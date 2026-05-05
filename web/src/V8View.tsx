import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Bag } from "./state";
import { ControlField, EmptyState, HeaderIconButton, MetricCard, PageHeader } from "./PageChrome";
import type { V8HeapSnapshot, V8WorkerSnapshot } from "./api";

function formatBytes(bytes: number | null | undefined): string {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return n.toFixed(0) + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KiB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MiB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GiB";
}

function formatMs(ms: number | null | undefined): string {
  const n = Number(ms ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0 ms";
  if (n < 1000) return n.toFixed(0) + " ms";
  if (n < 60_000) return (n / 1000).toFixed(2) + " s";
  return (n / 60_000).toFixed(1) + " min";
}

function formatTime(at: number | null | undefined): string {
  const n = Number(at ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Date(n).toISOString();
}

function pct(part: number | null | undefined, total: number | null | undefined): number {
  const p = Number(part ?? 0);
  const t = Number(total ?? 0);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return 0;
  return Math.max(0, Math.min(100, (p / t) * 100));
}

function hitRate(hit: number, miss: number): string {
  const total = hit + miss;
  if (!total) return "—";
  return Math.round((hit / total) * 100) + "%";
}

function heapUsedPct(heap?: V8HeapSnapshot | null): number {
  if (!heap) return 0;
  return pct(heap.usedHeapSize, heap.heapSizeLimit || heap.totalHeapSize);
}

function statusClass(status: string): string {
  if (status === "busy") return "busy";
  if (status === "recycling") return "warn";
  if (status === "stopped") return "error";
  return "ok";
}

function laneLabel(lane: string): string {
  return lane.replace(/^moo-/, "");
}

function shortHash(hash: string | null | undefined): string {
  if (!hash) return "—";
  return hash.replace(/^sha256:/, "").slice(0, 12);
}

function Bar(props: { value: number; label?: string; tone?: "ok" | "warn" | "error" }) {
  const width = () => Math.max(0, Math.min(100, props.value || 0)).toFixed(1) + "%";
  return (
    <div class={"v8-bar " + (props.tone || "")} title={props.label || width()}>
      <div class="v8-bar-fill" style={{ width: width() }} />
    </div>
  );
}

type PoolSummary = {
  lane: string;
  workers: number;
  busy: number;
  idle: number;
  recycling: number;
  stopped: number;
  jobs: number;
  errors: number;
  recycles: number;
  nearHeapLimit: number;
  cacheHits: number;
  cacheMisses: number;
  snapshotHits: number;
  snapshotMisses: number;
  usedHeapSize: number;
  heapSizeLimit: number;
  cacheEntries: number;
  contexts: number;
};

function summarizePools(workers: V8WorkerSnapshot[]): PoolSummary[] {
  const byLane = new Map<string, PoolSummary>();
  for (const worker of workers) {
    let pool = byLane.get(worker.lane);
    if (!pool) {
      pool = {
        lane: worker.lane,
        workers: 0,
        busy: 0,
        idle: 0,
        recycling: 0,
        stopped: 0,
        jobs: 0,
        errors: 0,
        recycles: 0,
        nearHeapLimit: 0,
        cacheHits: 0,
        cacheMisses: 0,
        snapshotHits: 0,
        snapshotMisses: 0,
        usedHeapSize: 0,
        heapSizeLimit: 0,
        cacheEntries: 0,
        contexts: 0,
      };
      byLane.set(worker.lane, pool);
    }
    pool.workers += 1;
    if (worker.status === "busy") pool.busy += 1;
    else if (worker.status === "recycling") pool.recycling += 1;
    else if (worker.status === "stopped") pool.stopped += 1;
    else pool.idle += 1;
    pool.jobs += worker.jobs;
    pool.errors += worker.errors;
    pool.recycles += worker.recycles;
    pool.nearHeapLimit += worker.nearHeapLimit;
    pool.cacheHits += worker.cacheHits;
    pool.cacheMisses += worker.cacheMisses;
    pool.snapshotHits += worker.snapshotHits;
    pool.snapshotMisses += worker.snapshotMisses;
    pool.usedHeapSize += worker.heap?.usedHeapSize ?? 0;
    pool.heapSizeLimit += worker.heap?.heapSizeLimit ?? 0;
    pool.cacheEntries += worker.cacheEntries;
    pool.contexts += worker.heap?.numberOfNativeContexts ?? 0;
  }
  return [...byLane.values()].sort((a, b) => a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0);
}

function WorkerCountBar(props: { pool: PoolSummary; max: number }) {
  const width = (value: number) => pct(value, props.max);
  const display = () => props.pool.busy + "/" + props.pool.workers;
  return (
    <div class="v8-chart-row">
      <div class="v8-chart-label" title={laneLabel(props.pool.lane)}>{laneLabel(props.pool.lane)}</div>
      <div class="v8-stacked-bar" title={props.pool.busy + " busy / " + props.pool.workers + " workers"}>
        <div class="busy" style={{ width: width(props.pool.busy).toFixed(1) + "%" }} />
        <div class="idle" style={{ width: width(props.pool.idle).toFixed(1) + "%" }} />
        <div class="warn" style={{ width: width(props.pool.recycling).toFixed(1) + "%" }} />
        <div class="error" style={{ width: width(props.pool.stopped).toFixed(1) + "%" }} />
      </div>
      <div class="v8-chart-value" title={display()}>{display()}</div>
    </div>
  );
}

function MetricBar(props: { label: string; value: number; max: number; display: string; tone?: "ok" | "warn" | "error" }) {
  return (
    <div class="v8-chart-row">
      <div class="v8-chart-label" title={props.label}>{props.label}</div>
      <Bar value={pct(props.value, props.max)} tone={props.tone || "ok"} />
      <div class="v8-chart-value" title={props.display}>{props.display}</div>
    </div>
  );
}

function PoolCharts(props: { pools: PoolSummary[] }) {
  const maxWorkers = () => Math.max(1, ...props.pools.map((pool) => pool.workers));
  const maxHeap = () => Math.max(1, ...props.pools.map((pool) => pool.usedHeapSize));
  const maxJobs = () => Math.max(1, ...props.pools.map((pool) => pool.jobs));
  return (
    <section class="v8-charts">
      <article class="v8-chart-panel">
        <header><h2>workers per pool</h2><span>busy / total</span></header>
        <div class="v8-chart-legend"><span class="busy">busy</span><span class="idle">idle</span><span class="warn">recycling</span><span class="error">stopped</span></div>
        <For each={props.pools} fallback={<div class="memory-loading">No pools.</div>}>
          {(pool) => <WorkerCountBar pool={pool} max={maxWorkers()} />}
        </For>
      </article>

      <article class="v8-chart-panel">
        <header><h2>heap by pool</h2><span>used heap</span></header>
        <For each={props.pools} fallback={<div class="memory-loading">No pools.</div>}>
          {(pool) => {
            const heapPct = () => pct(pool.usedHeapSize, pool.heapSizeLimit);
            const tone = () => heapPct() > 85 ? "error" : heapPct() > 65 ? "warn" : "ok";
            return <MetricBar label={laneLabel(pool.lane)} value={pool.usedHeapSize} max={maxHeap()} display={formatBytes(pool.usedHeapSize)} tone={tone()} />;
          }}
        </For>
      </article>

      <article class="v8-chart-panel">
        <header><h2>jobs by pool</h2><span>errors / recycles</span></header>
        <For each={props.pools} fallback={<div class="memory-loading">No pools.</div>}>
          {(pool) => <MetricBar label={laneLabel(pool.lane)} value={pool.jobs} max={maxJobs()} display={pool.jobs + " jobs · " + pool.errors + " err · " + pool.recycles + " rec"} tone={pool.errors ? "warn" : "ok"} />}
        </For>
      </article>
    </section>
  );
}

function WorkerTable(props: { workers: V8WorkerSnapshot[] }) {
  return (
    <section class="v8-workers-panel">
      <h2>workers <span>{props.workers.length}</span></h2>
      <div class="v8-workers-wrap">
        <table class="v8-workers-table">
          <thead>
            <tr><th>pool</th><th>id</th><th>status</th><th>heap</th><th title="total jobs; worker generation and jobs in this generation">jobs / generation</th><th>cache</th><th>snapshot</th><th>current / last</th><th>note</th></tr>
          </thead>
          <tbody>
            <For each={props.workers} fallback={<tr><td colSpan={9}>No workers in this lane.</td></tr>}>
              {(worker) => {
                const heapPct = () => heapUsedPct(worker.heap);
                const heapTone = () => heapPct() > 85 ? "error" : heapPct() > 65 ? "warn" : "ok";
                const command = () => worker.status === "busy" ? (worker.currentCommand || "running") : (worker.lastCommand || "idle");
                const elapsed = () => worker.status === "busy" ? worker.currentJobElapsedMs : worker.lastDurationMs;
                const note = () => worker.lastError || worker.lastRecycleReason || shortHash(worker.snapshotHash);
                return (
                  <tr class={"v8-worker-row " + statusClass(worker.status)}>
                    <td>{laneLabel(worker.lane)}</td>
                    <td>#{worker.workerId}</td>
                    <td><span class={"v8-pill " + statusClass(worker.status)}>{worker.status}</span></td>
                    <td><div class="v8-table-meter"><Bar value={heapPct()} tone={heapTone()} /><span>{formatBytes(worker.heap?.usedHeapSize)}</span></div></td>
                    <td>{worker.jobs} <span class="muted" title="worker generation; jobs completed in this generation">gen {worker.generation} · {worker.generationJobs}</span></td>
                    <td>{hitRate(worker.cacheHits, worker.cacheMisses)} <span class="muted">{worker.cacheEntries}</span></td>
                    <td>{hitRate(worker.snapshotHits, worker.snapshotMisses)} <span class={worker.snapshotLoaded ? "ok" : "warn"}>{worker.snapshotLoaded ? "on" : "off"}</span></td>
                    <td class="v8-command-cell"><span>{command()}</span><span>{formatMs(elapsed())}</span></td>
                    <td class="v8-note-cell" title={note()}>{note()}</td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function V8View(props: { bag: Bag; onToggleSidebar: () => void }) {
  const { bag } = props;
  const [laneFilter, setLaneFilter] = createSignal("all");
  const [autoRefresh, setAutoRefresh] = createSignal(true);

  onMount(() => {
    void bag.refreshV8Stats();
  });

  createEffect(() => {
    if (!autoRefresh()) return;
    const timer = window.setInterval(() => {
      if (bag.view() === "v8") void bag.refreshV8Stats();
    }, 1500);
    onCleanup(() => window.clearInterval(timer));
  });

  const stats = () => bag.v8Stats();
  const lanes = createMemo(() => {
    const set = new Set(stats()?.workers.map((w) => w.lane) ?? []);
    return ["all", ...[...set].sort()];
  });
  const allWorkers = createMemo(() => stats()?.workers ?? []);
  const workers = createMemo(() => {
    const lane = laneFilter();
    const rows = allWorkers();
    return lane === "all" ? rows : rows.filter((w) => w.lane === lane);
  });
  const poolRows = createMemo(() => summarizePools(workers()));
  const totals = () => stats()?.totals;
  const config = () => stats()?.config;
  const heapPctTotal = () => pct(totals()?.usedHeapSize, totals()?.totalHeapSize);

  return (
    <main class="timeline v8-view">
      <PageHeader
        bag={bag}
        class="v8-header"
        title="V8"
        onToggleSidebar={props.onToggleSidebar}
        showRightSidebarToggle
        actions={<>
          <label class="v8-toggle"><input type="checkbox" checked={autoRefresh()} onChange={(e) => setAutoRefresh(e.currentTarget.checked)} /> live</label>
          <HeaderIconButton
            title="refresh V8 stats"
            aria-label="refresh V8 stats"
            onClick={() => void bag.refreshV8Stats()}
          >
            ↻
          </HeaderIconButton>
        </>}
      />

      <Show when={stats()} fallback={<EmptyState class="memory-loading">{bag.v8StatsLoaded() ? "No V8 stats yet." : "Loading V8 stats…"}</EmptyState>}>
        <section class="v8-stats-grid">
          <MetricCard class="v8-stat-card" label="workers" value={(totals()?.busy ?? 0) + "/" + (totals()?.workers ?? 0)} sub="busy / total" />
          <MetricCard class="v8-stat-card" label="jobs" value={totals()?.totalJobs ?? 0} sub={(totals()?.totalErrors ?? 0) + " errors"} tone={(totals()?.totalErrors ?? 0) ? "warn" : "ok"} />
          <MetricCard class="v8-stat-card" label="recycles" value={totals()?.totalRecycles ?? 0} sub={(totals()?.totalNearHeapLimit ?? 0) + " near heap · " + (totals()?.totalTerminations ?? 0) + " terminated"} tone={(totals()?.totalTerminations ?? 0) ? "error" : (totals()?.totalNearHeapLimit ?? 0) ? "warn" : (totals()?.totalRecycles ?? 0) ? "warn" : "ok"} />
          <MetricCard class="v8-stat-card" label="heap" value={formatBytes(totals()?.usedHeapSize)} sub={heapPctTotal().toFixed(0) + "% of committed heap"} />
          <MetricCard class="v8-stat-card" label="cache hit" value={hitRate(totals()?.totalCacheHits ?? 0, totals()?.totalCacheMisses ?? 0)} sub={(totals()?.totalCacheHits ?? 0) + " hits / " + (totals()?.totalCacheMisses ?? 0) + " misses"} />
          <MetricCard class="v8-stat-card" label="snapshot hit" value={hitRate(totals()?.totalSnapshotHits ?? 0, totals()?.totalSnapshotMisses ?? 0)} sub={config()?.startupSnapshotsEnabled ? "enabled" : "disabled"} tone={config()?.startupSnapshotsEnabled ? "ok" : "warn"} />
        </section>

        <section class="v8-config-row">
          <span>heap recycle <strong>{formatBytes(config()?.recycleUsedHeapBytes)}</strong></span>
          <span>cached contexts <strong>{config()?.cacheEntries ?? "—"}</strong></span>
          <span>updated <strong>{formatTime(stats()?.generatedAt)}</strong></span>
        </section>

        <section class="v8-toolbar">
          <ControlField class="v8-lane-control" label="lane">
            <select value={laneFilter()} onChange={(e) => setLaneFilter(e.currentTarget.value)}>
              <For each={lanes()}>{(lane) => <option value={lane}>{lane === "all" ? "all lanes" : laneLabel(lane)}</option>}</For>
            </select>
          </ControlField>
        </section>

        <PoolCharts pools={poolRows()} />

        <WorkerTable workers={workers()} />
      </Show>
    </main>
  );
}
