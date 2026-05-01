import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Bag } from "./state";
import type { V8Event, V8HeapSnapshot, V8WorkerSnapshot } from "./api";

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
  return new Date(n).toLocaleTimeString();
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

function StatCard(props: { label: string; value: string | number; sub?: string; tone?: "ok" | "warn" | "error" }) {
  return (
    <div class={"v8-stat-card " + (props.tone || "")}>
      <div class="v8-stat-label">{props.label}</div>
      <div class="v8-stat-value">{props.value}</div>
      <Show when={props.sub}><div class="v8-stat-sub">{props.sub}</div></Show>
    </div>
  );
}

function Bar(props: { value: number; label?: string; tone?: "ok" | "warn" | "error" }) {
  const width = () => Math.max(0, Math.min(100, props.value || 0)).toFixed(1) + "%";
  return (
    <div class={"v8-bar " + (props.tone || "")} title={props.label || width()}>
      <div class="v8-bar-fill" style={{ width: width() }} />
    </div>
  );
}

function WorkerCard(props: { worker: V8WorkerSnapshot }) {
  const w = () => props.worker;
  const heapPct = () => heapUsedPct(w().heap);
  const heapTone = () => heapPct() > 85 ? "error" : heapPct() > 65 ? "warn" : "ok";
  return (
    <article class="v8-worker-card">
      <header class="v8-worker-header">
        <div>
          <div class="v8-worker-title">{laneLabel(w().lane)} #{w().workerId}</div>
          <div class="v8-worker-sub">generation {w().generation} · {w().generationJobs} jobs in generation</div>
        </div>
        <div class={"v8-pill " + statusClass(w().status)}>{w().status}</div>
      </header>

      <div class="v8-worker-current">
        <span>{w().status === "busy" ? (w().currentCommand || "running") : (w().lastCommand || "idle")}</span>
        <span>{w().status === "busy" ? formatMs(w().currentJobElapsedMs) : formatMs(w().lastDurationMs)}</span>
      </div>

      <div class="v8-worker-meter-row">
        <div class="v8-meter-label">
          <span>heap</span>
          <span>{formatBytes(w().heap?.usedHeapSize)} / {formatBytes(w().heap?.heapSizeLimit)}</span>
        </div>
        <Bar value={heapPct()} tone={heapTone()} />
      </div>

      <div class="v8-worker-grid">
        <div><span>contexts</span><strong>{w().heap?.numberOfNativeContexts ?? "—"}</strong></div>
        <div><span>cached contexts</span><strong>{w().cacheEntries}</strong></div>
        <div><span>cache hit</span><strong>{hitRate(w().cacheHits, w().cacheMisses)}</strong></div>
        <div><span>snapshot</span><strong>{hitRate(w().snapshotHits, w().snapshotMisses)}</strong></div>
        <div><span>errors</span><strong>{w().errors}</strong></div>
        <div><span>recycles</span><strong>{w().recycles}</strong></div>
        <div><span>queue</span><strong>{formatMs(w().lastQueueWaitMs)}</strong></div>
      </div>

      <div class="v8-worker-tags">
        <span class={w().snapshotLoaded ? "on" : "off"}>startup snapshot {w().snapshotLoaded ? "on" : "off"}</span>
        <span>hash {shortHash(w().snapshotHash)}</span>
        <span>{w().lastContextKind || "—"} context</span>
      </div>

      <Show when={w().lastRecycleReason || w().lastError}>
        <div class="v8-worker-note">
          <Show when={w().lastRecycleReason}><div>recycled: {w().lastRecycleReason} at {formatTime(w().lastRecycleAt)}</div></Show>
          <Show when={w().lastError}><div class="error">last error: {w().lastError}</div></Show>
        </div>
      </Show>
    </article>
  );
}

function EventRow(props: { event: V8Event }) {
  const ev = () => props.event;
  return (
    <tr class={"v8-event-" + ev().kind}>
      <td>{formatTime(ev().at)}</td>
      <td>{laneLabel(ev().lane)} #{ev().workerId}</td>
      <td>{ev().generation}</td>
      <td><span class="v8-event-kind">{ev().kind}</span></td>
      <td>{ev().command || "—"}</td>
      <td>{ev().reason || "—"}</td>
      <td class="v8-event-detail">{ev().detail || ""}</td>
    </tr>
  );
}

export function V8View(props: { bag: Bag; onToggleSidebar: () => void }) {
  const { bag } = props;
  const [laneFilter, setLaneFilter] = createSignal("all");
  const [autoRefresh, setAutoRefresh] = createSignal(true);
  const [dense, setDense] = createSignal(false);

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
  const workers = createMemo(() => {
    const lane = laneFilter();
    const rows = stats()?.workers ?? [];
    return lane === "all" ? rows : rows.filter((w) => w.lane === lane);
  });
  const events = createMemo(() => (stats()?.events ?? []).slice().reverse().slice(0, dense() ? 80 : 30));
  const totals = () => stats()?.totals;
  const config = () => stats()?.config;
  const heapPctTotal = () => pct(totals()?.usedHeapSize, totals()?.totalHeapSize);

  return (
    <main class="timeline v8-view">
      <header class="view-header v8-header">
        <button type="button" class="mobile-nav-button" onClick={props.onToggleSidebar} aria-label="open navigation">☰</button>
        <div>
          <h1>V8 observability</h1>
          <p>Isolate generations, startup snapshot reuse, context caches, heap pressure, and recycle reasons.</p>
        </div>
        <div class="v8-header-actions">
          <label class="v8-toggle"><input type="checkbox" checked={autoRefresh()} onChange={(e) => setAutoRefresh(e.currentTarget.checked)} /> live</label>
          <button type="button" class="secondary" onClick={() => bag.refreshV8Stats()}>refresh</button>
        </div>
      </header>

      <Show when={stats()} fallback={<div class="memory-loading">{bag.v8StatsLoaded() ? "No V8 stats yet." : "Loading V8 stats…"}</div>}>
        <section class="v8-stats-grid">
          <StatCard label="workers" value={(totals()?.busy ?? 0) + "/" + (totals()?.workers ?? 0)} sub="busy / total" />
          <StatCard label="jobs" value={totals()?.totalJobs ?? 0} sub={(totals()?.totalErrors ?? 0) + " errors"} tone={(totals()?.totalErrors ?? 0) ? "warn" : "ok"} />
          <StatCard label="recycles" value={totals()?.totalRecycles ?? 0} sub={(totals()?.totalNearHeapLimit ?? 0) + " near heap · " + (totals()?.totalTerminations ?? 0) + " terminated"} tone={(totals()?.totalTerminations ?? 0) ? "error" : (totals()?.totalNearHeapLimit ?? 0) ? "warn" : (totals()?.totalRecycles ?? 0) ? "warn" : "ok"} />
          <StatCard label="heap" value={formatBytes(totals()?.usedHeapSize)} sub={heapPctTotal().toFixed(0) + "% of committed heap"} />
          <StatCard label="cache hit" value={hitRate(totals()?.totalCacheHits ?? 0, totals()?.totalCacheMisses ?? 0)} sub={(totals()?.totalCacheHits ?? 0) + " hits / " + (totals()?.totalCacheMisses ?? 0) + " misses"} />
          <StatCard label="snapshot hit" value={hitRate(totals()?.totalSnapshotHits ?? 0, totals()?.totalSnapshotMisses ?? 0)} sub={config()?.startupSnapshotsEnabled ? "enabled" : "disabled"} tone={config()?.startupSnapshotsEnabled ? "ok" : "warn"} />
        </section>

        <section class="v8-config-row">
          <span>heap recycle <strong>{formatBytes(config()?.recycleUsedHeapBytes)}</strong></span>
          <span>cached contexts <strong>{config()?.cacheEntries ?? "—"}</strong></span>
          <span>updated <strong>{formatTime(stats()?.generatedAt)}</strong></span>
        </section>

        <section class="v8-toolbar">
          <label>
            lane
            <select value={laneFilter()} onChange={(e) => setLaneFilter(e.currentTarget.value)}>
              <For each={lanes()}>{(lane) => <option value={lane}>{lane === "all" ? "all lanes" : laneLabel(lane)}</option>}</For>
            </select>
          </label>
          <label class="v8-toggle"><input type="checkbox" checked={dense()} onChange={(e) => setDense(e.currentTarget.checked)} /> more events</label>
        </section>

        <section class="v8-workers" classList={{ dense: dense() }}>
          <For each={workers()} fallback={<div class="memory-loading">No workers in this lane.</div>}>
            {(worker) => <WorkerCard worker={worker} />}
          </For>
        </section>

        <section class="v8-events-panel">
          <h2>recent lifecycle events</h2>
          <div class="v8-events-wrap">
            <table class="v8-events-table">
              <thead>
                <tr><th>time</th><th>worker</th><th>gen</th><th>event</th><th>command</th><th>reason</th><th>detail</th></tr>
              </thead>
              <tbody>
                <For each={events()} fallback={<tr><td colSpan={7}>No events yet.</td></tr>}>
                  {(event) => <EventRow event={event} />}
                </For>
              </tbody>
            </table>
          </div>
        </section>
      </Show>
    </main>
  );
}
