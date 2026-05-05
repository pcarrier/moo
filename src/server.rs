use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;

use crate::driver;
use crate::host;
use crate::pool::Pool;
use crate::settings;
use crate::ws;

pub type BundleProvider = Arc<dyn Fn() -> Arc<String> + Send + Sync>;

pub fn serve(
    host_addr: &str,
    port: u16,
    bundle: BundleProvider,
    ui_html: &'static str,
    db: &str,
) -> Result<(), String> {
    let listener = TcpListener::bind((host_addr, port)).map_err(|e| e.to_string())?;
    // Pool size needs headroom for read-only commands (describe/triples/etc)
    // to overlap with long-running `step` calls that hold an isolate for the
    // duration of LLM streaming.
    let workers = std::thread::available_parallelism()
        .map(|n| (n.get() * 2).max(8))
        .unwrap_or(12);
    let pool = Arc::new(Pool::new(workers, db));
    driver::restart_ongoing(pool.clone(), bundle());
    let db = Arc::new(db.to_string());

    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                let bundle = bundle.clone();
                let db = db.clone();
                let pool = pool.clone();
                thread::spawn(move || {
                    // The /api/ws handler carries both broadcast events and
                    // request/response RPC over a single WebSocket.
                    let _ = handle_request(s, &bundle, ui_html, pool, &db);
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
    ui_html: &'static str,
    pool: Arc<Pool>,
    db: &str,
) -> std::io::Result<()> {
    let read_clone = stream.try_clone()?;
    let mut reader = BufReader::new(read_clone);

    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let trimmed = request_line.trim_end_matches(['\r', '\n']);
    let mut parts = trimmed.splitn(3, ' ');
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();

    let mut upgrade_to: Option<String> = None;
    let mut ws_key: Option<String> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        let lower = trimmed.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("upgrade:") {
            upgrade_to = Some(rest.trim().to_string());
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
        return ws::handle(stream, &key, pool, bundle.clone());
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

    if method == "GET" && serves_ui_route(&path) {
        return write_response(
            &mut stream,
            "200 OK",
            "text/html; charset=utf-8",
            ui_html.as_bytes(),
        );
    }

    write_response(
        &mut stream,
        "404 Not Found",
        "text/plain; charset=utf-8",
        b"not found",
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
    constant_time_eq(provided.as_bytes(), expected.as_bytes())
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
    constant_time_eq(provided.as_bytes(), expected.as_bytes())
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

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
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
    path == "/"
        || path == "/index.html"
        || path == "/facts"
        || path.starts_with("/facts/")
        || path == "/apps"
        || path.starts_with("/apps/")
        || path == "/mcp"
        || path.starts_with("/mcp/")
        || path.starts_with("/chat/")
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
}
