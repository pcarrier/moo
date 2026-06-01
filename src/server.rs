use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::Instant;

use crate::blit;
use crate::driver;
use crate::host;
use crate::pool::Pool;
use crate::settings;
use crate::util;
use crate::ws;

pub type BundleProvider = Arc<dyn Fn() -> Arc<String> + Send + Sync>;

struct StaticAsset {
    path: &'static str,
    content_type: &'static str,
    body: &'static [u8],
}

const PWA_MANIFEST: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/pwa_manifest.webmanifest"));
const PWA_SW: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/pwa_sw.js"));
const PWA_ICON_SVG: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/pwa_icon_moo.svg"));

const PWA_ASSETS: &[StaticAsset] = &[
    StaticAsset {
        path: "/manifest.webmanifest",
        content_type: "application/manifest+json; charset=utf-8",
        body: PWA_MANIFEST,
    },
    StaticAsset {
        path: "/sw.js",
        content_type: "text/javascript; charset=utf-8",
        body: PWA_SW,
    },
    StaticAsset {
        path: "/icons/moo.svg",
        content_type: "image/svg+xml",
        body: PWA_ICON_SVG,
    },
];

pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("--base-url must not be empty".to_string());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("--base-url must start with http:// or https://".to_string());
    }
    if trimmed.contains(|ch: char| ch.is_ascii_whitespace()) {
        return Err("--base-url must not contain whitespace".to_string());
    }
    Ok(trimmed.to_string())
}

pub(crate) fn http_url_for_addr(addr: SocketAddr) -> String {
    format!("http://{addr}")
}

pub(crate) fn wildcard_visit_addr_for_addr(addr: SocketAddr) -> Option<SocketAddr> {
    let port = addr.port();
    match addr.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => {
            Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port))
        }
        IpAddr::V6(ip) if ip.is_unspecified() => {
            Some(SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port))
        }
        _ => None,
    }
}

pub(crate) fn wildcard_visit_url_for_addr(addr: SocketAddr) -> Option<String> {
    wildcard_visit_addr_for_addr(addr).map(http_url_for_addr)
}

fn listening_message(addr: SocketAddr) -> String {
    let listen_url = http_url_for_addr(addr);
    match wildcard_visit_url_for_addr(addr) {
        Some(visit_url) => format!("listening on {listen_url} — visit {visit_url}"),
        None => format!("listening on {listen_url}"),
    }
}

pub fn serve(
    host_addr: &str,
    port: u16,
    base_url: Option<String>,
    bundle: BundleProvider,
    ui_html_br: &'static [u8],
    db: &str,
) -> Result<(), String> {
    let listener = TcpListener::bind((host_addr, port)).map_err(|e| e.to_string())?;
    let local_addr = listener.local_addr().map_err(|e| e.to_string())?;
    // Pool size caps need headroom for read-only commands (describe/triples/etc)
    // to overlap with long-running `step` calls that hold an isolate for the
    // duration of LLM streaming. Pools now start small and grow on demand.
    let conn = host::open_db(db)?;
    if let Some(raw) = settings::get(&conn, settings::V8_CONFIG_KEY)? {
        let parsed: crate::pool::V8RuntimeSettings =
            serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        crate::pool::apply_v8_runtime_settings(&parsed);
    } else if let Some(env) = settings::get(&conn, settings::V8_ENV_KEY)? {
        crate::pool::apply_v8_env_text(&env);
    }
    drop(conn);
    let workers = std::thread::available_parallelism()
        .map(|n| (n.get() * 2).max(8))
        .unwrap_or(crate::pool::DEFAULT_MAX_WORKERS)
        .min(crate::pool::configured_max_workers());
    let pool = Arc::new(Pool::new(workers, db, base_url.clone()));
    driver::restart_ongoing(pool.clone(), bundle());
    let db = Arc::new(db.to_string());
    eprintln!("moo: {}", listening_message(local_addr));

    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                let bundle = bundle.clone();
                let db = db.clone();
                let base_url = base_url.clone();
                let pool = pool.clone();
                thread::spawn(move || {
                    // The /api/ws handler carries both broadcast events and
                    // request/response RPC over a single WebSocket.
                    let _ = handle_request(s, &bundle, ui_html_br, pool, &db, base_url.as_deref());
                });
            }
            Err(_) => continue,
        }
    }
    Ok(())
}

fn handle_request(
    mut stream: TcpStream,
    bundle: &BundleProvider,
    ui_html_br: &'static [u8],
    pool: Arc<Pool>,
    db: &str,
    base_url: Option<&str>,
) -> std::io::Result<()> {
    let read_clone = stream.try_clone()?;
    let mut reader = BufReader::new(read_clone);

    // Cap how many bytes a single line read may consume so a client sending a
    // request/header line with no newline can't drive unbounded heap
    // allocation (checking len() after read_line is too late — it's already
    // allocated). This runs before any auth, so it must bound an unauthed peer.
    const MAX_HEADER_LINE: u64 = 8192;
    let mut request_line = String::new();
    if (&mut reader)
        .take(MAX_HEADER_LINE)
        .read_line(&mut request_line)?
        == 0
    {
        return Ok(());
    }
    let trimmed = request_line.trim_end_matches(['\r', '\n']);
    let mut parts = trimmed.splitn(3, ' ');
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();

    let mut upgrade_to: Option<String> = None;
    let mut ws_key: Option<String> = None;
    let mut accept_br = false;
    loop {
        let mut line = String::new();
        let n = (&mut reader).take(MAX_HEADER_LINE).read_line(&mut line)?;
        if n == 0 {
            break;
        }
        // Hit the cap without a terminating newline: an over-long header line.
        if n as u64 == MAX_HEADER_LINE && !line.ends_with('\n') {
            return write_response(
                &mut stream,
                "431 Request Header Fields Too Large",
                "text/plain; charset=utf-8",
                b"header line too large",
            );
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        let lower = trimmed.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("upgrade:") {
            upgrade_to = Some(rest.trim().to_string());
        } else if let Some(rest) = lower.strip_prefix("accept-encoding:") {
            accept_br |= accepts_encoding(rest, "br");
        } else if lower.starts_with("sec-websocket-key:") {
            // header values keep their original case; pull from `trimmed`.
            if let Some(idx) = trimmed.find(':') {
                ws_key = Some(trimmed[idx + 1..].trim().to_string());
            }
        }
    }
    drop(reader);

    let is_ws_upgrade = upgrade_to
        .as_deref()
        .map(|u| u.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);

    let (path_only, query) = match path.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (path.as_str(), None),
    };

    if method == "GET" && path_only == "/api/auth/psk" {
        return write_psk_status(&mut stream, db, query);
    }

    if is_ws_upgrade && method == "GET" && path_only == "/api/ws" {
        if !psk_ok(db, query) {
            return write_response(
                &mut stream,
                "401 Unauthorized",
                "text/plain; charset=utf-8",
                b"invalid psk",
            );
        }
        let key = ws_key.unwrap_or_default();
        return ws::handle(
            stream,
            &key,
            pool,
            bundle.clone(),
            db.to_string(),
            base_url.map(str::to_string),
        );
    }

    if is_ws_upgrade && method == "GET" && path_only == "/api/blit/ws" {
        if !psk_ok(db, query) {
            return write_response(
                &mut stream,
                "401 Unauthorized",
                "text/plain; charset=utf-8",
                b"invalid psk",
            );
        }
        let key = ws_key.unwrap_or_default();
        return blit::handle_ws(stream, &key);
    }

    if method == "GET"
        && let Some(location) = legacy_facts_route_redirect(path_only, query)
    {
        return write_redirect(&mut stream, &location);
    }

    if method == "GET"
        && (path_only.starts_with("/api/fs/raw/") || path_only.starts_with("/api/fs/raw64/"))
    {
        return serve_raw_file(&mut stream, path_only, db);
    }

    if method == "GET"
        && let Some(asset) = pwa_asset_for_path(path_only)
    {
        return write_response(&mut stream, "200 OK", asset.content_type, asset.body);
    }

    if method == "GET" && serves_ui_route(&path) {
        return write_ui_response(&mut stream, ui_html_br, accept_br, path_only);
    }

    write_response(
        &mut stream,
        "404 Not Found",
        "text/plain; charset=utf-8",
        b"not found",
    )
}

fn write_psk_status(stream: &mut TcpStream, db: &str, query: Option<&str>) -> std::io::Result<()> {
    let configured = match configured_psk(db) {
        Ok(v) => v,
        Err(()) => {
            return write_response(
                stream,
                "500 Internal Server Error",
                "text/plain; charset=utf-8",
                b"psk status unavailable",
            );
        }
    };
    let Some(expected) = configured else {
        return write_response(
            stream,
            "200 OK",
            "application/json; charset=utf-8",
            br#"{"required":false,"valid":true}"#,
        );
    };
    let valid = query
        .and_then(|q| query_get(q, "psk"))
        .is_some_and(|provided| crate::passphrase::verify(&provided, &expected));
    let body = format!(r#"{{"required":true,"valid":{valid}}}"#);
    write_response(
        stream,
        "200 OK",
        "application/json; charset=utf-8",
        body.as_bytes(),
    )
}

fn psk_ok(db: &str, query: Option<&str>) -> bool {
    let configured = match configured_psk(db) {
        Ok(v) => v,
        Err(()) => return false,
    };
    let Some(expected) = configured else {
        return true; // no PSK set → open
    };
    let Some(provided) = query.and_then(|q| query_get(q, "psk")) else {
        return false;
    };
    crate::passphrase::verify(&provided, &expected)
}

fn serve_raw_file(stream: &mut TcpStream, path: &str, db: &str) -> std::io::Result<()> {
    let Some(raw) = raw_file_request(path) else {
        return write_response(
            stream,
            "400 Bad Request",
            "text/plain; charset=utf-8",
            b"bad raw file route",
        );
    };
    if !raw_path_psk_ok(db, raw.psk.as_deref()) {
        return write_response(
            stream,
            "401 Unauthorized",
            "text/plain; charset=utf-8",
            b"invalid psk",
        );
    }

    let base = PathBuf::from(raw.root);
    let child = if raw.rest.is_empty() {
        base.clone()
    } else {
        base.join(raw.rest.trim_start_matches('/'))
    };
    let Ok(base_canon) = std::fs::canonicalize(&base) else {
        return write_response(
            stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"not found",
        );
    };
    let Ok(child_canon) = std::fs::canonicalize(&child) else {
        return write_response(
            stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"not found",
        );
    };
    if !child_canon.starts_with(&base_canon) {
        return write_response(
            stream,
            "403 Forbidden",
            "text/plain; charset=utf-8",
            b"forbidden",
        );
    }
    let Ok(meta) = std::fs::metadata(&child_canon) else {
        return write_response(
            stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"not found",
        );
    };
    if !meta.is_file() {
        return write_response(
            stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"not found",
        );
    }
    let Ok(body) = std::fs::read(&child_canon) else {
        return write_response(
            stream,
            "500 Internal Server Error",
            "text/plain; charset=utf-8",
            b"read failed",
        );
    };
    write_response(stream, "200 OK", content_type_for_path(&child_canon), &body)
}

fn configured_psk(db: &str) -> Result<Option<String>, ()> {
    // Read the configured PSK on every check so changes take effect without
    // restarting the server.
    let conn = match host::open_db(db) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("psk check: failed to open db: {e}");
            return Err(());
        }
    };
    match settings::get(&conn, settings::PSK_KEY) {
        Ok(v) => Ok(v),
        Err(e) => {
            eprintln!("psk check: failed to read setting: {e}");
            Err(())
        }
    }
}

fn raw_path_psk_ok(db: &str, provided: Option<&str>) -> bool {
    let configured = match configured_psk(db) {
        Ok(v) => v,
        Err(()) => return false,
    };
    let Some(expected) = configured else {
        return true; // no PSK set → open
    };
    let Some(provided) = provided else {
        return false;
    };
    crate::passphrase::verify(provided, &expected)
}

struct RawFileRequest {
    psk: Option<String>,
    root: String,
    rest: String,
}

fn raw_file_request(path: &str) -> Option<RawFileRequest> {
    if let Some(raw64) = raw_file_request_base64(path) {
        return Some(raw64);
    }

    let mut rest = path.strip_prefix("/api/fs/raw/")?;
    let psk = if let Some(after_psk) = rest.strip_prefix("psk/") {
        let (encoded_psk, after) = after_psk.split_once('/')?;
        rest = after;
        Some(percent_decode(encoded_psk))
    } else {
        None
    };

    // Preferred route format:
    //   /api/fs/raw/<absolute-root-without-leading-slash>/-/<path-within-root>
    // The older format encoded the whole absolute root as one path segment
    // (%2Ftmp%2F...), which some browsers/proxies decode before forwarding and
    // turn into a different route. Keeping normal slash-separated path segments
    // also lets iframe src= previews resolve relative assets naturally.
    if let Some(after_root) = rest.strip_prefix("-/") {
        return Some(RawFileRequest {
            psk,
            root: "/".to_string(),
            rest: percent_decode(after_root),
        });
    }
    if let Some((encoded_root, encoded_rest)) = rest.split_once("/-/") {
        let root = percent_decode(encoded_root).trim_matches('/').to_string();
        if root.is_empty() {
            return None;
        }
        return Some(RawFileRequest {
            psk,
            root: format!("/{root}"),
            rest: percent_decode(encoded_rest),
        });
    }

    // Back-compat for URLs produced before the segment-based route format.
    let (encoded_root, encoded_rest) = rest.split_once('/').unwrap_or((rest, ""));
    if encoded_root.is_empty() {
        return None;
    }
    Some(RawFileRequest {
        psk,
        root: percent_decode(encoded_root),
        rest: percent_decode(encoded_rest),
    })
}

fn raw_file_request_base64(path: &str) -> Option<RawFileRequest> {
    let mut rest = path.strip_prefix("/api/fs/raw64/")?;
    let psk = if let Some(after_psk) = rest.strip_prefix("psk/") {
        let (encoded_psk, after) = after_psk.split_once('/')?;
        rest = after;
        Some(base64_url_decode_string(encoded_psk)?)
    } else {
        None
    };
    let (encoded_root, encoded_rest) = rest.split_once('/').unwrap_or((rest, ""));
    if encoded_root.is_empty() {
        return None;
    }
    Some(RawFileRequest {
        psk,
        root: base64_url_decode_string(encoded_root)?,
        rest: percent_decode(encoded_rest),
    })
}

fn base64_url_decode_string(s: &str) -> Option<String> {
    String::from_utf8(base64_url_decode(s)?).ok()
}

fn base64_url_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u8;
    for b in s.bytes() {
        if b == b'=' {
            break;
        }
        let val = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        } as u32;
        buf = (buf << 6) | val;
        bits += 6;
        while bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

fn content_type_for_path(path: &Path) -> &'static str {
    let Some(ext) = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
    else {
        return "application/octet-stream";
    };
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "xhtml" => "application/xhtml+xml; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "txt" | "text" | "md" | "markdown" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "eot" => "application/vnd.ms-fontobject",
        _ => "application/octet-stream",
    }
}

fn query_get(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k == key {
            return Some(percent_decode(v));
        }
    }
    None
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'+' {
            out.push(b' ');
            i += 1;
        } else if b == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
            } else {
                out.push(b);
                i += 1;
            }
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn legacy_facts_route_redirect(path: &str, query: Option<&str>) -> Option<String> {
    if path != "/memory" && !path.starts_with("/memory/") {
        return None;
    }
    let mut location = String::from("/facts");
    location.push_str(&path["/memory".len()..]);
    if let Some(query) = query {
        location.push('?');
        location.push_str(query);
    }
    Some(location)
}

fn serves_ui_route(path: &str) -> bool {
    let path = path.split_once('?').map_or(path, |(path, _)| path);
    path.starts_with('/') && !path.starts_with("/api/")
}

fn pwa_asset_for_path(path: &str) -> Option<&'static StaticAsset> {
    PWA_ASSETS.iter().find(|asset| asset.path == path)
}

fn accepts_encoding(value: &str, coding: &str) -> bool {
    value.split(',').any(|part| {
        let mut pieces = part.trim().split(';');
        let Some(token) = pieces.next() else {
            return false;
        };
        if !token.trim().eq_ignore_ascii_case(coding) {
            return false;
        }
        pieces.all(|piece| {
            let piece = piece.trim();
            let Some((name, raw_value)) = piece.split_once('=') else {
                return true;
            };
            if !name.trim().eq_ignore_ascii_case("q") {
                return true;
            }
            raw_value.trim().parse::<f32>().is_ok_and(|q| q > 0.0)
        })
    })
}

fn decode_ui_html(ui_html_br: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut body = Vec::new();
    brotli::Decompressor::new(ui_html_br, 4096).read_to_end(&mut body)?;
    Ok(body)
}

fn write_ui_response(
    stream: &mut TcpStream,
    ui_html_br: &[u8],
    accept_br: bool,
    path: &str,
) -> std::io::Result<()> {
    if accept_br {
        let started = Instant::now();
        let result = write_encoded_response(
            stream,
            "200 OK",
            "text/html; charset=utf-8",
            ui_html_br,
            Some("br"),
        );
        trace_asset_response(path, "br", true, ui_html_br.len(), None, started);
        return result;
    }

    let started = Instant::now();
    let body = decode_ui_html(ui_html_br)?;
    let len = body.len();
    let result = write_encoded_response(stream, "200 OK", "text/html; charset=utf-8", &body, None);
    trace_asset_response(
        path,
        "identity",
        false,
        len,
        Some(ui_html_br.len()),
        started,
    );
    result
}

fn trace_asset_response(
    path: &str,
    encoding: &str,
    precompressed: bool,
    response_bytes: usize,
    source_br_bytes: Option<usize>,
    started: Instant,
) {
    if !host::tracing_enabled() {
        return;
    }
    let id = util::random_id("trace");
    let elapsed_ns = started.elapsed().as_nanos() as i64;
    let started_ns = util::now_ns().saturating_sub(elapsed_ns);
    let data = serde_json::json!({
        "path": path,
        "content_type": "text/html; charset=utf-8",
        "content_encoding": encoding,
        "brotli_precompressed_asset": precompressed,
        "brotli_runtime_compression": false,
        "response_bytes": response_bytes,
        "source_br_bytes": source_br_bytes,
        "durationNs": elapsed_ns,
    });
    let data_json = data.to_string();
    let _ = host::trace_ensure_root(host::TraceRootParams {
        id: &id,
        chat_id: None,
        run_id: None,
        kind: "http",
        name: "serve-ui-asset",
        status: None,
        started_ns,
        input_hash: None,
        data_json: Some(&data_json),
    });
}

fn write_redirect(stream: &mut TcpStream, location: &str) -> std::io::Result<()> {
    let header = format!(
        "HTTP/1.1 308 Permanent Redirect\r\n\
         Location: {location}\r\n\
         Content-Length: 0\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n"
    );
    stream.write_all(header.as_bytes())?;
    stream.flush()
}

fn write_encoded_response(
    stream: &mut TcpStream,
    status: &str,
    ctype: &str,
    body: &[u8],
    encoding: Option<&str>,
) -> std::io::Result<()> {
    let encoding_header = encoding
        .map(|encoding| format!("Content-Encoding: {encoding}\r\n"))
        .unwrap_or_default();
    let header = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: {ctype}\r\n\
         {encoding_header}\
         Vary: Accept-Encoding\r\n\
         Content-Length: {len}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n",
        len = body.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn write_response(
    stream: &mut TcpStream,
    status: &str,
    ctype: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let header = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: {ctype}\r\n\
         Content-Length: {len}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n",
        len = body.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_file_request_parses_segment_root_routes() {
        let raw = raw_file_request("/api/fs/raw/tmp/site/-/docs/index.html").unwrap();
        assert_eq!(raw.psk, None);
        assert_eq!(raw.root, "/tmp/site");
        assert_eq!(raw.rest, "docs/index.html");
    }

    #[test]
    fn raw_file_request_parses_segment_root_routes_with_psk() {
        let raw = raw_file_request("/api/fs/raw/psk/secret/tmp/site/-/docs/ss.avif").unwrap();
        assert_eq!(raw.psk, Some("secret".to_string()));
        assert_eq!(raw.root, "/tmp/site");
        assert_eq!(raw.rest, "docs/ss.avif");
    }

    #[test]
    fn raw_file_request_parses_base64_root_routes() {
        let raw =
            raw_file_request("/api/fs/raw64/L3NyYy9tb28vLm1vby9jaGF0/docs/index.html").unwrap();
        assert_eq!(raw.psk, None);
        assert_eq!(raw.root, "/src/moo/.moo/chat");
        assert_eq!(raw.rest, "docs/index.html");
    }

    #[test]
    fn raw_file_request_parses_base64_root_routes_with_psk() {
        let raw =
            raw_file_request("/api/fs/raw64/psk/c2VjcmV0L3dpdGgtc2xhc2g/L3RtcC9zaXRl/docs/ss.avif")
                .unwrap();
        assert_eq!(raw.psk, Some("secret/with-slash".to_string()));
        assert_eq!(raw.root, "/tmp/site");
        assert_eq!(raw.rest, "docs/ss.avif");
    }

    #[test]
    fn raw_file_request_keeps_legacy_encoded_root_route() {
        let raw = raw_file_request("/api/fs/raw/%2Ftmp%2Fsite/docs/index.html").unwrap();
        assert_eq!(raw.psk, None);
        assert_eq!(raw.root, "/tmp/site");
        assert_eq!(raw.rest, "docs/index.html");
    }

    #[test]
    fn serves_ui_route_falls_back_for_any_non_api_path() {
        assert!(serves_ui_route("/"));
        assert!(serves_ui_route("/new"));
        assert!(serves_ui_route("/new?from=chat"));
        assert!(serves_ui_route("/chat/abc"));
        assert!(!serves_ui_route("/api/ws"));
        assert!(!serves_ui_route("/api/fs/raw/tmp/site/-/index.html"));
    }

    #[test]
    fn pwa_assets_are_explicit_static_routes() {
        let manifest = pwa_asset_for_path("/manifest.webmanifest").unwrap();
        assert_eq!(
            manifest.content_type,
            "application/manifest+json; charset=utf-8"
        );
        assert!(
            std::str::from_utf8(manifest.body)
                .unwrap()
                .contains(r#""display": "standalone""#)
        );

        let worker = pwa_asset_for_path("/sw.js").unwrap();
        assert_eq!(worker.content_type, "text/javascript; charset=utf-8");
        assert!(
            std::str::from_utf8(worker.body)
                .unwrap()
                .contains(r#"self.addEventListener("fetch""#)
        );

        let icon = pwa_asset_for_path("/icons/moo.svg").unwrap();
        assert_eq!(icon.content_type, "image/svg+xml");
        assert!(std::str::from_utf8(icon.body).unwrap().contains("🐮"));

        assert!(pwa_asset_for_path("/chat/abc").is_none());
        assert!(pwa_asset_for_path("/api/ws").is_none());
    }

    #[test]
    fn normalize_base_url_trims_trailing_slash() {
        assert_eq!(
            normalize_base_url(" http://100.126.83.89:5173/ ").unwrap(),
            "http://100.126.83.89:5173"
        );
    }

    #[test]
    fn normalize_base_url_requires_http_url() {
        assert!(normalize_base_url("100.126.83.89:5173").is_err());
        assert!(normalize_base_url("file:///tmp/moo").is_err());
        assert!(normalize_base_url("http://bad host:5173").is_err());
    }

    #[test]
    fn accept_encoding_matches_brotli_token() {
        assert!(accepts_encoding("gzip, br", "br"));
        assert!(accepts_encoding("br;q=1.0", "br"));
        assert!(accepts_encoding("gzip, BR ; q=0.5", "br"));
        assert!(!accepts_encoding("gzip", "br"));
        assert!(!accepts_encoding("brr", "br"));
        assert!(!accepts_encoding("br;q=0", "br"));
        assert!(!accepts_encoding("br;q=0.0", "br"));
    }

    #[test]
    fn decode_ui_html_inflates_embedded_brotli() {
        let html = b"<!doctype html><title>moo</title>";
        let mut compressed = Vec::new();
        {
            let mut writer = brotli::CompressorWriter::new(&mut compressed, 4096, 5, 22);
            writer.write_all(html).unwrap();
        }
        assert_eq!(decode_ui_html(&compressed).unwrap(), html);
    }

    #[test]
    fn http_url_for_addr_formats_ipv6_with_brackets() {
        let addr: SocketAddr = "[::1]:49152".parse().unwrap();
        assert_eq!(http_url_for_addr(addr), "http://[::1]:49152");
    }

    #[test]
    fn wildcard_visit_url_uses_loopback_url() {
        assert_eq!(
            wildcard_visit_url_for_addr("0.0.0.0:49152".parse().unwrap()).as_deref(),
            Some("http://127.0.0.1:49152")
        );
        assert_eq!(
            wildcard_visit_url_for_addr("[::]:49152".parse().unwrap()).as_deref(),
            Some("http://[::1]:49152")
        );
        assert_eq!(
            wildcard_visit_url_for_addr("127.0.0.1:49152".parse().unwrap()),
            None
        );
    }

    #[test]
    fn listening_message_includes_visit_url_for_wildcard() {
        assert_eq!(
            listening_message("0.0.0.0:49152".parse().unwrap()),
            "listening on http://0.0.0.0:49152 — visit http://127.0.0.1:49152"
        );
        assert_eq!(
            listening_message("[::]:49152".parse().unwrap()),
            "listening on http://[::]:49152 — visit http://[::1]:49152"
        );
        assert_eq!(
            listening_message("127.0.0.1:49152".parse().unwrap()),
            "listening on http://127.0.0.1:49152"
        );
    }
}
