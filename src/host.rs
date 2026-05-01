use std::cell::RefCell;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

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
create table if not exists settings (
  key text primary key,
  value text not null,
  updated_at integer not null
);
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
    migrate_chat_model_effort_to_chat_facts(&conn)?;
    Ok(conn)
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
    use super::open_db;
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
}
