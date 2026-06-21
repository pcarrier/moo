#[cfg(windows)]
use std::fs::File;
#[cfg(windows)]
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::TcpStream;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use sha1::{Digest, Sha1};

const WS_GUID: &[u8] = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_WS_MESSAGE: u64 = 16 << 20;
const MAX_BLIT_FRAME: usize = 16 << 20;
const AUTH_PASSPHRASE: &str = "moo-blit-local";
const MIN_BLIT_VERSION: (u32, u32, u32) = (0, 33, 1);

static INSTALLING: AtomicBool = AtomicBool::new(false);
static INSTALL_RESULT: OnceLock<Result<(), String>> = OnceLock::new();

pub fn handle_ws(mut stream: TcpStream, sec_key: &str) -> std::io::Result<()> {
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

    match read_ws_message(&mut stream)? {
        Some(WsMessage::Text(pass))
            if constant_time_eq(pass.trim().as_bytes(), AUTH_PASSPHRASE.as_bytes()) => {}
        Some(WsMessage::Ping(payload)) => {
            let _ = write_ws_frame(&mut stream, 0xA, &payload);
            let _ = write_ws_text(&mut stream, b"auth");
            let _ = write_ws_close(&mut stream);
            return Ok(());
        }
        _ => {
            let _ = write_ws_text(&mut stream, b"auth");
            let _ = write_ws_close(&mut stream);
            return Ok(());
        }
    }

    let blit = match connect_blit_server() {
        Ok(sock) => sock,
        Err(err) => {
            let _ = write_ws_text(&mut stream, format!("error:{err}").as_bytes());
            let _ = write_ws_close(&mut stream);
            return Ok(());
        }
    };

    write_ws_text(&mut stream, b"ok")?;

    let alive = std::sync::Arc::new(AtomicBool::new(true));
    let mut ws_reader = stream.try_clone()?;
    let mut ws_writer = stream;
    let mut blit_reader = clone_blit_socket(&blit)?;
    let mut blit_writer = blit;

    let alive_ws_to_blit = alive.clone();
    let ws_to_blit = thread::spawn(move || {
        while alive_ws_to_blit.load(Ordering::Relaxed) {
            match read_ws_message(&mut ws_reader) {
                Ok(Some(WsMessage::Binary(payload))) => {
                    if write_blit_frame(&mut blit_writer, &payload).is_err() {
                        break;
                    }
                }
                Ok(Some(WsMessage::Ping(_))) | Ok(Some(WsMessage::Pong)) => continue,
                Ok(Some(WsMessage::Text(_))) => continue,
                Ok(Some(WsMessage::Close)) | Ok(None) | Err(_) => break,
            }
        }
        alive_ws_to_blit.store(false, Ordering::Relaxed);
    });

    while alive.load(Ordering::Relaxed) {
        match read_blit_frame(&mut blit_reader) {
            Ok(Some(payload)) => {
                if write_ws_binary(&mut ws_writer, &payload).is_err() {
                    break;
                }
            }
            Ok(None) | Err(_) => break,
        }
    }
    alive.store(false, Ordering::Relaxed);
    let _ = write_ws_binary(&mut ws_writer, &[0x0C]);
    let _ = write_ws_close(&mut ws_writer);
    // The reader thread may be parked in read_ws_message on a socket with no read
    // timeout; an idle client that ignores our close frame would never unblock
    // it and join() would hang forever (leaking the thread, both fds, and the
    // connection-limiter permit). Shut the socket down so the read returns.
    let _ = ws_writer.shutdown(std::net::Shutdown::Both);
    let _ = ws_to_blit.join();
    Ok(())
}

pub fn warmup() {
    let _ = thread::Builder::new()
        .name("blit-warmup".to_string())
        .spawn(|| {
            // Blit is only used after the browser asks for a terminal, but its
            // first local-server start can be noticeable.  Start/connect once in
            // the background so the + button usually only pays PTY creation.
            let _ = connect_blit_server();
        });
}

fn connect_blit_server() -> Result<BlitSocket, String> {
    ensure_blit_installed()?;
    let socket_path = default_local_socket();
    if let Ok(sock) = connect_blit_socket(&socket_path) {
        return Ok(sock);
    }
    start_blit_server(&socket_path)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut last = String::new();
    while Instant::now() < deadline {
        match connect_blit_socket(&socket_path) {
            Ok(sock) => return Ok(sock),
            Err(err) => {
                last = err.to_string();
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
    Err(format!(
        "cannot connect to blit server at {socket_path}: {last}"
    ))
}

fn ensure_blit_installed() -> Result<(), String> {
    if blit_is_usable() {
        return Ok(());
    }
    if let Some(result) = INSTALL_RESULT.get() {
        return result.clone();
    }
    while INSTALLING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        thread::sleep(Duration::from_millis(250));
        if blit_is_usable() {
            return Ok(());
        }
        if let Some(result) = INSTALL_RESULT.get() {
            return result.clone();
        }
    }
    let result = install_blit();
    let _ = INSTALL_RESULT.set(result.clone());
    INSTALLING.store(false, Ordering::SeqCst);
    result
}

fn blit_is_usable() -> bool {
    blit_is_installed() && blit_version_ok()
}

fn blit_version_ok() -> bool {
    let output = Command::new(blit_exe())
        .arg("--version")
        .stdin(Stdio::null())
        .output();
    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_blit_version(&stdout).is_some_and(blit_version_is_ok)
}

fn blit_version_is_ok(version: (u32, u32, u32)) -> bool {
    version >= MIN_BLIT_VERSION
}

fn blit_is_installed() -> bool {
    #[cfg(windows)]
    {
        command_exists("blit") || std::path::Path::new(&blit_exe()).exists()
    }
    #[cfg(not(windows))]
    {
        std::path::Path::new(&blit_exe()).exists()
    }
}

#[cfg(windows)]
fn command_exists(name: &str) -> bool {
    let mut cmd = Command::new("where");
    cmd.arg(name);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn install_blit() -> Result<(), String> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new(powershell_exe());
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://install.blit.sh/install.ps1 | iex",
        ]);
        configure_windows_command(&mut c);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.arg("-lc")
            .arg("mkdir -p \"$HOME/.local/bin\" && curl -sf https://install.blit.sh | BLIT_PREFIX=\"$HOME/.local\" sh");
        c
    };
    let output = cmd
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot run blit installer: {e}"))?;
    if (output.status.success() || blit_is_installed()) && blit_version_ok() {
        Ok(())
    } else {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let installed_version = blit_installed_version();
        let reason = if !output.status.success() {
            match output.status.code() {
                Some(code) => format!("the blit installer exited with status {code}"),
                None => "the blit installer was terminated by a signal".to_string(),
            }
        } else if !blit_is_installed() {
            "the blit installer completed, but blit was not found afterwards".to_string()
        } else if let Some(version) = installed_version {
            format!(
                "running blit is {}, but {} is required",
                format_blit_version(version),
                format_blit_version(MIN_BLIT_VERSION)
            )
        } else {
            format!(
                "the running blit version could not be read; {} or newer is required",
                format_blit_version(MIN_BLIT_VERSION)
            )
        };
        let install_output = format_install_output(&stdout, &stderr);
        let mut message = format!(
            "Cannot start terminal because {reason}. Install blit {} or newer, then try again.",
            format_blit_version(MIN_BLIT_VERSION)
        );
        if !install_output.is_empty() {
            message.push_str("\n\nInstaller output:\n");
            message.push_str(&install_output);
        }
        Err(message)
    }
}

fn blit_installed_version() -> Option<(u32, u32, u32)> {
    let output = Command::new(blit_exe())
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_blit_version(&stdout).or_else(|| parse_blit_version(&stderr))
}

fn format_blit_version(version: (u32, u32, u32)) -> String {
    format!("{}.{}.{}", version.0, version.1, version.2)
}

fn normalize_install_stream(stream: &str) -> String {
    stream
        .trim()
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace("... ", "...\n")
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

fn append_install_stream(output: &mut String, stream: &str) {
    let stream = normalize_install_stream(stream);
    if stream.is_empty() {
        return;
    }
    if !output.is_empty() && !output.ends_with('\n') {
        output.push('\n');
    }
    output.push_str(&stream);
    if !output.ends_with('\n') {
        output.push('\n');
    }
}

fn format_install_output(stdout: &str, stderr: &str) -> String {
    let mut output = String::new();
    append_install_stream(&mut output, stderr);
    append_install_stream(&mut output, stdout);
    output
}

fn start_blit_server(socket_path: &str) -> Result<(), String> {
    let exe = blit_exe();
    let mut cmd = Command::new(&exe);
    cmd.arg("server")
        .arg("--socket")
        .arg(socket_path)
        .envs(windows_shell_env())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_windows_command(&mut cmd);
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("cannot start blit server with {exe}: {e}"))
}

fn blit_exe() -> String {
    #[cfg(windows)]
    {
        if command_exists("blit") {
            return "blit".to_string();
        }
        if let Ok(dir) = std::env::var("LOCALAPPDATA") {
            return format!(r"{dir}\blit\bin\blit.exe");
        }
        "blit.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/.local/bin/blit");
        }
        "blit".to_string()
    }
}

fn parse_blit_version(output: &str) -> Option<(u32, u32, u32)> {
    for token in output.split_whitespace() {
        let mut parts = token.split('.');
        let (Some(major_part), Some(minor_part), Some(patch_part)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if parts.next().is_some() {
            continue;
        }
        let (Ok(major), Ok(minor)) = (major_part.parse(), minor_part.parse()) else {
            continue;
        };
        let patch_digits = patch_part.trim_end_matches(|ch: char| !ch.is_ascii_digit());
        let Ok(patch) = patch_digits.parse() else {
            continue;
        };
        return Some((major, minor, patch));
    }
    None
}

#[cfg(windows)]
fn powershell_exe() -> String {
    for candidate in ["pwsh.exe", "pwsh", "powershell.exe", "powershell"] {
        if command_exists(candidate) {
            return candidate.to_string();
        }
    }
    "powershell.exe".to_string()
}

#[cfg(windows)]
fn configure_windows_command(cmd: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
}

#[cfg(not(windows))]
fn configure_windows_command(_cmd: &mut Command) {}

fn windows_shell_env() -> impl IntoIterator<Item = (&'static str, String)> {
    #[cfg(windows)]
    {
        let powershell = powershell_exe();
        [
            ("SHELL", powershell.clone()),
            ("COMSPEC", powershell),
            ("BLIT_SHELL_FLAGS", String::new()),
        ]
    }
    #[cfg(not(windows))]
    {
        [] as [(&'static str, String); 0]
    }
}

fn default_local_socket() -> String {
    if let Ok(p) = std::env::var("BLIT_SOCK") {
        return p;
    }
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".into());
        format!(r"\\.\pipe\blit-{user}")
    }
    #[cfg(not(windows))]
    {
        if let Ok(dir) = std::env::var("TMPDIR") {
            let p = format!("{dir}/blit.sock");
            if std::path::Path::new(&p).exists() {
                return p;
            }
        }
        if let Ok(user) = std::env::var("USER") {
            let p = format!("/tmp/blit-{user}.sock");
            if std::path::Path::new(&p).exists() {
                return p;
            }
            let sys = format!("/run/blit/{user}.sock");
            if std::path::Path::new(&sys).exists() {
                return sys;
            }
        }
        if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
            return format!("{dir}/blit.sock");
        }
        "/tmp/blit.sock".into()
    }
}

#[cfg(unix)]
type BlitSocket = UnixStream;

#[cfg(windows)]
struct BlitSocket(File);

#[cfg(unix)]
fn connect_blit_socket(socket_path: &str) -> std::io::Result<BlitSocket> {
    UnixStream::connect(socket_path)
}

#[cfg(windows)]
fn connect_blit_socket(socket_path: &str) -> std::io::Result<BlitSocket> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(socket_path)
        .map(BlitSocket)
}

#[cfg(unix)]
fn clone_blit_socket(socket: &BlitSocket) -> std::io::Result<BlitSocket> {
    socket.try_clone()
}

#[cfg(windows)]
fn clone_blit_socket(socket: &BlitSocket) -> std::io::Result<BlitSocket> {
    socket.0.try_clone().map(BlitSocket)
}

#[cfg(windows)]
impl Read for BlitSocket {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buf)
    }
}

#[cfg(windows)]
impl Write for BlitSocket {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

#[derive(Debug)]
enum WsMessage {
    Text(String),
    Binary(Vec<u8>),
    Ping(Vec<u8>),
    Pong,
    Close,
}

fn read_ws_message(stream: &mut TcpStream) -> std::io::Result<Option<WsMessage>> {
    let mut message: Vec<u8> = Vec::new();
    let mut message_opcode: Option<u8> = None;

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
        if len > MAX_WS_MESSAGE || (message.len() as u64).saturating_add(len) > MAX_WS_MESSAGE {
            return Err(std::io::Error::other("ws message too large"));
        }
        let mut mask = [0u8; 4];
        if masked && read_exact_or_eof(stream, &mut mask)? {
            return Ok(None);
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
            0x8 => return Ok(Some(WsMessage::Close)),
            0x9 => return Ok(Some(WsMessage::Ping(payload))),
            0xA => return Ok(Some(WsMessage::Pong)),
            0x1 | 0x2 if message_opcode.is_some() => {
                // RFC 6455 §5.4: a new data frame while a fragmented message is
                // in progress is a protocol violation; fail the connection
                // instead of silently overwriting the partial buffer.
                return Err(std::io::Error::other(
                    "ws: unexpected data frame during fragmented message",
                ));
            }
            0x1 | 0x2 => {
                message_opcode = Some(opcode);
                message = payload;
            }
            0x0 if message_opcode.is_some() => message.extend_from_slice(&payload),
            _ => continue,
        }
        if fin {
            return Ok(match message_opcode {
                Some(0x1) => Some(WsMessage::Text(
                    String::from_utf8_lossy(&message).into_owned(),
                )),
                Some(0x2) => Some(WsMessage::Binary(message)),
                _ => None,
            });
        }
    }
}

fn write_ws_text(stream: &mut TcpStream, payload: &[u8]) -> std::io::Result<()> {
    write_ws_frame(stream, 0x1, payload)
}

fn write_ws_binary(stream: &mut TcpStream, payload: &[u8]) -> std::io::Result<()> {
    write_ws_frame(stream, 0x2, payload)
}

fn write_ws_close(stream: &mut TcpStream) -> std::io::Result<()> {
    write_ws_frame(stream, 0x8, &[])
}

fn write_ws_frame(stream: &mut TcpStream, opcode: u8, payload: &[u8]) -> std::io::Result<()> {
    let mut header: Vec<u8> = Vec::with_capacity(10);
    header.push(0x80 | (opcode & 0x0F));
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

fn read_blit_frame(stream: &mut BlitSocket) -> std::io::Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    if read_exact_or_eof_blit(stream, &mut len_buf)? {
        return Ok(None);
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_BLIT_FRAME {
        return Err(std::io::Error::other("blit frame too large"));
    }
    let mut payload = vec![0u8; len];
    if len > 0 && read_exact_or_eof_blit(stream, &mut payload)? {
        return Ok(None);
    }
    Ok(Some(payload))
}

fn write_blit_frame(stream: &mut BlitSocket, payload: &[u8]) -> std::io::Result<()> {
    stream.write_all(&(payload.len() as u32).to_le_bytes())?;
    stream.write_all(payload)?;
    stream.flush()
}

fn read_exact_or_eof_blit(stream: &mut BlitSocket, buf: &mut [u8]) -> std::io::Result<bool> {
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

fn compute_accept(key: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(key.trim().as_bytes());
    hasher.update(WS_GUID);
    let digest = hasher.finalize();
    B64.encode(digest)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    // Use usize for the accumulator so length differences cannot be truncated
    // (e.g. lengths differing by a multiple of 256 would look equal otherwise).
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().min(b.len()) {
        diff |= (a[i] ^ b[i]) as usize;
    }
    std::hint::black_box(diff) == 0
}

#[cfg(test)]
mod tests {
    use super::{format_install_output, parse_blit_version};

    #[test]
    fn format_install_output_splits_progress_sentences_and_carriage_returns() {
        let stdout = "downloading blit 0.33.1 for linux/x86_64... installing to /home/me/.local/bin... installed blit 0.33.1 to /home/me/.local/bin/blit\ngenerated man pages and completions in /home/me/.local/share";
        let stderr = "checking existing blit...\rdownloading blit 0.33.1 for linux/x86_64...\r\ninstalling to /home/me/.local/bin...\rinstalled blit 0.33.1 to /home/me/.local/bin/blit\r";

        assert_eq!(
            format_install_output(stdout, stderr),
            concat!(
                "checking existing blit...\n",
                "downloading blit 0.33.1 for linux/x86_64...\n",
                "installing to /home/me/.local/bin...\n",
                "installed blit 0.33.1 to /home/me/.local/bin/blit\n",
                "downloading blit 0.33.1 for linux/x86_64...\n",
                "installing to /home/me/.local/bin...\n",
                "installed blit 0.33.1 to /home/me/.local/bin/blit\n",
                "generated man pages and completions in /home/me/.local/share\n",
            ),
        );
    }

    #[test]
    fn parse_blit_version_ignores_trailing_punctuation() {
        assert_eq!(
            parse_blit_version("blit 0.33.1 already installed."),
            Some((0, 33, 1))
        );
    }
}
