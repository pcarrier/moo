use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
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
        && let Some(location) = legacy_facts_route_redirect(path_only, query) {
            return write_redirect(&mut stream, &location);
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
    // Read the configured PSK on every upgrade so `moo psk set/clear` takes
    // effect without restarting the server. WS upgrades are infrequent enough
    // that the extra SQLite hit is fine.
    let conn = match host::open_db(db) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("psk check: failed to open db: {e}");
            return false;
        }
    };
    let configured = match settings::get(&conn, settings::PSK_KEY) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("psk check: failed to read setting: {e}");
            return false;
        }
    };
    let Some(expected) = configured else {
        return true; // no PSK set → open
    };
    let Some(provided) = query.and_then(|q| query_get(q, "psk")) else {
        return false;
    };
    constant_time_eq(provided.as_bytes(), expected.as_bytes())
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
