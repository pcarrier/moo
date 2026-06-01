// Generic LLM streaming transport. Rust owns the long-running HTTP/SSE
// request so no V8 worker is held while bytes are flowing. Provider-specific
// SSE accumulation, tool-call assembly, usage normalization, and progress
// event shaping live in the TypeScript harness via short accumulator calls.

use crate::broadcast;
use crate::pool::Pool;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use reqwest::header::HeaderMap;
use serde_json::{Map, Value, json};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_tls_with_config};

// Codex defaults: 15s to upgrade, 5min between server frames. We additionally
// recycle idle connections after a few minutes so a long-quiet chat doesn't
// hand the next user a half-dead socket the server already gave up on.
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const WS_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const WS_CONNECTION_IDLE_TTL: Duration = Duration::from_secs(600);
const WS_MAX_CONNECTIONS_PER_KEY: usize = 4;
const WS_COMMAND_CHANNEL_CAPACITY: usize = 32;
const WS_EVENT_CHANNEL_CAPACITY: usize = 128;
/// Cap the SSE reassembly buffer so a server that streams bytes without ever
/// emitting an event boundary ("\n\n") can't grow the heap without bound.
const SSE_BUFFER_LIMIT_BYTES: usize = 10_000_000;

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
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

type OpenAiWebSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct OpenAiWebSocketManager {
    connections: Mutex<HashMap<WebSocketConnectionKey, Vec<WebSocketConnectionHandle>>>,
    next_session_id: AtomicU64,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct WebSocketConnectionKey {
    ws_url: String,
    chat_id: String,
    model: Option<String>,
    headers_hash: String,
    stats_hash: String,
}

#[derive(Clone)]
struct WebSocketConnectionHandle {
    session_id: u64,
    sender: mpsc::Sender<WebSocketCommand>,
    load: Arc<AtomicUsize>,
}

#[derive(Clone)]
struct WebSocketSelection {
    handle: WebSocketConnectionHandle,
    key_hash: String,
    pool_size: usize,
}

struct WebSocketCommand {
    body: String,
    events: mpsc::Sender<WebSocketSessionEvent>,
    key_hash: String,
    pool_size: usize,
    model: Option<String>,
}

#[derive(Clone)]
struct WebSocketSessionStarted {
    session_id: u64,
    connection_id: u64,
    request_index: u64,
    connection_reused: bool,
    reconnects: u64,
    upgrade_status: u16,
    response_headers: Value,
    key_hash: String,
    pool_size: usize,
    model: Option<String>,
}

struct WebSocketSessionFailure {
    status: u16,
    error_body: String,
    response_headers: Value,
}

enum WebSocketSessionEvent {
    Started(WebSocketSessionStarted),
    Message(Message),
    Failure(WebSocketSessionFailure),
}

struct WebSocketConnectSuccess {
    socket: OpenAiWebSocket,
    upgrade_status: u16,
    response_headers: Value,
}

enum ActiveMessageDisposition {
    Continue,
    Complete,
    CloseConnection,
}

fn websocket_manager() -> &'static OpenAiWebSocketManager {
    static MANAGER: OnceLock<OpenAiWebSocketManager> = OnceLock::new();
    MANAGER.get_or_init(|| OpenAiWebSocketManager {
        connections: Mutex::new(HashMap::new()),
        next_session_id: AtomicU64::new(0),
    })
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
        if buffered.len().saturating_add(bytes.len()) > SSE_BUFFER_LIMIT_BYTES {
            return transport_error(
                &pool,
                &bundle,
                status,
                format!(
                    "stream: SSE buffer exceeded {SSE_BUFFER_LIMIT_BYTES} bytes without an event boundary"
                ),
                accumulator.clone(),
                response_headers,
            )
            .await;
        }
        buffered.extend_from_slice(&bytes);

        // SSE event boundary is a blank line. Only drain complete events so
        // partial UTF-8 remains buffered. Batch all complete data frames from
        // this network chunk into one short harness call to avoid waking V8 for
        // every tiny token delta.
        let mut events: Vec<String> = Vec::new();
        while let Some((idx, term_len)) = find_double_newline(&buffered) {
            let event_bytes: Vec<u8> = buffered.drain(..idx + term_len).collect();
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
    let chat_id = chat_id_from_stream_events(&stream_events).to_string();
    let mut session_events = match websocket_manager()
        .start_request(ws_url, headers.clone(), body, chat_id)
        .await
    {
        Ok(events) => events,
        Err(e) => {
            return transport_error(&pool, &bundle, 0, e, Value::Null, Value::Null).await;
        }
    };

    let started = loop {
        match session_events.recv().await {
            Some(WebSocketSessionEvent::Started(started)) => break started,
            Some(WebSocketSessionEvent::Failure(failure)) => {
                return transport_error(
                    &pool,
                    &bundle,
                    failure.status,
                    failure.error_body,
                    Value::Null,
                    failure.response_headers,
                )
                .await;
            }
            Some(WebSocketSessionEvent::Message(_)) => continue,
            None => {
                return transport_error(
                    &pool,
                    &bundle,
                    0,
                    "websocket manager closed before connection started".to_string(),
                    Value::Null,
                    Value::Null,
                )
                .await;
            }
        }
    };

    let upgrade_status = started.upgrade_status;
    let response_headers = started.response_headers.clone();
    // The websocket handshake itself is a 101 Switching Protocols response, but
    // downstream LLM result/retry logic expects model streams to look like a
    // successful request with provider errors surfaced by the accumulator.
    let status = 200;

    let mut accumulator =
        match init_stream_accumulator(&pool, &bundle, &stream_events, status, &response_headers)
            .await
        {
            Ok(state) => state,
            Err(value) => return value,
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
    let mut websocket_response_id: Option<String> = None;

    loop {
        let message = match session_events.recv().await {
            Some(WebSocketSessionEvent::Message(message)) => message,
            Some(WebSocketSessionEvent::Failure(failure)) => {
                let failure_headers = if failure.response_headers.is_null() {
                    response_headers.clone()
                } else {
                    failure.response_headers
                };
                return transport_error(
                    &pool,
                    &bundle,
                    if failure.status == 0 {
                        status
                    } else {
                        failure.status
                    },
                    failure.error_body,
                    accumulator.clone(),
                    failure_headers,
                )
                .await;
            }
            Some(WebSocketSessionEvent::Started(_)) => continue,
            None => break,
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
                if first_event_ns.is_none() {
                    first_event_ns = Some(request_started.elapsed().as_nanos());
                }
                let event = match serde_json::from_str::<Value>(&text) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                if websocket_response_id.is_none() {
                    websocket_response_id = websocket_event_response_id(&event);
                }
                let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
                let is_error = event_type == "error" || event.get("error").is_some();
                let should_accumulate = should_accumulate_websocket_event(event_type, &event);
                let is_terminal = websocket_terminal_event(event_type, &event);

                if should_accumulate {
                    match accumulate_websocket_text_event(
                        &pool,
                        &bundle,
                        accumulator,
                        &stream_events,
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
                            return transport_error(
                                &pool,
                                &bundle,
                                status,
                                format!("llm accumulate: {e}"),
                                Value::Null,
                                response_headers,
                            )
                            .await;
                        }
                    }
                }

                if is_error {
                    return transport_error(
                        &pool,
                        &bundle,
                        status,
                        text,
                        accumulator.clone(),
                        response_headers,
                    )
                    .await;
                }
                if is_terminal {
                    terminal_seen = true;
                    break;
                }
            }
            Message::Binary(bytes) => {
                network_bytes =
                    network_bytes.saturating_add(u64::try_from(bytes.len()).unwrap_or(u64::MAX));
                websocket_binary_events = websocket_binary_events.saturating_add(1);
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
                if websocket_response_id.is_none() {
                    websocket_response_id = websocket_event_response_id(&event);
                }
                let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
                let is_error = event_type == "error" || event.get("error").is_some();
                let should_accumulate = should_accumulate_websocket_event(event_type, &event);
                let is_terminal = websocket_terminal_event(event_type, &event);

                if should_accumulate {
                    match accumulate_websocket_text_event(
                        &pool,
                        &bundle,
                        accumulator,
                        &stream_events,
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
                            return transport_error(
                                &pool,
                                &bundle,
                                status,
                                format!("llm accumulate: {e}"),
                                Value::Null,
                                response_headers,
                            )
                            .await;
                        }
                    }
                }

                if is_error {
                    return transport_error(
                        &pool,
                        &bundle,
                        status,
                        text,
                        accumulator.clone(),
                        response_headers,
                    )
                    .await;
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
        return transport_error(
            &pool,
            &bundle,
            status,
            "websocket connection closed before terminal response event".to_string(),
            accumulator.clone(),
            response_headers,
        )
        .await;
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
        "websocketConnectionReused": started.connection_reused,
        "websocketSessionId": started.session_id,
        "websocketConnectionId": started.connection_id,
        "websocketRequestIndex": started.request_index,
        "websocketReconnects": started.reconnects,
        "websocketKey": started.key_hash,
        "websocketPoolSize": started.pool_size,
        "websocketModel": started.model,
        "websocketResponseId": websocket_response_id,
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
    finalize_stream(&pool, &bundle, accumulator, status, response_headers, stats).await
}

impl OpenAiWebSocketManager {
    async fn start_request(
        &self,
        ws_url: String,
        headers: Value,
        body: String,
        chat_id: String,
    ) -> Result<mpsc::Receiver<WebSocketSessionEvent>, String> {
        let model = websocket_body_model(&body);
        let key = WebSocketConnectionKey::new(&ws_url, &headers, &chat_id, model);
        let (events_tx, events_rx) = mpsc::channel(WS_EVENT_CHANNEL_CAPACITY);
        let mut command = Some(WebSocketCommand {
            body,
            events: events_tx,
            key_hash: key.stats_hash.clone(),
            pool_size: 0,
            model: key.model.clone(),
        });

        for _ in 0..2 {
            let selection = self.select_connection(&key, &ws_url, &headers);
            if let Some(cmd) = command.as_mut() {
                cmd.key_hash = selection.key_hash.clone();
                cmd.pool_size = selection.pool_size;
            }
            selection.handle.load.fetch_add(1, Ordering::AcqRel);
            let send_result = selection
                .handle
                .sender
                .send(command.take().expect("websocket command missing"))
                .await;
            match send_result {
                Ok(()) => return Ok(events_rx),
                Err(err) => {
                    selection.handle.load.fetch_sub(1, Ordering::AcqRel);
                    self.remove_connection(&key, selection.handle.session_id);
                    command = Some(err.0);
                }
            }
        }

        Err("websocket manager: connection worker closed".to_string())
    }

    fn select_connection(
        &self,
        key: &WebSocketConnectionKey,
        ws_url: &str,
        headers: &Value,
    ) -> WebSocketSelection {
        let mut connections = self.connections.lock().expect("websocket manager poisoned");
        let pool = connections.entry(key.clone()).or_default();
        pool.retain(|handle| !handle.sender.is_closed());

        let all_busy = pool
            .iter()
            .all(|handle| handle.load.load(Ordering::Acquire) > 0);
        if pool.is_empty() || (all_busy && pool.len() < WS_MAX_CONNECTIONS_PER_KEY) {
            let session_id = self.next_session_id.fetch_add(1, Ordering::AcqRel) + 1;
            let (sender, receiver) = mpsc::channel(WS_COMMAND_CHANNEL_CAPACITY);
            let load = Arc::new(AtomicUsize::new(0));
            spawn_websocket_connection(
                session_id,
                key.stats_hash.clone(),
                ws_url.to_string(),
                headers.clone(),
                receiver,
                load.clone(),
            );
            pool.push(WebSocketConnectionHandle {
                session_id,
                sender,
                load,
            });
        }

        let handle = pool
            .iter()
            .min_by_key(|handle| handle.load.load(Ordering::Acquire))
            .expect("websocket pool unexpectedly empty")
            .clone();
        WebSocketSelection {
            handle,
            key_hash: key.stats_hash.clone(),
            pool_size: pool.len(),
        }
    }

    fn remove_connection(&self, key: &WebSocketConnectionKey, session_id: u64) {
        let mut connections = self.connections.lock().expect("websocket manager poisoned");
        if let Some(pool) = connections.get_mut(key) {
            pool.retain(|handle| handle.session_id != session_id && !handle.sender.is_closed());
            if pool.is_empty() {
                connections.remove(key);
            }
        }
    }
}

impl WebSocketConnectionKey {
    fn new(ws_url: &str, headers: &Value, chat_id: &str, model: Option<String>) -> Self {
        let headers_hash = websocket_headers_fingerprint(headers);
        let stats_hash =
            websocket_connection_stats_hash(ws_url, chat_id, model.as_deref(), &headers_hash);
        Self {
            ws_url: ws_url.to_string(),
            chat_id: chat_id.to_string(),
            model,
            headers_hash,
            stats_hash,
        }
    }
}

fn spawn_websocket_connection(
    session_id: u64,
    key_hash: String,
    ws_url: String,
    headers: Value,
    commands: mpsc::Receiver<WebSocketCommand>,
    load: Arc<AtomicUsize>,
) {
    tokio::spawn(async move {
        run_websocket_connection(session_id, key_hash, ws_url, headers, commands, load).await;
    });
}

async fn run_websocket_connection(
    session_id: u64,
    key_hash: String,
    ws_url: String,
    headers: Value,
    mut commands: mpsc::Receiver<WebSocketCommand>,
    load: Arc<AtomicUsize>,
) {
    let mut socket: Option<OpenAiWebSocket> = None;
    let mut response_headers = Value::Null;
    let mut upgrade_status = 0_u16;
    let mut connection_id = 0_u64;
    let mut reconnects = 0_u64;
    let mut request_index = 0_u64;

    loop {
        if socket.is_none() {
            let Some(cmd) = commands.recv().await else {
                break;
            };
            request_index = request_index.saturating_add(1);
            let connect = connect_openai_websocket(&ws_url, &headers).await;
            let success = match connect {
                Ok(success) => success,
                Err(failure) => {
                    let _ = cmd
                        .events
                        .send(WebSocketSessionEvent::Failure(failure))
                        .await;
                    load.fetch_sub(1, Ordering::AcqRel);
                    continue;
                }
            };
            connection_id = connection_id.saturating_add(1);
            if connection_id > 1 {
                reconnects = reconnects.saturating_add(1);
            }
            response_headers = success.response_headers.clone();
            upgrade_status = success.upgrade_status;
            socket = Some(success.socket);
            let started = WebSocketSessionStarted {
                session_id,
                connection_id,
                request_index,
                connection_reused: false,
                reconnects,
                upgrade_status,
                response_headers: response_headers.clone(),
                key_hash: cmd.key_hash.clone(),
                pool_size: cmd.pool_size,
                model: cmd.model.clone(),
            };
            let keep_socket = handle_active_websocket_request(
                socket.as_mut().expect("websocket missing after connect"),
                cmd,
                started,
            )
            .await;
            load.fetch_sub(1, Ordering::AcqRel);
            if !keep_socket {
                socket = None;
            }
            continue;
        }

        let idle = tokio::time::sleep(WS_CONNECTION_IDLE_TTL);
        tokio::pin!(idle);
        tokio::select! {
            maybe_cmd = commands.recv() => {
                let Some(cmd) = maybe_cmd else {
                    break;
                };
                request_index = request_index.saturating_add(1);
                let started = WebSocketSessionStarted {
                    session_id,
                    connection_id,
                    request_index,
                    connection_reused: true,
                    reconnects,
                    upgrade_status,
                    response_headers: response_headers.clone(),
                    key_hash: cmd.key_hash.clone(),
                    pool_size: cmd.pool_size,
                    model: cmd.model.clone(),
                };
                let keep_socket = handle_active_websocket_request(
                    socket.as_mut().expect("websocket missing for active request"),
                    cmd,
                    started,
                ).await;
                load.fetch_sub(1, Ordering::AcqRel);
                if !keep_socket {
                    socket = None;
                }
            }
            maybe_message = socket.as_mut().expect("websocket missing while idle").next() => {
                match maybe_message {
                    Some(Ok(Message::Close(_))) | None => {
                        break;
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if let Some(active_socket) = socket.as_mut() {
                            let _ = active_socket.send(Message::Pong(payload)).await;
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) => {
                        break;
                    }
                }
            }
            _ = &mut idle => {
                if let Some(mut idle_socket) = socket.take() {
                    let _ = idle_socket.close(None).await;
                }
                break;
            }
        }
    }

    let _ = key_hash;
}

async fn connect_openai_websocket(
    ws_url: &str,
    headers: &Value,
) -> Result<WebSocketConnectSuccess, WebSocketSessionFailure> {
    ensure_rustls_crypto_provider();
    let mut request = ws_url
        .into_client_request()
        .map_err(|e| WebSocketSessionFailure {
            status: 0,
            error_body: format!("websocket request: {e}"),
            response_headers: Value::Null,
        })?;
    let mut request_headers = request_headers_from_value(headers);
    if let Ok(value) = http::HeaderValue::from_str(&random_uuid_v4()) {
        request_headers.insert("session-id", value);
    }
    if let Ok(value) = http::HeaderValue::from_str(&random_uuid_v4()) {
        request_headers.insert("thread-id", value);
    }
    request.headers_mut().extend(request_headers.drain());

    let connect_future = connect_async_tls_with_config(request, None, false, None);
    let response = match tokio::time::timeout(WS_CONNECT_TIMEOUT, connect_future).await {
        Ok(result) => result,
        Err(_) => {
            return Err(WebSocketSessionFailure {
                status: 0,
                error_body: format!(
                    "websocket connect timed out after {}s",
                    WS_CONNECT_TIMEOUT.as_secs()
                ),
                response_headers: Value::Null,
            });
        }
    };
    let (socket, response) = match response {
        Ok(pair) => pair,
        Err(e) => {
            let (status, error_body, response_headers) = websocket_connect_error(e);
            return Err(WebSocketSessionFailure {
                status,
                error_body,
                response_headers,
            });
        }
    };

    let upgrade_status = response.status().as_u16();
    let response_headers = ws_headers_json(response.headers());
    if upgrade_status >= 400 {
        return Err(WebSocketSessionFailure {
            status: upgrade_status,
            error_body: format!("websocket upgrade failed with status {upgrade_status}"),
            response_headers,
        });
    }

    Ok(WebSocketConnectSuccess {
        socket,
        upgrade_status,
        response_headers,
    })
}

async fn handle_active_websocket_request(
    socket: &mut OpenAiWebSocket,
    cmd: WebSocketCommand,
    started: WebSocketSessionStarted,
) -> bool {
    let response_headers = started.response_headers.clone();
    let events = cmd.events;
    if events
        .send(WebSocketSessionEvent::Started(started))
        .await
        .is_err()
    {
        return false;
    }

    if let Err(e) = socket.send(Message::Text(cmd.body.into())).await {
        let _ = events
            .send(WebSocketSessionEvent::Failure(WebSocketSessionFailure {
                status: 200,
                error_body: format!("websocket send: {e}"),
                response_headers,
            }))
            .await;
        return false;
    }

    loop {
        let message = match tokio::time::timeout(WS_IDLE_TIMEOUT, socket.next()).await {
            Ok(Some(Ok(message))) => message,
            Ok(Some(Err(e))) => {
                let _ = events
                    .send(WebSocketSessionEvent::Failure(WebSocketSessionFailure {
                        status: 200,
                        error_body: format!("websocket stream: {e}"),
                        response_headers,
                    }))
                    .await;
                return false;
            }
            Ok(None) => {
                let _ = events
                    .send(WebSocketSessionEvent::Failure(WebSocketSessionFailure {
                        status: 200,
                        error_body: "websocket connection closed before terminal response event"
                            .to_string(),
                        response_headers,
                    }))
                    .await;
                return false;
            }
            Err(_) => {
                let _ = events
                    .send(WebSocketSessionEvent::Failure(WebSocketSessionFailure {
                        status: 200,
                        error_body: format!(
                            "websocket idle timeout after {}s",
                            WS_IDLE_TIMEOUT.as_secs()
                        ),
                        response_headers,
                    }))
                    .await;
                return false;
            }
        };

        let disposition = websocket_active_message_disposition(&message);
        if let Message::Ping(payload) = &message {
            let _ = socket.send(Message::Pong(payload.clone())).await;
        }
        if events
            .send(WebSocketSessionEvent::Message(message))
            .await
            .is_err()
        {
            return false;
        }
        match disposition {
            ActiveMessageDisposition::Continue => {}
            ActiveMessageDisposition::Complete => return true,
            ActiveMessageDisposition::CloseConnection => return false,
        }
    }
}

fn websocket_active_message_disposition(message: &Message) -> ActiveMessageDisposition {
    match message {
        Message::Close(_) => ActiveMessageDisposition::CloseConnection,
        Message::Text(text) => websocket_text_message_disposition(text.as_str()),
        Message::Binary(bytes) => match std::str::from_utf8(bytes.as_ref()) {
            Ok(text) => websocket_text_message_disposition(text),
            Err(_) => ActiveMessageDisposition::Continue,
        },
        Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {
            ActiveMessageDisposition::Continue
        }
    }
}

fn websocket_text_message_disposition(text: &str) -> ActiveMessageDisposition {
    let Ok(event) = serde_json::from_str::<Value>(text) else {
        return ActiveMessageDisposition::Continue;
    };
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    if event_type == "error" || event.get("error").is_some() {
        return ActiveMessageDisposition::CloseConnection;
    }
    if websocket_terminal_event(event_type, &event) {
        return ActiveMessageDisposition::Complete;
    }
    ActiveMessageDisposition::Continue
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

fn websocket_body_model(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body).ok().and_then(|value| {
        value
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn websocket_event_response_id(event: &Value) -> Option<String> {
    event
        .get("response")
        .and_then(|response| response.get("id"))
        .and_then(Value::as_str)
        .or_else(|| event.get("response_id").and_then(Value::as_str))
        .or_else(|| {
            event
                .get("item")
                .and_then(|item| item.get("response_id"))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
}

fn websocket_headers_fingerprint(headers: &Value) -> String {
    let mut pairs: Vec<(String, String)> = headers
        .as_object()
        .map(|map| {
            map.iter()
                .filter_map(|(name, value)| {
                    value
                        .as_str()
                        .map(|s| (name.to_ascii_lowercase(), s.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    pairs.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let mut canonical = String::new();
    for (name, value) in pairs {
        canonical.push_str(&name);
        canonical.push(':');
        canonical.push_str(&value);
        canonical.push('\n');
    }
    sha256_hex(&canonical)
}

fn websocket_connection_stats_hash(
    ws_url: &str,
    chat_id: &str,
    model: Option<&str>,
    headers_hash: &str,
) -> String {
    let mut canonical = String::new();
    canonical.push_str(ws_url);
    canonical.push('\0');
    canonical.push_str(chat_id);
    canonical.push('\0');
    canonical.push_str(model.unwrap_or(""));
    canonical.push('\0');
    canonical.push_str(headers_hash);
    let hash = sha256_hex(&canonical);
    format!("ws:{}", &hash[..16])
}

fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest.as_slice() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
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

/// Locate the next SSE event boundary (a blank line). Per the SSE spec the
/// line terminator may be LF, CRLF, or a bare CR, so a blank line is `\n\n`,
/// `\r\n\r\n`, or `\r\r`. Returns the byte index where the terminator begins
/// and the terminator's length so the caller drains exactly the matched bytes
/// (draining a 4-byte CRLF boundary as 2 bytes would leave a stray `\r\n`
/// prefixed on the next event). The earliest boundary wins; when boundaries
/// start at the same index the longer (CRLF) terminator is preferred.
fn find_double_newline(buf: &[u8]) -> Option<(usize, usize)> {
    let lf = buf.windows(2).position(|w| w == b"\n\n").map(|i| (i, 2));
    let cr = buf.windows(2).position(|w| w == b"\r\r").map(|i| (i, 2));
    let crlf = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| (i, 4));
    [lf, cr, crlf]
        .into_iter()
        .flatten()
        .min_by(|(ai, alen), (bi, blen)| ai.cmp(bi).then(blen.cmp(alen)))
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
    use super::{
        ActiveMessageDisposition, WebSocketConnectionKey, should_accumulate_websocket_event,
        websocket_active_message_disposition, websocket_body_model, websocket_event_response_id,
        websocket_terminal_event,
    };
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

    #[test]
    fn websocket_connection_key_separates_auth_without_leaking_it() {
        let key_a = WebSocketConnectionKey::new(
            "wss://api.openai.test/v1/responses",
            &json!({ "Authorization": "Bearer secret-a", "OpenAI-Beta": "responses_websockets=2026-02-06" }),
            "chat-a",
            Some("gpt-5".to_string()),
        );
        let key_b = WebSocketConnectionKey::new(
            "wss://api.openai.test/v1/responses",
            &json!({ "authorization": "Bearer secret-b", "OpenAI-Beta": "responses_websockets=2026-02-06" }),
            "chat-a",
            Some("gpt-5".to_string()),
        );
        let key_c = WebSocketConnectionKey::new(
            "wss://api.openai.test/v1/responses",
            &json!({ "Authorization": "Bearer secret-a", "OpenAI-Beta": "responses_websockets=2026-02-06" }),
            "chat-c",
            Some("gpt-5".to_string()),
        );

        assert_ne!(key_a, key_b);
        assert_ne!(key_a, key_c);
        assert_ne!(key_a.headers_hash, key_b.headers_hash);
        assert_ne!(key_a.stats_hash, key_b.stats_hash);
        assert_ne!(key_a.stats_hash, key_c.stats_hash);
        assert!(!key_a.stats_hash.contains("secret-a"));
        assert!(key_a.stats_hash.starts_with("ws:"));
    }

    #[test]
    fn websocket_model_and_response_id_helpers_cover_openai_shapes() {
        assert_eq!(
            websocket_body_model(r#"{"type":"response.create","model":"gpt-5"}"#),
            Some("gpt-5".to_string())
        );
        assert_eq!(
            websocket_event_response_id(&json!({ "response": { "id": "resp_nested" } })),
            Some("resp_nested".to_string())
        );
        assert_eq!(
            websocket_event_response_id(&json!({ "response_id": "resp_top" })),
            Some("resp_top".to_string())
        );
        assert_eq!(
            websocket_event_response_id(&json!({ "item": { "response_id": "resp_item" } })),
            Some("resp_item".to_string())
        );
    }

    #[test]
    fn websocket_active_disposition_keeps_terminal_socket_reusable() {
        assert!(matches!(
            websocket_active_message_disposition(&tokio_tungstenite::tungstenite::Message::Text(
                r#"{"type":"response.completed","response":{"status":"completed"}}"#.into()
            )),
            ActiveMessageDisposition::Complete
        ));
        assert!(matches!(
            websocket_active_message_disposition(&tokio_tungstenite::tungstenite::Message::Text(
                r#"{"type":"error","error":{"message":"bad"}}"#.into()
            )),
            ActiveMessageDisposition::CloseConnection
        ));
    }
}
