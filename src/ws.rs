// WebSocket server for /api/ws. Carries both the broadcast event
// stream (server → client) and request/response RPC commands (client → server with reply). One reader thread decodes frames;
// commands are dispatched to worker threads that pipe results back through
// a shared writer mpsc the main thread drains. Single TcpStream is owned
// only by the writer (main thread) — never written from elsewhere.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};

use crate::broadcast::{self, Filter};
use crate::pool::Pool;
use crate::server::BundleProvider;
use crate::{driver, host, settings, util};

const WS_GUID: &[u8] = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_IDLE_TICK: Duration = Duration::from_millis(500);

enum WsRecv<T> {
    Item(T),
    Idle,
    Closed,
}

fn recv_ws_tick<T>(rx: &mpsc::Receiver<T>) -> WsRecv<T> {
    match rx.recv_timeout(WS_IDLE_TICK) {
        Ok(item) => WsRecv::Item(item),
        Err(RecvTimeoutError::Timeout) => WsRecv::Idle,
        Err(RecvTimeoutError::Disconnected) => WsRecv::Closed,
    }
}

pub fn handle(
    mut stream: TcpStream,
    sec_key: &str,
    pool: Arc<Pool>,
    bundle: BundleProvider,
    db: String,
    base_url: Option<String>,
) -> std::io::Result<()> {
    let accept = compute_accept(sec_key);
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Accept: {accept}\r\n\
         \r\n"
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()?;

    let subscription = broadcast::subscribe();
    let sub_id = subscription.id;
    let bcast_rx = subscription.rx;

    // Single channel feeding the writer (this thread). Both the broadcast
    // forwarder and per-request worker threads drop frames here.
    let (writer_tx, writer_rx) = mpsc::channel::<String>();
    let alive = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));

    // Forwarder: broadcast subscription → writer channel. Also injects ping
    // heartbeats during quiet periods.
    {
        let writer_tx = writer_tx.clone();
        let alive = alive.clone();
        thread::spawn(move || {
            while alive.load(std::sync::atomic::Ordering::Relaxed) {
                match recv_ws_tick(&bcast_rx) {
                    WsRecv::Item(msg) => {
                        if writer_tx.send(msg).is_err() {
                            break;
                        }
                    }
                    WsRecv::Idle => {
                        if writer_tx.send(r#"{"kind":"ping"}"#.to_string()).is_err() {
                            break;
                        }
                    }
                    WsRecv::Closed => break,
                }
            }
        });
    }

    // Reader thread: parses subscribe messages and dispatches `run` requests
    // to worker threads. Each worker thread runs the command synchronously
    // and posts a `{kind:"run-result",id,result}` frame to writer_tx.
    let read_clone = stream.try_clone()?;
    let alive_reader = alive.clone();
    {
        let writer_tx = writer_tx.clone();
        let pool = pool.clone();
        let bundle = bundle.clone();
        let base_url = base_url.clone();
        thread::spawn(move || {
            let mut s = read_clone;
            loop {
                match read_text_frame(&mut s) {
                    Ok(Some(text)) => {
                        let trimmed = text.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let parsed: Value = match serde_json::from_str(trimmed) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        if let Some(chat_id) = parsed
                            .get("subscribe")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                        {
                            let replay = broadcast::set_filter(
                                sub_id,
                                Filter {
                                    chat_id: Some(chat_id.to_string()),
                                },
                            );
                            for msg in replay {
                                if writer_tx.send(msg).is_err() {
                                    break;
                                }
                            }
                            continue;
                        }
                        if let Some(payload) = parsed.get("run") {
                            let id = parsed
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let payload = payload.clone();
                            let command = command_from_payload(&payload).to_string();
                            let run_inline = inline_builtin_command(&command);
                            let writer_tx = writer_tx.clone();
                            let pool = pool.clone();
                            let bundle = bundle.clone();
                            let db = db.clone();
                            let base_url = base_url.clone();
                            let run = move || {
                                let id_for_error = id.clone();
                                let writer_tx_for_error = writer_tx.clone();
                                let result = std::panic::catch_unwind(
                                    std::panic::AssertUnwindSafe(move || {
                                        run_command(
                                            payload, id, pool, bundle, writer_tx, db, base_url,
                                        )
                                    }),
                                );
                                if result.is_err() {
                                    send_run_result(
                                        &writer_tx_for_error,
                                        &id_for_error,
                                        json!({ "ok": false, "error": { "message": "command worker panicked" } }),
                                    );
                                }
                            };
                            if run_inline {
                                run();
                            } else {
                                thread::spawn(run);
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
            alive_reader.store(false, std::sync::atomic::Ordering::Relaxed);
        });
    }

    // Writer loop: drains the merged channel and writes frames. Exit when
    // the reader closes (alive=false) or the writer side errors.
    while alive.load(std::sync::atomic::Ordering::Relaxed) {
        match recv_ws_tick(&writer_rx) {
            WsRecv::Item(msg) => {
                if write_text_frame(&mut stream, msg.as_bytes()).is_err() {
                    break;
                }
            }
            WsRecv::Idle => continue,
            WsRecv::Closed => break,
        }
    }
    Ok(())
}

fn run_command(
    payload: Value,
    id: String,
    pool: Arc<Pool>,
    bundle: BundleProvider,
    writer_tx: mpsc::Sender<String>,
    db: String,
    base_url: Option<String>,
) {
    let command = command_from_payload(&payload).to_string();
    if command == "interrupt"
        && let Some(chat_id) = payload.get("chatId").and_then(|v| v.as_str())
    {
        crate::driver::cancel_runts(chat_id, None);
    }

    if command == "run-ts-cancel" {
        let result = run_ts_cancel_command(&pool, &bundle, &payload, &db);
        send_run_result(&writer_tx, &id, result);
        return;
    }

    // Some builtins do not need per-request host/db setup. Return them before
    // host initialization so UI observability calls do not contend with normal
    // command setup.
    if no_host_builtin_command(&command)
        && let Some(result) = builtin_command_result(&command, &db, &payload)
    {
        send_run_result(&writer_tx, &id, result);
        return;
    }

    let install_result = if settings_command(&command) {
        Ok(())
    } else if db_only_command(&command) {
        host::install_db(&db)
    } else {
        host::install(&db)
    };
    if let Err(e) = install_result {
        send_run_result(
            &writer_tx,
            &id,
            json!({
                "ok": false,
                "error": format!("host init: {e}"),
            }),
        );
        return;
    }

    if let Some(result) = builtin_command_result(&command, &db, &payload) {
        send_run_result(&writer_tx, &id, result);
        return;
    }

    let source = bundle();
    let effective_base_url = effective_server_base_url(&db, base_url.as_deref());
    let payload = payload_with_base_url(payload, effective_base_url.as_deref());
    if command == "run-ts-tool"
        && handle_run_ts_tool_command(&pool, source.clone(), payload.clone(), &writer_tx, &id)
    {
        return;
    }
    let result_value = submit_to_pool(&pool, source.clone(), payload.to_string());
    apply_driver_actions(&result_value, &pool, source);
    send_run_result(&writer_tx, &id, result_value);
}

fn builtin_command_result(command: &str, db: &str, payload: &Value) -> Option<Value> {
    Some(match command {
        "v8-stats" => crate::pool::v8_stats_json(),
        "v8-settings-get" => v8_settings_get(db),
        "v8-settings-save" => v8_settings_save(db, payload),
        "otel-config-get" => otel_config_get(db),
        "otel-config-save" => otel_config_save(db, payload),
        "otel-config-test" => otel_config_test(db, payload),
        "llm-auth-get" => llm_auth_get(db),
        "llm-auth-save" => llm_auth_save(db, payload),
        "run-ts-background" => run_ts_background_command(payload),
        "run-ts-backgrounds" => crate::driver::background_runts_json(),
        "pointers" => pointers_command(db, payload),
        "graph-summaries" => graph_summaries_command(db, payload),
        _ => return None,
    })
}

fn run_ts_background_command(payload: &Value) -> Value {
    let Some(chat_id) = payload
        .get("chatId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    else {
        return json!({ "ok": false, "error": { "message": "run-ts-background requires chatId" } });
    };
    let step_id = payload
        .get("stepId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let requested = crate::driver::request_foreground_runts_background(chat_id, step_id);
    json!({
        "ok": true,
        "value": {
            "chatId": chat_id,
            "stepId": payload.get("stepId").cloned().unwrap_or(Value::Null),
            "requested": requested,
        },
    })
}

fn run_ts_cancel_command(
    pool: &Arc<Pool>,
    bundle: &BundleProvider,
    payload: &Value,
    db: &str,
) -> Value {
    let chat_id = match payload
        .get("chatId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        Some(s) => s.to_string(),
        None => return json!({ "ok": false, "error": { "message": "run-ts-cancel requires chatId" } }),
    };
    let step_id = payload
        .get("stepId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    let cancelled = crate::driver::cancel_runts(&chat_id, step_id.as_deref());
    if cancelled > 0 {
        if let Some(sid) = &step_id {
            crate::broadcast::publish(
                json!({
                    "kind": "runts-step-finished",
                    "chatId": chat_id,
                    "stepId": sid,
                    "status": "agent:Cancelled",
                    "error": "runTS cancelled",
                    "at": crate::util::now_ms(),
                })
                .to_string(),
            );
            let pool = pool.clone();
            let bundle = bundle();
            let db = db.to_string();
            let chat_id = chat_id.clone();
            let sid = sid.clone();
            std::thread::spawn(move || {
                if host::install(&db).is_ok() {
                    let input = json!({ "command": "run-ts-cancel", "chatId": chat_id, "stepId": sid });
                    let _ = pool.submit(bundle, input.to_string());
                }
            });
        }
    }
    json!({
        "ok": true,
        "value": {
            "chatId": chat_id,
            "stepId": step_id,
            "cancelled": cancelled,
        },
    })
}

fn send_run_result(writer_tx: &mpsc::Sender<String>, id: &str, result: Value) {
    let frame = json!({
        "kind": "run-result",
        "id": id,
        "result": result,
    });
    let _ = writer_tx.send(frame.to_string());
}
fn effective_server_base_url(db: &str, base_url: Option<&str>) -> Option<String> {
    let configured = host::open_settings_db(db)
        .ok()
        .and_then(|conn| settings::read_server_base_url(&conn).ok().flatten());
    configured.or_else(|| base_url.map(str::to_string).filter(|s| !s.is_empty()))
}

fn payload_with_base_url(mut payload: Value, base_url: Option<&str>) -> Value {
    let Some(base_url) = base_url.filter(|s| !s.is_empty()) else {
        return payload;
    };
    if let Some(obj) = payload.as_object_mut() {
        obj.entry("serverBaseUrl".to_string())
            .or_insert_with(|| Value::String(base_url.to_string()));
    }
    payload
}

fn ok_value(value: Value) -> Value {
    json!({ "ok": true, "value": value })
}

fn err_value(message: impl ToString) -> Value {
    json!({ "ok": false, "error": { "message": message.to_string() } })
}

fn escape_like(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '%' | '_' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

fn pointers_command(db: &str, payload: &Value) -> Value {
    let prefix = payload.get("prefix").and_then(|v| v.as_str()).unwrap_or("");
    let result: Result<Value, String> = with_settings_connection(db, |conn| {
        let mut pointers = Vec::new();
        if prefix.is_empty() {
            let mut stmt = conn
                .prepare("select name, target from refs order by name")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (name, target) = row.map_err(|e| e.to_string())?;
                if !name.trim().is_empty() && !name.contains("[object Promise]") {
                    pointers.push(json!([name, target]));
                }
            }
        } else {
            let pattern = format!("{}%", escape_like(prefix));
            let mut stmt = conn
                .prepare(
                    "select name, target from refs where name like ?1 escape '\\' order by name",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![pattern], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (name, target) = row.map_err(|e| e.to_string())?;
                if !name.trim().is_empty() && !name.contains("[object Promise]") {
                    pointers.push(json!([name, target]));
                }
            }
        }
        Ok(json!({ "pointers": pointers }))
    })
    .and_then(|inner| inner);
    match result {
        Ok(value) => ok_value(value),
        Err(err) => err_value(err),
    }
}

#[derive(Default)]
struct GraphSummaryAccumulator {
    facts: usize,
    subjects: std::collections::BTreeSet<String>,
}

fn graph_summaries_command(db: &str, payload: &Value) -> Value {
    let removed = payload
        .get("removed")
        .and_then(|v| v.as_str())
        .unwrap_or("exclude");
    let removed_mode = if removed == "include" || removed == "only" {
        removed
    } else {
        "exclude"
    };
    let project = payload.get("project");
    let result: Result<Value, String> = with_settings_connection(db, |conn| {
        let mut summaries: std::collections::BTreeMap<String, GraphSummaryAccumulator> = std::collections::BTreeMap::new();
        let mut add = |graph: String, subject: String| {
            let entry = summaries.entry(graph).or_default();
            entry.facts += 1;
            entry.subjects.insert(subject);
        };

        if project.is_some() {
            let (store, graph) = project_store_and_graph(project);
            if removed_mode != "only" {
                let mut stmt = conn
                    .prepare("select graph, subject from quads where ref_name = ?1 and graph = ?2")
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![store, graph], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                    .map_err(|e| e.to_string())?;
                for row in rows {
                    let (g, s) = row.map_err(|e| e.to_string())?;
                    add(g, s);
                }
            }
            if removed_mode != "exclude" {
                let mut stmt = conn
                    .prepare(
                        "select l.graph, l.subject
                           from fact_log l
                          where l.ref_name = ?1 and l.graph = ?2 and l.action = 'remove'
                            and not exists (
                              select 1 from quads q
                               where q.ref_name = l.ref_name and q.graph = l.graph
                                 and q.subject = l.subject and q.predicate = l.predicate and q.object = l.object
                            )",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![store, graph], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                    .map_err(|e| e.to_string())?;
                for row in rows {
                    let (g, s) = row.map_err(|e| e.to_string())?;
                    add(g, s);
                }
            }
        } else {
            if removed_mode != "exclude" {
                let mut seen = std::collections::BTreeSet::new();
                let mut stmt = conn
                    .prepare(
                        "select l.graph, l.subject, l.predicate, l.object
                           from fact_log l
                          where l.action = 'remove'
                            and not exists (
                              select 1 from quads q
                               where q.ref_name = l.ref_name and q.graph = l.graph
                                 and q.subject = l.subject and q.predicate = l.predicate and q.object = l.object
                            )
                          order by l.ref_name, l.graph, l.subject, l.predicate, l.object, l.id",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))
                    .map_err(|e| e.to_string())?;
                for row in rows {
                    let (g, s, p, o) = row.map_err(|e| e.to_string())?;
                    let key = format!("{g}\0{s}\0{p}\0{o}");
                    if seen.insert(key) {
                        add(g, s);
                    }
                }
            }
            if removed_mode != "only" {
                let mut seen = std::collections::BTreeSet::new();
                let mut stmt = conn
                    .prepare("select graph, subject, predicate, object from quads order by ref_name, graph, subject, predicate, object")
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))
                    .map_err(|e| e.to_string())?;
                for row in rows {
                    let (g, s, p, o) = row.map_err(|e| e.to_string())?;
                    let key = format!("{g}\0{s}\0{p}\0{o}");
                    if seen.insert(key) {
                        add(g, s);
                    }
                }
            }
        }

        let graphs: Vec<Value> = summaries
            .into_iter()
            .map(|(graph, summary)| json!([graph, summary.facts, summary.subjects.len()]))
            .collect();
        Ok(json!({ "graphs": graphs }))
    })
    .and_then(|inner| inner);
    match result {
        Ok(value) => ok_value(value),
        Err(err) => err_value(err),
    }
}

fn project_store_and_graph(project: Option<&Value>) -> (String, String) {
    match project {
        Some(Value::Bool(false)) => ("memory/facts".to_string(), "memory:facts".to_string()),
        Some(Value::String(s)) if s.is_empty() => {
            ("memory/facts".to_string(), "memory:facts".to_string())
        }
        Some(Value::String(s)) => {
            let encoded = percent_encode_project(s);
            (
                format!("memory/project/{encoded}/facts"),
                format!("memory:project/{encoded}"),
            )
        }
        _ => ("memory/facts".to_string(), "memory:facts".to_string()),
    }
}

fn percent_encode_project(input: &str) -> String {
    let mut out = String::new();
    for b in input.bytes() {
        let ch = b as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
            out.push(ch);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn v8_settings_payload(stored: crate::pool::V8RuntimeSettings) -> Value {
    json!({
        "settings": stored,
        "defaults": crate::pool::default_v8_runtime_settings(),
        "effective": crate::pool::effective_v8_runtime_settings(),
    })
}

fn with_settings_connection<R>(
    db: &str,
    f: impl FnOnce(&rusqlite::Connection) -> R,
) -> Result<R, String> {
    let conn = host::open_settings_db(db)?;
    Ok(f(&conn))
}

fn v8_settings_get(db: &str) -> Value {
    let result: Result<crate::pool::V8RuntimeSettings, String> =
        with_settings_connection(db, |conn| {
            if let Some(raw) = settings::get(conn, settings::V8_CONFIG_KEY)? {
                let parsed = serde_json::from_str::<crate::pool::V8RuntimeSettings>(&raw)
                    .map_err(|e| e.to_string())?;
                Ok(crate::pool::normalize_v8_runtime_settings(parsed))
            } else if let Some(env) = settings::get(conn, settings::V8_ENV_KEY)? {
                crate::pool::apply_v8_env_text(&env);
                Ok(crate::pool::effective_v8_runtime_settings())
            } else {
                Ok(crate::pool::default_v8_runtime_settings())
            }
        })
        .and_then(|inner| inner);
    match result {
        Ok(stored) => json!({ "ok": true, "value": v8_settings_payload(stored) }),
        Err(message) => json!({ "ok": false, "error": { "message": message } }),
    }
}

fn v8_settings_save(db: &str, payload: &Value) -> Value {
    let Some(value) = payload.get("settings") else {
        return json!({ "ok": false, "error": { "message": "missing V8 settings" } });
    };
    let parsed = match serde_json::from_value::<crate::pool::V8RuntimeSettings>(value.clone()) {
        Ok(settings) => crate::pool::normalize_v8_runtime_settings(settings),
        Err(err) => return json!({ "ok": false, "error": { "message": err.to_string() } }),
    };
    let serialized = match serde_json::to_string(&parsed) {
        Ok(serialized) => serialized,
        Err(err) => return json!({ "ok": false, "error": { "message": err.to_string() } }),
    };
    let result: Result<(), String> = with_settings_connection(db, |conn| {
        settings::set(conn, settings::V8_CONFIG_KEY, &serialized)?;
        let _ = settings::clear(conn, settings::V8_ENV_KEY);
        Ok(())
    })
    .and_then(|inner| inner);
    match result {
        Ok(()) => {
            crate::pool::apply_v8_runtime_settings(&parsed);
            json!({ "ok": true, "value": v8_settings_payload(parsed) })
        }
        Err(message) => json!({ "ok": false, "error": { "message": message } }),
    }
}

fn otel_config_get(db: &str) -> Value {
    let result: Result<settings::TraceConfig, String> =
        with_settings_connection(db, host::trace_config_from_conn).and_then(|inner| inner);
    match result {
        Ok(config) => {
            let defaults = settings::default_trace_config();
            json!({ "ok": true, "value": {
                "enabled": host::otel_reporting_enabled(),
                "config": config,
                "defaults": defaults,
                "note": "OTEL reporting configuration applied immediately. Environment overrides: MOO_OTEL_ENABLED, MOO_OTEL_ENDPOINT, MOO_OTEL_SERVICE_NAME, MOO_OTEL_HEADERS, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS, OTEL_SERVICE_NAME.",
            }})
        }
        Err(message) => json!({ "ok": false, "error": { "message": message } }),
    }
}

fn no_host_builtin_command(command: &str) -> bool {
    matches!(command, "v8-stats" | "run-ts-background")
}

fn inline_builtin_command(command: &str) -> bool {
    // Only pure process-local reads should run on the WebSocket reader thread.
    matches!(command, "v8-stats")
}

fn settings_command(command: &str) -> bool {
    matches!(
        command,
        "v8-settings-get"
            | "v8-settings-save"
            | "otel-config-get"
            | "otel-config-save"
            | "otel-config-test"
            | "llm-auth-get"
            | "llm-auth-save"
            | "llm-auth-oauth-start"
            | "llm-auth-oauth-complete"
            | "llm-auth-oauth-device-start"
            | "llm-auth-oauth-device-poll"
            | "llm-auth-oauth-logout"
    )
}

fn db_only_command(command: &str) -> bool {
    matches!(command, "")
}

fn otel_config_save(db: &str, payload: &Value) -> Value {
    let Some(value) = payload.get("config") else {
        return json!({ "ok": false, "error": { "message": "missing trace config" } });
    };
    let parsed = match serde_json::from_value::<settings::TraceConfig>(value.clone()) {
        Ok(config) => settings::normalize_trace_config(config),
        Err(err) => return json!({ "ok": false, "error": { "message": err.to_string() } }),
    };
    let serialized = match serde_json::to_string(&parsed) {
        Ok(serialized) => serialized,
        Err(err) => return json!({ "ok": false, "error": { "message": err.to_string() } }),
    };
    let result: Result<(), String> = with_settings_connection(db, |conn| {
        settings::set(conn, settings::TRACE_CONFIG_KEY, &serialized)?;
        Ok(())
    })
    .and_then(|inner| inner)
    .and_then(|()| host::apply_trace_config(&parsed));
    match result {
        Ok(()) => json!({ "ok": true, "value": {
            "enabled": host::otel_reporting_enabled(),
            "config": parsed,
            "defaults": settings::default_trace_config(),
            "note": "OTEL reporting configuration applied immediately. Environment overrides: MOO_OTEL_ENABLED, MOO_OTEL_ENDPOINT, MOO_OTEL_SERVICE_NAME, MOO_OTEL_HEADERS, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS, OTEL_SERVICE_NAME.",
        }}),
        Err(message) => json!({ "ok": false, "error": { "message": message } }),
    }
}

fn otel_config_test(_db: &str, payload: &Value) -> Value {
    let Some(value) = payload.get("config") else {
        return json!({ "ok": false, "error": { "message": "missing trace config" } });
    };
    let parsed = match serde_json::from_value::<settings::TraceConfig>(value.clone()) {
        Ok(config) => settings::normalize_trace_config(config),
        Err(err) => return json!({ "ok": false, "error": { "message": err.to_string() } }),
    };
    if !parsed.enabled {
        return json!({ "ok": true, "value": { "message": "OTEL reporting is disabled. These draft settings have not been saved and no endpoint request was attempted." } });
    }
    match host::test_trace_config(&parsed) {
        Ok(()) => {
            json!({ "ok": true, "value": { "message": "OTEL configuration OK. These draft settings have not been saved yet." } })
        }
        Err(message) => json!({ "ok": false, "error": { "message": message } }),
    }
}

const LLM_AUTH_SETTINGS_REF: &str = "settings";
const LLM_AUTH_SETTINGS_KIND: &str = "llm:AuthSettings";
const LLM_PROVIDERS: [&str; 5] = ["openai", "anthropic", "qwen", "xai", "deepseek"];

fn clamp_i64(value: Option<i64>, fallback: i64, min: i64, max: i64) -> i64 {
    value.unwrap_or(fallback).clamp(min, max)
}

fn value_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|n| n.floor() as i64)))
}

fn normalize_retry_policy(input: Option<&Value>) -> Value {
    let obj = input.and_then(Value::as_object);
    json!({
        "maxAttempts": clamp_i64(obj.and_then(|o| value_i64(o.get("maxAttempts"))), 3, 1, 20),
        "baseDelayMs": clamp_i64(obj.and_then(|o| value_i64(o.get("baseDelayMs"))), 750, 0, 60_000),
        "maxDelayMs": clamp_i64(obj.and_then(|o| value_i64(o.get("maxDelayMs"))), 8_000, 0, 10 * 60_000),
        "jitterMs": clamp_i64(obj.and_then(|o| value_i64(o.get("jitterMs"))), 250, 0, 60_000),
        "maxRetryAfterMs": clamp_i64(obj.and_then(|o| value_i64(o.get("maxRetryAfterMs"))), 30 * 60_000, 0, 60 * 60_000),
    })
}

fn normalize_ui_settings(raw: Option<&Value>) -> Value {
    let obj = raw.and_then(Value::as_object);
    let syntax_highlight_max_bytes = obj
        .and_then(|o| o.get("syntaxHighlightMaxBytes"))
        .and_then(Value::as_u64)
        .filter(|v| *v > 0)
        .unwrap_or(1024 * 1024);
    json!({ "syntaxHighlightMaxBytes": syntax_highlight_max_bytes })
}

fn normalize_compaction_settings(input: Option<&Value>) -> Value {
    let obj = input.and_then(Value::as_object);
    json!({ "thresholdPercent": clamp_i64(obj.and_then(|o| value_i64(o.get("thresholdPercent"))), 50, 1, 100) })
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

fn normalize_llm_auth_mode<'a>(id: &str, requested: &'a str) -> &'a str {
    if requested == "apiKey" || (id == "openai" && requested == "oauth") {
        requested
    } else {
        "env"
    }
}

fn normalize_llm_provider(raw: Option<&Value>, id: &str) -> Value {
    let obj = raw.and_then(Value::as_object);
    let requested = obj
        .and_then(|o| o.get("authMode"))
        .and_then(Value::as_str)
        .unwrap_or("env");
    let auth_mode = normalize_llm_auth_mode(id, requested);
    json!({
        "authMode": auth_mode,
        "apiKey": non_empty_string(obj.and_then(|o| o.get("apiKey"))),
        "accessToken": if id == "openai" { non_empty_string(obj.and_then(|o| o.get("accessToken"))) } else { None },
        "refreshToken": if id == "openai" { non_empty_string(obj.and_then(|o| o.get("refreshToken"))) } else { None },
        "expiresAt": if id == "openai" { value_i64(obj.and_then(|o| o.get("expiresAt"))) } else { None },
        "oauthSubject": if id == "openai" { non_empty_string(obj.and_then(|o| o.get("oauthSubject"))) } else { None },
        "oauthAccountId": if id == "openai" { non_empty_string(obj.and_then(|o| o.get("oauthAccountId"))) } else { None },
        "baseUrl": non_empty_string(obj.and_then(|o| o.get("baseUrl"))),
    })
}

fn normalize_llm_auth_settings(raw: &Value) -> Value {
    let providers_raw = raw.get("providers");
    let mut providers = serde_json::Map::new();
    for id in LLM_PROVIDERS {
        providers.insert(
            id.to_string(),
            normalize_llm_provider(providers_raw.and_then(|p| p.get(id)), id),
        );
    }
    let mut out = serde_json::Map::new();
    out.insert("providers".to_string(), Value::Object(providers));
    out.insert(
        "compaction".to_string(),
        normalize_compaction_settings(raw.get("compaction")),
    );
    out.insert("ui".to_string(), normalize_ui_settings(raw.get("ui")));
    out.insert(
        "retries".to_string(),
        normalize_retry_policy(raw.get("retries")),
    );
    if let Some(updated_at) = value_i64(raw.get("updatedAt")) {
        out.insert("updatedAt".to_string(), json!(updated_at));
    }
    Value::Object(out)
}

fn read_llm_auth_settings_conn(conn: &Connection) -> Result<Value, String> {
    let target: Option<String> = conn
        .query_row(
            "select target from refs where name = ?1",
            params![LLM_AUTH_SETTINGS_REF],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(target) = target else {
        return Ok(normalize_llm_auth_settings(&json!({})));
    };
    let raw = if let Some(json_target) = target.strip_prefix("json:") {
        serde_json::from_str::<Value>(json_target).map_err(|e| e.to_string())?
    } else {
        let bytes: Option<Vec<u8>> = conn
            .query_row(
                "select bytes from objects where hash = ?1",
                params![target],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(bytes) = bytes else {
            return Ok(normalize_llm_auth_settings(&json!({})));
        };
        serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string())?
    };
    Ok(normalize_llm_auth_settings(&raw))
}

fn redact_provider(provider: &Value) -> Value {
    let mut out = provider.as_object().cloned().unwrap_or_default();
    let api_key = provider
        .get("apiKey")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let redacted = api_key.map(|key| {
        let suffix_rev: String = key.chars().rev().take(4).collect();
        let suffix: String = suffix_rev.chars().rev().collect();
        format!("••••{suffix}")
    });
    out.insert(
        "apiKey".to_string(),
        redacted.map(Value::String).unwrap_or(Value::Null),
    );
    let has_access = provider
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .is_some();
    let has_refresh = provider
        .get("refreshToken")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .is_some();
    out.insert(
        "accessToken".to_string(),
        if has_access {
            json!("present")
        } else {
            Value::Null
        },
    );
    out.insert(
        "refreshToken".to_string(),
        if has_refresh {
            json!("present")
        } else {
            Value::Null
        },
    );
    out.insert("hasApiKey".to_string(), json!(api_key.is_some()));
    out.insert("hasAccessToken".to_string(), json!(has_access));
    out.insert("hasRefreshToken".to_string(), json!(has_refresh));
    Value::Object(out)
}

fn redact_llm_auth_settings(settings: &Value) -> Value {
    let mut out = settings.as_object().cloned().unwrap_or_default();
    let providers_raw = settings.get("providers");
    let mut providers = serde_json::Map::new();
    for id in LLM_PROVIDERS {
        providers.insert(
            id.to_string(),
            redact_provider(
                providers_raw
                    .and_then(|p| p.get(id))
                    .unwrap_or(&Value::Null),
            ),
        );
    }
    out.insert("providers".to_string(), Value::Object(providers));
    Value::Object(out)
}

fn apply_llm_provider_input(current: &Value, id: &str, input: Option<&Value>) -> Value {
    let Some(input_obj) = input.and_then(Value::as_object) else {
        return current.clone();
    };
    let mode_raw = input_obj
        .get("authMode")
        .and_then(Value::as_str)
        .or_else(|| current.get("authMode").and_then(Value::as_str))
        .unwrap_or("env");
    let auth_mode = normalize_llm_auth_mode(id, mode_raw);
    let mut next = current.as_object().cloned().unwrap_or_default();
    next.insert("authMode".to_string(), json!(auth_mode));
    if let Some(api_key) = input_obj
        .get("apiKey")
        .and_then(Value::as_str)
        .filter(|s| !s.starts_with("••••"))
    {
        next.insert(
            "apiKey".to_string(),
            non_empty_string(Some(&Value::String(api_key.to_string())))
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
    }
    if let Some(base_url) = input_obj.get("baseUrl").and_then(Value::as_str) {
        next.insert(
            "baseUrl".to_string(),
            non_empty_string(Some(&Value::String(base_url.to_string())))
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
    }
    // Keep OpenAI OAuth credentials when switching away from OAuth so the user
    // can switch back without reconnecting; only explicit disconnect clears it.
    if id != "openai" || input_obj.get("clearOAuth").and_then(Value::as_bool) == Some(true) {
        next.insert("accessToken".to_string(), Value::Null);
        next.insert("refreshToken".to_string(), Value::Null);
        next.insert("expiresAt".to_string(), Value::Null);
        next.insert("oauthSubject".to_string(), Value::Null);
    }
    normalize_llm_provider(Some(&Value::Object(next)), id)
}

fn write_llm_auth_settings_conn(conn: &mut Connection, mut next: Value) -> Result<Value, String> {
    if let Some(obj) = next.as_object_mut() {
        obj.insert("updatedAt".to_string(), json!(util::now_ms()));
    }
    let bytes = serde_json::to_vec(&next).map_err(|e| e.to_string())?;
    let hash = util::sha256_object_hash(LLM_AUTH_SETTINGS_KIND, &bytes);
    let now = util::now_ms();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "insert or ignore into objects(hash, kind, bytes, created_at) values (?1, ?2, ?3, ?4)",
        params![&hash, LLM_AUTH_SETTINGS_KIND, &bytes, now],
    )
    .map_err(|e| e.to_string())?;
    let old_target: Option<String> = tx
        .query_row(
            "select target from refs where name = ?1",
            params![LLM_AUTH_SETTINGS_REF],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    tx.execute("insert into refs(name, target, updated_at) values (?1, ?2, ?3) on conflict(name) do update set target = excluded.target, updated_at = excluded.updated_at", params![LLM_AUTH_SETTINGS_REF, &hash, now]).map_err(|e| e.to_string())?;
    if old_target.as_deref() != Some(hash.as_str()) {
        tx.execute(
            "insert into ref_log(name, old_target, new_target, created_at) values (?1, ?2, ?3, ?4)",
            params![LLM_AUTH_SETTINGS_REF, old_target, &hash, now],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(next)
}

fn llm_auth_get(db: &str) -> Value {
    let result: Result<Value, String> = (|| {
        let conn = host::open_settings_db(db)?;
        let mut settings_value = redact_llm_auth_settings(&read_llm_auth_settings_conn(&conn)?);
        if let Some(obj) = settings_value.as_object_mut() {
            obj.insert(
                "serverBaseUrl".to_string(),
                settings::read_server_base_url(&conn)?
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            );
        }
        Ok(json!({ "settings": settings_value }))
    })();
    match result {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(message) => json!({ "ok": false, "error": { "message": message } }),
    }
}

fn llm_auth_save(db: &str, payload: &Value) -> Value {
    let result: Result<Value, String> = (|| {
        let mut conn = host::open_settings_db(db)?;
        let current = read_llm_auth_settings_conn(&conn)?;
        let current_providers = current
            .get("providers")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut providers = serde_json::Map::new();
        for id in LLM_PROVIDERS {
            providers.insert(
                id.to_string(),
                apply_llm_provider_input(
                    current_providers.get(id).unwrap_or(&Value::Null),
                    id,
                    payload.get(id),
                ),
            );
        }
        let settings = json!({
            "providers": providers,
            "compaction": if payload.get("compaction").and_then(Value::as_object).is_some() { normalize_compaction_settings(payload.get("compaction")) } else { current.get("compaction").cloned().unwrap_or_else(|| normalize_compaction_settings(None)) },
            "retries": if payload.get("retries").and_then(Value::as_object).is_some() { normalize_retry_policy(payload.get("retries")) } else { current.get("retries").cloned().unwrap_or_else(|| normalize_retry_policy(None)) },
            "ui": if payload.get("ui").and_then(Value::as_object).is_some() { normalize_ui_settings(payload.get("ui")) } else { current.get("ui").cloned().unwrap_or_else(|| normalize_ui_settings(None)) },
        });
        let saved_server_base_url = if payload.get("serverBaseUrl").is_some() {
            settings::write_server_base_url(
                &conn,
                payload.get("serverBaseUrl").and_then(Value::as_str),
            )?
        } else {
            settings::read_server_base_url(&conn)?
        };
        let saved = write_llm_auth_settings_conn(&mut conn, settings)?;
        let mut redacted = redact_llm_auth_settings(&saved);
        if let Some(obj) = redacted.as_object_mut() {
            obj.insert(
                "serverBaseUrl".to_string(),
                saved_server_base_url
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            );
        }
        Ok(json!({ "settings": redacted }))
    })();
    match result {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(message) => json!({ "ok": false, "error": { "message": message } }),
    }
}

fn command_from_payload(payload: &Value) -> &str {
    payload
        .get("argv")
        .and_then(|x| x.as_array())
        .and_then(|argv| argv.first())
        .and_then(|x| x.as_str())
        .or_else(|| payload.get("command").and_then(|x| x.as_str()))
        .unwrap_or("")
}

fn submit_to_pool(pool: &Pool, bundle: Arc<String>, body: String) -> Value {
    match pool.submit(bundle, body) {
        Ok(out) => serde_json::from_str::<Value>(&out).unwrap_or_else(
            |_| json!({ "ok": false, "error": { "message": "non-JSON pool result" } }),
        ),
        Err(e) => json!({ "ok": false, "error": { "message": e } }),
    }
}

fn handle_run_ts_tool_command(
    pool: &Arc<Pool>,
    bundle: Arc<String>,
    payload: Value,
    writer_tx: &mpsc::Sender<String>,
    id: &str,
) -> bool {
    let Some(background_after_ns) = driver::runts_tool_background_after_ns(&payload) else {
        return false;
    };
    let chat_id = payload
        .get("chatId")
        .or_else(|| payload.pointer("/state/chatId"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if chat_id.is_empty() {
        return false;
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let payload = ensure_runts_step_id(payload);
    let mut handle =
        driver::spawn_runts_tool_command(pool.clone(), bundle, payload.clone(), cancel.clone());
    if background_after_ns == 0 {
        let result = detached_runts_tool_result(&payload);
        driver::background_runts_command(chat_id, payload, cancel, handle);
        send_run_result(writer_tx, id, result);
        return true;
    }
    let wait = crate::async_runtime::runtime().block_on(async {
        tokio::time::timeout(Duration::from_nanos(background_after_ns), &mut handle).await
    });
    match wait {
        Ok(joined) => {
            let result = joined.unwrap_or_else(|e| {
                json!({
                    "content": format!("error: runTS task failed: {e}"),
                    "status": "failed",
                })
            });
            send_run_result(writer_tx, id, json!({ "ok": true, "value": result }));
        }
        Err(_) => {
            driver::background_runts_command(chat_id, payload.clone(), cancel, handle);
            send_run_result(writer_tx, id, detached_runts_tool_result(&payload));
        }
    }
    true
}

fn ensure_runts_step_id(mut payload: Value) -> Value {
    let has_step_id = payload
        .get("runTsStepId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .is_some();
    if !has_step_id && let Some(obj) = payload.as_object_mut() {
        obj.insert(
            "runTsStepId".to_string(),
            Value::String(util::random_id("step")),
        );
    }
    payload
}

fn detached_runts_tool_result(payload: &Value) -> Value {
    let mut tool_call_id = payload
        .get("toolCall")
        .and_then(|v| v.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let step_id = payload
        .get("runTsStepId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| tool_call_id.clone());
    if tool_call_id.is_empty() {
        tool_call_id = step_id.clone();
    }
    json!({
        "ok": true,
        "value": {
            "toolCallId": tool_call_id,
            "stepId": step_id,
            "runTsStepId": step_id,
            "backgroundId": step_id,
            "content": format!("detached: runTS continues in background; id: {step_id}; cancel with await moo.tools.cancel({{ id: \"{step_id}\" }})"),
            "status": "done",
        }
    })
}

fn apply_driver_actions(result: &Value, pool: &Arc<Pool>, bundle: Arc<String>) {
    if result.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return;
    }
    let Some(value) = result.get("value") else {
        return;
    };
    driver::apply_driver_actions(value, pool, &bundle);
}

// Reads one WS text message from the stream. Returns Ok(Some(text)) for a
// complete message, Ok(None) on close/EOF, Err on transport or protocol errors.
// Only handles the bits we need: text frames, continuations, masked
// (client→server), no extensions.
fn read_text_frame(stream: &mut TcpStream) -> std::io::Result<Option<String>> {
    let mut message: Vec<u8> = Vec::new();
    let mut in_text_message = false;

    loop {
        let mut hdr = [0u8; 2];
        if read_exact_or_eof(stream, &mut hdr)? {
            return Ok(None);
        }
        let fin = (hdr[0] & 0x80) != 0;
        let opcode = hdr[0] & 0x0F;
        let masked = (hdr[1] & 0x80) != 0;
        let mut len = (hdr[1] & 0x7F) as u64;
        if len == 126 {
            let mut ext = [0u8; 2];
            if read_exact_or_eof(stream, &mut ext)? {
                return Ok(None);
            }
            len = u16::from_be_bytes(ext) as u64;
        } else if len == 127 {
            let mut ext = [0u8; 8];
            if read_exact_or_eof(stream, &mut ext)? {
                return Ok(None);
            }
            len = u64::from_be_bytes(ext);
        }
        let mut mask = [0u8; 4];
        if masked && read_exact_or_eof(stream, &mut mask)? {
            return Ok(None);
        }
        // Generous cap for image-attachment payloads. A pasted screenshot
        // base64-encoded as a data URL inflates ~33% and is commonly several MB;
        // the 1 MB cap was rejecting the entire `step` request and silently
        // dropping the user's message + image. Apply the same cap to both a
        // single frame and the reassembled message.
        const MAX_MESSAGE: u64 = 256 << 20;
        if len > MAX_MESSAGE || (message.len() as u64).saturating_add(len) > MAX_MESSAGE {
            return Err(std::io::Error::other("ws message too large"));
        }
        let mut payload = vec![0u8; len as usize];
        if read_exact_or_eof(stream, &mut payload)? {
            return Ok(None);
        }
        if masked {
            for (i, b) in payload.iter_mut().enumerate() {
                *b ^= mask[i % 4];
            }
        }

        match opcode {
            0x8 => return Ok(None), // close
            0x9 | 0xA => continue,  // ping/pong; ignore for v1
            0x1 => {
                // Text messages may be fragmented by browsers/proxies,
                // especially when they carry base64 image attachments. The
                // old reader tried to parse each frame as a whole JSON RPC
                // message, so fragmented image steps were silently ignored.
                message = payload;
                in_text_message = !fin;
                if fin {
                    return Ok(Some(String::from_utf8_lossy(&message).into_owned()));
                }
            }
            0x0 if in_text_message => {
                message.extend_from_slice(&payload);
                in_text_message = !fin;
                if fin {
                    return Ok(Some(String::from_utf8_lossy(&message).into_owned()));
                }
            }
            0x0 => continue, // stray continuation; skip silently
            _ => continue,   // binary/reserved; skip silently
        }
    }
}

fn read_exact_or_eof(stream: &mut TcpStream, buf: &mut [u8]) -> std::io::Result<bool> {
    let mut filled = 0;
    while filled < buf.len() {
        match stream.read(&mut buf[filled..]) {
            Ok(0) => return Ok(true),
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(false)
}

fn write_text_frame(stream: &mut TcpStream, payload: &[u8]) -> std::io::Result<()> {
    let mut header: Vec<u8> = Vec::with_capacity(10);
    header.push(0x81); // FIN + opcode 0x1 (text)
    let len = payload.len();
    if len < 126 {
        header.push(len as u8);
    } else if len < 65_536 {
        header.push(126);
        header.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        header.push(127);
        header.extend_from_slice(&(len as u64).to_be_bytes());
    }
    stream.write_all(&header)?;
    stream.write_all(payload)?;
    stream.flush()
}

fn compute_accept(key: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(key.trim().as_bytes());
    hasher.update(WS_GUID);
    let digest = hasher.finalize();
    B64.encode(digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_accept_rfc_example() {
        // RFC 6455: "dGhlIHNhbXBsZSBub25jZQ==" → "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        assert_eq!(
            compute_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn read_text_frame_reassembles_fragmented_json() {
        use std::io::Write;
        use std::net::{TcpListener, TcpStream};
        use std::thread;

        fn write_masked_frame(
            stream: &mut TcpStream,
            fin: bool,
            opcode: u8,
            payload: &[u8],
        ) -> std::io::Result<()> {
            let mut frame = vec![(if fin { 0x80 } else { 0x00 }) | opcode];
            let mask = [1u8, 2, 3, 4];
            let len = payload.len();
            if len < 126 {
                frame.push(0x80 | len as u8);
            } else if len < 65_536 {
                frame.push(0x80 | 126);
                frame.extend_from_slice(&(len as u16).to_be_bytes());
            } else {
                frame.push(0x80 | 127);
                frame.extend_from_slice(&(len as u64).to_be_bytes());
            }
            frame.extend_from_slice(&mask);
            frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
            stream.write_all(&frame)
        }

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(addr).unwrap();
            write_masked_frame(&mut stream, false, 0x1, br#"{"run":{"command":""#).unwrap();
            write_masked_frame(
                &mut stream,
                true,
                0x0,
                br#"step","chatId":"c","message":"hi"}}"#,
            )
            .unwrap();
        });

        let (mut server, _) = listener.accept().unwrap();
        let text = read_text_frame(&mut server).unwrap().unwrap();
        client.join().unwrap();
        assert_eq!(
            text,
            r#"{"run":{"command":"step","chatId":"c","message":"hi"}}"#
        );
    }

    #[test]
    fn payload_with_base_url_adds_server_base_url() {
        assert_eq!(
            payload_with_base_url(
                json!({ "command": "mcp-oauth-start" }),
                Some("http://100.126.83.89:5173")
            ),
            json!({ "command": "mcp-oauth-start", "serverBaseUrl": "http://100.126.83.89:5173" })
        );
    }

    #[test]
    fn payload_with_base_url_preserves_explicit_value() {
        assert_eq!(
            payload_with_base_url(
                json!({ "serverBaseUrl": "http://explicit" }),
                Some("http://configured")
            ),
            json!({ "serverBaseUrl": "http://explicit" })
        );
    }

    #[test]
    fn llm_auth_save_persists_server_base_url() {
        let mut db = std::env::temp_dir();
        db.push(format!(
            "moo-llm-auth-server-base-url-{}-{}.db",
            std::process::id(),
            util::now_ms()
        ));
        let db = db.to_string_lossy().to_string();
        let save = llm_auth_save(
            &db,
            &json!({
                "serverBaseUrl": " https://moo.example.com/ "
            }),
        );
        assert_eq!(save.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            save["value"]["settings"]["serverBaseUrl"],
            "https://moo.example.com"
        );
        let get = llm_auth_get(&db);
        assert_eq!(
            get["value"]["settings"]["serverBaseUrl"],
            "https://moo.example.com"
        );
    }

    #[test]
    fn otel_config_test_disabled_does_not_require_otel_endpoint() {
        let result = otel_config_test(
            ":memory:",
            &json!({
                "config": {
                    "enabled": false,
                    "otelEndpoint": "http://127.0.0.1:1/v1/traces",
                    "serviceName": "moo",
                    "headers": []
                }
            }),
        );
        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(true));
        let message = result
            .get("value")
            .and_then(|v| v.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        assert!(message.contains("no endpoint request was attempted"));
    }

    #[test]
    fn otel_config_test_enabled_validates_otel_endpoint() {
        let result = otel_config_test(
            ":memory:",
            &json!({
                "config": {
                    "enabled": true,
                    "otelEndpoint": "http://127.0.0.1:1/v1/traces",
                    "serviceName": "moo",
                    "headers": []
                }
            }),
        );
        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(false));
        let message = result
            .get("error")
            .and_then(|v| v.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        assert!(!message.is_empty());
    }

    #[test]
    fn otel_config_save_enabled_applies_without_endpoint_probe() {
        let _guard = host::TEST_DB_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "moo-ws-otel-config-{}",
            crate::util::random_id("test")
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("store.sqlite");
        host::install_fresh(db_path.to_str().unwrap()).unwrap();

        let result = otel_config_save(
            ":memory:",
            &json!({
                "config": {
                    "enabled": true,
                    "otelEndpoint": "http://127.0.0.1:1/v1/traces",
                    "serviceName": "moo",
                    "headers": []
                }
            }),
        );
        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            result["value"]["config"]["otelEndpoint"].as_str(),
            Some("http://127.0.0.1:1/v1/traces")
        );
    }

    #[test]
    fn llm_auth_get_save_uses_settings_db_directly() {
        let _guard = host::TEST_DB_LOCK.lock().unwrap();
        let db_path_buf = std::env::temp_dir().join(format!(
            "moo-llm-auth-settings-{}-{}.db",
            std::process::id(),
            util::now_ms()
        ));
        let db_path = db_path_buf.to_str().unwrap();

        let initial = llm_auth_get(db_path);
        assert_eq!(initial["ok"], true);
        assert_eq!(
            initial["value"]["settings"]["providers"]["openai"]["authMode"],
            "env"
        );

        let settings = json!({
            "compaction": { "thresholdPercent": 100 },
            "retries": { "maxAttempts": 1, "baseDelayMs": 42 },
        });
        let saved = llm_auth_save(db_path, &settings);
        assert_eq!(saved["ok"], true);
        let settings = &saved["value"]["settings"];

        assert_eq!(settings["compaction"]["thresholdPercent"], 100);
        assert_eq!(settings["retries"]["maxAttempts"], 1);
        assert_eq!(settings["retries"]["baseDelayMs"], 42);

        let loaded = llm_auth_get(db_path);
        assert_eq!(loaded["value"]["settings"], *settings);
        let _ = std::fs::remove_file(&db_path_buf);
    }

    #[test]
    fn llm_auth_save_preserves_openai_oauth_tokens_across_mode_changes() {
        let current = json!({
            "authMode": "oauth",
            "accessToken": "access-token",
            "refreshToken": "refresh-token",
            "expiresAt": 123456,
            "oauthSubject": "subject",
            "oauthAccountId": "account",
        });

        let env_saved =
            apply_llm_provider_input(&current, "openai", Some(&json!({ "authMode": "env" })));

        assert_eq!(env_saved["authMode"], "env");
        assert_eq!(env_saved["accessToken"], "access-token");
        assert_eq!(env_saved["refreshToken"], "refresh-token");
        assert_eq!(env_saved["expiresAt"], 123456);
        assert_eq!(env_saved["oauthSubject"], "subject");
        assert_eq!(env_saved["oauthAccountId"], "account");

        let api_key_saved = apply_llm_provider_input(
            &env_saved,
            "openai",
            Some(&json!({ "authMode": "apiKey", "apiKey": "sk-test" })),
        );

        assert_eq!(api_key_saved["authMode"], "apiKey");
        assert_eq!(api_key_saved["accessToken"], "access-token");
        assert_eq!(api_key_saved["refreshToken"], "refresh-token");
        assert_eq!(api_key_saved["expiresAt"], 123456);
        assert_eq!(api_key_saved["oauthSubject"], "subject");
        assert_eq!(api_key_saved["oauthAccountId"], "account");

        let cleared = apply_llm_provider_input(
            &api_key_saved,
            "openai",
            Some(&json!({ "authMode": "apiKey", "clearOAuth": true })),
        );

        assert_eq!(cleared["authMode"], "apiKey");
        assert!(cleared["accessToken"].is_null());
        assert!(cleared["refreshToken"].is_null());
        assert!(cleared["expiresAt"].is_null());
        assert!(cleared["oauthSubject"].is_null());
        assert_eq!(cleared["oauthAccountId"], "account");
    }

    #[test]
    fn settings_commands_bypass_full_host_install() {
        assert!(settings_command("otel-config-get"));
        assert!(settings_command("otel-config-save"));
        assert!(settings_command("otel-config-test"));
        assert!(settings_command("v8-settings-get"));
        assert!(settings_command("v8-settings-save"));
        assert!(settings_command("llm-auth-get"));
        assert!(settings_command("llm-auth-save"));
        assert!(settings_command("llm-auth-oauth-start"));
        assert!(settings_command("llm-auth-oauth-complete"));
        assert!(settings_command("llm-auth-oauth-device-start"));
        assert!(settings_command("llm-auth-oauth-device-poll"));
        assert!(settings_command("llm-auth-oauth-logout"));
        assert!(!settings_command("v8-stats"));
        assert!(!db_only_command("v8-settings-get"));
    }

    #[test]
    fn only_pure_process_builtins_run_on_ws_reader_thread() {
        assert!(inline_builtin_command("v8-stats"));
    }
}
