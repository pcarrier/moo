use std::cell::RefCell;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::OptionalExtension;
use rusqlite::{Connection, TransactionBehavior, params};

const DB_BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(30_000);

const SCHEMA_SQL: &str = r#"
create table if not exists objects (
  hash text primary key,
  kind text not null,
  bytes blob not null,
  created_at integer not null
);
create table if not exists refs (
  name text primary key,
  target text not null,
  updated_at integer not null
);
create table if not exists ref_log (
  id integer primary key autoincrement,
  name text not null,
  old_target text,
  new_target text,
  created_at integer not null
);
create table if not exists quads (
  ref_name text not null,
  graph text not null,
  subject text not null,
  predicate text not null,
  object text not null,
  created_by text not null default 'system',
  primary key(ref_name, graph, subject, predicate, object)
) without rowid;
create index if not exists quads_by_spo on quads(ref_name, subject, predicate, object);
create index if not exists quads_by_pos on quads(ref_name, predicate, object, subject);
create index if not exists quads_by_gpo on quads(ref_name, graph, predicate, object, subject);
create index if not exists quads_by_ops on quads(ref_name, object, predicate, subject);
create index if not exists quads_by_gsp on quads(ref_name, graph, subject, predicate, object);
create table if not exists fact_log (
  id integer primary key autoincrement,
  ref_name text not null,
  graph text not null,
  subject text not null,
  predicate text not null,
  object text not null,
  action text not null,
  created_by text not null default 'system',
  created_at integer not null
);
create index if not exists fact_log_by_ref_gspo_time
  on fact_log(ref_name, graph, subject, predicate, object, created_at, id);
create index if not exists fact_log_by_ref_time
  on fact_log(ref_name, created_at, id);
create table if not exists settings (
  key text primary key,
  value text not null,
  updated_at integer not null
);
create table if not exists traces (
  id text primary key,
  parent_id text null references traces(id),
  chat_id text null,
  run_id text null,
  kind text not null,
  name text not null,
  depth integer not null,
  seq integer not null,
  status text not null,
  started_ms integer not null,
  ended_ms integer null,
  input_hash text null,
  output_hash text null,
  error_hash text null,
  invoked_from_step_id text null,
  data_json text null
);
create index if not exists traces_by_parent_seq on traces(parent_id, seq);
create index if not exists traces_by_chat_time on traces(chat_id, started_ms);
create index if not exists traces_roots_time on traces(started_ms desc) where parent_id is null;
create index if not exists traces_by_run_time on traces(run_id, started_ms);
create index if not exists traces_errors on traces(started_ms desc) where status = 'error';
create index if not exists traces_by_invoker on traces(invoked_from_step_id) where invoked_from_step_id is not null;
create table if not exists trace_events (
  id integer primary key autoincrement,
  span_id text not null references traces(id),
  ts_ms integer not null,
  level text not null,
  message text not null,
  data_hash text null
);
create index if not exists trace_events_by_span on trace_events(span_id, ts_ms);
"#;

pub struct HostState {
    pub db: Connection,
}

thread_local! {
    static HOST: RefCell<Option<HostState>> = const { RefCell::new(None) };
}

static DB_INIT_LOCK: Mutex<()> = Mutex::new(());

pub fn with_host<R>(f: impl FnOnce(&mut HostState) -> R) -> R {
    HOST.with(|h| {
        let mut borrow = h.borrow_mut();
        let host = borrow.as_mut().expect("host not initialized");
        f(host)
    })
}

pub fn install(db_path: &str) -> Result<(), String> {
    let conn = open_db(db_path)?;
    HOST.with(|h| {
        *h.borrow_mut() = Some(HostState { db: conn });
    });
    Ok(())
}

#[cfg(test)]
pub fn drop_host() {
    HOST.with(|h| {
        h.borrow_mut().take();
    });
}

pub fn open_db(path: &str) -> Result<Connection, String> {
    let _init_guard = DB_INIT_LOCK.lock().map_err(|e| e.to_string())?;
    open_db_inner(path)
}

fn open_db_inner(path: &str) -> Result<Connection, String> {
    if let Some(parent) = PathBuf::from(path).parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.busy_timeout(DB_BUSY_TIMEOUT)
        .map_err(|e| e.to_string())?;
    // Default to IMMEDIATE so concurrent writers wait on busy_timeout instead
    // of failing fast: under WAL, a DEFERRED txn that upgrades from read to
    // write while another connection holds the writer returns SQLITE_BUSY
    // without invoking the busy handler ("database is locked").
    conn.set_transaction_behavior(TransactionBehavior::Immediate);
    conn.execute_batch(
        "pragma journal_mode=WAL; pragma synchronous=NORMAL; pragma temp_store=MEMORY;",
    )
    .map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA_SQL).map_err(|e| e.to_string())?;
    let has_created_by = conn
        .prepare("pragma table_info(quads)")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .iter()
        .any(|c| c == "created_by");
    if !has_created_by {
        conn.execute(
            "alter table quads add column created_by text not null default 'system'",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    let schema_version: i64 = conn
        .query_row("pragma user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if schema_version < 2 {
        conn.execute_batch(
            r#"
            drop table if exists trace_events;
            drop table if exists traces;
            create table traces (
              id text primary key,
              parent_id text null references traces(id),
              chat_id text null,
              run_id text null,
              kind text not null,
              name text not null,
              depth integer not null,
              seq integer not null,
              status text not null,
              started_ms integer not null,
              ended_ms integer null,
              input_hash text null,
              output_hash text null,
              error_hash text null,
              invoked_from_step_id text null,
              data_json text null
            );
            create index traces_by_parent_seq on traces(parent_id, seq);
            create index traces_by_chat_time on traces(chat_id, started_ms);
            create index traces_roots_time on traces(started_ms desc) where parent_id is null;
            create index traces_by_run_time on traces(run_id, started_ms);
            create index traces_errors on traces(started_ms desc) where status = 'error';
            create index traces_by_invoker on traces(invoked_from_step_id) where invoked_from_step_id is not null;
            create table trace_events (
              id integer primary key autoincrement,
              span_id text not null references traces(id),
              ts_ms integer not null,
              level text not null,
              message text not null,
              data_hash text null
            );
            create index trace_events_by_span on trace_events(span_id, ts_ms);
            pragma user_version = 2;
            "#,
        )
        .map_err(|e| e.to_string())?;
    }
    backfill_trace_step_roots(&conn)?;
    migrate_chat_model_effort_to_chat_facts(&conn)?;
    Ok(conn)
}

fn backfill_trace_step_roots(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        -- Historical trace rows were sometimes parented directly to chat step
        -- ids. Materialize those missing step parents first so the trace tree
        -- can become strict without losing chat/run metadata.
        insert or ignore into traces(
          id, parent_id, chat_id, run_id, kind, name, depth, seq, status, started_ms,
          ended_ms, input_hash, output_hash, error_hash, invoked_from_step_id, data_json
        )
        with step_rows as (
          select
            step.subject as step_id,
            substr(step.graph, 6) as chat_id,
            coalesce(run.object, min(child.run_id)) as run_id,
            coalesce(kind.object, 'agent:Step') as kind_name,
            coalesce(cast(created.object as integer), min(child.started_ms)) as started_ms,
            payload.object as input_hash,
            row_number() over (
              partition by step.graph
              order by coalesce(cast(created.object as integer), min(child.started_ms)), step.subject
            ) - 1 as seq
          from quads step
          join traces child
            on child.parent_id = step.subject
          left join quads kind
            on kind.ref_name = step.ref_name
           and kind.graph = step.graph
           and kind.subject = step.subject
           and kind.predicate = 'agent:kind'
          left join quads created
            on created.ref_name = step.ref_name
           and created.graph = step.graph
           and created.subject = step.subject
           and created.predicate = 'agent:createdAt'
          left join quads run
            on run.ref_name = step.ref_name
           and run.graph = step.graph
           and run.subject = step.subject
           and run.predicate = 'agent:run'
          left join quads payload
            on payload.ref_name = step.ref_name
           and payload.graph = step.graph
           and payload.subject = step.subject
           and payload.predicate = 'agent:payload'
          where step.predicate = 'rdf:type'
            and step.object = 'agent:Step'
            and step.ref_name like 'chat/%/facts'
            and step.graph like 'chat:%'
            and not exists (select 1 from traces existing where existing.id = step.subject)
          group by step.ref_name, step.graph, step.subject
        )
        select step_id, null, chat_id, run_id, 'step', kind_name, 0, seq, 'ok',
               started_ms, started_ms, input_hash, null, null, step_id, null
        from step_rows
        where started_ms is not null;

        -- Any remaining orphaned parent ids may not have chat-step facts (for
        -- example old ad-hoc system roots). Backfill them with the same neutral
        -- root shape that trace_open_conn used to create lazily.
        insert or ignore into traces(
          id, parent_id, chat_id, run_id, kind, name, depth, seq, status, started_ms,
          ended_ms, input_hash, output_hash, error_hash, invoked_from_step_id, data_json
        )
        with missing_parents as (
          select
            child.parent_id as parent_id,
            min(child.chat_id) as chat_id,
            min(child.run_id) as run_id,
            min(child.started_ms) as started_ms,
            row_number() over (order by min(child.started_ms), child.parent_id) - 1
              + (select coalesce(max(seq), -1) + 1 from traces where parent_id is null) as seq
          from traces child
          where child.parent_id is not null
            and not exists (select 1 from traces parent where parent.id = child.parent_id)
          group by child.parent_id
        )
        select parent_id, null, chat_id, run_id, 'system', parent_id, 0, seq, 'ok',
               started_ms, started_ms, null, null, null, null, null
        from missing_parents
        where started_ms is not null;
        "#,
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn migrate_chat_model_effort_to_chat_facts(conn: &Connection) -> Result<(), String> {
    let now = crate::util::now_ms();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let legacy_refs = {
        let mut stmt = tx
            .prepare(
                "select name, target from refs
                 where name like 'chat/%/model'",
            )
            .map_err(|e| e.to_string())?;
        stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
    };

    for (name, target) in legacy_refs {
        let parts: Vec<&str> = name.split('/').collect();
        if parts.len() != 3 || parts[0] != "chat" {
            continue;
        }
        let chat_id = parts[1];
        if parts[2] != "model" {
            continue;
        }
        let value = target.trim();
        if !value.is_empty() {
            insert_chat_setting_quad(&tx, chat_id, "ui:model", value, now)?;
        }
        tx.execute("delete from refs where name = ?1", params![name])
            .map_err(|e| e.to_string())?;
    }

    let legacy_efforts = {
        let mut stmt = tx
            .prepare(
                "select ref_name, graph, subject, object from quads
                 where ref_name = 'memory/facts'
                   and graph = 'memory:facts'
                   and predicate = 'ui:effortLevel'
                   and subject like 'chat:%'",
            )
            .map_err(|e| e.to_string())?;
        stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
    };

    for (ref_name, graph, subject, object) in legacy_efforts {
        if let Some(chat_id) = subject.strip_prefix("chat:") {
            let effort = object.trim().trim_matches('"');
            if !effort.is_empty() {
                insert_chat_setting_quad(&tx, chat_id, "ui:effortLevel", effort, now)?;
            }
        }
        tx.execute(
            "delete from quads where ref_name = ?1 and graph = ?2 and subject = ?3 and predicate = 'ui:effortLevel' and object = ?4",
            params![ref_name, graph, subject, object],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())
}

fn insert_chat_setting_quad(
    conn: &Connection,
    chat_id: &str,
    predicate: &str,
    object: &str,
    now: i64,
) -> Result<(), String> {
    let ref_name = format!("chat/{}/facts", chat_id);
    let graph = format!("chat:{}", chat_id);
    let subject = graph.clone();
    conn.execute(
        "delete from quads where ref_name = ?1 and graph = ?2 and subject = ?3 and predicate = ?4",
        params![&ref_name, &graph, &subject, predicate],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "insert or ignore into quads(ref_name, graph, subject, predicate, object, created_by)
         values (?1, ?2, ?3, ?4, ?5, 'system')",
        params![&ref_name, &graph, &subject, predicate, object],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "insert into fact_log(ref_name, graph, subject, predicate, object, action, created_by, created_at)
         values (?1, ?2, ?3, ?4, ?5, 'add', 'system', ?6)",
        params![&ref_name, &graph, &subject, predicate, object, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::Barrier;
    use std::thread;

    // Two connections opened via open_db run read-then-write transactions
    // against the same row in parallel. With WAL + DEFERRED begin (the
    // rusqlite default) the second connection's upgrade from reader to
    // writer returns SQLITE_BUSY immediately, bypassing busy_timeout. With
    // IMMEDIATE begin the busy handler waits, so neither thread sees
    // "database is locked".
    #[test]
    fn concurrent_writers_do_not_report_database_is_locked() {
        let dir = std::env::temp_dir().join(format!(
            "moo-host-concurrent-{}-{}",
            std::process::id(),
            crate::util::now_ms(),
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("store.sqlite");
        let path_str = path.to_str().unwrap().to_string();

        {
            let seed = open_db(&path_str).unwrap();
            seed.execute(
                "insert into refs(name, target, updated_at) values ('k', 'v0', 0)",
                [],
            )
            .unwrap();
        }

        const ITER: usize = 50;
        let barrier = Arc::new(Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|tid| {
                let path_str = path_str.clone();
                let barrier = barrier.clone();
                thread::spawn(move || -> Result<(), String> {
                    let mut conn = open_db(&path_str).map_err(|e| format!("open: {e}"))?;
                    barrier.wait();
                    for i in 0..ITER {
                        let tx = conn.transaction().map_err(|e| e.to_string())?;
                        let cur: String = tx
                            .query_row("select target from refs where name = 'k'", [], |r| r.get(0))
                            .map_err(|e| e.to_string())?;
                        let next = format!("{cur}-t{tid}-i{i}");
                        tx.execute(
                            "update refs set target = ?1, updated_at = ?2 where name = 'k'",
                            rusqlite::params![&next, i as i64],
                        )
                        .map_err(|e| e.to_string())?;
                        tx.commit().map_err(|e| e.to_string())?;
                    }
                    Ok(())
                })
            })
            .collect();

        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let _ = std::fs::remove_dir_all(&dir);
        for (i, r) in results.iter().enumerate() {
            let msg = r.as_ref().err().cloned().unwrap_or_default();
            assert!(!msg.contains("database is locked"), "thread {i}: {msg}");
            assert!(r.is_ok(), "thread {i} reported: {msg}");
        }
    }

    #[test]
    fn backfills_runjs_step_trace_roots() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        conn.execute_batch("pragma foreign_keys = off;").unwrap();
        conn.execute(
            "insert into quads(ref_name, graph, subject, predicate, object) values
             ('chat/c1/facts', 'chat:c1', 'run1', 'rdf:type', 'agent:Run'),
             ('chat/c1/facts', 'chat:c1', 'step1', 'rdf:type', 'agent:Step'),
             ('chat/c1/facts', 'chat:c1', 'step1', 'agent:kind', 'agent:RunJS'),
             ('chat/c1/facts', 'chat:c1', 'step1', 'agent:run', 'run1'),
             ('chat/c1/facts', 'chat:c1', 'step1', 'agent:createdAt', '1234'),
             ('chat/c1/facts', 'chat:c1', 'step1', 'agent:payload', 'sha256:payload')",
            [],
        )
        .unwrap();
        conn.execute(
            "insert into traces(
               id, parent_id, chat_id, run_id, kind, name, depth, seq, status, started_ms,
               ended_ms, input_hash, output_hash, error_hash, invoked_from_step_id, data_json
             ) values('trace-child', 'step1', null, null, 'runjs', 'runjs.execute', 1, 0,
                      'ok', 1235, 1236, null, null, null, null, null)",
            [],
        )
        .unwrap();

        backfill_trace_step_roots(&conn).unwrap();

        let root = trace_get_conn(&conn, "step1").unwrap().unwrap();
        assert_eq!(root.parent_id.as_deref(), None);
        assert_eq!(root.chat_id.as_deref(), Some("c1"));
        assert_eq!(root.run_id.as_deref(), Some("run1"));
        assert_eq!(root.kind, "step");
        assert_eq!(root.name, "agent:RunJS");
        assert_eq!(root.depth, 0);
        assert_eq!(root.seq, 0);
        assert_eq!(root.status, "ok");
        assert_eq!(root.started_ms, 1234);
        assert_eq!(root.ended_ms, Some(1234));
        assert_eq!(root.input_hash.as_deref(), Some("sha256:payload"));
        assert_eq!(root.invoked_from_step_id.as_deref(), Some("step1"));
    }

    #[test]
    fn backfills_non_runjs_and_generic_trace_roots() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        conn.execute_batch("pragma foreign_keys = off;").unwrap();
        conn.execute(
            "insert into quads(ref_name, graph, subject, predicate, object) values
             ('chat/c1/facts', 'chat:c1', 'step2', 'rdf:type', 'agent:Step'),
             ('chat/c1/facts', 'chat:c1', 'step2', 'agent:kind', 'agent:UserInput'),
             ('chat/c1/facts', 'chat:c1', 'step2', 'agent:createdAt', '2000')",
            [],
        )
        .unwrap();
        conn.execute(
            "insert into traces(
               id, parent_id, chat_id, run_id, kind, name, depth, seq, status, started_ms,
               ended_ms, input_hash, output_hash, error_hash, invoked_from_step_id, data_json
             ) values('trace-child', 'step2', null, 'run2', 'tool', 'tool.call', 1, 0,
                      'ok', 2005, 2006, null, null, null, null, null)",
            [],
        )
        .unwrap();
        conn.execute(
            "insert into traces(
               id, parent_id, chat_id, run_id, kind, name, depth, seq, status, started_ms,
               ended_ms, input_hash, output_hash, error_hash, invoked_from_step_id, data_json
             ) values('legacy-child', 'system:legacy-root', 'c2', 'run3', 'proc', 'cargo test', 1, 0,
                      'ok', 3005, 3006, null, null, null, null, null)",
            [],
        )
        .unwrap();

        backfill_trace_step_roots(&conn).unwrap();

        let step_root = trace_get_conn(&conn, "step2").unwrap().unwrap();
        assert_eq!(step_root.parent_id.as_deref(), None);
        assert_eq!(step_root.chat_id.as_deref(), Some("c1"));
        assert_eq!(step_root.run_id.as_deref(), Some("run2"));
        assert_eq!(step_root.kind, "step");
        assert_eq!(step_root.name, "agent:UserInput");
        assert_eq!(step_root.depth, 0);
        assert_eq!(step_root.status, "ok");
        assert_eq!(step_root.started_ms, 2000);
        assert_eq!(step_root.ended_ms, Some(2000));
        assert_eq!(step_root.invoked_from_step_id.as_deref(), Some("step2"));

        let generic_root = trace_get_conn(&conn, "system:legacy-root")
            .unwrap()
            .unwrap();
        assert_eq!(generic_root.parent_id.as_deref(), None);
        assert_eq!(generic_root.chat_id.as_deref(), Some("c2"));
        assert_eq!(generic_root.run_id.as_deref(), Some("run3"));
        assert_eq!(generic_root.kind, "system");
        assert_eq!(generic_root.name, "system:legacy-root");
        assert_eq!(generic_root.depth, 0);
        assert_eq!(generic_root.status, "ok");
        assert_eq!(generic_root.started_ms, 3005);
        assert_eq!(generic_root.ended_ms, Some(3005));
    }
}

/// Helpers for the parent-linked trace tree shared by the harness and Rust runtime.
#[derive(Debug, Clone)]
pub struct TraceRow {
    pub id: String,
    pub parent_id: Option<String>,
    pub chat_id: Option<String>,
    pub run_id: Option<String>,
    pub kind: String,
    pub name: String,
    pub depth: i64,
    pub seq: i64,
    pub status: String,
    pub started_ms: i64,
    pub ended_ms: Option<i64>,
    pub input_hash: Option<String>,
    pub output_hash: Option<String>,
    pub error_hash: Option<String>,
    pub invoked_from_step_id: Option<String>,
    pub data_json: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TraceEventRow {
    pub id: i64,
    pub span_id: String,
    pub ts_ms: i64,
    pub level: String,
    pub message: String,
    pub data_hash: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct TraceSearch {
    pub query: Option<String>,
    pub kind: Option<String>,
    pub status: Option<String>,
    pub chat_id: Option<String>,
    pub run_id: Option<String>,
    pub has_error: bool,
    pub limit: i64,
    pub before_ms: Option<i64>,
}

pub fn trace_open(
    id: &str,
    parent_id: Option<&str>,
    chat_id: Option<&str>,
    run_id: Option<&str>,
    kind: &str,
    name: &str,
    started_ms: i64,
    input_hash: Option<&str>,
    invoked_from_step_id: Option<&str>,
    data_json: Option<&str>,
) -> Result<(), String> {
    with_host(|host| {
        trace_open_conn(
            &host.db,
            id,
            parent_id,
            chat_id,
            run_id,
            kind,
            name,
            started_ms,
            input_hash,
            invoked_from_step_id,
            data_json,
        )
    })
}

pub fn trace_open_conn(
    conn: &Connection,
    id: &str,
    parent_id: Option<&str>,
    chat_id: Option<&str>,
    run_id: Option<&str>,
    kind: &str,
    name: &str,
    started_ms: i64,
    input_hash: Option<&str>,
    invoked_from_step_id: Option<&str>,
    data_json: Option<&str>,
) -> Result<(), String> {
    let parent: Option<(i64, Option<String>, Option<String>)> = match parent_id {
        Some(parent_id) => {
            let found = conn
                .query_row(
                    "select depth, chat_id, run_id from traces where id = ?1",
                    params![parent_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if found.is_none() {
                let stub_seq = next_seq_conn(conn, None)?;
                conn.execute(
                    "insert or ignore into traces(
                       id, parent_id, chat_id, run_id, kind, name, depth, seq,
                       status, started_ms, ended_ms, input_hash, output_hash,
                       error_hash, invoked_from_step_id, data_json
                     ) values(?1, null, ?2, null, 'system', ?1, 0, ?3, 'ok',
                       cast((unixepoch('now') * 1000) as integer),
                       cast((unixepoch('now') * 1000) as integer),
                       null, null, null, null, null)",
                    params![parent_id, chat_id, stub_seq],
                )
                .map_err(|e| e.to_string())?;
                Some((0, chat_id.map(ToString::to_string), None))
            } else {
                found
            }
        }
        None => None,
    };
    let (depth, inherited_chat_id, inherited_run_id) = match parent {
        Some((depth, chat_id, run_id)) => (depth.saturating_add(1), chat_id, run_id),
        None => (0, None, None),
    };
    let final_chat_id = chat_id.map(ToString::to_string).or(inherited_chat_id);
    let final_run_id = run_id.map(ToString::to_string).or(inherited_run_id);
    let seq = next_seq_conn(conn, parent_id)?;
    conn.execute(
        "insert into traces(
           id, parent_id, chat_id, run_id, kind, name, depth, seq, status, started_ms,
           ended_ms, input_hash, output_hash, error_hash, invoked_from_step_id, data_json
         ) values(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'running', ?9, null, ?10, null, null, ?11, ?12)",
        params![
            id,
            parent_id,
            final_chat_id.as_deref(),
            final_run_id.as_deref(),
            kind,
            name,
            depth,
            seq,
            started_ms,
            input_hash,
            invoked_from_step_id,
            data_json,
        ],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn next_seq_conn(conn: &Connection, parent_id: Option<&str>) -> Result<i64, String> {
    let max_seq: i64 = match parent_id {
        Some(parent_id) => conn.query_row(
            "select coalesce(max(seq), -1) from traces where parent_id = ?1",
            params![parent_id],
            |r| r.get(0),
        ),
        None => conn.query_row(
            "select coalesce(max(seq), -1) from traces where parent_id is null",
            [],
            |r| r.get(0),
        ),
    }
    .map_err(|e| e.to_string())?;
    Ok(max_seq.saturating_add(1))
}

pub fn trace_finish(
    id: &str,
    ended_ms: i64,
    status: &str,
    output_hash: Option<&str>,
    error_hash: Option<&str>,
    data_json: Option<&str>,
) -> Result<bool, String> {
    with_host(|host| {
        host.db
            .execute(
                "update traces
                 set ended_ms = ?2, status = ?3, output_hash = ?4, error_hash = ?5, data_json = ?6
                 where id = ?1",
                params![id, ended_ms, status, output_hash, error_hash, data_json],
            )
            .map(|n| n > 0)
            .map_err(|e| e.to_string())
    })
}

#[allow(dead_code)]
pub fn trace_event(
    span_id: &str,
    ts_ms: i64,
    level: &str,
    message: &str,
    data_hash: Option<&str>,
) -> Result<i64, String> {
    with_host(|host| {
        host.db
            .execute(
                "insert into trace_events(span_id, ts_ms, level, message, data_hash)
                 values(?1, ?2, ?3, ?4, ?5)",
                params![span_id, ts_ms, level, message, data_hash],
            )
            .map(|_| host.db.last_insert_rowid())
            .map_err(|e| e.to_string())
    })
}

pub fn trace_get(id: &str) -> Result<Option<TraceRow>, String> {
    with_host(|host| trace_get_conn(&host.db, id))
}

pub fn trace_get_conn(conn: &Connection, id: &str) -> Result<Option<TraceRow>, String> {
    conn.query_row(
        &format!("{TRACE_SELECT_SQL} where id = ?1"),
        params![id],
        trace_row_from_sql,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn trace_children(
    parent_id: Option<&str>,
    limit: Option<i64>,
) -> Result<Vec<TraceRow>, String> {
    with_host(|host| trace_children_conn(&host.db, parent_id, limit))
}

pub fn trace_children_conn(
    conn: &Connection,
    parent_id: Option<&str>,
    limit: Option<i64>,
) -> Result<Vec<TraceRow>, String> {
    let sql = match (parent_id, limit) {
        (Some(_), Some(_)) => {
            format!("{TRACE_SELECT_SQL} where parent_id = ?1 order by seq asc limit ?2")
        }
        (Some(_), None) => format!("{TRACE_SELECT_SQL} where parent_id = ?1 order by seq asc"),
        (None, Some(_)) => {
            format!("{TRACE_SELECT_SQL} where parent_id is null order by seq asc limit ?1")
        }
        (None, None) => format!("{TRACE_SELECT_SQL} where parent_id is null order by seq asc"),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    match (parent_id, limit) {
        (Some(parent_id), Some(limit)) => stmt
            .query_map(params![parent_id, limit], trace_row_from_sql)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string()),
        (Some(parent_id), None) => stmt
            .query_map(params![parent_id], trace_row_from_sql)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string()),
        (None, Some(limit)) => stmt
            .query_map(params![limit], trace_row_from_sql)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string()),
        (None, None) => stmt
            .query_map([], trace_row_from_sql)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string()),
    }
}

pub fn trace_ancestors(id: &str) -> Result<Vec<TraceRow>, String> {
    with_host(|host| {
        let mut stmt = host.db.prepare(
            &format!(
                "with recursive a(id, parent_id, chat_id, run_id, kind, name, depth, seq, status, started_ms, ended_ms, input_hash, output_hash, error_hash, invoked_from_step_id, data_json) as (
                   {select_sql} where id = ?1
                   union all
                   select t.id, t.parent_id, t.chat_id, t.run_id, t.kind, t.name, t.depth, t.seq, t.status, t.started_ms, t.ended_ms, t.input_hash, t.output_hash, t.error_hash, t.invoked_from_step_id, t.data_json
                   from traces t join a on a.parent_id = t.id
                 ) select id, parent_id, chat_id, run_id, kind, name, depth, seq, status, started_ms, ended_ms, input_hash, output_hash, error_hash, invoked_from_step_id, data_json from a order by depth asc",
                select_sql = TRACE_SELECT_SQL
            ),
        ).map_err(|e| e.to_string())?;
        stmt.query_map(params![id], trace_row_from_sql)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    })
}

pub fn trace_subtree(id: &str, max_depth: i32) -> Result<Vec<TraceRow>, String> {
    with_host(|host| {
        let mut stmt = host.db.prepare(
            &format!(
                "with recursive s(id, parent_id, chat_id, run_id, kind, name, depth, seq, status, started_ms, ended_ms, input_hash, output_hash, error_hash, invoked_from_step_id, data_json, rel_depth) as (
                   {select_sql} where id = ?1
                   union all
                   select t.id, t.parent_id, t.chat_id, t.run_id, t.kind, t.name, t.depth, t.seq, t.status, t.started_ms, t.ended_ms, t.input_hash, t.output_hash, t.error_hash, t.invoked_from_step_id, t.data_json, s.rel_depth + 1
                   from traces t join s on t.parent_id = s.id where s.rel_depth < ?2
                 ) select id, parent_id, chat_id, run_id, kind, name, depth, seq, status, started_ms, ended_ms, input_hash, output_hash, error_hash, invoked_from_step_id, data_json from s order by depth asc, seq asc",
                select_sql = TRACE_SELECT_SQL
            ),
        ).map_err(|e| e.to_string())?;
        stmt.query_map(params![id, max_depth], trace_row_from_sql)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    })
}

pub fn trace_events(
    span_id: &str,
    limit: i64,
    before_ms: Option<i64>,
) -> Result<Vec<TraceEventRow>, String> {
    with_host(|host| {
        let limit = limit.clamp(1, 1000);
        let sql = if before_ms.is_some() {
            "select id, span_id, ts_ms, level, message, data_hash from trace_events where span_id = ?1 and ts_ms < ?2 order by ts_ms asc, id asc limit ?3"
        } else {
            "select id, span_id, ts_ms, level, message, data_hash from trace_events where span_id = ?1 order by ts_ms asc, id asc limit ?2"
        };
        let mut stmt = host.db.prepare(sql).map_err(|e| e.to_string())?;
        if let Some(before_ms) = before_ms {
            stmt.query_map(params![span_id, before_ms, limit], trace_event_row_from_sql)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())
        } else {
            stmt.query_map(params![span_id, limit], trace_event_row_from_sql)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())
        }
    })
}

pub fn trace_chat_roots(limit: i64, before_ms: Option<i64>) -> Result<Vec<TraceRow>, String> {
    with_host(|host| {
        let limit = limit.clamp(1, 200);
        let sql = if before_ms.is_some() {
            format!(
                "{TRACE_SELECT_SQL} where kind = 'chat' and parent_id is null and started_ms < ?1 order by started_ms desc limit ?2"
            )
        } else {
            format!(
                "{TRACE_SELECT_SQL} where kind = 'chat' and parent_id is null order by started_ms desc limit ?1"
            )
        };
        let mut stmt = host.db.prepare(&sql).map_err(|e| e.to_string())?;
        if let Some(before_ms) = before_ms {
            stmt.query_map(params![before_ms, limit], trace_row_from_sql)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())
        } else {
            stmt.query_map(params![limit], trace_row_from_sql)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())
        }
    })
}

pub fn trace_failed(
    limit: i64,
    chat_id: Option<&str>,
    before_ms: Option<i64>,
) -> Result<Vec<TraceRow>, String> {
    let mut query = TraceSearch::default();
    query.limit = limit;
    query.chat_id = chat_id.map(ToString::to_string);
    query.has_error = true;
    query.before_ms = before_ms;
    trace_search(query)
}

pub fn trace_search(query: TraceSearch) -> Result<Vec<TraceRow>, String> {
    with_host(|host| {
        let limit = query.limit.clamp(1, 200);
        let before_ms = query.before_ms.unwrap_or(i64::MAX);
        let text = query.query.unwrap_or_default().to_lowercase();
        let kind = query.kind.unwrap_or_default();
        let status = if query.has_error {
            "error".to_string()
        } else {
            query.status.unwrap_or_default()
        };
        let chat_id = query.chat_id.unwrap_or_default();
        let run_id = query.run_id.unwrap_or_default();
        let mut stmt = host
            .db
            .prepare(&format!(
                "{TRACE_SELECT_SQL} where started_ms < ?1
                 and (?2 = '' or lower(name) like '%' || ?2 || '%')
                 and (?3 = '' or kind = ?3)
                 and (?4 = '' or status = ?4)
                 and (?5 = '' or chat_id = ?5)
                 and (?6 = '' or run_id = ?6)
                 order by started_ms desc limit ?7"
            ))
            .map_err(|e| e.to_string())?;
        stmt.query_map(
            params![before_ms, text, kind, status, chat_id, run_id, limit],
            trace_row_from_sql,
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
    })
}

#[allow(dead_code)]
pub fn trace_chat_root_for(chat_id: &str) -> Result<Option<TraceRow>, String> {
    with_host(|host| trace_chat_root_for_conn(&host.db, chat_id))
}

pub fn trace_chat_root_for_conn(
    conn: &Connection,
    chat_id: &str,
) -> Result<Option<TraceRow>, String> {
    conn.query_row(
        &format!("{TRACE_SELECT_SQL} where parent_id is null and kind = 'chat' and chat_id = ?1 order by started_ms desc limit 1"),
        params![chat_id],
        trace_row_from_sql,
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn trace_event_row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<TraceEventRow> {
    Ok(TraceEventRow {
        id: row.get(0)?,
        span_id: row.get(1)?,
        ts_ms: row.get(2)?,
        level: row.get(3)?,
        message: row.get(4)?,
        data_hash: row.get(5)?,
    })
}

const TRACE_SELECT_SQL: &str = "select id, parent_id, chat_id, run_id, kind, name, depth, seq, status, started_ms, ended_ms, input_hash, output_hash, error_hash, invoked_from_step_id, data_json from traces";

fn trace_row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<TraceRow> {
    Ok(TraceRow {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        chat_id: row.get(2)?,
        run_id: row.get(3)?,
        kind: row.get(4)?,
        name: row.get(5)?,
        depth: row.get(6)?,
        seq: row.get(7)?,
        status: row.get(8)?,
        started_ms: row.get(9)?,
        ended_ms: row.get(10)?,
        input_hash: row.get(11)?,
        output_hash: row.get(12)?,
        error_hash: row.get(13)?,
        invoked_from_step_id: row.get(14)?,
        data_json: row.get(15)?,
    })
}
