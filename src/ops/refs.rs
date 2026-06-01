use rusqlite::{OptionalExtension, params};
use rusty_v8 as v8;

use crate::broadcast;
use crate::host::with_db;
use crate::ops::v8util::{array_from_strings, required_args, set_return_str};
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

fn prefix_upper_bound(prefix: &str) -> Option<String> {
    let mut bytes = prefix.as_bytes().to_vec();
    for i in (0..bytes.len()).rev() {
        if bytes[i] != 0xff {
            bytes[i] += 1;
            bytes.truncate(i + 1);
            return String::from_utf8(bytes).ok();
        }
    }
    None
}

fn op_ref_set(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    if !required_args(scope, &args, 2, "ref_set requires (name, target)") {
        return;
    }
    let name = args.get(0).to_rust_string_lossy(scope);
    let target = args.get(1).to_rust_string_lossy(scope);
    let r: Result<(), String> = with_db(|conn| {
        let now = now_ms();
        let old: Option<String> = conn
            .query_row(
                "select target from refs where name = ?1",
                params![&name],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        conn.execute(
            "insert into refs(name, target, updated_at) values (?1, ?2, ?3)
             on conflict(name) do update set target = excluded.target, updated_at = excluded.updated_at",
            params![&name, &target, now],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "insert into ref_log(name, old_target, new_target, created_at)
             values (?1, ?2, ?3, ?4)",
            params![&name, &old, &target, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    });
    match r {
        Err(e) => throw(scope, &e),
        Ok(()) => broadcast::pointer_changed(&name),
    }
}

fn op_ref_get(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if !required_args(scope, &args, 1, "ref_get requires (name)") {
        return;
    }
    let name = args.get(0).to_rust_string_lossy(scope);
    let target: Result<Option<String>, String> = with_db(|conn| {
        let mut stmt = conn
            .prepare_cached("select target from refs where name = ?1")
            .map_err(|e| e.to_string())?;
        stmt.query_row(params![&name], |r| r.get::<_, String>(0))
            .optional()
            .map_err(|e| e.to_string())
    });
    match target {
        Ok(Some(t)) => set_return_str(scope, &mut rv, &t),
        Ok(None) => rv.set(v8::null(scope).into()),
        Err(e) => throw(scope, &e),
    }
}

fn op_ref_cas(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if !required_args(
        scope,
        &args,
        3,
        "ref_cas requires (name, expected|null, next)",
    ) {
        return;
    }
    let name = args.get(0).to_rust_string_lossy(scope);
    let expected = if args.get(1).is_null_or_undefined() {
        None
    } else {
        Some(args.get(1).to_rust_string_lossy(scope))
    };
    let next = args.get(2).to_rust_string_lossy(scope);

    let r: Result<bool, String> = with_db(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
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
                broadcast::pointer_changed(&name);
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
    let names: Result<Vec<String>, String> = with_db(|conn| {
        if prefix.is_empty() {
            let mut stmt = conn
                .prepare_cached("select name from refs order by name")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            return rows
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string());
        }
        if let Some(upper) = prefix_upper_bound(&prefix) {
            let mut stmt = conn
                .prepare_cached(
                    "select name from refs where name >= ?1 and name < ?2 order by name",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![&prefix, &upper], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())
        } else {
            let mut stmt = conn
                .prepare_cached("select name from refs where name >= ?1 order by name")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![&prefix], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())
        }
    });
    match names {
        Ok(names) => {
            rv.set(array_from_strings(scope, &names).into());
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
    let entries: Result<Vec<(String, String)>, String> = with_db(|conn| {
        if prefix.is_empty() {
            let mut stmt = conn
                .prepare_cached("select name, target from refs order by name")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            return rows
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string());
        }
        if let Some(upper) = prefix_upper_bound(&prefix) {
            let mut stmt = conn
                .prepare_cached(
                    "select name, target from refs where name >= ?1 and name < ?2 order by name",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![&prefix, &upper], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())
        } else {
            let mut stmt = conn
                .prepare_cached("select name, target from refs where name >= ?1 order by name")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![&prefix], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())
        }
    });
    match entries {
        Ok(entries) => match serde_json::to_string(&entries) {
            Ok(json) => {
                set_return_str(scope, &mut rv, &json);
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
    if !required_args(scope, &args, 1, "ref_delete requires (name)") {
        return;
    }
    let name = args.get(0).to_rust_string_lossy(scope);
    let r: Result<bool, String> = with_db(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
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
                broadcast::pointer_changed(&name);
            }
            rv.set(v8::Boolean::new(scope, b).into());
        }
        Err(e) => throw(scope, &e),
    }
}
