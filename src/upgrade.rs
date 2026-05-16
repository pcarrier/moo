use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(not(windows))]
const INSTALLER_URL: &str = "https://moo.pcarrier.com/install";
#[cfg(windows)]
const INSTALLER_URL: &str = "https://moo.pcarrier.com/install.ps1";

#[cfg(not(windows))]
const INSTALLER_SUFFIX: &str = "sh";
#[cfg(windows)]
const INSTALLER_SUFFIX: &str = "ps1";

const INSTALLER_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_INSTALLER_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
struct InstallLocation {
    prefix: PathBuf,
    bin_dir: PathBuf,
}

pub fn run() -> ! {
    match run_inner() {
        Ok(status) => std::process::exit(exit_code(status)),
        Err(err) => {
            eprintln!("error: {err}");
            std::process::exit(1);
        }
    }
}

fn run_inner() -> Result<ExitStatus, String> {
    let exe = env::current_exe().map_err(|e| format!("cannot find current executable: {e}"))?;
    let install = infer_install_location(&exe)?;
    let script = fetch_installer(INSTALLER_URL)?;
    let script_path = write_temp_installer(&script)?;
    let status = run_installer(&script_path, &install);
    let _ = fs::remove_file(&script_path);
    status
}

fn infer_install_location(exe: &Path) -> Result<InstallLocation, String> {
    let bin_dir = exe
        .parent()
        .ok_or_else(|| format!("cannot infer install location from {}", exe.display()))?
        .to_path_buf();
    let prefix = if path_file_name_eq(&bin_dir, "bin") {
        bin_dir
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(&bin_dir)
            .to_path_buf()
    } else {
        bin_dir.clone()
    };
    Ok(InstallLocation { prefix, bin_dir })
}

fn path_file_name_eq(path: &Path, expected: &str) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case(expected))
}

fn fetch_installer(url: &str) -> Result<String, String> {
    eprintln!("fetching {url}");
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(INSTALLER_TIMEOUT))
        .http_status_as_error(false)
        .build();
    let agent = ureq::Agent::new_with_config(config);
    let req = ureq::http::Request::builder()
        .method(ureq::http::Method::GET)
        .uri(url)
        .header("Accept", "text/plain")
        .body(String::new())
        .map_err(|e| format!("cannot build installer request: {e}"))?;
    let mut resp = agent
        .run(req)
        .map_err(|e| format!("cannot fetch installer: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("installer download failed with HTTP {status}"));
    }
    let mut bytes = Vec::new();
    resp.body_mut()
        .as_reader()
        .take(MAX_INSTALLER_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read installer: {e}"))?;
    if bytes.len() as u64 > MAX_INSTALLER_BYTES {
        return Err("installer download is unexpectedly large".to_string());
    }
    String::from_utf8(bytes).map_err(|e| format!("installer is not UTF-8: {e}"))
}

fn write_temp_installer(script: &str) -> Result<PathBuf, String> {
    let dir = env::temp_dir();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    for attempt in 0..100u32 {
        let path = dir.join(format!(
            "moo-upgrade-{}-{nonce}-{attempt}.{INSTALLER_SUFFIX}",
            std::process::id()
        ));
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("cannot create {}: {e}", path.display())),
        };
        file.write_all(script.as_bytes())
            .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        return Ok(path);
    }
    Err(format!(
        "cannot choose a temporary installer path under {}",
        dir.display()
    ))
}

fn run_installer(path: &Path, install: &InstallLocation) -> Result<ExitStatus, String> {
    eprintln!(
        "running installer for {} (bin {})",
        install.prefix.display(),
        install.bin_dir.display()
    );
    let mut cmd = installer_command(path);
    cmd.env("MOO_PREFIX", &install.prefix)
        .env("BIN_DIR", &install.bin_dir)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    cmd.status()
        .map_err(|e| format!("cannot run installer {}: {e}", path.display()))
}

#[cfg(not(windows))]
fn installer_command(path: &Path) -> Command {
    let mut cmd = Command::new("sh");
    cmd.arg(path);
    cmd
}

#[cfg(windows)]
fn installer_command(path: &Path) -> Command {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(path);
    cmd
}

fn exit_code(status: ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    1
}

#[cfg(test)]
mod tests {
    use super::{InstallLocation, infer_install_location};
    use std::path::Path;

    #[test]
    fn infers_prefix_from_bin_dir() {
        let loc = infer_install_location(Path::new("/usr/local/bin/moo")).unwrap();
        assert_eq!(
            loc,
            InstallLocation {
                prefix: Path::new("/usr/local").to_path_buf(),
                bin_dir: Path::new("/usr/local/bin").to_path_buf(),
            }
        );
    }

    #[test]
    fn uses_parent_when_not_in_bin_dir() {
        let loc = infer_install_location(Path::new("/opt/moo/moo")).unwrap();
        assert_eq!(
            loc,
            InstallLocation {
                prefix: Path::new("/opt/moo").to_path_buf(),
                bin_dir: Path::new("/opt/moo").to_path_buf(),
            }
        );
    }
}
