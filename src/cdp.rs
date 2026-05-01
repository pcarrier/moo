// Chrome DevTools Protocol server. Exposes one debuggable target backed by a
// dedicated V8 isolate on its own thread. Discovery endpoints live on the same
// listener as the WebSocket so a single `--bind-cdp ADDR` flag is enough.
//
// Architecture:
//
//   listener thread  →  per-connection thread (HTTP, then WS reader)
//                        │
//                        │   PendingSession { in_rx, out_tx }
//                        ▼
//                    inspector thread (owns V8 isolate + V8Inspector)
//                        │
//                        ├── pulls protocol frames from `in_rx`
//                        ├── dispatches them to V8InspectorSession
//                        └── outgoing frames go through ChannelImpl → `out_tx`
//                                                                       │
//                              writer thread of conn ◀──────────────────┘
//
// One DevTools client at a time. A new connection enqueues a fresh session;
// the inspector thread serves them one after the other.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::ptr::NonNull;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use rusty_v8 as v8;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use v8::UniquePtr;
use v8::inspector::{
    Channel, ChannelImpl, StringBuffer, StringView, V8Inspector, V8InspectorClient,
    V8InspectorClientImpl, V8InspectorClientTrustLevel, V8InspectorSession,
};

use crate::host;
use crate::runtime;
use crate::runtime::AgentRunHandler;
use crate::server::BundleProvider;

const WS_GUID: &[u8] = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const CONTEXT_GROUP_ID: i32 = 1;
const DEFAULT_TARGET_ID: &str = "moo-harness";
const DEFAULT_TARGET_TITLE: &str = "moo harness";
const TARGET_PREFIX: &str = "chat-";
const SOURCE_MAP_PATH: &str = "/harness.js.map";
const INTERNAL_PROFILER_ENABLE_ID: i64 = -10_001;
const INTERNAL_PROFILER_START_ID: i64 = -10_002;
const INTERNAL_PROFILER_STOP_ID: i64 = -10_003;

pub fn spawn(
    addr: &str,
    bundle: BundleProvider,
    source_map_path: Option<PathBuf>,
    db_path: String,
) -> Result<(), String> {
    let listener = TcpListener::bind(addr).map_err(|e| format!("cdp bind {addr}: {e}"))?;
    let local = listener
        .local_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| addr.to_string());
    eprintln!("cdp: listening on http://{local} — DevTools targets at http://{local}/json/list");

    // Linked source map for the bundle. We re-read on every request so it
    // tracks the current bundle through --watch.
    let map_path: Option<Arc<PathBuf>> = source_map_path.map(Arc::new);

    let (session_tx, session_rx) = mpsc::channel::<PendingSession>();
    let (inspect_tx, inspect_rx) = mpsc::channel::<InspectRequest>();
    let active_target = Arc::new(Mutex::new(None::<TargetSpec>));
    let _ = CDP_HANDLE.set(CdpHandle {
        inspect_tx,
        active_target: active_target.clone(),
    });

    {
        let bundle = bundle.clone();
        let advertised = local.clone();
        let map_for_inspector = map_path.clone();
        let inspector_active_target = active_target.clone();
        let inspector_db_path = db_path.clone();
        thread::Builder::new()
            .name("moo-cdp-isolate".into())
            .spawn(move || {
                run_inspector_thread(
                    session_rx,
                    inspect_rx,
                    bundle,
                    advertised,
                    map_for_inspector,
                    inspector_active_target,
                    inspector_db_path,
                )
            })
            .map_err(|e| format!("spawn cdp isolate thread: {e}"))?;
    }

    let advertised = local.clone();
    let listener_active_target = active_target.clone();
    thread::Builder::new()
        .name("moo-cdp-listener".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let session_tx = session_tx.clone();
                let advertised = advertised.clone();
                let map_path = map_path.clone();
                let bundle = bundle.clone();
                let db_path = db_path.clone();
                let active_target = listener_active_target.clone();
                thread::spawn(move || {
                    let _ = handle_conn(
                        stream,
                        &advertised,
                        session_tx,
                        map_path,
                        bundle,
                        db_path,
                        active_target,
                    );
                });
            }
        })
        .map_err(|e| format!("spawn cdp listener thread: {e}"))?;

    Ok(())
}

struct PendingSession {
    target: TargetSpec,
    in_rx: Receiver<Vec<u8>>,
    out_tx: Sender<Vec<u8>>,
}

#[derive(Clone, Debug)]
struct TargetSpec {
    id: String,
    title: String,
    chat_id: Option<String>,
}

impl TargetSpec {
    fn default_target() -> Self {
        Self {
            id: DEFAULT_TARGET_ID.to_string(),
            title: DEFAULT_TARGET_TITLE.to_string(),
            chat_id: None,
        }
    }
}

struct InspectRequest {
    input: String,
    response: Sender<Result<String, String>>,
    async_agent_run: Option<AgentRunHandler>,
}

#[derive(Clone)]
pub struct CdpHandle {
    inspect_tx: Sender<InspectRequest>,
    active_target: Arc<Mutex<Option<TargetSpec>>>,
}

static CDP_HANDLE: OnceLock<CdpHandle> = OnceLock::new();

pub fn handle() -> Option<CdpHandle> {
    CDP_HANDLE.get().cloned()
}

impl CdpHandle {
    pub fn run_if_attached(
        &self,
        input: &str,
        async_agent_run: Option<AgentRunHandler>,
    ) -> Option<Result<String, String>> {
        let chat_id = chat_id_from_input(input)?;
        let attached = self.active_target.lock().unwrap().clone();
        if attached
            .as_ref()
            .and_then(|target| target.chat_id.as_deref())
            != Some(chat_id.as_str())
        {
            return None;
        }
        let (response, rx) = mpsc::channel();
        let request = InspectRequest {
            input: input.to_string(),
            response,
            async_agent_run,
        };
        if self.inspect_tx.send(request).is_err() {
            return Some(Err("cdp inspector thread is not running".to_string()));
        }
        Some(match rx.recv() {
            Ok(result) => result,
            Err(_) => Err("cdp inspector thread dropped inspected job".to_string()),
        })
    }
}

fn chat_id_from_input(input: &str) -> Option<String> {
    let v: Value = serde_json::from_str(input).ok()?;
    v.get("chatId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            v.pointer("/state/chatId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            v.pointer("/state/state/chatId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
}

// =========================================================================
// Inspector thread: owns the V8 isolate, V8Inspector, V8InspectorClient, and
// (per-session) V8InspectorSession.
// =========================================================================

// Shared state between the inspector thread's main loop and the
// V8InspectorClientImpl. Both run on the same thread, so single-threaded
// interior mutability is enough.
#[derive(Clone)]
struct CdpResource {
    content: String,
    content_type: &'static str,
}

struct Shared {
    paused: Cell<bool>,
    in_rx: RefCell<Option<Receiver<Vec<u8>>>>,
    session: Cell<Option<NonNull<V8InspectorSession>>>,
    // Set once at thread startup so callbacks can reconstruct the Isolate
    // handle when V8 calls back into the client without a scope arg
    // (ensure_default_context_in_group).
    isolate_ptr: Cell<Option<v8::UnsafeRawIsolatePtr>>,
    // The Global handle for the current session's default context. Lives
    // for the duration of one DevTools session.
    default_context: RefCell<Option<v8::Global<v8::Context>>>,
    out_tx: RefCell<Option<Sender<Vec<u8>>>>,
    tracing_return_stream: Cell<bool>,
    tracing_start_ts: Cell<u64>,
    trace_stream_counter: Cell<u64>,
    io_streams: RefCell<HashMap<String, String>>,
    io_stream_counter: Cell<u64>,
    cdp_resources: RefCell<HashMap<String, CdpResource>>,
}

// SAFETY: Shared is only ever accessed on the inspector thread. We hold a
// `*const Shared` inside the V8InspectorClient (which V8 keeps alive across
// callbacks); the value the pointer addresses lives for the entire lifetime
// of the inspector thread.
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

fn now_micros() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}

fn run_inspector_thread(
    session_rx: Receiver<PendingSession>,
    inspect_rx: Receiver<InspectRequest>,
    bundle: BundleProvider,
    advertised_host: String,
    map_path: Option<Arc<PathBuf>>,
    active_target: Arc<Mutex<Option<TargetSpec>>>,
    db_path: String,
) {
    if let Err(e) = host::install(&db_path) {
        eprintln!("cdp: host init: {e}");
        return;
    }
    runtime::init_v8();

    // Stable address for the shared cell — the inspector client and the
    // pause loop both hold raw pointers into it.
    let shared = Box::new(Shared {
        paused: Cell::new(false),
        in_rx: RefCell::new(None),
        session: Cell::new(None),
        isolate_ptr: Cell::new(None),
        default_context: RefCell::new(None),
        out_tx: RefCell::new(None),
        tracing_return_stream: Cell::new(false),
        tracing_start_ts: Cell::new(0),
        trace_stream_counter: Cell::new(0),
        io_streams: RefCell::new(HashMap::new()),
        io_stream_counter: Cell::new(0),
        cdp_resources: RefCell::new(HashMap::new()),
    });
    let shared_ptr: *const Shared = &*shared;

    let mut isolate = v8::Isolate::new(v8::CreateParams::default());
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Auto);
    // Stash the raw pointer; the inspector callbacks need it to reconstruct
    // an Isolate without a borrow on this stack frame.
    shared
        .isolate_ptr
        .set(Some(unsafe { isolate.as_raw_isolate_ptr() }));

    // The inspector client and V8 inspector live for the lifetime of this
    // thread; the per-session V8InspectorSession is created/dropped as
    // DevTools connects and disconnects.
    let client = V8InspectorClient::new(Box::new(InspectorClient { shared: shared_ptr }));
    let inspector = V8Inspector::create(&mut isolate, client);

    // Build a context up front so DevTools sees a "default" execution context
    // it can evaluate against. Recreated per session to keep state clean.
    loop {
        let pending = match session_rx.recv() {
            Ok(p) => p,
            Err(_) => return, // sender dropped; server shutting down
        };
        // Pull the latest bundle source per session so live-reloaded code
        // shows up the next time DevTools connects.
        let source = bundle();
        // Only point DevTools at a sourceMappingURL when the .map file is
        // actually on disk; otherwise the URL would 404 and DevTools would
        // log a noisy fetch error in the console.
        let map_resource = map_path.as_deref().and_then(|p| {
            fs::read_to_string(p).ok().map(|content| {
                (
                    format!("http://{advertised_host}{SOURCE_MAP_PATH}"),
                    content,
                )
            })
        });
        let map_url = map_resource.as_ref().map(|(url, _)| url.as_str());
        run_session(
            &mut isolate,
            &inspector,
            &shared,
            shared_ptr,
            pending,
            &inspect_rx,
            &active_target,
            &source,
            &format!("http://{advertised_host}/harness.js"),
            map_url,
            map_resource.as_ref().map(|(_, content)| content.as_str()),
        );
    }
}

fn run_session(
    isolate: &mut v8::Isolate,
    inspector: &V8Inspector,
    shared: &Shared,
    shared_ptr: *const Shared,
    pending: PendingSession,
    inspect_rx: &Receiver<InspectRequest>,
    active_target: &Arc<Mutex<Option<TargetSpec>>>,
    bundle_source: &str,
    script_url: &str,
    source_map_url: Option<&str>,
    source_map_content: Option<&str>,
) {
    {
        let mut resources = shared.cdp_resources.borrow_mut();
        resources.clear();
        resources.insert(
            script_url.to_string(),
            CdpResource {
                content: bundle_source.to_string(),
                content_type: "application/javascript; charset=utf-8",
            },
        );
        if let (Some(url), Some(content)) = (source_map_url, source_map_content) {
            resources.insert(
                url.to_string(),
                CdpResource {
                    content: content.to_string(),
                    content_type: "application/json; charset=utf-8",
                },
            );
        }
    }

    v8::scope!(let handle_scope, isolate);
    let context = v8::Context::new(handle_scope, Default::default());

    // Stash a Global handle so ensure_default_context_in_group can hand a
    // Local back to V8 from outside any explicit scope. Take it before
    // ContextScope::new mutably borrows handle_scope.
    let context_global = v8::Global::new(handle_scope.as_ref(), context);
    *shared.default_context.borrow_mut() = Some(context_global);

    // Tell the inspector about the context so DevTools can target it.
    let target = pending.target.clone();
    let origin = target
        .chat_id
        .as_deref()
        .map(|cid| format!("moo://chat/{cid}"))
        .unwrap_or_else(|| "moo://harness".to_string());
    let aux_data = json!({
        "isDefault": true,
        "name": target.title,
        "origin": origin,
        "type": "node"
    })
    .to_string();
    inspector.context_created(
        context,
        CONTEXT_GROUP_ID,
        StringView::from(target.title.as_bytes()),
        StringView::from(aux_data.as_bytes()),
    );

    // Enter the context to install globals + parse the bundle. We drop the
    // ContextScope before pumping messages — V8 inspector enters the right
    // context internally for each Runtime/Debugger command.
    {
        let mut scope = v8::ContextScope::new(handle_scope, context);
        let globals = if target.chat_id.is_some() {
            runtime::install_globals(&mut scope)
        } else {
            runtime::install_minimal_globals(&mut scope)
        };
        if let Err(e) = globals {
            eprintln!("cdp: install globals: {e}");
        }
        if !bundle_source.is_empty() {
            eval_bundle_in_scope(&mut scope, bundle_source, script_url, source_map_url);
        }
    }

    *shared.out_tx.borrow_mut() = Some(pending.out_tx.clone());
    let channel = Channel::new(Box::new(OutboundChannel {
        out_tx: pending.out_tx,
        shared: shared_ptr,
    }));
    let session = inspector.connect(
        CONTEXT_GROUP_ID,
        channel,
        StringView::empty(),
        V8InspectorClientTrustLevel::FullyTrusted,
    );

    *shared.in_rx.borrow_mut() = Some(pending.in_rx);
    let session_box: Box<V8InspectorSession> = Box::new(session);
    let session_ptr =
        NonNull::new(Box::as_ref(&session_box) as *const V8InspectorSession as *mut _).unwrap();
    shared.session.set(Some(session_ptr));
    shared.paused.set(false);

    *active_target.lock().unwrap() = Some(target.clone());
    pump_messages(shared_ptr, inspect_rx, target.chat_id.as_deref());
    *active_target.lock().unwrap() = None;

    shared.session.set(None);
    shared.paused.set(false);
    drop(session_box);
    *shared.in_rx.borrow_mut() = None;
    *shared.out_tx.borrow_mut() = None;
    shared.io_streams.borrow_mut().clear();
    shared.cdp_resources.borrow_mut().clear();

    inspector.context_destroyed(context);
    *shared.default_context.borrow_mut() = None;
}

// Compile + run the bundle in the inspector context. Errors are surfaced to
// the server log but don't tear down the session — the user can still poke
// at whatever did get defined before the throw.
fn eval_bundle_in_scope(
    scope: &mut v8::PinScope,
    source: &str,
    script_url: &str,
    source_map_url: Option<&str>,
) {
    // Give V8 an explicit ScriptOrigin instead of relying on trailing
    // pragmas. DevTools receives the URL and sourceMapURL in
    // Debugger.scriptParsed immediately, which makes source-map loading
    // reliable even if the bundled source already has its own comments.
    v8::tc_scope!(let tc, scope);
    let Some(code) = v8::String::new(tc, source) else {
        eprintln!("cdp: bundle source too large to load in inspector");
        return;
    };
    let Some(resource_name) = v8::String::new(tc, script_url) else {
        eprintln!("cdp: script URL too large to load in inspector");
        return;
    };
    let source_map = match source_map_url {
        Some(url) => match v8::String::new(tc, url) {
            Some(url) => Some(url.into()),
            None => {
                eprintln!("cdp: source map URL too large to load in inspector");
                None
            }
        },
        None => None,
    };
    let origin = v8::ScriptOrigin::new(
        tc,
        resource_name.into(),
        0,
        0,
        false,
        -1,
        source_map,
        false,
        false,
        false,
        None,
    );
    let script = match v8::Script::compile(tc, code, Some(&origin)) {
        Some(s) => s,
        None => {
            let msg = tc
                .exception()
                .map(|e| e.to_rust_string_lossy(tc))
                .unwrap_or_else(|| "unknown".into());
            eprintln!("cdp: bundle compile error: {msg}");
            return;
        }
    };
    if script.run(tc).is_none() {
        let msg = tc
            .exception()
            .map(|e| e.to_rust_string_lossy(tc))
            .unwrap_or_else(|| "unknown".into());
        eprintln!("cdp: bundle top-level threw: {msg}");
    }
}

// Drains the active session's incoming queue, dispatching CDP frames to V8.
// Returns when the connection drops (recv → Err) or the session is otherwise
// torn down.
fn pump_messages(
    shared: *const Shared,
    inspect_rx: &Receiver<InspectRequest>,
    attached_chat_id: Option<&str>,
) {
    loop {
        while let Ok(request) = inspect_rx.try_recv() {
            run_inspected_job(shared, request, attached_chat_id);
        }
        let msg = {
            // Borrow only long enough to call recv(); recv() blocks but only
            // holds the immutable borrow of the RefCell. Reentrant calls
            // (from run_message_loop_on_pause) take additional immutable
            // borrows, which is fine.
            let borrow = unsafe { (*shared).in_rx.borrow() };
            let Some(rx) = borrow.as_ref() else { return };
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(bytes) => bytes,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        };

        if handle_frontend_protocol_message(shared, &msg) {
            continue;
        }

        let Some(session_ptr) = (unsafe { &*shared }).session.get() else {
            return;
        };
        let session = unsafe { session_ptr.as_ref() };
        let view = StringView::from(msg.as_slice());
        session.dispatch_protocol_message(view);
    }
}

fn run_inspected_job(
    shared: *const Shared,
    request: InspectRequest,
    attached_chat_id: Option<&str>,
) {
    let request_chat_id = chat_id_from_input(&request.input);
    if request_chat_id.as_deref() != attached_chat_id {
        let _ = request.response.send(Err(
            "cdp inspected job does not match attached chat".to_string()
        ));
        return;
    }

    let Some(context_global) = (unsafe { (*shared).default_context.borrow() })
        .as_ref()
        .cloned()
    else {
        let _ = request
            .response
            .send(Err("cdp target has no active V8 context".to_string()));
        return;
    };
    let Some(isolate_ptr) = (unsafe { (*shared).isolate_ptr.get() }) else {
        let _ = request
            .response
            .send(Err("cdp isolate is not available".to_string()));
        return;
    };
    if isolate_ptr.is_null() {
        let _ = request
            .response
            .send(Err("cdp isolate pointer is null".to_string()));
        return;
    }

    let mut isolate = unsafe { v8::Isolate::from_raw_isolate_ptr_unchecked(isolate_ptr) };
    v8::scope!(let scope, &mut isolate);
    let context = v8::Local::new(scope, context_global);
    let mut scope = v8::ContextScope::new(scope, context);
    let report = match request.async_agent_run {
        Some(agent_run) => {
            runtime::run_loaded_main_async_in_scope(&mut scope, &request.input, agent_run)
        }
        None => runtime::run_loaded_main_in_scope(&mut scope, &request.input),
    };
    let _ = request.response.send(report.result);
}

fn handle_frontend_protocol_message(shared: *const Shared, msg: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(msg) else {
        return false;
    };
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        return false;
    };
    let id = value.get("id").cloned();
    let params = value.get("params").cloned().unwrap_or_else(|| json!({}));

    match method {
        "Schema.getDomains" => {
            send_response(
                shared,
                id,
                json!({
                    "domains": [
                        {"name":"Runtime","version":"1.3"},
                        {"name":"Debugger","version":"1.3"},
                        {"name":"Profiler","version":"1.3"},
                        {"name":"HeapProfiler","version":"1.3"},
                        {"name":"Tracing","version":"1.3"},
                        {"name":"IO","version":"1.3"}
                    ]
                }),
            );
            true
        }
        "Browser.getVersion" => {
            send_response(
                shared,
                id,
                json!({
                    "protocolVersion": "1.3",
                    "product": format!("moo/{}", env!("CARGO_PKG_VERSION")),
                    "revision": "",
                    "userAgent": "moo",
                    "jsVersion": v8::V8::get_version()
                }),
            );
            true
        }
        "Tracing.getCategories" => {
            send_response(
                shared,
                id,
                json!({
                    "categories": [
                        "v8",
                        "devtools.timeline",
                        "disabled-by-default-v8.cpu_profiler"
                    ]
                }),
            );
            true
        }
        "Tracing.start" => {
            let return_stream = params
                .get("transferMode")
                .and_then(Value::as_str)
                .map(|m| m == "ReturnAsStream")
                .unwrap_or(false);
            unsafe {
                (*shared).tracing_return_stream.set(return_stream);
                (*shared).tracing_start_ts.set(now_micros());
            }
            // Chrome's Performance panel records through Tracing.*. A plain
            // V8 inspector target only implements Profiler.*, so bridge the
            // two: start V8's CPU profiler here and translate the profile into
            // trace events when Tracing.end arrives.
            dispatch_internal_protocol(
                shared,
                INTERNAL_PROFILER_ENABLE_ID,
                "Profiler.enable",
                json!({}),
            );
            dispatch_internal_protocol(
                shared,
                INTERNAL_PROFILER_START_ID,
                "Profiler.start",
                json!({}),
            );
            send_response(shared, id, json!({}));
            true
        }
        "Tracing.end" => {
            send_response(shared, id, json!({}));
            if !dispatch_internal_protocol(
                shared,
                INTERNAL_PROFILER_STOP_ID,
                "Profiler.stop",
                json!({}),
            ) {
                finish_tracing(shared, None);
            }
            true
        }
        "IO.read" => {
            let handle = params.get("handle").and_then(Value::as_str).unwrap_or("");
            let chunk =
                unsafe { (*shared).io_streams.borrow_mut().remove(handle) }.unwrap_or_default();
            send_response(
                shared,
                id,
                json!({
                    "base64Encoded": false,
                    "data": chunk,
                    "eof": true
                }),
            );
            true
        }
        "IO.close" => {
            if let Some(handle) = params.get("handle").and_then(Value::as_str) {
                unsafe { (*shared).io_streams.borrow_mut().remove(handle) };
            }
            send_response(shared, id, json!({}));
            true
        }
        "Page.getResourceContent" => {
            let url = params.get("url").and_then(Value::as_str).unwrap_or("");
            match cdp_resource_for_url(shared, url) {
                Some(resource) => send_response(
                    shared,
                    id,
                    json!({"content": resource.content, "base64Encoded": false}),
                ),
                None => send_protocol_error(shared, id, -32000, "resource not found"),
            }
            true
        }
        "Page.loadNetworkResource" | "Network.loadNetworkResource" => {
            let url = params.get("url").and_then(Value::as_str).unwrap_or("");
            match cdp_resource_for_url(shared, url) {
                Some(resource) => {
                    let handle = new_io_stream(shared, resource.content.clone());
                    send_response(
                        shared,
                        id,
                        json!({
                            "resource": {
                                "success": true,
                                "httpStatusCode": 200,
                                "stream": handle,
                                "headers": [
                                    {"name": "Content-Type", "value": resource.content_type},
                                    {"name": "Access-Control-Allow-Origin", "value": "*"}
                                ]
                            }
                        }),
                    );
                }
                None => send_response(
                    shared,
                    id,
                    json!({
                        "resource": {
                            "success": false,
                            "netError": -6,
                            "netErrorName": "net::ERR_FILE_NOT_FOUND",
                            "httpStatusCode": 404
                        }
                    }),
                ),
            }
            true
        }
        // The Chrome frontend often sends these browser/page-domain requests
        // while opening Performance. They are not meaningful for a bare V8
        // target, but acknowledging them keeps the panel usable.
        "Log.enable"
        | "Network.enable"
        | "Page.enable"
        | "Page.setLifecycleEventsEnabled"
        | "Performance.enable"
        | "Performance.disable" => {
            send_response(shared, id, json!({}));
            true
        }
        "Performance.getMetrics" => {
            send_response(shared, id, json!({ "metrics": [] }));
            true
        }
        "Page.getResourceTree" => {
            send_response(
                shared,
                id,
                json!({
                    "frameTree": {
                        "frame": {
                            "id": DEFAULT_TARGET_ID,
                            "loaderId": DEFAULT_TARGET_ID,
                            "url": "moo://harness",
                            "securityOrigin": "moo://harness",
                            "mimeType": "text/html"
                        },
                        "resources": cdp_resource_tree(shared)
                    }
                }),
            );
            true
        }
        _ => false,
    }
}

fn cdp_resource_for_url(shared: *const Shared, url: &str) -> Option<CdpResource> {
    let resources = unsafe { (*shared).cdp_resources.borrow() };
    if let Some(resource) = resources.get(url) {
        return Some(resource.clone());
    }
    let requested_path = resource_path(url);
    resources
        .iter()
        .find(|(known, _)| resource_path(known) == requested_path)
        .map(|(_, resource)| resource.clone())
}

fn resource_path(url: &str) -> &str {
    let without_query = url.split_once('?').map(|(p, _)| p).unwrap_or(url);
    if let Some(after_scheme) = without_query
        .strip_prefix("http://")
        .or_else(|| without_query.strip_prefix("https://"))
    {
        return after_scheme
            .find('/')
            .map(|idx| &after_scheme[idx..])
            .unwrap_or("/");
    }
    without_query
}

fn cdp_resource_tree(shared: *const Shared) -> Value {
    let resources = unsafe { (*shared).cdp_resources.borrow() };
    Value::Array(
        resources
            .iter()
            .map(|(url, resource)| {
                let kind = if resource.content_type.starts_with("application/javascript") {
                    "Script"
                } else {
                    "Other"
                };
                json!({"url": url, "type": kind, "mimeType": resource.content_type})
            })
            .collect(),
    )
}

fn new_io_stream(shared: *const Shared, content: String) -> String {
    let n = unsafe { (*shared).io_stream_counter.get() + 1 };
    unsafe { (*shared).io_stream_counter.set(n) };
    let handle = format!("resource-{n}");
    unsafe {
        (*shared)
            .io_streams
            .borrow_mut()
            .insert(handle.clone(), content)
    };
    handle
}

fn dispatch_internal_protocol(shared: *const Shared, id: i64, method: &str, params: Value) -> bool {
    let Some(session_ptr) = (unsafe { &*shared }).session.get() else {
        return false;
    };
    let session = unsafe { session_ptr.as_ref() };
    let request = json!({"id": id, "method": method, "params": params}).to_string();
    let view = StringView::from(request.as_bytes());
    session.dispatch_protocol_message(view);
    true
}

fn handle_internal_response(shared: *const Shared, msg: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(msg) else {
        return false;
    };
    let Some(id) = value.get("id").and_then(Value::as_i64) else {
        return false;
    };
    match id {
        INTERNAL_PROFILER_ENABLE_ID | INTERNAL_PROFILER_START_ID => true,
        INTERNAL_PROFILER_STOP_ID => {
            let profile = value.get("result").and_then(|r| r.get("profile")).cloned();
            finish_tracing(shared, profile);
            true
        }
        _ => false,
    }
}

fn finish_tracing(shared: *const Shared, profile: Option<Value>) {
    let trace = trace_json(shared, profile.clone());
    let return_stream = unsafe { (*shared).tracing_return_stream.get() };
    if return_stream {
        let n = unsafe { (*shared).trace_stream_counter.get() + 1 };
        unsafe { (*shared).trace_stream_counter.set(n) };
        let handle = format!("trace-{n}");
        unsafe {
            (*shared)
                .io_streams
                .borrow_mut()
                .insert(handle.clone(), trace)
        };
        send_notification(
            shared,
            json!({
                "method": "Tracing.tracingComplete",
                "params": {"dataLossOccurred": false, "stream": handle}
            }),
        );
    } else {
        let events = trace_events(shared, profile);
        send_notification(
            shared,
            json!({
                "method": "Tracing.dataCollected",
                "params": {"value": events}
            }),
        );
        send_notification(
            shared,
            json!({
                "method": "Tracing.tracingComplete",
                "params": {"dataLossOccurred": false}
            }),
        );
    }
}

fn trace_events(shared: *const Shared, profile: Option<Value>) -> Value {
    let start_ts = unsafe { (*shared).tracing_start_ts.get() };
    let ts = if start_ts == 0 {
        now_micros()
    } else {
        start_ts
    };
    let end_ts = now_micros();
    let mut events = vec![
        json!({"name":"process_name","ph":"M","pid":1,"tid":1,"ts":ts,"args":{"name":"moo"}}),
        json!({"name":"thread_name","ph":"M","pid":1,"tid":1,"ts":ts,"args":{"name":"v8 inspector"}}),
        json!({"name":"TracingStartedInBrowser","ph":"I","s":"t","pid":1,"tid":1,"ts":ts,"args":{"data":{"sessionId":DEFAULT_TARGET_ID}}}),
    ];
    if let Some(profile) = profile {
        events.push(json!({
            "cat": "disabled-by-default-v8.cpu_profiler",
            "name": "Profile",
            "ph": "P",
            "id": "0x1",
            "pid": 1,
            "tid": 1,
            "ts": ts,
            "args": {"data": {"startTime": profile.get("startTime").cloned().unwrap_or(json!(ts))}}
        }));
        events.push(json!({
            "cat": "disabled-by-default-v8.cpu_profiler",
            "name": "ProfileChunk",
            "ph": "P",
            "id": "0x1",
            "pid": 1,
            "tid": 1,
            "ts": end_ts,
            "args": {"data": {"cpuProfile": profile}}
        }));
    }
    Value::Array(events)
}

fn trace_json(shared: *const Shared, profile: Option<Value>) -> String {
    json!({
        "traceEvents": trace_events(shared, profile),
        "metadata": {"source": "moo cdp"}
    })
    .to_string()
}
fn send_response(shared: *const Shared, id: Option<Value>, result: Value) {
    let Some(id) = id else { return };
    send_json_to_frontend(shared, json!({"id": id, "result": result}));
}

fn send_protocol_error(shared: *const Shared, id: Option<Value>, code: i64, message: &str) {
    let Some(id) = id else { return };
    send_json_to_frontend(
        shared,
        json!({"id": id, "error": {"code": code, "message": message}}),
    );
}

fn send_notification(shared: *const Shared, value: Value) {
    send_json_to_frontend(shared, value);
}

fn send_json_to_frontend(shared: *const Shared, value: Value) {
    let bytes = value.to_string().into_bytes();
    let borrow = unsafe { (*shared).out_tx.borrow() };
    if let Some(tx) = borrow.as_ref() {
        let _ = tx.send(bytes);
    }
}

// =========================================================================
// V8InspectorClient: the callback surface V8 uses to talk back to us. Most
// callbacks are no-ops; the important one is the pause loop.
// =========================================================================

struct InspectorClient {
    shared: *const Shared,
}

// SAFETY: the pointer is only dereferenced on the inspector thread; the
// Shared it points to outlives the V8InspectorClient (both die when the
// inspector thread exits).
unsafe impl Send for InspectorClient {}
unsafe impl Sync for InspectorClient {}

impl V8InspectorClientImpl for InspectorClient {
    fn run_message_loop_on_pause(&self, _context_group_id: i32) {
        // V8 has paused execution and needs us to keep dispatching protocol
        // messages until DevTools tells it to resume (which triggers
        // quit_message_loop_on_pause). Reuse the same pump as the main loop;
        // it'll exit when `paused` flips back to false (we re-check per
        // iteration via session/in_rx state).
        unsafe {
            (*self.shared).paused.set(true);
        }
        // Local pump: differs from the outer pump only in that it bails out
        // when `paused` flips to false, even if the channel still has work.
        loop {
            let paused = unsafe { (*self.shared).paused.get() };
            if !paused {
                return;
            }
            let msg = {
                let borrow = unsafe { (*self.shared).in_rx.borrow() };
                let Some(rx) = borrow.as_ref() else { return };
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(bytes) => bytes,
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => {
                        unsafe { (*self.shared).paused.set(false) };
                        return;
                    }
                }
            };
            if handle_frontend_protocol_message(self.shared, &msg) {
                continue;
            }

            let Some(session_ptr) = (unsafe { &*self.shared }).session.get() else {
                return;
            };
            let session = unsafe { session_ptr.as_ref() };
            let view = StringView::from(msg.as_slice());
            session.dispatch_protocol_message(view);
        }
    }

    fn quit_message_loop_on_pause(&self) {
        unsafe { (*self.shared).paused.set(false) };
    }

    fn run_if_waiting_for_debugger(&self, _context_group_id: i32) {}

    fn ensure_default_context_in_group(
        &self,
        _context_group_id: i32,
    ) -> Option<v8::Local<'_, v8::Context>> {
        // V8 calls this when a CDP request (e.g. Runtime.evaluate without an
        // explicit contextId) needs the default execution context. We have
        // a Global<Context> kept alive for the active session; convert it
        // to a Local in the V8 handle scope V8 has already set up before
        // calling us.
        unsafe {
            let isolate_ptr = (*self.shared).isolate_ptr.get()?;
            if isolate_ptr.is_null() {
                return None;
            }
            let context_borrow = (*self.shared).default_context.borrow();
            let global = context_borrow.as_ref()?;

            let mut isolate = v8::Isolate::from_raw_isolate_ptr_unchecked(isolate_ptr);
            // CallbackScope wraps V8's *current* HandleScope (it does not push
            // a new one for `&mut Isolate`), so the Local we mint stays valid
            // for the duration of V8's enclosing C++ call frame — which is
            // precisely as long as V8 needs the returned pointer.
            v8::callback_scope!(unsafe scope, &mut isolate);
            let local = v8::Local::new(scope, global);
            Some(local.extend_lifetime_unchecked::<v8::Local<'_, v8::Context>>())
        }
    }
}

// =========================================================================
// ChannelImpl: V8 hands us outbound CDP messages here. We forward them to the
// per-connection writer thread via mpsc.
// =========================================================================

struct OutboundChannel {
    out_tx: Sender<Vec<u8>>,
    shared: *const Shared,
}

// SAFETY: outbound callbacks are made on the inspector thread, and the shared
// pointer targets the inspector thread's long-lived Shared value.
unsafe impl Send for OutboundChannel {}
unsafe impl Sync for OutboundChannel {}

impl ChannelImpl for OutboundChannel {
    fn send_response(&self, _call_id: i32, message: UniquePtr<StringBuffer>) {
        if let Some(buf) = message.as_ref() {
            let bytes = string_view_to_utf8(&buf.string());
            if !handle_internal_response(self.shared, &bytes) {
                let _ = self.out_tx.send(bytes);
            }
        }
    }
    fn send_notification(&self, message: UniquePtr<StringBuffer>) {
        if let Some(buf) = message.as_ref() {
            let _ = self.out_tx.send(string_view_to_utf8(&buf.string()));
        }
    }
    fn flush_protocol_notifications(&self) {}
}

fn string_view_to_utf8(view: &StringView) -> Vec<u8> {
    if let Some(bytes) = view.characters8() {
        return bytes.to_vec();
    }
    if let Some(units) = view.characters16() {
        return String::from_utf16_lossy(units).into_bytes();
    }
    Vec::new()
}

// =========================================================================
// HTTP / WebSocket front-end.
// =========================================================================

fn handle_conn(
    mut stream: TcpStream,
    advertised_host: &str,
    session_tx: Sender<PendingSession>,
    map_path: Option<Arc<PathBuf>>,
    bundle: BundleProvider,
    db_path: String,
    active_target: Arc<Mutex<Option<TargetSpec>>>,
) -> std::io::Result<()> {
    let read_clone = stream.try_clone()?;
    let mut reader = BufReader::new(read_clone);

    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let trimmed = request_line.trim_end_matches(['\r', '\n']);
    let mut parts = trimmed.splitn(3, ' ');
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();

    let mut upgrade_to: Option<String> = None;
    let mut ws_key: Option<String> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        let lower = trimmed.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("upgrade:") {
            upgrade_to = Some(rest.trim().to_string());
        } else if lower.starts_with("sec-websocket-key:")
            && let Some(idx) = trimmed.find(':')
        {
            ws_key = Some(trimmed[idx + 1..].trim().to_string());
        }
    }
    drop(reader);

    let path_only = request_target_path(&path);
    let is_ws_upgrade = upgrade_to
        .as_deref()
        .map(|u| u.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);

    if method != "GET" {
        return write_response(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain",
            b"GET only",
        );
    }

    if is_ws_upgrade && let Some(target_id) = path_only.strip_prefix("/ws/") {
        let key = ws_key.unwrap_or_default();
        let target = target_from_id(target_id, &db_path).unwrap_or_else(|| TargetSpec {
            id: target_id.to_string(),
            title: target_id.to_string(),
            chat_id: chat_id_from_target_id(target_id),
        });
        return handle_ws_upgrade(stream, &key, session_tx, target);
    }

    match path_only {
        "/json" | "/json/list" => write_response(
            &mut stream,
            "200 OK",
            "application/json; charset=utf-8",
            json_list(advertised_host, &db_path, &active_target).as_bytes(),
        ),
        "/json/version" => write_response(
            &mut stream,
            "200 OK",
            "application/json; charset=utf-8",
            json_version().as_bytes(),
        ),
        "/json/protocol" => write_response(
            &mut stream,
            "200 OK",
            "application/json; charset=utf-8",
            protocol_json().as_bytes(),
        ),
        "/harness.js" => write_response_with_cors(
            &mut stream,
            "200 OK",
            "application/javascript; charset=utf-8",
            bundle().as_bytes(),
        ),
        SOURCE_MAP_PATH => match map_path.as_deref() {
            Some(path) => match fs::read(path) {
                Ok(bytes) => write_response_with_cors(
                    &mut stream,
                    "200 OK",
                    "application/json; charset=utf-8",
                    &bytes,
                ),
                Err(_) => write_response_with_cors(
                    &mut stream,
                    "404 Not Found",
                    "text/plain",
                    b"source map not found",
                ),
            },
            None => write_response_with_cors(
                &mut stream,
                "404 Not Found",
                "text/plain",
                b"no bundle path configured",
            ),
        },
        _ => write_response(&mut stream, "404 Not Found", "text/plain", b"not found"),
    }
}

// Source maps are fetched by DevTools running at a different origin
// (devtools://...), so the response needs `Access-Control-Allow-Origin: *`
// or DevTools blocks it as a CORS error and falls back to "no source maps."
fn write_response_with_cors(
    stream: &mut TcpStream,
    status: &str,
    ctype: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let header = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: {ctype}\r\n\
         Content-Length: {len}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n",
        len = body.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn request_target_path(target: &str) -> &str {
    resource_path(target)
}

fn protocol_json() -> String {
    json!({
        "version": {"major": "1", "minor": "3"},
        "domains": [
            {"domain":"Runtime","version":"1.3"},
            {"domain":"Debugger","version":"1.3"},
            {"domain":"Profiler","version":"1.3"},
            {"domain":"HeapProfiler","version":"1.3"},
            {"domain":"Schema","version":"1.3","commands":[{"name":"getDomains","returns":[{"name":"domains","type":"array","items":{"type":"object"}}]}]},
            {"domain":"Tracing","version":"1.3","commands":[{"name":"getCategories"},{"name":"start"},{"name":"end"}],"events":[{"name":"dataCollected"},{"name":"tracingComplete"}]},
            {"domain":"IO","version":"1.3","commands":[{"name":"read"},{"name":"close"}]},
            {"domain":"Browser","version":"1.3","commands":[{"name":"getVersion"}]},
            {"domain":"Page","version":"1.3","commands":[{"name":"enable"},{"name":"getResourceTree"},{"name":"getResourceContent"},{"name":"loadNetworkResource"}]},
            {"domain":"Network","version":"1.3","commands":[{"name":"enable"},{"name":"loadNetworkResource"}]},
            {"domain":"Log","version":"1.3"},
            {"domain":"Performance","version":"1.3"}
        ]
    })
    .to_string()
}

fn json_version() -> String {
    let v8_version = v8::V8::get_version();
    format!(
        r#"{{"Browser":"moo/{}","Protocol-Version":"1.3","V8-Version":"{}"}}"#,
        env!("CARGO_PKG_VERSION"),
        v8_version
    )
}

fn json_list(
    advertised_host: &str,
    db_path: &str,
    active_target: &Arc<Mutex<Option<TargetSpec>>>,
) -> String {
    let mut targets = chat_targets(db_path);
    if targets.is_empty() {
        targets.push(TargetSpec::default_target());
    }
    if let Some(active) = active_target.lock().unwrap().clone()
        && !targets.iter().any(|t| t.id == active.id)
    {
        targets.insert(0, active);
    }
    Value::Array(
        targets
            .iter()
            .map(|target| target_json(advertised_host, target))
            .collect(),
    )
    .to_string()
}

fn target_json(advertised_host: &str, target: &TargetSpec) -> Value {
    let ws_url = format!("ws://{advertised_host}/ws/{}", target.id);
    let frontend = format!(
        "devtools://devtools/bundled/inspector.html?ws={advertised_host}/ws/{}",
        target.id
    );
    let description = target
        .chat_id
        .as_deref()
        .map(|cid| format!("moo chat {cid}"))
        .unwrap_or_else(|| "moo harness".to_string());
    let url = target
        .chat_id
        .as_deref()
        .map(|cid| format!("moo://chat/{cid}"))
        .unwrap_or_else(|| "moo://harness".to_string());
    json!({
        "description": description,
        "devtoolsFrontendUrl": frontend,
        "id": target.id,
        "title": target.title,
        "type": "node",
        "url": url,
        "webSocketDebuggerUrl": ws_url,
    })
}

fn chat_targets(db_path: &str) -> Vec<TargetSpec> {
    let Ok(conn) = host::open_db(db_path) else {
        return Vec::new();
    };
    let mut ids = HashSet::new();
    if let Ok(mut stmt) = conn.prepare("select name from refs where name like 'chat/%/%'")
        && let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0))
    {
        for name in rows.flatten() {
            if let Some(cid) = name.split('/').nth(1)
                && !cid.is_empty()
            {
                ids.insert(cid.to_string());
            }
        }
    }

    let mut targets = Vec::new();
    for chat_id in ids {
        targets.push(target_from_chat_id(&conn, &chat_id));
    }
    targets.sort_by(|a, b| b.title.cmp(&a.title));
    targets
}

fn target_from_chat_id(conn: &rusqlite::Connection, chat_id: &str) -> TargetSpec {
    let title = ref_target(conn, &format!("chat/{chat_id}/title"))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| chat_id.to_string());
    TargetSpec {
        id: target_id_for_chat(chat_id),
        title: format!("moo: {title}"),
        chat_id: Some(chat_id.to_string()),
    }
}

fn ref_target(conn: &rusqlite::Connection, name: &str) -> Option<String> {
    conn.query_row("select target from refs where name = ?1", [name], |row| {
        row.get::<_, String>(0)
    })
    .ok()
}

fn target_from_id(target_id: &str, db_path: &str) -> Option<TargetSpec> {
    if target_id == DEFAULT_TARGET_ID {
        return Some(TargetSpec::default_target());
    }
    let chat_id = chat_id_from_target_id(target_id)?;
    let conn = host::open_db(db_path).ok()?;
    Some(target_from_chat_id(&conn, &chat_id))
}

fn target_id_for_chat(chat_id: &str) -> String {
    format!("{TARGET_PREFIX}{}", percent_encode(chat_id))
}

fn chat_id_from_target_id(target_id: &str) -> Option<String> {
    target_id
        .strip_prefix(TARGET_PREFIX)
        .and_then(percent_decode)
        .filter(|s| !s.is_empty())
}

fn percent_encode(input: &str) -> String {
    let mut out = String::new();
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn handle_ws_upgrade(
    mut stream: TcpStream,
    sec_key: &str,
    session_tx: Sender<PendingSession>,
    target: TargetSpec,
) -> std::io::Result<()> {
    let accept = compute_accept(sec_key);
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Accept: {accept}\r\n\
         \r\n"
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()?;

    let (in_tx, in_rx) = mpsc::channel::<Vec<u8>>();
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();

    if session_tx
        .send(PendingSession {
            target,
            in_rx,
            out_tx,
        })
        .is_err()
    {
        return Ok(()); // inspector thread gone
    }

    // Writer thread: drains outbound CDP frames → WS text frames.
    let writer_stream = stream.try_clone()?;
    let writer = thread::spawn(move || {
        let mut s = writer_stream;
        loop {
            match out_rx.recv_timeout(Duration::from_secs(30)) {
                Ok(bytes) => {
                    if write_text_frame(&mut s, &bytes).is_err() {
                        break;
                    }
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    // Reader: parse WS frames → in_tx. Returning here closes the connection;
    // dropping `in_tx` then signals the inspector that the session is over.
    let reader_result = read_ws_loop(&mut stream, &in_tx);
    drop(in_tx);
    let _ = writer.join();
    let _ = stream.shutdown(std::net::Shutdown::Both);
    reader_result
}

fn read_ws_loop(stream: &mut TcpStream, in_tx: &Sender<Vec<u8>>) -> std::io::Result<()> {
    loop {
        match read_text_frame(stream)? {
            Some(bytes) => {
                if in_tx.send(bytes).is_err() {
                    return Ok(());
                }
            }
            None => return Ok(()),
        }
    }
}

// Reads one WS text message from the stream. Returns Ok(Some(bytes)) for a
// complete message, Ok(None) on close/EOF. Mirrors the framing logic in
// src/ws.rs but yields raw bytes (CDP messages are JSON; we don't need to
// decode them as UTF-8 strings before forwarding).
fn read_text_frame(stream: &mut TcpStream) -> std::io::Result<Option<Vec<u8>>> {
    let mut message: Vec<u8> = Vec::new();
    let mut in_text_message = false;
    loop {
        let mut hdr = [0u8; 2];
        if read_exact_or_eof(stream, &mut hdr)? {
            return Ok(None);
        }
        let fin = (hdr[0] & 0x80) != 0;
        let opcode = hdr[0] & 0x0F;
        let masked = (hdr[1] & 0x80) != 0;
        let mut len = (hdr[1] & 0x7F) as u64;
        if len == 126 {
            let mut ext = [0u8; 2];
            if read_exact_or_eof(stream, &mut ext)? {
                return Ok(None);
            }
            len = u16::from_be_bytes(ext) as u64;
        } else if len == 127 {
            let mut ext = [0u8; 8];
            if read_exact_or_eof(stream, &mut ext)? {
                return Ok(None);
            }
            len = u64::from_be_bytes(ext);
        }
        let mut mask = [0u8; 4];
        if masked && read_exact_or_eof(stream, &mut mask)? {
            return Ok(None);
        }
        const MAX_MESSAGE: u64 = 32 << 20; // 32 MiB — CDP messages can carry source
        if len > MAX_MESSAGE || (message.len() as u64).saturating_add(len) > MAX_MESSAGE {
            return Err(std::io::Error::other("cdp ws message too large"));
        }
        let mut payload = vec![0u8; len as usize];
        if read_exact_or_eof(stream, &mut payload)? {
            return Ok(None);
        }
        if masked {
            for (i, b) in payload.iter_mut().enumerate() {
                *b ^= mask[i % 4];
            }
        }
        match opcode {
            0x8 => return Ok(None),
            0x9 | 0xA => continue,
            0x1 => {
                message = payload;
                in_text_message = !fin;
                if fin {
                    return Ok(Some(message));
                }
            }
            0x0 if in_text_message => {
                message.extend_from_slice(&payload);
                in_text_message = !fin;
                if fin {
                    return Ok(Some(message));
                }
            }
            0x0 => continue,
            _ => continue,
        }
    }
}

fn read_exact_or_eof(stream: &mut TcpStream, buf: &mut [u8]) -> std::io::Result<bool> {
    let mut filled = 0;
    while filled < buf.len() {
        match stream.read(&mut buf[filled..]) {
            Ok(0) => return Ok(true),
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(false)
}

fn write_text_frame(stream: &mut TcpStream, payload: &[u8]) -> std::io::Result<()> {
    let mut header: Vec<u8> = Vec::with_capacity(10);
    header.push(0x81);
    let len = payload.len();
    if len < 126 {
        header.push(len as u8);
    } else if len < 65_536 {
        header.push(126);
        header.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        header.push(127);
        header.extend_from_slice(&(len as u64).to_be_bytes());
    }
    stream.write_all(&header)?;
    stream.write_all(payload)?;
    stream.flush()
}

fn compute_accept(key: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(key.trim().as_bytes());
    hasher.update(WS_GUID);
    let digest = hasher.finalize();
    B64.encode(digest)
}

fn write_response(
    stream: &mut TcpStream,
    status: &str,
    ctype: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let header = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: {ctype}\r\n\
         Content-Length: {len}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n",
        len = body.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}
