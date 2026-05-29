use glob::glob;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use rusty_v8 as v8;

use crate::ops::v8util::{
    array_from_strings, required_args, set_object_str, set_object_value, set_return_str,
};
use crate::runtime::{install_fn, throw};

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
    match fs::read(&path) {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            set_return_str(scope, &mut rv, &text);
        }
        Err(e) => throw(scope, &format!("fs_read {path}: {e}")),
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
    if let Err(e) = fs::write(&path, content.as_bytes()) {
        throw(scope, &format!("fs_write {path}: {e}"));
    }
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
