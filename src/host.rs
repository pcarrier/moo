use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use rusqlite::OptionalExtension;
use rusqlite::{Connection, TransactionBehavior, params};
use serde_json::Value;

use crate::broadcast;
use crate::settings;
use crate::util::{now_ms, now_ns, sha256_object_hash};

const DB_BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(30_000);
const TRACE_INLINE_JSON_LIMIT: usize = 1024;
const TRACE_BATCH_MAX_ROWS: usize = 128;
const TRACE_BATCH_MAX_DELAY: Duration = Duration::from_millis(50);

// Single shared connection for all DB access. Rust-level Mutex serialization is
// microseconds; SQLite WAL writer contention with busy_timeout is up to 30s.
static DB: Mutex<Option<Connection>> = Mutex::new(None);
static DB_INIT_LOCK: Mutex<()> = Mutex::new(());
static TRACE_BACKEND: Mutex<Option<ClickHouseTraceClient>> = Mutex::new(None);
static TRACE_INITIALIZING: Mutex<Option<settings::TraceConfig>> = Mutex::new(None);
static NEXT_TRACE_EVENT_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_TRACE_SEQ: AtomicU64 = AtomicU64::new(1);
static TRACE_WRITE_QUEUE: LazyLock<TraceWriteQueue> = LazyLock::new(TraceWriteQueue::start);
static TRACE_SHADOW_ROWS: LazyLock<Mutex<HashMap<String, TraceRow>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Debug)]
struct ClickHouseTraceClient {
    config: settings::TraceConfig,
    trace_table: String,
    state_table: String,
    event_table: String,
    blob_table: String,
    agent: ureq::Agent,
}

const CH_TIMEOUT: Duration = Duration::from_secs(10);

impl ClickHouseTraceClient {
    fn new(config: settings::TraceConfig) -> Self {
        let trace_table = config.clickhouse_table_prefix.clone();
        let agent = ureq::Agent::new_with_config(
            ureq::Agent::config_builder()
                .timeout_global(Some(CH_TIMEOUT))
                .http_status_as_error(false)
                .build(),
        );
        Self {
            state_table: format!("{trace_table}_state"),
            event_table: format!("{trace_table}_events"),
            blob_table: format!("{trace_table}_blobs"),
            trace_table,
            config,
            agent,
        }
    }

    fn authed_builder(&self, url: &str, content_type: &str) -> ureq::http::request::Builder {
        let mut builder = ureq::http::Request::builder()
            .method("POST")
            .uri(url)
            .header("Content-Type", content_type);
        if let Some(user) = &self.config.clickhouse_user {
            builder = builder.header("X-ClickHouse-User", user);
        }
        if let Some(password) = &self.config.clickhouse_password {
            builder = builder.header("X-ClickHouse-Key", password);
        }
        builder
    }

    fn query(&self, body: &str) -> Result<String, String> {
        let url = format!(
            "{}/?database={}",
            self.config.clickhouse_url, self.config.clickhouse_database
        );
        let req = self
            .authed_builder(&url, "text/plain")
            .body(body.to_string())
            .map_err(|e| e.to_string())?;
        let mut resp = self.agent.run(req).map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let mut buf = Vec::new();
        resp.body_mut()
            .as_reader()
            .read_to_end(&mut buf)
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&buf).to_string();
        if status >= 400 {
            return Err(format!("clickhouse {status}: {text}"));
        }
        Ok(text)
    }

    fn request(&self, body: &str) -> Result<(), String> {
        self.query(body).map(|_| ())
    }

    fn ensure_tables(&self) -> Result<(), String> {
        let t = &self.trace_table;
        let ts = &self.state_table;
        let te = &self.event_table;
        let tb = &self.blob_table;
        self.request(&format!(
            "CREATE TABLE IF NOT EXISTS {t} (                id String,                parent_id Nullable(String),                chat_id Nullable(String),                run_id Nullable(String),                kind LowCardinality(String),                name String,                depth Int32,                seq Int64,                started_ns Int64,                input_hash Nullable(String),                invoked_from_step_id Nullable(String),                started_at DateTime64(9, 'UTC') MATERIALIZED fromUnixTimestamp64Nano(started_ns, 'UTC'),                is_root UInt8 MATERIALIZED if(isNull(parent_id), 1, 0),                chat_key String MATERIALIZED ifNull(chat_id, ''),                run_key String MATERIALIZED ifNull(run_id, ''),                parent_key String MATERIALIZED ifNull(parent_id, ''),                INDEX idx_id id TYPE bloom_filter(0.01) GRANULARITY 4,                INDEX idx_parent parent_key TYPE bloom_filter(0.01) GRANULARITY 4,                INDEX idx_run run_key TYPE bloom_filter(0.01) GRANULARITY 4,                INDEX idx_kind kind TYPE set(64) GRANULARITY 4,                INDEX idx_roots is_root TYPE set(2) GRANULARITY 4            ) ENGINE = MergeTree()            PARTITION BY toYYYYMM(started_at)            ORDER BY (chat_key, started_ns, id)            SETTINGS index_granularity = 8192"
        ))?;
        self.request(&format!(
            "CREATE TABLE IF NOT EXISTS {ts} (                id String,                status LowCardinality(String),                ended_ns Nullable(Int64),                output_hash Nullable(String),                error_hash Nullable(String),                data_json Nullable(String),                data_hash Nullable(String),                _version UInt64,                ended_at Nullable(DateTime64(9, 'UTC')) MATERIALIZED if(isNull(ended_ns), NULL, fromUnixTimestamp64Nano(assumeNotNull(ended_ns), 'UTC')),                has_error UInt8 MATERIALIZED if(status = 'error' OR isNotNull(error_hash), 1, 0),                INDEX idx_status status TYPE set(16) GRANULARITY 4,                INDEX idx_errors has_error TYPE set(2) GRANULARITY 4            ) ENGINE = ReplacingMergeTree(_version)            ORDER BY id            SETTINGS index_granularity = 8192"
        ))?;
        self.request(&format!(
            "CREATE TABLE IF NOT EXISTS {te} (                id UInt64,                span_id String,                ts_ns Int64,                level LowCardinality(String),                message String,                data_hash Nullable(String),                ts DateTime64(9, 'UTC') MATERIALIZED fromUnixTimestamp64Nano(ts_ns, 'UTC'),                INDEX idx_level level TYPE set(16) GRANULARITY 4            ) ENGINE = MergeTree()            PARTITION BY toYYYYMM(ts)            ORDER BY (span_id, ts_ns, id)            SETTINGS index_granularity = 8192"
        ))?;
        self.request(&format!(
            "CREATE TABLE IF NOT EXISTS {tb} (                hash String,                kind LowCardinality(String),                encoding LowCardinality(String),                uncompressed_bytes UInt64,                data String,                created_at Int64,                created_at_dt DateTime64(3, 'UTC') MATERIALIZED fromUnixTimestamp64Milli(created_at, 'UTC')            ) ENGINE = ReplacingMergeTree()            PARTITION BY toYYYYMM(created_at_dt)            ORDER BY hash            SETTINGS index_granularity = 8192"
        ))?;
        Ok(())
    }

    fn insert_json_batch(&self, table: &str, rows: &[serde_json::Value]) -> Result<(), String> {
        if rows.is_empty() {
            return Ok(());
        }
        let query = format!("INSERT INTO {table} FORMAT JSONEachRow");
        let url = format!(
            "{}/?database={}&query={}",
            self.config.clickhouse_url,
            self.config.clickhouse_database,
            ch_encode_query(&query)
        );
        let mut body = String::new();
        for row in rows {
            body.push_str(&serde_json::to_string(row).map_err(|e| e.to_string())?);
            body.push('\n');
        }
        let req = self
            .authed_builder(&url, "application/json")
            .body(body)
            .map_err(|e| e.to_string())?;
        let mut resp = self.agent.run(req).map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        if status >= 400 {
            let mut buf = Vec::new();
            let _ = resp.body_mut().as_reader().read_to_end(&mut buf);
            return Err(format!(
                "clickhouse insert into {table} ({} row{}) {status}: {}",
                rows.len(),
                if rows.len() == 1 { "" } else { "s" },
                String::from_utf8_lossy(&buf)
            ));
        }
        Ok(())
    }

    fn select_json_each_row(&self, sql: &str) -> Result<Vec<Value>, String> {
        let sql = format!("{} FORMAT JSONEachRow", sql.trim_end_matches(';'));
        let output = self.query(&sql)?;
        output
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str::<Value>(line).map_err(|e| e.to_string()))
            .collect()
    }

    fn span_json(row: &TraceRow) -> serde_json::Value {
        serde_json::json!({
            "id": row.id, "parent_id": row.parent_id, "chat_id": row.chat_id, "run_id": row.run_id,
            "kind": row.kind, "name": row.name, "depth": row.depth, "seq": row.seq,
            "started_ns": row.started_ns, "input_hash": row.input_hash,
            "invoked_from_step_id": row.invoked_from_step_id,
        })
    }

    fn state_json(row: &TraceRow) -> serde_json::Value {
        let version = now_ms()
            .max(row.ended_ns.unwrap_or(row.started_ns) / 1_000_000)
            .max(row.started_ns / 1_000_000) as u64;
        serde_json::json!({
            "id": row.id, "status": row.status, "ended_ns": row.ended_ns,
            "output_hash": row.output_hash, "error_hash": row.error_hash,
            "data_json": row.data_json, "data_hash": row.data_hash, "_version": version,
        })
    }

    fn event_json(
        span_id: &str,
        id: i64,
        ts_ns: i64,
        level: &str,
        message: &str,
        data_hash: Option<&str>,
    ) -> serde_json::Value {
        serde_json::json!({ "id": id as u64, "span_id": span_id, "ts_ns": ts_ns, "level": level, "message": message, "data_hash": data_hash })
    }

    fn blob_json(
        hash: &str,
        kind: &str,
        encoding: &str,
        uncompressed_bytes: i64,
        bytes: &[u8],
        created_at: i64,
    ) -> serde_json::Value {
        serde_json::json!({ "hash": hash, "kind": kind, "encoding": encoding, "uncompressed_bytes": uncompressed_bytes, "data": BASE64.encode(bytes), "created_at": created_at })
    }

    fn select_trace_rows(&self, clause: &str, include_data: bool) -> Result<Vec<TraceRow>, String> {
        self.select_latest_trace_rows(clause, None, include_data)
    }

    fn select_latest_trace_rows(
        &self,
        clause: &str,
        having: Option<&str>,
        include_data: bool,
    ) -> Result<Vec<TraceRow>, String> {
        let columns = if include_data {
            TRACE_CH_SELECT_COLUMNS
        } else {
            TRACE_CH_LIST_COLUMNS
        };
        let sql = ch_latest_trace_rows_sql(
            &self.trace_table,
            &self.state_table,
            columns,
            clause,
            having,
        );
        let mut rows = self
            .select_json_each_row(&sql)?
            .iter()
            .map(ch_trace_row_from_json)
            .collect::<Result<Vec<_>, _>>()?;
        if include_data {
            hydrate_trace_rows_ch(self, &mut rows)?;
        }
        Ok(rows)
    }

    fn get_trace(&self, id: &str) -> Result<Option<TraceRow>, String> {
        let sql = ch_latest_trace_rows_sql(
            &self.trace_table,
            &self.state_table,
            TRACE_CH_SELECT_COLUMNS,
            &format!("WHERE id = {} LIMIT 1", ch_sql_string(id)),
            None,
        );
        let mut rows = self
            .select_json_each_row(&sql)?
            .iter()
            .map(ch_trace_row_from_json)
            .collect::<Result<Vec<_>, _>>()?;
        hydrate_trace_rows_ch(self, &mut rows)?;
        Ok(rows.pop())
    }

    fn children_for_parents(&self, parent_ids: &[String]) -> Result<Vec<TraceRow>, String> {
        let ids = parent_ids
            .iter()
            .map(|id| id.trim())
            .filter(|id| !id.is_empty())
            .map(ch_sql_string)
            .collect::<Vec<_>>();
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let ids = ids.join(", ");
        self.select_trace_rows(
            &format!("WHERE parent_id IN ({ids}) ORDER BY depth ASC, seq ASC"),
            false,
        )
    }

    fn children(
        &self,
        parent_id: Option<&str>,
        limit: Option<i64>,
    ) -> Result<Vec<TraceRow>, String> {
        let parent_id = parent_id.map(str::trim).filter(|id| !id.is_empty());
        let clause = match parent_id {
            Some(parent_id) => format!("WHERE parent_id = {}", ch_sql_string(parent_id)),
            None => "WHERE isNull(parent_id)".to_string(),
        };
        let limit_clause = limit
            .map(|limit| format!(" LIMIT {}", limit.clamp(1, 1000)))
            .unwrap_or_default();
        self.select_trace_rows(&format!("{clause} ORDER BY seq ASC{limit_clause}"), false)
    }

    fn events(
        &self,
        span_id: &str,
        limit: i64,
        before_ns: Option<i64>,
    ) -> Result<Vec<TraceEventRow>, String> {
        let limit = limit.clamp(1, 1000);
        let before = before_ns
            .map(|ns| format!(" AND ts_ns < {ns}"))
            .unwrap_or_default();
        let sql = format!(
            "SELECT id, span_id, ts_ns, level, message, data_hash FROM {} WHERE span_id = {}{before} ORDER BY ts_ns ASC, id ASC LIMIT {limit}",
            self.event_table,
            ch_sql_string(span_id),
        );
        self.select_json_each_row(&sql)?
            .iter()
            .map(ch_trace_event_from_json)
            .collect()
    }

    fn chat_roots(&self, limit: i64, before_ns: Option<i64>) -> Result<Vec<TraceRow>, String> {
        let limit = limit.clamp(1, 200);
        let before = before_ns
            .map(|ns| format!(" AND started_ns < {ns}"))
            .unwrap_or_default();
        self.select_trace_rows(
            &format!("WHERE isNull(parent_id) AND kind = 'chat'{before} ORDER BY started_ns DESC LIMIT {limit}"),
            false,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn roots(
        &self,
        limit: i64,
        before_ns: Option<i64>,
        query: Option<&str>,
        started_after_ns: Option<i64>,
        started_before_ns: Option<i64>,
        min_duration_ns: Option<i64>,
        max_duration_ns: Option<i64>,
        kind: Option<&str>,
        status: Option<&str>,
        scope: Option<&str>,
    ) -> Result<Vec<TraceRow>, String> {
        let limit = limit.clamp(1, 500);
        let mut clauses = vec!["isNull(parent_id)".to_string()];
        let mut having_clauses: Vec<String> = Vec::new();
        if let Some(before_ns) = before_ns {
            clauses.push(format!("started_ns < {before_ns}"));
        }
        if let Some(started_after_ns) = started_after_ns {
            clauses.push(format!("started_ns >= {started_after_ns}"));
        }
        if let Some(started_before_ns) = started_before_ns {
            clauses.push(format!("started_ns <= {started_before_ns}"));
        }
        let min_duration_ns = min_duration_ns.unwrap_or(0).max(0);
        let max_duration_ns = max_duration_ns.unwrap_or(i64::MAX);
        let now = now_ns();
        if min_duration_ns > 0 {
            having_clauses.push(format!(
                "(ifNull(ended_ns, {now}) - started_ns) >= {min_duration_ns}"
            ));
        }
        if max_duration_ns < i64::MAX {
            having_clauses.push(format!(
                "(ifNull(ended_ns, {now}) - started_ns) <= {max_duration_ns}"
            ));
        }
        let text = query.unwrap_or("").trim();
        if !text.is_empty() {
            clauses.push(ch_text_filter(&["name", "id", "ifNull(chat_id, '')"], text));
        }
        let kind = kind.unwrap_or("").trim();
        if !kind.is_empty() && kind != "any" {
            clauses.push(format!("kind = {}", ch_sql_string(kind)));
        }
        let status = status.unwrap_or("").trim();
        if !status.is_empty() && status != "any" {
            having_clauses.push(format!("status = {}", ch_sql_string(status)));
        }
        match scope.unwrap_or("").trim() {
            "" | "any" => {}
            "chat" => clauses.push("chat_id IS NOT NULL".to_string()),
            "global" => clauses.push("chat_id IS NULL".to_string()),
            other => return Err(format!("invalid trace root scope: {other}")),
        }
        self.select_latest_trace_rows(
            &format!(
                "WHERE {} ORDER BY started_ns DESC LIMIT {limit}",
                clauses.join(" AND ")
            ),
            Some(&having_clauses.join(" AND ")),
            true,
        )
    }

    fn search(&self, query: &TraceSearch, limit: i64, now: i64) -> Result<Vec<TraceRow>, String> {
        let mut clauses: Vec<String> = Vec::new();
        let mut having_clauses: Vec<String> = Vec::new();
        if let Some(before_ns) = query.before_ns {
            clauses.push(format!("started_ns < {before_ns}"));
        }
        let text = query.query.as_deref().unwrap_or("").trim();
        if !text.is_empty() {
            clauses.push(ch_text_filter(
                &["name", "id", "ifNull(chat_id, '')", "ifNull(run_id, '')"],
                text,
            ));
        }
        if let Some(kind) = query
            .kind
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            clauses.push(format!("kind = {}", ch_sql_string(kind)));
        }
        let status = if query.has_error {
            Some("error")
        } else {
            query
                .status
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
        };
        if let Some(status) = status {
            having_clauses.push(format!("status = {}", ch_sql_string(status)));
        }
        if let Some(chat_id) = query
            .chat_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            clauses.push(format!("chat_id = {}", ch_sql_string(chat_id)));
        }
        if let Some(run_id) = query
            .run_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            clauses.push(format!("run_id = {}", ch_sql_string(run_id)));
        }
        if query.roots_only {
            clauses.push("isNull(parent_id)".to_string());
        }
        match query.scope.as_deref().map(str::trim) {
            Some("global") => clauses.push("chat_id IS NULL".to_string()),
            Some("chat") => clauses.push("chat_id IS NOT NULL".to_string()),
            _ => {}
        }
        if let Some(started_after_ns) = query.started_after_ns {
            clauses.push(format!("started_ns >= {started_after_ns}"));
        }
        if let Some(started_before_ns) = query.started_before_ns {
            clauses.push(format!("started_ns <= {started_before_ns}"));
        }
        let min_duration_ns = query.min_duration_ns.unwrap_or(0).max(0);
        if min_duration_ns > 0 {
            having_clauses.push(format!(
                "(ifNull(ended_ns, {now}) - started_ns) >= {min_duration_ns}"
            ));
        }
        if let Some(max_duration_ns) = query.max_duration_ns.filter(|v| *v < i64::MAX) {
            having_clauses.push(format!(
                "(ifNull(ended_ns, {now}) - started_ns) <= {max_duration_ns}"
            ));
        }
        let where_clause = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        self.select_latest_trace_rows(
            &format!("{where_clause} ORDER BY started_ns DESC LIMIT {limit}"),
            Some(&having_clauses.join(" AND ")),
            false,
        )
    }

    fn chat_root_for(&self, chat_id: &str) -> Result<Option<TraceRow>, String> {
        let mut rows = self.select_trace_rows(
            &format!(
                "WHERE isNull(parent_id) AND kind = 'chat' AND chat_id = {} ORDER BY started_ns DESC LIMIT 1",
                ch_sql_string(chat_id),
            ),
            false,
        )?;
        Ok(rows.pop())
    }

    fn chat_tree(
        &self,
        chat_id: &str,
        max_depth: i32,
    ) -> Result<(Option<TraceRow>, Vec<TraceRow>), String> {
        let Some(root) = self.chat_root_for(chat_id)? else {
            return Ok((None, Vec::new()));
        };
        let max_depth = max_depth.max(0) as i64;
        let max_abs_depth = root.depth + max_depth;
        let nodes = self.select_trace_rows(
            &format!(
                "WHERE chat_id = {} AND depth >= {} AND depth <= {} ORDER BY depth ASC, seq ASC",
                ch_sql_string(chat_id),
                root.depth,
                max_abs_depth,
            ),
            false,
        )?;
        Ok((Some(root), nodes))
    }

    fn get_blob(&self, hash: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(self.get_blobs(&[hash.to_string()])?.remove(hash))
    }

    fn get_blobs(&self, hashes: &[String]) -> Result<HashMap<String, Vec<u8>>, String> {
        if hashes.is_empty() {
            return Ok(HashMap::new());
        }
        let ids = hashes
            .iter()
            .map(|hash| ch_sql_string(hash))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT hash, argMax(encoding, created_at) AS encoding, argMax(data, created_at) AS data FROM {} WHERE hash IN ({ids}) GROUP BY hash",
            self.blob_table,
        );
        let mut out = HashMap::new();
        for row in self.select_json_each_row(&sql)? {
            let hash = ch_string(&row, "hash")?;
            let encoding = ch_string(&row, "encoding")?;
            let data = ch_string(&row, "data")?;
            let bytes = BASE64.decode(data.as_bytes()).map_err(|e| e.to_string())?;
            let decoded = match encoding.as_str() {
                "br" => brotli_decompress(&bytes)?,
                "identity" => bytes,
                other => return Err(format!("unsupported trace blob encoding: {other}")),
            };
            out.insert(hash, decoded);
        }
        Ok(out)
    }
}

fn brotli_decompress(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    brotli::Decompressor::new(input, 4096)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

#[derive(Clone, Debug)]
enum TraceWrite {
    Span(Box<TraceRow>),
    State(Box<TraceRow>),
    Event {
        span_id: String,
        id: i64,
        ts_ns: i64,
        level: String,
        message: String,
        data_hash: Option<String>,
    },
    Blob {
        hash: String,
        kind: String,
        encoding: String,
        uncompressed_bytes: i64,
        bytes: Vec<u8>,
        created_at: i64,
    },
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
                    if let Err(error) = flush_trace_writes(&batch) {
                        report_trace_write_error(error, batch.len());
                    }
                    batch.clear();
                }
            })
            .expect("spawn trace writer");
        Self { tx }
    }
    fn enqueue(&self, write: TraceWrite) -> Result<(), String> {
        self.tx.send(write).map_err(|e| e.to_string())
    }
}

fn report_trace_write_error(message: String, rows: usize) {
    broadcast::publish(serde_json::json!({ "kind": "trace-write-error", "message": message, "rows": rows, "at": now_ms() }).to_string());
}

fn flush_trace_writes(writes: &[TraceWrite]) -> Result<(), String> {
    let Some(client) = current_trace_client() else {
        return Ok(());
    };
    let mut spans = Vec::new();
    let mut states = Vec::new();
    let mut events = Vec::new();
    let mut blobs = Vec::new();
    for write in writes {
        match write {
            TraceWrite::Span(row) => spans.push(ClickHouseTraceClient::span_json(row)),
            TraceWrite::State(row) => states.push(ClickHouseTraceClient::state_json(row)),
            TraceWrite::Event {
                span_id,
                id,
                ts_ns,
                level,
                message,
                data_hash,
            } => events.push(ClickHouseTraceClient::event_json(
                span_id,
                *id,
                *ts_ns,
                level,
                message,
                data_hash.as_deref(),
            )),
            TraceWrite::Blob {
                hash,
                kind,
                encoding,
                uncompressed_bytes,
                bytes,
                created_at,
            } => blobs.push(ClickHouseTraceClient::blob_json(
                hash,
                kind,
                encoding,
                *uncompressed_bytes,
                bytes,
                *created_at,
            )),
        }
    }
    client.insert_json_batch(&client.blob_table, &blobs)?;
    client.insert_json_batch(&client.trace_table, &spans)?;
    client.insert_json_batch(&client.state_table, &states)?;
    client.insert_json_batch(&client.event_table, &events)?;
    Ok(())
}

fn enqueue_trace_write(write: TraceWrite) -> Result<(), String> {
    if let TraceWrite::Span(row) | TraceWrite::State(row) = &write
        && let Ok(mut shadow) = TRACE_SHADOW_ROWS.lock()
    {
        shadow.insert(row.id.clone(), (**row).clone());
    }
    TRACE_WRITE_QUEUE.enqueue(write)
}

fn trace_shadow_get(id: &str) -> Option<TraceRow> {
    TRACE_SHADOW_ROWS
        .lock()
        .ok()
        .and_then(|shadow| shadow.get(id).cloned())
}

fn trace_shadow_children(parent_id: Option<&str>, limit: Option<i64>) -> Vec<TraceRow> {
    let Ok(shadow) = TRACE_SHADOW_ROWS.lock() else {
        return vec![];
    };
    let mut rows: Vec<TraceRow> = shadow
        .values()
        .filter(|row| row.parent_id.as_deref() == parent_id)
        .cloned()
        .collect();
    rows.sort_by_key(|row| (row.depth, row.seq));
    if let Some(limit) = limit {
        rows.truncate(limit.max(0) as usize);
    }
    rows
}

fn ch_encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push(char::from(b"0123456789ABCDEF"[(b >> 4) as usize]));
                out.push(char::from(b"0123456789ABCDEF"[(b & 0xf) as usize]));
            }
        }
    }
    out
}

const TRACE_CH_SELECT_COLUMNS: &str = "id, parent_id, chat_id, run_id, kind, name, depth, seq, ifNull(status, 'running') AS status, started_ns, ended_ns, input_hash, output_hash, error_hash, invoked_from_step_id, data_json, data_hash";
const TRACE_CH_LIST_COLUMNS: &str = "id, parent_id, chat_id, run_id, kind, name, depth, seq, ifNull(status, 'running') AS status, started_ns, ended_ns, input_hash, output_hash, error_hash, invoked_from_step_id, NULL AS data_json, data_hash";

fn ch_sql_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        if ch == '\'' || ch == '\\' {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('\'');
    out
}

fn ch_like_pattern(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('%');
    for ch in value.to_ascii_lowercase().chars() {
        if matches!(ch, '%' | '_' | '\\' | '\'') {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('%');
    out
}

fn ch_text_filter(exprs: &[&str], value: &str) -> String {
    let pattern = ch_sql_string(&ch_like_pattern(value));
    exprs
        .iter()
        .map(|expr| format!("lowerUTF8({expr}) LIKE {pattern}"))
        .collect::<Vec<_>>()
        .join(" OR ")
        .pipe(|inner| format!("({inner})"))
}

fn ch_split_order_limit(clause: &str) -> (&str, &str) {
    if clause.starts_with("ORDER BY ") {
        ("", clause)
    } else if let Some(pos) = clause.find(" ORDER BY ") {
        (&clause[..pos], &clause[pos..])
    } else {
        (clause, "")
    }
}

fn ch_latest_trace_rows_sql(
    table: &str,
    state_table: &str,
    columns: &str,
    clause: &str,
    having: Option<&str>,
) -> String {
    let (where_clause, order_limit) = ch_split_order_limit(clause.trim());
    let mut filters = Vec::new();
    let where_clause = where_clause.trim();
    if let Some(rest) = where_clause.strip_prefix("WHERE ") {
        let rest = rest.trim();
        if !rest.is_empty() {
            filters.push(rest.to_string());
        }
    } else if !where_clause.is_empty() {
        filters.push(where_clause.to_string());
    }
    if let Some(having) = having.map(str::trim).filter(|s| !s.is_empty()) {
        filters.push(having.to_string());
    }
    let outer_where = if filters.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", filters.join(" AND "))
    };
    let order_limit = order_limit.trim();
    let order_limit = if order_limit.is_empty() {
        String::new()
    } else {
        format!(" {order_limit}")
    };
    format!(
        "SELECT {columns} FROM {table} AS s ANY LEFT JOIN (SELECT id, status, ended_ns, output_hash, error_hash, data_json, data_hash FROM {state_table} FINAL) AS st USING (id){outer_where}{order_limit}"
    )
}

trait Pipe: Sized {
    fn pipe<R>(self, f: impl FnOnce(Self) -> R) -> R {
        f(self)
    }
}
impl<T> Pipe for T {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latest_trace_rows_sql_filters_after_final() {
        let sql = ch_latest_trace_rows_sql(
            "moo_traces",
            "moo_traces_state",
            TRACE_CH_LIST_COLUMNS,
            "WHERE isNull(parent_id) ORDER BY started_ns DESC LIMIT 25",
            Some("status = 'error'"),
        );

        assert!(sql.contains("FROM moo_traces AS s ANY LEFT JOIN (SELECT id, status, ended_ns, output_hash, error_hash, data_json, data_hash FROM moo_traces_state FINAL) AS st USING (id) WHERE isNull(parent_id) AND status = 'error' ORDER BY started_ns DESC LIMIT 25"));
        assert!(!sql.contains("argMax"));
        assert!(!sql.contains("GROUP BY id"));
    }

    #[test]
    fn latest_trace_rows_sql_allows_empty_filters() {
        let sql = ch_latest_trace_rows_sql(
            "moo_traces",
            "moo_traces_state",
            TRACE_CH_SELECT_COLUMNS,
            "ORDER BY seq ASC LIMIT 10",
            None,
        );

        assert!(sql.contains(" FROM moo_traces AS s ANY LEFT JOIN (SELECT id, status, ended_ns, output_hash, error_hash, data_json, data_hash FROM moo_traces_state FINAL) AS st USING (id) ORDER BY seq ASC LIMIT 10"));
        assert!(!sql.contains(") WHERE  ORDER"));
    }

    #[test]
    fn inferred_step_attachment_root_is_not_step_kind() {
        let (kind, name) = infer_trace_root_kind_name("step:abc123");

        assert_eq!(kind, "chat");
        assert_eq!(name, "step:abc123");
    }

    #[test]
    fn trace_roots_sql_only_selects_null_parent_rows() {
        let sql = ch_latest_trace_rows_sql(
            "moo_traces",
            "moo_traces_state",
            TRACE_CH_LIST_COLUMNS,
            "WHERE isNull(parent_id) AND started_ns < 100 ORDER BY started_ns DESC LIMIT 25",
            None,
        );

        assert!(sql.contains(
            "WHERE isNull(parent_id) AND started_ns < 100 ORDER BY started_ns DESC LIMIT 25"
        ));
        assert!(!sql.contains("parent_id = ''"));
    }

    #[test]
    fn trace_children_sql_uses_declared_parent_only() {
        let sql = ch_latest_trace_rows_sql(
            "moo_traces",
            "moo_traces_state",
            TRACE_CH_LIST_COLUMNS,
            "WHERE parent_id = 'trace:parent' ORDER BY seq ASC LIMIT 25",
            None,
        );

        assert!(sql.contains("WHERE parent_id = 'trace:parent' ORDER BY seq ASC LIMIT 25"));
        assert!(!sql.contains("isNull(parent_id)"));
    }
}

fn ch_value<'a>(row: &'a Value, key: &str) -> Result<&'a Value, String> {
    row.get(key)
        .ok_or_else(|| format!("clickhouse row missing {key}"))
}

fn ch_string(row: &Value, key: &str) -> Result<String, String> {
    match ch_value(row, key)? {
        Value::String(s) => Ok(s.clone()),
        other => Err(format!("clickhouse {key} must be string, got {other}")),
    }
}

fn ch_opt_string(row: &Value, key: &str) -> Result<Option<String>, String> {
    match ch_value(row, key)? {
        Value::Null => Ok(None),
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        other => Err(format!(
            "clickhouse {key} must be nullable string, got {other}"
        )),
    }
}

fn ch_i64(row: &Value, key: &str) -> Result<i64, String> {
    match ch_value(row, key)? {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_u64().and_then(|v| i64::try_from(v).ok()))
            .ok_or_else(|| format!("clickhouse {key} is out of i64 range")),
        other => Err(format!("clickhouse {key} must be integer, got {other}")),
    }
}

fn ch_opt_i64(row: &Value, key: &str) -> Result<Option<i64>, String> {
    match ch_value(row, key)? {
        Value::Null => Ok(None),
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_u64().and_then(|v| i64::try_from(v).ok()))
            .map(Some)
            .ok_or_else(|| format!("clickhouse {key} is out of i64 range")),
        other => Err(format!(
            "clickhouse {key} must be nullable integer, got {other}"
        )),
    }
}

fn ch_trace_row_from_json(row: &Value) -> Result<TraceRow, String> {
    Ok(TraceRow {
        id: ch_string(row, "id")?,
        parent_id: ch_opt_string(row, "parent_id")?,
        chat_id: ch_opt_string(row, "chat_id")?,
        run_id: ch_opt_string(row, "run_id")?,
        kind: ch_string(row, "kind")?,
        name: ch_string(row, "name")?,
        depth: ch_i64(row, "depth")?,
        seq: ch_i64(row, "seq")?,
        status: ch_string(row, "status")?,
        started_ns: ch_i64(row, "started_ns")?,
        ended_ns: ch_opt_i64(row, "ended_ns")?,
        input_hash: ch_opt_string(row, "input_hash")?,
        output_hash: ch_opt_string(row, "output_hash")?,
        error_hash: ch_opt_string(row, "error_hash")?,
        invoked_from_step_id: ch_opt_string(row, "invoked_from_step_id")?,
        data_json: ch_opt_string(row, "data_json")?,
        data_hash: ch_opt_string(row, "data_hash")?,
    })
}

fn ch_trace_event_from_json(row: &Value) -> Result<TraceEventRow, String> {
    Ok(TraceEventRow {
        id: ch_i64(row, "id")?,
        span_id: ch_string(row, "span_id")?,
        ts_ns: ch_i64(row, "ts_ns")?,
        level: ch_string(row, "level")?,
        message: ch_string(row, "message")?,
        data_hash: ch_opt_string(row, "data_hash")?,
    })
}

fn hydrate_trace_row_ch(client: &ClickHouseTraceClient, row: &mut TraceRow) -> Result<(), String> {
    if row.data_json.is_none()
        && let Some(hash) = row.data_hash.as_deref()
        && let Some(bytes) = client.get_blob(hash)?
    {
        row.data_json = Some(String::from_utf8_lossy(&bytes).to_string());
    }
    Ok(())
}

fn hydrate_trace_rows_ch(
    client: &ClickHouseTraceClient,
    rows: &mut [TraceRow],
) -> Result<(), String> {
    let mut hashes = Vec::new();
    for row in rows.iter() {
        if row.data_json.is_none()
            && let Some(hash) = row.data_hash.as_deref()
            && !hashes.iter().any(|existing: &String| existing == hash)
        {
            hashes.push(hash.to_string());
        }
    }
    if hashes.is_empty() {
        return Ok(());
    }
    let blobs = client.get_blobs(&hashes)?;
    for row in rows {
        if row.data_json.is_none()
            && let Some(hash) = row.data_hash.as_deref()
            && let Some(bytes) = blobs.get(hash)
        {
            row.data_json = Some(String::from_utf8_lossy(bytes).to_string());
        }
    }
    Ok(())
}

fn current_trace_client() -> Option<ClickHouseTraceClient> {
    TRACE_BACKEND
        .lock()
        .ok()
        .and_then(|backend| backend.clone())
}

pub fn with_db<R>(f: impl FnOnce(&mut Connection) -> R) -> R {
    let mut guard = DB.lock().expect("db mutex poisoned");
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
    let mut guard = DB.lock().expect("db mutex poisoned");
    if guard.is_none() {
        *guard = Some(open_db(db_path)?);
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
    let config = settings::normalize_trace_config(config);
    if !config.enabled {
        *TRACE_BACKEND.lock().expect("trace backend mutex poisoned") = None;
        *TRACE_INITIALIZING
            .lock()
            .expect("trace initializing mutex poisoned") = None;
        return;
    }

    if current_trace_client()
        .as_ref()
        .map(|client| client.config == config)
        .unwrap_or(false)
    {
        return;
    }

    {
        let mut initializing = TRACE_INITIALIZING
            .lock()
            .expect("trace initializing mutex poisoned");
        if initializing
            .as_ref()
            .map(|pending| pending == &config)
            .unwrap_or(false)
        {
            return;
        }
        *initializing = Some(config.clone());
    }

    thread::spawn(move || {
        if let Err(err) = apply_trace_config(&config) {
            eprintln!("ClickHouse tracing disabled: failed to initialize trace tables: {err}");
        }
        let mut initializing = TRACE_INITIALIZING
            .lock()
            .expect("trace initializing mutex poisoned");
        if initializing
            .as_ref()
            .map(|pending| pending == &config)
            .unwrap_or(false)
        {
            *initializing = None;
        }
    });
}

pub fn test_trace_config(config: &settings::TraceConfig) -> Result<(), String> {
    let config = settings::normalize_trace_config(config.clone());
    if !config.enabled {
        return Ok(());
    }
    ClickHouseTraceClient::new(config).ensure_tables()
}

pub fn apply_trace_config(config: &settings::TraceConfig) -> Result<(), String> {
    let config = settings::normalize_trace_config(config.clone());
    if !config.enabled {
        *TRACE_BACKEND.lock().expect("trace backend mutex poisoned") = None;
        *TRACE_INITIALIZING
            .lock()
            .expect("trace initializing mutex poisoned") = None;
        return Ok(());
    }
    let client = ClickHouseTraceClient::new(config);
    client.ensure_tables()?;
    *TRACE_BACKEND.lock().expect("trace backend mutex poisoned") = Some(client);
    Ok(())
}

pub fn tracing_enabled() -> bool {
    current_trace_client().is_some()
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
    if let Ok(value) = env::var("MOO_CLICKHOUSE_URL") {
        config.clickhouse_url = value;
    }
    if let Ok(value) = env::var("MOO_CLICKHOUSE_DATABASE") {
        config.clickhouse_database = value;
    }
    if let Ok(value) = env::var("MOO_CLICKHOUSE_TABLE_PREFIX") {
        config.clickhouse_table_prefix = value;
    }
    if let Ok(value) = env::var("MOO_CLICKHOUSE_USER") {
        config.clickhouse_user = Some(value);
    }
    if let Ok(value) = env::var("MOO_CLICKHOUSE_PASSWORD") {
        config.clickhouse_password = Some(value);
    }
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
    *DB.lock().expect("db mutex poisoned") = Some(open_db(db_path)?);
    if let Ok(mut shadow) = TRACE_SHADOW_ROWS.lock() {
        shadow.clear();
    }
    NEXT_TRACE_SEQ.store(1, Ordering::Relaxed);
    NEXT_TRACE_EVENT_ID.store(1, Ordering::Relaxed);
    *TRACE_BACKEND.lock().expect("trace backend mutex poisoned") = None;
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
    let _init_guard = DB_INIT_LOCK.lock().map_err(|e| e.to_string())?;
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
        return ("chat", id.to_string());
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

#[derive(Debug, Clone)]
pub struct TraceEventRow {
    pub id: i64,
    pub span_id: String,
    pub ts_ns: i64,
    pub level: String,
    pub message: String,
    pub data_hash: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct TraceSearch {
    pub query: Option<String>,
    pub kind: Option<String>,
    pub status: Option<String>,
    pub chat_id: Option<String>,
    pub run_id: Option<String>,
    pub scope: Option<String>,
    pub has_error: bool,
    pub limit: i64,
    pub before_ns: Option<i64>,
    pub started_after_ns: Option<i64>,
    pub started_before_ns: Option<i64>,
    pub min_duration_ns: Option<i64>,
    pub max_duration_ns: Option<i64>,
    pub roots_only: bool,
}

pub struct TraceRootParams<'a> {
    pub id: &'a str,
    pub chat_id: Option<&'a str>,
    pub run_id: Option<&'a str>,
    pub kind: &'a str,
    pub name: &'a str,
    pub started_ns: i64,
    pub input_hash: Option<&'a str>,
    pub data_json: Option<&'a str>,
}

fn trace_put_blob_queued(kind: &str, bytes: &[u8]) -> Result<String, String> {
    let hash = sha256_object_hash(kind, bytes);
    // Do not Brotli-compress trace blobs at runtime. Brotli is reserved for
    // serving assets that were already compressed at build time; trace blobs use
    // identity encoding so tracing cannot become a CPU-heavy compressor.
    enqueue_trace_write(TraceWrite::Blob {
        hash: hash.clone(),
        kind: kind.to_string(),
        encoding: "identity".to_string(),
        uncompressed_bytes: bytes.len() as i64,
        bytes: bytes.to_vec(),
        created_at: now_ms(),
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
    let TraceRootParams {
        id,
        chat_id,
        run_id,
        kind,
        name,
        started_ns,
        input_hash,
        data_json,
    } = params;
    if trace_get(id)?.is_some() {
        return Ok(());
    }
    let seq = NEXT_TRACE_SEQ.fetch_add(1, Ordering::Relaxed) as i64;
    let prepared = prepare_trace_data_queued(data_json)?;
    let row = TraceRow {
        id: id.to_string(),
        parent_id: None,
        chat_id: chat_id.map(ToString::to_string),
        run_id: run_id.map(ToString::to_string),
        kind: kind.to_string(),
        name: name.to_string(),
        depth: 0,
        seq,
        status: "ok".to_string(),
        started_ns,
        ended_ns: Some(started_ns),
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
    let parent = match parent_id {
        Some(parent_id) => match trace_get(parent_id)? {
            Some(row) => Some((row.depth, row.chat_id, row.run_id)),
            None => {
                let (kind, name) = infer_trace_root_kind_name(parent_id);
                trace_ensure_root(TraceRootParams {
                    id: parent_id,
                    chat_id,
                    run_id,
                    kind,
                    name: &name,
                    started_ns,
                    input_hash: None,
                    data_json: Some(r#"{"backfilled":"missing live trace parent"}"#),
                })?;
                trace_get(parent_id)?.map(|row| (row.depth, row.chat_id, row.run_id))
            }
        },
        None => None,
    };
    let seq = NEXT_TRACE_SEQ.fetch_add(1, Ordering::Relaxed) as i64;
    let prepared = prepare_trace_data_queued(data_json)?;
    let (depth, inherited_chat_id, inherited_run_id) = parent.unwrap_or((0, None, None));
    let row = TraceRow {
        id: id.to_string(),
        parent_id: parent_id.map(ToString::to_string),
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
    let Some(mut row) = trace_shadow_get(id) else {
        return Ok(false);
    };
    let prepared = prepare_trace_data_queued(data_json)?;
    row.data_json = prepared.inline_json;
    row.data_hash = prepared.hash;
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
    let Some(mut row) = trace_shadow_get(id) else {
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

pub fn trace_event(
    span_id: &str,
    ts_ns: i64,
    level: &str,
    message: &str,
    data_hash: Option<&str>,
) -> Result<i64, String> {
    if current_trace_client().is_none() {
        return Ok(0);
    }
    let id = NEXT_TRACE_EVENT_ID.fetch_add(1, Ordering::Relaxed) as i64;
    enqueue_trace_write(TraceWrite::Event {
        span_id: span_id.to_string(),
        id,
        ts_ns,
        level: level.to_string(),
        message: message.to_string(),
        data_hash: data_hash.map(ToString::to_string),
    })?;
    Ok(id)
}

pub fn trace_get(id: &str) -> Result<Option<TraceRow>, String> {
    let Some(client) = current_trace_client() else {
        return Ok(trace_shadow_get(id));
    };
    if let Some(mut row) = trace_shadow_get(id) {
        let _ = hydrate_trace_row_ch(&client, &mut row);
        return Ok(Some(row));
    }
    client.get_trace(id)
}

pub fn trace_children(
    parent_id: Option<&str>,
    limit: Option<i64>,
) -> Result<Vec<TraceRow>, String> {
    let Some(client) = current_trace_client() else {
        return Ok(trace_shadow_children(parent_id, limit));
    };
    client.children(parent_id, limit)
}

pub fn trace_ancestors(id: &str) -> Result<Vec<TraceRow>, String> {
    let Some(client) = current_trace_client() else {
        return Ok(vec![]);
    };
    let mut rows = Vec::new();
    let mut current = client.get_trace(id)?;
    while let Some(row) = current {
        let parent_id = row.parent_id.clone();
        rows.push(row);
        current = match parent_id {
            Some(parent_id) => client.get_trace(&parent_id)?,
            None => None,
        };
    }
    rows.sort_by_key(|row| (row.depth, row.seq));
    Ok(rows)
}

pub fn trace_subtree(id: &str, max_depth: i32) -> Result<Vec<TraceRow>, String> {
    let Some(client) = current_trace_client() else {
        return Ok(vec![]);
    };
    let max_depth = max_depth.max(0) as usize;
    let Some(root) = client.get_trace(id)? else {
        return Ok(vec![]);
    };
    let mut rows = vec![root];
    let mut frontier = vec![id.to_string()];
    for _ in 0..max_depth {
        let mut next = Vec::new();
        let children = client.children_for_parents(&frontier)?;
        next.extend(children.iter().map(|row| row.id.clone()));
        rows.extend(children);
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    rows.sort_by_key(|row| (row.depth, row.seq));
    Ok(rows)
}

pub fn trace_events(
    span_id: &str,
    limit: i64,
    before_ns: Option<i64>,
) -> Result<Vec<TraceEventRow>, String> {
    let Some(client) = current_trace_client() else {
        return Ok(vec![]);
    };
    client.events(span_id, limit, before_ns)
}

pub fn trace_chat_roots(limit: i64, before_ns: Option<i64>) -> Result<Vec<TraceRow>, String> {
    let Some(client) = current_trace_client() else {
        return Ok(vec![]);
    };
    client.chat_roots(limit, before_ns)
}

pub fn trace_chat_tree(
    chat_id: &str,
    max_depth: i32,
) -> Result<(Option<TraceRow>, Vec<TraceRow>), String> {
    let Some(client) = current_trace_client() else {
        return Ok((None, vec![]));
    };
    client.chat_tree(chat_id, max_depth)
}

pub fn trace_roots(mut query: TraceSearch) -> Result<Vec<TraceRow>, String> {
    query.roots_only = true;
    trace_search(query)
}

pub fn trace_failed(
    limit: i64,
    chat_id: Option<&str>,
    before_ns: Option<i64>,
    started_after_ns: Option<i64>,
    started_before_ns: Option<i64>,
    min_duration_ns: Option<i64>,
    max_duration_ns: Option<i64>,
) -> Result<Vec<TraceRow>, String> {
    let mut query = TraceSearch::default();
    query.limit = limit;
    query.chat_id = chat_id.map(ToString::to_string);
    query.has_error = true;
    query.before_ns = before_ns;
    query.started_after_ns = started_after_ns;
    query.started_before_ns = started_before_ns;
    query.min_duration_ns = min_duration_ns;
    query.max_duration_ns = max_duration_ns;
    trace_search(query)
}

pub fn trace_search(query: TraceSearch) -> Result<Vec<TraceRow>, String> {
    let Some(client) = current_trace_client() else {
        return Ok(vec![]);
    };
    let limit = query.limit.clamp(1, 500);
    client.search(&query, limit, now_ns())
}
