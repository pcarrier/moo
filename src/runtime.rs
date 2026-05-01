use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Once};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use rusty_v8 as v8;

use crate::ops;
use crate::snapshots;
use crate::util::js_string_literal;

static INIT_V8: Once = Once::new();

pub struct RunReport {
    pub result: Result<String, String>,
    pub unhandled_exception: bool,
}

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

pub fn init_v8() {
    INIT_V8.call_once(|| {
        let platform = v8::new_default_platform(0, false).make_shared();
        v8::V8::initialize_platform(platform);
        v8::V8::initialize();
    });
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
    let mut isolate = v8::Isolate::new(v8::CreateParams::default().snapshot_blob(startup));
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

pub(crate) fn run_loaded_main_in_scope(scope: &mut v8::PinScope, input_json: &str) -> RunReport {
    run_main_in_scope(scope, None, input_json)
}

pub(crate) fn run_loaded_main_async_in_scope(
    scope: &mut v8::PinScope,
    input_json: &str,
    agent_run: AgentRunHandler,
) -> RunReport {
    run_main_async_loaded_in_scope(scope, input_json, agent_run)
}

fn run_main_in_scope(
    scope: &mut v8::PinScope,
    source: Option<&str>,
    input_json: &str,
) -> RunReport {
    let input_expr = format!(
        "globalThis.__runInput = JSON.parse({});",
        js_string_literal(input_json)
    );
    if let Err(err) = eval_no_output(scope, &input_expr) {
        return RunReport {
            result: Err(err),
            unhandled_exception: true,
        };
    }

    let wrapped = if let Some(source) = source {
        format!(
            r#"
(async () => {{
{source}
return JSON.stringify(await globalThis.main(globalThis.__runInput));
}})()
"#
        )
    } else {
        "(async () => JSON.stringify(await globalThis.main(globalThis.__runInput)))()".to_string()
    };

    match eval_to_string(scope, &wrapped) {
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

fn run_main_async_in_scope(
    scope: &mut v8::PinScope,
    source: &str,
    input_json: &str,
    agent_run: AgentRunHandler,
) -> RunReport {
    let input_expr = format!(
        "globalThis.__runInput = JSON.parse({});",
        js_string_literal(input_json)
    );
    if let Err(err) = eval_no_output(scope, &input_expr) {
        return RunReport {
            result: Err(err),
            unhandled_exception: true,
        };
    }

    let wrapped = format!(
        r#"
(async () => {{
{source}
return JSON.stringify(await globalThis.main(globalThis.__runInput));
}})()
"#
    );

    let (completion_tx, completion_rx) = mpsc::channel();
    ASYNC_HOST_STATE.with(|state| {
        *state.borrow_mut() = Some(AsyncHostState {
            next_id: 1,
            pending: HashMap::new(),
            completion_tx,
            agent_run,
        });
    });

    let out = eval_to_string_async(scope, &wrapped, completion_rx);
    cancel_pending_async_ops();
    ASYNC_HOST_STATE.with(|state| {
        state.borrow_mut().take();
    });

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

fn run_main_async_loaded_in_scope(
    scope: &mut v8::PinScope,
    input_json: &str,
    agent_run: AgentRunHandler,
) -> RunReport {
    let input_expr = format!(
        "globalThis.__runInput = JSON.parse({});",
        js_string_literal(input_json)
    );
    if let Err(err) = eval_no_output(scope, &input_expr) {
        return RunReport {
            result: Err(err),
            unhandled_exception: true,
        };
    }

    let wrapped = "(async () => JSON.stringify(await globalThis.main(globalThis.__runInput)))()";

    let (completion_tx, completion_rx) = mpsc::channel();
    ASYNC_HOST_STATE.with(|state| {
        *state.borrow_mut() = Some(AsyncHostState {
            next_id: 1,
            pending: HashMap::new(),
            completion_tx,
            agent_run,
        });
    });

    let out = eval_to_string_async(scope, wrapped, completion_rx);
    cancel_pending_async_ops();
    ASYNC_HOST_STATE.with(|state| {
        state.borrow_mut().take();
    });

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
    let mut isolate = v8::Isolate::snapshot_creator(None, None);
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

fn eval_to_string(scope: &mut v8::PinScope, source: &str) -> Result<(String, bool), String> {
    v8::tc_scope!(let tc, scope);
    let code =
        v8::String::new(tc, source).ok_or_else(|| "could not allocate source".to_string())?;
    let script = match v8::Script::compile(tc, code, None) {
        Some(script) => script,
        None => return Err(caught_exception(tc)),
    };
    let value = match script.run(tc) {
        Some(value) => value,
        None => return Err(caught_exception(tc)),
    };

    if value.is_promise() {
        let promise = v8::Local::<v8::Promise>::try_from(value)
            .map_err(|_| "script returned a non-promise value".to_string())?;
        while promise.state() == v8::PromiseState::Pending {
            tc.perform_microtask_checkpoint();
        }
        let result = promise.result(tc);
        if promise.state() == v8::PromiseState::Rejected {
            return Ok((
                format!(r#"{{"ok":false,"error":{}}}"#, serialize_error(tc, result)),
                true,
            ));
        }
        return value_to_string(tc, result).map(|out| (out, false));
    }

    value_to_string(tc, value).map(|out| (out, false))
}

fn eval_to_string_async(
    scope: &mut v8::PinScope,
    source: &str,
    completion_rx: Receiver<AsyncOpCompletion>,
) -> Result<(String, bool), String> {
    v8::tc_scope!(let tc, scope);
    let code =
        v8::String::new(tc, source).ok_or_else(|| "could not allocate source".to_string())?;
    let script = match v8::Script::compile(tc, code, None) {
        Some(script) => script,
        None => return Err(caught_exception(tc)),
    };
    let value = match script.run(tc) {
        Some(value) => value,
        None => return Err(caught_exception(tc)),
    };

    if value.is_promise() {
        let promise = v8::Local::<v8::Promise>::try_from(value)
            .map_err(|_| "script returned a non-promise value".to_string())?;
        loop {
            tc.perform_microtask_checkpoint();
            if promise.state() != v8::PromiseState::Pending {
                break;
            }
            if pending_async_ops() == 0 {
                return Err(
                    "JavaScript promise is pending with no host async operations".to_string(),
                );
            }
            let completion = completion_rx
                .recv()
                .map_err(|_| "async host-op channel closed".to_string())?;
            settle_async_op(tc, completion)?;
        }
        let result = promise.result(tc);
        if promise.state() == v8::PromiseState::Rejected {
            return Ok((
                format!(r#"{{"ok":false,"error":{}}}"#, serialize_error(tc, result)),
                true,
            ));
        }
        return value_to_string(tc, result).map(|out| (out, false));
    }

    value_to_string(tc, value).map(|out| (out, false))
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
    install_fn(scope, "__web_btoa", op_web_btoa)?;
    install_fn(scope, "__web_atob", op_web_atob)?;
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
    let context = scope.get_current_context();
    let global = context.global(scope);
    let n = v8::String::new(scope, name).ok_or_else(|| format!("alloc name {name}"))?;
    let f = v8::Function::new(scope, cb).ok_or_else(|| format!("alloc fn {name}"))?;
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

fn value_to_string(
    scope: &mut v8::PinScope,
    value: v8::Local<v8::Value>,
) -> Result<String, String> {
    let text = value
        .to_string(scope)
        .ok_or_else(|| "could not convert JavaScript value to string".to_string())?;
    Ok(text.to_rust_string_lossy(scope))
}
