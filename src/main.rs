mod async_runtime;
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
mod util;
mod ws;

use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use clap::{Parser, Subcommand};

const DEFAULT_HARNESS: &str = include_str!(concat!(env!("OUT_DIR"), "/default_harness.js"));
const DEFAULT_UI: &str = include_str!(concat!(env!("OUT_DIR"), "/default_ui.html"));

#[derive(Parser)]
#[command(name = "moo", about = "moo agent harness (rusty_v8 + SQLite)")]
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
    /// Run the bundle once. Positional args are passed to JS as input.argv.
    Run {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Run the bundle once with a JSON input.
    Eval {
        #[arg(default_value = "{}")]
        input: String,
    },
    /// Start the local web shell.
    Serve {
        #[arg(long, default_value_t = 7777)]
        port: u16,
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        /// Bind a local Chrome DevTools Protocol endpoint for V8 debugging.
        #[arg(long, value_name = "ADDR")]
        bind_cdp: Option<String>,
        /// Re-read --bundle from disk on each request (live reload). Requires --bundle.
        #[arg(long)]
        watch: bool,
    },
    /// Dump quads in TriG (Turtle with named graphs). Filters to one chat when given.
    Dump { chat_id: Option<String> },
    /// Build a V8 startup snapshot for the selected JS bundle.
    Snapshot { output: PathBuf },
    /// Manage the optional PSK that gates the local web shell.
    Psk {
        #[command(subcommand)]
        action: PskCmd,
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
    let cli = Cli::parse();
    if let Err(err) = real_main(cli) {
        eprintln!("error: {err}");
        std::process::exit(1);
    }
}

fn run_dump_command(bundle_source: &str, chat_id: Option<&str>) -> Result<(), String> {
    let mut input = serde_json::json!({ "command": "dump" });
    if let Some(chat_id) = chat_id {
        input["chatId"] = serde_json::Value::String(chat_id.to_string());
    }
    let raw = runtime::run_js(bundle_source, &input.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if value.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let message = value
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("dump command failed");
        return Err(message.to_string());
    }
    let text = value
        .get("value")
        .and_then(|v| v.get("text"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "dump command did not return value.text".to_string())?;
    print!("{text}");
    Ok(())
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
    let db_path = cli.db.clone().map(Ok).unwrap_or_else(default_db_path)?;
    if let Cmd::Serve {
        port,
        host,
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
                let cache = Mutex::new((None, String::new()));
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
                    *guard = (modified, source.clone());
                    source
                })
            }
        } else {
            let source = match &cli.bundle {
                Some(path) => fs::read_to_string(path).map_err(|e| e.to_string())?,
                None => DEFAULT_HARNESS.to_string(),
            };
            std::sync::Arc::new(move || source.clone())
        };
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
        return server::serve(host, *port, provider, DEFAULT_UI, &db_path);
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

    let bundle_source = match &cli.bundle {
        Some(path) => fs::read_to_string(path).map_err(|e| e.to_string())?,
        None => DEFAULT_HARNESS.to_string(),
    };

    host::install(&db_path)?;
    let result = match cli.command {
        Cmd::Run { args } => {
            let input = serde_json::json!({ "argv": args }).to_string();
            runtime::run_js(&bundle_source, &input).map(|out| println!("{out}"))
        }
        Cmd::Eval { input } => runtime::run_js(&bundle_source, &input).map(|out| println!("{out}")),
        Cmd::Dump { chat_id } => run_dump_command(&bundle_source, chat_id.as_deref()),
        Cmd::Snapshot { output } => {
            let blob = runtime::create_bundle_snapshot(&bundle_source)?;
            fs::write(&output, blob).map_err(|e| e.to_string())?;
            Ok(())
        }
        Cmd::Serve { .. } | Cmd::Psk { .. } => unreachable!(),
    };
    host::drop_host();
    result
}
