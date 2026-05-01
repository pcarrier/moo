// Generic LLM streaming transport. Rust owns the long-running HTTP/SSE
// request so no V8 worker is held while bytes are flowing. Provider-specific
// SSE accumulation, tool-call assembly, usage normalization, and progress
// event shaping live in the TypeScript harness via short accumulator calls.

use crate::broadcast;
use crate::pool::Pool;
use std::sync::Arc;

use futures_util::StreamExt;
use reqwest::header::HeaderMap;
use serde_json::{Map, Value, json};

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
        buffered.extend_from_slice(&bytes);

        // SSE event boundary is a blank line. Only drain complete events so
        // partial UTF-8 remains buffered. Batch all complete data frames from
        // this network chunk into one short harness call to avoid waking V8 for
        // every tiny token delta.
        let mut events: Vec<String> = Vec::new();
        while let Some(idx) = find_double_newline(&buffered) {
            let event_bytes: Vec<u8> = buffered.drain(..idx + 2).collect();
            let event = String::from_utf8_lossy(&event_bytes);
            for line in event.split('\n') {
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                events.push(data.to_string());
            }
        }
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
        Ok(v) => v,
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
