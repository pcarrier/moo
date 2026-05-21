// Chat driver runtime.
//
// TypeScript owns the chat/agent state machine behind the step-next harness
// command. Rust keeps only process concerns: one in-flight task per chat, the
// per-chat lock, interruption, short V8 calls, and long-running LLM transport
// without pinning a V8 worker.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};
use tokio::task::{AbortHandle, JoinHandle};

use crate::async_runtime::runtime;
use crate::broadcast;
use crate::host;
use crate::ops::llm;
use crate::pool::Pool;
use crate::runtime::{AgentRunHandler, AsyncOpCompletion, AsyncOpHandle};
use crate::util::{now_ms, now_ns, random_id};

// Tracks the in-flight tokio task for each chat so /api/run interrupt can
// abort it. Accepted turns publish step-start before the command response is
// sent, and StepLifecycle's Drop publishes step-end when the driver finishes.
struct RunningChat {
    handle: JoinHandle<()>,
    run_id: u64,
    started_at: u64,
    end_event: Option<Value>,
    ended: Arc<AtomicBool>,
    foreground_runts: ForegroundRunTsState,
}

type ForegroundRunTsState = Arc<Mutex<Option<ForegroundRunTs>>>;

#[derive(Clone)]
struct ForegroundRunTs {
    step_id: String,
    cancel: Arc<AtomicBool>,
    background: Arc<AtomicBool>,
}

struct QueuedChatRun {
    pool: Arc<Pool>,
    bundle: Arc<String>,
    state: Value,
}

struct PreparedChatRun {
    chat_id: String,
    running: RunningChat,
    start_tx: tokio::sync::oneshot::Sender<()>,
    lifecycle_events: Option<Value>,
    started_at: u64,
}

struct BackgroundRunTs {
    chat_id: String,
    step_id: String,
    label: Option<String>,
    requested_by: String,
    started_at: u64,
    cancel: Arc<AtomicBool>,
    abort: AbortHandle,
}

static RUNNING: LazyLock<Mutex<HashMap<String, RunningChat>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static QUEUED: LazyLock<Mutex<HashMap<String, VecDeque<QueuedChatRun>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static BACKGROUND_RUNTS: LazyLock<Mutex<HashMap<String, BackgroundRunTs>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static DISPATCH: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static NEXT_RUN_ID: AtomicU64 = AtomicU64::new(1);

fn running_lock() -> MutexGuard<'static, HashMap<String, RunningChat>> {
    match RUNNING.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            eprintln!("running chat registry mutex poisoned; recovering inner value");
            poisoned.into_inner()
        }
    }
}

fn queued_lock() -> MutexGuard<'static, HashMap<String, VecDeque<QueuedChatRun>>> {
    match QUEUED.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            eprintln!("queued chat driver registry mutex poisoned; recovering inner value");
            poisoned.into_inner()
        }
    }
}

fn dispatch_lock() -> MutexGuard<'static, ()> {
    match DISPATCH.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            eprintln!("chat dispatch mutex poisoned; recovering inner value");
            poisoned.into_inner()
        }
    }
}

fn background_runts_lock() -> MutexGuard<'static, HashMap<String, BackgroundRunTs>> {
    match BACKGROUND_RUNTS.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            eprintln!("background runTS registry mutex poisoned; recovering inner value");
            poisoned.into_inner()
        }
    }
}

pub fn background_runts_json() -> Value {
    let jobs = background_runts_lock()
        .values()
        .map(|entry| {
            json!({
                "chatId": entry.chat_id,
                "stepId": entry.step_id,
                "label": entry.label,
                "requestedBy": entry.requested_by,
                "startedAt": entry.started_at,
            })
        })
        .collect::<Vec<_>>();
    json!({ "jobs": jobs })
}

pub fn cancel_background_runts(chat_id: &str, step_id: Option<&str>) -> usize {
    let cancels = background_runts_lock()
        .values()
        .filter(|entry| entry.chat_id == chat_id && step_id.is_none_or(|id| entry.step_id == id))
        .map(|entry| (entry.cancel.clone(), entry.abort.clone()))
        .collect::<Vec<_>>();
    for (cancel, abort) in &cancels {
        cancel.store(true, Ordering::SeqCst);
        abort.abort();
    }
    cancels.len()
}

pub fn request_foreground_runts_background(chat_id: &str, step_id: Option<&str>) -> bool {
    let Some(foreground) = running_lock()
        .get(chat_id)
        .and_then(|entry| active_foreground_runts(&entry.foreground_runts, step_id))
    else {
        return false;
    };
    foreground.background.store(true, Ordering::SeqCst);
    true
}

pub fn cancel_runts(chat_id: &str, step_id: Option<&str>) -> usize {
    let mut cancelled = cancel_background_runts(chat_id, step_id);
    if let Some(foreground) = running_lock()
        .get(chat_id)
        .and_then(|entry| active_foreground_runts(&entry.foreground_runts, step_id))
    {
        if !foreground.cancel.swap(true, Ordering::SeqCst) {
            // Keep the foreground driver alive so the cancelled tool result is
            // recorded in chat state and queued follow-ups can continue from a
            // terminal runJS/runTS row instead of a vanished in-flight turn.
            cancelled += 1;
        }
    }
    cancelled
}

fn active_foreground_runts(
    state: &ForegroundRunTsState,
    step_id: Option<&str>,
) -> Option<ForegroundRunTs> {
    let entry = match state.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => {
            eprintln!("foreground runTS registry mutex poisoned; recovering inner value");
            poisoned.into_inner().clone()
        }
    };
    entry.filter(|entry| step_id.is_none_or(|id| entry.step_id == id))
}

fn set_active_foreground_runts(state: &ForegroundRunTsState, entry: ForegroundRunTs) {
    match state.lock() {
        Ok(mut guard) => {
            *guard = Some(entry);
        }
        Err(poisoned) => {
            eprintln!("foreground runTS registry mutex poisoned; recovering inner value");
            *poisoned.into_inner() = Some(entry);
        }
    }
}

fn clear_active_foreground_runts(state: &ForegroundRunTsState, step_id: &str) {
    match state.lock() {
        Ok(mut guard) => {
            if guard.as_ref().is_some_and(|entry| entry.step_id == step_id) {
                *guard = None;
            }
        }
        Err(poisoned) => {
            eprintln!("foreground runTS registry mutex poisoned; recovering inner value");
            let mut guard = poisoned.into_inner();
            if guard.as_ref().is_some_and(|entry| entry.step_id == step_id) {
                *guard = None;
            }
        }
    }
}

pub fn dispatch_drive(pool: Arc<Pool>, bundle: Arc<String>, state: Value) {
    dispatch_state(pool, bundle, state);
}

const CHAT_TRACE_PREFIX: &str = "chattrace:";

fn chat_trace_id(chat_id: &str) -> String {
    format!("{CHAT_TRACE_PREFIX}{chat_id}")
}

fn object_value(value: Value) -> Value {
    match value {
        Value::Object(_) => value,
        Value::Null => json!({}),
        other => json!({ "value": other }),
    }
}

fn chat_title_conn(conn: &rusqlite::Connection, chat_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "select target from refs where name = ?1",
        params![format!("chat/{chat_id}/title")],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn ensure_chat_trace_root(chat_id: &str) -> Result<String, String> {
    if !host::tracing_enabled() {
        return Ok(chat_trace_id(chat_id));
    }
    let id = chat_trace_id(chat_id);
    let title = host::with_db(|conn| chat_title_conn(conn, chat_id))?.unwrap_or_default();
    let label = if title.is_empty() {
        format!("chat {chat_id}")
    } else {
        title.clone()
    };
    let root_name = label.as_str();
    let data = object_value(json!({
        "chatId": chat_id,
        "label": label,
        "description": "single chat trace",
    }))
    .to_string();
    if host::trace_get(&id)?.is_none() {
        host::trace_open(host::TraceOpenParams {
            id: &id,
            parent_id: None,
            chat_id: Some(chat_id),
            run_id: None,
            kind: "chat",
            name: root_name,
            started_ns: now_ns(),
            input_hash: None,
            invoked_from_step_id: None,
            data_json: Some(&data),
        })?;
    } else {
        host::trace_update_data(&id, Some(&data))?;
    }
    Ok(id)
}

fn chat_trace_open(
    parent_id: Option<&str>,
    chat_id: &str,
    run_id: Option<u64>,
    kind: &str,
    name: &str,
    data: Value,
) -> Option<String> {
    let root_id = match ensure_chat_trace_root(chat_id) {
        Ok(id) => id,
        Err(e) => {
            eprintln!("chat trace root [{chat_id}]: {e}");
            return None;
        }
    };
    let parent = parent_id.unwrap_or(&root_id);
    let id = random_id("traceevt");
    let run_id_str = run_id.map(|id| id.to_string());
    let data_json = object_value(data).to_string();
    if let Err(e) = host::trace_open(host::TraceOpenParams {
        id: &id,
        parent_id: Some(parent),
        chat_id: Some(chat_id),
        run_id: run_id_str.as_deref(),
        kind,
        name,
        started_ns: now_ns(),
        input_hash: None,
        invoked_from_step_id: None,
        data_json: Some(&data_json),
    }) {
        eprintln!("chat trace insert [{chat_id}]: {e}");
        return None;
    }
    Some(id)
}

fn chat_trace_finish(event_id: Option<String>, status: &str, data: Value) {
    let Some(event_id) = event_id else {
        return;
    };
    let row = match host::trace_get(&event_id) {
        Ok(row) => row,
        Err(e) => {
            eprintln!("chat trace finish read: {e}");
            return;
        }
    };
    let Some(row) = row else {
        return;
    };
    let ended_ns = now_ns();
    let mut merged = match row
        .data_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .unwrap_or_else(|| json!({}))
    {
        Value::Object(map) => map,
        other => {
            let mut map = Map::new();
            map.insert("previous".to_string(), other);
            map
        }
    };
    if let Value::Object(map) = object_value(data) {
        for (k, v) in map {
            merged.insert(k, v);
        }
    }
    merged.insert(
        "durationNs".to_string(),
        Value::Number(serde_json::Number::from(
            ended_ns.saturating_sub(row.started_ns),
        )),
    );
    if let Err(e) = host::trace_finish(
        &event_id,
        ended_ns,
        status,
        None,
        None,
        Some(&Value::Object(merged).to_string()),
    ) {
        eprintln!("chat trace finish update: {e}");
    }
}

fn chat_trace_finish_running(event_id: Option<String>, status: &str, data: Value) {
    let Some(event_id) = event_id else {
        return;
    };
    let row = match host::trace_get(&event_id) {
        Ok(row) => row,
        Err(e) => {
            eprintln!("chat trace cleanup read: {e}");
            return;
        }
    };
    let Some(row) = row else {
        return;
    };
    if row.status != "running" {
        return;
    }
    chat_trace_finish(Some(event_id), status, data);
}

struct ChatTraceSpan {
    id: Option<String>,
    cleanup_reason: &'static str,
}

impl ChatTraceSpan {
    fn new(id: Option<String>, cleanup_reason: &'static str) -> Self {
        Self { id, cleanup_reason }
    }

    fn id(&self) -> Option<&str> {
        self.id.as_deref()
    }

    fn finish(mut self, status: &str, data: Value) {
        chat_trace_finish(self.id.take(), status, data);
    }
}

impl Drop for ChatTraceSpan {
    fn drop(&mut self) {
        let Some(id) = self.id.take() else {
            return;
        };
        chat_trace_finish_running(
            Some(id),
            "cancelled",
            json!({
                "endedBy": "chat.driver.cleanup",
                "reason": self.cleanup_reason,
            }),
        );
    }
}

fn dispatch_state(pool: Arc<Pool>, bundle: Arc<String>, state: Value) {
    let chat_id = state
        .get("chatId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if chat_id.is_empty() {
        return;
    }
    let _dispatch_guard = dispatch_lock();
    if running_lock().contains_key(&chat_id) {
        queued_lock()
            .entry(chat_id)
            .or_default()
            .push_back(QueuedChatRun {
                pool,
                bundle,
                state,
            });
        return;
    }

    start_prepared_run(prepare_chat_run(pool, bundle, chat_id, state));
}

fn prepare_chat_run(
    pool: Arc<Pool>,
    bundle: Arc<String>,
    chat_id: String,
    state: Value,
) -> PreparedChatRun {
    let run_id = NEXT_RUN_ID.fetch_add(1, Ordering::Relaxed);
    let started_at = now_ms() as u64;
    let lifecycle_events = state.get("lifecycleEvents").cloned();
    let end_event = state
        .get("lifecycleEvents")
        .and_then(|v| v.get("end"))
        .filter(|v| v.is_object())
        .cloned();
    let ended = Arc::new(AtomicBool::new(false));
    let task_ended = ended.clone();
    let foreground_runts = Arc::new(Mutex::new(None));
    let task_foreground_runts = foreground_runts.clone();
    let (start_tx, start_rx) = tokio::sync::oneshot::channel::<()>();
    let task_chat_id = chat_id.clone();
    let handle = runtime().spawn(async move {
        let _ = start_rx.await;
        let lifecycle_events = state.get("lifecycleEvents").cloned();
        let mut step_guard = StepLifecycle::new(lifecycle_events.as_ref(), task_ended);
        if let Err(e) = drive(
            pool,
            bundle,
            task_chat_id.clone(),
            state,
            task_foreground_runts,
            run_id,
        )
        .await
        {
            eprintln!("chat driver [{task_chat_id}]: {e}");
            publish_event_payload(&json!({
                "kind": "driver-error",
                "chatId": task_chat_id,
                "error": e,
            }));
        }
        step_guard.finish();
        finish_current_and_start_next(&task_chat_id, run_id);
    });

    PreparedChatRun {
        chat_id,
        running: RunningChat {
            handle,
            run_id,
            started_at,
            end_event,
            ended,
            foreground_runts,
        },
        start_tx,
        lifecycle_events,
        started_at,
    }
}

fn start_prepared_run(prepared: PreparedChatRun) {
    publish_start_event(prepared.lifecycle_events.as_ref(), prepared.started_at);
    running_lock().insert(prepared.chat_id, prepared.running);
    let _ = prepared.start_tx.send(());
}

fn finish_current_and_start_next(chat_id: &str, run_id: u64) {
    let _dispatch_guard = dispatch_lock();
    {
        let mut running = running_lock();
        if running
            .get(chat_id)
            .map(|entry| entry.run_id == run_id)
            .unwrap_or(false)
        {
            running.remove(chat_id);
        } else {
            return;
        }
    }
    start_next_queued_run_locked(chat_id);
}

fn start_next_queued_run_locked(chat_id: &str) {
    let next = {
        let mut queued = queued_lock();
        let Some(queue) = queued.get_mut(chat_id) else {
            return;
        };
        let next = queue.pop_front();
        if queue.is_empty() {
            queued.remove(chat_id);
        }
        next
    };
    let Some(next) = next else {
        return;
    };
    if running_lock().contains_key(chat_id) {
        queued_lock()
            .entry(chat_id.to_string())
            .or_default()
            .push_front(next);
        return;
    }
    start_prepared_run(prepare_chat_run(
        next.pool,
        next.bundle,
        chat_id.to_string(),
        next.state,
    ));
}

async fn drive(
    pool: Arc<Pool>,
    bundle: Arc<String>,
    chat_id: String,
    state: Value,
    foreground_runts: ForegroundRunTsState,
    run_id: u64,
) -> Result<(), String> {
    let lock_arc = pool.chat_lock(&format!("chat:{chat_id}"));
    let _guard = lock_arc.lock().await;

    let turn_span = ChatTraceSpan::new(
        chat_trace_open(
            None,
            &chat_id,
            Some(run_id),
            "turn",
            "chat.driver",
            json!({
                "chatId": chat_id,
                "runId": run_id,
                "state": state.clone(),
            }),
        ),
        "chat.driver",
    );
    let result = drive_loop(
        &pool,
        &bundle,
        state,
        &chat_id,
        run_id,
        turn_span.id(),
        foreground_runts,
    )
    .await;
    turn_span.finish(
        if result.is_ok() { "ok" } else { "error" },
        json!({
            "runId": run_id,
            "error": result.as_ref().err().cloned(),
        }),
    );
    result
}

pub fn restart_ongoing(pool: Arc<Pool>, bundle: Arc<String>) {
    runtime().spawn(async move {
        let discovered = call_v8(&pool, &bundle, json!({ "command": "restart-ongoing" })).await;
        let Ok(raw) = discovered else {
            eprintln!("chat driver restart discovery: {}", discovered.unwrap_err());
            return;
        };
        let value = match unwrap_value(&raw) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("chat driver restart discovery: {e}");
                return;
            }
        };
        let _count = apply_driver_actions(&value, &pool, &bundle);
    });
}

pub fn apply_driver_actions(value: &Value, pool: &Arc<Pool>, bundle: &Arc<String>) -> usize {
    let mut count = 0;
    if let Some(action) = value.get("driver")
        && apply_driver_action(action, pool, bundle)
    {
        count += 1;
    }
    if let Some(actions) = value.get("driverActions").and_then(|v| v.as_array()) {
        for action in actions {
            if apply_driver_action(action, pool, bundle) {
                count += 1;
            }
        }
    }
    count
}

pub fn apply_driver_action(action: &Value, pool: &Arc<Pool>, bundle: &Arc<String>) -> bool {
    match action.get("action").and_then(|v| v.as_str()) {
        Some("drive") => {
            if let Some(state) = action.get("state").filter(|v| v.is_object()) {
                dispatch_drive(pool.clone(), bundle.clone(), state.clone());
                return true;
            }
        }
        Some("background-runts") => {
            if let Some(chat_id) = action
                .get("chatId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                let step_id = action
                    .get("stepId")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty());
                request_foreground_runts_background(chat_id, step_id);
                return true;
            }
        }
        Some("cancel-runts") => {
            if let Some(chat_id) = action
                .get("chatId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                let step_id = action
                    .get("stepId")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty());
                cancel_runts(chat_id, step_id);
                return true;
            }
        }
        Some("interrupt") => {
            if let Some(chat_id) = action
                .get("chatId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                interrupt(chat_id);
                return true;
            }
        }
        _ => {}
    }
    false
}

pub fn interrupt(chat_id: &str) -> bool {
    queued_lock().remove(chat_id);
    let Some(running) = running_lock().remove(chat_id) else {
        return false;
    };
    finish_running(running);
    true
}

pub fn running_ids() -> Vec<String> {
    running_lock().keys().cloned().collect()
}

pub fn running_started_at() -> HashMap<String, u64> {
    running_lock()
        .iter()
        .map(|(chat_id, running)| (chat_id.clone(), running.started_at))
        .collect()
}

fn finish_running(running: RunningChat) {
    if let Some(foreground) = active_foreground_runts(&running.foreground_runts, None) {
        foreground.cancel.store(true, Ordering::SeqCst);
    }
    running.handle.abort();
    // Publish step-end synchronously rather than waiting for the aborted
    // task's StepLifecycle::Drop, which may be parked inside spawn_blocking
    // (V8 calls) and not run for a while. Clients rely on step-end to drain
    // queued messages.
    if !running.ended.swap(true, Ordering::SeqCst)
        && let Some(end_event) = &running.end_event
    {
        publish_event_payload(end_event);
    }
}

struct StepLifecycle {
    end_event: Option<Value>,
    ended: Arc<AtomicBool>,
}

impl StepLifecycle {
    fn new(events: Option<&Value>, ended: Arc<AtomicBool>) -> Self {
        let events = events.filter(|v| v.is_object());
        Self {
            end_event: events
                .and_then(|v| v.get("end"))
                .filter(|v| v.is_object())
                .cloned(),
            ended,
        }
    }

    fn finish(&mut self) {
        if self.ended.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(end_event) = self.end_event.take() {
            publish_event_payload(&end_event);
        }
    }
}

impl Drop for StepLifecycle {
    fn drop(&mut self) {
        self.finish();
    }
}

fn runts_tool_step_id(value: &Value) -> String {
    value
        .get("runTsStepId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            value
                .get("toolCall")
                .and_then(|v| v.get("id"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
        })
        .map(ToString::to_string)
        .unwrap_or_else(|| random_id("runts"))
}

fn runts_tool_call_id(value: &Value) -> String {
    value
        .get("toolCall")
        .and_then(|v| v.get("id"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| runts_tool_step_id(value))
}

fn detached_runts_tool_result(value: &Value) -> Value {
    let step_id = runts_tool_step_id(value);
    let tool_call_id = value
        .get("toolCall")
        .and_then(|v| v.get("id"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(&step_id)
        .to_string();
    json!({
        "toolCallId": tool_call_id,
        "stepId": step_id,
        "runTsStepId": step_id,
        "backgroundId": step_id,
        "content": format!("detached: runTS continues in background; id: {step_id}; cancel with await moo.tools.cancel({{ id: \"{step_id}\" }}}})"),
        "status": "done",
    })
}

fn runts_tool_label(value: &Value) -> Option<String> {
    let arguments = value
        .get("toolCall")
        .and_then(|v| v.get("function"))
        .and_then(|v| v.get("arguments"))
        .and_then(|v| v.as_str())?;
    serde_json::from_str::<Value>(arguments).ok().and_then(|v| {
        v.get("label")
            .and_then(|label| label.as_str())
            .map(ToString::to_string)
    })
}

pub fn runts_tool_background_after_ns(value: &Value) -> Option<u64> {
    value
        .get("backgroundAfterNs")
        .and_then(|v| v.as_u64())
        .or_else(|| {
            let arguments = value
                .get("toolCall")
                .and_then(|v| v.get("function"))
                .and_then(|v| v.get("arguments"))
                .and_then(|v| v.as_str())?;
            serde_json::from_str::<Value>(arguments)
                .ok()
                .and_then(|v| v.get("backgroundAfterNs").and_then(|n| n.as_u64()))
        })
}

pub fn spawn_runts_tool_command(
    pool: Arc<Pool>,
    bundle: Arc<String>,
    value: Value,
    cancelled: Arc<AtomicBool>,
) -> JoinHandle<Value> {
    runtime().spawn(async move { run_ts_tool_async(&pool, &bundle, &value, None, cancelled).await })
}

pub fn background_runts_command(
    chat_id: String,
    value: Value,
    cancel_for_task: Arc<AtomicBool>,
    handle: JoinHandle<Value>,
) {
    let step_id = runts_tool_step_id(&value);
    let label = runts_tool_label(&value);
    let requested_by = "api";
    let abort = handle.abort_handle();
    background_runts_lock().insert(
        step_id.clone(),
        BackgroundRunTs {
            chat_id: chat_id.clone(),
            step_id: step_id.clone(),
            label: label.clone(),
            requested_by: requested_by.to_string(),
            started_at: now_ms() as u64,
            cancel: cancel_for_task,
            abort,
        },
    );
    publish_runts_background_event(
        "runts-background-start",
        &chat_id,
        &step_id,
        label.as_deref(),
        requested_by,
    );
    runtime().spawn(async move {
        let _ = handle.await;
        background_runts_lock().remove(&step_id);
        publish_runts_background_event(
            "runts-background-end",
            &chat_id,
            &step_id,
            label.as_deref(),
            requested_by,
        );
    });
}

fn publish_runts_background_event(
    kind: &str,
    chat_id: &str,
    step_id: &str,
    label: Option<&str>,
    requested_by: &str,
) {
    publish_event_payload(&json!({
        "kind": kind,
        "chatId": chat_id,
        "stepId": step_id,
        "label": label,
        "requestedBy": requested_by,
        "at": now_ms(),
    }));
}

fn background_runts_tool(
    pool: Arc<Pool>,
    bundle: Arc<String>,
    chat_id: String,
    value: Value,
    parent_span: Option<String>,
    tool_span: ChatTraceSpan,
    requested_by: &'static str,
) {
    let step_id = runts_tool_step_id(&value);
    let label = runts_tool_label(&value);
    let cancel_for_task = Arc::new(AtomicBool::new(false));
    let handle = spawn_runts_tool_task(
        pool.clone(),
        bundle.clone(),
        value.clone(),
        parent_span,
        cancel_for_task.clone(),
    );
    background_runts_tool_handle(
        chat_id.clone(),
        step_id,
        label,
        cancel_for_task,
        tool_span,
        handle,
        requested_by,
    );
}

fn background_runts_tool_handle(
    chat_id: String,
    step_id: String,
    label: Option<String>,
    cancel_for_task: Arc<AtomicBool>,
    tool_span: ChatTraceSpan,
    handle: JoinHandle<Value>,
    requested_by: &'static str,
) {
    let abort = handle.abort_handle();
    background_runts_lock().insert(
        step_id.clone(),
        BackgroundRunTs {
            chat_id: chat_id.clone(),
            step_id: step_id.clone(),
            label: label.clone(),
            requested_by: requested_by.to_string(),
            started_at: now_ms() as u64,
            cancel: cancel_for_task.clone(),
            abort,
        },
    );
    publish_runts_background_event(
        "runts-background-start",
        &chat_id,
        &step_id,
        label.as_deref(),
        requested_by,
    );
    let cancel_for_join = cancel_for_task.clone();
    runtime().spawn(async move {
        let tool_result = handle.await.unwrap_or_else(|e| {
            let cancelled = cancel_for_join.load(Ordering::SeqCst) || e.is_cancelled();
            json!({
                "content": if cancelled {
                    "cancelled: runTS cancelled".to_string()
                } else {
                    format!("error: runTS background task failed: {e}")
                },
                "status": if cancelled { "cancelled" } else { "failed" },
            })
        });
        background_runts_lock().remove(&step_id);
        publish_runts_background_event(
            "runts-background-end",
            &chat_id,
            &step_id,
            label.as_deref(),
            requested_by,
        );
        let tool_ok = tool_result
            .get("status")
            .and_then(|v| v.as_str())
            .map(|s| s != "failed" && s != "cancelled")
            .unwrap_or(true);
        tool_span.finish(
            if tool_ok { "ok" } else { "error" },
            json!({ "result": tool_result }),
        );
    });
}

fn spawn_runts_tool_task(
    pool: Arc<Pool>,
    bundle: Arc<String>,
    value: Value,
    parent_span: Option<String>,
    cancelled: Arc<AtomicBool>,
) -> JoinHandle<Value> {
    runtime().spawn(async move {
        run_ts_tool_async(&pool, &bundle, &value, parent_span.as_deref(), cancelled).await
    })
}

async fn drive_loop(
    pool: &Arc<Pool>,
    bundle: &Arc<String>,
    state: Value,
    chat_id: &str,
    run_id: u64,
    turn_span: Option<&str>,
    foreground_runts: ForegroundRunTsState,
) -> Result<(), String> {
    let mut next_input = if let Some(tool_result) = state.get("__toolResult").cloned() {
        let mut resumed = state.clone();
        if let Some(obj) = resumed.as_object_mut() {
            obj.remove("__toolResult");
        }
        json!({ "command": "step-next", "state": resumed, "toolResult": tool_result })
    } else {
        json!({ "command": "step-next", "state": state })
    };

    loop {
        let command = next_input
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("step-next")
            .to_string();
        let step_span = ChatTraceSpan::new(
            chat_trace_open(
                turn_span,
                chat_id,
                Some(run_id),
                "step",
                "harness.step",
                json!({
                    "chatId": chat_id,
                    "command": command,
                    "input": next_input.clone(),
                }),
            ),
            "harness.step",
        );
        let raw = match call_v8(pool, bundle, next_input).await {
            Ok(raw) => raw,
            Err(e) => {
                step_span.finish("error", json!({ "command": command, "error": e }));
                return Err(e);
            }
        };
        let value = match unwrap_value(&raw) {
            Ok(value) => value,
            Err(e) => {
                step_span.finish("error", json!({ "command": command, "error": e }));
                return Err(e);
            }
        };
        let next_kind_value = value.get("kind").cloned().unwrap_or(Value::Null);
        match value.get("kind").and_then(|v| v.as_str()) {
            Some("llm") => {
                let state = value.get("state").cloned().unwrap_or(Value::Null);
                let url = match value.get("url").and_then(|v| v.as_str()) {
                    Some(url) => url.to_string(),
                    None => {
                        let error = "step-next llm missing url".to_string();
                        step_span.finish(
                            "error",
                            json!({ "command": command, "nextKind": next_kind_value, "error": error }),
                        );
                        return Err(error);
                    }
                };
                let headers = value.get("headers").cloned().unwrap_or(json!({}));
                let body_value = value.get("body").cloned().unwrap_or(Value::Null);
                let body = serde_json::to_string(&body_value).unwrap_or_else(|_| "{}".to_string());
                let stream_events = value.get("streamEvents").cloned().unwrap_or(Value::Null);
                if let Some(delay_ms) = value
                    .get("delayMs")
                    .and_then(|v| v.as_u64())
                    .filter(|n| *n > 0)
                {
                    let sleep_span = ChatTraceSpan::new(
                        chat_trace_open(
                            step_span.id(),
                            chat_id,
                            Some(run_id),
                            "llm",
                            "llm.retry_sleep",
                            json!({ "chatId": chat_id, "delayMs": delay_ms }),
                        ),
                        "llm.retry_sleep",
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    sleep_span.finish("ok", json!({ "delayMs": delay_ms }));
                }

                // No V8 worker held during this call.
                let llm_span = ChatTraceSpan::new(
                    chat_trace_open(
                        step_span.id(),
                        chat_id,
                        Some(run_id),
                        "llm",
                        "llm.stream",
                        json!({
                            "chatId": chat_id,
                            "purpose": value.get("purpose").cloned().unwrap_or(Value::Null),
                            "provider": value.get("requestProvider").cloned().unwrap_or(Value::Null),
                            "model": value.get("requestModel").cloned().unwrap_or(Value::Null),
                            "effort": value.get("requestEffort").cloned().unwrap_or(Value::Null),
                            "url": url,
                            "responsesApi": value.get("responsesApi").cloned().unwrap_or(Value::Null),
                            "estimatedPromptTokens": value.get("estimatedPromptTokens").cloned().unwrap_or(Value::Null),
                            "tokenBudget": value.get("tokenBudget").cloned().unwrap_or(Value::Null),
                            "tokenThreshold": value.get("tokenThreshold").cloned().unwrap_or(Value::Null),
                            "body": body_value,
                        }),
                    ),
                    "llm.stream",
                );
                let stream_started = std::time::Instant::now();
                let llm_result = llm::stream_chat(
                    pool.clone(),
                    bundle.clone(),
                    url,
                    headers,
                    body,
                    stream_events,
                )
                .await;
                let duration_ns =
                    u64::try_from(stream_started.elapsed().as_nanos()).unwrap_or(u64::MAX);
                let llm_ok = llm_result
                    .get("ok")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                llm_span.finish(
                    if llm_ok { "ok" } else { "error" },
                    json!({
                        "durationNs": duration_ns,
                        "ok": llm_ok,
                        "result": llm_result.clone(),
                    }),
                );

                next_input = json!({
                    "command": "step-next",
                    "state": state,
                    "llmResult": llm_result,
                    "llmDurationNs": duration_ns,
                });
                step_span.finish(
                    "ok",
                    json!({
                        "command": command,
                        "nextKind": next_kind_value,
                        "output": value,
                    }),
                );
            }
            Some("tool-ts") => {
                let state = value.get("state").cloned().unwrap_or(Value::Null);
                let tool_span = ChatTraceSpan::new(
                    chat_trace_open(
                        step_span.id(),
                        chat_id,
                        Some(run_id),
                        "tool",
                        "harness.runts_tool",
                        json!({
                            "chatId": chat_id,
                            "toolCall": value.get("toolCall").cloned().unwrap_or(Value::Null),
                            "request": value.clone(),
                        }),
                    ),
                    "harness.runts_tool",
                );
                let background_after_ns = value.get("backgroundAfterNs").and_then(|v| v.as_u64());
                if background_after_ns == Some(0) {
                    let detached_result = detached_runts_tool_result(&value);
                    background_runts_tool(
                        pool.clone(),
                        bundle.clone(),
                        chat_id.to_string(),
                        value.clone(),
                        tool_span.id().map(ToString::to_string),
                        tool_span,
                        "tool",
                    );
                    step_span.finish(
                        "ok",
                        json!({
                            "command": command,
                            "nextKind": next_kind_value,
                            "output": value,
                            "backgrounded": true,
                            "backgroundRequested": "tool",
                        }),
                    );
                    next_input = json!({
                        "command": "step-next",
                        "state": state,
                        "toolResult": detached_result,
                    });
                    continue;
                }
                let foreground_value = value.clone();
                let foreground_parent_span = tool_span.id().map(ToString::to_string);
                let foreground_step_id = runts_tool_step_id(&value);
                let run_cancel = Arc::new(AtomicBool::new(false));
                let tool_background = Arc::new(AtomicBool::new(false));
                set_active_foreground_runts(
                    &foreground_runts,
                    ForegroundRunTs {
                        step_id: foreground_step_id.clone(),
                        cancel: run_cancel.clone(),
                        background: tool_background.clone(),
                    },
                );
                let mut run = spawn_runts_tool_task(
                    pool.clone(),
                    bundle.clone(),
                    foreground_value,
                    foreground_parent_span.clone(),
                    run_cancel.clone(),
                );
                let background_poll = async {
                    loop {
                        if tool_background.load(Ordering::SeqCst) {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                };
                tokio::pin!(background_poll);
                let auto_background = async {
                    if let Some(ns) = background_after_ns.filter(|ns| *ns > 0) {
                        tokio::time::sleep(std::time::Duration::from_nanos(ns)).await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                };
                tokio::pin!(auto_background);
                let cancel_poll_flag = run_cancel.clone();
                let cancel_poll = async move {
                    loop {
                        if cancel_poll_flag.load(Ordering::SeqCst) {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    }
                };
                tokio::pin!(cancel_poll);
                tokio::select! {
                    joined = &mut run => {
                        let tool_result = joined.unwrap_or_else(|e| {
                            json!({
                                "content": format!("error: runTS task failed: {e}"),
                                "status": "failed",
                            })
                        });
                        let tool_ok = tool_result
                            .get("status")
                            .and_then(|v| v.as_str())
                            .map(|s| s != "failed" && s != "cancelled")
                            .unwrap_or(true);
                        tool_span.finish(
                            if tool_ok { "ok" } else { "error" },
                            json!({ "result": tool_result.clone() }),
                        );
                        next_input = json!({
                            "command": "step-next",
                            "state": state,
                            "toolResult": tool_result,
                        });
                        step_span.finish(
                            "ok",
                            json!({
                                "command": command,
                                "nextKind": next_kind_value,
                                "output": value,
                                "backgrounded": false,
                            }),
                        );
                        clear_active_foreground_runts(&foreground_runts, &foreground_step_id);
                    }
                    _ = &mut cancel_poll => {
                        run.abort();
                        let tool_result = json!({
                            "toolCallId": runts_tool_call_id(&value),
                            "content": "cancelled: runTS cancelled",
                            "status": "cancelled",
                        });
                        tool_span.finish("error", json!({ "result": tool_result.clone() }));
                        next_input = json!({
                            "command": "step-next",
                            "state": state,
                            "toolResult": tool_result,
                        });
                        step_span.finish(
                            "cancelled",
                            json!({
                                "command": command,
                                "nextKind": next_kind_value,
                                "output": value,
                                "backgrounded": false,
                            }),
                        );
                        clear_active_foreground_runts(&foreground_runts, &foreground_step_id);
                    }
                    _ = &mut background_poll => {
                        clear_active_foreground_runts(&foreground_runts, &foreground_step_id);
                        let step_id = foreground_step_id.clone();
                        let label = runts_tool_label(&value);
                        let detached_result = detached_runts_tool_result(&value);
                        background_runts_tool_handle(
                            chat_id.to_string(),
                            step_id,
                            label,
                            run_cancel,
                            tool_span,
                            run,
                            "user",
                        );
                        step_span.finish(
                            "ok",
                            json!({
                                "command": command,
                                "nextKind": next_kind_value,
                                "output": value,
                                "backgrounded": true,
                                "backgroundRequested": "user",
                            }),
                        );
                        next_input = json!({
                            "command": "step-next",
                            "state": state,
                            "toolResult": detached_result,
                        });
                        continue;
                    }
                    _ = &mut auto_background => {
                        clear_active_foreground_runts(&foreground_runts, &foreground_step_id);
                        let step_id = foreground_step_id.clone();
                        let label = runts_tool_label(&value);
                        let detached_result = detached_runts_tool_result(&value);
                        background_runts_tool_handle(
                            chat_id.to_string(),
                            step_id,
                            label,
                            run_cancel,
                            tool_span,
                            run,
                            "timer",
                        );
                        step_span.finish(
                            "ok",
                            json!({
                                "command": command,
                                "nextKind": next_kind_value,
                                "output": value,
                                "backgrounded": true,
                                "backgroundRequested": "timer",
                                "backgroundAfterNs": background_after_ns,
                            }),
                        );
                        next_input = json!({
                            "command": "step-next",
                            "state": state,
                            "toolResult": detached_result,
                        });
                        continue;
                    }
                }
            }
            Some("done") | Some("wait-input") | Some("error") => {
                step_span.finish(
                    "ok",
                    json!({
                        "command": command,
                        "nextKind": next_kind_value,
                        "output": value,
                    }),
                );
                return Ok(());
            }
            _ => {
                step_span.finish(
                    "ok",
                    json!({
                        "command": command,
                        "nextKind": next_kind_value,
                        "output": value,
                    }),
                );
                return Ok(());
            }
        }
    }
}

async fn run_ts_tool_async(
    pool: &Arc<Pool>,
    bundle: &Arc<String>,
    value: &Value,
    parent_step_id: Option<&str>,
    cancelled: Arc<AtomicBool>,
) -> Value {
    let chat_id = value
        .pointer("/state/chatId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let tool_call = value.get("toolCall").cloned().unwrap_or(Value::Null);
    let tool_call_id = runts_tool_call_id(value);
    let input = json!({
        "command": "run-ts-tool",
        "chatId": chat_id,
        "state": value.get("state").cloned().unwrap_or(Value::Null),
        "toolCall": tool_call,
        "model": value.get("model").cloned().unwrap_or(Value::Null),
        "runTsStepId": value.get("runTsStepId").cloned().unwrap_or(Value::Null),
    });
    let handler = make_agent_run_handler(pool.clone(), bundle.clone());
    let pool2 = pool.clone();
    let bundle2 = bundle.clone();
    let input_str = input.to_string();
    let parent_step_id = parent_step_id.map(ToString::to_string);
    let cancelled_for_result = cancelled.clone();
    let raw = tokio::task::spawn_blocking(move || {
        pool2.submit_async_tool(bundle2, input_str, handler, parent_step_id, cancelled)
    })
    .await
    .map_err(|e| format!("spawn_blocking async tool: {e}"))
    .and_then(|r| r);
    match raw {
        Ok(raw) => match serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|v| unwrap_value(&v).ok())
        {
            Some(v) => v,
            None => json!({
                "toolCallId": tool_call_id,
                "content": "error: runTS returned an invalid harness response",
                "status": "failed",
            }),
        },
        Err(e) => {
            let cancelled = cancelled_for_result.load(Ordering::SeqCst);
            json!({
                "toolCallId": tool_call_id,
                "content": format!("{}: {e}", if cancelled { "cancelled" } else { "error" }),
                "status": if cancelled { "cancelled" } else { "failed" },
            })
        }
    }
}

fn make_agent_run_handler(pool: Arc<Pool>, bundle: Arc<String>) -> AgentRunHandler {
    Arc::new(move |op_id, request_json, completion_tx| {
        let pool = pool.clone();
        let bundle = bundle.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel_for_task = cancelled.clone();
        runtime().spawn(async move {
            let result = drive_subagent(pool, bundle, request_json, cancel_for_task).await;
            let _ = completion_tx.send(AsyncOpCompletion { id: op_id, result });
        });
        AsyncOpHandle {
            cancel: Arc::new(move || {
                cancelled.store(true, Ordering::SeqCst);
            }),
        }
    })
}

async fn drive_subagent(
    pool: Arc<Pool>,
    bundle: Arc<String>,
    request_json: String,
    cancelled: Arc<AtomicBool>,
) -> Result<String, String> {
    let req: Value =
        serde_json::from_str(&request_json).map_err(|e| format!("subagent request JSON: {e}"))?;
    let child_chat_id = req
        .get("childChatId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "subagent request missing childChatId".to_string())?
        .to_string();
    let task = build_subagent_task(&req);
    let max_steps = req
        .pointer("/limits/maxSteps")
        .and_then(|v| v.as_u64())
        .unwrap_or(20);
    let timeout_ms = req
        .pointer("/limits/timeoutMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(600_000);
    let started = std::time::Instant::now();
    let state = json!({
        "chatId": child_chat_id.clone(),
        "mode": "step",
        "message": task,
        "artificial": true,
        "lifecycleEvents": {
            "start": { "kind": "step-start", "chatId": child_chat_id },
            "end": { "kind": "step-end", "chatId": child_chat_id }
        }
    });
    let drive = drive_limited(&pool, &bundle, state, max_steps, cancelled.clone());
    let status =
        match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), drive).await {
            Ok(Ok(done)) => done,
            Ok(Err(e)) => {
                return Ok(subagent_result_json(
                    "failed",
                    &child_chat_id,
                    "",
                    Some(&e),
                    started.elapsed().as_nanos(),
                ));
            }
            Err(_) => {
                cancelled.store(true, Ordering::SeqCst);
                return Ok(subagent_result_json(
                    "timeout",
                    &child_chat_id,
                    "",
                    Some("subagent timed out"),
                    started.elapsed().as_nanos(),
                ));
            }
        };
    if cancelled.load(Ordering::SeqCst) {
        return Ok(subagent_result_json(
            "cancelled",
            &child_chat_id,
            "",
            Some("subagent cancelled"),
            started.elapsed().as_nanos(),
        ));
    }
    if status == "cancelled" {
        return Ok(subagent_result_json(
            "cancelled",
            &child_chat_id,
            "",
            Some("subagent cancelled"),
            started.elapsed().as_nanos(),
        ));
    }
    if status == "wait-input" {
        return Ok(subagent_result_json(
            "wait-input",
            &child_chat_id,
            "",
            Some("subagent requested user input"),
            started.elapsed().as_nanos(),
        ));
    }
    let output = extract_final_reply(&pool, &bundle, &child_chat_id)
        .await
        .unwrap_or_default();
    Ok(subagent_result_json(
        if output.trim().is_empty() {
            "failed"
        } else {
            "done"
        },
        &child_chat_id,
        &output,
        if output.trim().is_empty() {
            Some("subagent produced no final reply")
        } else {
            None
        },
        started.elapsed().as_nanos(),
    ))
}

fn build_subagent_task(req: &Value) -> String {
    let spec = req.get("spec").cloned().unwrap_or(Value::Null);
    let label = spec
        .get("label")
        .and_then(|v| v.as_str())
        .unwrap_or("Subagent task");
    let task = spec.get("task").and_then(|v| v.as_str()).unwrap_or("");
    let context = spec.get("context").and_then(|v| v.as_str()).unwrap_or("");
    let expected = spec
        .get("expectedOutput")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mut parts = vec![
        "You are a bounded subagent delegated by a parent agent.".to_string(),
        "Complete only the assigned task. Do not ask the user questions. Return a concise final report with evidence and file links when relevant.".to_string(),
        format!("Task label: {label}"),
        format!("Task:\n{task}"),
    ];
    if !context.trim().is_empty() {
        parts.push(format!("Context:\n{context}"));
    }
    if !expected.trim().is_empty() {
        parts.push(format!("Expected output:\n{expected}"));
    }
    parts.join("\n\n")
}

async fn drive_limited(
    pool: &Arc<Pool>,
    bundle: &Arc<String>,
    state: Value,
    max_steps: u64,
    cancelled: Arc<AtomicBool>,
) -> Result<String, String> {
    let lock_chat_id = state
        .get("chatId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let lock_arc = pool.chat_lock(&format!("chat:{lock_chat_id}"));
    let _guard = lock_arc.lock().await;
    let started_at = now_ms() as u64;
    publish_start_event(state.get("lifecycleEvents"), started_at);
    let _step_guard = StepLifecycle::new(
        state.get("lifecycleEvents"),
        Arc::new(AtomicBool::new(false)),
    );
    let mut next_input = json!({ "command": "step-next", "state": state });
    let mut steps = 0_u64;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Ok("cancelled".to_string());
        }
        let raw = call_v8(pool, bundle, next_input).await?;
        let value = unwrap_value(&raw)?;
        match value.get("kind").and_then(|v| v.as_str()) {
            Some("llm") => {
                steps = steps.saturating_add(1);
                if steps > max_steps {
                    return Err(format!("subagent exceeded maxSteps={max_steps}"));
                }
                let state = value.get("state").cloned().unwrap_or(Value::Null);
                let url = value
                    .get("url")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "step-next llm missing url".to_string())?
                    .to_string();
                let headers = value.get("headers").cloned().unwrap_or(json!({}));
                let body_value = value.get("body").cloned().unwrap_or(Value::Null);
                let body = serde_json::to_string(&body_value).unwrap_or_else(|_| "{}".to_string());
                let stream_events = value.get("streamEvents").cloned().unwrap_or(Value::Null);
                if let Some(delay_ms) = value
                    .get("delayMs")
                    .and_then(|v| v.as_u64())
                    .filter(|n| *n > 0)
                {
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                }
                let stream_started = std::time::Instant::now();
                let llm_result = llm::stream_chat(
                    pool.clone(),
                    bundle.clone(),
                    url,
                    headers,
                    body,
                    stream_events,
                )
                .await;
                let duration_ns =
                    u64::try_from(stream_started.elapsed().as_nanos()).unwrap_or(u64::MAX);
                next_input = json!({
                    "command": "step-next",
                    "state": state,
                    "llmResult": llm_result,
                    "llmDurationNs": duration_ns,
                });
            }
            Some("tool-ts") => {
                steps = steps.saturating_add(1);
                if steps > max_steps {
                    return Err(format!("subagent exceeded maxSteps={max_steps}"));
                }
                let state = value.get("state").cloned().unwrap_or(Value::Null);
                let tool_result =
                    run_ts_tool_async(pool, bundle, &value, None, cancelled.clone()).await;
                next_input = json!({
                    "command": "step-next",
                    "state": state,
                    "toolResult": tool_result,
                });
            }
            Some("wait-input") => return Ok("wait-input".to_string()),
            Some("done") => return Ok("done".to_string()),
            Some("error") => return Ok("error".to_string()),
            _ => return Ok("done".to_string()),
        }
    }
}

async fn extract_final_reply(
    pool: &Arc<Pool>,
    bundle: &Arc<String>,
    child_chat_id: &str,
) -> Result<String, String> {
    let raw = call_v8(
        pool,
        bundle,
        json!({ "command": "subagent-final", "chatId": child_chat_id }),
    )
    .await?;
    let value = unwrap_value(&raw)?;
    Ok(value
        .get("output")
        .or_else(|| value.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

fn subagent_result_json(
    status: &str,
    child_chat_id: &str,
    output: &str,
    error: Option<&str>,
    duration_ns: u128,
) -> String {
    let mut value = json!({
        "status": status,
        "childChatId": child_chat_id,
        "output": output,
        "error": error,
        "durationNs": u64::try_from(duration_ns).unwrap_or(u64::MAX),
    });
    if error.is_none() {
        value["error"] = Value::Null;
    }
    value.to_string()
}

async fn call_v8(pool: &Arc<Pool>, bundle: &Arc<String>, input: Value) -> Result<Value, String> {
    let pool = pool.clone();
    let bundle = bundle.clone();
    let input_str = input.to_string();
    let raw = tokio::task::spawn_blocking(move || pool.submit_unlocked(bundle, input_str))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))??;
    serde_json::from_str(&raw).map_err(|e| format!("parse v8 result: {e}"))
}

fn unwrap_value(v: &Value) -> Result<Value, String> {
    if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
        let msg = v
            .pointer("/error/message")
            .and_then(|x| x.as_str())
            .unwrap_or("v8 call failed");
        return Err(msg.to_string());
    }
    Ok(v.get("value").cloned().unwrap_or(Value::Null))
}

fn publish_start_event(events: Option<&Value>, started_at: u64) {
    if let Some(start) = events
        .filter(|v| v.is_object())
        .and_then(|v| v.get("start"))
        .filter(|v| v.is_object())
    {
        publish_event_payload_at(start, started_at);
    }
}

fn publish_event_payload(payload: &Value) {
    publish_event_payload_at(payload, now_ms() as u64);
}

fn publish_event_payload_at(payload: &Value, at: u64) {
    let mut payload = payload.clone();
    if let Some(obj) = payload.as_object_mut() {
        obj.entry("at").or_insert_with(|| json!(at));
    }
    if let Ok(s) = serde_json::to_string(&payload) {
        broadcast::publish(s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_registry_lock_recovers_from_poison() {
        let source = include_str!("driver.rs");
        assert!(source.contains("fn running_lock"));
        assert!(!source.contains(concat!("RUNNING", ".lock().unwrap()")));
        assert!(!source.contains(concat!("RUNNING", ".lock().expect")));
    }

    #[test]
    fn foreground_runts_lookup_is_step_scoped() {
        let chat_id = format!("test-chat-{}", now_ns());
        let state = Arc::new(Mutex::new(None));
        let cancel = Arc::new(AtomicBool::new(false));
        let background = Arc::new(AtomicBool::new(false));
        set_active_foreground_runts(
            &state,
            ForegroundRunTs {
                step_id: "step:active".to_string(),
                cancel: cancel.clone(),
                background: background.clone(),
            },
        );

        let handle = runtime().spawn(async {});
        running_lock().insert(
            chat_id.clone(),
            RunningChat {
                handle,
                run_id: 0,
                started_at: 0,
                end_event: None,
                ended: Arc::new(AtomicBool::new(false)),
                foreground_runts: state.clone(),
            },
        );

        assert!(active_foreground_runts(&state, Some("step:other")).is_none());
        assert!(!request_foreground_runts_background(
            &chat_id,
            Some("step:other")
        ));
        assert_eq!(cancel_runts(&chat_id, Some("step:other")), 0);
        assert!(!cancel.load(Ordering::SeqCst));
        assert!(!background.load(Ordering::SeqCst));

        assert!(request_foreground_runts_background(
            &chat_id,
            Some("step:active")
        ));
        assert!(background.load(Ordering::SeqCst));

        let active = active_foreground_runts(&state, Some("step:active")).unwrap();
        assert_eq!(cancel_runts(&chat_id, Some("step:active")), 1);
        assert!(cancel.load(Ordering::SeqCst));
        assert_eq!(cancel_runts(&chat_id, Some("step:active")), 0);

        clear_active_foreground_runts(&state, "step:other");
        assert!(active_foreground_runts(&state, None).is_some());
        clear_active_foreground_runts(&state, "step:active");
        assert!(active_foreground_runts(&state, None).is_none());

        if let Some(running) = running_lock().remove(&chat_id) {
            running.handle.abort();
        }
        drop(active);
    }
}
