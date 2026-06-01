use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use rusqlite::OptionalExtension;
use rusqlite::{Connection, TransactionBehavior, params};
use serde_json::{Value, json};

use crate::broadcast;
use crate::settings;
use crate::util::{now_ms, now_ns, sha256_object_hash};

const DB_BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(30_000);
const TRACE_INLINE_JSON_LIMIT: usize = 1024;
const TRACE_BATCH_MAX_ROWS: usize = 128;
const TRACE_BATCH_MAX_DELAY: Duration = Duration::from_millis(50);

// Single shared connection for all DB access. Rust-level Mutex serialization is
// sub-millisecond work; SQLite WAL writer contention with busy_timeout is up to 30s.
static DB: Mutex<Option<Connection>> = Mutex::new(None);
static DB_INIT_LOCK: Mutex<()> = Mutex::new(());
static TRACE_EXPORTER: Mutex<Option<OtelTraceExporter>> = Mutex::new(None);
static NEXT_TRACE_SEQ: AtomicU64 = AtomicU64::new(1);
static TRACE_WRITE_QUEUE: LazyLock<TraceWriteQueue> = LazyLock::new(TraceWriteQueue::start);
static TRACE_IN_FLIGHT_ROWS: LazyLock<Mutex<HashMap<String, TraceInFlightRow>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Test-only switch that enables trace gating without configuring a network
/// exporter. Production `tracing_enabled()` is unaffected (this is compiled out
/// of non-test builds).
#[cfg(test)]
static TRACE_FORCE_ENABLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn lock_recover<'a, T>(mutex: &'a Mutex<T>, name: &str) -> MutexGuard<'a, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            eprintln!("{name} mutex poisoned; recovering inner value");
            poisoned.into_inner()
        }
    }
}

#[derive(Clone, Debug)]
struct OtelTraceExporter {
    config: settings::TraceConfig,
    endpoint: String,
    agent: ureq::Agent,
}

const OTEL_TIMEOUT: Duration = Duration::from_secs(10);

impl OtelTraceExporter {
    fn new(config: settings::TraceConfig) -> Self {
        let endpoint = config.otel_endpoint.clone();
        let agent = ureq::Agent::new_with_config(
            ureq::Agent::config_builder()
                .timeout_global(Some(OTEL_TIMEOUT))
                .http_status_as_error(false)
                .build(),
        );
        Self {
            config,
            endpoint,
            agent,
        }
    }

    fn export(&self, rows: &[TraceRow]) -> Result<(), String> {
        let spans = rows.iter().filter_map(otel_span_json).collect::<Vec<_>>();
        if spans.is_empty() {
            return Ok(());
        }
        let payload = json!({
            "resourceSpans": [{
                "resource": {
                    "attributes": [
                        otel_attr_string("service.name", &self.config.service_name),
                        otel_attr_string("telemetry.sdk.language", "rust"),
                        otel_attr_string("telemetry.sdk.name", "moo"),
                    ]
                },
                "scopeSpans": [{
                    "scope": { "name": "moo.trace" },
                    "spans": spans,
                }]
            }]
        });
        let body = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        let mut builder = ureq::http::Request::builder()
            .method("POST")
            .uri(&self.endpoint)
            .header("Content-Type", "application/json");
        for header in &self.config.headers {
            builder = builder.header(&header.name, &header.value);
        }
        let req = builder.body(body).map_err(|e| e.to_string())?;
        let mut resp = self.agent.run(req).map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let mut text = String::new();
        let _ = resp.body_mut().as_reader().read_to_string(&mut text);
        if status >= 400 {
            return Err(format!("otel export {status}: {text}"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default)]
struct TraceStore {
    rows: HashMap<String, TraceRow>,
    blobs: HashMap<String, (String, Vec<u8>)>,
}

static TRACE_STORE: LazyLock<Mutex<TraceStore>> =
    LazyLock::new(|| Mutex::new(TraceStore::default()));

fn trace_store_put_blob(hash: String, kind: String, bytes: Vec<u8>) {
    // Recover from poison (and log) rather than silently dropping the write —
    // every other TRACE_STORE consumer uses lock_recover, so a single panic
    // shouldn't permanently stop persisting trace data here.
    let mut store = lock_recover(&TRACE_STORE, "trace store");
    store.blobs.entry(hash).or_insert((kind, bytes));
}

fn trace_store_apply(row: TraceRow) {
    let mut store = lock_recover(&TRACE_STORE, "trace store");
    store
        .rows
        .entry(row.id.clone())
        .and_modify(|entry| merge_trace_row(entry, &row))
        .or_insert(row);
}

fn trace_store_get(id: &str) -> Option<TraceRow> {
    TRACE_STORE
        .lock()
        .ok()
        .and_then(|store| store.rows.get(id).cloned())
}

fn trace_store_rows() -> Vec<TraceRow> {
    TRACE_STORE
        .lock()
        .map(|store| store.rows.values().cloned().collect())
        .unwrap_or_default()
}

fn trace_store_blob(hash: &str) -> Option<(String, Vec<u8>)> {
    TRACE_STORE
        .lock()
        .ok()
        .and_then(|store| store.blobs.get(hash).cloned())
}

fn merge_trace_row(entry: &mut TraceRow, row: &TraceRow) {
    if entry.kind.is_empty() || !row.kind.is_empty() {
        entry.parent_id = row.parent_id.clone();
        entry.root_id = row.root_id.clone();
        entry.root_kind = row.root_kind.clone();
        entry.root_name = row.root_name.clone();
        entry.chat_id = row.chat_id.clone();
        entry.run_id = row.run_id.clone();
        entry.kind = row.kind.clone();
        entry.name = row.name.clone();
        entry.depth = row.depth;
        entry.seq = row.seq;
        entry.started_ns = row.started_ns;
        entry.input_hash = row.input_hash.clone();
        entry.invoked_from_step_id = row.invoked_from_step_id.clone();
    }
    entry.status = row.status.clone();
    entry.ended_ns = row.ended_ns;
    entry.output_hash = row.output_hash.clone();
    entry.error_hash = row.error_hash.clone();
    entry.data_json = row.data_json.clone();
    entry.data_hash = row.data_hash.clone();
}

fn trace_attr_value(value: &Value) -> Option<Value> {
    match value {
        Value::Null => None,
        Value::Bool(b) => Some(json!({ "boolValue": b })),
        Value::Number(n) => n
            .as_i64()
            .map(|v| json!({ "intValue": v.to_string() }))
            .or_else(|| n.as_u64().map(|v| json!({ "intValue": v.to_string() })))
            .or_else(|| n.as_f64().map(|v| json!({ "doubleValue": v }))),
        Value::String(s) => Some(json!({ "stringValue": s })),
        other => Some(json!({ "stringValue": other.to_string() })),
    }
}

fn otel_attr_string(key: &str, value: &str) -> Value {
    json!({ "key": key, "value": { "stringValue": value } })
}

fn otel_attr_i64(key: &str, value: i64) -> Value {
    json!({ "key": key, "value": { "intValue": value.to_string() } })
}

fn otel_attr_json(key: &str, value: &Value) -> Option<Value> {
    trace_attr_value(value).map(|value| json!({ "key": key, "value": value }))
}

fn otel_trace_id(root_id: &str) -> String {
    stable_hex(root_id, 16)
}

fn otel_span_id(id: &str) -> String {
    stable_hex(id, 8)
}

fn stable_hex(input: &str, bytes: usize) -> String {
    let hash = sha256_object_hash("otel:id", input.as_bytes());
    let raw = hash.strip_prefix("sha256:").unwrap_or(&hash);
    raw.chars().take(bytes * 2).collect()
}

fn otel_span_json(row: &TraceRow) -> Option<Value> {
    let end = row.ended_ns?;
    let mut attrs = vec![
        otel_attr_string("moo.trace.id", &row.id),
        otel_attr_string("moo.trace.kind", &row.kind),
        otel_attr_string("moo.trace.status", &row.status),
        otel_attr_i64("moo.trace.seq", row.seq),
        otel_attr_i64("moo.trace.depth", row.depth),
    ];
    if let Some(chat_id) = &row.chat_id {
        attrs.push(otel_attr_string("moo.chat.id", chat_id));
    }
    if let Some(run_id) = &row.run_id {
        attrs.push(otel_attr_string("moo.run.id", run_id));
    }
    if let Some(step_id) = &row.invoked_from_step_id {
        attrs.push(otel_attr_string("moo.step.id", step_id));
    }
    for (key, hash) in [
        ("moo.trace.input_hash", &row.input_hash),
        ("moo.trace.output_hash", &row.output_hash),
        ("moo.trace.error_hash", &row.error_hash),
        ("moo.trace.data_hash", &row.data_hash),
    ] {
        if let Some(hash) = hash {
            attrs.push(otel_attr_string(key, hash));
        }
    }
    if let Some(data_json) = &row.data_json {
        if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(data_json) {
            for (key, value) in map.iter().take(64) {
                if key.len() <= 128
                    && let Some(attr) = otel_attr_json(&format!("moo.data.{key}"), value)
                {
                    attrs.push(attr);
                }
            }
        } else {
            attrs.push(otel_attr_string("moo.trace.data", data_json));
        }
    }
    let mut span = json!({
        "traceId": otel_trace_id(&row.root_id),
        "spanId": otel_span_id(&row.id),
        "name": row.name,
        "kind": 1,
        "startTimeUnixNano": row.started_ns.to_string(),
        "endTimeUnixNano": end.max(row.started_ns).to_string(),
        "attributes": attrs,
        "status": otel_status(&row.status, row.error_hash.is_some()),
    });
    if let Some(parent_id) = &row.parent_id {
        span["parentSpanId"] = Value::String(otel_span_id(parent_id));
    }
    Some(span)
}

fn otel_status(status: &str, has_error: bool) -> Value {
    match status {
        "ok" => json!({ "code": 1 }),
        "error" => json!({ "code": 2, "message": "error" }),
        "cancelled" => json!({ "code": 2, "message": "cancelled" }),
        "timeout" => json!({ "code": 2, "message": "timeout" }),
        other if has_error => json!({ "code": 2, "message": other }),
        _ => json!({ "code": 0 }),
    }
}

enum TraceWrite {
    Span(Box<TraceRow>),
    State(Box<TraceRow>),
    Blob {
        hash: String,
        kind: String,
        bytes: Vec<u8>,
    },
}

#[derive(Clone, Debug)]
struct TraceInFlightRow {
    row: TraceRow,
    pending_writes: usize,
}

struct TraceWriteQueue {
    tx: Sender<TraceWrite>,
}

impl TraceWriteQueue {
    fn start() -> Self {
        let (tx, rx) = mpsc::channel::<TraceWrite>();
        thread::Builder::new()
            .name("moo-trace-writer".to_string())
            .spawn(move || {
                let mut batch = Vec::with_capacity(TRACE_BATCH_MAX_ROWS);
                while let Ok(first) = rx.recv() {
                    batch.push(first);
                    loop {
                        if batch.len() >= TRACE_BATCH_MAX_ROWS {
                            break;
                        }
                        match rx.recv_timeout(TRACE_BATCH_MAX_DELAY) {
                            Ok(item) => batch.push(item),
                            Err(RecvTimeoutError::Timeout)
                            | Err(RecvTimeoutError::Disconnected) => break,
                        }
                    }
                    let result = flush_trace_writes(&batch);
                    complete_trace_in_flight_writes(&batch);
                    if let Err(error) = result {
                        report_trace_write_error(error, batch.len());
                    }
                    batch.clear();
                }
            })
            .expect("spawn trace writer");
        Self { tx }
    }
    fn enqueue(&self, write: TraceWrite) -> Result<(), (String, TraceWrite)> {
        self.tx.send(write).map_err(|e| (e.to_string(), e.0))
    }
}

fn report_trace_write_error(message: String, rows: usize) {
    let endpoint = current_trace_exporter().map(|exporter| exporter.endpoint);
    broadcast::publish(
        serde_json::json!({ "kind": "otel-export-error", "message": message, "rows": rows, "endpoint": endpoint, "at": now_ms() })
            .to_string(),
    );
}

fn flush_trace_writes(writes: &[TraceWrite]) -> Result<(), String> {
    let mut finished = Vec::new();
    for write in writes {
        match write {
            TraceWrite::Span(row) | TraceWrite::State(row) => {
                trace_store_apply((**row).clone());
                if row.ended_ns.is_some() {
                    finished.push((**row).clone());
                }
            }
            TraceWrite::Blob { hash, kind, bytes } => {
                trace_store_put_blob(hash.clone(), kind.clone(), bytes.clone());
            }
        }
    }
    if let Some(exporter) = current_trace_exporter() {
        exporter.export(&finished)?;
    }
    Ok(())
}

fn enqueue_trace_write(write: TraceWrite) -> Result<(), String> {
    // Register before enqueue (race-free on the success path), then roll the
    // registration back if enqueue fails (writer thread gone), recovering the
    // moved value from SendError so the in-flight row count doesn't leak.
    register_trace_in_flight_write(&write);
    match TRACE_WRITE_QUEUE.enqueue(write) {
        Ok(()) => Ok(()),
        Err((message, write)) => {
            complete_trace_in_flight_writes(std::slice::from_ref(&write));
            Err(message)
        }
    }
}

fn register_trace_in_flight_write(write: &TraceWrite) {
    let mut rows = lock_recover(&TRACE_IN_FLIGHT_ROWS, "trace in-flight rows");
    match write {
        TraceWrite::Span(row) => {
            rows.entry(row.id.clone())
                .and_modify(|entry| {
                    let previous_state = (
                        entry.row.status.clone(),
                        entry.row.ended_ns,
                        entry.row.output_hash.clone(),
                        entry.row.error_hash.clone(),
                        entry.row.data_json.clone(),
                        entry.row.data_hash.clone(),
                    );
                    entry.row = (**row).clone();
                    entry.row.status = previous_state.0;
                    entry.row.ended_ns = previous_state.1;
                    entry.row.output_hash = previous_state.2;
                    entry.row.error_hash = previous_state.3;
                    entry.row.data_json = previous_state.4;
                    entry.row.data_hash = previous_state.5;
                    entry.pending_writes = entry.pending_writes.saturating_add(1);
                })
                .or_insert_with(|| TraceInFlightRow {
                    row: (**row).clone(),
                    pending_writes: 1,
                });
        }
        TraceWrite::State(row) => {
            rows.entry(row.id.clone())
                .and_modify(|entry| {
                    entry.row.status = row.status.clone();
                    entry.row.ended_ns = row.ended_ns;
                    entry.row.output_hash = row.output_hash.clone();
                    entry.row.error_hash = row.error_hash.clone();
                    entry.row.data_json = row.data_json.clone();
                    entry.row.data_hash = row.data_hash.clone();
                    entry.pending_writes = entry.pending_writes.saturating_add(1);
                })
                .or_insert_with(|| TraceInFlightRow {
                    row: (**row).clone(),
                    pending_writes: 1,
                });
        }
        TraceWrite::Blob { .. } => {}
    }
}

fn trace_write_row_id(write: &TraceWrite) -> Option<&str> {
    match write {
        TraceWrite::Span(row) | TraceWrite::State(row) => Some(row.id.as_str()),
        TraceWrite::Blob { .. } => None,
    }
}

fn complete_trace_in_flight_writes(writes: &[TraceWrite]) {
    let mut rows = lock_recover(&TRACE_IN_FLIGHT_ROWS, "trace in-flight rows");
    for write in writes {
        let Some(id) = trace_write_row_id(write) else {
            continue;
        };
        let should_remove = if let Some(entry) = rows.get_mut(id) {
            entry.pending_writes = entry.pending_writes.saturating_sub(1);
            entry.pending_writes == 0
        } else {
            false
        };
        if should_remove {
            rows.remove(id);
        }
    }
}

fn trace_in_flight_get(id: &str) -> Option<TraceRow> {
    TRACE_IN_FLIGHT_ROWS
        .lock()
        .ok()
        .and_then(|rows| rows.get(id).map(|entry| entry.row.clone()))
}

fn trace_in_flight_children(parent_id: Option<&str>, limit: Option<i64>) -> Vec<TraceRow> {
    let Ok(rows) = TRACE_IN_FLIGHT_ROWS.lock() else {
        return vec![];
    };
    let mut rows: Vec<TraceRow> = rows
        .values()
        .filter(|entry| entry.row.parent_id.as_deref() == parent_id)
        .map(|entry| entry.row.clone())
        .collect();
    rows.sort_by_key(|row| (row.depth, row.seq));
    if let Some(limit) = limit {
        rows.truncate(limit.max(0) as usize);
    }
    rows
}

fn current_trace_exporter() -> Option<OtelTraceExporter> {
    lock_recover(&TRACE_EXPORTER, "trace exporter").clone()
}

pub fn with_db<R>(f: impl FnOnce(&mut Connection) -> R) -> R {
    let mut guard = lock_recover(&DB, "db");
    let conn = guard
        .as_mut()
        .expect("db not initialized — call host::install() first");
    f(conn)
}

const MAIN_SCHEMA_SQL: &str = r#"
create table if not exists objects (
  hash text primary key,
  kind text not null,
  bytes blob not null,
  created_at integer not null
);
create table if not exists refs (
  name text primary key,
  target text not null,
  updated_at integer not null
);
create table if not exists ref_log (
  id integer primary key autoincrement,
  name text not null,
  old_target text,
  new_target text,
  created_at integer not null
);
create table if not exists quads (
  ref_name text not null,
  graph text not null,
  subject text not null,
  predicate text not null,
  object text not null,
  created_by text not null default 'system',
  primary key(ref_name, graph, subject, predicate, object)
) without rowid;
create index if not exists quads_by_spo on quads(ref_name, subject, predicate, object);
create index if not exists quads_by_pos on quads(ref_name, predicate, object, subject);
create index if not exists quads_by_gpo on quads(ref_name, graph, predicate, object, subject);
create index if not exists quads_by_ops on quads(ref_name, object, predicate, subject);
create index if not exists quads_by_gsp on quads(ref_name, graph, subject, predicate, object);
create table if not exists fact_log (
  id integer primary key autoincrement,
  ref_name text not null,
  graph text not null,
  subject text not null,
  predicate text not null,
  object text not null,
  action text not null,
  created_by text not null default 'system',
  created_at integer not null
);
create index if not exists fact_log_by_ref_gspo_time
  on fact_log(ref_name, graph, subject, predicate, object, created_at, id);
create index if not exists fact_log_by_ref_time
  on fact_log(ref_name, created_at, id);
create table if not exists settings (
  key text primary key,
  value text not null,
  updated_at integer not null
);
"#;

pub fn install_db(db_path: &str) -> Result<(), String> {
    let installed = {
        let mut guard = lock_recover(&DB, "db");
        if guard.is_none() {
            *guard = Some(open_db(db_path)?);
            true
        } else {
            false
        }
    };
    if installed {
        crate::ops::facts::clear_chat_fact_summaries_cache();
    }
    Ok(())
}

pub fn install(db_path: &str) -> Result<(), String> {
    install_db(db_path)?;
    let trace_config = with_db(|conn| trace_config_from_db_env(conn))?;
    install_trace_config_async(trace_config);
    Ok(())
}

fn install_trace_config_async(config: settings::TraceConfig) {
    apply_trace_config_local(&config);
}

fn apply_trace_config_local(config: &settings::TraceConfig) {
    let config = settings::normalize_trace_config(config.clone());
    let mut guard = lock_recover(&TRACE_EXPORTER, "trace exporter");
    if !config.enabled {
        *guard = None;
        return;
    }
    if guard
        .as_ref()
        .map(|exporter| exporter.config == config)
        .unwrap_or(false)
    {
        return;
    }
    *guard = Some(OtelTraceExporter::new(config));
}

pub fn test_trace_config(config: &settings::TraceConfig) -> Result<(), String> {
    let config = settings::normalize_trace_config(config.clone());
    if !config.enabled {
        return Ok(());
    }
    let exporter = OtelTraceExporter::new(config);
    if exporter.endpoint.trim().is_empty() {
        return Err("OTEL endpoint is empty".to_string());
    }
    let now = now_ns();
    let sample = TraceRow {
        id: "otel-config-test".to_string(),
        parent_id: None,
        root_id: "otel-config-test".to_string(),
        root_kind: "system".to_string(),
        root_name: "otel config test".to_string(),
        chat_id: None,
        run_id: None,
        kind: "system".to_string(),
        name: "otel config test".to_string(),
        depth: 0,
        seq: 0,
        status: "ok".to_string(),
        started_ns: now,
        ended_ns: Some(now.saturating_add(1_000_000)),
        input_hash: None,
        output_hash: None,
        error_hash: None,
        invoked_from_step_id: None,
        data_json: Some(json!({ "source": "settings", "test": true }).to_string()),
        data_hash: None,
    };
    exporter.export(&[sample])
}

pub fn apply_trace_config(config: &settings::TraceConfig) -> Result<(), String> {
    apply_trace_config_local(config);
    Ok(())
}

pub fn tracing_enabled() -> bool {
    #[cfg(test)]
    if TRACE_FORCE_ENABLED.load(Ordering::Relaxed) {
        return true;
    }
    otel_reporting_enabled()
}

/// RAII switch letting tests exercise the trace pipeline without a network
/// exporter. Tracing is gated on while the guard lives; export is still skipped
/// because no `OtelTraceExporter` is configured, so trace writes only land in
/// the in-memory store / in-flight maps that tests read back.
#[cfg(test)]
pub struct TracingTestGuard;

#[cfg(test)]
pub fn enable_tracing_for_test() -> TracingTestGuard {
    TRACE_FORCE_ENABLED.store(true, Ordering::Relaxed);
    TracingTestGuard
}

#[cfg(test)]
impl Drop for TracingTestGuard {
    fn drop(&mut self) {
        TRACE_FORCE_ENABLED.store(false, Ordering::Relaxed);
    }
}

pub fn otel_reporting_enabled() -> bool {
    current_trace_exporter().is_some()
}

pub fn trace_config_from_conn(conn: &Connection) -> Result<settings::TraceConfig, String> {
    trace_config_from_db_env(conn)
}

fn trace_config_from_db_env(conn: &Connection) -> Result<settings::TraceConfig, String> {
    let mut config = if let Some(raw) = settings::get(conn, settings::TRACE_CONFIG_KEY)? {
        let parsed = serde_json::from_str::<settings::TraceConfig>(&raw)
            .map_err(|e| format!("invalid {}: {e}", settings::TRACE_CONFIG_KEY))?;
        settings::normalize_trace_config(parsed)
    } else {
        settings::default_trace_config()
    };
    apply_trace_env_overrides(&mut config);
    Ok(settings::normalize_trace_config(config))
}

fn apply_trace_env_overrides(config: &mut settings::TraceConfig) {
    if let Some(enabled) = env_bool("MOO_TRACE_ENABLED") {
        config.enabled = enabled;
    }
    if let Some(enabled) = env_bool("MOO_OTEL_ENABLED") {
        config.enabled = enabled;
    }
    if let Ok(value) = env::var("MOO_OTEL_ENDPOINT") {
        config.otel_endpoint = value;
    }
    if let Ok(value) = env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") {
        config.otel_endpoint = value;
    } else if let Ok(value) = env::var("OTEL_EXPORTER_OTLP_ENDPOINT") {
        config.otel_endpoint = format!("{}/v1/traces", value.trim().trim_end_matches('/'));
    }
    if let Ok(value) = env::var("MOO_OTEL_SERVICE_NAME") {
        config.service_name = value;
    }
    if let Ok(value) = env::var("OTEL_SERVICE_NAME") {
        config.service_name = value;
    }
    if let Ok(value) = env::var("MOO_OTEL_HEADERS") {
        config.headers = parse_otel_headers(&value);
    }
    if let Ok(value) = env::var("OTEL_EXPORTER_OTLP_TRACES_HEADERS") {
        config.headers.extend(parse_otel_headers(&value));
    } else if let Ok(value) = env::var("OTEL_EXPORTER_OTLP_HEADERS") {
        config.headers.extend(parse_otel_headers(&value));
    }
}

fn parse_otel_headers(raw: &str) -> Vec<settings::OtelHeader> {
    raw.split(',')
        .filter_map(|part| {
            let (name, value) = part.split_once('=')?;
            let name = name.trim();
            if name.is_empty() {
                return None;
            }
            Some(settings::OtelHeader {
                name: name.to_string(),
                value: value.trim().to_string(),
            })
        })
        .collect()
}

fn env_bool(name: &str) -> Option<bool> {
    let value = env::var(name).ok()?;
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "y" | "on" => Some(true),
        "0" | "false" | "no" | "n" | "off" => Some(false),
        _ => None,
    }
}

/// Tests that need a fresh DB must hold this lock for the entire test scope,
/// then call `install_fresh` to replace the global connection.
#[cfg(test)]
pub static TEST_DB_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub fn install_fresh(db_path: &str) -> Result<(), String> {
    {
        *lock_recover(&DB, "db") = Some(open_db(db_path)?);
    }
    crate::ops::facts::clear_chat_fact_summaries_cache();
    lock_recover(&TRACE_IN_FLIGHT_ROWS, "trace in-flight rows").clear();
    NEXT_TRACE_SEQ.store(1, Ordering::Relaxed);
    *lock_recover(&TRACE_EXPORTER, "trace exporter") = None;
    *lock_recover(&TRACE_STORE, "trace store") = TraceStore::default();
    Ok(())
}

pub fn open_db(path: &str) -> Result<Connection, String> {
    let conn = open_db_with_schema(path, MAIN_SCHEMA_SQL)?;
    migrate_direct_json_pointers_conn(&conn)?;
    Ok(conn)
}

pub fn open_settings_db(path: &str) -> Result<Connection, String> {
    open_db_with_schema(path, MAIN_SCHEMA_SQL)
}

fn open_db_with_schema(path: &str, schema_sql: &str) -> Result<Connection, String> {
    let _init_guard = lock_recover(&DB_INIT_LOCK, "db init");
    if let Some(parent) = PathBuf::from(path).parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.set_transaction_behavior(TransactionBehavior::Immediate);
    conn.busy_timeout(DB_BUSY_TIMEOUT)
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "pragma journal_mode=WAL; pragma synchronous=NORMAL; pragma temp_store=MEMORY; pragma auto_vacuum=INCREMENTAL;",
    )
    .map_err(|e| e.to_string())?;
    conn.execute_batch(schema_sql).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn is_direct_json_pointer_name(name: &str, kind: &str) -> bool {
    let parts: Vec<&str> = name.split('/').collect();
    match (kind, parts.as_slice()) {
        ("agent:Usage", ["chat", chat_id, "usage"]) => !chat_id.is_empty(),
        ("agent:Compaction", ["chat", chat_id, "compaction"]) => !chat_id.is_empty(),
        ("ui:State", ["uiinst", instance_id, "state"]) => !instance_id.is_empty(),
        ("mcp:Session", ["mcp", server_id, "session"]) => !server_id.is_empty(),
        _ => false,
    }
}

fn direct_json_pointer_target(
    kind: &str,
    bytes: &[u8],
    hash: &str,
) -> Result<Option<String>, String> {
    let mut value: serde_json::Value = match serde_json::from_slice(bytes) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if kind == "agent:Compaction" {
        let Some(obj) = value.as_object_mut() else {
            return Ok(None);
        };
        if !obj.contains_key("hash") {
            obj.insert(
                "hash".to_string(),
                serde_json::Value::String(hash.to_string()),
            );
        }
    }
    serde_json::to_string(&value)
        .map(|json| Some(format!("json:{json}")))
        .map_err(|e| e.to_string())
}

fn migrate_direct_json_pointers_conn(conn: &Connection) -> Result<usize, String> {
    let updates: Vec<(String, String, String)> = {
        let mut stmt = conn
            .prepare(
                "select refs.name, refs.target, objects.kind, objects.bytes
                 from refs join objects on objects.hash = refs.target
                 where refs.target like 'sha256:%'
                   and objects.kind in ('agent:Usage', 'agent:Compaction', 'ui:State', 'mcp:Session')",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Vec<u8>>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut updates = Vec::new();
        for row in rows {
            let (name, old_target, kind, bytes) = row.map_err(|e| e.to_string())?;
            if !is_direct_json_pointer_name(&name, &kind) {
                continue;
            }
            if let Some(next_target) = direct_json_pointer_target(&kind, &bytes, &old_target)? {
                updates.push((name, old_target, next_target));
            }
        }
        updates
    };

    if updates.is_empty() {
        return Ok(0);
    }

    let mut changed = 0usize;
    let now = now_ms();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (name, old_target, next_target) in updates {
        let n = tx
            .execute(
                "update refs set target = ?1, updated_at = ?2 where name = ?3 and target = ?4",
                params![&next_target, now, &name, &old_target],
            )
            .map_err(|e| e.to_string())?;
        if n > 0 {
            changed += n;
            tx.execute(
                "insert into ref_log(name, old_target, new_target, created_at) values (?1, ?2, ?3, ?4)",
                params![&name, &old_target, &next_target, now],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(changed)
}

fn infer_trace_root_kind_name(id: &str) -> (&'static str, String) {
    if let Some(rest) = id.strip_prefix("command:") {
        let command = rest.split(':').next().unwrap_or(rest);
        return ("command", format!("command {command}"));
    }
    if id.starts_with("step:") {
        // A step is always a child in the trace tree. If the concrete step row
        // is missing when a trace is attached to it, backfill a chat-shaped
        // ancestor under the step id rather than creating a root `step` span.
        return ("missing-parent", id.to_string());
    }
    if id.starts_with("trace:") {
        return ("trace", id.to_string());
    }
    ("system", id.to_string())
}

pub fn put_object(kind: &str, bytes: &[u8]) -> Result<String, String> {
    let hash = sha256_object_hash(kind, bytes);
    with_db(|conn| {
        conn.prepare_cached(
            "insert or ignore into objects(hash, kind, bytes, created_at)
             values (?1, ?2, ?3, ?4)",
        )
        .map_err(|e| e.to_string())?
        .execute(params![&hash, kind, bytes, now_ms()])
        .map_err(|e| e.to_string())?;
        Ok(hash)
    })
}

pub fn get_object(hash: &str) -> Result<Option<(String, Vec<u8>)>, String> {
    if let Some(blob) = trace_store_blob(hash) {
        return Ok(Some(blob));
    }
    with_db(|conn| {
        conn.prepare_cached("select kind, bytes from objects where hash = ?1")
            .map_err(|e| e.to_string())?
            .query_row(params![hash], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
            })
            .optional()
            .map_err(|e| e.to_string())
    })
}

#[derive(Debug, Clone)]
pub struct TraceRow {
    pub id: String,
    pub parent_id: Option<String>,
    pub root_id: String,
    pub root_kind: String,
    pub root_name: String,
    pub chat_id: Option<String>,
    pub run_id: Option<String>,
    pub kind: String,
    pub name: String,
    pub depth: i64,
    pub seq: i64,
    pub status: String,
    pub started_ns: i64,
    pub ended_ns: Option<i64>,
    pub input_hash: Option<String>,
    pub output_hash: Option<String>,
    pub error_hash: Option<String>,
    pub invoked_from_step_id: Option<String>,
    pub data_json: Option<String>,
    pub data_hash: Option<String>,
}

pub struct TraceRootParams<'a> {
    pub id: &'a str,
    pub chat_id: Option<&'a str>,
    pub run_id: Option<&'a str>,
    pub kind: &'a str,
    pub name: &'a str,
    pub status: Option<&'a str>,
    pub started_ns: i64,
    pub input_hash: Option<&'a str>,
    pub data_json: Option<&'a str>,
}

fn trace_put_blob_queued(kind: &str, bytes: &[u8]) -> Result<String, String> {
    let hash = put_object(kind, bytes)?;
    enqueue_trace_write(TraceWrite::Blob {
        hash: hash.clone(),
        kind: kind.to_string(),
        bytes: bytes.to_vec(),
    })?;
    Ok(hash)
}
struct PreparedTraceData {
    inline_json: Option<String>,
    hash: Option<String>,
}

fn prepare_trace_data_queued(data_json: Option<&str>) -> Result<PreparedTraceData, String> {
    let Some(raw) = data_json else {
        return Ok(PreparedTraceData {
            inline_json: None,
            hash: None,
        });
    };
    let bytes = raw.as_bytes();
    if bytes.len() <= TRACE_INLINE_JSON_LIMIT {
        return Ok(PreparedTraceData {
            inline_json: Some(raw.to_string()),
            hash: None,
        });
    }
    let hash = trace_put_blob_queued("trace:Data", bytes)?;
    Ok(PreparedTraceData {
        inline_json: None,
        hash: Some(hash),
    })
}

pub fn trace_ensure_root(params: TraceRootParams<'_>) -> Result<(), String> {
    if !tracing_enabled() {
        return Ok(());
    }
    let TraceRootParams {
        id,
        chat_id,
        run_id,
        kind,
        name,
        status,
        started_ns,
        input_hash,
        data_json,
    } = params;
    if trace_get(id)?.is_some() {
        return Ok(());
    }
    let status = status.unwrap_or("ok");
    let seq = NEXT_TRACE_SEQ.fetch_add(1, Ordering::Relaxed) as i64;
    let prepared = prepare_trace_data_queued(data_json)?;
    let row = TraceRow {
        id: id.to_string(),
        parent_id: None,
        root_id: id.to_string(),
        root_kind: kind.to_string(),
        root_name: name.to_string(),
        chat_id: chat_id.map(ToString::to_string),
        run_id: run_id.map(ToString::to_string),
        kind: kind.to_string(),
        name: name.to_string(),
        depth: 0,
        seq,
        status: status.to_string(),
        started_ns,
        ended_ns: if status == "running" {
            None
        } else {
            Some(started_ns)
        },
        input_hash: input_hash.map(ToString::to_string),
        output_hash: None,
        error_hash: None,
        invoked_from_step_id: None,
        data_json: prepared.inline_json,
        data_hash: prepared.hash,
    };
    enqueue_trace_write(TraceWrite::Span(Box::new(row.clone())))?;
    enqueue_trace_write(TraceWrite::State(Box::new(row)))?;
    Ok(())
}

pub struct TraceOpenParams<'a> {
    pub id: &'a str,
    pub parent_id: Option<&'a str>,
    pub chat_id: Option<&'a str>,
    pub run_id: Option<&'a str>,
    pub kind: &'a str,
    pub name: &'a str,
    pub started_ns: i64,
    pub input_hash: Option<&'a str>,
    pub invoked_from_step_id: Option<&'a str>,
    pub data_json: Option<&'a str>,
}

pub fn trace_open(params: TraceOpenParams<'_>) -> Result<(), String> {
    if !tracing_enabled() {
        return Ok(());
    }
    let TraceOpenParams {
        id,
        parent_id,
        chat_id,
        run_id,
        kind,
        name,
        started_ns,
        input_hash,
        invoked_from_step_id,
        data_json,
    } = params;
    if trace_get(id)?.is_some() {
        return Ok(());
    }
    let parent = match parent_id {
        Some(parent_id) => match trace_get(parent_id)? {
            Some(row) => Some((
                row.depth,
                row.chat_id,
                row.run_id,
                row.root_id,
                row.root_kind,
                row.root_name,
            )),
            None => {
                let (kind, name) = infer_trace_root_kind_name(parent_id);
                trace_ensure_root(TraceRootParams {
                    id: parent_id,
                    chat_id,
                    run_id,
                    kind,
                    name: &name,
                    status: None,
                    started_ns,
                    input_hash: None,
                    data_json: Some(r#"{"backfilled":"missing live trace parent"}"#),
                })?;
                trace_get(parent_id)?.map(|row| {
                    (
                        row.depth,
                        row.chat_id,
                        row.run_id,
                        row.root_id,
                        row.root_kind,
                        row.root_name,
                    )
                })
            }
        },
        None => None,
    };
    let seq = NEXT_TRACE_SEQ.fetch_add(1, Ordering::Relaxed) as i64;
    let prepared = prepare_trace_data_queued(data_json)?;
    let (depth, inherited_chat_id, inherited_run_id, root_id, root_kind, root_name) = parent
        .unwrap_or_else(|| {
            (
                0,
                None,
                None,
                id.to_string(),
                kind.to_string(),
                name.to_string(),
            )
        });
    let row = TraceRow {
        id: id.to_string(),
        parent_id: parent_id.map(ToString::to_string),
        root_id,
        root_kind,
        root_name,
        chat_id: chat_id.map(ToString::to_string).or(inherited_chat_id),
        run_id: run_id.map(ToString::to_string).or(inherited_run_id),
        kind: kind.to_string(),
        name: name.to_string(),
        depth: if parent_id.is_some() { depth + 1 } else { 0 },
        seq,
        status: "running".to_string(),
        started_ns,
        ended_ns: None,
        input_hash: input_hash.map(ToString::to_string),
        output_hash: None,
        error_hash: None,
        invoked_from_step_id: invoked_from_step_id.map(ToString::to_string),
        data_json: prepared.inline_json,
        data_hash: prepared.hash,
    };
    enqueue_trace_write(TraceWrite::Span(Box::new(row.clone())))?;
    enqueue_trace_write(TraceWrite::State(Box::new(row)))?;
    Ok(())
}

pub fn trace_update_data(id: &str, data_json: Option<&str>) -> Result<bool, String> {
    let mut row = if let Some(row) = trace_in_flight_get(id) {
        row
    } else if let Some(row) = trace_store_get(id) {
        row
    } else {
        return Ok(false);
    };
    let prepared = prepare_trace_data_queued(data_json)?;
    row.data_json = prepared.inline_json;
    row.data_hash = prepared.hash;
    if row.status == "running" && row.ended_ns.is_some() {
        row.ended_ns = None;
    }
    enqueue_trace_write(TraceWrite::State(Box::new(row)))?;
    Ok(true)
}

pub fn trace_finish(
    id: &str,
    ended_ns: i64,
    status: &str,
    output_hash: Option<&str>,
    error_hash: Option<&str>,
    data_json: Option<&str>,
) -> Result<bool, String> {
    let mut row = if let Some(row) = trace_in_flight_get(id) {
        row
    } else if let Some(row) = trace_store_get(id) {
        row
    } else {
        return Ok(false);
    };
    let prepared = prepare_trace_data_queued(data_json)?;
    row.ended_ns = Some(ended_ns);
    row.status = status.to_string();
    row.output_hash = output_hash.map(ToString::to_string);
    row.error_hash = error_hash.map(ToString::to_string);
    row.data_json = prepared.inline_json;
    row.data_hash = prepared.hash;
    enqueue_trace_write(TraceWrite::State(Box::new(row)))?;
    Ok(true)
}

pub fn trace_get(id: &str) -> Result<Option<TraceRow>, String> {
    if let Some(row) = trace_in_flight_get(id) {
        return Ok(Some(row));
    }
    Ok(trace_store_get(id))
}

pub fn trace_children(
    parent_id: Option<&str>,
    limit: Option<i64>,
) -> Result<Vec<TraceRow>, String> {
    let mut rows: Vec<TraceRow> = trace_store_rows()
        .into_iter()
        .filter(|row| row.parent_id.as_deref() == parent_id)
        .collect();
    let mut in_flight = trace_in_flight_children(parent_id, None);
    rows.append(&mut in_flight);
    dedupe_trace_rows(&mut rows);
    rows.sort_by_key(|row| (row.depth, row.seq));
    if let Some(limit) = limit {
        rows.truncate(limit.max(0) as usize);
    }
    Ok(rows)
}

fn dedupe_trace_rows(rows: &mut Vec<TraceRow>) {
    let mut deduped: HashMap<String, TraceRow> = HashMap::new();
    for row in rows.drain(..) {
        deduped
            .entry(row.id.clone())
            .and_modify(|entry| merge_trace_row(entry, &row))
            .or_insert(row);
    }
    rows.extend(deduped.into_values());
}
