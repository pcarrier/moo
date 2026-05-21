use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use rusty_v8 as v8;
use serde_json::{Map, Value};

use crate::ops::v8util::{required_args, set_object_str, set_object_value, set_return_str};
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
const HTTP_FETCH_BODY_LIMIT_BYTES: usize = 50_000_000;

fn op_http_fetch(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if !required_args(
        scope,
        &args,
        2,
        "http_fetch requires (method, url, [headersJson], [body], [timeoutMs])",
    ) {
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

    let (status, response_headers, body_capture) = match response_result {
        Ok(mut resp) => {
            let status = resp.status().as_u16();
            let response_headers = headers_to_json(resp.headers());
            let body_capture =
                read_limited_body(resp.body_mut().as_reader(), HTTP_FETCH_BODY_LIMIT_BYTES);
            (status, response_headers, body_capture)
        }
        Err(e) => {
            throw(scope, &format!("http_fetch {url}: {e}"));
            return;
        }
    };

    let body_text = String::from_utf8_lossy(&body_capture.bytes).into_owned();
    let obj = v8::Object::new(scope);
    let status_value = v8::Number::new(scope, status as f64);
    set_object_value(scope, obj, "status", status_value.into());
    set_object_str(scope, obj, "headers", &response_headers);
    set_object_str(scope, obj, "body", &body_text);
    let truncated_value = v8::Boolean::new(scope, body_capture.truncated);
    set_object_value(scope, obj, "bodyTruncated", truncated_value.into());
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

#[derive(Default)]
struct CapturedBody {
    bytes: Vec<u8>,
    truncated: bool,
}

fn read_limited_body(mut reader: impl Read, limit: usize) -> CapturedBody {
    let mut captured = CapturedBody::default();
    let mut chunk = [0_u8; 8192];
    loop {
        let read = match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        let remaining = limit.saturating_sub(captured.bytes.len());
        if remaining > 0 {
            captured
                .bytes
                .extend_from_slice(&chunk[..read.min(remaining)]);
        }
        if read > remaining {
            captured.truncated = true;
            break;
        }
    }
    captured
}

fn read_stream_chunk(
    streams: &mut HashMap<u64, StreamReader>,
    handle: u64,
    buf: &mut [u8],
) -> Result<usize, std::io::Error> {
    let Some(reader) = streams.get_mut(&handle) else {
        return Ok(0);
    };
    let result = reader.read(buf);
    if !matches!(result, Ok(n) if n > 0) {
        streams.remove(&handle);
    }
    result
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
    if !required_args(
        scope,
        &args,
        2,
        "http_stream_open requires (method, url, [headers], [body], [timeoutMs])",
    ) {
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
    let handle_value = v8::Number::new(scope, id as f64);
    set_object_value(scope, obj, "handle", handle_value.into());
    let status_value = v8::Number::new(scope, status as f64);
    set_object_value(scope, obj, "status", status_value.into());
    set_object_str(scope, obj, "headers", &response_headers);
    rv.set(obj.into());
}

fn op_http_stream_next(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if !required_args(scope, &args, 1, "http_stream_next requires (handle)") {
        return;
    }
    let handle = args
        .get(0)
        .to_number(scope)
        .map(|n| n.value() as u64)
        .unwrap_or(0);

    let mut buf = [0u8; 4096];
    let result: Result<usize, std::io::Error> =
        STREAMS.with(|s| read_stream_chunk(&mut s.borrow_mut(), handle, &mut buf));

    match result {
        Ok(0) => rv.set(v8::null(scope).into()),
        Ok(n) => {
            let text = String::from_utf8_lossy(&buf[..n]).into_owned();
            set_return_str(scope, &mut rv, &text);
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

#[cfg(test)]
mod tests {
    use super::{StreamReader, read_limited_body, read_stream_chunk};
    use std::collections::HashMap;
    use std::io::{Cursor, Error, Read};

    struct FailingReader;

    impl Read for FailingReader {
        fn read(&mut self, _buf: &mut [u8]) -> Result<usize, Error> {
            Err(Error::other("boom"))
        }
    }

    #[test]
    fn read_limited_body_reports_truncation() {
        let captured = read_limited_body(Cursor::new(vec![b'x'; 12]), 5);
        assert_eq!(captured.bytes, vec![b'x'; 5]);
        assert!(captured.truncated);
    }

    #[test]
    fn read_limited_body_keeps_exact_limit_complete() {
        let captured = read_limited_body(Cursor::new(b"hello".to_vec()), 5);
        assert_eq!(captured.bytes, b"hello");
        assert!(!captured.truncated);
    }

    #[test]
    fn stream_chunk_removes_handle_on_eof() {
        let mut streams: HashMap<u64, StreamReader> = HashMap::new();
        streams.insert(7, Box::new(Cursor::new(Vec::<u8>::new())));
        let mut buf = [0_u8; 8];

        assert_eq!(read_stream_chunk(&mut streams, 7, &mut buf).unwrap(), 0);
        assert!(!streams.contains_key(&7));
    }

    #[test]
    fn stream_chunk_removes_handle_on_error() {
        let mut streams: HashMap<u64, StreamReader> = HashMap::new();
        streams.insert(8, Box::new(FailingReader));
        let mut buf = [0_u8; 8];

        assert!(read_stream_chunk(&mut streams, 8, &mut buf).is_err());
        assert!(!streams.contains_key(&8));
    }

    #[test]
    fn stream_chunk_keeps_handle_after_data() {
        let mut streams: HashMap<u64, StreamReader> = HashMap::new();
        streams.insert(9, Box::new(Cursor::new(b"ok".to_vec())));
        let mut buf = [0_u8; 8];

        assert_eq!(read_stream_chunk(&mut streams, 9, &mut buf).unwrap(), 2);
        assert!(streams.contains_key(&9));
    }
}
