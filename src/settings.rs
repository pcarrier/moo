use rusqlite::{Connection, OptionalExtension, params};

use crate::util::now_ms;

pub fn get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "select value from settings where key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "insert into settings (key, value, updated_at) values (?1, ?2, ?3)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn clear(conn: &Connection, key: &str) -> Result<bool, String> {
    let n = conn
        .execute("delete from settings where key = ?1", params![key])
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

pub const PSK_KEY: &str = "auth.psk";
