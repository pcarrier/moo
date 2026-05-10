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
use std::time::Instant;

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
const MIN_HEAP_LIMIT_BYTES: usize = 1024 * 1024;
const V8_EVENTS_MAX: usize = 1000;
const V8_LANES: &[&str] = &[
    "moo-worker",
    "moo-read-worker",
    "moo-scan-worker",
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
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V8RuntimeSettings {
    // Legacy/global fields are kept for compatibility with existing settings.
    pub max_workers: Option<usize>,
    pub read_max_workers: Option<usize>,
    pub scan_max_workers: Option<usize>,
    pub tool_max_workers: Option<usize>,
    pub max_old_generation_bytes: Option<usize>,
    pub max_young_generation_bytes: Option<usize>,
    pub recycle_used_heap_bytes: Option<usize>,
    pub startup_snapshots_enabled: Option<bool>,
    pub main_pool: Option<V8PoolRuntimeSettings>,
    pub read_pool: Option<V8PoolRuntimeSettings>,
    pub scan_pool: Option<V8PoolRuntimeSettings>,
    pub tool_pool: Option<V8PoolRuntimeSettings>,
}

fn pool_settings(
    max_workers: usize,
    max_old_generation_bytes: usize,
    max_young_generation_bytes: usize,
    recycle_used_heap_bytes: usize,
) -> V8PoolRuntimeSettings {
    V8PoolRuntimeSettings {
        max_workers: Some(max_workers),
        max_old_generation_bytes: Some(max_old_generation_bytes),
        max_young_generation_bytes: Some(max_young_generation_bytes),
        recycle_used_heap_bytes: Some(recycle_used_heap_bytes),
    }
}

pub fn default_v8_runtime_settings() -> V8RuntimeSettings {
    V8RuntimeSettings {
        max_workers: Some(DEFAULT_MAX_WORKERS),
        read_max_workers: Some(default_read_max_workers(DEFAULT_MAX_WORKERS)),
        scan_max_workers: Some(1),
        tool_max_workers: Some(default_tool_max_workers(DEFAULT_MAX_WORKERS)),
        max_old_generation_bytes: Some(DEFAULT_MAX_OLD_GENERATION_BYTES),
        max_young_generation_bytes: Some(DEFAULT_MAX_YOUNG_GENERATION_BYTES),
        recycle_used_heap_bytes: Some(DEFAULT_RECYCLE_USED_HEAP_BYTES),
        startup_snapshots_enabled: Some(true),
        main_pool: Some(pool_settings(
            DEFAULT_MAX_WORKERS,
            DEFAULT_MAX_OLD_GENERATION_BYTES,
            DEFAULT_MAX_YOUNG_GENERATION_BYTES,
            DEFAULT_RECYCLE_USED_HEAP_BYTES,
        )),
        read_pool: Some(pool_settings(
            default_read_max_workers(DEFAULT_MAX_WORKERS),
            DEFAULT_MAX_OLD_GENERATION_BYTES,
            DEFAULT_MAX_YOUNG_GENERATION_BYTES,
            DEFAULT_RECYCLE_USED_HEAP_BYTES,
        )),
        scan_pool: Some(pool_settings(
            1,
            DEFAULT_MAX_OLD_GENERATION_BYTES,
            DEFAULT_MAX_YOUNG_GENERATION_BYTES,
            DEFAULT_RECYCLE_USED_HEAP_BYTES,
        )),
        tool_pool: Some(pool_settings(
            default_tool_max_workers(DEFAULT_MAX_WORKERS),
            DEFAULT_MAX_OLD_GENERATION_BYTES,
            DEFAULT_MAX_YOUNG_GENERATION_BYTES,
            DEFAULT_RECYCLE_USED_HEAP_BYTES,
        )),
    }
}

pub fn effective_v8_runtime_settings() -> V8RuntimeSettings {
    V8RuntimeSettings {
        max_workers: Some(configured_max_workers()),
        read_max_workers: Some(configured_read_max_workers()),
        scan_max_workers: Some(configured_scan_max_workers()),
        tool_max_workers: Some(configured_tool_max_workers()),
        max_old_generation_bytes: Some(max_old_generation_bytes_for_lane("moo-worker")),
        max_young_generation_bytes: Some(max_young_generation_bytes_for_lane("moo-worker")),
        recycle_used_heap_bytes: Some(recycle_used_heap_bytes_for_lane("moo-worker")),
        startup_snapshots_enabled: Some(startup_snapshots_enabled()),
        main_pool: Some(effective_pool_settings("moo-worker")),
        read_pool: Some(effective_pool_settings("moo-read-worker")),
        scan_pool: Some(effective_pool_settings("moo-scan-worker")),
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
    normalize_pool_runtime_settings(&mut settings.main_pool);
    normalize_pool_runtime_settings(&mut settings.read_pool);
    normalize_pool_runtime_settings(&mut settings.scan_pool);
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
    pub total_enqueued: u64,
    pub max_queued: usize,
    pub last_queue_wait_ms: u64,
    pub max_queue_wait_ms: u64,
    pub total_queue_wait_ms: u64,
    pub observed_queue_waits: u64,
    pub average_queue_wait_ms: u64,
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
        self.workers.lock().unwrap().insert(
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
            .unwrap()
            .entry(lane.to_string())
            .or_insert_with(|| V8PoolQueueSnapshot {
                lane: lane.to_string(),
                ..Default::default()
            });
    }

    fn job_queued(&self, lane: &str) {
        let mut queues = self.queues.lock().unwrap();
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

    fn job_dequeued(&self, lane: &str) {
        let mut queues = self.queues.lock().unwrap();
        let queue = queues
            .entry(lane.to_string())
            .or_insert_with(|| V8PoolQueueSnapshot {
                lane: lane.to_string(),
                ..Default::default()
            });
        queue.queued = queue.queued.saturating_sub(1);
    }

    fn observe_queue_wait(&self, lane: &str, queue_wait_ms: u64) {
        let mut queues = self.queues.lock().unwrap();
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
        queue.average_queue_wait_ms = if queue.observed_queue_waits == 0 {
            0
        } else {
            queue.total_queue_wait_ms / queue.observed_queue_waits
        };
    }

    fn generation_started(&self, lane: &str, id: usize, generation: u64) {
        let key = worker_key(lane, id);
        let now = now_ms();
        if let Some(state) = self.workers.lock().unwrap().get_mut(&key) {
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
        if let Some(state) = self.workers.lock().unwrap().get_mut(&key) {
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
        if let Some(state) = self.workers.lock().unwrap().get_mut(&key) {
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
        if let Some(state) = self.workers.lock().unwrap().get_mut(&key) {
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
        if let Some(state) = self.workers.lock().unwrap().get_mut(&key) {
            state.snapshot.status = "stopped".to_string();
            state.snapshot.current_command = None;
            state.snapshot.current_job_started_at = None;
            state.snapshot.current_job_elapsed_ns = None;
            state.current_started_instant = None;
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

    fn snapshot(&self) -> V8StatsSnapshot {
        let generated_at = now_ms();
        let mut workers: Vec<V8WorkerSnapshot> = self
            .workers
            .lock()
            .unwrap()
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
        let mut pools: Vec<V8PoolQueueSnapshot> =
            self.queues.lock().unwrap().values().cloned().collect();
        pools.sort_by(|a, b| a.lane.cmp(&b.lane));
        let mut totals = V8TotalsSnapshot {
            workers: workers.len(),
            ..Default::default()
        };
        for worker in &workers {
            if worker.status == "busy" {
                totals.busy += 1;
            }
            totals.total_jobs = totals.total_jobs.saturating_add(worker.jobs);
            totals.total_errors = totals.total_errors.saturating_add(worker.errors);
            totals.total_terminations = totals
                .total_terminations
                .saturating_add(worker.terminations);
            totals.total_recycles = totals.total_recycles.saturating_add(worker.recycles);
            totals.total_near_heap_limit = totals
                .total_near_heap_limit
                .saturating_add(worker.near_heap_limit);
            totals.total_cache_hits = totals.total_cache_hits.saturating_add(worker.cache_hits);
            totals.total_cache_misses = totals
                .total_cache_misses
                .saturating_add(worker.cache_misses);
            totals.total_snapshot_hits = totals
                .total_snapshot_hits
                .saturating_add(worker.snapshot_hits);
            totals.total_snapshot_misses = totals
                .total_snapshot_misses
                .saturating_add(worker.snapshot_misses);
            if let Some(heap) = &worker.heap {
                totals.used_heap_size = totals.used_heap_size.saturating_add(heap.used_heap_size);
                totals.total_heap_size =
                    totals.total_heap_size.saturating_add(heap.total_heap_size);
            }
        }
        for pool in &pools {
            totals.queued = totals.queued.saturating_add(pool.queued);
            totals.total_enqueued = totals.total_enqueued.saturating_add(pool.total_enqueued);
            totals.max_queued = totals.max_queued.max(pool.max_queued);
        }
        let cache_entries = workers.iter().map(|w| w.cache_entries).sum();
        let events = self.events.lock().unwrap().iter().cloned().collect();
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
                pools: v8_pool_config_snapshots(),
            },
            totals,
        }
    }

    fn push_event(&self, event: V8Event) {
        let mut events = self.events.lock().unwrap();
        events.push_back(event.clone());
        while events.len() > V8_EVENTS_MAX {
            events.pop_front();
        }
        drop(events);
        if let Ok(payload) = serde_json::to_string(&json!({ "kind": "v8", "event": &event })) {
            crate::broadcast::publish(payload);
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
        .unwrap()
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
    let mut overrides = V8_CONFIG_OVERRIDES.lock().unwrap();
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
    let mut overrides = V8_CONFIG_OVERRIDES.lock().unwrap();
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
    if let Some(value) = settings.startup_snapshots_enabled {
        overrides.insert(
            "MOO_V8_STARTUP_SNAPSHOTS".to_string(),
            if value { "1" } else { "0" }.to_string(),
        );
    }
    apply_v8_pool_runtime_settings(&mut overrides, "MOO_V8_MAIN", settings.main_pool.as_ref());
    apply_v8_pool_runtime_settings(&mut overrides, "MOO_V8_READ", settings.read_pool.as_ref());
    apply_v8_pool_runtime_settings(&mut overrides, "MOO_V8_SCAN", settings.scan_pool.as_ref());
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
        })
        .collect()
}

fn lane_env_prefix(lane: &str) -> &'static str {
    match lane {
        "moo-read-worker" => "MOO_V8_READ",
        "moo-scan-worker" => "MOO_V8_SCAN",
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

fn effective_pool_settings(lane: &str) -> V8PoolRuntimeSettings {
    pool_settings(
        configured_workers_for_lane(lane),
        max_old_generation_bytes_for_lane(lane),
        max_young_generation_bytes_for_lane(lane),
        recycle_used_heap_bytes_for_lane(lane),
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
    server_base_url: Option<String>,
    db: String,
}

impl Pool {
    pub fn new(workers: usize, db: &str, server_base_url: Option<String>) -> Self {
        let workers = workers.max(1);
        let (tx, rx) = mpsc::channel::<Job>();
        spawn_workers("moo-worker", workers, rx, db);

        // UI/API reads must stay responsive even while agent/tool work fills
        // the main isolate pool. Keep fast reads on their own lane, and keep
        // whole-store scans (triples/vocabulary) off that lane so they cannot
        // starve chat-models/ui-chat/describe refreshes.
        let read_workers = configured_read_max_workers();
        let (read_tx, read_rx) = mpsc::channel::<Job>();
        spawn_workers("moo-read-worker", read_workers, read_rx, db);

        let scan_workers = configured_scan_max_workers();
        let (scan_tx, scan_rx) = mpsc::channel::<Job>();
        spawn_workers("moo-scan-worker", scan_workers, scan_rx, db);

        let async_tool_workers = configured_tool_max_workers();
        let (async_tool_tx, async_tool_rx) = mpsc::channel::<AsyncToolJob>();
        spawn_async_tool_workers("moo-tool-worker", async_tool_workers, async_tool_rx, db);

        Pool {
            tx,
            read_tx,
            scan_tx,
            async_tool_tx,
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
                return self.dispatch_on("moo-read-worker", &self.read_tx, bundle, input);
            }
            Lane::ScanRead => {
                return self.dispatch_on("moo-scan-worker", &self.scan_tx, bundle, input);
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
        V8_OBSERVABILITY.job_queued("moo-tool-worker");
        if self
            .async_tool_tx
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
            V8_OBSERVABILITY.job_dequeued("moo-tool-worker");
            return Err("async tool isolate pool closed".to_string());
        }
        recv_job_result(resp_rx, "async tool isolate worker dropped")
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
        self.dispatch_on("moo-worker", &self.tx, bundle, input)
    }

    fn dispatch_on(
        &self,
        lane: &str,
        tx: &Sender<Job>,
        bundle: Arc<String>,
        input: String,
    ) -> Result<String, String> {
        let (resp_tx, resp_rx) = mpsc::channel();
        V8_OBSERVABILITY.job_queued(lane);
        if tx
            .send(Job {
                bundle,
                input,
                response: resp_tx,
                enqueued_at: Instant::now(),
            })
            .is_err()
        {
            V8_OBSERVABILITY.job_dequeued(lane);
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

fn recv_locked<T>(rx: &Arc<Mutex<mpsc::Receiver<T>>>) -> Option<T> {
    rx.lock().unwrap().recv().ok()
}

fn spawn_workers(name: &str, count: usize, rx: mpsc::Receiver<Job>, db: &str) {
    let rx = Arc::new(Mutex::new(rx));
    for i in 0..count.max(1) {
        let rx = rx.clone();
        let db = db.to_string();
        let thread_name = format!("{name}-{i}");
        let lane = name.to_string();
        thread::Builder::new()
            .name(thread_name.clone())
            .spawn(move || worker_loop(rx, db, lane, i))
            .unwrap_or_else(|_| panic!("spawn {thread_name}"));
    }
}

fn worker_loop(rx: Arc<Mutex<mpsc::Receiver<Job>>>, db: String, lane: String, id: usize) {
    if let Err(e) = host::install(&db) {
        eprintln!("[worker {id}] host init: {e}");
        return;
    }
    runtime::init_v8();
    V8_OBSERVABILITY.register_worker(&lane, id);
    let mut rt = WorkerRuntime::new(&lane, id, None);

    loop {
        let Some(job) = recv_locked(&rx) else {
            break; // channel closed
        };
        V8_OBSERVABILITY.job_dequeued(&lane);
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

fn spawn_async_tool_workers(name: &str, count: usize, rx: mpsc::Receiver<AsyncToolJob>, db: &str) {
    let rx = Arc::new(Mutex::new(rx));
    for i in 0..count.max(1) {
        let rx = rx.clone();
        let db = db.to_string();
        let thread_name = format!("{name}-{i}");
        let lane = name.to_string();
        thread::Builder::new()
            .name(thread_name.clone())
            .spawn(move || async_tool_worker_loop(rx, db, lane, i))
            .unwrap_or_else(|_| panic!("spawn {thread_name}"));
    }
}

fn async_tool_worker_loop(
    rx: Arc<Mutex<mpsc::Receiver<AsyncToolJob>>>,
    db: String,
    lane: String,
    id: usize,
) {
    if let Err(e) = host::install(&db) {
        eprintln!("[async tool worker {id}] host init: {e}");
        return;
    }
    runtime::init_v8();
    V8_OBSERVABILITY.register_worker(&lane, id);
    let mut rt = WorkerRuntime::new(&lane, id, None);

    loop {
        let Some(job) = recv_locked(&rx) else {
            break;
        };
        V8_OBSERVABILITY.job_dequeued(&lane);
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
}

const FAST_READ_ONLY_COMMANDS: &[&str] = &[
    "describe",
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
];

const SCAN_READ_ONLY_COMMANDS: &[&str] =
    &["graph-summaries", "memory-query", "triples", "vocabulary"];

const FRESH_CONTEXT_COMMANDS: &[&str] = &["run-js-tool", "ui-call"];

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
    fn chat_rm_chat_id_ignores_other_commands() {
        assert_eq!(
            chat_rm_chat_id(r#"{"command":"interrupt","chatId":"abc"}"#),
            None
        );
        assert_eq!(chat_rm_chat_id(r#"{"command":"chat-rm"}"#), None);
        assert_eq!(chat_rm_chat_id("not json"), None);
    }

    #[test]
    fn payload_with_server_base_url_adds_configured_url() {
        let payload = payload_with_server_base_url(
            r#"{"command":"run-js-tool","chatId":"c"}"#.to_string(),
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
        let input = r#"{"command":"run-js-tool"}"#.to_string();
        assert_eq!(payload_with_server_base_url(input.clone(), None), input);
    }
}
