use rusqlite::{OptionalExtension, params};
use rusty_v8 as v8;

use crate::broadcast;
use crate::host::with_host;
use crate::runtime::{install_fn, throw};
use crate::util::now_ms;

pub fn install(scope: &mut v8::PinScope) -> Result<(), String> {
    install_fn(scope, "__op_ref_set", op_ref_set)?;
    install_fn(scope, "__op_ref_get", op_ref_get)?;
    install_fn(scope, "__op_ref_cas", op_ref_cas)?;
    install_fn(scope, "__op_refs_list", op_refs_list)?;
    install_fn(scope, "__op_refs_entries", op_refs_entries)?;
    install_fn(scope, "__op_ref_delete", op_ref_delete)?;
    Ok(())
}

fn op_ref_set(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    if args.length() < 2 {
        throw(scope, "ref_set requires (name, target)");
        return;
    }
    let name = args.get(0).to_rust_string_lossy(scope);
    let target = args.get(1).to_rust_string_lossy(scope);
    let r: Result<(), String> = with_host(|h| {
        let now = now_ms();
        let old: Option<String> =
            h.db.query_row(
                "select target from refs where name = ?1",
                params![&name],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        h.db.execute(
            "insert into refs(name, target, updated_at) values (?1, ?2, ?3)
             on conflict(name) do update set target = excluded.target, updated_at = excluded.updated_at",
            params![&name, &target, now],
        )
        .map_err(|e| e.to_string())?;
        h.db.execute(
            "insert into ref_log(name, old_target, new_target, created_at)
             values (?1, ?2, ?3, ?4)",
            params![&name, &old, &target, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    });
    match r {
        Err(e) => throw(scope, &e),
        Ok(()) => broadcast::ref_changed(&name),
    }
}

fn op_ref_get(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        throw(scope, "ref_get requires (name)");
        return;
    }
    let name = args.get(0).to_rust_string_lossy(scope);
    let target: Option<String> = with_host(|h| {
        let mut stmt = match h
            .db
            .prepare_cached("select target from refs where name = ?1")
        {
            Ok(s) => s,
            Err(_) => return None,
        };
        stmt.query_row(params![&name], |r| r.get::<_, String>(0))
            .optional()
            .unwrap_or(None)
    });
    match target {
        Some(t) => {
            if let Some(v) = v8::String::new(scope, &t) {
                rv.set(v.into());
            }
        }
        None => rv.set(v8::null(scope).into()),
    }
}

fn op_ref_cas(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 3 {
        throw(scope, "ref_cas requires (name, expected|null, next)");
        return;
    }
    let name = args.get(0).to_rust_string_lossy(scope);
    let expected = if args.get(1).is_null_or_undefined() {
        None
    } else {
        Some(args.get(1).to_rust_string_lossy(scope))
    };
    let next = args.get(2).to_rust_string_lossy(scope);

    let r: Result<bool, String> = with_host(|h| {
        let tx = h.db.transaction().map_err(|e| e.to_string())?;
        let current: Option<String> = tx
            .query_row(
                "select target from refs where name = ?1",
                params![&name],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if current != expected {
            return Ok(false);
        }
        let now = now_ms();
        tx.execute(
            "insert into refs(name, target, updated_at) values (?1, ?2, ?3)
             on conflict(name) do update set target = excluded.target, updated_at = excluded.updated_at",
            params![&name, &next, now],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "insert into ref_log(name, old_target, new_target, created_at) values (?1, ?2, ?3, ?4)",
            params![&name, &current, &next, now],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(true)
    });

    match r {
        Ok(b) => {
            if b {
                broadcast::ref_changed(&name);
            }
            rv.set(v8::Boolean::new(scope, b).into());
        }
        Err(e) => throw(scope, &e),
    }
}

fn op_refs_list(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let prefix = if args.length() > 0 && !args.get(0).is_null_or_undefined() {
        args.get(0).to_rust_string_lossy(scope)
    } else {
        String::new()
    };
    let names: Result<Vec<String>, String> = with_host(|h| {
        let pattern = format!("{}%", prefix.replace('%', "\\%").replace('_', "\\_"));
        let mut stmt = h
            .db
            .prepare_cached("select name from refs where name like ?1 escape '\\' order by name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![&pattern], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    });
    match names {
        Ok(names) => {
            let arr = v8::Array::new(scope, names.len() as i32);
            for (i, n) in names.iter().enumerate() {
                if let Some(s) = v8::String::new(scope, n) {
                    arr.set_index(scope, i as u32, s.into());
                }
            }
            rv.set(arr.into());
        }
        Err(e) => throw(scope, &e),
    }
}

fn op_refs_entries(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let prefix = if args.length() > 0 && !args.get(0).is_null_or_undefined() {
        args.get(0).to_rust_string_lossy(scope)
    } else {
        String::new()
    };
    let entries: Result<Vec<(String, String)>, String> = with_host(|h| {
        let pattern = format!("{}%", prefix.replace('%', "\\%").replace('_', "\\_"));
        let mut stmt =
            h.db.prepare_cached(
                "select name, target from refs where name like ?1 escape '\\' order by name",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![&pattern], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    });
    match entries {
        Ok(entries) => match serde_json::to_string(&entries) {
            Ok(json) => {
                if let Some(s) = v8::String::new(scope, &json) {
                    rv.set(s.into());
                }
            }
            Err(e) => throw(scope, &e.to_string()),
        },
        Err(e) => throw(scope, &e),
    }
}

fn op_ref_delete(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        throw(scope, "ref_delete requires (name)");
        return;
    }
    let name = args.get(0).to_rust_string_lossy(scope);
    let r: Result<bool, String> = with_host(|h| {
        let tx = h.db.transaction().map_err(|e| e.to_string())?;
        let old: Option<String> = tx
            .query_row(
                "select target from refs where name = ?1",
                params![&name],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let n = tx
            .execute("delete from refs where name = ?1", params![&name])
            .map_err(|e| e.to_string())?;
        if n > 0 {
            tx.execute(
                "insert into ref_log(name, old_target, new_target, created_at) values (?1, ?2, NULL, ?3)",
                params![&name, &old, now_ms()],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(n > 0)
    });
    match r {
        Ok(b) => {
            if b {
                broadcast::ref_changed(&name);
            }
            rv.set(v8::Boolean::new(scope, b).into());
        }
        Err(e) => throw(scope, &e),
    }
}
