use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn random_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let n = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}:{:016x}{:08x}", prefix, nanos, n)
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
    fn chat_id_payload_keeps_counter_entropy() {
        let raw = random_id("chat");
        let payload = raw.strip_prefix("chat:").expect("chat id prefix");

        // Chat creation stores this complete payload as the chat id. The final
        // 8 hex chars are the monotonic counter; truncating to 12 chars keeps
        // only coarse timestamp bits and can collide for parallel subagents.
        assert_eq!(payload.len(), 24);
        assert!(payload.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
