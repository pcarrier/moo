use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::params;
use rusty_v8 as v8;

use crate::broadcast;
use crate::host::with_host;
use crate::util::{now_ms, sha256_object_hash};

const HEAP_SNAPSHOT_KIND: &str = "v8:heapSnapshot";
const HEAP_LIMIT_GROWTH_BYTES: usize = 128 * 1024 * 1024;

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
    let target = fact_target(input_json);
    let subject = format!("v8:snapshot/{}", hash.replace(':', "_"));
    let at = now_ms();
    let size = bytes.len().to_string();
    let command = input_field(input_json, "command");

    with_host(|h| -> Result<(), String> {
        let tx = h.db.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "insert or ignore into objects(hash, kind, bytes, created_at)
             values (?1, ?2, ?3, ?4)",
            params![&hash, HEAP_SNAPSHOT_KIND, bytes, at],
        )
        .map_err(|e| e.to_string())?;

        let mut facts = vec![
            ("rdf:type", "v8:HeapSnapshot".to_string()),
            ("v8:object", hash.clone()),
            ("v8:reason", reason.to_string()),
            ("v8:detail", detail.to_string()),
            ("v8:source", source.to_string()),
            ("v8:createdAt", at.to_string()),
            ("v8:size", size),
        ];
        if let Some(chat_id) = &target.chat_id {
            facts.push(("v8:chat", format!("chat:{chat_id}")));
        }
        if let Some(command) = command {
            facts.push(("v8:command", command));
        }

        for (predicate, object) in facts {
            let inserted = tx
                .execute(
                    "insert or ignore into quads(ref_name, graph, subject, predicate, object)
                     values (?1, ?2, ?3, ?4, ?5)",
                    params![
                        &target.ref_name,
                        &target.graph,
                        &subject,
                        predicate,
                        &object
                    ],
                )
                .map_err(|e| e.to_string())?;
            if inserted > 0 {
                tx.execute(
                    "insert into fact_log(ref_name, graph, subject, predicate, object, action, created_by, created_at)
                     values (?1, ?2, ?3, ?4, ?5, 'add', 'system', ?6)",
                    params![&target.ref_name, &target.graph, &subject, predicate, &object, at],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })?;

    broadcast::facts_changed(&target.ref_name);
    Ok(hash)
}

struct FactTarget {
    ref_name: String,
    graph: String,
    chat_id: Option<String>,
}

fn fact_target(input_json: &str) -> FactTarget {
    let chat_id = input_field(input_json, "chatId").filter(|s| !s.trim().is_empty());
    if let Some(chat_id) = chat_id {
        FactTarget {
            ref_name: format!("chat/{chat_id}/facts"),
            graph: format!("chat:{chat_id}"),
            chat_id: Some(chat_id),
        }
    } else {
        FactTarget {
            ref_name: "memory/facts".to_string(),
            graph: "memory:facts".to_string(),
            chat_id: None,
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
