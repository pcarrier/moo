use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use rusty_v8 as v8;
use serde_json::{Map, Value};

use crate::runtime::{install_fn, throw};

pub fn install(scope: &mut v8::PinScope) -> Result<(), String> {
    install_fn(scope, "__op_http_fetch", op_http_fetch)?;
    install_fn(scope, "__op_http_stream_open", op_http_stream_open)?;
    install_fn(scope, "__op_http_stream_next", op_http_stream_next)?;
    install_fn(scope, "__op_http_stream_close", op_http_stream_close)?;
    Ok(())
}

// Stream registry: handles live for the duration of one HTTP-server request
// thread. ureq::Response::into_reader gives us a 'static Box<dyn Read>.
type StreamReader = Box<dyn Read + Send>;
thread_local! {
    static STREAMS: RefCell<HashMap<u64, StreamReader>> = RefCell::new(HashMap::new());
}
static NEXT_STREAM_ID: AtomicU64 = AtomicU64::new(1);

fn op_http_fetch(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 2 {
        throw(
            scope,
            "http_fetch requires (method, url, [headersJson], [body], [timeoutMs])",
        );
        return;
    }
    let method = args.get(0).to_rust_string_lossy(scope).to_uppercase();
    let url = args.get(1).to_rust_string_lossy(scope);
    let headers_json = if args.length() > 2 && !args.get(2).is_null_or_undefined() {
        args.get(2).to_rust_string_lossy(scope)
    } else {
        "{}".to_string()
    };
    let body = if args.length() > 3 && !args.get(3).is_null_or_undefined() {
        Some(args.get(3).to_rust_string_lossy(scope))
    } else {
        None
    };
    let timeout_ms: u64 = if args.length() > 4 && args.get(4).is_number() {
        let n = args
            .get(4)
            .to_number(scope)
            .map(|n| n.value())
            .unwrap_or(60_000.0);
        if n.is_finite() && n > 0.0 {
            n as u64
        } else {
            60_000
        }
    } else {
        60_000
    };

    let headers: serde_json::Value =
        serde_json::from_str(&headers_json).unwrap_or_else(|_| serde_json::json!({}));

    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_millis(timeout_ms)))
        .http_status_as_error(false)
        .build();
    let agent = ureq::Agent::new_with_config(config);
    let mut builder = ureq::http::Request::builder()
        .method(
            method
                .parse::<ureq::http::Method>()
                .unwrap_or(ureq::http::Method::GET),
        )
        .uri(&url);
    if let Some(map) = headers.as_object() {
        for (k, v) in map {
            if let Some(s) = v.as_str() {
                builder = builder.header(k, s);
            }
        }
    }

    let response_result = match builder.body(body.unwrap_or_default()) {
        Ok(req) => agent.run(req),
        Err(e) => {
            throw(scope, &format!("http_fetch {url}: {e}"));
            return;
        }
    };

    let (status, response_headers, body_text) = match response_result {
        Ok(mut resp) => {
            let status = resp.status().as_u16();
            let response_headers = headers_to_json(resp.headers());
            let mut buf = Vec::new();
            let _ = resp
                .body_mut()
                .as_reader()
                .take(50_000_000)
                .read_to_end(&mut buf);
            (
                status,
                response_headers,
                String::from_utf8_lossy(&buf).into_owned(),
            )
        }
        Err(e) => {
            throw(scope, &format!("http_fetch {url}: {e}"));
            return;
        }
    };

    let obj = v8::Object::new(scope);
    if let Some(k) = v8::String::new(scope, "status") {
        let v = v8::Number::new(scope, status as f64);
        obj.set(scope, k.into(), v.into());
    }
    if let (Some(k), Some(v)) = (
        v8::String::new(scope, "headers"),
        v8::String::new(scope, &response_headers),
    ) {
        obj.set(scope, k.into(), v.into());
    }
    if let (Some(k), Some(v)) = (
        v8::String::new(scope, "body"),
        v8::String::new(scope, &body_text),
    ) {
        obj.set(scope, k.into(), v.into());
    }
    rv.set(obj.into());
}

fn headers_to_json(headers: &ureq::http::HeaderMap) -> String {
    let mut out = Map::new();
    for (name, value) in headers.iter() {
        if let Ok(value) = value.to_str() {
            let key = name.as_str().to_ascii_lowercase();
            match out.get_mut(&key) {
                Some(Value::Array(values)) => values.push(Value::String(value.to_string())),
                Some(existing) => {
                    let previous = existing.take();
                    *existing = Value::Array(vec![previous, Value::String(value.to_string())]);
                }
                None => {
                    out.insert(key, Value::String(value.to_string()));
                }
            }
        }
    }
    Value::Object(out).to_string()
}

// ---- streaming HTTP -----------------------------------------------------
//
// op_http_stream_open issues the request and returns a numeric handle. The
// response reader is parked in a per-thread registry. op_http_stream_next
// pulls the next chunk (blocking on the socket); returns null on EOF or
// error. op_http_stream_close drops the reader.

fn op_http_stream_open(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 2 {
        throw(
            scope,
            "http_stream_open requires (method, url, [headers], [body], [timeoutMs])",
        );
        return;
    }
    let method = args.get(0).to_rust_string_lossy(scope).to_uppercase();
    let url = args.get(1).to_rust_string_lossy(scope);
    let headers_json = if args.length() > 2 && !args.get(2).is_null_or_undefined() {
        args.get(2).to_rust_string_lossy(scope)
    } else {
        "{}".to_string()
    };
    let body = if args.length() > 3 && !args.get(3).is_null_or_undefined() {
        Some(args.get(3).to_rust_string_lossy(scope))
    } else {
        None
    };
    let timeout_ms: u64 = if args.length() > 4 && args.get(4).is_number() {
        let n = args
            .get(4)
            .to_number(scope)
            .map(|n| n.value())
            .unwrap_or(120_000.0);
        if n.is_finite() && n > 0.0 {
            n as u64
        } else {
            120_000
        }
    } else {
        120_000
    };

    let headers: serde_json::Value =
        serde_json::from_str(&headers_json).unwrap_or_else(|_| serde_json::json!({}));

    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_millis(timeout_ms)))
        .http_status_as_error(false)
        .build();
    let agent = ureq::Agent::new_with_config(config);
    let mut builder = ureq::http::Request::builder()
        .method(
            method
                .parse::<ureq::http::Method>()
                .unwrap_or(ureq::http::Method::GET),
        )
        .uri(&url);
    if let Some(map) = headers.as_object() {
        for (k, v) in map {
            if let Some(s) = v.as_str() {
                builder = builder.header(k, s);
            }
        }
    }

    let response_result = match builder.body(body.unwrap_or_default()) {
        Ok(req) => agent.run(req),
        Err(e) => {
            throw(scope, &format!("http_stream_open {url}: {e}"));
            return;
        }
    };

    let (status, response_headers, reader): (u16, String, StreamReader) = match response_result {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let response_headers = headers_to_json(resp.headers());
            let reader = Box::new(resp.into_parts().1.into_reader());
            (status, response_headers, reader)
        }
        Err(e) => {
            throw(scope, &format!("http_stream_open {url}: {e}"));
            return;
        }
    };

    let id = NEXT_STREAM_ID.fetch_add(1, Ordering::Relaxed);
    STREAMS.with(|s| s.borrow_mut().insert(id, reader));

    let obj = v8::Object::new(scope);
    if let Some(k) = v8::String::new(scope, "handle") {
        let v = v8::Number::new(scope, id as f64);
        obj.set(scope, k.into(), v.into());
    }
    if let Some(k) = v8::String::new(scope, "status") {
        let v = v8::Number::new(scope, status as f64);
        obj.set(scope, k.into(), v.into());
    }
    if let (Some(k), Some(v)) = (
        v8::String::new(scope, "headers"),
        v8::String::new(scope, &response_headers),
    ) {
        obj.set(scope, k.into(), v.into());
    }
    rv.set(obj.into());
}

fn op_http_stream_next(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        throw(scope, "http_stream_next requires (handle)");
        return;
    }
    let handle = args
        .get(0)
        .to_number(scope)
        .map(|n| n.value() as u64)
        .unwrap_or(0);

    let mut buf = [0u8; 4096];
    let result: Result<usize, std::io::Error> = STREAMS.with(|s| {
        let mut map = s.borrow_mut();
        match map.get_mut(&handle) {
            Some(reader) => reader.read(&mut buf),
            None => Ok(0),
        }
    });

    match result {
        Ok(0) => rv.set(v8::null(scope).into()),
        Ok(n) => {
            let text = String::from_utf8_lossy(&buf[..n]).into_owned();
            if let Some(s) = v8::String::new(scope, &text) {
                rv.set(s.into());
            }
        }
        Err(e) => throw(scope, &format!("http_stream_next: {e}")),
    }
}

fn op_http_stream_close(
    _scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        return;
    }
    let handle = args
        .get(0)
        .to_number(_scope)
        .map(|n| n.value() as u64)
        .unwrap_or(0);
    STREAMS.with(|s| {
        s.borrow_mut().remove(&handle);
    });
}
