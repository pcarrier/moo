use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

const DEFAULT_NANOID_LEN: usize = 21;
const CHAT_NANOID_LEN: usize = 12;
const NANOID_ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-";
// Keep the first payload byte valid as a Turtle/SPARQL prefixed-name local
// starter because generated ids are often used as values like `chat:<id>`.
const NANOID_START_ALPHABET: &[u8] =
    b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";

static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn now_ns() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0)
}

pub fn now_ms() -> i64 {
    now_ns() / 1_000_000
}

fn fill_entropy(bytes: &mut [u8]) {
    if getrandom::fill(bytes).is_ok() {
        return;
    }

    // OS randomness should be available on supported targets. If it is not,
    // keep ids unique-ish and URL-safe rather than failing user-visible ops.
    let mut filled = 0;
    while filled < bytes.len() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let n = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut hasher = Sha256::new();
        hasher.update(nanos.to_le_bytes());
        hasher.update(n.to_le_bytes());
        hasher.update(std::process::id().to_le_bytes());
        let digest = hasher.finalize();
        let take = std::cmp::min(bytes.len() - filled, digest.len());
        bytes[filled..filled + take].copy_from_slice(&digest[..take]);
        filled += take;
    }
}

fn nanoid_payload(len: usize) -> String {
    let mut out = String::with_capacity(len);
    let mut random = [0u8; 32];

    while out.len() < len {
        fill_entropy(&mut random);
        for byte in random {
            let alphabet = if out.is_empty() {
                NANOID_START_ALPHABET
            } else {
                NANOID_ALPHABET
            };
            let mask = alphabet.len().next_power_of_two() - 1;
            let idx = (byte as usize) & mask;
            if idx >= alphabet.len() {
                continue;
            }
            out.push(alphabet[idx] as char);
            if out.len() == len {
                break;
            }
        }
    }

    out
}

pub fn random_id(prefix: &str) -> String {
    let len = match prefix {
        "chat" => CHAT_NANOID_LEN,
        _ => DEFAULT_NANOID_LEN,
    };
    format!("{}:{}", prefix, nanoid_payload(len))
}

pub fn sha256_object_hash(kind: &str, content: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(kind.as_bytes());
    hasher.update(b"\0");
    hasher.update(content);
    let bytes = hasher.finalize();
    let mut hex = String::with_capacity(7 + bytes.len() * 2);
    hex.push_str("sha256:");
    for b in bytes {
        hex.push_str(&format!("{:02x}", b));
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::random_id;

    #[test]
    fn chat_id_payload_is_nanoidish() {
        let raw = random_id("chat");
        let payload = raw.strip_prefix("chat:").expect("chat id prefix");

        assert_eq!(payload.len(), 12);
        assert!(!payload.starts_with('-'));
        assert!(
            payload
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        );
    }

    #[test]
    fn non_chat_id_payloads_keep_default_length() {
        let raw = random_id("trace");
        let payload = raw.strip_prefix("trace:").expect("trace id prefix");

        assert_eq!(payload.len(), 21);
    }

    #[test]
    fn generated_ids_do_not_collide_in_a_batch() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1_000 {
            assert!(seen.insert(random_id("chat")));
        }
    }
}
