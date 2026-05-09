use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use rusty_v8 as v8;

use crate::host::{get_object, put_object};
use crate::ops::v8util::{required_args, set_object_str, set_object_value, set_return_str};
use crate::runtime::{install_fn, throw};

pub fn install(scope: &mut v8::PinScope) -> Result<(), String> {
    install_fn(scope, "__op_object_put", op_object_put)?;
    install_fn(scope, "__op_object_get", op_object_get)?;
    Ok(())
}

fn op_object_put(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if !required_args(scope, &args, 2, "object_put requires (kind, content)") {
        return;
    }
    let kind = args.get(0).to_rust_string_lossy(scope);
    let content = args.get(1).to_rust_string_lossy(scope);
    let hash = match put_object(&kind, content.as_bytes()) {
        Ok(hash) => hash,
        Err(e) => {
            throw(scope, &e);
            return;
        }
    };
    set_return_str(scope, &mut rv, &hash);
}

fn op_object_get(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if !required_args(scope, &args, 1, "object_get requires (hash)") {
        return;
    }
    let hash = args.get(0).to_rust_string_lossy(scope);
    let row: Option<(String, Vec<u8>)> = get_object(&hash).unwrap_or(None);
    match row {
        Some((kind, bytes)) => {
            let content = String::from_utf8_lossy(&bytes).to_string();
            let bytes_b64 = B64.encode(&bytes);
            let size = bytes.len() as f64;
            let obj = v8::Object::new(scope);
            set_object_str(scope, obj, "kind", &kind);
            set_object_str(scope, obj, "content", &content);
            set_object_str(scope, obj, "bytesBase64", &bytes_b64);
            let sv = v8::Number::new(scope, size);
            set_object_value(scope, obj, "size", sv.into());
            rv.set(obj.into());
        }
        None => {
            rv.set(v8::null(scope).into());
        }
    }
}
