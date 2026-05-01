use rusty_v8 as v8;

use crate::broadcast;
use crate::driver;
use crate::runtime::{install_fn, throw};
use crate::util::{now_ms, random_id};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use sha2::{Digest, Sha256};

pub fn install(scope: &mut v8::PinScope) -> Result<(), String> {
    install_fn(scope, "__op_now", op_now)?;
    install_fn(scope, "__op_id", op_id)?;
    install_fn(scope, "__op_sha256_base64url", op_sha256_base64url)?;
    install_fn(scope, "__op_broadcast", op_broadcast)?;
    install_fn(scope, "__op_chat_running_ids", op_chat_running_ids)?;
    install_fn(
        scope,
        "__op_chat_running_started_at",
        op_chat_running_started_at,
    )?;
    Ok(())
}

fn op_chat_running_ids(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let ids = driver::running_ids();
    let json = serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string());
    if let Some(v) = v8::String::new(scope, &json) {
        rv.set(v.into());
    }
}

fn op_chat_running_started_at(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let started_at = driver::running_started_at();
    let json = serde_json::to_string(&started_at).unwrap_or_else(|_| "{}".to_string());
    if let Some(v) = v8::String::new(scope, &json) {
        rv.set(v.into());
    }
}

fn op_broadcast(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        throw(scope, "broadcast requires (json)");
        return;
    }
    // No persistence — pushes a raw JSON event to all WS subscribers. Used
    // for ephemeral signals (token streams, progress) that shouldn't end up
    // in the fact store.
    let payload = args.get(0).to_rust_string_lossy(scope);
    broadcast::publish(payload);
}

fn op_now(scope: &mut v8::PinScope, _args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let v = v8::Number::new(scope, now_ms() as f64);
    rv.set(v.into());
}

fn op_id(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let prefix = if args.length() > 0 && !args.get(0).is_null_or_undefined() {
        args.get(0).to_rust_string_lossy(scope)
    } else {
        "id".to_string()
    };
    let id = random_id(&prefix);
    if let Some(v) = v8::String::new(scope, &id) {
        rv.set(v.into());
    }
}

fn op_sha256_base64url(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        throw(scope, "sha256_base64url requires (input)");
        return;
    }
    let input = args.get(0).to_rust_string_lossy(scope);
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let out = B64URL.encode(digest);
    if let Some(v) = v8::String::new(scope, &out) {
        rv.set(v.into());
    }
}
