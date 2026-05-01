// WebSocket server for /api/ws. Carries both the broadcast event
// stream (server → client) and request/response RPC commands (client → server with reply). One reader thread decodes frames;
// commands are dispatched to worker threads that pipe results back through
// a shared writer mpsc the main thread drains. Single TcpStream is owned
// only by the writer (main thread) — never written from elsewhere.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};

use crate::broadcast::{self, Filter};
use crate::driver;
use crate::pool::Pool;
use crate::server::BundleProvider;

const WS_GUID: &[u8] = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

pub fn handle(
    mut stream: TcpStream,
    sec_key: &str,
    pool: Arc<Pool>,
    bundle: BundleProvider,
) -> std::io::Result<()> {
    let accept = compute_accept(sec_key);
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Accept: {accept}\r\n\
         \r\n"
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()?;

    let subscription = broadcast::subscribe();
    let sub_id = subscription.id;
    let bcast_rx = subscription.rx;

    // Single channel feeding the writer (this thread). Both the broadcast
    // forwarder and per-request worker threads drop frames here.
    let (writer_tx, writer_rx) = mpsc::channel::<String>();
    let alive = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));

    // Forwarder: broadcast subscription → writer channel. Also injects ping
    // heartbeats during quiet periods.
    {
        let writer_tx = writer_tx.clone();
        let alive = alive.clone();
        thread::spawn(move || {
            while alive.load(std::sync::atomic::Ordering::Relaxed) {
                match bcast_rx.recv_timeout(Duration::from_millis(500)) {
                    Ok(msg) => {
                        if writer_tx.send(msg).is_err() {
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if writer_tx.send(r#"{"kind":"ping"}"#.to_string()).is_err() {
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        });
    }

    // Reader thread: parses subscribe messages and dispatches `run` requests
    // to worker threads. Each worker thread runs the command synchronously
    // and posts a `{kind:"run-result",id,result}` frame to writer_tx.
    let read_clone = stream.try_clone()?;
    let alive_reader = alive.clone();
    {
        let writer_tx = writer_tx.clone();
        let pool = pool.clone();
        let bundle = bundle.clone();
        thread::spawn(move || {
            let mut s = read_clone;
            loop {
                match read_text_frame(&mut s) {
                    Ok(Some(text)) => {
                        let trimmed = text.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let parsed: Value = match serde_json::from_str(trimmed) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        if let Some(chat_id) = parsed
                            .get("subscribe")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                        {
                            broadcast::set_filter(
                                sub_id,
                                Filter {
                                    chat_id: Some(chat_id.to_string()),
                                },
                            );
                            continue;
                        }
                        if let Some(payload) = parsed.get("run") {
                            let id = parsed
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let writer_tx = writer_tx.clone();
                            let pool = pool.clone();
                            let bundle = bundle.clone();
                            let payload = payload.clone();
                            thread::spawn(move || {
                                run_command(payload, id, pool, bundle, writer_tx);
                            });
                        }
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
            alive_reader.store(false, std::sync::atomic::Ordering::Relaxed);
        });
    }

    // Writer loop: drains the merged channel and writes frames. Exit when
    // the reader closes (alive=false) or the writer side errors.
    while alive.load(std::sync::atomic::Ordering::Relaxed) {
        match writer_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(msg) => {
                if write_text_frame(&mut stream, msg.as_bytes()).is_err() {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    Ok(())
}

fn run_command(
    payload: Value,
    id: String,
    pool: Arc<Pool>,
    bundle: BundleProvider,
    writer_tx: mpsc::Sender<String>,
) {
    let source = Arc::new(bundle());
    let result_value = submit_to_pool(&pool, source.clone(), payload.to_string());
    apply_driver_actions(&result_value, &pool, source);

    let frame = json!({
        "kind": "run-result",
        "id": id,
        "result": result_value,
    });
    let _ = writer_tx.send(frame.to_string());
}

fn submit_to_pool(pool: &Pool, bundle: Arc<String>, body: String) -> Value {
    match pool.submit(bundle, body) {
        Ok(out) => serde_json::from_str::<Value>(&out).unwrap_or_else(
            |_| json!({ "ok": false, "error": { "message": "non-JSON pool result" } }),
        ),
        Err(e) => json!({ "ok": false, "error": { "message": e } }),
    }
}

fn apply_driver_actions(result: &Value, pool: &Arc<Pool>, bundle: Arc<String>) {
    if result.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return;
    }
    let Some(value) = result.get("value") else {
        return;
    };
    driver::apply_driver_actions(value, pool, &bundle);
}

// Reads one WS text message from the stream. Returns Ok(Some(text)) for a
// complete message, Ok(None) on close/EOF, Err on transport or protocol errors.
// Only handles the bits we need: text frames, continuations, masked
// (client→server), no extensions.
fn read_text_frame(stream: &mut TcpStream) -> std::io::Result<Option<String>> {
    let mut message: Vec<u8> = Vec::new();
    let mut in_text_message = false;

    loop {
        let mut hdr = [0u8; 2];
        if read_exact_or_eof(stream, &mut hdr)? {
            return Ok(None);
        }
        let fin = (hdr[0] & 0x80) != 0;
        let opcode = hdr[0] & 0x0F;
        let masked = (hdr[1] & 0x80) != 0;
        let mut len = (hdr[1] & 0x7F) as u64;
        if len == 126 {
            let mut ext = [0u8; 2];
            if read_exact_or_eof(stream, &mut ext)? {
                return Ok(None);
            }
            len = u16::from_be_bytes(ext) as u64;
        } else if len == 127 {
            let mut ext = [0u8; 8];
            if read_exact_or_eof(stream, &mut ext)? {
                return Ok(None);
            }
            len = u64::from_be_bytes(ext);
        }
        let mut mask = [0u8; 4];
        if masked && read_exact_or_eof(stream, &mut mask)? {
            return Ok(None);
        }
        // Generous cap for image-attachment payloads. A pasted screenshot
        // base64-encoded as a data URL inflates ~33% and is commonly several MB;
        // the 1 MB cap was rejecting the entire `step` request and silently
        // dropping the user's message + image. Apply the same cap to both a
        // single frame and the reassembled message.
        const MAX_MESSAGE: u64 = 256 << 20;
        if len > MAX_MESSAGE || (message.len() as u64).saturating_add(len) > MAX_MESSAGE {
            return Err(std::io::Error::other("ws message too large"));
        }
        let mut payload = vec![0u8; len as usize];
        if read_exact_or_eof(stream, &mut payload)? {
            return Ok(None);
        }
        if masked {
            for (i, b) in payload.iter_mut().enumerate() {
                *b ^= mask[i % 4];
            }
        }

        match opcode {
            0x8 => return Ok(None), // close
            0x9 | 0xA => continue,  // ping/pong; ignore for v1
            0x1 => {
                // Text messages may be fragmented by browsers/proxies,
                // especially when they carry base64 image attachments. The
                // old reader tried to parse each frame as a whole JSON RPC
                // message, so fragmented image steps were silently ignored.
                message = payload;
                in_text_message = !fin;
                if fin {
                    return Ok(Some(String::from_utf8_lossy(&message).into_owned()));
                }
            }
            0x0 if in_text_message => {
                message.extend_from_slice(&payload);
                in_text_message = !fin;
                if fin {
                    return Ok(Some(String::from_utf8_lossy(&message).into_owned()));
                }
            }
            0x0 => continue, // stray continuation; skip silently
            _ => continue,   // binary/reserved; skip silently
        }
    }
}

fn read_exact_or_eof(stream: &mut TcpStream, buf: &mut [u8]) -> std::io::Result<bool> {
    let mut filled = 0;
    while filled < buf.len() {
        match stream.read(&mut buf[filled..]) {
            Ok(0) => return Ok(true),
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(false)
}

fn write_text_frame(stream: &mut TcpStream, payload: &[u8]) -> std::io::Result<()> {
    let mut header: Vec<u8> = Vec::with_capacity(10);
    header.push(0x81); // FIN + opcode 0x1 (text)
    let len = payload.len();
    if len < 126 {
        header.push(len as u8);
    } else if len < 65_536 {
        header.push(126);
        header.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        header.push(127);
        header.extend_from_slice(&(len as u64).to_be_bytes());
    }
    stream.write_all(&header)?;
    stream.write_all(payload)?;
    stream.flush()
}

fn compute_accept(key: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(key.trim().as_bytes());
    hasher.update(WS_GUID);
    let digest = hasher.finalize();
    B64.encode(digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_accept_rfc_example() {
        // RFC 6455: "dGhlIHNhbXBsZSBub25jZQ==" → "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        assert_eq!(
            compute_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn read_text_frame_reassembles_fragmented_json() {
        use std::io::Write;
        use std::net::{TcpListener, TcpStream};
        use std::thread;

        fn write_masked_frame(
            stream: &mut TcpStream,
            fin: bool,
            opcode: u8,
            payload: &[u8],
        ) -> std::io::Result<()> {
            let mut frame = vec![(if fin { 0x80 } else { 0x00 }) | opcode];
            let mask = [1u8, 2, 3, 4];
            let len = payload.len();
            if len < 126 {
                frame.push(0x80 | len as u8);
            } else if len < 65_536 {
                frame.push(0x80 | 126);
                frame.extend_from_slice(&(len as u16).to_be_bytes());
            } else {
                frame.push(0x80 | 127);
                frame.extend_from_slice(&(len as u64).to_be_bytes());
            }
            frame.extend_from_slice(&mask);
            frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
            stream.write_all(&frame)
        }

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(addr).unwrap();
            write_masked_frame(&mut stream, false, 0x1, br#"{"run":{"command":""#).unwrap();
            write_masked_frame(
                &mut stream,
                true,
                0x0,
                br#"step","chatId":"c","message":"hi"}}"#,
            )
            .unwrap();
        });

        let (mut server, _) = listener.accept().unwrap();
        let text = read_text_frame(&mut server).unwrap().unwrap();
        client.join().unwrap();
        assert_eq!(
            text,
            r#"{"run":{"command":"step","chatId":"c","message":"hi"}}"#
        );
    }
}
