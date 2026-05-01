use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use rusqlite::{OptionalExtension, params};
use rusty_v8 as v8;

use crate::host::with_host;
use crate::runtime::{install_fn, throw};
use crate::util::{now_ms, sha256_object_hash};

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
    if args.length() < 2 {
        throw(scope, "object_put requires (kind, content)");
        return;
    }
    let kind = args.get(0).to_rust_string_lossy(scope);
    let content = args.get(1).to_rust_string_lossy(scope);
    let hash = sha256_object_hash(&kind, content.as_bytes());
    let r = with_host(|h| {
        h.db.prepare_cached(
            "insert or ignore into objects(hash, kind, bytes, created_at)
             values (?1, ?2, ?3, ?4)",
        )
        .map_err(|e| e.to_string())?
        .execute(params![&hash, &kind, content.as_bytes(), now_ms()])
        .map_err(|e| e.to_string())
    });
    if let Err(e) = r {
        throw(scope, &e);
        return;
    }
    if let Some(v) = v8::String::new(scope, &hash) {
        rv.set(v.into());
    }
}

fn op_object_get(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        throw(scope, "object_get requires (hash)");
        return;
    }
    let hash = args.get(0).to_rust_string_lossy(scope);
    let row: Option<(String, Vec<u8>)> = with_host(|h| {
        let mut stmt = match h
            .db
            .prepare_cached("select kind, bytes from objects where hash = ?1")
        {
            Ok(s) => s,
            Err(_) => return None,
        };
        stmt.query_row(params![&hash], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
        })
        .optional()
        .unwrap_or(None)
    });
    match row {
        Some((kind, bytes)) => {
            let content = String::from_utf8_lossy(&bytes).to_string();
            let bytes_b64 = B64.encode(&bytes);
            let size = bytes.len() as f64;
            let obj = v8::Object::new(scope);
            if let (Some(kk), Some(kv)) = (
                v8::String::new(scope, "kind"),
                v8::String::new(scope, &kind),
            ) {
                obj.set(scope, kk.into(), kv.into());
            }
            if let (Some(ck), Some(cv)) = (
                v8::String::new(scope, "content"),
                v8::String::new(scope, &content),
            ) {
                obj.set(scope, ck.into(), cv.into());
            }
            if let (Some(bk), Some(bv)) = (
                v8::String::new(scope, "bytesBase64"),
                v8::String::new(scope, &bytes_b64),
            ) {
                obj.set(scope, bk.into(), bv.into());
            }
            if let Some(sk) = v8::String::new(scope, "size") {
                let sv = v8::Number::new(scope, size);
                obj.set(scope, sk.into(), sv.into());
            }
            rv.set(obj.into());
        }
        None => {
            rv.set(v8::null(scope).into());
        }
    }
}
