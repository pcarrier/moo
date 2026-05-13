use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

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
pub const V8_ENV_KEY: &str = "v8.env";
pub const V8_CONFIG_KEY: &str = "v8.config";
pub const TRACE_CONFIG_KEY: &str = "trace.config";
pub const SERVER_BASE_URL_KEY: &str = "server.baseUrl";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TraceConfig {
    pub enabled: bool,
    pub clickhouse_url: String,
    pub clickhouse_database: String,
    pub clickhouse_table_prefix: String,
    pub clickhouse_user: Option<String>,
    pub clickhouse_password: Option<String>,
}

pub fn default_trace_clickhouse_url() -> String {
    "http://localhost:8123".to_string()
}

pub fn default_trace_clickhouse_database() -> String {
    "default".to_string()
}

pub fn default_trace_clickhouse_table_prefix() -> String {
    "moo_traces".to_string()
}

pub fn default_trace_config() -> TraceConfig {
    TraceConfig {
        enabled: false,
        clickhouse_url: default_trace_clickhouse_url(),
        clickhouse_database: default_trace_clickhouse_database(),
        clickhouse_table_prefix: default_trace_clickhouse_table_prefix(),
        clickhouse_user: None,
        clickhouse_password: None,
    }
}

pub fn normalize_trace_config(mut config: TraceConfig) -> TraceConfig {
    let defaults = default_trace_config();
    if config.clickhouse_url.trim().is_empty() {
        config.clickhouse_url = defaults.clickhouse_url;
    } else {
        config.clickhouse_url = config
            .clickhouse_url
            .trim()
            .trim_end_matches('/')
            .to_string();
    }
    if config.clickhouse_database.trim().is_empty() {
        config.clickhouse_database = defaults.clickhouse_database;
    } else {
        config.clickhouse_database = config.clickhouse_database.trim().to_string();
    }
    if config.clickhouse_table_prefix.trim().is_empty() {
        config.clickhouse_table_prefix = defaults.clickhouse_table_prefix;
    } else {
        config.clickhouse_table_prefix = config.clickhouse_table_prefix.trim().to_string();
    }
    config.clickhouse_user = config
        .clickhouse_user
        .and_then(|user| (!user.trim().is_empty()).then(|| user.trim().to_string()));
    config.clickhouse_password = config
        .clickhouse_password
        .and_then(|password| (!password.trim().is_empty()).then(|| password.trim().to_string()));
    config
}

pub fn normalize_server_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("base URL is empty".to_string());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("base URL must start with http:// or https://".to_string());
    }
    if trimmed.chars().any(|c| c.is_whitespace()) {
        return Err("base URL must not contain whitespace".to_string());
    }
    Ok(trimmed.to_string())
}

pub fn read_server_base_url(conn: &Connection) -> Result<Option<String>, String> {
    match get(conn, SERVER_BASE_URL_KEY)? {
        Some(value) => normalize_server_base_url(&value).map(Some),
        None => Ok(None),
    }
}

pub fn write_server_base_url(
    conn: &Connection,
    value: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(raw) = value else {
        clear(conn, SERVER_BASE_URL_KEY)?;
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        clear(conn, SERVER_BASE_URL_KEY)?;
        return Ok(None);
    }
    let normalized = normalize_server_base_url(trimmed)?;
    set(conn, SERVER_BASE_URL_KEY, &normalized)?;
    Ok(Some(normalized))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_config_defaults_to_disabled_clickhouse() {
        let config = default_trace_config();
        assert!(!config.enabled);
        assert_eq!(config.clickhouse_url, "http://localhost:8123");
        assert_eq!(config.clickhouse_database, "default");
        assert_eq!(config.clickhouse_table_prefix, "moo_traces");
        assert_eq!(config.clickhouse_user, None);
        assert_eq!(config.clickhouse_password, None);
    }

    #[test]
    fn trace_config_normalizes_blank_and_trimmed_values() {
        let config = TraceConfig {
            enabled: true,
            clickhouse_url: " https://clickhouse.example.com/ ".to_string(),
            clickhouse_database: " moo ".to_string(),
            clickhouse_table_prefix: " trace_store ".to_string(),
            clickhouse_user: Some(" user ".to_string()),
            clickhouse_password: Some(" secret ".to_string()),
        };
        let normalized = normalize_trace_config(config);
        assert!(normalized.enabled);
        assert_eq!(normalized.clickhouse_url, "https://clickhouse.example.com");
        assert_eq!(normalized.clickhouse_database, "moo");
        assert_eq!(normalized.clickhouse_table_prefix, "trace_store");
        assert_eq!(normalized.clickhouse_user.as_deref(), Some("user"));
        assert_eq!(normalized.clickhouse_password.as_deref(), Some("secret"));

        let blank = TraceConfig {
            enabled: true,
            clickhouse_url: "   ".to_string(),
            clickhouse_database: "".to_string(),
            clickhouse_table_prefix: "  ".to_string(),
            clickhouse_user: Some("  ".to_string()),
            clickhouse_password: Some("	".to_string()),
        };
        let normalized_blank = normalize_trace_config(blank);
        assert_eq!(
            normalized_blank.clickhouse_url,
            default_trace_clickhouse_url()
        );
        assert_eq!(
            normalized_blank.clickhouse_database,
            default_trace_clickhouse_database()
        );
        assert_eq!(
            normalized_blank.clickhouse_table_prefix,
            default_trace_clickhouse_table_prefix()
        );
        assert_eq!(normalized_blank.clickhouse_user, None);
        assert_eq!(normalized_blank.clickhouse_password, None);
    }

    #[test]
    fn server_base_url_normalizes_and_validates() {
        assert_eq!(
            normalize_server_base_url(" https://moo.example.com/ ").unwrap(),
            "https://moo.example.com"
        );
        assert!(normalize_server_base_url("moo.example.com").is_err());
        assert!(normalize_server_base_url("http://bad host").is_err());
    }
}
