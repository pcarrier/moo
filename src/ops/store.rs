use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use std::collections::HashMap;

use rusqlite::params_from_iter;
use rusty_v8 as v8;

use crate::host::{get_object, put_object, with_db};
use crate::ops::v8util::{required_args, set_object_str, set_object_value, set_return_str};
use crate::runtime::{install_fn, throw};

pub fn install(scope: &mut v8::PinScope) -> Result<(), String> {
    install_fn(scope, "__op_object_put", op_object_put)?;
    install_fn(scope, "__op_object_get", op_object_get)?;
    install_fn(scope, "__op_objects_get", op_objects_get)?;
    Ok(())
}

#[derive(serde::Serialize)]
struct StoredObjectJson {
    kind: String,
    content: String,
    #[serde(rename = "bytesBase64")]
    bytes_base64: String,
    size: usize,
}

const OBJECTS_GET_CHUNK_SIZE: usize = 500;

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

fn op_objects_get(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if !required_args(scope, &args, 1, "objects_get requires (hashesJson)") {
        return;
    }
    let hashes_json = args.get(0).to_rust_string_lossy(scope);
    let mut hashes: Vec<String> = match serde_json::from_str(&hashes_json) {
        Ok(v) => v,
        Err(e) => {
            throw(scope, &format!("objects_get hashes: {e}"));
            return;
        }
    };
    hashes.sort();
    hashes.dedup();
    if hashes.is_empty() {
        set_return_str(scope, &mut rv, "{}");
        return;
    }

    let rows: Result<HashMap<String, StoredObjectJson>, String> = with_db(|conn| {
        let mut out = HashMap::new();
        for chunk in hashes.chunks(OBJECTS_GET_CHUNK_SIZE) {
            let placeholders = (0..chunk.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
            let sql =
                format!("select hash, kind, bytes from objects where hash in ({placeholders})");
            let mut stmt = conn.prepare_cached(&sql).map_err(|e| e.to_string())?;
            let iter = stmt
                .query_map(params_from_iter(chunk.iter()), |r| {
                    let hash = r.get::<_, String>(0)?;
                    let kind = r.get::<_, String>(1)?;
                    let bytes = r.get::<_, Vec<u8>>(2)?;
                    Ok((hash, kind, bytes))
                })
                .map_err(|e| e.to_string())?;
            for row in iter {
                let (hash, kind, bytes) = row.map_err(|e| e.to_string())?;
                out.insert(
                    hash,
                    StoredObjectJson {
                        kind,
                        content: String::from_utf8_lossy(&bytes).to_string(),
                        bytes_base64: B64.encode(&bytes),
                        size: bytes.len(),
                    },
                );
            }
        }
        Ok(out)
    });

    match rows {
        Ok(rows) => match serde_json::to_string(&rows) {
            Ok(json) => set_return_str(scope, &mut rv, &json),
            Err(e) => throw(scope, &e.to_string()),
        },
        Err(e) => throw(scope, &e),
    }
}
