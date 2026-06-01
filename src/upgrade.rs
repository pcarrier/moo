use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use minisign_verify::{PublicKey, Signature};

#[cfg(not(windows))]
const INSTALLER_URL: &str = "https://moo.pcarrier.com/install";
#[cfg(windows)]
const INSTALLER_URL: &str = "https://moo.pcarrier.com/install.ps1";

// Detached minisign signature, served alongside the installer script.
#[cfg(not(windows))]
const INSTALLER_SIG_URL: &str = "https://moo.pcarrier.com/install.minisig";
#[cfg(windows)]
const INSTALLER_SIG_URL: &str = "https://moo.pcarrier.com/install.ps1.minisig";

#[cfg(not(windows))]
const INSTALLER_SUFFIX: &str = "sh";
#[cfg(windows)]
const INSTALLER_SUFFIX: &str = "ps1";

const INSTALLER_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_INSTALLER_BYTES: u64 = 1024 * 1024;

// Compiled-in minisign (ed25519) public key used to verify the self-upgrade
// installer script. It is public and version-controlled (rotatable via PR). The
// matching secret key signs the installer in CI at site-deploy time
// (.github/workflows/pages.yml), so the script can be edited freely without
// stranding older binaries — only the rarely-changed key matters. TLS provides
// transport security; the signature is what protects against a compromised
// host/CDN or a MITM with a trusted-but-rogue CA. The file may hold a full
// minisign `.pub` (comment line + key line) or a bare base64 key.
const INSTALLER_PUBKEY: &str = include_str!("../keys/installer.pub");

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
    let bytes = fetch_installer(INSTALLER_URL)?;
    verify_installer(&bytes)?;
    let script = String::from_utf8(bytes).map_err(|e| format!("installer is not UTF-8: {e}"))?;
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

fn fetch_installer(url: &str) -> Result<Vec<u8>, String> {
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
    Ok(bytes)
}

// Verify the downloaded installer's detached minisign signature against the
// compiled-in public key before it is ever written to disk or executed. The key
// is baked into the binary at build time, so trust is independent of the TLS
// channel used to fetch the script — defending against a compromised host/CDN or
// a MITM with a trusted CA. If no usable key was compiled in, refuse to run by
// default (a release build is expected to ship one); an explicit opt-out lets
// developers run unverified builds.
fn verify_installer(bytes: &[u8]) -> Result<(), String> {
    let Some(pubkey) = compiled_pubkey() else {
        if env::var_os("MOO_UPGRADE_ALLOW_UNVERIFIED").is_some() {
            eprintln!(
                "warning: installer signature NOT verified (no installer public key compiled in; \
                 MOO_UPGRADE_ALLOW_UNVERIFIED is set)"
            );
            return Ok(());
        }
        return Err(
            "refusing to run unverified installer: this build has no compiled-in installer public key \
             (provide keys/installer.pub at build time, or MOO_UPGRADE_ALLOW_UNVERIFIED=1 to override)"
                .to_string(),
        );
    };
    let sig_bytes = fetch_installer(INSTALLER_SIG_URL)?;
    let sig_text = String::from_utf8(sig_bytes)
        .map_err(|e| format!("installer signature is not valid UTF-8: {e}"))?;
    verify_detached(&pubkey, bytes, &sig_text)
}

// Parse the compiled-in key material, tolerating either a full minisign `.pub`
// file (an "untrusted comment:" line followed by the base64 key) or a bare
// base64 key. Returns None when no line parses as a key — treated as "unpinned".
fn compiled_pubkey() -> Option<PublicKey> {
    compiled_pubkey_from(INSTALLER_PUBKEY)
}

fn compiled_pubkey_from(material: &str) -> Option<PublicKey> {
    material
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("untrusted comment"))
        .find_map(|l| PublicKey::from_base64(l).ok())
}

fn verify_detached(pubkey: &PublicKey, bytes: &[u8], sig_text: &str) -> Result<(), String> {
    let signature =
        Signature::decode(sig_text).map_err(|e| format!("malformed installer signature: {e}"))?;
    // allow_legacy = false: require a prehashed signature (modern minisign
    // default), rejecting the streamable-but-weaker legacy format.
    pubkey
        .verify(bytes, &signature, false)
        .map_err(|e| format!("installer signature verification failed: {e}"))
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
    use super::{InstallLocation, compiled_pubkey_from, infer_install_location, verify_detached};
    use minisign_verify::PublicKey;
    use std::path::Path;

    // Known-good minisign test vector (prehashed signature of b"test").
    const TEST_PUBKEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const TEST_SIG: &str = "untrusted comment: signature from minisign secret key\n\
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n\
trusted comment: timestamp:1633700835\tfile:test\tprehashed\n\
wLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==";

    #[test]
    fn verifies_valid_signature_and_rejects_tampering() {
        let pk = PublicKey::from_base64(TEST_PUBKEY).unwrap();
        assert!(verify_detached(&pk, b"test", TEST_SIG).is_ok());
        // Tampered payload must not verify.
        assert!(verify_detached(&pk, b"tesT", TEST_SIG).is_err());
        // Garbage signature text must be rejected, not panic.
        assert!(verify_detached(&pk, b"test", "not a signature").is_err());
    }

    #[test]
    fn parses_pubkey_from_full_pub_file_or_bare_key() {
        let full = format!("untrusted comment: minisign public key ABC\n{TEST_PUBKEY}\n");
        assert!(compiled_pubkey_from(&full).is_some());
        assert!(compiled_pubkey_from(TEST_PUBKEY).is_some());
        // A placeholder with no parseable key line is treated as unpinned.
        assert!(compiled_pubkey_from("untrusted comment: REPLACE ME\nnot-a-real-key").is_none());
        assert!(compiled_pubkey_from("").is_none());
    }

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
