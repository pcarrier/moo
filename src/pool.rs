// Worker pool of recyclable V8 isolates.
//
// Each worker owns one SQLite connection and one V8 runtime generation at a
// time. Generations are reused for hot-path latency, observed continuously, and
// recycled after memory pressure or dirty failures.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::thread;
use std::time::{Duration, Instant};

use rusty_v8 as v8;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Mutex as TokioMutex;

use crate::cdp;
use crate::driver;
use crate::host;
use crate::runtime;
use crate::runtime::AgentRunHandler;
use crate::settings;
use crate::snapshots;
use crate::util::{now_ms, sha256_object_hash};

pub const DEFAULT_MAX_WORKERS: usize = 16;
pub const DEFAULT_MAX_OLD_GENERATION_BYTES: usize = 128 * 1024 * 1024;
pub const DEFAULT_MAX_YOUNG_GENERATION_BYTES: usize = 16 * 1024 * 1024;
pub const DEFAULT_RECYCLE_USED_HEAP_BYTES: usize = 96 * 1024 * 1024;
pub const DEFAULT_AUTOSCALE_WINDOW_SECS: u64 = 30;
const MIN_HEAP_LIMIT_BYTES: usize = 1024 * 1024;
const V8_EVENTS_MAX: usize = 1000;
const V8_LANES: &[&str] = &[
    "moo-worker",
    "moo-read-worker",
    "moo-scan-worker",
    "moo-ui-worker",
    "moo-tool-worker",
];

static V8_CONFIG_OVERRIDES: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static V8_OBSERVABILITY: LazyLock<Arc<V8Observability>> =
    LazyLock::new(|| Arc::new(V8Observability::new()));

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V8PoolRuntimeSettings {
    pub max_workers: Option<usize>,
    pub max_old_generation_bytes: Option<usize>,
    pub max_young_generation_bytes: Option<usize>,
    pub recycle_used_heap_bytes: Option<usize>,
    pub autoscale_window_secs: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V8RuntimeSettings {
    // Legacy/global fields are kept for compatibility with existing settings.
    pub max_workers: Option<usize>,
    pub read_max_workers: Option<usize>,
    pub scan_max_workers: Option<usize>,
    pub ui_max_workers: Option<usize>,
    pub tool_max_workers: Option<usize>,
    pub max_old_generation_bytes: Option<usize>,
    pub max_young_generation_bytes: Option<usize>,
    pub recycle_used_heap_bytes: Option<usize>,
    pub autoscale_window_secs: Option<u64>,
    pub startup_snapshots_enabled: Option<bool>,
    pub main_pool: Option<V8PoolRuntimeSettings>,
    pub read_pool: Option<V8PoolRuntimeSettings>,
    pub scan_pool: Option<V8PoolRuntimeSettings>,
    pub ui_pool: Option<V8PoolRuntimeSettings>,
    pub tool_pool: Option<V8PoolRuntimeSettings>,
}

fn pool_settings(
    max_workers: usize,
    max_old_generation_bytes: usize,
    max_young_generation_bytes: usize,
    recycle_used_heap_bytes: usize,
    autoscale_window_secs: u64,
) -> V8PoolRuntimeSettings {
    V8PoolRuntimeSettings {
        max_workers: Some(max_workers),
        max_old_generation_bytes: Some(max_old_generation_bytes),
        max_young_generation_bytes: Some(max_young_generation_bytes),
        recycle_used_heap_bytes: Some(recycle_used_heap_bytes),
        autoscale_window_secs: Some(autoscale_window_secs.max(1)),
    }
}

pub fn default_v8_runtime_settings() -> V8RuntimeSettings {
    V8RuntimeSettings {
        max_workers: Some(DEFAULT_MAX_WORKERS),
        read_max_workers: Some(default_read_max_workers(DEFAULT_MAX_WORKERS)),
        scan_max_workers: Some(1),
        ui_max_workers: Some(default_ui_max_workers(DEFAULT_MAX_WORKERS)),
        tool_max_workers: Some(default_tool_max_workers(DEFAULT_MAX_WORKERS)),
        max_old_generation_bytes: Some(DEFAULT_MAX_OLD_GENERATION_BYTES),
        max_young_generation_bytes: Some(DEFAULT_MAX_YOUNG_GENERATION_BYTES),
        recycle_used_heap_bytes: Some(DEFAULT_RECYCLE_USED_HEAP_BYTES),
        autoscale_window_secs: Some(DEFAULT_AUTOSCALE_WINDOW_SECS),
        startup_snapshots_enabled: Some(true),
        main_pool: Some(pool_settings(
            DEFAULT_MAX_WORKERS,
            DEFAULT_MAX_OLD_GENERATION_BYTES,
            DEFAULT_MAX_YOUNG_GENERATION_BYTES,
            DEFAULT_RECYCLE_USED_HEAP_BYTES,
            DEFAULT_AUTOSCALE_WINDOW_SECS,
        )),
        read_pool: Some(pool_settings(
            default_read_max_workers(DEFAULT_MAX_WORKERS),
            DEFAULT_MAX_OLD_GENERATION_BYTES,
            DEFAULT_MAX_YOUNG_GENERATION_BYTES,
            DEFAULT_RECYCLE_USED_HEAP_BYTES,
            DEFAULT_AUTOSCALE_WINDOW_SECS,
        )),
        scan_pool: Some(pool_settings(
            1,
            DEFAULT_MAX_OLD_GENERATION_BYTES,
            DEFAULT_MAX_YOUNG_GENERATION_BYTES,
            DEFAULT_RECYCLE_USED_HEAP_BYTES,
            DEFAULT_AUTOSCALE_WINDOW_SECS,
        )),
        ui_pool: Some(pool_settings(
            default_ui_max_workers(DEFAULT_MAX_WORKERS),
            DEFAULT_MAX_OLD_GENERATION_BYTES,
            DEFAULT_MAX_YOUNG_GENERATION_BYTES,
            DEFAULT_RECYCLE_USED_HEAP_BYTES,
            DEFAULT_AUTOSCALE_WINDOW_SECS,
        )),
        tool_pool: Some(pool_settings(
            default_tool_max_workers(DEFAULT_MAX_WORKERS),
            DEFAULT_MAX_OLD_GENERATION_BYTES,
            DEFAULT_MAX_YOUNG_GENERATION_BYTES,
            DEFAULT_RECYCLE_USED_HEAP_BYTES,
            DEFAULT_AUTOSCALE_WINDOW_SECS,
        )),
    }
}

pub fn effective_v8_runtime_settings() -> V8RuntimeSettings {
    V8RuntimeSettings {
        max_workers: Some(configured_max_workers()),
        read_max_workers: Some(configured_read_max_workers()),
        scan_max_workers: Some(configured_scan_max_workers()),
        ui_max_workers: Some(configured_ui_max_workers()),
        tool_max_workers: Some(configured_tool_max_workers()),
        max_old_generation_bytes: Some(max_old_generation_bytes_for_lane("moo-worker")),
        max_young_generation_bytes: Some(max_young_generation_bytes_for_lane("moo-worker")),
        recycle_used_heap_bytes: Some(recycle_used_heap_bytes_for_lane("moo-worker")),
        autoscale_window_secs: Some(autoscale_window_secs_for_lane("moo-worker")),
        startup_snapshots_enabled: Some(startup_snapshots_enabled()),
        main_pool: Some(effective_pool_settings("moo-worker")),
        read_pool: Some(effective_pool_settings("moo-read-worker")),
        scan_pool: Some(effective_pool_settings("moo-scan-worker")),
        ui_pool: Some(effective_pool_settings("moo-ui-worker")),
        tool_pool: Some(effective_pool_settings("moo-tool-worker")),
    }
}

fn normalize_pool_runtime_settings(settings: &mut Option<V8PoolRuntimeSettings>) {
    let Some(settings) = settings.as_mut() else {
        return;
    };
    if let Some(value) = settings.max_workers.as_mut() {
        *value = (*value).max(1);
    }
    if let Some(value) = settings.max_old_generation_bytes.as_mut() {
        *value = (*value).max(MIN_HEAP_LIMIT_BYTES);
    }
    if let Some(value) = settings.max_young_generation_bytes.as_mut() {
        *value = (*value).max(MIN_HEAP_LIMIT_BYTES);
    }
    if let Some(value) = settings.recycle_used_heap_bytes.as_mut() {
        *value = (*value).max(MIN_HEAP_LIMIT_BYTES);
    }
    if let Some(value) = settings.autoscale_window_secs.as_mut() {
        *value = (*value).max(1);
    }
}

pub fn normalize_v8_runtime_settings(mut settings: V8RuntimeSettings) -> V8RuntimeSettings {
    if let Some(value) = settings.max_workers.as_mut() {
        *value = (*value).max(1);
    }
    if let Some(value) = settings.read_max_workers.as_mut() {
        *value = (*value).max(1);
    }
    if let Some(value) = settings.scan_max_workers.as_mut() {
        *value = (*value).max(1);
    }
    if let Some(value) = settings.ui_max_workers.as_mut() {
        *value = (*value).max(1);
    }
    if let Some(value) = settings.tool_max_workers.as_mut() {
        *value = (*value).max(1);
    }
    if let Some(value) = settings.max_old_generation_bytes.as_mut() {
        *value = (*value).max(MIN_HEAP_LIMIT_BYTES);
    }
    if let Some(value) = settings.max_young_generation_bytes.as_mut() {
        *value = (*value).max(MIN_HEAP_LIMIT_BYTES);
    }
    if let Some(value) = settings.recycle_used_heap_bytes.as_mut() {
        *value = (*value).max(MIN_HEAP_LIMIT_BYTES);
    }
    if let Some(value) = settings.autoscale_window_secs.as_mut() {
        *value = (*value).max(1);
    }
    normalize_pool_runtime_settings(&mut settings.main_pool);
    normalize_pool_runtime_settings(&mut settings.read_pool);
    normalize_pool_runtime_settings(&mut settings.scan_pool);
    normalize_pool_runtime_settings(&mut settings.ui_pool);
    normalize_pool_runtime_settings(&mut settings.tool_pool);
    settings
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V8StatsSnapshot {
    pub generated_at: i64,
    pub workers: Vec<V8WorkerSnapshot>,
    pub pools: Vec<V8PoolQueueSnapshot>,
    pub events: Vec<V8Event>,
    pub config: V8ConfigSnapshot,
    pub totals: V8TotalsSnapshot,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V8ConfigSnapshot {
    // Legacy main-pool fields are kept for compatibility with existing callers.
    pub recycle_used_heap_bytes: usize,
    pub max_old_generation_bytes: usize,
    pub max_young_generation_bytes: usize,
    pub cache_entries: usize,
    pub startup_snapshots_enabled: bool,
    pub max_workers: usize,
    pub autoscale_window_secs: u64,
    pub pools: Vec<V8PoolConfigSnapshot>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V8PoolConfigSnapshot {
    pub lane: String,
    pub max_workers: usize,
    pub recycle_used_heap_bytes: usize,
    pub max_old_generation_bytes: usize,
    pub max_young_generation_bytes: usize,
    pub autoscale_window_secs: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V8TotalsSnapshot {
    pub workers: usize,
    pub busy: usize,
    pub queued: usize,
    pub total_enqueued: u64,
    pub max_queued: usize,
    pub total_jobs: u64,
    pub total_errors: u64,
    pub total_terminations: u64,
    pub total_recycles: u64,
    pub total_near_heap_limit: u64,
    pub total_cache_hits: u64,
    pub total_cache_misses: u64,
    pub total_snapshot_hits: u64,
    pub total_snapshot_misses: u64,
    pub used_heap_size: usize,
    pub total_heap_size: usize,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V8PoolQueueSnapshot {
    pub lane: String,
    pub queued: usize,
    pub active_workers: usize,
    pub max_workers: usize,
    pub busy_workers: usize,
    pub recent_max_utilization: usize,
    pub autoscale_window_secs: u64,
    pub total_enqueued: u64,
    pub max_queued: usize,
    pub last_queue_wait_ms: u64,
    pub max_queue_wait_ms: u64,
    pub total_queue_wait_ms: u64,
    pub observed_queue_waits: u64,
    pub average_queue_wait_ms: u64,
    pub total_jobs: u64,
    pub total_errors: u64,
    pub total_terminations: u64,
    pub total_recycles: u64,
    pub total_near_heap_limit: u64,
    pub total_cache_hits: u64,
    pub total_cache_misses: u64,
    pub total_snapshot_hits: u64,
    pub total_snapshot_misses: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V8WorkerSnapshot {
    pub key: String,
    pub lane: String,
    pub worker_id: usize,
    pub generation: u64,
    pub status: String,
    pub current_command: Option<String>,
    pub current_job_started_at: Option<i64>,
    pub current_job_elapsed_ns: Option<u64>,
    pub jobs: u64,
    pub generation_jobs: u64,
    pub errors: u64,
    pub terminations: u64,
    pub recycles: u64,
    pub near_heap_limit: u64,
    pub cache_hits: u64,
    pub cache_misses: u64,
    pub snapshot_hits: u64,
    pub snapshot_misses: u64,
    pub last_duration_ns: u64,
    pub last_queue_wait_ms: u64,
    pub last_command: Option<String>,
    pub last_context_kind: Option<String>,
    pub last_error: Option<String>,
    pub last_recycle_reason: Option<String>,
    pub last_recycle_at: Option<i64>,
    pub created_at: i64,
    pub generation_started_at: i64,
    pub cache_entries: usize,
    pub snapshot_loaded: bool,
    pub snapshot_hash: Option<String>,
    pub heap: Option<V8HeapSnapshot>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V8HeapSnapshot {
    pub total_heap_size: usize,
    pub total_heap_size_executable: usize,
    pub total_physical_size: usize,
    pub total_available_size: usize,
    pub used_heap_size: usize,
    pub heap_size_limit: usize,
    pub malloced_memory: usize,
    pub external_memory: usize,
    pub peak_malloced_memory: usize,
    pub total_global_handles_size: usize,
    pub used_global_handles_size: usize,
    pub number_of_native_contexts: usize,
    pub number_of_detached_contexts: usize,
    pub total_allocated_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V8Event {
    pub at: i64,
    pub worker: String,
    pub lane: String,
    pub worker_id: usize,
    pub generation: u64,
    pub kind: String,
    pub reason: Option<String>,
    pub command: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ContextKind {
    Cached,
    Fresh,
    Snapshot,
    SnapshotOneShot,
    Cdp,
}

impl ContextKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cached => "cached",
            Self::Fresh => "fresh",
            Self::Snapshot => "snapshot",
            Self::SnapshotOneShot => "snapshot-one-shot",
            Self::Cdp => "cdp",
        }
    }
}

#[derive(Default)]
struct V8Observability {
    workers: Mutex<HashMap<String, V8WorkerState>>,
    queues: Mutex<HashMap<String, V8PoolQueueSnapshot>>,
    events: Mutex<VecDeque<V8Event>>,
}

#[derive(Clone, Debug)]
struct V8WorkerState {
    snapshot: V8WorkerSnapshot,
    current_started_instant: Option<Instant>,
}

struct JobOutcome {
    result: Result<String, String>,
    report: Option<runtime::RunReport>,
    context_kind: ContextKind,
    cache_hit: Option<bool>,
    snapshot_hit: Option<bool>,
}

impl V8Observability {
    fn new() -> Self {
        Self::default()
    }

    fn register_worker(&self, lane: &str, id: usize) {
        self.register_pool(lane);
        let key = worker_key(lane, id);
        let now = now_ms();
        let snapshot = V8WorkerSnapshot {
            key: key.clone(),
            lane: lane.to_string(),
            worker_id: id,
            generation: 0,
            status: "starting".to_string(),
            created_at: now,
            generation_started_at: now,
            ..Default::default()
        };
        self.workers.lock().unwrap_or_else(|e| e.into_inner()).insert(
            key.clone(),
            V8WorkerState {
                snapshot,
                current_started_instant: None,
            },
        );
        self.push_event(V8Event {
            at: now,
            worker: key,
            lane: lane.to_string(),
            worker_id: id,
            generation: 0,
            kind: "worker-start".to_string(),
            reason: None,
            command: None,
            detail: None,
        });
    }

    fn register_pool(&self, lane: &str) {
        self.queues
            .lock()
            .expect("queues lock")
            .entry(lane.to_string())
            .or_insert_with(|| V8PoolQueueSnapshot {
                lane: lane.to_string(),
                ..Default::default()
            });
    }

    fn pool_runtime_update(&self, lane: &str, update: PoolRuntimeUpdate) {
        let mut queues = self.queues.lock().unwrap_or_else(|e| e.into_inner());
        let queue = queues
            .entry(lane.to_string())
            .or_insert_with(|| V8PoolQueueSnapshot {
                lane: lane.to_string(),
                ..Default::default()
            });
        queue.active_workers = update.active_workers;
        queue.max_workers = update.max_workers;
        queue.busy_workers = update.busy_workers;
        queue.recent_max_utilization = update.recent_max_utilization;
        queue.autoscale_window_secs = update.autoscale_window_secs;
        queue.queued = update.queued;
        queue.max_queued = queue.max_queued.max(update.queued);
    }

    fn job_queued(&self, lane: &str) {
        let mut queues = self.queues.lock().unwrap_or_else(|e| e.into_inner());
        let queue = queues
            .entry(lane.to_string())
            .or_insert_with(|| V8PoolQueueSnapshot {
                lane: lane.to_string(),
                ..Default::default()
            });
        queue.queued = queue.queued.saturating_add(1);
        queue.total_enqueued = queue.total_enqueued.saturating_add(1);
        queue.max_queued = queue.max_queued.max(queue.queued);
    }

    fn observe_queue_wait(&self, lane: &str, queue_wait_ms: u64) {
        let mut queues = self.queues.lock().unwrap_or_else(|e| e.into_inner());
        let queue = queues
            .entry(lane.to_string())
            .or_insert_with(|| V8PoolQueueSnapshot {
                lane: lane.to_string(),
                ..Default::default()
            });
        queue.last_queue_wait_ms = queue_wait_ms;
        queue.max_queue_wait_ms = queue.max_queue_wait_ms.max(queue_wait_ms);
        queue.total_queue_wait_ms = queue.total_queue_wait_ms.saturating_add(queue_wait_ms);
        queue.observed_queue_waits = queue.observed_queue_waits.saturating_add(1);
        queue.average_queue_wait_ms = queue
            .total_queue_wait_ms
            .checked_div(queue.observed_queue_waits)
            .unwrap_or(0);
    }

    fn generation_started(&self, lane: &str, id: usize, generation: u64) {
        let key = worker_key(lane, id);
        let now = now_ms();
        if let Some(state) = self.workers.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&key) {
            state.snapshot.generation = generation;
            state.snapshot.status = "idle".to_string();
            state.snapshot.generation_started_at = now;
            state.snapshot.generation_jobs = 0;
            state.snapshot.current_command = None;
            state.snapshot.current_job_started_at = None;
            state.snapshot.current_job_elapsed_ns = None;
            state.snapshot.snapshot_loaded = false;
            state.snapshot.snapshot_hash = None;
            state.snapshot.cache_entries = 0;
            state.current_started_instant = None;
        }
        self.push_event(V8Event {
            at: now,
            worker: key,
            lane: lane.to_string(),
            worker_id: id,
            generation,
            kind: "generation-start".to_string(),
            reason: None,
            command: None,
            detail: None,
        });
    }

    fn job_start(&self, lane: &str, id: usize, generation: u64, command: &str) {
        let key = worker_key(lane, id);
        let now = now_ms();
        if let Some(state) = self.workers.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&key) {
            state.snapshot.status = "busy".to_string();
            state.snapshot.current_command = Some(command.to_string());
            state.snapshot.current_job_started_at = Some(now);
            state.snapshot.current_job_elapsed_ns = Some(0);
            state.current_started_instant = Some(Instant::now());
        }
        self.push_event(V8Event {
            at: now,
            worker: key,
            lane: lane.to_string(),
            worker_id: id,
            generation,
            kind: "job-start".to_string(),
            reason: None,
            command: Some(command.to_string()),
            detail: None,
        });
    }

    fn job_end(&self, lane: &str, id: usize, generation: u64, update: JobMetricsUpdate) {
        self.observe_queue_wait(lane, update.queue_wait_ms);
        let key = worker_key(lane, id);
        let now = now_ms();
        let mut event_detail = None;
        if let Some(state) = self.workers.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&key) {
            let snapshot = &mut state.snapshot;
            snapshot.status = "idle".to_string();
            snapshot.current_command = None;
            snapshot.current_job_started_at = None;
            snapshot.current_job_elapsed_ns = None;
            snapshot.jobs = snapshot.jobs.saturating_add(1);
            snapshot.generation_jobs = snapshot.generation_jobs.saturating_add(1);
            snapshot.last_duration_ns = update.duration_ns;
            snapshot.last_queue_wait_ms = update.queue_wait_ms;
            snapshot.last_command = Some(update.command.clone());
            snapshot.last_context_kind = Some(update.context_kind.as_str().to_string());
            snapshot.cache_entries = update.cache_entries;
            snapshot.heap = update.heap.clone();
            snapshot.snapshot_loaded = update.snapshot_loaded;
            snapshot.snapshot_hash = update.snapshot_hash.clone();
            if update.ok {
                snapshot.last_error = None;
            } else {
                snapshot.errors = snapshot.errors.saturating_add(1);
                snapshot.last_error = update.error.clone();
            }
            if update.terminated {
                snapshot.terminations = snapshot.terminations.saturating_add(1);
            }
            if update.near_heap_limit {
                snapshot.near_heap_limit = snapshot.near_heap_limit.saturating_add(1);
            }
            if let Some(hit) = update.cache_hit {
                if hit {
                    snapshot.cache_hits = snapshot.cache_hits.saturating_add(1);
                } else {
                    snapshot.cache_misses = snapshot.cache_misses.saturating_add(1);
                }
            }
            if let Some(hit) = update.snapshot_hit {
                if hit {
                    snapshot.snapshot_hits = snapshot.snapshot_hits.saturating_add(1);
                } else {
                    snapshot.snapshot_misses = snapshot.snapshot_misses.saturating_add(1);
                }
            }
            state.current_started_instant = None;
            event_detail = update.error.clone();
        }
        self.push_event(V8Event {
            at: now,
            worker: key,
            lane: lane.to_string(),
            worker_id: id,
            generation,
            kind: if update.ok { "job-end" } else { "job-error" }.to_string(),
            reason: if update.terminated {
                Some("terminated".to_string())
            } else if update.near_heap_limit {
                Some("near-heap-limit".to_string())
            } else {
                None
            },
            command: Some(update.command),
            detail: event_detail,
        });
    }

    fn snapshot_build_error(
        &self,
        lane: &str,
        id: usize,
        generation: u64,
        command: &str,
        err: String,
    ) {
        self.push_event(V8Event {
            at: now_ms(),
            worker: worker_key(lane, id),
            lane: lane.to_string(),
            worker_id: id,
            generation,
            kind: "snapshot-build-error".to_string(),
            reason: Some("snapshot-build".to_string()),
            command: Some(command.to_string()),
            detail: Some(err),
        });
    }

    fn recycle(&self, lane: &str, id: usize, generation: u64, reason: &str) {
        let key = worker_key(lane, id);
        let now = now_ms();
        if let Some(state) = self.workers.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&key) {
            state.snapshot.recycles = state.snapshot.recycles.saturating_add(1);
            state.snapshot.status = "recycling".to_string();
            state.snapshot.last_recycle_reason = Some(reason.to_string());
            state.snapshot.last_recycle_at = Some(now);
        }
        self.push_event(V8Event {
            at: now,
            worker: key,
            lane: lane.to_string(),
            worker_id: id,
            generation,
            kind: "recycle".to_string(),
            reason: Some(reason.to_string()),
            command: None,
            detail: None,
        });
    }

    fn worker_exit(&self, lane: &str, id: usize, generation: u64) {
        let key = worker_key(lane, id);
        let now = now_ms();
        let snapshot = self
            .workers
            .lock()
            .expect("workers lock")
            .remove(&key)
            .map(|state| state.snapshot);
        if let Some(snapshot) = snapshot.as_ref() {
            self.aggregate_worker_totals(snapshot);
        }
        self.push_event(V8Event {
            at: now,
            worker: key,
            lane: lane.to_string(),
            worker_id: id,
            generation,
            kind: "worker-exit".to_string(),
            reason: None,
            command: None,
            detail: None,
        });
    }

    fn aggregate_worker_totals(&self, snapshot: &V8WorkerSnapshot) {
        let mut queues = self.queues.lock().unwrap_or_else(|e| e.into_inner());
        let queue = queues
            .entry(snapshot.lane.clone())
            .or_insert_with(|| V8PoolQueueSnapshot {
                lane: snapshot.lane.clone(),
                ..Default::default()
            });
        queue.total_jobs = queue.total_jobs.saturating_add(snapshot.jobs);
        queue.total_errors = queue.total_errors.saturating_add(snapshot.errors);
        queue.total_terminations = queue
            .total_terminations
            .saturating_add(snapshot.terminations);
        queue.total_recycles = queue.total_recycles.saturating_add(snapshot.recycles);
        queue.total_near_heap_limit = queue
            .total_near_heap_limit
            .saturating_add(snapshot.near_heap_limit);
        queue.total_cache_hits = queue.total_cache_hits.saturating_add(snapshot.cache_hits);
        queue.total_cache_misses = queue
            .total_cache_misses
            .saturating_add(snapshot.cache_misses);
        queue.total_snapshot_hits = queue
            .total_snapshot_hits
            .saturating_add(snapshot.snapshot_hits);
        queue.total_snapshot_misses = queue
            .total_snapshot_misses
            .saturating_add(snapshot.snapshot_misses);
    }

    fn snapshot(&self) -> V8StatsSnapshot {
        let generated_at = now_ms();
        let mut workers: Vec<V8WorkerSnapshot> = self
            .workers
            .lock()
            .expect("workers lock")
            .values()
            .map(|state| {
                let mut snapshot = state.snapshot.clone();
                if let Some(started) = state.current_started_instant {
                    snapshot.current_job_elapsed_ns = Some(started.elapsed().as_nanos() as u64);
                }
                snapshot
            })
            .collect();
        workers.sort_by(|a, b| a.lane.cmp(&b.lane).then(a.worker_id.cmp(&b.worker_id)));
        let mut pool_map: HashMap<String, V8PoolQueueSnapshot> = self
            .queues
            .lock()
            .expect("queues lock")
            .values()
            .map(|pool| (pool.lane.clone(), pool.clone()))
            .collect();
        for lane in V8_LANES {
            pool_map
                .entry((*lane).to_string())
                .or_insert_with(|| V8PoolQueueSnapshot {
                    lane: (*lane).to_string(),
                    ..Default::default()
                });
        }
        for worker in &workers {
            let pool = pool_map
                .entry(worker.lane.clone())
                .or_insert_with(|| V8PoolQueueSnapshot {
                    lane: worker.lane.clone(),
                    ..Default::default()
                });
            pool.total_jobs = pool.total_jobs.saturating_add(worker.jobs);
            pool.total_errors = pool.total_errors.saturating_add(worker.errors);
            pool.total_terminations = pool.total_terminations.saturating_add(worker.terminations);
            pool.total_recycles = pool.total_recycles.saturating_add(worker.recycles);
            pool.total_near_heap_limit = pool
                .total_near_heap_limit
                .saturating_add(worker.near_heap_limit);
            pool.total_cache_hits = pool.total_cache_hits.saturating_add(worker.cache_hits);
            pool.total_cache_misses = pool.total_cache_misses.saturating_add(worker.cache_misses);
            pool.total_snapshot_hits = pool
                .total_snapshot_hits
                .saturating_add(worker.snapshot_hits);
            pool.total_snapshot_misses = pool
                .total_snapshot_misses
                .saturating_add(worker.snapshot_misses);
        }
        let mut pools: Vec<V8PoolQueueSnapshot> = pool_map.into_values().collect();
        pools.sort_by(|a, b| a.lane.cmp(&b.lane));
        let mut totals = V8TotalsSnapshot::default();
        for pool in &pools {
            totals.workers = totals.workers.saturating_add(pool.active_workers);
            totals.busy = totals.busy.saturating_add(pool.busy_workers);
            totals.queued = totals.queued.saturating_add(pool.queued);
            totals.total_enqueued = totals.total_enqueued.saturating_add(pool.total_enqueued);
            totals.max_queued = totals.max_queued.max(pool.max_queued);
            totals.total_jobs = totals.total_jobs.saturating_add(pool.total_jobs);
            totals.total_errors = totals.total_errors.saturating_add(pool.total_errors);
            totals.total_terminations = totals
                .total_terminations
                .saturating_add(pool.total_terminations);
            totals.total_recycles = totals.total_recycles.saturating_add(pool.total_recycles);
            totals.total_near_heap_limit = totals
                .total_near_heap_limit
                .saturating_add(pool.total_near_heap_limit);
            totals.total_cache_hits = totals
                .total_cache_hits
                .saturating_add(pool.total_cache_hits);
            totals.total_cache_misses = totals
                .total_cache_misses
                .saturating_add(pool.total_cache_misses);
            totals.total_snapshot_hits = totals
                .total_snapshot_hits
                .saturating_add(pool.total_snapshot_hits);
            totals.total_snapshot_misses = totals
                .total_snapshot_misses
                .saturating_add(pool.total_snapshot_misses);
        }
        for worker in &workers {
            if let Some(heap) = &worker.heap {
                totals.used_heap_size = totals.used_heap_size.saturating_add(heap.used_heap_size);
                totals.total_heap_size =
                    totals.total_heap_size.saturating_add(heap.total_heap_size);
            }
        }
        let cache_entries = workers.iter().map(|w| w.cache_entries).sum();
        let events = self
            .events
            .lock()
            .expect("events lock")
            .iter()
            .cloned()
            .collect();
        V8StatsSnapshot {
            generated_at,
            workers,
            pools,
            events,
            config: V8ConfigSnapshot {
                recycle_used_heap_bytes: recycle_used_heap_bytes_for_lane("moo-worker"),
                max_old_generation_bytes: max_old_generation_bytes_for_lane("moo-worker"),
                max_young_generation_bytes: max_young_generation_bytes_for_lane("moo-worker"),
                cache_entries,
                startup_snapshots_enabled: startup_snapshots_enabled(),
                max_workers: configured_max_workers(),
                autoscale_window_secs: autoscale_window_secs_for_lane("moo-worker"),
                pools: v8_pool_config_snapshots(),
            },
            totals,
        }
    }

    fn push_event(&self, event: V8Event) {
        let mut events = self.events.lock().unwrap_or_else(|e| e.into_inner());
        events.push_back(event.clone());
        while events.len() > V8_EVENTS_MAX {
            events.pop_front();
        }
        drop(events);
        if let Ok(payload) = serde_json::to_string(&json!({ "kind": "v8", "event": &event })) {
            crate::broadcast::publish_v8(payload);
        }
    }
}

#[derive(Clone)]
struct JobMetricsUpdate {
    command: String,
    context_kind: ContextKind,
    ok: bool,
    near_heap_limit: bool,
    terminated: bool,
    duration_ns: u64,
    queue_wait_ms: u64,
    cache_hit: Option<bool>,
    snapshot_hit: Option<bool>,
    cache_entries: usize,
    heap: Option<V8HeapSnapshot>,
    snapshot_loaded: bool,
    snapshot_hash: Option<String>,
    error: Option<String>,
}

pub fn v8_stats_json() -> serde_json::Value {
    json!({ "ok": true, "value": V8_OBSERVABILITY.snapshot() })
}

fn worker_key(lane: &str, id: usize) -> String {
    format!("{lane}-{id}")
}

fn config_value(name: &str) -> Option<String> {
    V8_CONFIG_OVERRIDES
        .lock()
        .expect("v8 config overrides lock")
        .get(name)
        .cloned()
        .or_else(|| std::env::var(name).ok())
}

fn read_usize_env(name: &str, default: usize) -> usize {
    config_value(name)
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(default)
}

fn read_bool_env(name: &str, default: bool) -> bool {
    config_value(name)
        .map(|value| {
            let value = value.trim().to_ascii_lowercase();
            matches!(value.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(default)
}

pub fn apply_v8_env_text(text: &str) {
    let mut overrides = V8_CONFIG_OVERRIDES
        .lock()
        .expect("v8 config overrides lock");
    overrides.clear();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if !key.starts_with("MOO_V8_") {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        overrides.insert(key.to_string(), value.to_string());
    }
}

pub fn apply_v8_runtime_settings(settings: &V8RuntimeSettings) {
    let settings = normalize_v8_runtime_settings(settings.clone());
    let mut overrides = V8_CONFIG_OVERRIDES
        .lock()
        .expect("v8 config overrides lock");
    overrides.clear();
    if let Some(value) = settings.max_workers {
        overrides.insert("MOO_V8_WORKERS".to_string(), value.to_string());
    }
    if let Some(value) = settings.read_max_workers {
        overrides.insert("MOO_V8_READ_WORKERS".to_string(), value.to_string());
    }
    if let Some(value) = settings.scan_max_workers {
        overrides.insert("MOO_V8_SCAN_WORKERS".to_string(), value.to_string());
    }
    if let Some(value) = settings.ui_max_workers {
        overrides.insert("MOO_V8_UI_WORKERS".to_string(), value.to_string());
    }
    if let Some(value) = settings.tool_max_workers {
        overrides.insert("MOO_V8_TOOL_WORKERS".to_string(), value.to_string());
    }
    if let Some(value) = settings.max_old_generation_bytes {
        overrides.insert(
            "MOO_V8_MAX_OLD_GENERATION_BYTES".to_string(),
            value.to_string(),
        );
    }
    if let Some(value) = settings.max_young_generation_bytes {
        overrides.insert(
            "MOO_V8_MAX_YOUNG_GENERATION_BYTES".to_string(),
            value.to_string(),
        );
    }
    if let Some(value) = settings.recycle_used_heap_bytes {
        overrides.insert(
            "MOO_V8_RECYCLE_USED_HEAP_BYTES".to_string(),
            value.to_string(),
        );
    }
    if let Some(value) = settings.autoscale_window_secs {
        overrides.insert(
            "MOO_V8_AUTOSCALE_WINDOW_SECS".to_string(),
            value.to_string(),
        );
    }
    if let Some(value) = settings.startup_snapshots_enabled {
        overrides.insert(
            "MOO_V8_STARTUP_SNAPSHOTS".to_string(),
            if value { "1" } else { "0" }.to_string(),
        );
    }
    apply_v8_pool_runtime_settings(&mut overrides, "MOO_V8_MAIN", settings.main_pool.as_ref());
    apply_v8_pool_runtime_settings(&mut overrides, "MOO_V8_READ", settings.read_pool.as_ref());
    apply_v8_pool_runtime_settings(&mut overrides, "MOO_V8_SCAN", settings.scan_pool.as_ref());
    apply_v8_pool_runtime_settings(&mut overrides, "MOO_V8_UI", settings.ui_pool.as_ref());
    apply_v8_pool_runtime_settings(&mut overrides, "MOO_V8_TOOL", settings.tool_pool.as_ref());
}

fn apply_v8_pool_runtime_settings(
    overrides: &mut HashMap<String, String>,
    prefix: &str,
    settings: Option<&V8PoolRuntimeSettings>,
) {
    let Some(settings) = settings else {
        return;
    };
    if let Some(value) = settings.max_workers {
        overrides.insert(format!("{prefix}_WORKERS"), value.to_string());
    }
    if let Some(value) = settings.max_old_generation_bytes {
        overrides.insert(
            format!("{prefix}_MAX_OLD_GENERATION_BYTES"),
            value.to_string(),
        );
    }
    if let Some(value) = settings.max_young_generation_bytes {
        overrides.insert(
            format!("{prefix}_MAX_YOUNG_GENERATION_BYTES"),
            value.to_string(),
        );
    }
    if let Some(value) = settings.recycle_used_heap_bytes {
        overrides.insert(
            format!("{prefix}_RECYCLE_USED_HEAP_BYTES"),
            value.to_string(),
        );
    }
    if let Some(value) = settings.autoscale_window_secs {
        overrides.insert(format!("{prefix}_AUTOSCALE_WINDOW_SECS"), value.to_string());
    }
}

pub fn configured_max_workers() -> usize {
    read_usize_env(
        "MOO_V8_MAIN_WORKERS",
        read_usize_env("MOO_V8_WORKERS", DEFAULT_MAX_WORKERS),
    )
    .max(1)
}

fn default_read_max_workers(main_workers: usize) -> usize {
    (main_workers / 4).max(2)
}

fn default_ui_max_workers(main_workers: usize) -> usize {
    (main_workers / 4).max(2)
}

fn default_tool_max_workers(main_workers: usize) -> usize {
    (main_workers / 4).max(2)
}

pub fn configured_read_max_workers() -> usize {
    read_usize_env(
        "MOO_V8_READ_WORKERS",
        default_read_max_workers(configured_max_workers()),
    )
    .max(1)
}

pub fn configured_scan_max_workers() -> usize {
    read_usize_env("MOO_V8_SCAN_WORKERS", 1).max(1)
}

pub fn configured_ui_max_workers() -> usize {
    read_usize_env(
        "MOO_V8_UI_WORKERS",
        default_ui_max_workers(configured_max_workers()),
    )
    .max(1)
}

pub fn configured_tool_max_workers() -> usize {
    read_usize_env(
        "MOO_V8_TOOL_WORKERS",
        default_tool_max_workers(configured_max_workers()),
    )
    .max(1)
}

fn configured_workers_for_lane(lane: &str) -> usize {
    match lane {
        "moo-read-worker" => configured_read_max_workers(),
        "moo-scan-worker" => configured_scan_max_workers(),
        "moo-ui-worker" => configured_ui_max_workers(),
        "moo-tool-worker" => configured_tool_max_workers(),
        _ => configured_max_workers(),
    }
}

fn v8_pool_config_snapshots() -> Vec<V8PoolConfigSnapshot> {
    V8_LANES
        .iter()
        .map(|lane| V8PoolConfigSnapshot {
            lane: (*lane).to_string(),
            max_workers: configured_workers_for_lane(lane),
            recycle_used_heap_bytes: recycle_used_heap_bytes_for_lane(lane),
            max_old_generation_bytes: max_old_generation_bytes_for_lane(lane),
            max_young_generation_bytes: max_young_generation_bytes_for_lane(lane),
            autoscale_window_secs: autoscale_window_secs_for_lane(lane),
        })
        .collect()
}

fn lane_env_prefix(lane: &str) -> &'static str {
    match lane {
        "moo-read-worker" => "MOO_V8_READ",
        "moo-scan-worker" => "MOO_V8_SCAN",
        "moo-ui-worker" => "MOO_V8_UI",
        "moo-tool-worker" => "MOO_V8_TOOL",
        _ => "MOO_V8_MAIN",
    }
}

fn read_lane_usize_env(lane: &str, suffix: &str, global_key: &str, default: usize) -> usize {
    let key = format!("{}_{}", lane_env_prefix(lane), suffix);
    read_usize_env(&key, read_usize_env(global_key, default))
}

fn max_old_generation_bytes_for_lane(lane: &str) -> usize {
    read_lane_usize_env(
        lane,
        "MAX_OLD_GENERATION_BYTES",
        "MOO_V8_MAX_OLD_GENERATION_BYTES",
        DEFAULT_MAX_OLD_GENERATION_BYTES,
    )
    .max(MIN_HEAP_LIMIT_BYTES)
}

fn max_young_generation_bytes_for_lane(lane: &str) -> usize {
    read_lane_usize_env(
        lane,
        "MAX_YOUNG_GENERATION_BYTES",
        "MOO_V8_MAX_YOUNG_GENERATION_BYTES",
        DEFAULT_MAX_YOUNG_GENERATION_BYTES,
    )
    .max(MIN_HEAP_LIMIT_BYTES)
}

fn v8_create_params(lane: &str) -> v8::CreateParams {
    v8::CreateParams::default()
        .set_max_old_generation_size_in_bytes(max_old_generation_bytes_for_lane(lane))
        .set_max_young_generation_size_in_bytes(max_young_generation_bytes_for_lane(lane))
}

fn v8_startup_snapshot_create_params(lane: &str, startup: v8::StartupData) -> v8::CreateParams {
    runtime::startup_snapshot_create_params(startup)
        .set_max_old_generation_size_in_bytes(max_old_generation_bytes_for_lane(lane))
        .set_max_young_generation_size_in_bytes(max_young_generation_bytes_for_lane(lane))
}

fn recycle_used_heap_bytes_for_lane(lane: &str) -> usize {
    read_lane_usize_env(
        lane,
        "RECYCLE_USED_HEAP_BYTES",
        "MOO_V8_RECYCLE_USED_HEAP_BYTES",
        DEFAULT_RECYCLE_USED_HEAP_BYTES,
    )
}

fn autoscale_window_secs_for_lane(lane: &str) -> u64 {
    read_lane_usize_env(
        lane,
        "AUTOSCALE_WINDOW_SECS",
        "MOO_V8_AUTOSCALE_WINDOW_SECS",
        DEFAULT_AUTOSCALE_WINDOW_SECS as usize,
    )
    .max(1) as u64
}

fn effective_pool_settings(lane: &str) -> V8PoolRuntimeSettings {
    pool_settings(
        configured_workers_for_lane(lane),
        max_old_generation_bytes_for_lane(lane),
        max_young_generation_bytes_for_lane(lane),
        recycle_used_heap_bytes_for_lane(lane),
        autoscale_window_secs_for_lane(lane),
    )
}

fn startup_snapshots_enabled() -> bool {
    read_bool_env("MOO_V8_STARTUP_SNAPSHOTS", true)
}

fn snapshot_eligible(input: &str) -> bool {
    startup_snapshots_enabled()
        && runtime::snapshot_path(input).is_none()
        && !needs_fresh_context(input)
}

pub struct Job {
    pub bundle: Arc<String>,
    pub input: String,
    pub response: Sender<Result<String, String>>,
    pub enqueued_at: Instant,
}

pub struct AsyncToolJob {
    pub bundle: Arc<String>,
    pub input: String,
    pub agent_run: AgentRunHandler,
    pub parent_id: Option<String>,
    pub cancelled: Arc<AtomicBool>,
    pub response: Sender<Result<String, String>>,
    pub enqueued_at: Instant,
}

type JobPool = DynamicPool<Job>;
type AsyncToolPool = DynamicPool<AsyncToolJob>;

struct DynamicPool<T> {
    lane: String,
    db: String,
    max_workers: usize,
    autoscale_window: Duration,
    tx: Sender<T>,
    rx: Arc<Mutex<mpsc::Receiver<T>>>,
    state: Mutex<DynamicPoolState>,
}

#[derive(Debug)]
struct DynamicPoolState {
    active_workers: usize,
    busy_workers: usize,
    queued: usize,
    next_worker_id: usize,
    utilization: VecDeque<UtilizationSample>,
}

#[derive(Clone, Copy, Debug)]
struct UtilizationSample {
    at: Instant,
    busy: usize,
}

#[derive(Clone, Copy, Debug)]
struct PoolRuntimeUpdate {
    queued: usize,
    active_workers: usize,
    max_workers: usize,
    busy_workers: usize,
    recent_max_utilization: usize,
    autoscale_window_secs: u64,
}

enum DynamicRecv<T> {
    Job(T),
    Stop { already_exited: bool },
}

impl<T> DynamicPool<T> {
    fn new(lane: &str, max_workers: usize, db: &str) -> Arc<Self> {
        let (tx, rx) = mpsc::channel::<T>();
        let max_workers = max_workers.max(1);
        let pool = Arc::new(Self {
            lane: lane.to_string(),
            db: db.to_string(),
            max_workers,
            autoscale_window: Duration::from_secs(autoscale_window_secs_for_lane(lane)),
            tx,
            rx: Arc::new(Mutex::new(rx)),
            state: Mutex::new(DynamicPoolState {
                active_workers: 0,
                busy_workers: 0,
                queued: 0,
                next_worker_id: 0,
                utilization: VecDeque::new(),
            }),
        });
        V8_OBSERVABILITY.register_pool(lane);
        pool.publish_runtime_update(pool.runtime_update());
        pool
    }

    fn lane(&self) -> &str {
        &self.lane
    }

    fn sender(&self) -> &Sender<T> {
        &self.tx
    }

    fn allocate_worker_id(&self) -> usize {
        let update;
        let id;
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            id = self.allocate_worker_id_locked(&mut state);
            update = self.runtime_update_locked(&mut state, Instant::now());
        }
        self.publish_runtime_update(update);
        id
    }

    fn job_queued_and_allocate_worker_if_needed(&self) -> Option<usize> {
        let mut id = None;
        V8_OBSERVABILITY.job_queued(&self.lane);
        let update;
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.queued = state.queued.saturating_add(1);
            if state.busy_workers.saturating_add(state.queued) > state.active_workers
                && state.active_workers < self.max_workers
            {
                id = Some(self.allocate_worker_id_locked(&mut state));
            }
            update = self.runtime_update_locked(&mut state, Instant::now());
        }
        self.publish_runtime_update(update);
        id
    }

    fn job_dequeued_on_send_error(&self) {
        let update;
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.queued = state.queued.saturating_sub(1);
            update = self.runtime_update_locked(&mut state, Instant::now());
        }
        self.publish_runtime_update(update);
    }

    fn recv(&self) -> DynamicRecv<T> {
        loop {
            let result = self
                .rx
                .lock()
                .expect("rx lock")
                .recv_timeout(self.autoscale_window);
            match result {
                Ok(job) => {
                    let update;
                    {
                        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                        let now = Instant::now();
                        state.queued = state.queued.saturating_sub(1);
                        state.busy_workers = state.busy_workers.saturating_add(1);
                        self.record_utilization_locked(&mut state, now);
                        update = self.runtime_update_locked(&mut state, now);
                    }
                    self.publish_runtime_update(update);
                    return DynamicRecv::Job(job);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if self.retire_idle_worker_if_underutilized() {
                        return DynamicRecv::Stop {
                            already_exited: true,
                        };
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return DynamicRecv::Stop {
                        already_exited: false,
                    };
                }
            }
        }
    }

    fn job_finished(&self) {
        let update;
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.busy_workers = state.busy_workers.saturating_sub(1);
            self.record_utilization_locked(&mut state, Instant::now());
            update = self.runtime_update_locked(&mut state, Instant::now());
        }
        self.publish_runtime_update(update);
    }

    fn worker_start_failed(&self) {
        self.worker_exited();
    }

    fn worker_exited(&self) {
        let update;
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.active_workers = state.active_workers.saturating_sub(1);
            update = self.runtime_update_locked(&mut state, Instant::now());
        }
        self.publish_runtime_update(update);
    }

    fn retire_idle_worker_if_underutilized(&self) -> bool {
        let mut retired = false;
        let update;
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            let recent_max = self.recent_max_utilization_locked(&mut state, now);
            if state.queued == 0 && state.active_workers > 1 && recent_max < state.active_workers {
                state.active_workers = state.active_workers.saturating_sub(1);
                retired = true;
            }
            update = self.runtime_update_locked(&mut state, now);
        }
        self.publish_runtime_update(update);
        retired
    }

    fn allocate_worker_id_locked(&self, state: &mut DynamicPoolState) -> usize {
        let id = state.next_worker_id;
        state.next_worker_id = state.next_worker_id.saturating_add(1);
        state.active_workers = state.active_workers.saturating_add(1).min(self.max_workers);
        id
    }

    fn record_utilization_locked(&self, state: &mut DynamicPoolState, now: Instant) {
        state.utilization.push_back(UtilizationSample {
            at: now,
            busy: state.busy_workers,
        });
        self.prune_utilization_locked(state, now);
    }

    fn recent_max_utilization_locked(&self, state: &mut DynamicPoolState, now: Instant) -> usize {
        self.prune_utilization_locked(state, now);
        state
            .utilization
            .iter()
            .map(|sample| sample.busy)
            .max()
            .unwrap_or(0)
            .max(state.busy_workers)
    }

    fn prune_utilization_locked(&self, state: &mut DynamicPoolState, now: Instant) {
        while state
            .utilization
            .front()
            .is_some_and(|sample| now.duration_since(sample.at) > self.autoscale_window)
        {
            state.utilization.pop_front();
        }
    }

    fn runtime_update(&self) -> PoolRuntimeUpdate {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.runtime_update_locked(&mut state, Instant::now())
    }

    fn runtime_update_locked(
        &self,
        state: &mut DynamicPoolState,
        now: Instant,
    ) -> PoolRuntimeUpdate {
        PoolRuntimeUpdate {
            queued: state.queued,
            active_workers: state.active_workers,
            max_workers: self.max_workers,
            busy_workers: state.busy_workers,
            recent_max_utilization: self.recent_max_utilization_locked(state, now),
            autoscale_window_secs: self.autoscale_window.as_secs().max(1),
        }
    }

    fn publish_runtime_update(&self, update: PoolRuntimeUpdate) {
        V8_OBSERVABILITY.pool_runtime_update(&self.lane, update);
    }
}

pub struct Pool {
    main_pool: Arc<JobPool>,
    read_pool: Arc<JobPool>,
    scan_pool: Arc<JobPool>,
    ui_pool: Arc<JobPool>,
    async_tool_pool: Arc<AsyncToolPool>,
    // Outer std::sync::Mutex protects the map and is only held while the
    // inner Arc is cloned quickly. The inner per-chat lock is
    // tokio::sync::Mutex so the chat driver can `lock().await` without
    // parking a runtime thread; sync `submit` callers (HTTP server thread)
    // use `blocking_lock` since they aren't inside a tokio runtime.
    chat_locks: Arc<Mutex<HashMap<String, Arc<TokioMutex<()>>>>>,
    server_base_url: Option<String>,
    db: String,
}

impl Pool {
    pub fn new(workers: usize, db: &str, server_base_url: Option<String>) -> Self {
        let main_pool = JobPool::new("moo-worker", workers.max(1), db);
        let main_id = main_pool.allocate_worker_id();
        if let Err(e) = spawn_worker(main_pool.clone(), main_id) {
            eprintln!("{e}");
            main_pool.worker_start_failed();
        }

        // UI/API reads must stay responsive even while agent/tool work fills
        // the main isolate pool. Keep fast reads on their own lane, and keep
        // whole-store scans (triples/vocabulary) off that lane so they cannot
        // starve chat-models/ui-chat/describe refreshes.
        let read_pool = JobPool::new("moo-read-worker", configured_read_max_workers(), db);
        let read_id = read_pool.allocate_worker_id();
        if let Err(e) = spawn_worker(read_pool.clone(), read_id) {
            eprintln!("{e}");
            read_pool.worker_start_failed();
        }

        let scan_pool = JobPool::new("moo-scan-worker", configured_scan_max_workers(), db);
        let scan_id = scan_pool.allocate_worker_id();
        if let Err(e) = spawn_worker(scan_pool.clone(), scan_id) {
            eprintln!("{e}");
            scan_pool.worker_start_failed();
        }

        // UI app handler calls can include slow external MCP requests. Keep
        // them off the main write lane so agent streaming/turn work cannot
        // starve app RPCs, and app RPCs cannot starve agent bookkeeping.
        let ui_pool = JobPool::new("moo-ui-worker", configured_ui_max_workers(), db);
        let ui_id = ui_pool.allocate_worker_id();
        if let Err(e) = spawn_worker(ui_pool.clone(), ui_id) {
            eprintln!("{e}");
            ui_pool.worker_start_failed();
        }

        let async_tool_pool =
            AsyncToolPool::new("moo-tool-worker", configured_tool_max_workers(), db);
        let async_id = async_tool_pool.allocate_worker_id();
        if let Err(e) = spawn_async_tool_worker(async_tool_pool.clone(), async_id) {
            eprintln!("{e}");
            async_tool_pool.worker_start_failed();
        }

        Pool {
            main_pool,
            read_pool,
            scan_pool,
            ui_pool,
            async_tool_pool,
            chat_locks: Arc::new(Mutex::new(HashMap::new())),
            server_base_url,
            db: db.to_string(),
        }
    }

    pub fn submit(&self, bundle: Arc<String>, input: String) -> Result<String, String> {
        // Writes for a given chat run under a per-chat mutex (filesystem +
        // ref-update races aren't covered by SQLite's WAL). Read-only commands
        // skip the lock entirely and use reserved worker lanes, so slow agent
        // tool work or whole-store scans do not make lightweight UI refreshes
        // sit in FIFO long enough to hit the websocket RPC timeout.
        //
        // Chat deletion is intentionally different: it must be able to cut in
        // front of the running driver for that chat. Abort the driver before
        // routing so the per-chat write lock is released, then let `chat-rm`
        // take the normal write lock while it wipes refs/facts/worktree state.
        // Without this pre-interrupt, deleting a thinking chat waits for the
        // active LLM/tool turn to finish, which can make deletion feel hung.
        let input = self.input_with_server_base_url(input);
        if let Some(chat_id) = chat_rm_chat_id(&input) {
            driver::interrupt(&chat_id);
        }
        let (lane, lock_key) = route_input(&input);
        match lane {
            Lane::FastRead => {
                return self.dispatch_on(&self.read_pool, bundle, input);
            }
            Lane::ScanRead => {
                return self.dispatch_on(&self.scan_pool, bundle, input);
            }
            Lane::Ui => {
                return self.dispatch_on(&self.ui_pool, bundle, input);
            }
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
        let input = self.input_with_server_base_url(input);
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
        parent_id: Option<String>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<String, String> {
        let input = self.input_with_server_base_url(input);
        let (resp_tx, resp_rx) = mpsc::channel();
        let pool = &self.async_tool_pool;
        if let Some(id) = pool.job_queued_and_allocate_worker_if_needed()
            && let Err(e) = spawn_async_tool_worker(pool.clone(), id)
        {
            pool.worker_start_failed();
            pool.job_dequeued_on_send_error();
            return Err(e);
        }
        if pool
            .sender()
            .send(AsyncToolJob {
                bundle,
                input,
                agent_run,
                parent_id,
                cancelled,
                response: resp_tx,
                enqueued_at: Instant::now(),
            })
            .is_err()
        {
            pool.job_dequeued_on_send_error();
            return Err("async tool isolate pool closed".to_string());
        }
        recv_job_result(resp_rx, "async tool isolate worker dropped")
    }

    /// Acquire-or-create the per-chat write lock. Caller holds the returned
    /// Arc and locks it via `.lock().await` (async) or `.blocking_lock()`
    /// (sync, outside a tokio runtime).
    pub fn chat_lock(&self, key: &str) -> Arc<TokioMutex<()>> {
        let mut locks = self.chat_locks.lock().unwrap_or_else(|e| e.into_inner());
        // Drop locks that nobody else references (strong_count == 1 means only
        // the map holds it), so the map stays bounded by *active* chats rather
        // than by every chat ever seen. Safe because an entry kept by an
        // in-flight turn has strong_count >= 2 and is preserved, so we never
        // split a held lock into two independent mutexes.
        locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        locks
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(TokioMutex::new(())))
            .clone()
    }

    fn input_with_server_base_url(&self, input: String) -> String {
        let configured = host::open_settings_db(&self.db)
            .ok()
            .and_then(|conn| settings::read_server_base_url(&conn).ok().flatten());
        payload_with_server_base_url(
            input,
            configured.as_deref().or(self.server_base_url.as_deref()),
        )
    }

    fn dispatch(&self, bundle: Arc<String>, input: String) -> Result<String, String> {
        self.dispatch_on(&self.main_pool, bundle, input)
    }

    fn dispatch_on(
        &self,
        pool: &Arc<JobPool>,
        bundle: Arc<String>,
        input: String,
    ) -> Result<String, String> {
        let (resp_tx, resp_rx) = mpsc::channel();
        if let Some(id) = pool.job_queued_and_allocate_worker_if_needed()
            && let Err(e) = spawn_worker(pool.clone(), id)
        {
            pool.worker_start_failed();
            pool.job_dequeued_on_send_error();
            return Err(e);
        }
        if pool
            .sender()
            .send(Job {
                bundle,
                input,
                response: resp_tx,
                enqueued_at: Instant::now(),
            })
            .is_err()
        {
            pool.job_dequeued_on_send_error();
            return Err("isolate pool closed".to_string());
        }
        recv_job_result(resp_rx, "isolate worker dropped")
    }
}

fn recv_job_result(
    rx: mpsc::Receiver<Result<String, String>>,
    dropped_message: &str,
) -> Result<String, String> {
    rx.recv()
        .unwrap_or_else(|_| Err(dropped_message.to_string()))
}

fn spawn_worker(pool: Arc<JobPool>, id: usize) -> Result<(), String> {
    let thread_name = format!("{}-{id}", pool.lane());
    let lane = pool.lane().to_string();
    thread::Builder::new()
        .name(thread_name)
        .spawn(move || worker_loop(pool, id))
        .map_err(|e| format!("failed to spawn {lane} worker {id}: {e}"))?;
    Ok(())
}

fn worker_loop(pool: Arc<JobPool>, id: usize) {
    let lane = pool.lane().to_string();
    if let Err(e) = host::install(&pool.db) {
        eprintln!("[worker {id}] host init: {e}");
        pool.worker_start_failed();
        return;
    }
    runtime::init_v8();
    V8_OBSERVABILITY.register_worker(&lane, id);
    let mut rt = WorkerRuntime::new(&lane, id, None);

    loop {
        let job = match pool.recv() {
            DynamicRecv::Job(job) => job,
            DynamicRecv::Stop { already_exited } => {
                if !already_exited {
                    pool.worker_exited();
                }
                break;
            }
        };
        let command = command_from_input(&job.input);
        V8_OBSERVABILITY.job_start(&lane, id, rt.generation, &command);
        let started = Instant::now();
        let queue_wait_ms = job.enqueued_at.elapsed().as_millis() as u64;
        let inspected = cdp::handle().and_then(|h| h.run_if_attached(&job.input, None));
        let snapshot_hit = if inspected.is_none() && snapshot_eligible(&job.input) {
            match rt.ensure_snapshot_bundle(&job.bundle) {
                Ok(hit) => Some(hit),
                Err(err) => {
                    V8_OBSERVABILITY.snapshot_build_error(&lane, id, rt.generation, &command, err);
                    None
                }
            }
        } else {
            None
        };
        let outcome = if let Some(result) = inspected {
            JobOutcome {
                result,
                report: None,
                context_kind: ContextKind::Cdp,
                cache_hit: None,
                snapshot_hit: None,
            }
        } else {
            run_worker_job(&mut rt, &job.bundle, &job.input, snapshot_hit)
        };
        let duration_ns = started.elapsed().as_nanos() as u64;
        let result = outcome.result;
        let near_heap_limit = rt.near_heap_limit.load(Ordering::SeqCst);
        let report_unhandled = outcome
            .report
            .as_ref()
            .is_some_and(|r| r.unhandled_exception);
        let terminated = rt.isolate().is_execution_terminating();
        let heap = rt.heap_snapshot();
        let error = result.as_ref().err().cloned();
        let recycle_reason =
            rt.recycle_reason(terminated, report_unhandled, near_heap_limit, &heap);
        V8_OBSERVABILITY.job_end(
            &lane,
            id,
            rt.generation,
            JobMetricsUpdate {
                command,
                context_kind: outcome.context_kind,
                ok: result.is_ok(),
                near_heap_limit,
                terminated,
                duration_ns,
                queue_wait_ms,
                cache_hit: outcome.cache_hit,
                snapshot_hit: outcome.snapshot_hit,
                cache_entries: rt.cache_len(),
                heap,
                snapshot_loaded: rt.snapshot_loaded(),
                snapshot_hash: rt.snapshot_hash.clone(),
                error: error.clone(),
            },
        );
        pool.job_finished();
        let _ = job.response.send(result);
        if let Some(reason) = recycle_reason {
            rt.recycle(&reason);
        }
    }
    V8_OBSERVABILITY.worker_exit(&lane, id, rt.generation);
}

struct WorkerRuntime {
    lane: String,
    id: usize,
    generation: u64,
    bundle_cache: runtime::LoadedBundleCache,
    snapshot_bundle_hash: Option<String>,
    snapshot_hash: Option<String>,
    snapshot_blob: Option<Arc<Vec<u8>>>,
    snapshot_context: Option<v8::Global<v8::Context>>,
    snapshot_main: Option<v8::Global<v8::Function>>,
    isolate: Option<v8::OwnedIsolate>,
    near_heap_limit: Box<AtomicBool>,
}

impl WorkerRuntime {
    fn new(lane: &str, id: usize, previous_generation: Option<u64>) -> Self {
        let generation = previous_generation.unwrap_or(0).saturating_add(1);
        let near_heap_limit = Box::new(AtomicBool::new(false));
        let mut isolate = v8::Isolate::new(v8_create_params(lane));
        isolate.set_microtasks_policy(v8::MicrotasksPolicy::Auto);
        snapshots::install_failure_hooks(&mut isolate, near_heap_limit.as_ref());
        let rt = Self {
            lane: lane.to_string(),
            id,
            generation,
            bundle_cache: runtime::LoadedBundleCache::new(),
            snapshot_bundle_hash: None,
            snapshot_hash: None,
            snapshot_blob: None,
            snapshot_context: None,
            snapshot_main: None,
            isolate: Some(isolate),
            near_heap_limit,
        };
        V8_OBSERVABILITY.generation_started(lane, id, generation);
        rt
    }

    fn cache_len(&self) -> usize {
        self.bundle_cache.len()
    }

    fn snapshot_loaded(&self) -> bool {
        self.snapshot_context.is_some()
    }

    fn recycle(&mut self, reason: &str) {
        V8_OBSERVABILITY.recycle(&self.lane, self.id, self.generation, reason);
        let next_generation = self.generation.saturating_add(1);
        self.clear_v8_state();
        self.generation = next_generation;
        self.install_default_isolate();
        V8_OBSERVABILITY.generation_started(&self.lane, self.id, self.generation);
    }

    fn isolate(&self) -> &v8::OwnedIsolate {
        self.isolate.as_ref().expect("worker isolate missing")
    }

    fn isolate_mut(&mut self) -> &mut v8::OwnedIsolate {
        self.isolate.as_mut().expect("worker isolate missing")
    }

    fn clear_v8_state(&mut self) {
        self.bundle_cache = runtime::LoadedBundleCache::new();
        self.snapshot_bundle_hash = None;
        self.snapshot_hash = None;
        self.snapshot_blob = None;
        self.snapshot_context = None;
        self.snapshot_main = None;
        let isolate = self.isolate.take();
        drop(isolate);
    }

    fn install_default_isolate(&mut self) {
        debug_assert!(self.isolate.is_none());
        let near_heap_limit = Box::new(AtomicBool::new(false));
        let mut isolate = v8::Isolate::new(v8_create_params(&self.lane));
        isolate.set_microtasks_policy(v8::MicrotasksPolicy::Auto);
        snapshots::install_failure_hooks(&mut isolate, near_heap_limit.as_ref());
        self.near_heap_limit = near_heap_limit;
        self.isolate = Some(isolate);
    }

    fn install_snapshot_isolate(
        &mut self,
        startup: v8::StartupData,
        bundle_hash: String,
        snapshot_hash: String,
        blob: Vec<u8>,
    ) -> Result<(), String> {
        self.clear_v8_state();

        let result = (|| {
            let near_heap_limit = Box::new(AtomicBool::new(false));
            let mut isolate =
                v8::Isolate::new(v8_startup_snapshot_create_params(&self.lane, startup));
            isolate.set_microtasks_policy(v8::MicrotasksPolicy::Auto);
            snapshots::install_failure_hooks(&mut isolate, near_heap_limit.as_ref());
            let (context, main) = runtime::load_snapshot_context_in(&mut isolate)?;
            Ok::<_, String>((near_heap_limit, isolate, context, main))
        })();

        match result {
            Ok((near_heap_limit, isolate, context, main)) => {
                self.near_heap_limit = near_heap_limit;
                self.isolate = Some(isolate);
                self.snapshot_bundle_hash = Some(bundle_hash);
                self.snapshot_hash = Some(snapshot_hash);
                self.snapshot_blob = Some(Arc::new(blob));
                self.snapshot_context = Some(context);
                self.snapshot_main = Some(main);
                Ok(())
            }
            Err(err) => {
                self.install_default_isolate();
                Err(err)
            }
        }
    }

    fn ensure_snapshot_bundle(&mut self, bundle: &Arc<String>) -> Result<bool, String> {
        let bundle_hash = sha256_object_hash("v8:bundle", bundle.as_bytes());
        if self.snapshot_bundle_hash.as_deref() == Some(bundle_hash.as_str())
            && self.snapshot_context.is_some()
            && self.snapshot_main.is_some()
        {
            return Ok(true);
        }

        let blob = self.create_startup_snapshot_blob(bundle.clone())?;
        let snapshot_hash = sha256_object_hash("v8:startupSnapshot", &blob);
        let startup = v8::StartupData::from(blob.clone());
        if !startup.is_valid() {
            return Err("created startup snapshot is not valid for this V8 build".to_string());
        }
        self.install_snapshot_isolate(startup, bundle_hash, snapshot_hash, blob)?;
        Ok(false)
    }

    fn create_startup_snapshot_blob(&self, bundle: Arc<String>) -> Result<Vec<u8>, String> {
        // rusty_v8::OwnedIsolate instances are entered when created and must be
        // dropped in strict LIFO order on a thread. SnapshotCreator also owns an
        // isolate, and its destructor path has different enter/exit mechanics than
        // a normal OwnedIsolate. Building the blob on a short-lived helper
        // thread keeps that temporary isolate off the worker thread's isolate
        // stack, so replacing or recycling the worker isolate cannot trip the
        // reverse-drop-order assertion.
        let thread_name = format!("{}-{}-snapshot", self.lane, self.id);
        let handle = thread::Builder::new()
            .name(thread_name)
            .spawn(move || runtime::create_bundle_snapshot(bundle.as_str()))
            .map_err(|e| format!("spawn startup snapshot builder: {e}"))?;
        handle
            .join()
            .map_err(|_| "startup snapshot builder panicked".to_string())?
    }

    fn has_snapshot_bundle(&self, bundle: &Arc<String>) -> bool {
        let bundle_hash = sha256_object_hash("v8:bundle", bundle.as_bytes());
        self.snapshot_bundle_hash.as_deref() == Some(bundle_hash.as_str())
            && self.snapshot_context.is_some()
            && self.snapshot_main.is_some()
    }

    fn heap_snapshot(&mut self) -> Option<V8HeapSnapshot> {
        let stats = self.isolate_mut().get_heap_statistics();
        Some(V8HeapSnapshot {
            total_heap_size: stats.total_heap_size(),
            total_heap_size_executable: stats.total_heap_size_executable(),
            total_physical_size: stats.total_physical_size(),
            total_available_size: stats.total_available_size(),
            used_heap_size: stats.used_heap_size(),
            heap_size_limit: stats.heap_size_limit(),
            malloced_memory: stats.malloced_memory(),
            external_memory: stats.external_memory(),
            peak_malloced_memory: stats.peak_malloced_memory(),
            total_global_handles_size: stats.total_global_handles_size(),
            used_global_handles_size: stats.used_global_handles_size(),
            number_of_native_contexts: stats.number_of_native_contexts(),
            number_of_detached_contexts: stats.number_of_detached_contexts(),
            total_allocated_bytes: stats.total_allocated_bytes(),
        })
    }

    fn recycle_reason(
        &self,
        terminated: bool,
        unhandled_exception: bool,
        near_heap_limit: bool,
        heap: &Option<V8HeapSnapshot>,
    ) -> Option<String> {
        if terminated {
            return Some("terminated".to_string());
        }
        if near_heap_limit {
            return Some("near-heap-limit".to_string());
        }
        if unhandled_exception {
            return Some("unhandled-exception".to_string());
        }
        let max_used = recycle_used_heap_bytes_for_lane(&self.lane);
        if max_used > 0
            && let Some(heap) = heap
            && heap.used_heap_size > max_used
        {
            return Some(format!("heap-used>{max_used}"));
        }
        None
    }
}

fn run_worker_job(
    rt: &mut WorkerRuntime,
    bundle: &Arc<String>,
    input: &str,
    snapshot_hit: Option<bool>,
) -> JobOutcome {
    if let Some(path) = runtime::snapshot_path(input) {
        let result = runtime::run_snapshot(&path, input);
        return JobOutcome {
            result,
            report: None,
            context_kind: ContextKind::SnapshotOneShot,
            cache_hit: None,
            snapshot_hit: None,
        };
    }
    if needs_fresh_context(input) {
        return run_uncached_bundle_job(rt, bundle, input);
    }
    if startup_snapshots_enabled() && rt.has_snapshot_bundle(bundle) {
        return run_snapshot_bundle_job(rt, input, snapshot_hit.unwrap_or(true));
    }
    run_bundle_job(rt, bundle, input)
}

fn run_bundle_job(rt: &mut WorkerRuntime, bundle: &Arc<String>, input: &str) -> JobOutcome {
    rt.near_heap_limit.store(false, Ordering::SeqCst);
    let was_cached = rt.bundle_cache.len() > 0;
    let report = {
        let isolate = rt.isolate.as_mut().expect("worker isolate missing");
        rt.bundle_cache.run_report_in(isolate, bundle, input)
    };
    let near_heap_limit = rt.near_heap_limit.load(Ordering::SeqCst);
    snapshots::record_if_triggered(
        rt.isolate_mut(),
        input,
        bundle,
        &report.result,
        near_heap_limit,
        report.unhandled_exception,
    );
    let result = report.result.clone();
    JobOutcome {
        result,
        report: Some(report),
        context_kind: ContextKind::Cached,
        cache_hit: Some(was_cached),
        snapshot_hit: None,
    }
}

fn run_uncached_bundle_job(
    rt: &mut WorkerRuntime,
    bundle: &Arc<String>,
    input: &str,
) -> JobOutcome {
    rt.near_heap_limit.store(false, Ordering::SeqCst);
    let report = runtime::run_js_report_in(rt.isolate_mut(), bundle, input);
    let near_heap_limit = rt.near_heap_limit.load(Ordering::SeqCst);
    snapshots::record_if_triggered(
        rt.isolate_mut(),
        input,
        bundle,
        &report.result,
        near_heap_limit,
        report.unhandled_exception,
    );
    let result = report.result.clone();
    JobOutcome {
        result,
        report: Some(report),
        context_kind: ContextKind::Fresh,
        cache_hit: None,
        snapshot_hit: None,
    }
}

fn run_snapshot_bundle_job(rt: &mut WorkerRuntime, input: &str, snapshot_hit: bool) -> JobOutcome {
    rt.near_heap_limit.store(false, Ordering::SeqCst);
    let context_global = rt
        .snapshot_context
        .as_ref()
        .expect("snapshot context missing")
        .clone();
    let main_global = rt
        .snapshot_main
        .as_ref()
        .expect("snapshot main missing")
        .clone();
    let snapshot_source = format!(
        "startup snapshot bundle {}",
        rt.snapshot_hash.clone().unwrap_or_default()
    );
    let report = {
        v8::scope!(let handle_scope, rt.isolate_mut());
        let context = v8::Local::new(handle_scope, &context_global);
        let mut scope = v8::ContextScope::new(handle_scope, context);
        let main = v8::Local::new(&scope, &main_global);
        runtime::run_loaded_main_in_scope_with_main(&mut scope, main, input)
    };
    let near_heap_limit = rt.near_heap_limit.load(Ordering::SeqCst);
    snapshots::record_if_triggered(
        rt.isolate_mut(),
        input,
        &snapshot_source,
        &report.result,
        near_heap_limit,
        report.unhandled_exception,
    );
    let result = report.result.clone();
    JobOutcome {
        result,
        report: Some(report),
        context_kind: ContextKind::Snapshot,
        cache_hit: None,
        snapshot_hit: Some(snapshot_hit),
    }
}

fn spawn_async_tool_worker(pool: Arc<AsyncToolPool>, id: usize) -> Result<(), String> {
    let thread_name = format!("{}-{id}", pool.lane());
    let lane = pool.lane().to_string();
    thread::Builder::new()
        .name(thread_name)
        .spawn(move || async_tool_worker_loop(pool, id))
        .map_err(|e| format!("failed to spawn {lane} worker {id}: {e}"))?;
    Ok(())
}

fn async_tool_worker_loop(pool: Arc<AsyncToolPool>, id: usize) {
    let lane = pool.lane().to_string();
    if let Err(e) = host::install(&pool.db) {
        eprintln!("[async tool worker {id}] host init: {e}");
        pool.worker_start_failed();
        return;
    }
    runtime::init_v8();
    V8_OBSERVABILITY.register_worker(&lane, id);
    let mut rt = WorkerRuntime::new(&lane, id, None);

    loop {
        let job = match pool.recv() {
            DynamicRecv::Job(job) => job,
            DynamicRecv::Stop { already_exited } => {
                if !already_exited {
                    pool.worker_exited();
                }
                break;
            }
        };
        let command = command_from_input(&job.input).to_string();
        V8_OBSERVABILITY.job_start(&lane, id, rt.generation, &command);
        let started = Instant::now();
        let queue_wait_ms = job.enqueued_at.elapsed().as_millis() as u64;
        let inspected =
            cdp::handle().and_then(|h| h.run_if_attached(&job.input, Some(job.agent_run.clone())));
        let outcome = if let Some(result) = inspected {
            JobOutcome {
                result,
                report: None,
                context_kind: ContextKind::Cdp,
                cache_hit: None,
                snapshot_hit: None,
            }
        } else if needs_fresh_context(&job.input) {
            run_uncached_async_tool_job(
                &mut rt,
                &job.bundle,
                &job.input,
                job.agent_run,
                job.parent_id,
                job.cancelled.clone(),
            )
        } else {
            run_async_tool_job(
                &mut rt,
                &job.bundle,
                &job.input,
                job.agent_run,
                job.parent_id,
                job.cancelled.clone(),
            )
        };
        let duration_ns = started.elapsed().as_nanos() as u64;
        let result = outcome.result;
        let near_heap_limit = rt.near_heap_limit.load(Ordering::SeqCst);
        let report_unhandled = outcome
            .report
            .as_ref()
            .is_some_and(|r| r.unhandled_exception);
        let terminated = rt.isolate().is_execution_terminating();
        let heap = rt.heap_snapshot();
        let error = result.as_ref().err().cloned();
        let recycle_reason =
            rt.recycle_reason(terminated, report_unhandled, near_heap_limit, &heap);
        V8_OBSERVABILITY.job_end(
            &lane,
            id,
            rt.generation,
            JobMetricsUpdate {
                command,
                context_kind: outcome.context_kind,
                ok: result.is_ok(),
                near_heap_limit,
                terminated,
                duration_ns,
                queue_wait_ms,
                cache_hit: outcome.cache_hit,
                snapshot_hit: outcome.snapshot_hit,
                cache_entries: rt.cache_len(),
                heap,
                snapshot_loaded: rt.snapshot_loaded(),
                snapshot_hash: rt.snapshot_hash.clone(),
                error: error.clone(),
            },
        );
        pool.job_finished();
        let _ = job.response.send(result);
        if let Some(reason) = recycle_reason {
            rt.recycle(&reason);
        }
    }
    V8_OBSERVABILITY.worker_exit(&lane, id, rt.generation);
}

fn run_async_tool_job(
    rt: &mut WorkerRuntime,
    bundle: &Arc<String>,
    input: &str,
    agent_run: AgentRunHandler,
    parent_id: Option<String>,
    cancelled: Arc<AtomicBool>,
) -> JobOutcome {
    rt.near_heap_limit.store(false, Ordering::SeqCst);
    let was_cached = rt.bundle_cache.len() > 0;
    let report = {
        let isolate = rt.isolate.as_mut().expect("worker isolate missing");
        rt.bundle_cache
            .run_async_report_in(isolate, bundle, input, agent_run, parent_id, cancelled)
    };
    let near_heap_limit = rt.near_heap_limit.load(Ordering::SeqCst);
    snapshots::record_if_triggered(
        rt.isolate_mut(),
        input,
        bundle,
        &report.result,
        near_heap_limit,
        report.unhandled_exception,
    );
    let result = report.result.clone();
    JobOutcome {
        result,
        report: Some(report),
        context_kind: ContextKind::Cached,
        cache_hit: Some(was_cached),
        snapshot_hit: None,
    }
}

fn run_uncached_async_tool_job(
    rt: &mut WorkerRuntime,
    bundle: &Arc<String>,
    input: &str,
    agent_run: AgentRunHandler,
    parent_id: Option<String>,
    cancelled: Arc<AtomicBool>,
) -> JobOutcome {
    rt.near_heap_limit.store(false, Ordering::SeqCst);
    let report = runtime::run_js_async_report_in(
        rt.isolate_mut(),
        bundle,
        input,
        agent_run,
        parent_id,
        cancelled,
    );
    let near_heap_limit = rt.near_heap_limit.load(Ordering::SeqCst);
    snapshots::record_if_triggered(
        rt.isolate_mut(),
        input,
        bundle,
        &report.result,
        near_heap_limit,
        report.unhandled_exception,
    );
    let result = report.result.clone();
    JobOutcome {
        result,
        report: Some(report),
        context_kind: ContextKind::Fresh,
        cache_hit: None,
        snapshot_hit: None,
    }
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
    Ui,
}

const FAST_READ_ONLY_COMMANDS: &[&str] = &[
    "dump",
    "chats",
    "chat-autocomplete",
    "fs-list",
    "fs-search",
    "fs-read",
    "fs-git-branches",
    "chat-recent-paths",
    "chat-export",
    "chat-models",
    "schema",
    "compactions",
    // Hydrate the shared queued-message list from the server immediately on
    // page load, even while a chat driver owns that chat's write lock.
    "pending-messages",
    "chat-queue-list",
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
    "v8-stats",
    "pointers",
    "skills-list",
    "skill-get",
];

const SCAN_READ_ONLY_COMMANDS: &[&str] = &[
    "describe",
    "graph-summaries",
    "memory-query",
    "triples",
    "vocabulary",
];

const FRESH_CONTEXT_COMMANDS: &[&str] = &["run-ts-tool", "ui-call"];

// Some browser actions can be invoked while an agent turn for the same chat
// still owns the per-chat write lock. Do not make those RPCs wait for that
// lock: handlers run in a fresh V8 context and their individual host calls
// still use the normal storage transaction boundaries. Manual chat renames only
// update title pointers, so waiting behind a long turn makes the UI appear hung.
const CHAT_LOCK_BYPASS_COMMANDS: &[&str] = &["chat-rename", "ui-call"];

fn needs_fresh_context(input: &str) -> bool {
    parse_input(input)
        .as_ref()
        .map(command_from)
        .is_some_and(|command| FRESH_CONTEXT_COMMANDS.contains(&command))
}

fn route_input(input: &str) -> (Lane, Option<String>) {
    let Some(v) = parse_input(input) else {
        return (Lane::Write, None);
    };
    let command = command_from(&v);
    let lane = lane_for(command);
    let lock_key = (lane == Lane::Write && !CHAT_LOCK_BYPASS_COMMANDS.contains(&command))
        .then(|| write_lock_key(command, &v));
    (lane, lock_key)
}

fn lane_for(command: &str) -> Lane {
    if FAST_READ_ONLY_COMMANDS.contains(&command) {
        Lane::FastRead
    } else if SCAN_READ_ONLY_COMMANDS.contains(&command) {
        Lane::ScanRead
    } else if command == "ui-call" {
        Lane::Ui
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

fn command_from_input(input: &str) -> String {
    parse_input(input)
        .as_ref()
        .map(command_from)
        .unwrap_or("describe")
        .to_string()
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

fn payload_with_server_base_url(input: String, base_url: Option<&str>) -> String {
    let Some(base_url) = base_url.filter(|s| !s.is_empty()) else {
        return input;
    };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&input) else {
        return input;
    };
    let Some(obj) = value.as_object_mut() else {
        return input;
    };
    if obj.contains_key("serverBaseUrl") {
        return input;
    }
    obj.insert(
        "serverBaseUrl".to_string(),
        serde_json::Value::String(base_url.to_string()),
    );
    value.to_string()
}

fn chat_rm_chat_id(input: &str) -> Option<String> {
    let value = parse_input(input)?;
    if command_from(&value) != "chat-rm" {
        return None;
    }
    if let Some(chat_id) = value.get("chatId").and_then(|x| x.as_str()) {
        let trimmed = chat_id.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    value
        .get("argv")
        .and_then(|x| x.as_array())
        .and_then(|argv| argv.get(1))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_snapshot_replacement_drops_old_isolate_before_new_one() {
        runtime::init_v8();
        let mut rt = WorkerRuntime::new("test-worker", 0, None);
        let bundle_one = Arc::new(
            "globalThis.main = () => ({ ok: true, value: atob(btoa('one')) });".to_string(),
        );
        let bundle_two = Arc::new(
            "globalThis.main = () => ({ ok: true, value: atob(btoa('two')) });".to_string(),
        );

        assert!(!rt.ensure_snapshot_bundle(&bundle_one).unwrap());
        assert!(rt.ensure_snapshot_bundle(&bundle_one).unwrap());
        assert!(!rt.ensure_snapshot_bundle(&bundle_two).unwrap());

        let outcome = run_snapshot_bundle_job(&mut rt, "{}", true);
        assert_eq!(outcome.result.unwrap(), r#"{"ok":true,"value":"two"}"#);
    }

    #[test]
    fn describe_uses_scan_lane_without_chat_lock() {
        assert_eq!(
            route_input(r#"{"command":"describe","chatId":"abc"}"#),
            (Lane::ScanRead, None)
        );
    }

    #[test]
    fn skill_read_commands_use_fast_read_lane_without_chat_lock() {
        assert_eq!(
            route_input(r#"{"command":"skills-list","chatId":"abc"}"#),
            (Lane::FastRead, None)
        );
        assert_eq!(
            route_input(r#"{"command":"skill-get","chatId":"abc","id":"apps"}"#),
            (Lane::FastRead, None)
        );
    }

    #[test]
    fn ui_call_uses_dedicated_lane_without_chat_lock() {
        assert_eq!(
            route_input(
                r#"{"command":"ui-call","chatId":"abc","uiId":"linear-active-tickets","name":"refresh"}"#
            ),
            (Lane::Ui, None)
        );
        assert!(needs_fresh_context(
            r#"{"command":"ui-call","chatId":"abc","uiId":"linear-active-tickets"}"#
        ));
    }

    #[test]
    fn chat_rename_uses_write_lane_without_chat_lock() {
        assert_eq!(
            route_input(r#"{"command":"chat-rename","chatId":"abc","title":"New title"}"#),
            (Lane::Write, None)
        );
    }

    #[test]
    fn chat_rm_chat_id_reads_command_payloads() {
        assert_eq!(
            chat_rm_chat_id(r#"{"command":"chat-rm","chatId":"abc"}"#),
            Some("abc".to_string())
        );
        assert_eq!(
            chat_rm_chat_id(r#"{"argv":["chat-rm","from-argv"]}"#),
            Some("from-argv".to_string())
        );
    }

    #[test]
    fn pending_messages_hydrate_from_fast_read_lane_without_chat_lock() {
        assert_eq!(
            route_input(r#"{"command":"pending-messages","chatId":"c1"}"#),
            (Lane::FastRead, None)
        );
    }

    #[test]
    fn chat_rm_chat_id_ignores_other_commands() {
        assert_eq!(
            chat_rm_chat_id(r#"{"command":"interrupt","chatId":"abc"}"#),
            None
        );
        assert_eq!(chat_rm_chat_id(r#"{"command":"chat-rm"}"#), None);
        assert_eq!(chat_rm_chat_id("not json"), None);
    }

    #[test]
    fn dynamic_pool_scales_up_when_queue_exceeds_active_workers() {
        let pool = JobPool::new("test-dynamic-grow", 3, ":memory:");
        assert_eq!(pool.allocate_worker_id(), 0);

        assert_eq!(pool.job_queued_and_allocate_worker_if_needed(), None);
        assert_eq!(pool.job_queued_and_allocate_worker_if_needed(), Some(1));
        assert_eq!(pool.job_queued_and_allocate_worker_if_needed(), Some(2));
        assert_eq!(pool.job_queued_and_allocate_worker_if_needed(), None);

        let state = pool.state.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(state.active_workers, 3);
        assert_eq!(state.queued, 4);
        assert_eq!(state.next_worker_id, 3);
    }

    #[test]
    fn dynamic_pool_keeps_idle_worker_when_recent_max_reached_count() {
        let pool = JobPool::new("test-dynamic-hold", 4, ":memory:");
        for _ in 0..3 {
            pool.allocate_worker_id();
        }
        {
            let mut state = pool.state.lock().unwrap_or_else(|e| e.into_inner());
            state.busy_workers = 0;
            state.queued = 0;
            state.utilization.clear();
            state.utilization.push_back(UtilizationSample {
                at: Instant::now(),
                busy: 3,
            });
        }

        assert!(!pool.retire_idle_worker_if_underutilized());
        assert_eq!(
            pool.state
                .lock()
                .expect("dynamic pool state")
                .active_workers,
            3
        );
    }

    #[test]
    fn dynamic_pool_retires_idle_worker_when_recent_max_below_count() {
        let pool = JobPool::new("test-dynamic-shrink", 4, ":memory:");
        for _ in 0..3 {
            pool.allocate_worker_id();
        }
        {
            let mut state = pool.state.lock().unwrap_or_else(|e| e.into_inner());
            state.busy_workers = 0;
            state.queued = 0;
            state.utilization.clear();
            state.utilization.push_back(UtilizationSample {
                at: Instant::now(),
                busy: 2,
            });
        }

        assert!(pool.retire_idle_worker_if_underutilized());
        assert_eq!(
            pool.state
                .lock()
                .expect("dynamic pool state")
                .active_workers,
            2
        );
    }

    #[test]
    fn dynamic_pool_keeps_one_worker_warm() {
        let pool = JobPool::new("test-dynamic-floor", 1, ":memory:");
        pool.allocate_worker_id();
        {
            let mut state = pool.state.lock().unwrap_or_else(|e| e.into_inner());
            state.busy_workers = 0;
            state.queued = 0;
            state.utilization.clear();
        }

        assert!(!pool.retire_idle_worker_if_underutilized());
        assert_eq!(
            pool.state
                .lock()
                .expect("dynamic pool state")
                .active_workers,
            1
        );
    }

    #[test]
    fn payload_with_server_base_url_adds_configured_url() {
        let payload = payload_with_server_base_url(
            r#"{"command":"run-ts-tool","chatId":"c"}"#.to_string(),
            Some("http://100.126.83.89:5173"),
        );
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(
            value.get("serverBaseUrl").and_then(|v| v.as_str()),
            Some("http://100.126.83.89:5173")
        );
    }

    #[test]
    fn payload_with_server_base_url_preserves_explicit_value() {
        let payload = payload_with_server_base_url(
            r#"{"command":"mcp-oauth-start","serverBaseUrl":"http://explicit"}"#.to_string(),
            Some("http://configured"),
        );
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(
            value.get("serverBaseUrl").and_then(|v| v.as_str()),
            Some("http://explicit")
        );
    }

    #[test]
    fn payload_with_server_base_url_ignores_missing_config() {
        let input = r#"{"command":"run-ts-tool"}"#.to_string();
        assert_eq!(payload_with_server_base_url(input.clone(), None), input);
    }
}
