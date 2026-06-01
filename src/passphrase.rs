//! Passphrase hashing and verification for the optional web-shell PSK.
//!
//! New PSKs are stored as argon2id PHC strings (salt + parameters embedded).
//! Verification transparently accepts either a PHC hash or a legacy plaintext
//! value so existing databases keep working until the PSK is set again.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::password_hash::rand_core::OsRng;
use argon2::Argon2;

/// PHC strings produced by the argon2 crate always start with this marker
/// (covers `$argon2id$`, `$argon2i$`, and `$argon2d$`).
const PHC_PREFIX: &str = "$argon2";

/// Hash `passphrase` with argon2id and a fresh random salt, returning a PHC
/// string suitable for storage.
pub fn hash(passphrase: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(passphrase.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| format!("cannot hash passphrase: {e}"))
}

/// Returns true when `stored` looks like an argon2 PHC hash rather than a
/// legacy plaintext PSK.
pub fn is_hashed(stored: &str) -> bool {
    stored.starts_with(PHC_PREFIX)
}

/// Verify a client-`provided` passphrase against the `stored` value.
///
/// Argon2 PHC hashes are verified with the embedded salt/parameters; anything
/// else is treated as legacy plaintext and compared in constant time.
pub fn verify(provided: &str, stored: &str) -> bool {
    if is_hashed(stored) {
        match PasswordHash::new(stored) {
            Ok(parsed) => Argon2::default()
                .verify_password(provided.as_bytes(), &parsed)
                .is_ok(),
            Err(_) => false,
        }
    } else {
        constant_time_eq(provided.as_bytes(), stored.as_bytes())
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    // Fold the length difference into the accumulator and always scan the
    // shorter slice instead of returning early on a length mismatch, so timing
    // does not leak the stored secret's length. Mirrors the idiom in blit.rs.
    let mut diff = (a.len() ^ b.len()) as u8;
    for i in 0..a.len().min(b.len()) {
        diff |= a[i] ^ b[i];
    }
    std::hint::black_box(diff) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_are_phc_strings_and_verify() {
        let stored = hash("hunter2").unwrap();
        assert!(is_hashed(&stored));
        assert!(stored.starts_with("$argon2id$"));
        assert!(verify("hunter2", &stored));
        assert!(!verify("hunter3", &stored));
    }

    #[test]
    fn each_hash_uses_a_fresh_salt() {
        assert_ne!(hash("same").unwrap(), hash("same").unwrap());
    }

    #[test]
    fn legacy_plaintext_still_verifies() {
        assert!(!is_hashed("moo-secret"));
        assert!(verify("moo-secret", "moo-secret"));
        assert!(!verify("moo-secret", "other"));
    }

    #[test]
    fn malformed_hash_rejects() {
        assert!(!verify("x", "$argon2id$not-a-real-hash"));
    }
}
