use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, Transaction};
use rusty_v8 as v8;

use crate::broadcast;
use crate::host::with_db;
use crate::runtime::{install_fn, throw};
use crate::util::now_ms;

pub fn install(scope: &mut v8::PinScope) -> Result<(), String> {
    install_fn(scope, "__op_facts_add", op_facts_add)?;
    install_fn(scope, "__op_facts_remove", op_facts_remove)?;
    install_fn(scope, "__op_facts_match", op_facts_match)?;
    install_fn(scope, "__op_facts_match_subjects", op_facts_match_subjects)?;
    install_fn(scope, "__op_facts_match_all", op_facts_match_all)?;
    install_fn(scope, "__op_facts_present", op_facts_present)?;
    install_fn(scope, "__op_facts_history", op_facts_history)?;
    install_fn(scope, "__op_facts_refs", op_facts_refs)?;
    install_fn(
        scope,
        "__op_facts_graph_summaries",
        op_facts_graph_summaries,
    )?;
    install_fn(scope, "__op_chat_fact_summaries", op_chat_fact_summaries)?;
    install_fn(scope, "__op_facts_count", op_facts_count)?;
    install_fn(scope, "__op_facts_swap", op_facts_swap)?;
    install_fn(scope, "__op_facts_snapshot_copy", op_facts_snapshot_copy)?;
    install_fn(scope, "__op_facts_clear", op_facts_clear)?;
    install_fn(scope, "__op_facts_purge", op_facts_purge)?;
    install_fn(scope, "__op_facts_purge_graph", op_facts_purge_graph)?;
    install_fn(
        scope,
        "__op_facts_purge_subject_prefix",
        op_facts_purge_subject_prefix,
    )?;
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

fn optional_arg_str(
    scope: &mut v8::PinScope,
    args: &v8::FunctionCallbackArguments,
    i: i32,
) -> Option<String> {
    if i >= args.length() {
        return None;
    }
    let v = args.get(i);
    if v.is_null_or_undefined() {
        return None;
    }
    Some(v.to_rust_string_lossy(scope))
}

fn positive_limit_arg(
    scope: &mut v8::PinScope,
    args: &v8::FunctionCallbackArguments,
    i: i32,
) -> Option<i64> {
    if i >= args.length() || !args.get(i).is_number() {
        return None;
    }
    args.get(i)
        .to_integer(scope)
        .map(|n| n.value())
        .filter(|n| *n > 0)
}

fn is_fact_var(term: &str) -> bool {
    term.starts_with('?')
}

const FACTS_MATCH_SUBJECT_CHUNK_SIZE: usize = 250;

fn log_fact_change(
    tx: &Transaction<'_>,
    ref_name: &str,
    graph: &str,
    subject: &str,
    predicate: &str,
    object: &str,
    action: &str,
) -> Result<(), String> {
    tx.execute(
        "insert into fact_log(ref_name, graph, subject, predicate, object, action, created_by, created_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, 'system', ?7)",
        params![ref_name, graph, subject, predicate, object, action, now_ms()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[derive(Debug)]
struct MatchAllQuery {
    sql: String,
    vals: Vec<SqlValue>,
    vars: Vec<String>,
}

fn build_match_all_query(
    ref_name: &str,
    patterns: &[[String; 3]],
    graph: Option<&str>,
    limit: Option<i64>,
) -> MatchAllQuery {
    let mut vars = Vec::new();
    let mut selections = Vec::new();
    let mut first_seen: HashMap<String, (usize, &'static str)> = HashMap::new();
    let mut conditions = Vec::new();
    let mut vals = vec![SqlValue::Text(ref_name.to_string())];

    for (i, pattern) in patterns.iter().enumerate() {
        if let Some(graph) = graph {
            conditions.push(format!("q{i}.graph = ?{}", vals.len() + 1));
            vals.push(SqlValue::Text(graph.to_string()));
        }

        for (term, column) in [
            (&pattern[0], "subject"),
            (&pattern[1], "predicate"),
            (&pattern[2], "object"),
        ] {
            if is_fact_var(term) {
                if let Some((first_i, first_column)) = first_seen.get(term) {
                    conditions.push(format!("q{i}.{column} = q{first_i}.{first_column}"));
                } else {
                    first_seen.insert(term.clone(), (i, column));
                    vars.push(term.clone());
                    selections.push(format!("q{i}.{column}"));
                }
            } else {
                conditions.push(format!("q{i}.{column} = ?{}", vals.len() + 1));
                vals.push(SqlValue::Text(term.clone()));
            }
        }
    }

    let select = if selections.is_empty() {
        "1".to_string()
    } else {
        selections
            .iter()
            .enumerate()
            .map(|(i, expr)| format!("{expr} as v{i}"))
            .collect::<Vec<_>>()
            .join(", ")
    };

    let mut sql = format!("select {select} from quads q0");
    for i in 1..patterns.len() {
        sql.push_str(&format!(" join quads q{i} on q{i}.ref_name = q0.ref_name"));
    }
    sql.push_str(" where q0.ref_name = ?1");
    for condition in conditions {
        sql.push_str(" and ");
        sql.push_str(&condition);
    }

    let mut order = Vec::new();
    for i in 0..patterns.len() {
        for column in ["graph", "subject", "predicate", "object"] {
            order.push(format!("q{i}.{column}"));
        }
    }
    if !order.is_empty() {
        sql.push_str(" order by ");
        sql.push_str(&order.join(", "));
    }
    if let Some(limit) = limit {
        sql.push_str(&format!(" limit ?{}", vals.len() + 1));
        vals.push(SqlValue::Integer(limit));
    }

    MatchAllQuery { sql, vals, vars }
}

fn run_match_all_query(db: &Connection, query: &MatchAllQuery) -> Result<Vec<Vec<String>>, String> {
    let mut stmt = db.prepare_cached(&query.sql).map_err(|e| e.to_string())?;
    let iter = stmt
        .query_map(params_from_iter(query.vals.iter()), |r| {
            let mut row = Vec::with_capacity(query.vars.len());
            for i in 0..query.vars.len() {
                row.push(r.get::<_, String>(i)?);
            }
            Ok(row)
        })
        .map_err(|e| e.to_string())?;
    iter.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn op_facts_add(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    if args.length() < 5 {
        throw(scope, "facts_add requires (ref, graph, s, p, o)");
        return;
    }
    let ref_name = args.get(0).to_rust_string_lossy(scope);
    let graph = args.get(1).to_rust_string_lossy(scope);
    let s = args.get(2).to_rust_string_lossy(scope);
    let p = args.get(3).to_rust_string_lossy(scope);
    let o = args.get(4).to_rust_string_lossy(scope);
    let r: Result<usize, String> = with_db(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let n = tx
            .execute(
                "insert or ignore into quads(ref_name, graph, subject, predicate, object)
             values (?1, ?2, ?3, ?4, ?5)",
                params![&ref_name, &graph, &s, &p, &o],
            )
            .map_err(|e| e.to_string())?;
        if n > 0 {
            log_fact_change(&tx, &ref_name, &graph, &s, &p, &o, "add")?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(n)
    });
    match r {
        Err(e) => throw(scope, &e),
        Ok(_) => {
            invalidate_chat_fact_summaries_cache_for_ref(&ref_name);
            broadcast::facts_changed(&ref_name);
        }
    }
}

fn op_facts_remove(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    if args.length() < 5 {
        throw(scope, "facts_remove requires (ref, graph, s, p, o)");
        return;
    }
    let ref_name = args.get(0).to_rust_string_lossy(scope);
    let graph = args.get(1).to_rust_string_lossy(scope);
    let s = args.get(2).to_rust_string_lossy(scope);
    let p = args.get(3).to_rust_string_lossy(scope);
    let o = args.get(4).to_rust_string_lossy(scope);
    let r: Result<usize, String> = with_db(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let n = tx.execute(
            "delete from quads where ref_name = ?1 and graph = ?2 and subject = ?3 and predicate = ?4 and object = ?5",
            params![&ref_name, &graph, &s, &p, &o],
        )
        .map_err(|e| e.to_string())?;
        if n > 0 {
            log_fact_change(&tx, &ref_name, &graph, &s, &p, &o, "remove")?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(n)
    });
    match r {
        Err(e) => throw(scope, &e),
        Ok(_) => {
            invalidate_chat_fact_summaries_cache_for_ref(&ref_name);
            broadcast::facts_changed(&ref_name);
        }
    }
}

fn set_quad_rows_return(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, rows: &[[String; 4]]) {
    let arr = v8::Array::new(scope, rows.len() as i32);
    for (i, row) in rows.iter().enumerate() {
        let inner = v8::Array::new(scope, 4);
        for (j, val) in row.iter().enumerate() {
            if let Some(s) = v8::String::new(scope, val) {
                inner.set_index(scope, j as u32, s.into());
            }
        }
        arr.set_index(scope, i as u32, inner.into());
    }
    rv.set(arr.into());
}

fn op_facts_match(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        throw(scope, "facts_match requires (ref, [graph, s, p, o, limit])");
        return;
    }
    let ref_name = args.get(0).to_rust_string_lossy(scope);

    let graph = optional_arg_str(scope, &args, 1);
    let subject = optional_arg_str(scope, &args, 2);
    let predicate = optional_arg_str(scope, &args, 3);
    let object = optional_arg_str(scope, &args, 4);
    let limit = positive_limit_arg(scope, &args, 5);

    let mut sql =
        String::from("select graph, subject, predicate, object from quads where ref_name = ?1");
    let mut vals: Vec<SqlValue> = vec![SqlValue::Text(ref_name.clone())];
    if let Some(g) = &graph {
        sql.push_str(&format!(" and graph = ?{}", vals.len() + 1));
        vals.push(SqlValue::Text(g.clone()));
    }
    if let Some(s) = &subject {
        sql.push_str(&format!(" and subject = ?{}", vals.len() + 1));
        vals.push(SqlValue::Text(s.clone()));
    }
    if let Some(p) = &predicate {
        sql.push_str(&format!(" and predicate = ?{}", vals.len() + 1));
        vals.push(SqlValue::Text(p.clone()));
    }
    if let Some(o) = &object {
        sql.push_str(&format!(" and object = ?{}", vals.len() + 1));
        vals.push(SqlValue::Text(o.clone()));
    }
    sql.push_str(" order by graph, subject, predicate, object");
    if let Some(n) = limit {
        sql.push_str(&format!(" limit ?{}", vals.len() + 1));
        vals.push(SqlValue::Integer(n));
    }

    let rows: Result<Vec<[String; 4]>, String> = with_db(|conn| {
        // Dynamic SQL (variable number of bind params), so prepare_cached
        // wins more here than for fixed-shape statements.
        let mut stmt = conn.prepare_cached(&sql).map_err(|e| e.to_string())?;
        let iter = stmt
            .query_map(params_from_iter(vals.iter()), |r| {
                Ok([
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ])
            })
            .map_err(|e| e.to_string())?;
        iter.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    });

    match rows {
        Ok(rows) => set_quad_rows_return(scope, &mut rv, &rows),
        Err(e) => throw(scope, &e),
    }
}

fn op_facts_match_subjects(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 4 {
        throw(
            scope,
            "facts_match_subjects requires (ref, graph, subjectsJson, predicatesJson)",
        );
        return;
    }
    let ref_name = args.get(0).to_rust_string_lossy(scope);
    let graph = optional_arg_str(scope, &args, 1);
    let subjects_json = args.get(2).to_rust_string_lossy(scope);
    let predicates_json = args.get(3).to_rust_string_lossy(scope);
    let mut subjects: Vec<String> = match serde_json::from_str(&subjects_json) {
        Ok(v) => v,
        Err(e) => {
            throw(scope, &format!("facts_match_subjects subjects: {e}"));
            return;
        }
    };
    let mut predicates: Vec<String> = match serde_json::from_str(&predicates_json) {
        Ok(v) => v,
        Err(e) => {
            throw(scope, &format!("facts_match_subjects predicates: {e}"));
            return;
        }
    };
    subjects.sort();
    subjects.dedup();
    predicates.sort();
    predicates.dedup();
    if subjects.is_empty() || predicates.is_empty() {
        let rows: Vec<[String; 4]> = Vec::new();
        set_quad_rows_return(scope, &mut rv, &rows);
        return;
    }

    let rows: Result<Vec<[String; 4]>, String> = with_db(|conn| {
        let mut out = Vec::new();
        for subject_chunk in subjects.chunks(FACTS_MATCH_SUBJECT_CHUNK_SIZE) {
            let subject_placeholders = (0..subject_chunk.len())
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(", ");
            let predicate_placeholders = (0..predicates.len())
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(", ");
            let mut sql = String::from(
                "select graph, subject, predicate, object from quads where ref_name = ?",
            );
            let mut vals: Vec<SqlValue> = vec![SqlValue::Text(ref_name.clone())];
            if let Some(g) = &graph {
                sql.push_str(" and graph = ?");
                vals.push(SqlValue::Text(g.clone()));
            }
            sql.push_str(&format!(" and subject in ({subject_placeholders})"));
            vals.extend(subject_chunk.iter().cloned().map(SqlValue::Text));
            sql.push_str(&format!(" and predicate in ({predicate_placeholders})"));
            vals.extend(predicates.iter().cloned().map(SqlValue::Text));
            sql.push_str(" order by graph, subject, predicate, object");

            let mut stmt = conn.prepare_cached(&sql).map_err(|e| e.to_string())?;
            let iter = stmt
                .query_map(params_from_iter(vals.iter()), |r| {
                    Ok([
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ])
                })
                .map_err(|e| e.to_string())?;
            for row in iter {
                out.push(row.map_err(|e| e.to_string())?);
            }
        }
        Ok(out)
    });

    match rows {
        Ok(rows) => set_quad_rows_return(scope, &mut rv, &rows),
        Err(e) => throw(scope, &e),
    }
}

fn op_facts_match_all(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 2 {
        throw(
            scope,
            "facts_match_all requires (ref, patternsJson, [graph], [limit])",
        );
        return;
    }
    let ref_name = args.get(0).to_rust_string_lossy(scope);
    let patterns_json = args.get(1).to_rust_string_lossy(scope);
    let patterns: Vec<[String; 3]> = match serde_json::from_str(&patterns_json) {
        Ok(v) => v,
        Err(e) => {
            throw(scope, &format!("facts_match_all patterns: {e}"));
            return;
        }
    };
    let graph = optional_arg_str(scope, &args, 2);
    let limit = positive_limit_arg(scope, &args, 3);

    if patterns.is_empty() {
        let arr = v8::Array::new(scope, 1);
        let obj = v8::Object::new(scope);
        arr.set_index(scope, 0, obj.into());
        rv.set(arr.into());
        return;
    }

    let query = build_match_all_query(&ref_name, &patterns, graph.as_deref(), limit);
    let rows = with_db(|conn| run_match_all_query(conn, &query));

    match rows {
        Ok(rows) => {
            let arr = v8::Array::new(scope, rows.len() as i32);
            for (i, row) in rows.iter().enumerate() {
                let obj = v8::Object::new(scope);
                for (j, value) in row.iter().enumerate() {
                    if let (Some(k), Some(v)) = (
                        v8::String::new(scope, &query.vars[j]),
                        v8::String::new(scope, value),
                    ) {
                        obj.set(scope, k.into(), v.into());
                    }
                }
                arr.set_index(scope, i as u32, obj.into());
            }
            rv.set(arr.into());
        }
        Err(e) => throw(scope, &e),
    }
}

fn op_facts_present(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 2 {
        throw(scope, "facts_present requires (ref, quadsJson)");
        return;
    }
    let ref_name = args.get(0).to_rust_string_lossy(scope);
    let quads_json = args.get(1).to_rust_string_lossy(scope);
    let quads: Vec<[String; 4]> = match serde_json::from_str(&quads_json) {
        Ok(v) => v,
        Err(e) => {
            throw(scope, &format!("facts_present quads: {e}"));
            return;
        }
    };

    let r: Result<Vec<bool>, String> = with_db(|conn| {
        let mut stmt = conn
            .prepare_cached(
                "select exists(select 1 from quads where ref_name = ?1 and graph = ?2 and subject = ?3 and predicate = ?4 and object = ?5)",
            )
            .map_err(|e| e.to_string())?;
        let mut out = Vec::with_capacity(quads.len());
        for q in &quads {
            let present: i64 = stmt
                .query_row(params![&ref_name, &q[0], &q[1], &q[2], &q[3]], |row| {
                    row.get(0)
                })
                .map_err(|e| e.to_string())?;
            out.push(present != 0);
        }
        Ok(out)
    });

    match r {
        Err(e) => throw(scope, &e),
        Ok(values) => {
            let arr = v8::Array::new(scope, values.len() as i32);
            for (i, present) in values.iter().enumerate() {
                let value = v8::Boolean::new(scope, *present);
                arr.set_index(scope, i as u32, value.into());
            }
            rv.set(arr.into());
        }
    }
}

fn op_facts_history(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        throw(
            scope,
            "facts_history requires (ref, [graph, s, p, o, limit])",
        );
        return;
    }
    let ref_name = args.get(0).to_rust_string_lossy(scope);

    let graph = optional_arg_str(scope, &args, 1);
    let subject = optional_arg_str(scope, &args, 2);
    let predicate = optional_arg_str(scope, &args, 3);
    let object = optional_arg_str(scope, &args, 4);
    let limit = positive_limit_arg(scope, &args, 5);

    let mut sql = String::from(
        "select graph, subject, predicate, object, action, created_at from fact_log where ref_name = ?1",
    );
    let mut vals: Vec<SqlValue> = vec![SqlValue::Text(ref_name.clone())];
    if let Some(g) = &graph {
        sql.push_str(&format!(" and graph = ?{}", vals.len() + 1));
        vals.push(SqlValue::Text(g.clone()));
    }
    if let Some(s) = &subject {
        sql.push_str(&format!(" and subject = ?{}", vals.len() + 1));
        vals.push(SqlValue::Text(s.clone()));
    }
    if let Some(p) = &predicate {
        sql.push_str(&format!(" and predicate = ?{}", vals.len() + 1));
        vals.push(SqlValue::Text(p.clone()));
    }
    if let Some(o) = &object {
        sql.push_str(&format!(" and object = ?{}", vals.len() + 1));
        vals.push(SqlValue::Text(o.clone()));
    }
    sql.push_str(" order by created_at, id");
    if let Some(n) = limit {
        sql.push_str(&format!(" limit ?{}", vals.len() + 1));
        vals.push(SqlValue::Integer(n));
    }

    let rows: Result<Vec<[String; 6]>, String> = with_db(|conn| {
        let mut stmt = conn.prepare_cached(&sql).map_err(|e| e.to_string())?;
        let iter = stmt
            .query_map(params_from_iter(vals.iter()), |r| {
                Ok([
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?.to_string(),
                ])
            })
            .map_err(|e| e.to_string())?;
        iter.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    });

    match rows {
        Ok(rows) => {
            let arr = v8::Array::new(scope, rows.len() as i32);
            for (i, row) in rows.iter().enumerate() {
                let inner = v8::Array::new(scope, 6);
                for (j, val) in row.iter().enumerate() {
                    if let Some(s) = v8::String::new(scope, val) {
                        inner.set_index(scope, j as u32, s.into());
                    }
                }
                arr.set_index(scope, i as u32, inner.into());
            }
            rv.set(arr.into());
        }
        Err(e) => throw(scope, &e),
    }
}

fn op_facts_refs(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let prefix = if args.length() > 0 && !args.get(0).is_null_or_undefined() {
        Some(args.get(0).to_rust_string_lossy(scope))
    } else {
        None
    };
    let refs: Result<Vec<String>, String> = with_db(|conn| {
        let (sql, vals): (&str, Vec<SqlValue>) = if let Some(prefix) = prefix {
            if let Some(upper) = prefix_upper_bound(&prefix) {
                (
                    "select distinct ref_name from quads where ref_name >= ?1 and ref_name < ?2
                     order by ref_name",
                    vec![SqlValue::Text(prefix), SqlValue::Text(upper)],
                )
            } else {
                (
                    "select distinct ref_name from quads where ref_name >= ?1
                     order by ref_name",
                    vec![SqlValue::Text(prefix)],
                )
            }
        } else {
            (
                "select distinct ref_name from quads order by ref_name",
                Vec::new(),
            )
        };
        let mut stmt = conn.prepare_cached(sql).map_err(|e| e.to_string())?;
        let iter = stmt
            .query_map(params_from_iter(vals.iter()), |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        iter.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    });
    match refs {
        Ok(refs) => {
            let arr = v8::Array::new(scope, refs.len() as i32);
            for (i, name) in refs.iter().enumerate() {
                if let Some(s) = v8::String::new(scope, name) {
                    arr.set_index(scope, i as u32, s.into());
                }
            }
            rv.set(arr.into());
        }
        Err(e) => throw(scope, &e),
    }
}

fn op_facts_graph_summaries(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let ref_name = optional_arg_str(scope, &args, 0);
    let graph = optional_arg_str(scope, &args, 1);
    let summaries: Result<Vec<(String, i64, i64)>, String> = with_db(|conn| {
        let (sql, vals): (&str, Vec<SqlValue>) = match (&ref_name, &graph) {
            (Some(_), Some(_)) => (
                "select graph, count(*) as facts, count(distinct subject) as subjects
                   from quads
                  where ref_name = ?1 and graph = ?2
                  group by graph
                  order by graph",
                vec![SqlValue::Text(ref_name.clone().unwrap()), SqlValue::Text(graph.clone().unwrap())],
            ),
            (Some(_), None) => (
                "select graph, count(*) as facts, count(distinct subject) as subjects
                   from quads
                  where ref_name = ?1
                  group by graph
                  order by graph",
                vec![SqlValue::Text(ref_name.clone().unwrap())],
            ),
            (None, Some(_)) => (
                "select graph, count(*) as facts, count(distinct subject) as subjects
                   from (select distinct graph, subject, predicate, object from quads where graph = ?1)
                  group by graph
                  order by graph",
                vec![SqlValue::Text(graph.clone().unwrap())],
            ),
            (None, None) => (
                "select graph, count(*) as facts, count(distinct subject) as subjects
                   from (select distinct graph, subject, predicate, object from quads)
                  group by graph
                  order by graph",
                Vec::new(),
            ),
        };
        let mut stmt = conn.prepare_cached(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params_from_iter(vals.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    });
    match summaries {
        Ok(rows) => match serde_json::to_string(&rows) {
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

#[derive(Default, serde::Serialize)]
struct ChatFactSummary {
    #[serde(rename = "totalFacts")]
    total_facts: i64,
    #[serde(rename = "totalTurns")]
    total_turns: i64,
    #[serde(rename = "totalSteps")]
    total_steps: i64,
    status: String,
}

static CHAT_FACT_SUMMARIES_CACHE: LazyLock<Mutex<Option<String>>> =
    LazyLock::new(|| Mutex::new(None));

fn chat_fact_summaries_cache_lock() -> std::sync::MutexGuard<'static, Option<String>> {
    match CHAT_FACT_SUMMARIES_CACHE.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub fn clear_chat_fact_summaries_cache() {
    *chat_fact_summaries_cache_lock() = None;
}

fn invalidate_chat_fact_summaries_cache_for_ref(ref_name: &str) {
    if chat_id_from_facts_ref(ref_name).is_some() {
        *chat_fact_summaries_cache_lock() = None;
    }
}

fn invalidate_chat_fact_summaries_cache_for_refs(refs: &[String]) {
    if refs
        .iter()
        .any(|ref_name| chat_id_from_facts_ref(ref_name).is_some())
    {
        *chat_fact_summaries_cache_lock() = None;
    }
}

fn chat_id_from_facts_ref(ref_name: &str) -> Option<String> {
    ref_name
        .strip_prefix("chat/")?
        .strip_suffix("/facts")
        .map(|s| s.to_string())
}

fn load_chat_fact_summaries() -> Result<HashMap<String, ChatFactSummary>, String> {
    with_db(|conn| {
        let mut summaries: HashMap<String, ChatFactSummary> = HashMap::new();

        {
            let mut stmt = conn
                .prepare_cached(
                    "select ref_name, count(*)
                       from quads
                      where ref_name >= 'chat/' and ref_name < 'chat0' and substr(ref_name, length(ref_name) - 5) = '/facts'
                      group by ref_name",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (ref_name, count) = row.map_err(|e| e.to_string())?;
                if let Some(chat_id) = chat_id_from_facts_ref(&ref_name) {
                    let summary = summaries.entry(chat_id).or_insert_with(|| ChatFactSummary {
                        status: "agent:Done".to_string(),
                        ..Default::default()
                    });
                    summary.total_facts = count;
                }
            }
        }

        {
            let mut stmt = conn
                .prepare_cached(
                    "select ref_name, count(*)
                       from quads
                      where ref_name >= 'chat/' and ref_name < 'chat0' and substr(ref_name, length(ref_name) - 5) = '/facts'
                        and predicate = 'agent:kind'
                        and object = 'agent:UserInput'
                      group by ref_name",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (ref_name, count) = row.map_err(|e| e.to_string())?;
                if let Some(chat_id) = chat_id_from_facts_ref(&ref_name) {
                    summaries
                        .entry(chat_id)
                        .or_insert_with(|| ChatFactSummary {
                            status: "agent:Done".to_string(),
                            ..Default::default()
                        })
                        .total_turns = count;
                }
            }
        }

        {
            let mut stmt = conn
                .prepare_cached(
                    "select t.ref_name, count(*)
                       from quads t
                       join quads s on s.ref_name = t.ref_name
                                   and s.graph = t.graph
                                   and s.subject = t.subject
                                   and s.predicate = 'agent:status'
                       join quads c on c.ref_name = t.ref_name
                                   and c.graph = t.graph
                                   and c.subject = t.subject
                                   and c.predicate = 'agent:createdAt'
                      where t.ref_name >= 'chat/' and t.ref_name < 'chat0' and substr(t.ref_name, length(t.ref_name) - 5) = '/facts'
                        and t.predicate = 'rdf:type'
                        and t.object = 'agent:Step'
                      group by t.ref_name",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (ref_name, count) = row.map_err(|e| e.to_string())?;
                if let Some(chat_id) = chat_id_from_facts_ref(&ref_name) {
                    summaries
                        .entry(chat_id)
                        .or_insert_with(|| ChatFactSummary {
                            status: "agent:Done".to_string(),
                            ..Default::default()
                        })
                        .total_steps = count;
                }
            }
        }

        let mut priority_status: HashMap<String, i32> = HashMap::new();

        {
            let mut stmt = conn
                .prepare_cached(
                    "select distinct r.ref_name
                       from quads r
                       join quads s on s.ref_name = r.ref_name
                                   and s.graph = r.graph
                                   and s.subject = r.subject
                                   and s.predicate = 'ui:status'
                                   and s.object = 'ui:Pending'
                      where r.ref_name >= 'chat/' and r.ref_name < 'chat0' and substr(r.ref_name, length(r.ref_name) - 5) = '/facts'
                        and r.predicate = 'rdf:type'
                        and r.object = 'ui:InputRequest'",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            for row in rows {
                let ref_name = row.map_err(|e| e.to_string())?;
                if let Some(chat_id) = chat_id_from_facts_ref(&ref_name) {
                    summaries
                        .entry(chat_id.clone())
                        .or_insert_with(|| ChatFactSummary {
                            status: "agent:Done".to_string(),
                            ..Default::default()
                        })
                        .status = "ui:Pending".to_string();
                    priority_status.insert(chat_id, 3);
                }
            }
        }

        {
            let mut stmt = conn
                .prepare_cached(
                    "select distinct ref_name, object
                       from quads
                      where ref_name >= 'chat/' and ref_name < 'chat0' and substr(ref_name, length(ref_name) - 5) = '/facts'
                        and predicate = 'agent:status'
                        and object in ('agent:Running', 'agent:Queued')",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (ref_name, status) = row.map_err(|e| e.to_string())?;
                if let Some(chat_id) = chat_id_from_facts_ref(&ref_name) {
                    let rank = if status == "agent:Running" { 2 } else { 1 };
                    if priority_status.get(&chat_id).copied().unwrap_or(0) >= rank {
                        continue;
                    }
                    summaries
                        .entry(chat_id.clone())
                        .or_insert_with(|| ChatFactSummary {
                            status: "agent:Done".to_string(),
                            ..Default::default()
                        })
                        .status = status;
                    priority_status.insert(chat_id, rank);
                }
            }
        }

        {
            let mut stmt = conn
                .prepare_cached(
                    "select s.ref_name, s.object, c.object
                       from quads s
                       join quads t on t.ref_name = s.ref_name
                                   and t.graph = s.graph
                                   and t.subject = s.subject
                                   and t.predicate = 'rdf:type'
                                   and t.object = 'agent:Step'
                       join quads c on c.ref_name = s.ref_name
                                   and c.graph = s.graph
                                   and c.subject = s.subject
                                   and c.predicate = 'agent:createdAt'
                      where s.ref_name >= 'chat/' and s.ref_name < 'chat0' and substr(s.ref_name, length(s.ref_name) - 5) = '/facts'
                        and s.predicate = 'agent:status'
                      order by s.ref_name, cast(c.object as integer) desc",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            let mut latest_seen: HashMap<String, ()> = HashMap::new();
            for row in rows {
                let (ref_name, status) = row.map_err(|e| e.to_string())?;
                if let Some(chat_id) = chat_id_from_facts_ref(&ref_name) {
                    if priority_status.contains_key(&chat_id) || latest_seen.contains_key(&chat_id)
                    {
                        continue;
                    }
                    latest_seen.insert(chat_id.clone(), ());
                    summaries
                        .entry(chat_id)
                        .or_insert_with(|| ChatFactSummary {
                            status: "agent:Done".to_string(),
                            ..Default::default()
                        })
                        .status = status;
                }
            }
        }

        Ok(summaries)
    })
}

fn op_chat_fact_summaries(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let json: Result<String, String> = {
        let mut cache = chat_fact_summaries_cache_lock();
        if let Some(cached) = cache.clone() {
            Ok(cached)
        } else {
            match load_chat_fact_summaries()
                .and_then(|summaries| serde_json::to_string(&summaries).map_err(|e| e.to_string()))
            {
                Ok(json) => {
                    *cache = Some(json.clone());
                    Ok(json)
                }
                Err(e) => Err(e),
            }
        }
    };
    match json {
        Ok(json) => {
            if let Some(s) = v8::String::new(scope, &json) {
                rv.set(s.into());
            }
        }
        Err(e) => throw(scope, &e),
    }
}

fn op_facts_count(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        throw(scope, "facts_count requires (ref)");
        return;
    }
    let ref_name = args.get(0).to_rust_string_lossy(scope);
    let graph = optional_arg_str(scope, &args, 1);
    let subject = optional_arg_str(scope, &args, 2);
    let predicate = optional_arg_str(scope, &args, 3);
    let object = optional_arg_str(scope, &args, 4);

    let mut sql = String::from("select count(*) from quads where ref_name = ?1");
    let mut vals: Vec<SqlValue> = vec![SqlValue::Text(ref_name.clone())];
    if let Some(g) = &graph {
        sql.push_str(&format!(" and graph = ?{}", vals.len() + 1));
        vals.push(SqlValue::Text(g.clone()));
    }
    if let Some(s) = &subject {
        sql.push_str(&format!(" and subject = ?{}", vals.len() + 1));
        vals.push(SqlValue::Text(s.clone()));
    }
    if let Some(p) = &predicate {
        sql.push_str(&format!(" and predicate = ?{}", vals.len() + 1));
        vals.push(SqlValue::Text(p.clone()));
    }
    if let Some(o) = &object {
        sql.push_str(&format!(" and object = ?{}", vals.len() + 1));
        vals.push(SqlValue::Text(o.clone()));
    }

    let count: Result<i64, String> = with_db(|conn| {
        conn.prepare_cached(&sql)
            .map_err(|e| e.to_string())?
            .query_row(params_from_iter(vals.iter()), |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())
    });
    match count {
        Ok(n) => {
            let v = v8::Number::new(scope, n as f64);
            rv.set(v.into());
        }
        Err(e) => throw(scope, &e),
    }
}

fn op_facts_swap(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    if args.length() < 3 {
        throw(scope, "facts_swap requires (ref, removesJson, addsJson)");
        return;
    }
    let ref_name = args.get(0).to_rust_string_lossy(scope);
    let removes_json = args.get(1).to_rust_string_lossy(scope);
    let adds_json = args.get(2).to_rust_string_lossy(scope);

    let removes: Vec<[String; 4]> = match serde_json::from_str(&removes_json) {
        Ok(v) => v,
        Err(e) => {
            throw(scope, &format!("facts_swap removes: {e}"));
            return;
        }
    };
    let adds: Vec<[String; 4]> = match serde_json::from_str(&adds_json) {
        Ok(v) => v,
        Err(e) => {
            throw(scope, &format!("facts_swap adds: {e}"));
            return;
        }
    };

    let r: Result<(), String> = with_db(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let now = now_ms();
        {
            let mut del = tx
                .prepare_cached(
                    "delete from quads where ref_name = ?1 and graph = ?2 and subject = ?3 and predicate = ?4 and object = ?5",
                )
                .map_err(|e| e.to_string())?;
            let mut log_remove = tx
                .prepare_cached(
                    "insert into fact_log(ref_name, graph, subject, predicate, object, action, created_by, created_at)
                     values (?1, ?2, ?3, ?4, ?5, 'remove', 'system', ?6)",
                )
                .map_err(|e| e.to_string())?;
            for q in &removes {
                let n = del
                    .execute(params![&ref_name, &q[0], &q[1], &q[2], &q[3]])
                    .map_err(|e| e.to_string())?;
                if n > 0 {
                    log_remove
                        .execute(params![&ref_name, &q[0], &q[1], &q[2], &q[3], now])
                        .map_err(|e| e.to_string())?;
                }
            }
            let mut ins = tx
                .prepare_cached(
                    "insert or ignore into quads(ref_name, graph, subject, predicate, object) values (?1, ?2, ?3, ?4, ?5)",
                )
                .map_err(|e| e.to_string())?;
            let mut log_add = tx
                .prepare_cached(
                    "insert into fact_log(ref_name, graph, subject, predicate, object, action, created_by, created_at)
                     values (?1, ?2, ?3, ?4, ?5, 'add', 'system', ?6)",
                )
                .map_err(|e| e.to_string())?;
            for q in &adds {
                let n = ins
                    .execute(params![&ref_name, &q[0], &q[1], &q[2], &q[3]])
                    .map_err(|e| e.to_string())?;
                if n > 0 {
                    log_add
                        .execute(params![&ref_name, &q[0], &q[1], &q[2], &q[3], now])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    });
    match r {
        Err(e) => throw(scope, &e),
        Ok(()) => {
            invalidate_chat_fact_summaries_cache_for_ref(&ref_name);
            broadcast::facts_changed(&ref_name);
        }
    }
}

fn op_facts_snapshot_copy(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 5 {
        throw(
            scope,
            "facts_snapshot_copy requires (sourceRef, targetRef, cutoffAt, fromGraph, toGraph)",
        );
        return;
    }
    let source_ref = args.get(0).to_rust_string_lossy(scope);
    let target_ref = args.get(1).to_rust_string_lossy(scope);
    let Some(cutoff_at) = args.get(2).to_integer(scope).map(|n| n.value()) else {
        throw(scope, "facts_snapshot_copy cutoffAt must be a number");
        return;
    };
    let from_graph = args.get(3).to_rust_string_lossy(scope);
    let to_graph = args.get(4).to_rust_string_lossy(scope);

    let r: Result<usize, String> = with_db(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let now = now_ms();
        let latest_at = tx
            .query_row(
                "select max(created_at) from fact_log where ref_name = ?1",
                params![&source_ref],
                |r| r.get::<_, Option<i64>>(0),
            )
            .map_err(|e| e.to_string())?;
        let inserted = if latest_at.is_some_and(|latest_at| latest_at <= cutoff_at) {
            tx.execute(
                "insert or ignore into quads(ref_name, graph, subject, predicate, object)
                 select ?1,
                        case when graph = ?2 then ?3 else graph end,
                        subject,
                        predicate,
                        object
                 from quads
                 where ref_name = ?4",
                params![&target_ref, &from_graph, &to_graph, &source_ref],
            )
            .map_err(|e| e.to_string())?
        } else {
            tx.execute(
                "insert or ignore into quads(ref_name, graph, subject, predicate, object)
                 with latest_time as (
                   select graph, subject, predicate, object, max(created_at) as created_at
                   from fact_log
                   where ref_name = ?4 and created_at <= ?5
                   group by graph, subject, predicate, object
                 ), latest_id as (
                   select l.graph, l.subject, l.predicate, l.object, max(l.id) as id
                   from fact_log l
                   join latest_time t
                     on t.graph = l.graph
                    and t.subject = l.subject
                    and t.predicate = l.predicate
                    and t.object = l.object
                    and t.created_at = l.created_at
                   where l.ref_name = ?4
                   group by l.graph, l.subject, l.predicate, l.object
                 )
                 select ?1,
                        case when l.graph = ?2 then ?3 else l.graph end,
                        l.subject,
                        l.predicate,
                        l.object
                 from fact_log l
                 join latest_id latest on latest.id = l.id
                 where l.action in ('+', 'add', 'added')",
                params![&target_ref, &from_graph, &to_graph, &source_ref, cutoff_at],
            )
            .map_err(|e| e.to_string())?
        };
        if inserted > 0 {
            tx.execute(
                "insert into fact_log(ref_name, graph, subject, predicate, object, action, created_by, created_at)
                 select ref_name, graph, subject, predicate, object, 'add', 'system', ?2
                 from quads
                 where ref_name = ?1",
                params![&target_ref, now],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(inserted)
    });
    match r {
        Err(e) => throw(scope, &e),
        Ok(count) => {
            invalidate_chat_fact_summaries_cache_for_ref(&target_ref);
            broadcast::facts_changed(&target_ref);
            rv.set(v8::Number::new(scope, count as f64).into());
        }
    }
}

fn op_facts_purge(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        throw(scope, "facts_purge requires ref");
        return;
    }
    let ref_name = args.get(0).to_rust_string_lossy(scope);
    let r: Result<usize, String> = with_db(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let quads = tx
            .execute("delete from quads where ref_name = ?1", params![&ref_name])
            .map_err(|e| e.to_string())?;
        let log = tx
            .execute(
                "delete from fact_log where ref_name = ?1",
                params![&ref_name],
            )
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(quads + log)
    });
    match r {
        Ok(count) => {
            invalidate_chat_fact_summaries_cache_for_ref(&ref_name);
            broadcast::facts_changed(&ref_name);
            rv.set(v8::Number::new(scope, count as f64).into());
        }
        Err(e) => throw(scope, &e),
    }
}

fn op_facts_purge_graph(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        throw(scope, "facts_purge_graph requires graph");
        return;
    }
    let graph = args.get(0).to_rust_string_lossy(scope);
    let r: Result<(usize, Vec<String>), String> = with_db(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let refs = {
            let mut stmt = tx
                .prepare_cached(
                    "select ref_name from quads where graph = ?1
                     union select ref_name from fact_log where graph = ?1
                     order by ref_name",
                )
                .map_err(|e| e.to_string())?;
            let iter = stmt
                .query_map(params![&graph], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            iter.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        let quads = tx
            .execute("delete from quads where graph = ?1", params![&graph])
            .map_err(|e| e.to_string())?;
        let log = tx
            .execute("delete from fact_log where graph = ?1", params![&graph])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok((quads + log, refs))
    });
    match r {
        Ok((count, refs)) => {
            invalidate_chat_fact_summaries_cache_for_refs(&refs);
            for ref_name in refs {
                broadcast::facts_changed(&ref_name);
            }
            rv.set(v8::Number::new(scope, count as f64).into());
        }
        Err(e) => throw(scope, &e),
    }
}

fn op_facts_purge_subject_prefix(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 2 {
        throw(
            scope,
            "facts_purge_subject_prefix requires (ref, subjectPrefix, [graph])",
        );
        return;
    }
    let ref_name = args.get(0).to_rust_string_lossy(scope);
    let prefix = args.get(1).to_rust_string_lossy(scope);
    let graph = optional_arg_str(scope, &args, 2);
    let r: Result<usize, String> = with_db(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let like = format!(
            "{}%",
            prefix
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_"),
        );
        let count = if let Some(graph) = graph {
            tx.execute(
                "delete from quads where ref_name = ?1 and graph = ?2 and subject like ?3 escape '\'",
                params![&ref_name, &graph, &like],
            )
            .map_err(|e| e.to_string())?
        } else {
            tx.execute(
                "delete from quads where ref_name = ?1 and subject like ?2 escape '\'",
                params![&ref_name, &like],
            )
            .map_err(|e| e.to_string())?
        };
        tx.commit().map_err(|e| e.to_string())?;
        Ok(count)
    });
    match r {
        Ok(count) => {
            invalidate_chat_fact_summaries_cache_for_ref(&ref_name);
            broadcast::facts_changed(&ref_name);
            rv.set(v8::Number::new(scope, count as f64).into());
        }
        Err(e) => throw(scope, &e),
    }
}

fn op_facts_clear(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        throw(scope, "facts_clear requires (ref)");
        return;
    }
    let ref_name = args.get(0).to_rust_string_lossy(scope);
    let r: Result<usize, String> = with_db(|conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let now = now_ms();
        let rows = {
            let mut stmt = tx
                .prepare_cached(
                    "select graph, subject, predicate, object from quads where ref_name = ?1",
                )
                .map_err(|e| e.to_string())?;
            let iter = stmt
                .query_map(params![&ref_name], |r| {
                    Ok([
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ])
                })
                .map_err(|e| e.to_string())?;
            iter.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        {
            let mut log_remove = tx
                .prepare_cached(
                    "insert into fact_log(ref_name, graph, subject, predicate, object, action, created_by, created_at)
                     values (?1, ?2, ?3, ?4, ?5, 'remove', 'system', ?6)",
                )
                .map_err(|e| e.to_string())?;
            for q in &rows {
                log_remove
                    .execute(params![&ref_name, &q[0], &q[1], &q[2], &q[3], now])
                    .map_err(|e| e.to_string())?;
            }
        }
        let n = tx
            .execute("delete from quads where ref_name = ?1", params![&ref_name])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(n)
    });
    match r {
        Ok(count) => {
            invalidate_chat_fact_summaries_cache_for_ref(&ref_name);
            broadcast::facts_changed(&ref_name);
            rv.set(v8::Number::new(scope, count as f64).into());
        }
        Err(e) => throw(scope, &e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "create table quads (
              ref_name text not null,
              graph text not null,
              subject text not null,
              predicate text not null,
              object text not null,
              primary key(ref_name, graph, subject, predicate, object)
            ) without rowid;",
        )
        .unwrap();
        db
    }

    fn add(db: &Connection, graph: &str, subject: &str, predicate: &str, object: &str) {
        db.execute(
            "insert into quads(ref_name, graph, subject, predicate, object) values ('ref', ?1, ?2, ?3, ?4)",
            params![graph, subject, predicate, object],
        )
        .unwrap();
    }

    fn query(
        db: &Connection,
        patterns: Vec<[&str; 3]>,
        graph: Option<&str>,
        limit: Option<i64>,
    ) -> Vec<HashMap<String, String>> {
        let patterns = patterns
            .into_iter()
            .map(|[s, p, o]| [s.to_string(), p.to_string(), o.to_string()])
            .collect::<Vec<_>>();
        let q = build_match_all_query("ref", &patterns, graph, limit);
        run_match_all_query(db, &q)
            .unwrap()
            .into_iter()
            .map(|row| q.vars.iter().cloned().zip(row).collect())
            .collect()
    }

    #[test]
    fn match_all_joins_patterns_in_sql() {
        let db = db();
        add(&db, "g", "alice", "knows", "bob");
        add(&db, "g", "alice", "name", "Alice");
        add(&db, "g", "bob", "name", "Bob");
        add(&db, "other", "bob", "name", "Wrong graph");

        let rows = query(
            &db,
            vec![["?s", "knows", "?o"], ["?o", "name", "?name"]],
            Some("g"),
            None,
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["?s"], "alice");
        assert_eq!(rows[0]["?o"], "bob");
        assert_eq!(rows[0]["?name"], "Bob");
    }

    #[test]
    fn match_all_enforces_repeated_variables() {
        let db = db();
        add(&db, "g", "alice", "same", "alice");
        add(&db, "g", "alice", "same", "bob");

        let rows = query(&db, vec![["?x", "same", "?x"]], Some("g"), None);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["?x"], "alice");
    }

    #[test]
    fn match_all_limit_applies_to_joined_results() {
        let db = db();
        add(&db, "g", "a", "rdf:type", "ui:InputRequest");
        add(&db, "g", "b", "rdf:type", "ui:InputRequest");
        add(&db, "g", "b", "ui:status", "ui:Pending");

        let rows = query(
            &db,
            vec![
                ["?req", "rdf:type", "ui:InputRequest"],
                ["?req", "ui:status", "ui:Pending"],
            ],
            Some("g"),
            Some(1),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["?req"], "b");
    }
}
