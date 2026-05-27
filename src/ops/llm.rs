// Generic LLM streaming transport. Rust owns the long-running HTTP/SSE
// request so no V8 worker is held while bytes are flowing. Provider-specific
// SSE accumulation, tool-call assembly, usage normalization, and progress
// event shaping live in the TypeScript harness via short accumulator calls.

use crate::broadcast;
use crate::pool::Pool;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use reqwest::header::HeaderMap;
use serde_json::{Map, Value, json};
use tokio::net::TcpStream;
use tokio::sync::Mutex as AsyncMutex;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_tls_with_config};

// Codex defaults: 15s to upgrade, 5min between server frames. We additionally
// recycle idle connections after a few minutes so a long-quiet chat doesn't
// hand the next user a half-dead socket the server already gave up on.
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const WS_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const WS_REUSE_MAX_AGE: Duration = Duration::from_secs(45 * 60);
const WS_REUSE_MAX_IDLE: Duration = Duration::from_secs(4 * 60);

/// rustls can't auto-select a crypto provider when both `ring` and `aws-lc-rs`
/// are in the dependency graph (reqwest pulls one, our WS path the other), so
/// install one explicitly the first time we open a WebSocket. Without this,
/// `connect_async_tls_with_config` panics deep inside rustls and the OAuth
/// streaming chat hangs with no visible error.
fn ensure_rustls_crypto_provider() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

type WsSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct WsEntry {
    socket: WsSocket,
    upgrade_status: u16,
    response_headers: Value,
    opened_at: Instant,
    last_used: Instant,
}

type WsSlot = Arc<AsyncMutex<Option<WsEntry>>>;

#[derive(Default)]
struct WsPool {
    // Short critical sections (lookup / insert empty slot) — std Mutex is fine
    // and lets us hand out the per-slot async Mutex without holding the pool
    // lock across the network I/O.
    slots: std::sync::Mutex<HashMap<String, WsSlot>>,
}

impl WsPool {
    fn slot(&self, key: &str) -> WsSlot {
        let mut guard = self
            .slots
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(None)))
            .clone()
    }
}

fn ws_pool() -> &'static WsPool {
    static POOL: OnceLock<WsPool> = OnceLock::new();
    POOL.get_or_init(WsPool::default)
}

fn connection_identity(url: &str, headers: &Value, chat_id: &str) -> String {
    // Key the pool by (URL, auth principal, chat). Per-chat sockets keep
    // server-side `session-id` / `thread-id` stable for the lifetime of a
    // conversation and let concurrent chats stream in parallel — folding
    // every chat into one socket would serialize them and smear server-side
    // identity across unrelated conversations.
    let auth = headers
        .get("Authorization")
        .or_else(|| headers.get("authorization"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let account = headers
        .get("ChatGPT-Account-ID")
        .or_else(|| headers.get("chatgpt-account-id"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    hasher.update(b"\0");
    hasher.update(auth.as_bytes());
    hasher.update(b"\0");
    hasher.update(account.as_bytes());
    hasher.update(b"\0");
    hasher.update(chat_id.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(16);
    for b in &digest[..8] {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

fn chat_id_from_stream_events(stream_events: &Value) -> &str {
    stream_events
        .get("chatId")
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn random_uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::fill(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        bytes[6], bytes[7],
        bytes[8], bytes[9],
        bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    )
}

pub async fn stream_chat(
    pool: Arc<Pool>,
    bundle: Arc<String>,
    url: String,
    headers: Value,
    body: String,
    stream_events: Value,
) -> Value {
    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(e) => {
            return transport_error(
                &pool,
                &bundle,
                0,
                format!("client: {e}"),
                Value::Null,
                Value::Null,
            )
            .await;
        }
    };

    let request_started = Instant::now();
    let mut req = client
        .post(&url)
        .header("content-type", "application/json")
        .body(body);
    if let Some(map) = headers.as_object() {
        for (k, v) in map {
            if let Some(s) = v.as_str() {
                req = req.header(k, s);
            }
        }
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return transport_error(
                &pool,
                &bundle,
                0,
                format!("send: {e}"),
                Value::Null,
                Value::Null,
            )
            .await;
        }
    };
    let status = resp.status().as_u16();
    let response_headers = headers_json(resp.headers());
    if status >= 400 {
        let body_text = resp.text().await.unwrap_or_default();
        return transport_error(
            &pool,
            &bundle,
            status,
            body_text,
            Value::Null,
            response_headers,
        )
        .await;
    }

    let mut accumulator = match call_harness(
        &pool,
        &bundle,
        json!({ "command": "llm-stream-init", "streamEvents": stream_events }),
    )
    .await
    {
        Ok(v) => {
            publish_returned_events(&v);
            v.get("state").cloned().unwrap_or(Value::Null)
        }
        Err(e) => {
            return transport_error(
                &pool,
                &bundle,
                status,
                format!("llm init: {e}"),
                Value::Null,
                response_headers,
            )
            .await;
        }
    };

    let mut buffered: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    let mut network_chunks: u64 = 0;
    let mut network_bytes: u64 = 0;
    let mut sse_events: u64 = 0;
    let mut done_events: u64 = 0;
    let mut empty_data_events: u64 = 0;
    let mut non_data_lines: u64 = 0;
    let mut event_blocks: u64 = 0;
    let mut accumulator_calls: u64 = 0;
    let mut first_byte_ns: Option<u128> = None;
    let mut first_event_ns: Option<u128> = None;
    let mut first_accumulator_ns: Option<u128> = None;

    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                return transport_error(
                    &pool,
                    &bundle,
                    status,
                    format!("stream: {e}"),
                    accumulator.clone(),
                    response_headers,
                )
                .await;
            }
        };
        if first_byte_ns.is_none() {
            first_byte_ns = Some(request_started.elapsed().as_nanos());
        }
        network_chunks = network_chunks.saturating_add(1);
        network_bytes =
            network_bytes.saturating_add(u64::try_from(bytes.len()).unwrap_or(u64::MAX));
        buffered.extend_from_slice(&bytes);

        // SSE event boundary is a blank line. Only drain complete events so
        // partial UTF-8 remains buffered. Batch all complete data frames from
        // this network chunk into one short harness call to avoid waking V8 for
        // every tiny token delta.
        let mut events: Vec<String> = Vec::new();
        while let Some(idx) = find_double_newline(&buffered) {
            let event_bytes: Vec<u8> = buffered.drain(..idx + 2).collect();
            event_blocks = event_blocks.saturating_add(1);
            let event = String::from_utf8_lossy(&event_bytes);
            for line in event.split('\n') {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Some(data) = trimmed.strip_prefix("data:") else {
                    non_data_lines = non_data_lines.saturating_add(1);
                    continue;
                };
                let data = data.trim();
                if data.is_empty() {
                    empty_data_events = empty_data_events.saturating_add(1);
                    continue;
                }
                if data == "[DONE]" {
                    done_events = done_events.saturating_add(1);
                    continue;
                }
                if first_event_ns.is_none() {
                    first_event_ns = Some(request_started.elapsed().as_nanos());
                }
                events.push(data.to_string());
            }
        }
        sse_events = sse_events.saturating_add(u64::try_from(events.len()).unwrap_or(u64::MAX));
        if events.is_empty() {
            continue;
        }

        match call_harness(
            &pool,
            &bundle,
            json!({
                "command": "llm-stream-accumulate",
                "state": accumulator,
                "streamEvents": stream_events,
                "events": events,
            }),
        )
        .await
        {
            Ok(v) => {
                publish_returned_events(&v);
                if first_accumulator_ns.is_none() {
                    first_accumulator_ns = Some(request_started.elapsed().as_nanos());
                }
                accumulator_calls = accumulator_calls.saturating_add(1);
                accumulator = v.get("state").cloned().unwrap_or(Value::Null);
            }
            Err(e) => {
                return transport_error(
                    &pool,
                    &bundle,
                    status,
                    format!("llm accumulate: {e}"),
                    accumulator.clone(),
                    response_headers,
                )
                .await;
            }
        }
    }

    match call_harness(
        &pool,
        &bundle,
        json!({
            "command": "llm-stream-finalize",
            "state": accumulator,
            "status": status,
            "headers": response_headers.clone(),
        }),
    )
    .await
    {
        Ok(mut v) => {
            if let Some(obj) = v.as_object_mut() {
                obj.insert(
                    "streamStats".to_string(),
                    json!({
                        "networkChunks": network_chunks,
                        "networkBytes": network_bytes,
                        "sseEvents": sse_events,
                        "sseEventBlocks": event_blocks,
                        "sseDoneEvents": done_events,
                        "sseEmptyDataEvents": empty_data_events,
                        "sseNonDataLines": non_data_lines,
                        "accumulatorCalls": accumulator_calls,
                        "timeToFirstByteNs": first_byte_ns,
                        "timeToFirstEventNs": first_event_ns,
                        "timeToFirstAccumulatorNs": first_accumulator_ns,
                    }),
                );
            }
            v
        }
        Err(e) => {
            transport_error(
                &pool,
                &bundle,
                status,
                format!("llm finalize: {e}"),
                accumulator.clone(),
                response_headers,
            )
            .await
        }
    }
}

pub async fn stream_chat_websocket(
    pool: Arc<Pool>,
    bundle: Arc<String>,
    url: String,
    headers: Value,
    body: String,
    stream_events: Value,
) -> Value {
    ensure_rustls_crypto_provider();
    let request_started = Instant::now();
    let ws_url = websocket_url(&url);
    let chat_id = chat_id_from_stream_events(&stream_events);
    let identity = connection_identity(&ws_url, &headers, chat_id);
    let slot = ws_pool().slot(&identity);
    let mut guard = slot.lock().await;

    // Up to one retry: if the cached connection is stale and send/receive
    // fails on the very first frame, drop it and try with a fresh one. Beyond
    // that the harness retry layer takes over.
    let mut attempt = 0u8;
    loop {
        // Materialize a live entry. Discard any cached connection that has
        // exceeded the soft age/idle ceilings before we even try it.
        let needs_new = match guard.as_ref() {
            None => true,
            Some(entry) => {
                let now = Instant::now();
                now.duration_since(entry.opened_at) > WS_REUSE_MAX_AGE
                    || now.duration_since(entry.last_used) > WS_REUSE_MAX_IDLE
            }
        };
        if needs_new && guard.is_some() {
            drop(guard.take());
        }
        if guard.is_none() {
            match open_ws_entry(&ws_url, &headers).await {
                Ok(entry) => *guard = Some(entry),
                Err(transport) => return transport.into_value(&pool, &bundle).await,
            }
        }

        let outcome = run_one_stream(
            &pool,
            &bundle,
            guard.as_mut().expect("entry just installed"),
            &body,
            &stream_events,
            request_started,
            attempt == 0,
        )
        .await;

        match outcome {
            StreamOutcome::Completed(value) => {
                if let Some(entry) = guard.as_mut() {
                    entry.last_used = Instant::now();
                }
                return value;
            }
            StreamOutcome::ProviderError(value) => {
                // A clean `response.failed` / error event — connection is
                // still healthy, keep it cached.
                if let Some(entry) = guard.as_mut() {
                    entry.last_used = Instant::now();
                }
                return value;
            }
            StreamOutcome::Reconnect(transport) => {
                // Cached socket is unhealthy. Drop it and either retry once
                // (if we hadn't sent anything yet) or surface the transport
                // error to the retry layer.
                drop(guard.take());
                if transport.retry_with_fresh_connection && attempt == 0 {
                    attempt += 1;
                    continue;
                }
                return transport.into_value(&pool, &bundle).await;
            }
        }
    }
}

/// Outcome of a single `response.create` exchange on a (possibly reused) socket.
enum StreamOutcome {
    /// Server reached `response.completed` (or equivalent terminal status) —
    /// connection is healthy, value is the harness-finalized result.
    Completed(Value),
    /// Server sent a structured error event but the connection itself is
    /// still healthy and reusable.
    ProviderError(Value),
    /// Socket-level failure — caller should drop the cached entry.
    Reconnect(WsTransportError),
}

struct WsTransportError {
    status: u16,
    error_body: String,
    accumulator: Value,
    response_headers: Value,
    /// Whether the caller may retry with a fresh connection without
    /// disturbing user-visible state. True only when the failure happened
    /// before any provider bytes for this request reached the harness.
    retry_with_fresh_connection: bool,
}

impl WsTransportError {
    async fn into_value(self, pool: &Arc<Pool>, bundle: &Arc<String>) -> Value {
        transport_error(
            pool,
            bundle,
            self.status,
            self.error_body,
            self.accumulator,
            self.response_headers,
        )
        .await
    }
}

async fn open_ws_entry(
    ws_url: &str,
    headers: &Value,
) -> Result<WsEntry, WsTransportError> {
    let session_id = random_uuid_v4();
    let thread_id = random_uuid_v4();

    let mut request = ws_url.into_client_request().map_err(|e| WsTransportError {
        status: 0,
        error_body: format!("websocket request: {e}"),
        accumulator: Value::Null,
        response_headers: Value::Null,
        retry_with_fresh_connection: false,
    })?;
    let mut request_headers = request_headers_from_value(headers);
    // The harness-provided headers carry the static identity material
    // (Authorization, ChatGPT-Account-ID, OpenAI-Beta, User-Agent). Stamp the
    // codex routing headers in here so they stay stable for the lifetime of
    // this socket — sticky routing on the codex backend depends on it.
    request.headers_mut().extend(request_headers.drain());
    insert_static_header(request.headers_mut(), "session-id", &session_id);
    insert_static_header(request.headers_mut(), "thread-id", &thread_id);
    insert_static_header(request.headers_mut(), "x-client-request-id", &thread_id);

    let connect_future = connect_async_tls_with_config(request, None, false, None);
    let response = tokio::time::timeout(WS_CONNECT_TIMEOUT, connect_future)
        .await
        .map_err(|_| WsTransportError {
            status: 0,
            error_body: format!(
                "websocket connect timed out after {}s",
                WS_CONNECT_TIMEOUT.as_secs()
            ),
            accumulator: Value::Null,
            response_headers: Value::Null,
            retry_with_fresh_connection: false,
        })?;
    let (socket, response) = response.map_err(|e| {
        let (status, error_body, response_headers) = websocket_connect_error(e);
        WsTransportError {
            status,
            error_body,
            accumulator: Value::Null,
            response_headers,
            retry_with_fresh_connection: false,
        }
    })?;

    let upgrade_status = response.status().as_u16();
    let response_headers = ws_headers_json(response.headers());
    if upgrade_status >= 400 {
        return Err(WsTransportError {
            status: upgrade_status,
            error_body: format!("websocket upgrade failed with status {upgrade_status}"),
            accumulator: Value::Null,
            response_headers,
            retry_with_fresh_connection: false,
        });
    }

    let now = Instant::now();
    Ok(WsEntry {
        socket,
        upgrade_status,
        response_headers,
        opened_at: now,
        last_used: now,
    })
}

fn insert_static_header(headers: &mut http::HeaderMap, name: &str, value: &str) {
    if let (Ok(name), Ok(value)) = (
        http::HeaderName::from_bytes(name.as_bytes()),
        http::HeaderValue::from_str(value),
    ) {
        headers.insert(name, value);
    }
}

async fn run_one_stream(
    pool: &Arc<Pool>,
    bundle: &Arc<String>,
    entry: &mut WsEntry,
    body: &str,
    stream_events: &Value,
    request_started: Instant,
    fresh_connection: bool,
) -> StreamOutcome {
    // The websocket handshake is a 101 Switching Protocols response; downstream
    // LLM result/retry logic expects model streams to look like a successful
    // request, so we surface 200 here and bubble provider errors through the
    // accumulator instead.
    let status = 200;
    let response_headers = entry.response_headers.clone();
    let upgrade_status = entry.upgrade_status;

    let mut accumulator =
        match init_stream_accumulator(pool, bundle, stream_events, status, &response_headers).await
        {
            Ok(state) => state,
            Err(value) => {
                // Init failure isn't a socket problem — keep the connection.
                return StreamOutcome::ProviderError(value);
            }
        };

    let mut network_chunks: u64 = 0;
    let mut network_bytes: u64 = 0;
    let mut websocket_events: u64 = 0;
    let mut websocket_text_events: u64 = 0;
    let mut websocket_binary_events: u64 = 0;
    let mut websocket_ping_events: u64 = 0;
    let mut websocket_pong_events: u64 = 0;
    let mut websocket_close_events: u64 = 0;
    let mut accumulator_calls: u64 = 0;
    let mut first_byte_ns: Option<u128> = None;
    let mut first_event_ns: Option<u128> = None;
    let mut first_accumulator_ns: Option<u128> = None;
    let mut terminal_seen = false;
    let mut bytes_seen_for_request = false;

    if let Err(e) = entry
        .socket
        .send(Message::Text(body.to_string().into()))
        .await
    {
        return StreamOutcome::Reconnect(WsTransportError {
            status,
            error_body: format!("websocket send: {e}"),
            accumulator,
            response_headers,
            retry_with_fresh_connection: !fresh_connection,
        });
    }

    loop {
        let message = match tokio::time::timeout(WS_IDLE_TIMEOUT, entry.socket.next()).await {
            Ok(Some(Ok(msg))) => msg,
            Ok(Some(Err(e))) => {
                return StreamOutcome::Reconnect(WsTransportError {
                    status,
                    error_body: format!("websocket stream: {e}"),
                    accumulator,
                    response_headers,
                    retry_with_fresh_connection: !fresh_connection && !bytes_seen_for_request,
                });
            }
            Ok(None) => break,
            Err(_) => {
                return StreamOutcome::Reconnect(WsTransportError {
                    status,
                    error_body: format!(
                        "websocket idle timeout after {}s",
                        WS_IDLE_TIMEOUT.as_secs()
                    ),
                    accumulator,
                    response_headers,
                    retry_with_fresh_connection: false,
                });
            }
        };
        if first_byte_ns.is_none() {
            first_byte_ns = Some(request_started.elapsed().as_nanos());
        }
        network_chunks = network_chunks.saturating_add(1);
        websocket_events = websocket_events.saturating_add(1);
        match message {
            Message::Text(text) => {
                let text = text.as_str().to_string();
                network_bytes =
                    network_bytes.saturating_add(u64::try_from(text.len()).unwrap_or(u64::MAX));
                websocket_text_events = websocket_text_events.saturating_add(1);
                bytes_seen_for_request = true;
                if first_event_ns.is_none() {
                    first_event_ns = Some(request_started.elapsed().as_nanos());
                }
                let event = match serde_json::from_str::<Value>(&text) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
                let is_error = event_type == "error" || event.get("error").is_some();
                let should_accumulate = should_accumulate_websocket_event(event_type, &event);
                let is_terminal = websocket_terminal_event(event_type, &event);

                if should_accumulate {
                    match accumulate_websocket_text_event(
                        pool,
                        bundle,
                        accumulator,
                        stream_events,
                        text.clone(),
                        request_started,
                    )
                    .await
                    {
                        Ok((state, first_call)) => {
                            accumulator_calls = accumulator_calls.saturating_add(1);
                            if first_accumulator_ns.is_none() {
                                first_accumulator_ns = Some(first_call);
                            }
                            accumulator = state;
                        }
                        Err(e) => {
                            return StreamOutcome::ProviderError(
                                transport_error(
                                    pool,
                                    bundle,
                                    status,
                                    format!("llm accumulate: {e}"),
                                    Value::Null,
                                    response_headers,
                                )
                                .await,
                            );
                        }
                    }
                }

                if is_error || is_terminal {
                    terminal_seen = true;
                    break;
                }
            }
            Message::Binary(bytes) => {
                network_bytes =
                    network_bytes.saturating_add(u64::try_from(bytes.len()).unwrap_or(u64::MAX));
                websocket_binary_events = websocket_binary_events.saturating_add(1);
                bytes_seen_for_request = true;
                if first_event_ns.is_none() {
                    first_event_ns = Some(request_started.elapsed().as_nanos());
                }
                let Ok(text) = String::from_utf8(bytes.to_vec()) else {
                    continue;
                };
                let event = match serde_json::from_str::<Value>(&text) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
                let is_error = event_type == "error" || event.get("error").is_some();
                let should_accumulate = should_accumulate_websocket_event(event_type, &event);
                let is_terminal = websocket_terminal_event(event_type, &event);

                if should_accumulate {
                    match accumulate_websocket_text_event(
                        pool,
                        bundle,
                        accumulator,
                        stream_events,
                        text.clone(),
                        request_started,
                    )
                    .await
                    {
                        Ok((state, first_call)) => {
                            accumulator_calls = accumulator_calls.saturating_add(1);
                            if first_accumulator_ns.is_none() {
                                first_accumulator_ns = Some(first_call);
                            }
                            accumulator = state;
                        }
                        Err(e) => {
                            return StreamOutcome::ProviderError(
                                transport_error(
                                    pool,
                                    bundle,
                                    status,
                                    format!("llm accumulate: {e}"),
                                    Value::Null,
                                    response_headers,
                                )
                                .await,
                            );
                        }
                    }
                }

                if is_error {
                    return StreamOutcome::ProviderError(
                        transport_error(
                            pool,
                            bundle,
                            status,
                            text,
                            accumulator,
                            response_headers,
                        )
                        .await,
                    );
                }
                if is_terminal {
                    terminal_seen = true;
                    break;
                }
            }
            Message::Ping(payload) => {
                network_bytes =
                    network_bytes.saturating_add(u64::try_from(payload.len()).unwrap_or(u64::MAX));
                websocket_ping_events = websocket_ping_events.saturating_add(1);
            }
            Message::Pong(payload) => {
                network_bytes =
                    network_bytes.saturating_add(u64::try_from(payload.len()).unwrap_or(u64::MAX));
                websocket_pong_events = websocket_pong_events.saturating_add(1);
            }
            Message::Close(_) => {
                websocket_close_events = websocket_close_events.saturating_add(1);
                break;
            }
            Message::Frame(_) => {}
        }
    }

    if !terminal_seen {
        // Server closed (or read returned None) before sending a terminal
        // response event. Treat this as a transport failure — the harness
        // retry layer will retry on a fresh connection.
        return StreamOutcome::Reconnect(WsTransportError {
            status,
            error_body: "websocket connection closed before terminal response event".to_string(),
            accumulator,
            response_headers,
            retry_with_fresh_connection: !fresh_connection && !bytes_seen_for_request,
        });
    }

    let mut stats = json!({
        "networkChunks": network_chunks,
        "networkBytes": network_bytes,
        "websocketEvents": websocket_events,
        "websocketTextEvents": websocket_text_events,
        "websocketBinaryEvents": websocket_binary_events,
        "websocketPingEvents": websocket_ping_events,
        "websocketPongEvents": websocket_pong_events,
        "websocketCloseEvents": websocket_close_events,
        "websocketUpgradeStatus": upgrade_status,
        "websocketTerminalSeen": terminal_seen,
        "websocketConnectionReused": !fresh_connection,
        "accumulatorCalls": accumulator_calls,
        "timeToFirstByteNs": first_byte_ns,
        "timeToFirstEventNs": first_event_ns,
        "timeToFirstAccumulatorNs": first_accumulator_ns,
    });
    if let Some(obj) = stats.as_object_mut() {
        obj.insert(
            "transport".to_string(),
            Value::String("websocket".to_string()),
        );
    }
    StreamOutcome::Completed(
        finalize_stream(pool, bundle, accumulator, status, response_headers, stats).await,
    )
}

async fn init_stream_accumulator(
    pool: &Arc<Pool>,
    bundle: &Arc<String>,
    stream_events: &Value,
    status: u16,
    response_headers: &Value,
) -> Result<Value, Value> {
    match call_harness(
        pool,
        bundle,
        json!({ "command": "llm-stream-init", "streamEvents": stream_events.clone() }),
    )
    .await
    {
        Ok(v) => {
            publish_returned_events(&v);
            Ok(v.get("state").cloned().unwrap_or(Value::Null))
        }
        Err(e) => Err(transport_error(
            pool,
            bundle,
            status,
            format!("llm init: {e}"),
            Value::Null,
            response_headers.clone(),
        )
        .await),
    }
}

async fn accumulate_websocket_text_event(
    pool: &Arc<Pool>,
    bundle: &Arc<String>,
    accumulator: Value,
    stream_events: &Value,
    event: String,
    request_started: Instant,
) -> Result<(Value, u128), String> {
    let v = call_harness(
        pool,
        bundle,
        json!({
            "command": "llm-stream-accumulate",
            "state": accumulator,
            "streamEvents": stream_events.clone(),
            "events": vec![event],
        }),
    )
    .await?;
    publish_returned_events(&v);
    Ok((
        v.get("state").cloned().unwrap_or(Value::Null),
        request_started.elapsed().as_nanos(),
    ))
}

async fn finalize_stream(
    pool: &Arc<Pool>,
    bundle: &Arc<String>,
    accumulator: Value,
    status: u16,
    response_headers: Value,
    stream_stats: Value,
) -> Value {
    match call_harness(
        pool,
        bundle,
        json!({
            "command": "llm-stream-finalize",
            "state": accumulator,
            "status": status,
            "headers": response_headers.clone(),
        }),
    )
    .await
    {
        Ok(mut v) => {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("streamStats".to_string(), stream_stats);
            }
            v
        }
        Err(e) => {
            transport_error(
                pool,
                bundle,
                status,
                format!("llm finalize: {e}"),
                Value::Null,
                response_headers,
            )
            .await
        }
    }
}

fn websocket_url(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        url.to_string()
    }
}

fn request_headers_from_value(headers: &Value) -> http::HeaderMap {
    let mut out = http::HeaderMap::new();
    if let Some(map) = headers.as_object() {
        for (k, v) in map {
            let Some(s) = v.as_str() else {
                continue;
            };
            let Ok(name) = http::HeaderName::from_bytes(k.as_bytes()) else {
                continue;
            };
            let Ok(value) = http::HeaderValue::from_str(s) else {
                continue;
            };
            out.insert(name, value);
        }
    }
    out
}

fn ws_headers_json(headers: &http::HeaderMap) -> Value {
    let mut out = Map::new();
    for (name, value) in headers.iter() {
        if let Ok(s) = value.to_str() {
            out.insert(name.as_str().to_string(), Value::String(s.to_string()));
        }
    }
    Value::Object(out)
}

fn websocket_connect_error(err: WsError) -> (u16, String, Value) {
    match err {
        WsError::Http(response) => {
            let status = response.status().as_u16();
            let headers = ws_headers_json(response.headers());
            let body = response
                .body()
                .as_ref()
                .and_then(|bytes| String::from_utf8(bytes.clone()).ok())
                .unwrap_or_else(|| format!("websocket upgrade failed with status {status}"));
            (status, body, headers)
        }
        other => (0, format!("websocket connect: {other}"), Value::Null),
    }
}

fn should_accumulate_websocket_event(event_type: &str, event: &Value) -> bool {
    if event_type == "error" || event.get("error").is_some() {
        return true;
    }
    matches!(
        event_type,
        "response.created"
            | "response.completed"
            | "response.done"
            | "response.failed"
            | "response.incomplete"
            | "response.output_text.delta"
            | "response.text.delta"
            | "response.output_item.added"
            | "response.output_item.done"
            | "response.content_part.added"
            | "response.content_part.done"
            | "response.function_call_arguments.delta"
            | "response.function_call_arguments.done"
            | "response.reasoning_summary_part.added"
            | "response.reasoning_summary_part.done"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning_summary_text.done"
            | "response.reasoning_text.delta"
            | "response.reasoning_text.done"
    )
}

fn websocket_terminal_event(event_type: &str, event: &Value) -> bool {
    match event_type {
        "response.completed" | "response.done" => true,
        "response.failed" | "response.incomplete" => true,
        _ => event
            .get("response")
            .and_then(|response| response.get("status"))
            .and_then(Value::as_str)
            .is_some_and(|status| {
                matches!(status, "completed" | "failed" | "incomplete" | "cancelled")
            }),
    }
}

async fn call_harness(
    pool: &Arc<Pool>,
    bundle: &Arc<String>,
    input: Value,
) -> Result<Value, String> {
    let pool = pool.clone();
    let bundle = bundle.clone();
    let input_str = input.to_string();
    let raw = tokio::task::spawn_blocking(move || pool.submit_unlocked(bundle, input_str))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))??;
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| format!("parse v8 result: {e}"))?;
    if parsed.get("ok").and_then(|x| x.as_bool()) != Some(true) {
        let msg = parsed
            .pointer("/error/message")
            .and_then(|x| x.as_str())
            .unwrap_or("v8 call failed");
        return Err(msg.to_string());
    }
    Ok(parsed.get("value").cloned().unwrap_or(Value::Null))
}

fn publish_returned_events(value: &Value) {
    if let Some(events) = value.get("events").and_then(|v| v.as_array()) {
        for event in events {
            publish_event_payload(event);
        }
    }
}

fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

fn headers_json(headers: &HeaderMap) -> Value {
    let mut out = Map::new();
    for (name, value) in headers.iter() {
        if let Ok(s) = value.to_str() {
            out.insert(name.as_str().to_string(), Value::String(s.to_string()));
        }
    }
    Value::Object(out)
}

async fn transport_error(
    pool: &Arc<Pool>,
    bundle: &Arc<String>,
    status: u16,
    error_body: String,
    state: Value,
    headers: Value,
) -> Value {
    match call_harness(
        pool,
        bundle,
        json!({
            "command": "llm-stream-error",
            "status": status,
            "errorBody": error_body,
            "state": state,
            "headers": headers.clone(),
        }),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => json!({
            "status": status,
            "ok": false,
            "content": "",
            "toolCalls": [],
            "errorBody": e,
            "headers": headers,
            "model": Value::Null,
            "usage": Value::Null,
        }),
    }
}

fn publish_event_payload(payload: &Value) {
    if let Ok(s) = serde_json::to_string(payload) {
        broadcast::publish(s);
    }
}

#[cfg(test)]
mod tests {
    use super::{should_accumulate_websocket_event, websocket_terminal_event};
    use serde_json::json;

    #[test]
    fn websocket_accumulates_responses_reasoning_events() {
        for event_type in [
            "response.content_part.added",
            "response.content_part.done",
            "response.reasoning_summary_part.added",
            "response.reasoning_summary_part.done",
            "response.reasoning_summary_text.delta",
            "response.reasoning_summary_text.done",
            "response.reasoning_text.delta",
            "response.reasoning_text.done",
        ] {
            assert!(
                should_accumulate_websocket_event(event_type, &json!({ "type": event_type })),
                "{event_type} should be passed to the harness accumulator"
            );
        }
    }

    #[test]
    fn websocket_status_completed_is_terminal() {
        assert!(websocket_terminal_event(
            "response.updated",
            &json!({ "response": { "status": "completed" } })
        ));
    }
}
