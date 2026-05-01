// Worker pool of long-lived V8 isolates.
//
// Each worker owns one v8::Isolate and one SQLite connection forever, so
// HTTP requests pay the V8 startup cost once per worker (not per request).
// Workers pull jobs off a shared mpsc; concurrency = pool size.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::thread;

use rusty_v8 as v8;
use tokio::sync::Mutex as TokioMutex;

use crate::cdp;
use crate::host;
use crate::runtime;
use crate::runtime::AgentRunHandler;
use crate::snapshots;

pub struct Job {
    pub bundle: Arc<String>,
    pub input: String,
    pub response: Sender<Result<String, String>>,
}

pub struct AsyncToolJob {
    pub bundle: Arc<String>,
    pub input: String,
    pub agent_run: AgentRunHandler,
    pub response: Sender<Result<String, String>>,
}

pub struct Pool {
    tx: Sender<Job>,
    read_tx: Sender<Job>,
    scan_tx: Sender<Job>,
    async_tool_tx: Sender<AsyncToolJob>,
    // Outer std::sync::Mutex protects the map and is only held while the
    // inner Arc is cloned (microseconds). The inner per-chat lock is
    // tokio::sync::Mutex so the chat driver can `lock().await` without
    // parking a runtime thread; sync `submit` callers (HTTP server thread)
    // use `blocking_lock` since they aren't inside a tokio runtime.
    chat_locks: Arc<Mutex<HashMap<String, Arc<TokioMutex<()>>>>>,
}

impl Pool {
    pub fn new(workers: usize, db: &str) -> Self {
        let workers = workers.max(1);
        let (tx, rx) = mpsc::channel::<Job>();
        spawn_workers("moo-worker", workers, rx, db);

        // UI/API reads must stay responsive even while agent/tool work fills
        // the main isolate pool. Keep fast reads on their own lane, and keep
        // whole-store scans (triples/vocabulary) off that lane so they cannot
        // starve chat-models/ui-chat/describe refreshes.
        let read_workers = (workers / 4).max(2);
        let (read_tx, read_rx) = mpsc::channel::<Job>();
        spawn_workers("moo-read-worker", read_workers, read_rx, db);

        let (scan_tx, scan_rx) = mpsc::channel::<Job>();
        spawn_workers("moo-scan-worker", 1, scan_rx, db);

        let async_tool_workers = (workers / 4).max(2);
        let (async_tool_tx, async_tool_rx) = mpsc::channel::<AsyncToolJob>();
        spawn_async_tool_workers("moo-tool-worker", async_tool_workers, async_tool_rx, db);

        Pool {
            tx,
            read_tx,
            scan_tx,
            async_tool_tx,
            chat_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn submit(&self, bundle: Arc<String>, input: String) -> Result<String, String> {
        // Writes for a given chat run under a per-chat mutex (filesystem +
        // ref-update races aren't covered by SQLite's WAL). Read-only commands
        // skip the lock entirely and use reserved worker lanes, so slow agent
        // tool work or whole-store scans do not make lightweight UI refreshes
        // sit in FIFO long enough to hit the websocket RPC timeout.
        let (lane, lock_key) = route_input(&input);
        match lane {
            Lane::FastRead => return self.dispatch_on(&self.read_tx, bundle, input),
            Lane::ScanRead => return self.dispatch_on(&self.scan_tx, bundle, input),
            Lane::Write => {}
        }
        let lock_arc = lock_key.map(|key| self.chat_lock(&key));
        let _guard = lock_arc.as_ref().map(|arc| arc.blocking_lock());
        self.dispatch(bundle, input)
    }

    /// Skip the chat lock — the caller (chat driver) already holds it for the
    /// duration of the step. Used for short V8 calls invoked from inside the
    /// driver loop: `step-prelude`, `step-prepare`, `step-handle-llm`.
    pub fn submit_unlocked(&self, bundle: Arc<String>, input: String) -> Result<String, String> {
        self.dispatch(bundle, input)
    }

    /// Run a long-lived JS tool job on the async tool lane. These jobs may park
    /// a V8 context while Promise-backed host operations (subagents) complete,
    /// so they are kept off the short command lanes.
    pub fn submit_async_tool(
        &self,
        bundle: Arc<String>,
        input: String,
        agent_run: AgentRunHandler,
    ) -> Result<String, String> {
        let (resp_tx, resp_rx) = mpsc::channel();
        self.async_tool_tx
            .send(AsyncToolJob {
                bundle,
                input,
                agent_run,
                response: resp_tx,
            })
            .map_err(|_| "async tool isolate pool closed".to_string())?;
        match resp_rx.recv() {
            Ok(r) => r,
            Err(_) => Err("async tool isolate worker dropped".to_string()),
        }
    }

    /// Acquire-or-create the per-chat write lock. Caller holds the returned
    /// Arc and locks it via `.lock().await` (async) or `.blocking_lock()`
    /// (sync, outside a tokio runtime).
    pub fn chat_lock(&self, key: &str) -> Arc<TokioMutex<()>> {
        let mut locks = self.chat_locks.lock().unwrap();
        locks
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(TokioMutex::new(())))
            .clone()
    }

    fn dispatch(&self, bundle: Arc<String>, input: String) -> Result<String, String> {
        self.dispatch_on(&self.tx, bundle, input)
    }

    fn dispatch_on(
        &self,
        tx: &Sender<Job>,
        bundle: Arc<String>,
        input: String,
    ) -> Result<String, String> {
        let (resp_tx, resp_rx) = mpsc::channel();
        tx.send(Job {
            bundle,
            input,
            response: resp_tx,
        })
        .map_err(|_| "isolate pool closed".to_string())?;
        match resp_rx.recv() {
            Ok(r) => r,
            Err(_) => Err("isolate worker dropped".to_string()),
        }
    }
}

fn spawn_workers(name: &str, count: usize, rx: mpsc::Receiver<Job>, db: &str) {
    let rx = Arc::new(Mutex::new(rx));
    for i in 0..count.max(1) {
        let rx = rx.clone();
        let db = db.to_string();
        let thread_name = format!("{name}-{i}");
        thread::Builder::new()
            .name(thread_name.clone())
            .spawn(move || worker_loop(rx, db, i))
            .unwrap_or_else(|_| panic!("spawn {thread_name}"));
    }
}

fn worker_loop(rx: Arc<Mutex<mpsc::Receiver<Job>>>, db: String, id: usize) {
    if let Err(e) = host::install(&db) {
        eprintln!("[worker {id}] host init: {e}");
        return;
    }
    runtime::init_v8();
    let near_heap_limit = AtomicBool::new(false);
    let mut isolate = v8::Isolate::new(v8::CreateParams::default());
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Auto);
    snapshots::install_failure_hooks(&mut isolate, &near_heap_limit);

    loop {
        let job = {
            let lock = rx.lock().unwrap();
            match lock.recv() {
                Ok(j) => j,
                Err(_) => break, // channel closed
            }
        };
        let result =
            if let Some(result) = cdp::handle().and_then(|h| h.run_if_attached(&job.input, None)) {
                result
            } else {
                match runtime::snapshot_path(&job.input) {
                    Some(path) => runtime::run_snapshot(&path, &job.input),
                    None => run_bundle_job(&mut isolate, &near_heap_limit, &job.bundle, &job.input),
                }
            };
        let _ = job.response.send(result);
    }
}

fn run_bundle_job(
    isolate: &mut v8::Isolate,
    near_heap_limit: &AtomicBool,
    bundle: &str,
    input: &str,
) -> Result<String, String> {
    near_heap_limit.store(false, Ordering::SeqCst);
    let report = runtime::run_js_report_in(isolate, bundle, input);
    snapshots::record_if_triggered(
        isolate,
        input,
        bundle,
        &report.result,
        near_heap_limit.load(Ordering::SeqCst),
        report.unhandled_exception,
    );
    report.result
}

fn spawn_async_tool_workers(name: &str, count: usize, rx: mpsc::Receiver<AsyncToolJob>, db: &str) {
    let rx = Arc::new(Mutex::new(rx));
    for i in 0..count.max(1) {
        let rx = rx.clone();
        let db = db.to_string();
        let thread_name = format!("{name}-{i}");
        thread::Builder::new()
            .name(thread_name.clone())
            .spawn(move || async_tool_worker_loop(rx, db, i))
            .unwrap_or_else(|_| panic!("spawn {thread_name}"));
    }
}

fn async_tool_worker_loop(rx: Arc<Mutex<mpsc::Receiver<AsyncToolJob>>>, db: String, id: usize) {
    if let Err(e) = host::install(&db) {
        eprintln!("[async tool worker {id}] host init: {e}");
        return;
    }
    runtime::init_v8();
    let near_heap_limit = AtomicBool::new(false);
    let mut isolate = v8::Isolate::new(v8::CreateParams::default());
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Auto);
    snapshots::install_failure_hooks(&mut isolate, &near_heap_limit);

    loop {
        let job = {
            let lock = rx.lock().unwrap();
            match lock.recv() {
                Ok(j) => j,
                Err(_) => break,
            }
        };
        let result = if let Some(result) =
            cdp::handle().and_then(|h| h.run_if_attached(&job.input, Some(job.agent_run.clone())))
        {
            result
        } else {
            run_async_tool_job(
                &mut isolate,
                &near_heap_limit,
                &job.bundle,
                &job.input,
                job.agent_run,
            )
        };
        let _ = job.response.send(result);
    }
}

fn run_async_tool_job(
    isolate: &mut v8::Isolate,
    near_heap_limit: &AtomicBool,
    bundle: &str,
    input: &str,
    agent_run: AgentRunHandler,
) -> Result<String, String> {
    near_heap_limit.store(false, Ordering::SeqCst);
    let report = runtime::run_js_async_report_in(isolate, bundle, input, agent_run);
    snapshots::record_if_triggered(
        isolate,
        input,
        bundle,
        &report.result,
        near_heap_limit.load(Ordering::SeqCst),
        report.unhandled_exception,
    );
    report.result
}

// Read-only commands skip the per-chat lock so they can overlap with an
// in-flight step for the same chat. They also use reserved worker lanes:
// fast chat/UI refreshes should not queue behind long agent/tool work, and
// whole-store scans should not queue ahead of fast refreshes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Lane {
    Write,
    FastRead,
    ScanRead,
}

const FAST_READ_ONLY_COMMANDS: &[&str] = &[
    "describe",
    "dump",
    "chats",
    "fs-list",
    "fs-read",
    "chat-recent-paths",
    "chat-export",
    "chat-models",
    "schema",
    "compactions",
    "mcp-list",
    "mcp-tools",
    "ui-list",
    "ui-bundle",
    "ui-chat",
    "ui-state-get",
    // Must skip the per-chat write lock: a running driver owns that lock,
    // and interrupt needs to reach TS so it can return a driver action that
    // aborts that driver.
    "interrupt",
    "help",
];

const SCAN_READ_ONLY_COMMANDS: &[&str] = &["memory-query", "triples", "vocabulary"];

fn route_input(input: &str) -> (Lane, Option<String>) {
    let Some(v) = parse_input(input) else {
        return (Lane::Write, None);
    };
    let command = command_from(&v);
    let lane = lane_for(command);
    let lock_key = (lane == Lane::Write).then(|| write_lock_key(command, &v));
    (lane, lock_key)
}

fn lane_for(command: &str) -> Lane {
    if FAST_READ_ONLY_COMMANDS.contains(&command) {
        Lane::FastRead
    } else if SCAN_READ_ONLY_COMMANDS.contains(&command) {
        Lane::ScanRead
    } else {
        Lane::Write
    }
}

fn write_lock_key(command: &str, v: &serde_json::Value) -> String {
    if let Some(argv) = v.get("argv").and_then(|x| x.as_array()) {
        return argv
            .get(1)
            .and_then(|x| x.as_str())
            .map(|chat_id| format!("chat:{chat_id}"))
            .unwrap_or_else(|| "global".to_string());
    }
    if let Some(chat_id) = v.get("chatId").and_then(|x| x.as_str()) {
        return format!("chat:{chat_id}");
    }
    // Wiping a chat graph touches the same fact-set the driver writes to;
    // route it through the per-chat lock so it can't race a running step.
    if command == "graph-rm"
        && let Some(graph) = v.get("graph").and_then(|x| x.as_str())
        && let Some(rest) = graph.strip_prefix("chat:")
    {
        return format!("chat:{rest}");
    }
    "global".to_string()
}

fn parse_input(input: &str) -> Option<serde_json::Value> {
    serde_json::from_str(input).ok()
}

fn command_from(v: &serde_json::Value) -> &str {
    v.get("argv")
        .and_then(|x| x.as_array())
        .and_then(|argv| argv.first())
        .and_then(|x| x.as_str())
        .or_else(|| v.get("command").and_then(|x| x.as_str()))
        .unwrap_or("describe")
}
