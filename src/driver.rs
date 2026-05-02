// Chat driver runtime.
//
// TypeScript owns the chat/agent state machine behind the step-next harness
// command. Rust keeps only process concerns: one in-flight task per chat, the
// per-chat lock, interruption, short V8 calls, and long-running LLM transport
// without pinning a V8 worker.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use serde_json::{Value, json};
use tokio::task::JoinHandle;

use crate::async_runtime::runtime;
use crate::broadcast;
use crate::ops::llm;
use crate::pool::Pool;
use crate::runtime::{AgentRunHandler, AsyncOpCompletion, AsyncOpHandle};
use crate::util::now_ms;

// Tracks the in-flight tokio task for each chat so /api/run interrupt can
// abort it. Aborting drops the task at its next await; the StepLifecycle
// guard's Drop publishes step-end and the chat lock is released.
struct RunningChat {
    handle: JoinHandle<()>,
    started_at: u64,
    end_event: Option<Value>,
    ended: Arc<AtomicBool>,
}

static RUNNING: LazyLock<Mutex<HashMap<String, RunningChat>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn dispatch_drive(pool: Arc<Pool>, bundle: Arc<String>, state: Value) {
    dispatch_state(pool, bundle, state);
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
    let cid = chat_id.clone();
    let end_event = state
        .get("lifecycleEvents")
        .and_then(|v| v.get("end"))
        .filter(|v| v.is_object())
        .cloned();
    let ended = Arc::new(AtomicBool::new(false));
    let task_ended = ended.clone();
    let handle = runtime().spawn(async move {
        if let Err(e) = drive(pool, bundle, chat_id.clone(), state, task_ended).await {
            eprintln!("chat driver [{chat_id}]: {e}");
        }
        RUNNING.lock().unwrap().remove(&chat_id);
    });
    if let Some(prev) = RUNNING.lock().unwrap().insert(
        cid,
        RunningChat {
            handle,
            started_at: now_ms() as u64,
            end_event,
            ended,
        },
    ) {
        prev.handle.abort();
    }
}

async fn drive(
    pool: Arc<Pool>,
    bundle: Arc<String>,
    chat_id: String,
    state: Value,
    ended: Arc<AtomicBool>,
) -> Result<(), String> {
    let lock_arc = pool.chat_lock(&format!("chat:{chat_id}"));
    let _guard = lock_arc.lock().await;

    let started_at = now_ms() as u64;
    if let Some(running) = RUNNING.lock().unwrap().get_mut(&chat_id) {
        running.started_at = started_at;
    }
    let _step_guard = StepLifecycle::start(state.get("lifecycleEvents"), started_at, ended);
    drive_loop(&pool, &bundle, state).await
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
    let Some(running) = RUNNING.lock().unwrap().remove(chat_id) else {
        return false;
    };
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
    true
}

pub fn running_ids() -> Vec<String> {
    RUNNING.lock().unwrap().keys().cloned().collect()
}

pub fn running_started_at() -> HashMap<String, u64> {
    RUNNING
        .lock()
        .unwrap()
        .iter()
        .map(|(chat_id, running)| (chat_id.clone(), running.started_at))
        .collect()
}

struct StepLifecycle {
    end_event: Option<Value>,
    ended: Arc<AtomicBool>,
}

impl StepLifecycle {
    fn start(events: Option<&Value>, started_at: u64, ended: Arc<AtomicBool>) -> Self {
        let events = events.filter(|v| v.is_object());
        if let Some(start) = events
            .and_then(|v| v.get("start"))
            .filter(|v| v.is_object())
        {
            publish_event_payload_at(start, started_at);
        }
        Self {
            end_event: events
                .and_then(|v| v.get("end"))
                .filter(|v| v.is_object())
                .cloned(),
            ended,
        }
    }
}

impl Drop for StepLifecycle {
    fn drop(&mut self) {
        if self.ended.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(end_event) = &self.end_event {
            publish_event_payload(end_event);
        }
    }
}

async fn drive_loop(pool: &Arc<Pool>, bundle: &Arc<String>, state: Value) -> Result<(), String> {
    let mut next_input = json!({ "command": "step-next", "state": state });

    loop {
        let raw = call_v8(pool, bundle, next_input).await?;
        let value = unwrap_value(&raw)?;
        match value.get("kind").and_then(|v| v.as_str()) {
            Some("llm") => {
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

                // No V8 worker held during this call.
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
                let duration_ms =
                    u64::try_from(stream_started.elapsed().as_millis()).unwrap_or(u64::MAX);

                next_input = json!({
                    "command": "step-next",
                    "state": state,
                    "llmResult": llm_result,
                    "llmDurationMs": duration_ms,
                });
            }
            Some("tool-js") => {
                let state = value.get("state").cloned().unwrap_or(Value::Null);
                let tool_result = run_js_tool_async(pool, bundle, &value).await;
                next_input = json!({
                    "command": "step-next",
                    "state": state,
                    "toolResult": tool_result,
                });
            }
            Some("done") | Some("wait-input") | Some("error") => return Ok(()),
            _ => return Ok(()),
        }
    }
}

async fn run_js_tool_async(pool: &Arc<Pool>, bundle: &Arc<String>, value: &Value) -> Value {
    let chat_id = value
        .pointer("/state/chatId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let tool_call = value.get("toolCall").cloned().unwrap_or(Value::Null);
    let tool_call_id = tool_call
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let input = json!({
        "command": "run-js-tool",
        "chatId": chat_id,
        "state": value.get("state").cloned().unwrap_or(Value::Null),
        "toolCall": tool_call,
        "model": value.get("model").cloned().unwrap_or(Value::Null),
    });
    let handler = make_agent_run_handler(pool.clone(), bundle.clone());
    let pool2 = pool.clone();
    let bundle2 = bundle.clone();
    let input_str = input.to_string();
    let raw =
        tokio::task::spawn_blocking(move || pool2.submit_async_tool(bundle2, input_str, handler))
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
                "content": "error: runJS returned an invalid harness response",
                "status": "failed",
            }),
        },
        Err(e) => json!({
            "toolCallId": tool_call_id,
            "content": format!("error: {e}"),
            "status": "failed",
        }),
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
    let max_turns = req
        .pointer("/limits/maxTurns")
        .and_then(|v| v.as_u64())
        .unwrap_or(6);
    let timeout_ms = req
        .pointer("/limits/timeoutMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(600_000);
    let started = std::time::Instant::now();
    let state = json!({
        "chatId": child_chat_id.clone(),
        "mode": "step",
        "message": task,
        "lifecycleEvents": {
            "start": { "kind": "step-start", "chatId": child_chat_id },
            "end": { "kind": "step-end", "chatId": child_chat_id }
        }
    });
    let drive = drive_limited(&pool, &bundle, state, max_turns, cancelled.clone());
    let status =
        match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), drive).await {
            Ok(Ok(done)) => done,
            Ok(Err(e)) => {
                return Ok(subagent_result_json(
                    "failed",
                    &child_chat_id,
                    "",
                    Some(&e),
                    started.elapsed().as_millis(),
                ));
            }
            Err(_) => {
                cancelled.store(true, Ordering::SeqCst);
                return Ok(subagent_result_json(
                    "timeout",
                    &child_chat_id,
                    "",
                    Some("subagent timed out"),
                    started.elapsed().as_millis(),
                ));
            }
        };
    if cancelled.load(Ordering::SeqCst) {
        return Ok(subagent_result_json(
            "cancelled",
            &child_chat_id,
            "",
            Some("subagent cancelled"),
            started.elapsed().as_millis(),
        ));
    }
    if status == "cancelled" {
        return Ok(subagent_result_json(
            "cancelled",
            &child_chat_id,
            "",
            Some("subagent cancelled"),
            started.elapsed().as_millis(),
        ));
    }
    if status == "wait-input" {
        return Ok(subagent_result_json(
            "wait-input",
            &child_chat_id,
            "",
            Some("subagent requested user input"),
            started.elapsed().as_millis(),
        ));
    }
    let text = extract_final_reply(&pool, &bundle, &child_chat_id)
        .await
        .unwrap_or_default();
    Ok(subagent_result_json(
        if text.trim().is_empty() {
            "failed"
        } else {
            "done"
        },
        &child_chat_id,
        &text,
        if text.trim().is_empty() {
            Some("subagent produced no final reply")
        } else {
            None
        },
        started.elapsed().as_millis(),
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
    max_turns: u64,
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
    let _step_guard = StepLifecycle::start(state.get("lifecycleEvents"), started_at, Arc::new(AtomicBool::new(false)));
    let mut next_input = json!({ "command": "step-next", "state": state });
    let mut llm_turns = 0_u64;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Ok("cancelled".to_string());
        }
        let raw = call_v8(pool, bundle, next_input).await?;
        let value = unwrap_value(&raw)?;
        match value.get("kind").and_then(|v| v.as_str()) {
            Some("llm") => {
                llm_turns = llm_turns.saturating_add(1);
                if llm_turns > max_turns {
                    return Err(format!("subagent exceeded maxTurns={max_turns}"));
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
                let duration_ms =
                    u64::try_from(stream_started.elapsed().as_millis()).unwrap_or(u64::MAX);
                next_input = json!({
                    "command": "step-next",
                    "state": state,
                    "llmResult": llm_result,
                    "llmDurationMs": duration_ms,
                });
            }
            Some("tool-js") => {
                let state = value.get("state").cloned().unwrap_or(Value::Null);
                let tool_result = run_js_tool_async(pool, bundle, &value).await;
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
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

fn subagent_result_json(
    status: &str,
    child_chat_id: &str,
    text: &str,
    error: Option<&str>,
    duration_ms: u128,
) -> String {
    let mut value = json!({
        "status": status,
        "childChatId": child_chat_id,
        "text": text,
        "error": error,
        "durationMs": u64::try_from(duration_ms).unwrap_or(u64::MAX),
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
