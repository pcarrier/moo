use glob::glob;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use rusty_v8 as v8;

use crate::ops::v8util::{
    array_from_strings, required_args, set_object_str, set_object_value, set_return_str,
    try_set_return_str,
};
use crate::runtime::{install_fn, throw};

/// Upper bound on the size of a file `fs_read` will load into memory. Reads of
/// regular files larger than this, and reads of non-regular files (FIFOs,
/// character/block devices, sockets) are rejected rather than allowed to
/// exhaust memory or hang the host thread.
const MAX_FILE_READ_BYTES: u64 = 256 * 1024 * 1024;
static ATOMIC_WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn install(scope: &mut v8::PinScope) -> Result<(), String> {
    install_fn(scope, "__op_fs_read", op_fs_read)?;
    install_fn(scope, "__op_fs_write", op_fs_write)?;
    install_fn(scope, "__op_fs_delete", op_fs_delete)?;
    install_fn(scope, "__op_fs_mkdir", op_fs_mkdir)?;
    install_fn(scope, "__op_fs_list", op_fs_list)?;
    install_fn(scope, "__op_fs_glob", op_fs_glob)?;
    install_fn(scope, "__op_fs_stat", op_fs_stat)?;
    install_fn(scope, "__op_fs_canonical", op_fs_canonical)?;
    Ok(())
}

fn op_fs_read(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if !required_args(scope, &args, 1, "fs_read requires (path)") {
        return;
    }
    let path = args.get(0).to_rust_string_lossy(scope);

    // Reject non-regular files (FIFOs, char/block devices, sockets) and
    // oversized regular files up front, before reading, so they error out
    // instead of hanging the host thread or exhausting memory. Use
    // symlink_metadata to avoid following into a special file via a symlink.
    let meta = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) => {
            throw(scope, &format!("fs_read {path}: {e}"));
            return;
        }
    };
    let file_type = meta.file_type();
    if !file_type.is_file() && !file_type.is_symlink() {
        throw(
            scope,
            &format!("fs_read {path}: not a regular file (refusing to read special file)"),
        );
        return;
    }

    let file = match fs::File::open(&path) {
        Ok(f) => f,
        Err(e) => {
            throw(scope, &format!("fs_read {path}: {e}"));
            return;
        }
    };
    // Re-stat the opened handle: this resolves symlinks and confirms the
    // underlying object is a regular file (guards against symlink-to-FIFO).
    match file.metadata() {
        Ok(m) if !m.file_type().is_file() => {
            throw(
                scope,
                &format!("fs_read {path}: not a regular file (refusing to read special file)"),
            );
            return;
        }
        Ok(m) if m.len() > MAX_FILE_READ_BYTES => {
            throw(
                scope,
                &format!(
                    "fs_read {path}: file too large ({} bytes, limit {MAX_FILE_READ_BYTES})",
                    m.len()
                ),
            );
            return;
        }
        Ok(_) => {}
        Err(e) => {
            throw(scope, &format!("fs_read {path}: {e}"));
            return;
        }
    }

    // Bounded read: read at most MAX_FILE_READ_BYTES + 1 so a file that grows
    // past the limit during the read is detected and rejected rather than
    // streamed without bound.
    let mut bytes = Vec::new();
    if let Err(e) = file.take(MAX_FILE_READ_BYTES + 1).read_to_end(&mut bytes) {
        throw(scope, &format!("fs_read {path}: {e}"));
        return;
    }
    if bytes.len() as u64 > MAX_FILE_READ_BYTES {
        throw(
            scope,
            &format!("fs_read {path}: file too large (exceeds limit {MAX_FILE_READ_BYTES})"),
        );
        return;
    }

    // Reject non-UTF-8/binary content instead of lossily substituting bytes,
    // which would silently corrupt the file on a read-modify-write round trip.
    let text = match String::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => {
            throw(
                scope,
                &format!("fs_read {path}: file is not valid UTF-8 (binary read not supported)"),
            );
            return;
        }
    };

    // Detect when the string is too large for V8 (exceeds its max string
    // length) and throw a clear error instead of silently returning undefined.
    if !try_set_return_str(scope, &mut rv, &text) {
        throw(
            scope,
            &format!("fs_read {path}: file too large to return as string"),
        );
    }
}

fn op_fs_write(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    if !required_args(scope, &args, 2, "fs_write requires (path, content)") {
        return;
    }
    let path = args.get(0).to_rust_string_lossy(scope);
    let content = args.get(1).to_rust_string_lossy(scope);
    if let Some(parent) = Path::new(&path).parent()
        && !parent.as_os_str().is_empty()
        && let Err(e) = fs::create_dir_all(parent)
    {
        throw(scope, &format!("fs_write mkdir {parent:?}: {e}"));
        return;
    }
    if let Err(e) = atomic_write(Path::new(&path), content.as_bytes()) {
        throw(scope, &format!("fs_write {path}: {e}"));
    }
}

/// Write `content` to `path` atomically: write to a temp file in the same
/// directory, fsync it, then rename over the target. On error (e.g. ENOSPC
/// mid-write, crash) the original file is left intact. The temp file is in the
/// same directory so the rename stays on one filesystem and is atomic.
fn atomic_write(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty());
    let dir = dir.unwrap_or_else(|| Path::new("."));

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "fs_write".to_string());
    let nonce = ATOMIC_WRITE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = dir.join(format!(
        ".{file_name}.moo-tmp-{}-{nonce}",
        std::process::id()
    ));

    // Preserve the existing file's permissions onto the temp file, since
    // rename does not carry them over from the target.
    let existing_perms = fs::metadata(path).ok().map(|m| m.permissions());

    let write_result = (|| -> std::io::Result<()> {
        let mut tmp = fs::File::create(&tmp_path)?;
        tmp.write_all(content)?;
        tmp.sync_all()?;
        if let Some(perms) = existing_perms {
            tmp.set_permissions(perms)?;
        }
        Ok(())
    })();

    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }

    if let Err(e) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }

    // Best-effort fsync of the parent directory so the rename is durable.
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }

    Ok(())
}

fn op_fs_delete(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    if !required_args(scope, &args, 1, "fs_delete requires (path)") {
        return;
    }
    let path = args.get(0).to_rust_string_lossy(scope);
    let recursive = args.get(1).boolean_value(scope);
    let meta = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) => {
            throw(scope, &format!("fs_delete {path}: {e}"));
            return;
        }
    };
    let result = if meta.is_dir() {
        if recursive {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_dir(&path)
        }
    } else {
        fs::remove_file(&path)
    };
    if let Err(e) = result {
        throw(scope, &format!("fs_delete {path}: {e}"));
    }
}

fn op_fs_mkdir(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    if !required_args(scope, &args, 1, "fs_mkdir requires (path)") {
        return;
    }
    let path = args.get(0).to_rust_string_lossy(scope);
    if let Err(e) = fs::create_dir_all(&path) {
        throw(scope, &format!("fs_mkdir {path}: {e}"));
    }
}

fn op_fs_list(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if !required_args(scope, &args, 1, "fs_list requires (path)") {
        return;
    }
    let path = args.get(0).to_rust_string_lossy(scope);
    let entries = match fs::read_dir(&path) {
        Ok(d) => d
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        Err(e) => {
            throw(scope, &format!("fs_list {path}: {e}"));
            return;
        }
    };
    rv.set(array_from_strings(scope, &entries).into());
}

fn op_fs_glob(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if !required_args(scope, &args, 1, "fs_glob requires (pattern)") {
        return;
    }
    let pattern = args.get(0).to_rust_string_lossy(scope);
    let paths = match glob(&pattern) {
        Ok(paths) => paths,
        Err(e) => {
            throw(scope, &format!("fs_glob {pattern}: {e}"));
            return;
        }
    };
    let entries = paths
        .filter_map(|entry| entry.ok())
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    rv.set(array_from_strings(scope, &entries).into());
}

fn op_fs_canonical(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if !required_args(scope, &args, 1, "fs_canonical requires (path)") {
        return;
    }
    let path = args.get(0).to_rust_string_lossy(scope);
    let canonical = match fs::canonicalize(&path) {
        Ok(p) => p,
        Err(e) => {
            throw(scope, &format!("fs_canonical {path}: {e}"));
            return;
        }
    };
    let text = canonical.to_string_lossy();
    set_return_str(scope, &mut rv, &text);
}

fn op_fs_stat(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if !required_args(scope, &args, 1, "fs_stat requires (path)") {
        return;
    }
    let path = args.get(0).to_rust_string_lossy(scope);
    let meta = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(_) => {
            rv.set(v8::null(scope).into());
            return;
        }
    };
    let kind = if meta.is_dir() {
        "dir"
    } else if meta.file_type().is_symlink() {
        "symlink"
    } else {
        "file"
    };
    let size = meta.len() as f64;
    let mtime: f64 = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);

    let obj = v8::Object::new(scope);
    set_object_str(scope, obj, "kind", kind);
    let size = v8::Number::new(scope, size);
    set_object_value(scope, obj, "size", size.into());
    let mtime = v8::Number::new(scope, mtime);
    set_object_value(scope, obj, "mtime", mtime.into());
    rv.set(obj.into());
}
