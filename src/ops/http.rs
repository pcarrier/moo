use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
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

// A live stream plus the cumulative number of bytes already read, so a single
// stream can be bounded by HTTP_STREAM_BODY_LIMIT_BYTES regardless of consumer
// behavior (mirrors read_limited_body for the buffered fetch path).
struct StreamState {
    reader: StreamReader,
    bytes_read: u64,
}

thread_local! {
    static STREAMS: RefCell<HashMap<u64, StreamState>> = RefCell::new(HashMap::new());
}
static NEXT_STREAM_ID: AtomicU64 = AtomicU64::new(1);
const HTTP_FETCH_BODY_LIMIT_BYTES: usize = 50_000_000;
// Streaming responses get the same cumulative ceiling as buffered fetches so a
// single stream can never read unbounded bytes (e.g. an infinite body or a
// gzip/brotli decompression bomb, since ureq auto-decompresses into the reader).
const HTTP_STREAM_BODY_LIMIT_BYTES: u64 = HTTP_FETCH_BODY_LIMIT_BYTES as u64;
// We follow redirects manually so each hop's resolved IP can be re-validated;
// bound the chain to avoid loops.
const HTTP_MAX_REDIRECTS: usize = 10;

// --- SSRF protection -----------------------------------------------------
//
// The URL is attacker-influenceable (prompt/tool-driven or via a redirect from
// an attacker-controlled server). Before issuing any request we parse the URL,
// allow only http/https, resolve the host ourselves, and reject any address
// that points at the local host, link-local/metadata, RFC1918 or ULA ranges.
// Redirects are followed manually (max_redirects(0)) so every hop is validated,
// which also defeats DNS-rebinding/redirect-based SSRF.

fn ip_is_blocked(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => ipv4_is_blocked(v4),
        IpAddr::V6(v6) => ipv6_is_blocked(v6),
    }
}

fn ipv4_is_blocked(ip: &Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_loopback()            // 127.0.0.0/8
        || ip.is_link_local()   // 169.254.0.0/16 (incl. cloud metadata)
        || ip.is_private()      // 10/8, 172.16/12, 192.168/16
        || ip.is_broadcast()
        || ip.is_unspecified()  // 0.0.0.0
        || ip.is_multicast()
        || o[0] == 100 && (o[1] & 0xc0) == 64 // 100.64.0.0/10 CGNAT
}

fn ipv6_is_blocked(ip: &Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        return true; // ::1, ::, ff00::/8
    }
    let seg = ip.segments();
    // Link-local fe80::/10
    if (seg[0] & 0xffc0) == 0xfe80 {
        return true;
    }
    // Unique local fc00::/7
    if (seg[0] & 0xfe00) == 0xfc00 {
        return true;
    }
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible addresses: validate the
    // embedded v4 address as well.
    if let Some(v4) = ip.to_ipv4() {
        return ipv4_is_blocked(&v4);
    }
    false
}

/// Parse and validate a URL for SSRF. Allows only http/https, resolves the host
/// and rejects any blocked address.
fn validate_url(url: &str) -> Result<(), String> {
    let uri: ureq::http::Uri = url
        .parse()
        .map_err(|e| format!("invalid url {url}: {e}"))?;

    match uri.scheme_str() {
        Some("http") | Some("https") => {}
        Some(other) => return Err(format!("blocked url scheme {other:?} (only http/https allowed)")),
        None => return Err(format!("url {url} is missing a scheme")),
    }

    let host = uri
        .host()
        .ok_or_else(|| format!("url {url} is missing a host"))?;
    // Strip brackets from IPv6 literals for parsing.
    let host_trimmed = host.trim_start_matches('[').trim_end_matches(']');
    let port = uri
        .port_u16()
        .unwrap_or(if uri.scheme_str() == Some("https") { 443 } else { 80 });

    // If the host is an IP literal, validate it directly without DNS.
    if let Ok(ip) = host_trimmed.parse::<IpAddr>() {
        if ip_is_blocked(&ip) {
            return Err(format!("blocked address {ip} for url {url}"));
        }
        return Ok(());
    }

    // Resolve the host ourselves so we validate the actual connect targets.
    let addrs: Vec<IpAddr> = (host_trimmed, port)
        .to_socket_addrs()
        .map_err(|e| format!("cannot resolve host for url {url}: {e}"))?
        .map(|sa| sa.ip())
        .collect();

    if addrs.is_empty() {
        return Err(format!("host for url {url} resolved to no addresses"));
    }
    for ip in &addrs {
        if ip_is_blocked(ip) {
            return Err(format!("blocked address {ip} for url {url}"));
        }
    }
    Ok(())
}

/// Execute an HTTP request, validating the target against SSRF rules on every
/// hop and following redirects manually (the agent has redirects disabled).
///
/// Returns the final response, or an error string suitable for `throw`.
#[allow(clippy::type_complexity)]
fn run_validated_request(
    agent: &ureq::Agent,
    method: &ureq::http::Method,
    initial_url: &str,
    headers: &serde_json::Value,
    body: &str,
) -> Result<ureq::http::Response<ureq::Body>, String> {
    let mut current_url = initial_url.to_string();

    for _ in 0..=HTTP_MAX_REDIRECTS {
        // Re-validate (re-resolve) on every hop to defeat DNS rebinding and
        // redirect-based SSRF.
        validate_url(&current_url)?;

        let mut builder = ureq::http::Request::builder()
            .method(method.clone())
            .uri(&current_url);
        if let Some(map) = headers.as_object() {
            for (k, v) in map {
                if let Some(s) = v.as_str() {
                    builder = builder.header(k, s);
                }
            }
        }

        let req = builder
            .body(body.to_string())
            .map_err(|e| format!("http request {current_url}: {e}"))?;
        let resp = agent
            .run(req)
            .map_err(|e| format!("http request {current_url}: {e}"))?;

        let status = resp.status().as_u16();
        if (300..400).contains(&status) {
            if let Some(location) = resp.headers().get(ureq::http::header::LOCATION) {
                let location = location
                    .to_str()
                    .map_err(|e| format!("invalid redirect location for {current_url}: {e}"))?;
                // Resolve the Location relative to the current URL.
                current_url = resolve_redirect(&current_url, location)?;
                continue;
            }
        }
        return Ok(resp);
    }

    Err(format!(
        "http request {initial_url}: too many redirects (>{HTTP_MAX_REDIRECTS})"
    ))
}

/// Resolve a (possibly relative) redirect Location against the current URL.
fn resolve_redirect(base: &str, location: &str) -> Result<String, String> {
    // Absolute URL with a scheme: use as-is (validation happens on next hop).
    if let Ok(uri) = location.parse::<ureq::http::Uri>() {
        if uri.scheme_str().is_some() {
            return Ok(location.to_string());
        }
    }

    let base_uri: ureq::http::Uri = base
        .parse()
        .map_err(|e| format!("invalid base url {base}: {e}"))?;
    let scheme = base_uri.scheme_str().unwrap_or("http");
    let authority = base_uri
        .authority()
        .map(|a| a.as_str())
        .ok_or_else(|| format!("redirect base {base} has no authority"))?;

    if let Some(stripped) = location.strip_prefix("//") {
        // Network-path reference: //host/path
        return Ok(format!("{scheme}://{stripped}"));
    }
    if location.starts_with('/') {
        // Absolute path on the same authority.
        return Ok(format!("{scheme}://{authority}{location}"));
    }
    // Relative path: resolve against the base path's directory.
    let base_path = base_uri.path();
    let dir = match base_path.rfind('/') {
        Some(idx) => &base_path[..=idx],
        None => "/",
    };
    Ok(format!("{scheme}://{authority}{dir}{location}"))
}

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
        // SSRF: disable transparent redirects; we follow them manually,
        // re-validating each hop's resolved IP.
        .max_redirects(0)
        .build();
    let agent = ureq::Agent::new_with_config(config);
    let http_method = method
        .parse::<ureq::http::Method>()
        .unwrap_or(ureq::http::Method::GET);

    let response_result = run_validated_request(
        &agent,
        &http_method,
        &url,
        &headers,
        &body.unwrap_or_default(),
    );

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
    streams: &mut HashMap<u64, StreamState>,
    handle: u64,
    buf: &mut [u8],
) -> Result<usize, std::io::Error> {
    let Some(state) = streams.get_mut(&handle) else {
        return Ok(0);
    };
    // Enforce the cumulative ceiling: once exhausted, stop returning data and
    // drop the stream (signals EOF to the consumer).
    if state.bytes_read >= HTTP_STREAM_BODY_LIMIT_BYTES {
        streams.remove(&handle);
        return Ok(0);
    }
    // Never read more than the remaining allowance in a single chunk.
    let remaining = (HTTP_STREAM_BODY_LIMIT_BYTES - state.bytes_read) as usize;
    let cap = buf.len().min(remaining);
    let result = state.reader.read(&mut buf[..cap]);
    match result {
        Ok(n) if n > 0 => {
            state.bytes_read = state.bytes_read.saturating_add(n as u64);
        }
        _ => {
            streams.remove(&handle);
        }
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
        // SSRF: disable transparent redirects; we follow them manually,
        // re-validating each hop's resolved IP.
        .max_redirects(0)
        .build();
    let agent = ureq::Agent::new_with_config(config);
    let http_method = method
        .parse::<ureq::http::Method>()
        .unwrap_or(ureq::http::Method::GET);

    let response_result = run_validated_request(
        &agent,
        &http_method,
        &url,
        &headers,
        &body.unwrap_or_default(),
    );

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
    STREAMS.with(|s| {
        s.borrow_mut().insert(
            id,
            StreamState {
                reader,
                bytes_read: 0,
            },
        )
    });

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
    use super::{StreamState, read_limited_body, read_stream_chunk, validate_url};
    use std::collections::HashMap;
    use std::io::{Cursor, Error, Read};

    struct FailingReader;

    impl Read for FailingReader {
        fn read(&mut self, _buf: &mut [u8]) -> Result<usize, Error> {
            Err(Error::other("boom"))
        }
    }

    fn state<R: Read + Send + 'static>(reader: R) -> StreamState {
        StreamState {
            reader: Box::new(reader),
            bytes_read: 0,
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
        let mut streams: HashMap<u64, StreamState> = HashMap::new();
        streams.insert(7, state(Cursor::new(Vec::<u8>::new())));
        let mut buf = [0_u8; 8];

        assert_eq!(read_stream_chunk(&mut streams, 7, &mut buf).unwrap(), 0);
        assert!(!streams.contains_key(&7));
    }

    #[test]
    fn stream_chunk_removes_handle_on_error() {
        let mut streams: HashMap<u64, StreamState> = HashMap::new();
        streams.insert(8, state(FailingReader));
        let mut buf = [0_u8; 8];

        assert!(read_stream_chunk(&mut streams, 8, &mut buf).is_err());
        assert!(!streams.contains_key(&8));
    }

    #[test]
    fn stream_chunk_keeps_handle_after_data() {
        let mut streams: HashMap<u64, StreamState> = HashMap::new();
        streams.insert(9, state(Cursor::new(b"ok".to_vec())));
        let mut buf = [0_u8; 8];

        assert_eq!(read_stream_chunk(&mut streams, 9, &mut buf).unwrap(), 2);
        assert!(streams.contains_key(&9));
    }

    #[test]
    fn stream_chunk_enforces_cumulative_cap() {
        use super::HTTP_STREAM_BODY_LIMIT_BYTES;
        let mut streams: HashMap<u64, StreamState> = HashMap::new();
        // Pretend we have already consumed the entire allowance.
        streams.insert(
            10,
            StreamState {
                reader: Box::new(Cursor::new(vec![b'x'; 16])),
                bytes_read: HTTP_STREAM_BODY_LIMIT_BYTES,
            },
        );
        let mut buf = [0_u8; 8];

        assert_eq!(read_stream_chunk(&mut streams, 10, &mut buf).unwrap(), 0);
        assert!(!streams.contains_key(&10));
    }

    #[test]
    fn validate_url_rejects_loopback_and_metadata() {
        assert!(validate_url("http://127.0.0.1/").is_err());
        assert!(validate_url("http://[::1]/").is_err());
        assert!(validate_url("http://169.254.169.254/latest/meta-data/").is_err());
        assert!(validate_url("http://10.0.0.1/").is_err());
        assert!(validate_url("http://192.168.1.1/").is_err());
        assert!(validate_url("http://172.16.0.1/").is_err());
    }

    #[test]
    fn validate_url_rejects_non_http_scheme() {
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("ftp://example.com/").is_err());
        assert!(validate_url("gopher://127.0.0.1/").is_err());
    }

    #[test]
    fn validate_url_allows_public_ip_literal() {
        assert!(validate_url("http://93.184.216.34/").is_ok());
    }
}
