// WebSocket server for /api/ws. Carries both the broadcast event
// stream (server → client) and request/response RPC commands (client → server with reply). One reader thread decodes frames;
// commands are dispatched to worker threads that pipe results back through
// a shared writer mpsc the main thread drains. Single TcpStream is owned
// only by the writer (main thread) — never written from elsewhere.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};

use crate::broadcast::{self, Filter};
use crate::pool::Pool;
use crate::server::BundleProvider;
use crate::{driver, host, settings};

const WS_GUID: &[u8] = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

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
                match bcast_rx.recv_timeout(Duration::from_millis(500)) {
                    Ok(msg) => {
                        if writer_tx.send(msg).is_err() {
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if writer_tx.send(r#"{"kind":"ping"}"#.to_string()).is_err() {
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
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
                            broadcast::set_filter(
                                sub_id,
                                Filter {
                                    chat_id: Some(chat_id.to_string()),
                                },
                            );
                            continue;
                        }
                        if let Some(payload) = parsed.get("run") {
                            let id = parsed
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let writer_tx = writer_tx.clone();
                            let pool = pool.clone();
                            let bundle = bundle.clone();
                            let payload = payload.clone();
                            let db = db.clone();
                            let base_url = base_url.clone();
                            thread::spawn(move || {
                                let id_for_error = id.clone();
                                let writer_tx_for_error = writer_tx.clone();
                                let result = std::panic::catch_unwind(
                                    std::panic::AssertUnwindSafe(move || {
                                        match host::install(&db) {
                                            Ok(()) => run_command(
                                                payload, id, pool, bundle, writer_tx, db, base_url,
                                            ),
                                            Err(message) => {
                                                let frame = json!({
                                                    "kind": "run-result",
                                                    "id": id,
                                                    "result": { "ok": false, "error": { "message": message } },
                                                });
                                                let _ = writer_tx.send(frame.to_string());
                                            }
                                        }
                                    }),
                                );
                                if result.is_err() {
                                    let frame = json!({
                                        "kind": "run-result",
                                        "id": id_for_error,
                                        "result": { "ok": false, "error": { "message": "command worker panicked" } },
                                    });
                                    let _ = writer_tx_for_error.send(frame.to_string());
                                }
                            });
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
        match writer_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(msg) => {
                if write_text_frame(&mut stream, msg.as_bytes()).is_err() {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
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
    if let Err(e) = host::install(&db) {
        let frame = json!({
            "kind": "run-result",
            "id": id,
            "result": {
                "ok": false,
                "error": format!("host init: {e}"),
            },
        });
        let _ = writer_tx.send(frame.to_string());
        return;
    }

    match command_from_payload(&payload) {
        "v8-stats" => {
            let frame = json!({
                "kind": "run-result",
                "id": id,
                "result": crate::pool::v8_stats_json(),
            });
            let _ = writer_tx.send(frame.to_string());
            return;
        }
        "v8-settings-get" => {
            let frame = json!({ "kind": "run-result", "id": id, "result": v8_settings_get(&db) });
            let _ = writer_tx.send(frame.to_string());
            return;
        }
        "v8-settings-save" => {
            let frame = json!({ "kind": "run-result", "id": id, "result": v8_settings_save(&db, &payload) });
            let _ = writer_tx.send(frame.to_string());
            return;
        }
        "trace-chats" => {
            let frame =
                json!({ "kind": "run-result", "id": id, "result": trace_chats(&db, &payload) });
            let _ = writer_tx.send(frame.to_string());
            return;
        }
        "trace-node" => {
            let frame =
                json!({ "kind": "run-result", "id": id, "result": trace_node(&db, &payload) });
            let _ = writer_tx.send(frame.to_string());
            return;
        }
        "trace-subtree" => {
            let frame = json!({ "kind": "run-result", "id": id, "result": trace_subtree_command(&db, &payload) });
            let _ = writer_tx.send(frame.to_string());
            return;
        }
        "trace-events" => {
            let frame = json!({ "kind": "run-result", "id": id, "result": trace_events_command(&db, &payload) });
            let _ = writer_tx.send(frame.to_string());
            return;
        }
        "trace-search" => {
            let frame =
                json!({ "kind": "run-result", "id": id, "result": trace_search(&db, &payload) });
            let _ = writer_tx.send(frame.to_string());
            return;
        }
        "trace-failed" => {
            let frame =
                json!({ "kind": "run-result", "id": id, "result": trace_failed(&db, &payload) });
            let _ = writer_tx.send(frame.to_string());
            return;
        }
        "trace-summary" => {
            let frame =
                json!({ "kind": "run-result", "id": id, "result": trace_summary(&db, &payload) });
            let _ = writer_tx.send(frame.to_string());
            return;
        }
        "trace-chat-tree" => {
            let frame =
                json!({ "kind": "run-result", "id": id, "result": trace_chat_tree(&db, &payload) });
            let _ = writer_tx.send(frame.to_string());
            return;
        }
        _ => {}
    }
    let source = bundle();
    let payload = payload_with_base_url(payload, base_url.as_deref());
    let result_value = submit_to_pool(&pool, source.clone(), payload.to_string());
    apply_driver_actions(&result_value, &pool, source);

    let frame = json!({
        "kind": "run-result",
        "id": id,
        "result": result_value,
    });
    let _ = writer_tx.send(frame.to_string());
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

fn v8_settings_payload(stored: crate::pool::V8RuntimeSettings) -> Value {
    json!({
        "settings": stored,
        "defaults": crate::pool::default_v8_runtime_settings(),
        "effective": crate::pool::effective_v8_runtime_settings(),
    })
}

fn v8_settings_get(db: &str) -> Value {
    let result = host::open_db(db).and_then(|conn| {
        if let Some(raw) = settings::get(&conn, settings::V8_CONFIG_KEY)? {
            let parsed = serde_json::from_str::<crate::pool::V8RuntimeSettings>(&raw)
                .map_err(|e| e.to_string())?;
            Ok(crate::pool::normalize_v8_runtime_settings(parsed))
        } else if let Some(env) = settings::get(&conn, settings::V8_ENV_KEY)? {
            crate::pool::apply_v8_env_text(&env);
            Ok(crate::pool::effective_v8_runtime_settings())
        } else {
            Ok(crate::pool::default_v8_runtime_settings())
        }
    });
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
    let result = host::open_db(db).and_then(|conn| {
        settings::set(&conn, settings::V8_CONFIG_KEY, &serialized)?;
        let _ = settings::clear(&conn, settings::V8_ENV_KEY);
        Ok(())
    });
    match result {
        Ok(()) => {
            crate::pool::apply_v8_runtime_settings(&parsed);
            json!({ "ok": true, "value": v8_settings_payload(parsed) })
        }
        Err(message) => json!({ "ok": false, "error": { "message": message } }),
    }
}

fn trace_error(message: impl Into<String>) -> Value {
    json!({ "ok": false, "error": { "message": message.into() } })
}

fn trace_ok(value: Value) -> Value {
    json!({ "ok": true, "value": value })
}

fn trace_payload<'a>(payload: &'a Value, key: &str) -> Option<&'a Value> {
    payload
        .get(key)
        .or_else(|| payload.get("input").and_then(|v| v.get(key)))
}

fn trace_string(payload: &Value, key: &str) -> Result<Option<String>, String> {
    match trace_payload(payload, key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        _ => Err(format!("{key} must be a string")),
    }
}

fn trace_required_string(payload: &Value, key: &str) -> Result<String, String> {
    trace_string(payload, key)?.ok_or_else(|| format!("{key} is required"))
}

fn trace_i64(payload: &Value, key: &str) -> Result<Option<i64>, String> {
    match trace_payload(payload, key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_i64()
            .ok_or_else(|| format!("{key} must be an integer"))
            .map(Some),
        _ => Err(format!("{key} must be a number")),
    }
}

fn trace_bool(payload: &Value, key: &str) -> Result<Option<bool>, String> {
    match trace_payload(payload, key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        _ => Err(format!("{key} must be a boolean")),
    }
}

fn trace_limit(payload: &Value, default: i64, max: i64) -> Result<i64, String> {
    Ok(trace_i64(payload, "limit")?
        .unwrap_or(default)
        .clamp(1, max))
}

fn trace_depth(payload: &Value, default: i32, max: i32) -> Result<i32, String> {
    Ok(trace_i64(payload, "maxDepth")?
        .unwrap_or(default as i64)
        .clamp(0, max as i64) as i32)
}

fn trace_row_to_json(row: &host::TraceRow) -> Value {
    let data_json = row
        .data_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or(Value::Null);
    json!({
        "id": row.id,
        "parentId": row.parent_id,
        "chatId": row.chat_id,
        "runId": row.run_id,
        "kind": row.kind,
        "name": row.name,
        "depth": row.depth,
        "seq": row.seq,
        "status": row.status,
        "startedMs": row.started_ms,
        "endedMs": row.ended_ms,
        "inputHash": row.input_hash,
        "outputHash": row.output_hash,
        "errorHash": row.error_hash,
        "invokedFromStepId": row.invoked_from_step_id,
        "dataJson": data_json,
    })
}

fn trace_event_to_json(row: &host::TraceEventRow) -> Value {
    json!({
        "id": row.id,
        "spanId": row.span_id,
        "tsMs": row.ts_ms,
        "level": row.level,
        "message": row.message,
        "dataHash": row.data_hash,
    })
}

fn trace_rows_json(rows: Vec<host::TraceRow>) -> Vec<Value> {
    rows.iter().map(trace_row_to_json).collect()
}

fn trace_events_json(rows: Vec<host::TraceEventRow>) -> Vec<Value> {
    rows.iter().map(trace_event_to_json).collect()
}

fn trace_ancestors_for_node(id: &str) -> Result<Vec<host::TraceRow>, String> {
    let mut ancestors = host::trace_ancestors(id)?;
    if ancestors.last().map(|row| row.id.as_str()) == Some(id) {
        ancestors.pop();
    }
    Ok(ancestors)
}

fn trace_chats(_db: &str, payload: &Value) -> Value {
    let result: Result<Value, String> = (|| {
        let limit = trace_limit(payload, 50, 200)?;
        let before_ms = trace_i64(payload, "beforeMs")?;
        Ok(json!({ "chats": trace_rows_json(host::trace_chat_roots(limit, before_ms)?) }))
    })();
    match result {
        Ok(value) => trace_ok(value),
        Err(message) => trace_error(message),
    }
}

fn trace_node(_db: &str, payload: &Value) -> Value {
    let result: Result<Value, String> = (|| {
        let id = trace_required_string(payload, "id")?;
        let node = host::trace_get(&id)?.ok_or_else(|| format!("trace node not found: {id}"))?;
        let children = host::trace_children(Some(&id), None)?;
        let ancestors = trace_ancestors_for_node(&id)?;
        let events = host::trace_events(&id, 1000, None)?;
        Ok(json!({
            "node": trace_row_to_json(&node),
            "children": trace_rows_json(children),
            "ancestors": trace_rows_json(ancestors),
            "events": trace_events_json(events),
        }))
    })();
    match result {
        Ok(value) => trace_ok(value),
        Err(message) => trace_error(message),
    }
}

fn trace_subtree_command(_db: &str, payload: &Value) -> Value {
    let result: Result<Value, String> = (|| {
        let id = trace_required_string(payload, "id")?;
        let max_depth = trace_depth(payload, 4, 10)?;
        Ok(json!({ "nodes": trace_rows_json(host::trace_subtree(&id, max_depth)?) }))
    })();
    match result {
        Ok(value) => trace_ok(value),
        Err(message) => trace_error(message),
    }
}

fn trace_events_command(_db: &str, payload: &Value) -> Value {
    let result: Result<Value, String> = (|| {
        let span_id = trace_required_string(payload, "spanId")?;
        let limit = trace_limit(payload, 200, 1000)?;
        let before_ms = trace_i64(payload, "beforeMs")?;
        Ok(json!({ "events": trace_events_json(host::trace_events(&span_id, limit, before_ms)?) }))
    })();
    match result {
        Ok(value) => trace_ok(value),
        Err(message) => trace_error(message),
    }
}

fn trace_search(_db: &str, payload: &Value) -> Value {
    let result: Result<Value, String> = (|| {
        let limit = trace_limit(payload, 50, 200)?;
        let query = host::TraceSearch {
            query: trace_string(payload, "query")?,
            kind: trace_string(payload, "kind")?,
            status: trace_string(payload, "status")?,
            chat_id: trace_string(payload, "chatId")?,
            run_id: trace_string(payload, "runId")?,
            has_error: trace_bool(payload, "hasError")?.unwrap_or(false),
            limit,
            before_ms: trace_i64(payload, "beforeMs")?,
        };
        let nodes = host::trace_search(query)?;
        let mut hits = Vec::with_capacity(nodes.len());
        for node in nodes {
            let ancestors = trace_ancestors_for_node(&node.id)?;
            hits.push(json!({ "node": trace_row_to_json(&node), "ancestors": trace_rows_json(ancestors) }));
        }
        Ok(json!({ "hits": hits }))
    })();
    match result {
        Ok(value) => trace_ok(value),
        Err(message) => trace_error(message),
    }
}

fn trace_failed(_db: &str, payload: &Value) -> Value {
    let result: Result<Value, String> = (|| {
        let limit = trace_limit(payload, 50, 200)?;
        let chat_id = trace_string(payload, "chatId")?;
        let before_ms = trace_i64(payload, "beforeMs")?;
        let nodes = host::trace_failed(limit, chat_id.as_deref(), before_ms)?;
        let mut failures = Vec::with_capacity(nodes.len());
        for node in nodes {
            let ancestors = trace_ancestors_for_node(&node.id)?;
            failures.push(json!({ "node": trace_row_to_json(&node), "ancestors": trace_rows_json(ancestors) }));
        }
        Ok(json!({ "failures": failures }))
    })();
    match result {
        Ok(value) => trace_ok(value),
        Err(message) => trace_error(message),
    }
}

fn trace_summary(_db: &str, payload: &Value) -> Value {
    let result: Result<Value, String> = (|| {
        let id = trace_required_string(payload, "id")?;
        let node = host::trace_get(&id)?.ok_or_else(|| format!("trace node not found: {id}"))?;
        let nodes = host::trace_subtree(&id, 10)?;
        let spans = nodes.len() as i64;
        let errors = nodes.iter().filter(|row| row.status == "error").count() as i64;
        let duration_ms = nodes
            .iter()
            .filter_map(|row| {
                row.ended_ms
                    .map(|ended| ended.saturating_sub(row.started_ms))
            })
            .sum::<i64>();
        let mut by_kind = serde_json::Map::new();
        let mut by_status = serde_json::Map::new();
        for row in &nodes {
            let n = by_kind.get(&row.kind).and_then(Value::as_i64).unwrap_or(0) + 1;
            by_kind.insert(row.kind.clone(), json!(n));
            let n = by_status
                .get(&row.status)
                .and_then(Value::as_i64)
                .unwrap_or(0)
                + 1;
            by_status.insert(row.status.clone(), json!(n));
        }
        let mut slowest = nodes.clone();
        slowest.sort_by(|a, b| {
            let da = a
                .ended_ms
                .map(|ended| ended.saturating_sub(a.started_ms))
                .unwrap_or(0);
            let db = b
                .ended_ms
                .map(|ended| ended.saturating_sub(b.started_ms))
                .unwrap_or(0);
            db.cmp(&da).then_with(|| b.started_ms.cmp(&a.started_ms))
        });
        slowest.truncate(5);
        Ok(json!({
            "node": trace_row_to_json(&node),
            "totals": {
                "spans": spans,
                "errors": errors,
                "durationMs": duration_ms,
                "byKind": Value::Object(by_kind),
                "byStatus": Value::Object(by_status),
            },
            "slowest": trace_rows_json(slowest),
        }))
    })();
    match result {
        Ok(value) => trace_ok(value),
        Err(message) => trace_error(message),
    }
}

fn trace_chat_tree(_db: &str, payload: &Value) -> Value {
    let result: Result<Value, String> = (|| {
        let chat_id = trace_required_string(payload, "chatId")?;
        let max_depth = trace_depth(payload, 6, 10)?;
        let root = host::trace_chat_root_for(&chat_id)?;
        let nodes = if let Some(root) = root.as_ref() {
            host::trace_subtree(&root.id, max_depth)?
        } else {
            Vec::new()
        };
        Ok(json!({
            "root": root.as_ref().map(trace_row_to_json),
            "nodes": trace_rows_json(nodes),
        }))
    })();
    match result {
        Ok(value) => trace_ok(value),
        Err(message) => trace_error(message),
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
}
