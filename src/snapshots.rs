use std::env;
use std::ffi::c_void;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use rusty_v8 as v8;
use serde::Serialize;

use crate::util::{now_ms, sha256_object_hash};

const HEAP_SNAPSHOT_KIND: &str = "v8:heapSnapshot";
const HEAP_LIMIT_GROWTH_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HeapSnapshotMetadata {
    kind: &'static str,
    hash: String,
    blob_path: String,
    metadata_path: String,
    chat_id: Option<String>,
    command: Option<String>,
    reason: String,
    detail: String,
    source: String,
    created_at: i64,
    size: usize,
}

pub fn install_failure_hooks(isolate: &mut v8::Isolate, near_heap_limit: &AtomicBool) {
    isolate.add_near_heap_limit_callback(
        near_heap_limit_callback,
        near_heap_limit as *const AtomicBool as *mut c_void,
    );
}

pub fn record_if_triggered(
    isolate: &mut v8::Isolate,
    input_json: &str,
    source: &str,
    result: &Result<String, String>,
    near_heap_limit: bool,
    unhandled_exception: bool,
) {
    let (reason, detail) =
        if near_heap_limit {
            (
                "v8:NearHeapLimit".to_string(),
                result.as_ref().err().cloned().unwrap_or_else(|| {
                    "V8 isolate reached the near-heap-limit callback".to_string()
                }),
            )
        } else if unhandled_exception {
            (
                "v8:UnhandledException".to_string(),
                result
                    .as_ref()
                    .map(|out| error_detail_from_output(out))
                    .unwrap_or_else(|err| err.clone()),
            )
        } else if let Err(err) = result {
            ("v8:UnhandledException".to_string(), err.clone())
        } else {
            return;
        };

    let _ = record_heap_snapshot(isolate, input_json, source, &reason, &detail);
}

fn record_heap_snapshot(
    isolate: &mut v8::Isolate,
    input_json: &str,
    source: &str,
    reason: &str,
    detail: &str,
) -> Result<String, String> {
    let mut bytes = Vec::new();
    isolate.take_heap_snapshot(|chunk| {
        bytes.extend_from_slice(chunk);
        true
    });
    if bytes.is_empty() {
        return Err("V8 produced an empty heap snapshot".to_string());
    }
    persist_heap_snapshot(&bytes, input_json, source, reason, detail)
}

fn persist_heap_snapshot(
    bytes: &[u8],
    input_json: &str,
    source: &str,
    reason: &str,
    detail: &str,
) -> Result<String, String> {
    let hash = sha256_object_hash(HEAP_SNAPSHOT_KIND, bytes);
    let at = now_ms();
    let size = bytes.len();
    let chat_id = input_field(input_json, "chatId").filter(|s| !s.trim().is_empty());
    let command = input_field(input_json, "command");
    write_heap_snapshot_files(
        HeapSnapshotMetadata {
            kind: HEAP_SNAPSHOT_KIND,
            hash: hash.clone(),
            blob_path: String::new(),
            metadata_path: String::new(),
            chat_id,
            command,
            reason: reason.to_string(),
            detail: detail.to_string(),
            source: source.to_string(),
            created_at: at,
            size,
        },
        bytes,
    )?;

    Ok(hash)
}

fn write_heap_snapshot_files(
    mut metadata: HeapSnapshotMetadata,
    bytes: &[u8],
) -> Result<HeapSnapshotMetadata, String> {
    let root = moo_data_dir()?.join("v8").join("snapshots");
    let blob_path = content_blob_path(&root, &metadata.hash)?;
    write_once(&blob_path, bytes)?;

    let metadata_path = metadata_file_path(&root, &metadata.hash)?;
    metadata.blob_path = blob_path.to_string_lossy().to_string();
    metadata.metadata_path = metadata_path.to_string_lossy().to_string();
    let json = serde_json::to_vec_pretty(&metadata).map_err(|e| e.to_string())?;
    write_atomic(&metadata_path, &json)?;
    Ok(metadata)
}

fn moo_data_dir() -> Result<PathBuf, String> {
    let home = env::var("HOME")
        .map_err(|_| "cannot choose V8 snapshot directory: set HOME".to_string())?;
    Ok(PathBuf::from(home).join(".local").join("share").join("moo"))
}

fn content_blob_path(root: &Path, hash: &str) -> Result<PathBuf, String> {
    let (algorithm, hex) = split_sha256_hash(hash)?;
    let prefix = hex
        .get(0..2)
        .ok_or_else(|| format!("invalid content hash: {hash}"))?;
    Ok(root.join("blobs").join(algorithm).join(prefix).join(hex))
}

fn metadata_file_path(root: &Path, hash: &str) -> Result<PathBuf, String> {
    let (algorithm, hex) = split_sha256_hash(hash)?;
    let prefix = hex
        .get(0..2)
        .ok_or_else(|| format!("invalid content hash: {hash}"))?;
    Ok(root
        .join("metadata")
        .join(algorithm)
        .join(prefix)
        .join(format!("{hex}.json")))
}

fn split_sha256_hash(hash: &str) -> Result<(&'static str, &str), String> {
    let hex = hash
        .strip_prefix("sha256:")
        .ok_or_else(|| format!("unsupported content hash: {hash}"))?;
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("invalid sha256 content hash: {hash}"));
    }
    Ok(("sha256", hex))
}

fn write_once(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    write_atomic(path, bytes)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension(format!("tmp-{}-{}", std::process::id(), now_ms()));
    fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(_) if path.exists() => {
            let _ = fs::remove_file(&tmp);
            match fs::metadata(path) {
                Ok(meta) if meta.len() == bytes.len() as u64 => Ok(()),
                Ok(_) => Err(format!(
                    "content-addressed path already exists with different size: {}",
                    path.display()
                )),
                Err(e) => Err(format!(
                    "verify existing content-addressed path {}: {e}",
                    path.display()
                )),
            }
        }
        Err(err) => {
            let _ = fs::remove_file(&tmp);
            Err(format!(
                "rename {} to {}: {err}",
                tmp.display(),
                path.display()
            ))
        }
    }
}

fn error_detail_from_output(output: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(output) else {
        return output.to_string();
    };
    value
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .map(|message| {
            value
                .get("error")
                .and_then(|e| e.get("stack"))
                .and_then(|s| s.as_str())
                .map(|stack| stack.to_string())
                .unwrap_or_else(|| message.to_string())
        })
        .unwrap_or_else(|| output.to_string())
}

fn input_field(input_json: &str, field: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(input_json).ok()?;
    match value.get(field)? {
        serde_json::Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

unsafe extern "C" fn near_heap_limit_callback(
    data: *mut c_void,
    current_heap_limit: usize,
    initial_heap_limit: usize,
) -> usize {
    if let Some(flag) = unsafe { (data as *const AtomicBool).as_ref() } {
        flag.store(true, Ordering::SeqCst);
    }
    let growth = initial_heap_limit.max(HEAP_LIMIT_GROWTH_BYTES);
    current_heap_limit
        .saturating_add(growth)
        .max(current_heap_limit + 1)
}
