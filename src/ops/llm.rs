// Generic LLM streaming transport. Rust owns the long-running HTTP/SSE
// request so no V8 worker is held while bytes are flowing. Provider-specific
// SSE accumulation, tool-call assembly, usage normalization, and progress
// event shaping live in the TypeScript harness via short accumulator calls.

use crate::broadcast;
use crate::pool::Pool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use reqwest::header::HeaderMap;
use serde_json::{Map, Value, json};
use tokio_tungstenite::connect_async_tls_with_config;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

// Codex defaults: 15s to upgrade, 5min between server frames.
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const WS_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

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
    let request_started = Instant::now();
    let ws_url = websocket_url(&url);
    let mut request = match ws_url.as_str().into_client_request() {
        Ok(req) => req,
        Err(e) => {
            return transport_error(
                &pool,
                &bundle,
                0,
                format!("websocket request: {e}"),
                Value::Null,
                Value::Null,
            )
            .await;
        }
    };
    let mut request_headers = request_headers_from_value(&headers);
    request.headers_mut().extend(request_headers.drain());

    let connect_future = connect_async_tls_with_config(request, None, false, None);
    let response = match tokio::time::timeout(WS_CONNECT_TIMEOUT, connect_future).await {
        Ok(result) => result,
        Err(_) => {
            return transport_error(
                &pool,
                &bundle,
                0,
                format!(
                    "websocket connect timed out after {}s",
                    WS_CONNECT_TIMEOUT.as_secs()
                ),
                Value::Null,
                Value::Null,
            )
            .await;
        }
    };
    let (mut socket, response) = match response {
        Ok(pair) => pair,
        Err(e) => {
            let (status, error_body, response_headers) = websocket_connect_error(e);
            return transport_error(
                &pool,
                &bundle,
                status,
                error_body,
                Value::Null,
                response_headers,
            )
            .await;
        }
    };

    let upgrade_status = response.status().as_u16();
    let response_headers = ws_headers_json(response.headers());
    if upgrade_status >= 400 {
        return transport_error(
            &pool,
            &bundle,
            upgrade_status,
            format!("websocket upgrade failed with status {upgrade_status}"),
            Value::Null,
            response_headers,
        )
        .await;
    }
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

    if let Err(e) = socket.send(Message::Text(body.into())).await {
        return transport_error(
            &pool,
            &bundle,
            status,
            format!("websocket send: {e}"),
            accumulator,
            response_headers,
        )
        .await;
    }

    loop {
        let message = match tokio::time::timeout(WS_IDLE_TIMEOUT, socket.next()).await {
            Ok(Some(Ok(msg))) => msg,
            Ok(Some(Err(e))) => {
                return transport_error(
                    &pool,
                    &bundle,
                    status,
                    format!("websocket stream: {e}"),
                    accumulator.clone(),
                    response_headers,
                )
                .await;
            }
            Ok(None) => break,
            Err(_) => {
                return transport_error(
                    &pool,
                    &bundle,
                    status,
                    format!(
                        "websocket idle timeout after {}s",
                        WS_IDLE_TIMEOUT.as_secs()
                    ),
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
                    terminal_seen = true;
                    break;
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
            | "response.function_call_arguments.delta"
            | "response.function_call_arguments.done"
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
