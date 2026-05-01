use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Once};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use rusty_v8 as v8;

use crate::ops;
use crate::snapshots;

static INIT_V8: Once = Once::new();

pub struct RunReport {
    pub result: Result<String, String>,
    pub unhandled_exception: bool,
}

const PROMISE_PUMP_YIELD_EVERY: u32 = 64;
const ASYNC_RECV_MAX_SLICE: Duration = Duration::from_millis(50);

pub struct AsyncOpCompletion {
    pub id: u64,
    pub result: Result<String, String>,
}

pub struct AsyncOpHandle {
    pub cancel: Arc<dyn Fn() + Send + Sync>,
}

pub type AgentRunHandler =
    Arc<dyn Fn(u64, String, Sender<AsyncOpCompletion>) -> AsyncOpHandle + Send + Sync + 'static>;

struct PendingAsyncOp {
    resolver: v8::Global<v8::PromiseResolver>,
    cancel: Arc<dyn Fn() + Send + Sync>,
}

struct AsyncHostState {
    next_id: u64,
    pending: HashMap<u64, PendingAsyncOp>,
    completion_tx: Sender<AsyncOpCompletion>,
    agent_run: AgentRunHandler,
}

thread_local! {
    static ASYNC_HOST_STATE: RefCell<Option<AsyncHostState>> = const { RefCell::new(None) };
}

pub struct LoadedBundleCache {
    entries: Vec<LoadedBundleEntry>,
}

struct LoadedBundleEntry {
    source: Arc<String>,
    context: v8::Global<v8::Context>,
    main: v8::Global<v8::Function>,
}

impl LoadedBundleCache {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn run_report_in(
        &mut self,
        isolate: &mut v8::Isolate,
        source: &Arc<String>,
        input_json: &str,
    ) -> RunReport {
        self.run_inner(isolate, source, input_json, None)
    }

    pub fn run_async_report_in(
        &mut self,
        isolate: &mut v8::Isolate,
        source: &Arc<String>,
        input_json: &str,
        agent_run: AgentRunHandler,
    ) -> RunReport {
        self.run_inner(isolate, source, input_json, Some(agent_run))
    }

    fn run_inner(
        &mut self,
        isolate: &mut v8::Isolate,
        source: &Arc<String>,
        input_json: &str,
        agent_run: Option<AgentRunHandler>,
    ) -> RunReport {
        v8::scope!(let handle_scope, isolate);

        if let Some(i) = self.entries.iter().position(|entry| {
            Arc::ptr_eq(&entry.source, source) || entry.source.as_str() == source.as_str()
        }) {
            let entry = self.entries.remove(i);
            let report = {
                let context = v8::Local::new(handle_scope, &entry.context);
                let mut scope = v8::ContextScope::new(handle_scope, context);
                let main = v8::Local::new(&scope, &entry.main);
                run_cached_main_maybe_async(&mut scope, main, input_json, agent_run)
            };
            // If invoking the loaded context failed at the host/V8 boundary, drop
            // it so a bad global mutation (for example deleting main) does not
            // poison this worker forever. Command-level failures are encoded as
            // successful JSON payloads and keep the warm context.
            if report.result.is_ok() && !report.unhandled_exception {
                self.entries.insert(0, entry);
            }
            return report;
        }

        let context = v8::Context::new(handle_scope, Default::default());
        let context_global = v8::Global::new(handle_scope.as_ref(), context);
        let (loaded, report) = {
            let mut scope = v8::ContextScope::new(handle_scope, context);
            match install_globals(&mut scope)
                .and_then(|()| eval_no_output(&mut scope, source.as_str()))
                .and_then(|()| capture_main(&mut scope))
            {
                Ok(main_global) => {
                    let main = v8::Local::new(&scope, &main_global);
                    (
                        Some(main_global),
                        run_cached_main_maybe_async(&mut scope, main, input_json, agent_run),
                    )
                }
                Err(err) => (
                    None,
                    RunReport {
                        result: Err(err),
                        unhandled_exception: true,
                    },
                ),
            }
        };

        if let Some(main) = loaded
            && report.result.is_ok()
            && !report.unhandled_exception
        {
            self.entries.insert(
                0,
                LoadedBundleEntry {
                    source: source.clone(),
                    context: context_global,
                    main,
                },
            );
        }
        report
    }
}

impl Default for LoadedBundleCache {
    fn default() -> Self {
        Self::new()
    }
}

pub fn init_v8() {
    INIT_V8.call_once(|| {
        let platform = v8::new_default_platform(0, false).make_shared();
        v8::V8::initialize_platform(platform);
        v8::V8::initialize();
    });
}

// Startup snapshots serialize any native V8 functions reachable from the
// snapshot context as external references. The snapshot creator and every
// isolate that deserializes the blob must use an equivalent table or V8 aborts
// with "Unknown external reference ...". Keep this limited to callbacks that
// are installed before create_blob in create_bundle_snapshot; the DB/chat host
// ops are installed after deserialization and are not part of the blob.
fn startup_snapshot_external_references() -> Cow<'static, [v8::ExternalReference]> {
    Cow::Owned(vec![
        v8::ExternalReference {
            function: op_web_btoa_raw,
        },
        v8::ExternalReference {
            function: op_web_atob_raw,
        },
    ])
}

pub(crate) fn startup_snapshot_create_params(startup: v8::StartupData) -> v8::CreateParams {
    v8::CreateParams::default()
        .snapshot_blob(startup)
        .external_references(startup_snapshot_external_references())
}

pub fn run_js(source: &str, input_json: &str) -> Result<String, String> {
    init_v8();
    if let Some(path) = snapshot_path(input_json) {
        return run_snapshot(&path, input_json);
    }
    let mut isolate = v8::Isolate::new(v8::CreateParams::default());
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Auto);
    let near_heap_limit = AtomicBool::new(false);
    snapshots::install_failure_hooks(&mut isolate, &near_heap_limit);
    let report = run_js_report_in(&mut isolate, source, input_json);
    snapshots::record_if_triggered(
        &mut isolate,
        input_json,
        source,
        &report.result,
        near_heap_limit.load(Ordering::SeqCst),
        report.unhandled_exception,
    );
    report.result
}

pub fn run_snapshot(path: &str, input_json: &str) -> Result<String, String> {
    init_v8();
    let bytes = fs::read(path).map_err(|e| format!("failed to read snapshot {path}: {e}"))?;
    let startup = v8::StartupData::from(bytes);
    if !startup.is_valid() {
        return Err(format!("snapshot {path} is not valid for this V8 build"));
    }
    let mut isolate = v8::Isolate::new(startup_snapshot_create_params(startup));
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Auto);
    let near_heap_limit = AtomicBool::new(false);
    snapshots::install_failure_hooks(&mut isolate, &near_heap_limit);
    let report = run_js_from_snapshot_report_in(&mut isolate, input_json);
    snapshots::record_if_triggered(
        &mut isolate,
        input_json,
        &format!("startup snapshot: {path}"),
        &report.result,
        near_heap_limit.load(Ordering::SeqCst),
        report.unhandled_exception,
    );
    report.result
}

// Runs the bundle inside a caller-supplied isolate. Each invocation creates
// a fresh Context so the previous request's globals don't leak; the isolate
// itself is reused, which avoids the multi-millisecond V8 startup cost on
// every HTTP request.
pub fn run_js_report_in(isolate: &mut v8::Isolate, source: &str, input_json: &str) -> RunReport {
    v8::scope!(let handle_scope, isolate);
    let context = v8::Context::new(handle_scope, Default::default());
    let mut scope = v8::ContextScope::new(handle_scope, context);

    match install_globals(&mut scope) {
        Ok(()) => run_main_in_scope(&mut scope, Some(source), input_json),
        Err(err) => RunReport {
            result: Err(err),
            unhandled_exception: true,
        },
    }
}

#[allow(dead_code)]
pub fn run_js_async_report_in(
    isolate: &mut v8::Isolate,
    source: &str,
    input_json: &str,
    agent_run: AgentRunHandler,
) -> RunReport {
    v8::scope!(let handle_scope, isolate);
    let context = v8::Context::new(handle_scope, Default::default());
    let mut scope = v8::ContextScope::new(handle_scope, context);

    match install_globals(&mut scope) {
        Ok(()) => run_main_async_in_scope(&mut scope, source, input_json, agent_run),
        Err(err) => RunReport {
            result: Err(err),
            unhandled_exception: true,
        },
    }
}

pub fn run_js_from_snapshot_report_in(isolate: &mut v8::Isolate, input_json: &str) -> RunReport {
    v8::scope!(let handle_scope, isolate);
    let context = match v8::Context::from_snapshot(handle_scope, 0, Default::default()) {
        Some(context) => context,
        None => {
            return RunReport {
                result: Err("snapshot does not contain context 0".to_string()),
                unhandled_exception: true,
            };
        }
    };
    let mut scope = v8::ContextScope::new(handle_scope, context);
    match install_globals(&mut scope) {
        Ok(()) => run_main_in_scope(&mut scope, None, input_json),
        Err(err) => RunReport {
            result: Err(err),
            unhandled_exception: true,
        },
    }
}

pub fn load_snapshot_context_in(
    isolate: &mut v8::Isolate,
) -> Result<(v8::Global<v8::Context>, v8::Global<v8::Function>), String> {
    v8::scope!(let handle_scope, isolate);
    let context = v8::Context::from_snapshot(handle_scope, 0, Default::default())
        .ok_or_else(|| "snapshot does not contain context 0".to_string())?;
    let context_global = v8::Global::new(handle_scope.as_ref(), context);
    let main = {
        let mut scope = v8::ContextScope::new(handle_scope, context);
        install_globals(&mut scope)?;
        capture_main(&mut scope)?
    };
    Ok((context_global, main))
}

pub(crate) fn run_loaded_main_in_scope(scope: &mut v8::PinScope, input_json: &str) -> RunReport {
    run_main_in_scope(scope, None, input_json)
}

pub(crate) fn run_loaded_main_in_scope_with_main(
    scope: &mut v8::PinScope,
    main: v8::Local<v8::Function>,
    input_json: &str,
) -> RunReport {
    run_cached_main_in_scope(scope, main, input_json)
}

pub(crate) fn run_loaded_main_async_in_scope(
    scope: &mut v8::PinScope,
    input_json: &str,
    agent_run: AgentRunHandler,
) -> RunReport {
    run_main_async_loaded_in_scope(scope, input_json, agent_run)
}

fn run_cached_main_maybe_async(
    scope: &mut v8::PinScope,
    main: v8::Local<v8::Function>,
    input_json: &str,
    agent_run: Option<AgentRunHandler>,
) -> RunReport {
    match agent_run {
        Some(agent_run) => run_cached_main_async_in_scope(scope, main, input_json, agent_run),
        None => run_cached_main_in_scope(scope, main, input_json),
    }
}

fn run_cached_main_in_scope(
    scope: &mut v8::PinScope,
    main: v8::Local<v8::Function>,
    input_json: &str,
) -> RunReport {
    report_from_main_result(call_cached_main_json(scope, main, input_json))
}

fn run_cached_main_async_in_scope(
    scope: &mut v8::PinScope,
    main: v8::Local<v8::Function>,
    input_json: &str,
    agent_run: AgentRunHandler,
) -> RunReport {
    let (completion_tx, completion_rx) = mpsc::channel();
    let _guard = AsyncHostStateGuard::install(completion_tx, agent_run);
    let out = call_cached_main_json_async(scope, main, input_json, completion_rx);
    report_from_main_result(out)
}

fn report_from_main_result(out: Result<(String, bool), String>) -> RunReport {
    match out {
        Ok((out, unhandled_exception)) => RunReport {
            result: Ok(out),
            unhandled_exception,
        },
        Err(err) => RunReport {
            result: Err(err),
            unhandled_exception: true,
        },
    }
}

fn run_main_in_scope(
    scope: &mut v8::PinScope,
    source: Option<&str>,
    input_json: &str,
) -> RunReport {
    if let Some(source) = source
        && let Err(err) = eval_no_output(scope, source)
    {
        return RunReport {
            result: Err(err),
            unhandled_exception: true,
        };
    }

    report_from_main_result(call_main_json(scope, input_json))
}

#[allow(dead_code)]
fn run_main_async_in_scope(
    scope: &mut v8::PinScope,
    source: &str,
    input_json: &str,
    agent_run: AgentRunHandler,
) -> RunReport {
    if let Err(err) = eval_no_output(scope, source) {
        return RunReport {
            result: Err(err),
            unhandled_exception: true,
        };
    }

    let (completion_tx, completion_rx) = mpsc::channel();
    let _guard = AsyncHostStateGuard::install(completion_tx, agent_run);
    let out = call_main_json_async(scope, input_json, completion_rx);
    report_from_main_result(out)
}

fn run_main_async_loaded_in_scope(
    scope: &mut v8::PinScope,
    input_json: &str,
    agent_run: AgentRunHandler,
) -> RunReport {
    let (completion_tx, completion_rx) = mpsc::channel();
    let _guard = AsyncHostStateGuard::install(completion_tx, agent_run);
    let out = call_main_json_async(scope, input_json, completion_rx);
    report_from_main_result(out)
}

pub fn snapshot_path(input_json: &str) -> Option<String> {
    let v = serde_json::from_str::<serde_json::Value>(input_json).ok()?;
    match v.get("snapshot")? {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Object(map) => map
            .get("path")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        _ => None,
    }
}

pub fn create_bundle_snapshot(source: &str) -> Result<Vec<u8>, String> {
    init_v8();
    let mut isolate =
        v8::Isolate::snapshot_creator(Some(startup_snapshot_external_references()), None);
    {
        v8::scope!(let scope, &mut isolate);
        let context = v8::Context::new(scope, Default::default());
        let mut scope = v8::ContextScope::new(scope, context);
        install_web_base64(&mut scope)?;
        eval_no_output(&mut scope, source)?;
        scope.set_default_context(context);
        scope.add_context(context);
    }
    let blob = isolate
        .create_blob(v8::FunctionCodeHandling::Keep)
        .ok_or_else(|| "failed to create V8 snapshot blob".to_string())?;
    Ok(blob.to_vec())
}

fn call_main_json(scope: &mut v8::PinScope, input_json: &str) -> Result<(String, bool), String> {
    v8::tc_scope!(let tc, scope);
    let input = parse_input_json(tc, input_json)?;
    let (main, recv) = lookup_main(tc)?;
    let value = match main.call(tc, recv, &[input]) {
        Some(value) => value,
        None => return Err(caught_exception(tc)),
    };
    await_and_stringify(tc, value)
}

fn call_cached_main_json(
    scope: &mut v8::PinScope,
    main: v8::Local<v8::Function>,
    input_json: &str,
) -> Result<(String, bool), String> {
    v8::tc_scope!(let tc, scope);
    let input = parse_input_json(tc, input_json)?;
    let recv = tc.get_current_context().global(tc).into();
    let value = match main.call(tc, recv, &[input]) {
        Some(value) => value,
        None => return Err(caught_exception(tc)),
    };
    await_and_stringify(tc, value)
}

fn call_main_json_async(
    scope: &mut v8::PinScope,
    input_json: &str,
    completion_rx: Receiver<AsyncOpCompletion>,
) -> Result<(String, bool), String> {
    v8::tc_scope!(let tc, scope);
    let input = parse_input_json(tc, input_json)?;
    let (main, recv) = lookup_main(tc)?;
    let value = match main.call(tc, recv, &[input]) {
        Some(value) => value,
        None => return Err(caught_exception(tc)),
    };
    await_and_stringify_async(tc, value, completion_rx)
}

fn call_cached_main_json_async(
    scope: &mut v8::PinScope,
    main: v8::Local<v8::Function>,
    input_json: &str,
    completion_rx: Receiver<AsyncOpCompletion>,
) -> Result<(String, bool), String> {
    v8::tc_scope!(let tc, scope);
    let input = parse_input_json(tc, input_json)?;
    let recv = tc.get_current_context().global(tc).into();
    let value = match main.call(tc, recv, &[input]) {
        Some(value) => value,
        None => return Err(caught_exception(tc)),
    };
    await_and_stringify_async(tc, value, completion_rx)
}

fn parse_input_json<'s>(
    scope: &mut v8::PinnedRef<'s, v8::TryCatch<v8::HandleScope>>,
    input_json: &str,
) -> Result<v8::Local<'s, v8::Value>, String> {
    let input =
        v8::String::new(scope, input_json).ok_or_else(|| "could not allocate input".to_string())?;
    match v8::json::parse(scope, input) {
        Some(value) => Ok(value),
        None => Err(caught_exception(scope)),
    }
}

fn lookup_main<'s>(
    scope: &mut v8::PinnedRef<'s, v8::TryCatch<v8::HandleScope>>,
) -> Result<(v8::Local<'s, v8::Function>, v8::Local<'s, v8::Value>), String> {
    let context = scope.get_current_context();
    let global = context.global(scope);
    let key =
        v8::String::new(scope, "main").ok_or_else(|| "could not allocate main key".to_string())?;
    let value = match global.get(scope, key.into()) {
        Some(value) => value,
        None => return Err(caught_exception(scope)),
    };
    let main = v8::Local::<v8::Function>::try_from(value)
        .map_err(|_| "globalThis.main is not a function".to_string())?;
    Ok((main, global.into()))
}

fn capture_main(scope: &mut v8::PinScope) -> Result<v8::Global<v8::Function>, String> {
    v8::tc_scope!(let tc, scope);
    let (main, _) = lookup_main(tc)?;
    Ok(v8::Global::new(tc.as_ref(), main))
}

fn await_and_stringify(
    scope: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>,
    value: v8::Local<v8::Value>,
) -> Result<(String, bool), String> {
    if value.is_promise() {
        let promise = v8::Local::<v8::Promise>::try_from(value)
            .map_err(|_| "script returned a non-promise value".to_string())?;
        let mut spins = 0u32;
        while promise.state() == v8::PromiseState::Pending {
            scope.perform_microtask_checkpoint();
            spins = spins.wrapping_add(1);
            if spins.is_multiple_of(PROMISE_PUMP_YIELD_EVERY) {
                std::thread::yield_now();
            }
        }
        return stringify_settled_promise(scope, promise);
    }

    json_stringify(scope, value).map(|out| (out, false))
}

fn await_and_stringify_async(
    scope: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>,
    value: v8::Local<v8::Value>,
    completion_rx: Receiver<AsyncOpCompletion>,
) -> Result<(String, bool), String> {
    if value.is_promise() {
        let promise = v8::Local::<v8::Promise>::try_from(value)
            .map_err(|_| "script returned a non-promise value".to_string())?;
        loop {
            scope.perform_microtask_checkpoint();
            if promise.state() != v8::PromiseState::Pending {
                break;
            }
            if pending_async_ops() == 0 {
                return Err(
                    "JavaScript promise is pending with no host async operations".to_string(),
                );
            }
            let completion = match completion_rx.recv_timeout(ASYNC_RECV_MAX_SLICE) {
                Ok(completion) => completion,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("async host-op channel closed".to_string());
                }
            };
            settle_async_op(scope, completion)?;
        }
        return stringify_settled_promise(scope, promise);
    }

    json_stringify(scope, value).map(|out| (out, false))
}

fn stringify_settled_promise(
    scope: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>,
    promise: v8::Local<v8::Promise>,
) -> Result<(String, bool), String> {
    let result = promise.result(scope);
    if promise.state() == v8::PromiseState::Rejected {
        return Ok((
            format!(
                r#"{{"ok":false,"error":{}}}"#,
                serialize_error(scope, result)
            ),
            true,
        ));
    }
    json_stringify(scope, result).map(|out| (out, false))
}

fn json_stringify(
    scope: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>,
    value: v8::Local<v8::Value>,
) -> Result<String, String> {
    if value.is_undefined() {
        return Ok("undefined".to_string());
    }
    match v8::json::stringify(scope, value) {
        Some(text) => Ok(text.to_rust_string_lossy(scope)),
        None => {
            if scope.has_caught() {
                Err(caught_exception(scope))
            } else {
                Ok("undefined".to_string())
            }
        }
    }
}

fn eval_no_output(scope: &mut v8::PinScope, source: &str) -> Result<(), String> {
    v8::tc_scope!(let tc, scope);
    let code =
        v8::String::new(tc, source).ok_or_else(|| "could not allocate source".to_string())?;
    let script = match v8::Script::compile(tc, code, None) {
        Some(script) => script,
        None => return Err(caught_exception(tc)),
    };
    match script.run(tc) {
        Some(_) => Ok(()),
        None => Err(caught_exception(tc)),
    }
}

struct AsyncHostStateGuard;

impl AsyncHostStateGuard {
    fn install(completion_tx: Sender<AsyncOpCompletion>, agent_run: AgentRunHandler) -> Self {
        ASYNC_HOST_STATE.with(|state| {
            *state.borrow_mut() = Some(AsyncHostState {
                next_id: 1,
                pending: HashMap::new(),
                completion_tx,
                agent_run,
            });
        });
        Self
    }
}

impl Drop for AsyncHostStateGuard {
    fn drop(&mut self) {
        cancel_pending_async_ops();
        ASYNC_HOST_STATE.with(|state| {
            state.borrow_mut().take();
        });
    }
}

fn pending_async_ops() -> usize {
    ASYNC_HOST_STATE.with(|state| {
        state
            .borrow()
            .as_ref()
            .map(|state| state.pending.len())
            .unwrap_or(0)
    })
}

fn settle_async_op(scope: &mut v8::PinScope, completion: AsyncOpCompletion) -> Result<(), String> {
    let pending = ASYNC_HOST_STATE.with(|state| {
        state
            .borrow_mut()
            .as_mut()
            .and_then(|state| state.pending.remove(&completion.id))
    });
    let Some(pending) = pending else {
        return Ok(());
    };
    let resolver = v8::Local::new(scope, &pending.resolver);
    match completion.result {
        Ok(value) => {
            let Some(v) = v8::String::new(scope, &value) else {
                return Err("could not allocate async op result".to_string());
            };
            let _ = resolver.resolve(scope, v.into());
        }
        Err(error) => {
            let msg = v8::String::new(scope, &error)
                .ok_or_else(|| "could not allocate async op error".to_string())?;
            let err = v8::Exception::error(scope, msg);
            let _ = resolver.reject(scope, err);
        }
    }
    Ok(())
}

fn cancel_pending_async_ops() {
    let pending = ASYNC_HOST_STATE.with(|state| {
        let mut borrow = state.borrow_mut();
        match borrow.as_mut() {
            Some(state) => state
                .pending
                .drain()
                .map(|(_, pending)| pending.cancel)
                .collect(),
            None => Vec::new(),
        }
    });
    for cancel in pending {
        cancel();
    }
}

pub(crate) fn install_globals(scope: &mut v8::PinScope) -> Result<(), String> {
    install_console(scope)?;
    install_fn(scope, "__op_agent_run", op_agent_run)?;
    install_web_base64(scope)?;
    ops::install_all(scope)?;
    Ok(())
}

// Subset of `install_globals` safe to use outside a real chat (no DB-backed
// `moo` ops). The CDP inspector context uses this so user code that touches
// `console.log` / `btoa` / `atob` doesn't blow up at parse time.
pub fn install_minimal_globals(scope: &mut v8::PinScope) -> Result<(), String> {
    install_console(scope)?;
    install_web_base64(scope)?;
    Ok(())
}

fn install_web_base64(scope: &mut v8::PinScope) -> Result<(), String> {
    install_fn_raw(scope, "__web_btoa", op_web_btoa_raw)?;
    install_fn_raw(scope, "__web_atob", op_web_atob_raw)?;
    eval_no_output(
        scope,
        r#"
(() => {
  const nativeBtoa = globalThis.__web_btoa;
  const nativeAtob = globalThis.__web_atob;
  delete globalThis.__web_btoa;
  delete globalThis.__web_atob;

  const invalidCharacter = (message) => {
    let error;
    if (typeof DOMException === "function") {
      error = new DOMException(message, "InvalidCharacterError");
    } else {
      error = new Error(message);
      error.name = "InvalidCharacterError";
    }
    throw error;
  };

  if (typeof globalThis.btoa !== "function") {
    Object.defineProperty(globalThis, "btoa", {
      value(input) {
        const data = String(input);
        const bytes = new Array(data.length);
        for (let i = 0; i < data.length; i++) {
          const code = data.charCodeAt(i);
          if (code > 0xff) {
            invalidCharacter("The string to be encoded contains characters outside of the Latin1 range.");
          }
          bytes[i] = code;
        }
        return nativeBtoa(bytes);
      },
      writable: true,
      configurable: true,
    });
  }

  if (typeof globalThis.atob !== "function") {
    Object.defineProperty(globalThis, "atob", {
      value(input) {
        let data = String(input).replace(/[\t\n\f\r ]+/g, "");
        if (data.length % 4 === 0) {
          data = data.replace(/={1,2}$/, "");
        }
        if (data.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(data)) {
          invalidCharacter("The string to be decoded is not correctly encoded.");
        }
        while (data.length % 4 !== 0) data += "=";
        try {
          return nativeAtob(data);
        } catch (_) {
          invalidCharacter("The string to be decoded is not correctly encoded.");
        }
      },
      writable: true,
      configurable: true,
    });
  }
})();
"#,
    )
}

unsafe extern "C" fn op_web_btoa_raw(info: *const v8::FunctionCallbackInfo) {
    // SAFETY: V8 invokes this callback with a valid FunctionCallbackInfo for
    // the current isolate, matching rusty_v8's own FunctionCallback adapter.
    let info = unsafe { &*info };
    let scope = std::pin::pin!(unsafe { v8::CallbackScope::new(info) });
    let mut scope = scope.init();
    let args = v8::FunctionCallbackArguments::from_function_callback_info(info);
    let rv = v8::ReturnValue::from_function_callback_info(info);
    op_web_btoa(&mut scope, args, rv);
}

unsafe extern "C" fn op_web_atob_raw(info: *const v8::FunctionCallbackInfo) {
    // SAFETY: V8 invokes this callback with a valid FunctionCallbackInfo for
    // the current isolate, matching rusty_v8's own FunctionCallback adapter.
    let info = unsafe { &*info };
    let scope = std::pin::pin!(unsafe { v8::CallbackScope::new(info) });
    let mut scope = scope.init();
    let args = v8::FunctionCallbackArguments::from_function_callback_info(info);
    let rv = v8::ReturnValue::from_function_callback_info(info);
    op_web_atob(&mut scope, args, rv);
}

fn op_web_btoa(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        throw(scope, "btoa requires (bytes)");
        return;
    }
    let Ok(array) = v8::Local::<v8::Array>::try_from(args.get(0)) else {
        throw(scope, "btoa requires a byte array");
        return;
    };
    let mut bytes = Vec::with_capacity(array.length() as usize);
    for i in 0..array.length() {
        let Some(value) = array.get_index(scope, i) else {
            throw(scope, "btoa could not read byte array");
            return;
        };
        let Some(byte) = value.uint32_value(scope) else {
            throw(scope, "btoa byte array contains a non-number");
            return;
        };
        if byte > u8::MAX as u32 {
            throw(
                scope,
                "btoa byte array contains a value outside the byte range",
            );
            return;
        }
        bytes.push(byte as u8);
    }

    let out = B64.encode(bytes);
    if let Some(s) = v8::String::new(scope, &out) {
        rv.set(s.into());
    }
}

fn op_web_atob(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        throw(scope, "atob requires (input)");
        return;
    }
    let input = args.get(0).to_rust_string_lossy(scope);
    let bytes = match B64.decode(input.as_bytes()) {
        Ok(bytes) => bytes,
        Err(e) => {
            throw(scope, &format!("atob decode: {e}"));
            return;
        }
    };
    if let Some(s) = v8::String::new_from_one_byte(scope, &bytes, v8::NewStringType::Normal) {
        rv.set(s.into());
    }
}

pub fn install_fn(
    scope: &mut v8::PinScope,
    name: &str,
    cb: impl v8::MapFnTo<v8::FunctionCallback>,
) -> Result<(), String> {
    install_fn_raw(scope, name, cb.map_fn_to())
}

fn install_fn_raw(
    scope: &mut v8::PinScope,
    name: &str,
    cb: v8::FunctionCallback,
) -> Result<(), String> {
    let context = scope.get_current_context();
    let global = context.global(scope);
    let n = v8::String::new(scope, name).ok_or_else(|| format!("alloc name {name}"))?;
    let f = v8::Function::new_raw(scope, cb).ok_or_else(|| format!("alloc fn {name}"))?;
    global
        .set(scope, n.into(), f.into())
        .ok_or_else(|| format!("install fn {name}"))?;
    Ok(())
}

fn op_agent_run(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let Some(resolver) = v8::PromiseResolver::new(scope) else {
        throw(scope, "agent_run: could not create PromiseResolver");
        return;
    };
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    let request = if args.length() > 0 && !args.get(0).is_null_or_undefined() {
        args.get(0).to_rust_string_lossy(scope)
    } else {
        String::new()
    };

    let resolver_global = v8::Global::new(scope.as_ref(), resolver);
    let start = ASYNC_HOST_STATE.with(|cell| {
        let mut borrow = cell.borrow_mut();
        let Some(state) = borrow.as_mut() else {
            return Err("agent_run is only available while executing runJS".to_string());
        };
        if request.trim().is_empty() {
            return Err("agent_run requires a request JSON string".to_string());
        }
        let id = state.next_id;
        state.next_id = state.next_id.saturating_add(1);
        let completion_tx = state.completion_tx.clone();
        let handler = state.agent_run.clone();
        let handle = handler(id, request, completion_tx);
        state.pending.insert(
            id,
            PendingAsyncOp {
                resolver: resolver_global,
                cancel: handle.cancel,
            },
        );
        Ok(())
    });

    if let Err(error) = start {
        let msg = match v8::String::new(scope, &error) {
            Some(msg) => msg,
            None => return,
        };
        let err = v8::Exception::error(scope, msg);
        let _ = resolver.reject(scope, err);
    }
}

fn install_console(scope: &mut v8::PinScope) -> Result<(), String> {
    let context = scope.get_current_context();
    let global = context.global(scope);
    let console = v8::Object::new(scope);

    let log_name =
        v8::String::new(scope, "log").ok_or_else(|| "could not allocate log".to_string())?;
    let log = v8::Function::new(
        scope,
        |_scope: &mut v8::PinScope, _args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue| {
            // Keep console.log available for JS compatibility, but do not write to
            // the server process. Use moo.log for user-visible timeline logs.
        },
    )
    .ok_or_else(|| "could not create console.log".to_string())?;
    console
        .set(scope, log_name.into(), log.into())
        .ok_or_else(|| "could not install console.log".to_string())?;

    let console_name = v8::String::new(scope, "console")
        .ok_or_else(|| "could not allocate console".to_string())?;
    global
        .set(scope, console_name.into(), console.into())
        .ok_or_else(|| "could not install console".to_string())?;
    Ok(())
}

pub fn throw(scope: &mut v8::PinScope, msg: &str) {
    if let Some(s) = v8::String::new(scope, msg) {
        let err = v8::Exception::error(scope, s);
        scope.throw_exception(err);
    }
}

fn caught_exception(try_catch: &mut v8::PinnedRef<'_, v8::TryCatch<v8::HandleScope>>) -> String {
    try_catch
        .exception()
        .map(|exception| exception.to_rust_string_lossy(try_catch))
        .unwrap_or_else(|| "JavaScript exception".to_string())
}

fn serialize_error(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> String {
    let mut message = value.to_rust_string_lossy(scope);
    let mut stack: Option<String> = None;

    if value.is_object()
        && let Ok(obj) = v8::Local::<v8::Object>::try_from(value)
    {
        if let Some(key) = v8::String::new(scope, "message")
            && let Some(v) = obj.get(scope, key.into())
            && !v.is_undefined()
            && !v.is_null()
        {
            message = v.to_rust_string_lossy(scope);
        }
        if let Some(key) = v8::String::new(scope, "stack")
            && let Some(v) = obj.get(scope, key.into())
            && !v.is_undefined()
            && !v.is_null()
        {
            stack = Some(v.to_rust_string_lossy(scope));
        }
    }

    let mut payload = serde_json::Map::new();
    payload.insert("message".into(), serde_json::Value::String(message));
    if let Some(s) = stack {
        payload.insert("stack".into(), serde_json::Value::String(s));
    }
    serde_json::Value::Object(payload).to_string()
}
