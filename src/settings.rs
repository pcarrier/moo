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
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_trace_otel_endpoint")]
    pub otel_endpoint: String,
    #[serde(default = "default_trace_service_name")]
    pub service_name: String,
    #[serde(default)]
    pub headers: Vec<OtelHeader>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OtelHeader {
    pub name: String,
    pub value: String,
}

pub fn default_trace_otel_endpoint() -> String {
    "http://localhost:4318/v1/traces".to_string()
}

pub fn default_trace_service_name() -> String {
    "moo".to_string()
}

pub fn default_trace_config() -> TraceConfig {
    TraceConfig {
        enabled: false,
        otel_endpoint: default_trace_otel_endpoint(),
        service_name: default_trace_service_name(),
        headers: vec![],
    }
}

pub fn normalize_trace_config(mut config: TraceConfig) -> TraceConfig {
    let defaults = default_trace_config();
    if config.otel_endpoint.trim().is_empty() {
        config.otel_endpoint = defaults.otel_endpoint;
    } else {
        config.otel_endpoint = config.otel_endpoint.trim().to_string();
    }
    if config.service_name.trim().is_empty() {
        config.service_name = defaults.service_name;
    } else {
        config.service_name = config.service_name.trim().to_string();
    }
    config.headers = config
        .headers
        .into_iter()
        .filter_map(|header| {
            let name = header.name.trim();
            if name.is_empty() {
                return None;
            }
            Some(OtelHeader {
                name: name.to_string(),
                value: header.value.trim().to_string(),
            })
        })
        .collect();
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
    fn trace_config_defaults_to_disabled_otel() {
        let config = default_trace_config();
        assert!(!config.enabled);
        assert_eq!(config.otel_endpoint, "http://localhost:4318/v1/traces");
        assert_eq!(config.service_name, "moo");
        assert!(config.headers.is_empty());
    }

    #[test]
    fn trace_config_normalizes_blank_and_trimmed_values() {
        let config = TraceConfig {
            enabled: true,
            otel_endpoint: " https://signoz.example.com:4318/v1/traces ".to_string(),
            service_name: " moo-dev ".to_string(),
            headers: vec![
                OtelHeader {
                    name: " signoz-access-token ".to_string(),
                    value: " secret ".to_string(),
                },
                OtelHeader {
                    name: "  ".to_string(),
                    value: "ignored".to_string(),
                },
            ],
        };
        let normalized = normalize_trace_config(config);
        assert!(normalized.enabled);
        assert_eq!(
            normalized.otel_endpoint,
            "https://signoz.example.com:4318/v1/traces"
        );
        assert_eq!(normalized.service_name, "moo-dev");
        assert_eq!(normalized.headers.len(), 1);
        assert_eq!(normalized.headers[0].name, "signoz-access-token");
        assert_eq!(normalized.headers[0].value, "secret");

        let blank = TraceConfig {
            enabled: true,
            otel_endpoint: "   ".to_string(),
            service_name: "".to_string(),
            headers: vec![],
        };
        let normalized_blank = normalize_trace_config(blank);
        assert_eq!(
            normalized_blank.otel_endpoint,
            default_trace_otel_endpoint()
        );
        assert_eq!(normalized_blank.service_name, default_trace_service_name());
        assert!(normalized_blank.headers.is_empty());
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
