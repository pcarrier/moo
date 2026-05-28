mod async_runtime;
mod blit;
mod broadcast;
mod cdp;
mod driver;
mod host;
mod ops;
mod pool;
mod runtime;
mod server;
mod settings;
mod snapshots;
mod upgrade;
mod util;
mod ws;

use clap::{Parser, Subcommand};
use rusqlite::OptionalExtension;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const DEFAULT_HARNESS: &str = include_str!(concat!(env!("OUT_DIR"), "/default_harness.js"));
const DEFAULT_UI_BR: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/default_ui.html.br"));

#[derive(Parser)]
#[command(name = "moo", version, about = "moo agent harness")]
struct Cli {
    /// Path to a JS bundle. Falls back to the embedded harness.
    #[arg(long, global = true)]
    bundle: Option<PathBuf>,
    /// SQLite store path. Defaults to $MOO_DB, then $XDG_DATA_HOME/moo/store.sqlite, then ~/.local/share/moo/store.sqlite.
    #[arg(long, global = true)]
    db: Option<String>,
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Start the local web shell.
    Serve {
        #[arg(long, default_value_t = 7777)]
        port: u16,
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        /// Public base URL for this server; used for externally-visible callbacks such as MCP OAuth redirects.
        #[arg(long, value_name = "URL")]
        base_url: Option<String>,
        /// Bind a local Chrome DevTools Protocol endpoint for V8 debugging.
        #[arg(long, value_name = "ADDR")]
        bind_cdp: Option<String>,
        /// Re-read --bundle from disk on each request (live reload). Requires --bundle.
        #[arg(long)]
        watch: bool,
    },
    /// Manage the optional PSK that gates the local web shell.
    Psk {
        #[command(subcommand)]
        action: PskCmd,
    },
    /// Clear all ongoing markers so no chats restart on next startup.
    Freeze,
    /// Disable OTEL reporting in the database. Works even if the server won't start.
    DisableTracing,
    /// Re-run the canonical installer at this binary's install location.
    Upgrade,
    /// Physically purge facts whose subject starts with a prefix.
    FactsPurgePrefix {
        store: String,
        prefix: String,
        #[arg(long)]
        graph: Option<String>,
    },
}

#[derive(Subcommand)]
enum PskCmd {
    /// Set the PSK. Clients must pass `?psk=<value>` (UI takes it from `#psk=`).
    Set { value: String },
    /// Remove the PSK so the web shell accepts any client.
    Clear,
    /// Print the current PSK value, or nothing if unset.
    Show,
}

fn main() {
    // Dependencies enable both rustls providers; choose one before TLS clients initialize.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let cli = Cli::parse();
    if let Err(err) = real_main(cli) {
        eprintln!("error: {err}");
        std::process::exit(1);
    }
}

fn default_db_path() -> Result<String, String> {
    if let Ok(path) = env::var("MOO_DB")
        && !path.trim().is_empty()
    {
        return Ok(path);
    }
    if let Ok(base) = env::var("XDG_DATA_HOME")
        && !base.trim().is_empty()
    {
        return Ok(PathBuf::from(base)
            .join("moo")
            .join("store.sqlite")
            .to_string_lossy()
            .to_string());
    }
    let home = env::var("HOME").map_err(|_| {
        "cannot choose default SQLite store: set --db, MOO_DB, XDG_DATA_HOME, or HOME".to_string()
    })?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("moo")
        .join("store.sqlite")
        .to_string_lossy()
        .to_string())
}

fn real_main(cli: Cli) -> Result<(), String> {
    if let Cmd::Upgrade = &cli.command {
        upgrade::run();
    }

    let db_path = cli.db.clone().map(Ok).unwrap_or_else(default_db_path)?;
    if let Cmd::Serve {
        port,
        host,
        base_url,
        bind_cdp,
        watch,
    } = &cli.command
    {
        let provider: server::BundleProvider = if *watch {
            let path = cli.bundle.clone().ok_or_else(|| {
                "--watch requires --bundle <path> (try --bundle harness/dist/harness.js)"
                    .to_string()
            })?;
            {
                let cache = Mutex::new((None, Arc::new(String::new())));
                std::sync::Arc::new(move || {
                    let modified = fs::metadata(&path).and_then(|m| m.modified()).ok();
                    let mut guard = cache.lock().expect("bundle cache poisoned");
                    if guard.0 == modified && !guard.1.is_empty() {
                        return guard.1.clone();
                    }
                    let source = fs::read_to_string(&path).unwrap_or_else(|e| {
                        format!(
                            "throw new Error('failed to read bundle: {}: {}');",
                            path.display(),
                            e
                        )
                    });
                    let source = Arc::new(source);
                    *guard = (modified, source.clone());
                    source
                })
            }
        } else {
            let source = Arc::new(match &cli.bundle {
                Some(path) => fs::read_to_string(path).map_err(|e| e.to_string())?,
                None => DEFAULT_HARNESS.to_string(),
            });
            std::sync::Arc::new(move || source.clone())
        };
        blit::warmup();
        if let Some(addr) = bind_cdp.as_deref() {
            let source_map_path = cli
                .bundle
                .as_ref()
                .map(|path| {
                    let mut mapped = path.clone().into_os_string();
                    mapped.push(".map");
                    PathBuf::from(mapped)
                })
                .or_else(|| {
                    let embedded =
                        PathBuf::from(concat!(env!("OUT_DIR"), "/default_harness.js.map"));
                    embedded.exists().then_some(embedded)
                });
            cdp::spawn(addr, provider.clone(), source_map_path, db_path.clone())?;
        }
        let base_url = base_url
            .as_deref()
            .map(server::normalize_base_url)
            .transpose()?;
        return server::serve(host, *port, base_url, provider, DEFAULT_UI_BR, &db_path);
    }

    if let Cmd::Freeze = &cli.command {
        let conn = host::open_db(&db_path)?;
        let now = util::now_ms();
        let names: Vec<String> = conn
            .prepare("SELECT name FROM refs WHERE name >= 'chat/' AND name < 'chat0' AND substr(name, length(name) - 7) = '/ongoing'")
            .map_err(|e| e.to_string())?
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        if names.is_empty() {
            eprintln!("no ongoing chats");
            return Ok(());
        }
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for name in &names {
            let old: Option<String> = tx
                .query_row("SELECT target FROM refs WHERE name = ?1", [name], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM refs WHERE name = ?1", [name])
                .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO ref_log(name, old_target, new_target, created_at) VALUES (?1, ?2, NULL, ?3)",
                rusqlite::params![name, old, now],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        eprintln!("froze {} chat(s)", names.len());
        return Ok(());
    }

    if let Cmd::Psk { action } = &cli.command {
        let conn = host::open_db(&db_path)?;
        return match action {
            PskCmd::Set { value } => {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    return Err("psk value must be non-empty".to_string());
                }
                settings::set(&conn, settings::PSK_KEY, trimmed)?;
                Ok(())
            }
            PskCmd::Clear => {
                let removed = settings::clear(&conn, settings::PSK_KEY)?;
                let _ = removed;
                Ok(())
            }
            PskCmd::Show => {
                if let Some(v) = settings::get(&conn, settings::PSK_KEY)? {
                    println!("{v}");
                }
                Ok(())
            }
        };
    }

    if let Cmd::DisableTracing = &cli.command {
        let conn = host::open_db(&db_path)?;
        let mut config = settings::get(&conn, settings::TRACE_CONFIG_KEY)?
            .and_then(|v| serde_json::from_str::<settings::TraceConfig>(&v).ok())
            .unwrap_or_else(settings::default_trace_config);
        if !config.enabled {
            eprintln!("OTEL reporting is already disabled");
            return Ok(());
        }
        config.enabled = false;
        let json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
        settings::set(&conn, settings::TRACE_CONFIG_KEY, &json)?;
        eprintln!("OTEL reporting disabled (restart the server to apply)");
        return Ok(());
    }

    if let Cmd::FactsPurgePrefix {
        store,
        prefix,
        graph,
    } = &cli.command
    {
        let conn = host::open_db(&db_path)?;
        let like = format!(
            "{}%",
            prefix
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_"),
        );
        let mut conn = conn;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let now = util::now_ms();
        let rows: Vec<[String; 4]> = if let Some(graph) = graph {
            let mut stmt = tx
                .prepare(
                    "select graph, subject, predicate, object from quads
                     where ref_name = ?1 and graph = ?2
                       and (subject like ?3 escape '\\' or predicate like ?3 escape '\\' or object like ?3 escape '\\')",
                )
                .map_err(|e| e.to_string())?;
            let iter = stmt
                .query_map(rusqlite::params![store, graph, like], |r| {
                    Ok([r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?])
                })
                .map_err(|e| e.to_string())?;
            iter.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        } else {
            let mut stmt = tx
                .prepare(
                    "select graph, subject, predicate, object from quads
                     where ref_name = ?1
                       and (subject like ?2 escape '\\' or predicate like ?2 escape '\\' or object like ?2 escape '\\')",
                )
                .map_err(|e| e.to_string())?;
            let iter = stmt
                .query_map(rusqlite::params![store, like], |r| {
                    Ok([r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?])
                })
                .map_err(|e| e.to_string())?;
            iter.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        {
            let mut log_remove = tx
                .prepare(
                    "insert into fact_log(ref_name, graph, subject, predicate, object, action, created_by, created_at)
                     values (?1, ?2, ?3, ?4, ?5, 'remove', 'system', ?6)",
                )
                .map_err(|e| e.to_string())?;
            for q in &rows {
                log_remove
                    .execute(rusqlite::params![store, &q[0], &q[1], &q[2], &q[3], now])
                    .map_err(|e| e.to_string())?;
            }
        }
        let n = if let Some(graph) = graph {
            tx.execute(
                "delete from quads where ref_name = ?1 and graph = ?2
                  and (subject like ?3 escape '\\' or predicate like ?3 escape '\\' or object like ?3 escape '\\')",
                rusqlite::params![store, graph, like],
            )
        } else {
            tx.execute(
                "delete from quads where ref_name = ?1
                  and (subject like ?2 escape '\\' or predicate like ?2 escape '\\' or object like ?2 escape '\\')",
                rusqlite::params![store, like],
            )
        }
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        println!("purged {n} facts");
        return Ok(());
    }

    Ok(())
}
