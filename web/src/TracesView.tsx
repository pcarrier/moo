import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import type { JSX } from "solid-js";
import type { Bag } from "./state";
import { LoadingDots } from "./LoadingDots";
import { RefreshIcon } from "./icons";
import { ActionButton, BackToChatButton, DetailSection, EmptyState, HeaderIconButton, InlineActions, Notice, PageHeader } from "./PageChrome";
import { api, type StoreObject, type TraceRow, type TraceSearchArgs } from "./api";
import { formatHjson, highlightAuto, highlightHjsonValue, maybeFormatHjsonTextForView } from "./syntax";

type LoadState = "idle" | "loading" | "error";
type TraceTab = "all" | "failed" | "search";
type TraceKindFilter = "any" | TraceRow["kind"];
type TraceStatusFilter = "any" | TraceRow["status"];
type SearchHit = { node: TraceRow; ancestors: TraceRow[]; root?: TraceRow | null };
type DetailState = { node: TraceRow; children: TraceRow[]; ancestors: TraceRow[]; root?: TraceRow | null };
type TraceTreeLoad = { root?: TraceRow | null; nodes: TraceRow[] };
type SelectTraceRootOptions = { request?: number; focusId?: string; expandIds?: Iterable<string>; preserveTab?: boolean; preserveUrl?: boolean };
type TreeRow = { node: TraceRow; depth: number; ghost?: boolean; parentId: string | null };
type TraceScopeFilter = "any" | "chat" | "global";

const TRACE_PAGE_LIMIT = 100;
const DEFAULT_TREE_DEPTH = 6;
const DEFAULT_TREE_OPEN_DEPTH = 1;
const SUBTREE_DEPTH = 4;
const TRACE_LOAD_TIMEOUT_MS = 30_000;
const KIND_FILTERS: TraceKindFilter[] = ["any", "frontend", "chat", "turn", "step", "llm", "tool", "runjs", "system", "user"];
const STATUS_FILTERS: TraceStatusFilter[] = ["any", "ok", "error", "running"];
const ROOT_KINDS = new Set<TraceRow["kind"]>(["chat", "command", "frontend", "http", "system", "trace", "runjs-recovered", "missing-parent"]);

const TRACE_SELECTOR_DEFAULT_W = 224;
const TRACE_SELECTOR_MIN_W = 168;
const TRACE_SELECTOR_MAX_W = 420;
const TRACE_DETAIL_DEFAULT_SPLIT = 0.5;
const TRACE_DETAIL_MIN_H = 176;
const TRACE_TIMELINE_MIN_H = 176;
const TRACE_SELECTOR_WIDTH_STORAGE_KEY = "moo.traceSelectorWidth";
const TRACE_DETAIL_SPLIT_STORAGE_KEY = "moo.traceDetailSplit";
const TRACE_DETAIL_SPLIT_MIN = 0.18;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || "unknown error");
}

function BareTraceLoading(props: { label: string }): JSX.Element {
  return <div class="trace-loading-bare" aria-live="polite"><LoadingDots class="trace-loading-dots" label={props.label} /></div>;
}

async function unwrap<T>(promise: Promise<{ ok: true; value: T } | { ok: false; error: { message?: string } }>, label: string): Promise<T> {
  const result = await withTimeout(promise, TRACE_LOAD_TIMEOUT_MS, label);
  if (!result.ok) throw new Error(result.error?.message || `${label} failed`);
  return result.value;
}

function nowNs(): number { return Date.now() * 1_000_000; }
function rowStartedNs(row: TraceRow): number { return Number(row.t0Ns); }
function rowEndedNs(row: TraceRow, now = nowNs()): number { return row.t1Ns == null ? now : Number(row.t1Ns); }
function rowIsRunning(row: TraceRow): boolean { return row.t1Ns == null && row.status === "running"; }
function rowDisplayStatus(row: TraceRow): TraceRow["status"] { return row.t1Ns != null && row.status === "running" ? "ok" : row.status; }
function nsToMs(ns: number): number { return ns / 1_000_000; }

function durationNs(row: TraceRow, now = nowNs()): number | null {
  const start = rowStartedNs(row);
  if (!Number.isFinite(start) || start <= 0) return null;
  const end = rowEndedNs(row, now);
  if (!Number.isFinite(end) || end < start) return null;
  return end - start;
}




type StartedRange = { startedAfterNs?: number; startedBeforeNs?: number; error?: string };
type DurationRange = { minDurationNs?: number; maxDurationNs?: number; error?: string };

function parseAgeDuration(raw: string): number | null {
  const match = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|msec|millisecond|milliseconds|s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days)$/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = match[2];
  if (unit === "ms" || unit === "msec" || unit === "millisecond" || unit === "milliseconds") return value;
  if (unit === "s" || unit === "sec" || unit === "second" || unit === "seconds") return value * 1000;
  if (unit === "m" || unit === "min" || unit === "minute" || unit === "minutes") return value * 60_000;
  if (unit === "h" || unit === "hr" || unit === "hour" || unit === "hours") return value * 60 * 60_000;
  if (unit === "d" || unit === "day" || unit === "days") return value * 24 * 60 * 60_000;
  return null;
}

function parseDurationRange(raw: string): DurationRange {
  const text = raw.trim();
  if (!text || text.toLowerCase() === "any") return {};
  const rangeParts = text.split(/\s*(?:\.\.|—|–|\bto\b)\s*/i).filter(Boolean);
  if (rangeParts.length === 2) {
    const first = parseAgeDuration(rangeParts[0]);
    const second = parseAgeDuration(rangeParts[1]);
    if (first != null && second != null) return { minDurationNs: Math.min(first, second) * 1_000_000, maxDurationNs: Math.max(first, second) * 1_000_000 };
    return { error: "Use a duration range like 100ms..2s, <5s, or >=1m." };
  }
  const comparison = text.match(/^(<=|>=|<|>)\s*(.+)$/);
  const op = comparison?.[1] || ">=";
  const valueText = comparison?.[2] || text;
  const duration = parseAgeDuration(valueText);
  if (duration == null) return { error: "Use a duration like >=100ms, <5s, or 100ms..2s." };
  if (op === "<" || op === "<=") return { maxDurationNs: duration * 1_000_000 };
  return { minDurationNs: duration * 1_000_000 };
}

function parseStartedTime(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric < 10_000_000_000) return numeric * 1_000_000;
    if (numeric < 10_000_000_000_000_000) return numeric * 1_000;
    return numeric;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed * 1_000_000 : null;
}

function parseStartedRange(raw: string, now = Date.now()): StartedRange {
  const text = raw.trim();
  const nowNsValue = now * 1_000_000;
  if (!text || text.toLowerCase() === "any") return {};
  const rangeParts = text.split(/\s*(?:\.\.|—|–|\bto\b)\s*/i).filter(Boolean);
  if (rangeParts.length === 2) {
    const firstAge = parseAgeDuration(rangeParts[0]);
    const secondAge = parseAgeDuration(rangeParts[1]);
    if (firstAge != null && secondAge != null) {
      return { startedAfterNs: nowNsValue - Math.max(firstAge, secondAge) * 1_000_000, startedBeforeNs: nowNsValue - Math.min(firstAge, secondAge) * 1_000_000 };
    }
    const start = parseStartedTime(rangeParts[0]);
    const end = parseStartedTime(rangeParts[1]);
    if (start != null && end != null) return { startedAfterNs: Math.min(start, end), startedBeforeNs: Math.max(start, end) };
    return { error: "Use an age range like 30m..2h or an ISO time range like 2026-01-01T09:00..2026-01-01T10:00." };
  }
  const comparison = text.match(/^(<=|>=|<|>)\s*(.+)$/);
  const op = comparison?.[1] || "<=";
  const valueText = comparison?.[2] || text;
  const ageMs = parseAgeDuration(valueText);
  if (ageMs != null) {
    const boundary = nowNsValue - ageMs * 1_000_000;
    if (op === ">" || op === ">=") return { startedBeforeNs: boundary };
    return { startedAfterNs: boundary };
  }
  const started = parseStartedTime(valueText);
  if (started != null) {
    if (op === ">" || op === ">=") return { startedAfterNs: started };
    return { startedBeforeNs: started };
  }
  return { error: "Use <15m, >2h, 30m..2h, or an ISO time range." };
}

function formatDurationNs(ns: number | null | undefined): string {
  const n = Number(ns ?? NaN);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const us = n / 1_000;
  if (us < 1000) return `${Math.round(us)} µs`;
  const ms = us / 1000;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 3 : ms < 100 ? 2 : 1)} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 3 : sec < 100 ? 2 : 1)} s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${Math.round(sec % 60)}s`;
}

function formatRootDuration(row: TraceRow): string {
  const ns = durationNs(row);
  return ns && ns > 0 ? formatDurationNs(ns) : "";
}

function formatTimeNs(ns: number | null | undefined): string {
  const n = Number(ns ?? NaN);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const wholeMs = Math.floor(n / 1_000_000);
  const microRemainder = Math.floor(n / 1_000) % 1000;
  const iso = new Date(wholeMs).toISOString();
  const base = iso.replace("T", " ").replace("Z", "");
  return `${base}${String(microRemainder).padStart(3, "0")}Z`;
}

function relativeTimeNs(ns: number | null | undefined, now = nowNs()): string {
  const n = Number(ns ?? NaN);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const delta = (now - n) / 1_000_000;
  const abs = Math.abs(delta);
  const suffix = delta >= 0 ? "ago" : "from now";
  if (abs < 1000) return "now";
  if (abs < 60_000) return `${Math.round(abs / 1000)}s ${suffix}`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ${suffix}`;
  return `${Math.round(abs / 86_400_000)}d ${suffix}`;
}

function sortedRows(rows: TraceRow[]): TraceRow[] {
  return [...rows].sort((a, b) => (rowStartedNs(a) - rowStartedNs(b)) || (a.seq - b.seq) || a.id.localeCompare(b.id));
}

function markRows(rows: TraceRow[]): TraceRow[] {
  return sortedRows(rows.filter((row) => row.kind === "mark"));
}

type TraceTimelineBounds = { startNs: number; endNs: number; durationNs: number };

function boundsForRows(rows: TraceRow[], now = nowNs()): TraceTimelineBounds | null {
  let startNs = Infinity;
  let endNs = -Infinity;
  for (const row of rows) {
    const start = rowStartedNs(row);
    if (!Number.isFinite(start) || start <= 0) continue;
    const rawEnd = rowEndedNs(row, now);
    const end = Number.isFinite(rawEnd) && rawEnd >= start ? rawEnd : start;
    startNs = Math.min(startNs, start);
    endNs = Math.max(endNs, end);
  }
  if (!Number.isFinite(startNs) || !Number.isFinite(endNs)) return null;
  const durationNs = Math.max(1, endNs - startNs);
  return { startNs, endNs: startNs + durationNs, durationNs };
}

function boundsForDetail(row: TraceRow, children: TraceRow[], now = nowNs()): TraceTimelineBounds | null {
  return boundsForRows([row, ...children], now);
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function clampNumber(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function storedNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? clampNumber(value, min, max) : fallback;
  } catch {
    return fallback;
  }
}

function storeNumber(key: string, value: number) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // localStorage can be disabled; split persistence is best-effort.
  }
}

function timelineStyle(row: TraceRow, bounds: TraceTimelineBounds | null): JSX.CSSProperties {
  if (!bounds) return { "--trace-left": "0%", "--trace-width": "100%" } as JSX.CSSProperties;
  const start = rowStartedNs(row);
  if (!Number.isFinite(start) || start <= 0) return { "--trace-left": "0%", "--trace-width": "100%" } as JSX.CSSProperties;
  const rawEnd = rowEndedNs(row);
  const end = Number.isFinite(rawEnd) && rawEnd >= start ? rawEnd : start;
  const left = clampPercent(((start - bounds.startNs) / bounds.durationNs) * 100);
  const right = clampPercent(((end - bounds.startNs) / bounds.durationNs) * 100);
  const width = Math.max(0.8, right - left);
  return { "--trace-left": `${left.toFixed(3)}%`, "--trace-width": `${width.toFixed(3)}%` } as JSX.CSSProperties;
}

function eventTimelineStyle(event: TraceRow, bounds: TraceTimelineBounds | null): JSX.CSSProperties {
  if (!bounds) return { "--trace-left": "0%" } as JSX.CSSProperties;
  const left = clampPercent(((rowStartedNs(event) - bounds.startNs) / bounds.durationNs) * 100);
  return { "--trace-left": `${left.toFixed(3)}%` } as JSX.CSSProperties;
}

function markLevel(row: TraceRow): string {
  const data = row.dataJson;
  const raw = data && typeof data === "object" && "level" in data ? (data as { level?: unknown }).level : null;
  return typeof raw === "string" && raw.trim() ? raw : row.status === "error" ? "error" : "mark";
}

function markMessage(row: TraceRow): string {
  const data = row.dataJson;
  const raw = data && typeof data === "object" && "message" in data ? (data as { message?: unknown }).message : null;
  return typeof raw === "string" && raw.trim() ? raw : nodeTitle(row);
}

function eventLevelClass(level: string | null | undefined): string {
  const normalized = String(level || "mark").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  if (normalized === "error" || normalized === "warn" || normalized === "info" || normalized === "debug") return `trace-event-${normalized}`;
  return "trace-event-event";
}

function formatOffsetNs(ns: number | null | undefined, originNs: number | null | undefined): string {
  const n = Number(ns ?? NaN);
  const start = Number(originNs ?? NaN);
  if (!Number.isFinite(n) || !Number.isFinite(start)) return "+—";
  return `+${formatDurationNs(Math.max(0, n - start))}`;
}

type TimelineTick = { left: string; label: string };

function timelineTicks(bounds: TraceTimelineBounds | null, count = 6): TimelineTick[] {
  if (!bounds) return [];
  const safeCount = Math.max(2, Math.floor(count));
  const ticks: TimelineTick[] = [];
  for (let i = 0; i < safeCount; i++) {
    const ratio = safeCount === 1 ? 0 : i / (safeCount - 1);
    const label = i === 0 ? "0 µs" : formatDurationNs(bounds.durationNs * ratio);
    ticks.push({ left: `${(ratio * 100).toFixed(3)}%`, label });
  }
  return ticks;
}

function tickStyle(tick: TimelineTick): JSX.CSSProperties {
  return { "--trace-left": tick.left } as JSX.CSSProperties;
}

function eventMarkerTitle(event: TraceRow, originNs: number | null | undefined): string {
  return `${formatOffsetNs(rowStartedNs(event), originNs)} · ${markLevel(event)} · ${markMessage(event)}`;
}

function TraceTimelineRuler(props: { bounds: TraceTimelineBounds | null; events?: TraceRow[] }) {
  return (
    <div class="trace-devtools-ruler" aria-hidden="true">
      <For each={timelineTicks(props.bounds)}>
        {(tick) => <span class="trace-devtools-tick" style={tickStyle(tick)}><span>{tick.label}</span></span>}
      </For>
      <For each={props.events || []}>
        {(event) => <span class={`trace-devtools-event-dot ${eventLevelClass(markLevel(event))}`} style={eventTimelineStyle(event, props.bounds)} title={eventMarkerTitle(event, props.bounds?.startNs)} />}
      </For>
    </div>
  );
}


function nodeTitle(row: TraceRow | null | undefined): string {
  if (!row) return "—";
  const data = (row.dataJson || {}) as Record<string, unknown>;
  const label = data.label ?? data.title ?? data.chatTitle ?? data.name;
  const value = String(label || row.name || row.id || "trace").trim();
  return value || row.id;
}

function errorCount(row: TraceRow | null | undefined): number {
  const data = (row?.dataJson || {}) as Record<string, unknown>;
  const raw = data.errorCount ?? data.errors ?? data.failures;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : row?.status === "error" ? 1 : 0;
}

function childCount(row: TraceRow | null | undefined): number | null {
  const data = (row?.dataJson || {}) as Record<string, unknown>;
  const raw = data.childCount ?? data.children ?? data.spanCount;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function hjsonHtml(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return highlightAuto(value);
  try {
    return highlightHjsonValue(value, { linkStoreHashes: true });
  } catch {
    return highlightAuto(String(value));
  }
}

function handleStoreHashClick(
  ev: MouseEvent,
  onOpenStore?: (hash: string) => void,
) {
  if (!onOpenStore) return;
  const target = ev.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLElement>("[data-store-hash]");
  const hash = button?.dataset.storeHash;
  if (!hash) return;
  ev.preventDefault();
  ev.stopPropagation();
  onOpenStore(hash);
}

function hjsonText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return maybeFormatHjsonTextForView(value.trim()) ?? value;
  try {
    return formatHjson(value);
  } catch {
    try {
      return JSON.stringify(value, null, 2) || String(value);
    } catch {
      return String(value);
    }
  }
}

function copyText(text: string) {
  if (!text) return;
  void navigator.clipboard?.writeText(text);
}

function traceRootOf(node: TraceRow, ancestors: TraceRow[] = []): TraceRow {
  const explicitRootId = node.rootId && (node.rootId !== node.id || !node.parentId) ? node.rootId : null;
  if (explicitRootId) {
    const match = [...ancestors, node].find((row) => row.id === explicitRootId);
    if (match) return match;
  }
  return ancestors[0] || node;
}

function isCanonicalRoot(row: TraceRow): boolean {
  return !row.parentId && (!row.rootId || row.rootId === row.id);
}

function rootLabel(row: TraceRow): string {
  if (isCanonicalRoot(row)) return ROOT_KINDS.has(row.kind) ? "root" : "root?";
  return row.rootKind ? `in ${row.rootKind} root` : "in root";
}

function rootMeta(row: TraceRow): string {
  const parts = [row.chatId ? `chat ${row.chatId}` : null, row.runId ? `run ${row.runId}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : row.id;
}

function rootTitle(row: TraceRow): string {
  return isCanonicalRoot(row) ? `${nodeTitle(row)} · ${rootLabel(row)}` : `${nodeTitle(row)} · ${rootLabel(row)} ${row.rootName || row.rootId || "ancestor"}`;
}

function compareRowsChronological(a: TraceRow, b: TraceRow): number {
  return (rowStartedNs(a) - rowStartedNs(b)) || (a.seq - b.seq) || a.id.localeCompare(b.id);
}

function compareRowsNewestFirst(a: TraceRow, b: TraceRow): number {
  return (rowStartedNs(b) - rowStartedNs(a)) || (b.seq - a.seq) || b.id.localeCompare(a.id);
}

function mergeRows(existing: TraceRow[], incoming: TraceRow[]): TraceRow[] {
  const byId = new Map<string, TraceRow>();
  for (const row of existing) byId.set(row.id, row);
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort(compareRowsChronological);
}

function mergeRootRowsNewestFirst(existing: TraceRow[], incoming: TraceRow[]): TraceRow[] {
  const byId = new Map<string, TraceRow>();
  for (const row of existing) byId.set(row.id, row);
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort(compareRowsNewestFirst);
}

function crumbText(rows: TraceRow[]): string {
  return rows.map(nodeTitle).join(" › ");
}

function directParent(state: DetailState): TraceRow | null {
  const parentId = state.node.parentId;
  if (!parentId) return null;
  return [...state.ancestors].reverse().find((ancestor) => ancestor.id === parentId) || null;
}

function StatusBadge(props: { status: TraceRow["status"] }) {
  const icon = () => (props.status === "ok" ? "✓" : props.status === "error" ? "!" : "•");
  return <span class={`trace-status-badge trace-status-${props.status}`}>{icon()} {props.status}</span>;
}

function KindBadge(props: { kind: TraceRow["kind"] }) {
  return <span class={`trace-kind-badge trace-kind-${props.kind}`}>{props.kind}</span>;
}

type LoadedTraceObject = { hash: string; kind: string | null; value: unknown; text: string | null; size: number | null };

function parseObjectContent(content: string | undefined): { value: unknown; text: string | null } {
  if (content == null) return { value: null, text: null };
  try {
    return { value: JSON.parse(content), text: null };
  } catch {
    return { value: null, text: content };
  }
}

function loadedTraceObject(hash: string, object: StoreObject): LoadedTraceObject | null {
  if (!object) return null;
  const parsed = parseObjectContent(object.content ?? object.text);
  return { hash, kind: object.kind ?? null, value: parsed.value, text: parsed.text, size: object.size ?? null };
}

function HashBlock(props: { label: string; hash: string | null; object?: StoreObject; onOpenStore?: (hash: string) => void }) {
  const [loaded, setLoaded] = createSignal<LoadedTraceObject | null>(null);
  const onStoreHashClick = (ev: MouseEvent) =>
    handleStoreHashClick(ev, props.onOpenStore);
  const [loadError, setLoadError] = createSignal<string | null>(null);

  createEffect(() => {
    const hash = props.hash;
    setLoaded(null);
    setLoadError(null);
    if (!hash) return;
    if (props.object !== undefined) {
      setLoaded(loadedTraceObject(hash, props.object));
      if (!props.object) setLoadError("object not found");
      return;
    }
    let cancelled = false;
    api.objects.get(hash).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setLoadError(result.error?.message || "object load failed");
        return;
      }
      const object = result.value.object;
      if (!object) return;
      const parsed = parseObjectContent(object.content ?? object.text);
      setLoaded({ hash, kind: object.kind ?? null, value: parsed.value, text: parsed.text, size: object.size ?? null });
    }, (err) => {
      if (!cancelled) setLoadError(errMessage(err));
    });
    onCleanup(() => { cancelled = true; });
  });

  return (
    <DetailSection class="trace-detail-section" title={props.label}>
      <Show when={props.hash} fallback={<EmptyState class="trace-empty">—</EmptyState>}>
        {(hash) => (
          <div>
            <Show when={loaded()} fallback={<pre class="trace-hash-block">{hash()}</pre>}>
              {(object) => <pre class="trace-json-block" onClick={onStoreHashClick} innerHTML={hjsonHtml(object().text ?? object().value)} />}
            </Show>
            <InlineActions class="trace-inline-actions">
              <ActionButton class="trace-small-button" onClick={() => copyText(hash())}>copy hash</ActionButton>
              <ActionButton class="trace-link-button" onClick={() => props.onOpenStore?.(hash())}>open object</ActionButton>
              <Show when={loaded()}>{(object) => <span>{object().kind || "object"}{object().size != null ? ` · ${object().size} bytes` : ""}</span>}</Show>
              <Show when={loadError()}>{(message) => <span class="trace-muted">{message()}</span>}</Show>
            </InlineActions>
          </div>
        )}
      </Show>
    </DetailSection>
  );
}

function DataBlock(props: { label: string; value: unknown; hash?: string | null; onOpenStore?: (hash: string) => void }) {
  const onStoreHashClick = (ev: MouseEvent) =>
    handleStoreHashClick(ev, props.onOpenStore);
  return (
    <DetailSection class="trace-detail-section" title={props.label}>
      <Show when={props.value != null} fallback={<HashBlock label={props.label} hash={props.hash || null} onOpenStore={props.onOpenStore} />}>
        <>
          <pre class="trace-json-block" onClick={onStoreHashClick} innerHTML={hjsonHtml(props.value)} />
          <Show when={props.hash}>
            {(hash) => <InlineActions class="trace-inline-actions"><ActionButton class="trace-small-button" onClick={() => copyText(hash())}>copy hash</ActionButton><ActionButton class="trace-link-button" onClick={() => props.onOpenStore?.(hash())}>open full object</ActionButton></InlineActions>}
          </Show>
        </>
      </Show>
    </DetailSection>
  );
}


export function TraceEventDetails(props: { event: TraceRow; onOpenStore?: (hash: string) => void }) {
  const data = () => props.event.dataJson;
  const onStoreHashClick = (ev: MouseEvent) =>
    handleStoreHashClick(ev, props.onOpenStore);
  const openHash = (hash: string | null | undefined) => {
    if (hash) props.onOpenStore?.(hash);
  };
  return (
    <div class="trace-detail-scroll">
      <div class="trace-detail-title">
        <KindBadge kind={props.event.kind} />
        <h2>{nodeTitle(props.event)}</h2>
        <StatusBadge status={rowDisplayStatus(props.event)} />
      </div>
      <div class="trace-detail-meta">
        <span>{formatDurationNs(durationNs(props.event))}</span>
        <span>{formatTimeNs(rowStartedNs(props.event))}</span>
      </div>
      <Show when={data()}>
        <section class="trace-detail-section">
          <h3>Data</h3>
          <pre class="trace-json-block" onClick={onStoreHashClick} innerHTML={hjsonHtml(data())} />
        </section>
      </Show>
      <section class="trace-detail-section">
        <h3>Hashes</h3>
        <InlineActions class="trace-inline-actions">
          <ActionButton class="trace-link-button" disabled={!props.event.inputHash} onClick={() => openHash(props.event.inputHash)}>input</ActionButton>
          <ActionButton class="trace-link-button" disabled={!props.event.outputHash} onClick={() => openHash(props.event.outputHash)}>output</ActionButton>
          <ActionButton class="trace-link-button" disabled={!props.event.errorHash} onClick={() => openHash(props.event.errorHash)}>error</ActionButton>
        </InlineActions>
      </section>
    </div>
  );
}

export function TracesView(props: { bag: Bag; onToggleSidebar?: () => void; onOpenSidebar?: () => void }) {
  const [activeTab, setActiveTab] = createSignal<TraceTab>("all");
  const [traceRoots, setTraceRoots] = createSignal<TraceRow[]>([]);
  const [rootsState, setRootsState] = createSignal<LoadState>("idle");
  const [rootsCursorNs, setRootsCursorNs] = createSignal<number | null>(null);
  const [rootsCanLoadMore, setRootsCanLoadMore] = createSignal(true);
  const [rootQuery, setRootQuery] = createSignal("");
  const initialTraceId = props.bag.traceId?.() || null;
  const [selectedRootKey, setSelectedRootKey] = createSignal<string | null>(initialTraceId || props.bag.traceChatId?.() || null);
  const [selectedChatId, setSelectedChatId] = createSignal<string | null>(initialTraceId ? null : props.bag.traceChatId?.() || null);
  let syncedSidebarTraceId: string | null = null;
  const [failures, setFailures] = createSignal<SearchHit[]>([]);
  const [failedState, setFailedState] = createSignal<LoadState>("idle");
  const [searchHits, setSearchHits] = createSignal<SearchHit[]>([]);
  const [searchState, setSearchState] = createSignal<LoadState>("idle");
  const [treeState, setTreeState] = createSignal<LoadState>("idle");
  const [detailState, setDetailState] = createSignal<LoadState>("idle");
  const [error, setError] = createSignal<string | null>(null);
  const [nodes, setNodes] = createSignal<TraceRow[]>([]);
  const [rootId, setRootId] = createSignal<string | null>(null);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [loadedBoundary, setLoadedBoundary] = createSignal<Map<string, number>>(new Map());
  const [detail, setDetail] = createSignal<DetailState | null>(null);
  const [kindFilter, setKindFilter] = createSignal<TraceKindFilter>("any");
  const [statusFilter, setStatusFilter] = createSignal<TraceStatusFilter>("any");
  const [scopeFilter, setScopeFilter] = createSignal<TraceScopeFilter>("any");
  const [durationRangeFilter, setDurationRangeFilter] = createSignal("");
  const [ageFilter, setAgeFilter] = createSignal("");
  const [selectorWidth, setSelectorWidth] = createSignal(storedNumber(TRACE_SELECTOR_WIDTH_STORAGE_KEY, TRACE_SELECTOR_DEFAULT_W, TRACE_SELECTOR_MIN_W, TRACE_SELECTOR_MAX_W));
  const [detailSplit, setDetailSplit] = createSignal(storedNumber(TRACE_DETAIL_SPLIT_STORAGE_KEY, TRACE_DETAIL_DEFAULT_SPLIT, TRACE_DETAIL_SPLIT_MIN, 1 - TRACE_DETAIL_SPLIT_MIN));

  const nodeById = createMemo(() => new Map(nodes().map((node) => [node.id, node])));
  const selectedNode = createMemo(() => (selectedId() ? nodeById().get(selectedId()!) || detail()?.node || null : null));
  let rootsFilterReady = false;
  let spanFilterReady = false;
  const timelineBounds = createMemo(() => boundsForRows(nodes()));
  let disposed = false;
  let selectionRequest = 0;
  const nextSelectionRequest = () => ++selectionRequest;
  const isCurrentSelection = (request: number) => !disposed && request === selectionRequest;
  let rootsRequest = 0;
  const nextRootsRequest = () => ++rootsRequest;
  const isCurrentRoots = (request: number) => !disposed && request === rootsRequest;
  let searchRequest = 0;
  const nextSearchRequest = () => ++searchRequest;
  const isCurrentSearch = (request: number) => !disposed && request === searchRequest;
  let failedRequest = 0;
  const nextFailedRequest = () => ++failedRequest;
  const isCurrentFailed = (request: number) => !disposed && request === failedRequest;

  onCleanup(() => {
    disposed = true;
    selectionRequest++;
    rootsRequest++;
    searchRequest++;
    failedRequest++;
  });

  const rootMatchesSelection = (row: TraceRow) => {
    const key = selectedRootKey();
    if (!key) return false;
    return row.id === key || row.rootId === key || (row.kind === "chat" && row.chatId === key);
  };

  const durationRange = () => parseDurationRange(durationRangeFilter());
  const durationMinNs = () => durationRange().minDurationNs;
  const durationMaxNs = () => durationRange().maxDurationNs;
  const durationFilterError = () => durationRange().error;
  const startedRange = () => parseStartedRange(ageFilter());
  const startedAfterNs = () => startedRange().startedAfterNs;
  const startedBeforeNs = () => startedRange().startedBeforeNs;
  const ageFilterError = () => startedRange().error;
  const rowMatchesDurationAndAge = (row: TraceRow) => {
    const minDurationNs = durationMinNs();
    if (minDurationNs != null && (durationNs(row) ?? -1) < minDurationNs) return false;
    const maxDurationNs = durationMaxNs();
    if (maxDurationNs != null && (durationNs(row) ?? Number.POSITIVE_INFINITY) > maxDurationNs) return false;
    const afterNs = startedAfterNs();
    if (afterNs != null && Number(rowStartedNs(row) || 0) < afterNs) return false;
    const beforeNs = startedBeforeNs();
    if (beforeNs != null && Number(rowStartedNs(row) || 0) > beforeNs) return false;
    return true;
  };

  const rowMatchesKindFilter = (row: TraceRow, kind: TraceKindFilter): boolean => {
    if (kind === "any") return true;
    if (kind !== "chat") return row.kind === kind;
    return row.kind === "chat" && !!row.chatId && isCanonicalRoot(row);
  };

  const rowMatchesTraceFilters = (row: TraceRow, opts: { queryText?: string; restrictChatToSelection?: boolean } = {}) => {
    const kind = kindFilter();
    const status = statusFilter();
    const scope = scopeFilter();
    if (!rowMatchesKindFilter(row, kind)) return false;
    if (status !== "any" && rowDisplayStatus(row) !== status) return false;
    if (scope === "chat") {
      if (!row.chatId) return false;
      const chatId = selectedChatId();
      if (opts.restrictChatToSelection && chatId && row.chatId !== chatId) return false;
    }
    if (scope === "global" && row.chatId) return false;
    if (!rowMatchesDurationAndAge(row)) return false;
    const query = opts.queryText ?? rootQuery().trim().toLowerCase();
    if (!query) return true;
    const haystack = [row.id, row.name, row.chatId || "", row.runId || "", nodeTitle(row), hjsonText(row.dataJson)].join(" ").toLowerCase();
    return haystack.includes(query);
  };

  const hitMatchesFilters = (hit: SearchHit, opts: { restrictChatToSelection?: boolean } = {}) => {
    const query = rootQuery().trim().toLowerCase();
    if (!rowMatchesTraceFilters(hit.node, { queryText: "", restrictChatToSelection: opts.restrictChatToSelection })) return false;
    if (!query) return true;
    const chain = [...hit.ancestors, hit.node];
    const haystack = [hit.node.id, hit.node.name, nodeTitle(hit.node), crumbText(chain), hjsonText(hit.node.dataJson)].join(" ").toLowerCase();
    return haystack.includes(query);
  };

  const filteredTraceRoots = createMemo(() => traceRoots().filter((root) => isCanonicalRoot(root) && rowMatchesTraceFilters(root)));
  const filteredFailures = createMemo(() => failures().filter((hit) => hitMatchesFilters(hit)));
  const filteredSearchHits = createMemo(() => searchHits().filter((hit) => hitMatchesFilters(hit, { restrictChatToSelection: true })));

  const selectorState = () => (activeTab() === "search" ? searchState() : activeTab() === "failed" ? failedState() : rootsState());
  const selectorCount = () => (activeTab() === "search" ? filteredSearchHits().length : activeTab() === "failed" ? filteredFailures().length : filteredTraceRoots().length);
  const selectorNoun = () => {
    const tab = activeTab();
    if (tab === "search") return "spans";
    if (tab === "failed") return "failures";
    return "roots";
  };
  const selectorSummary = () => `${selectorCount()} ${selectorNoun()}`;

  async function loadTraceTreeFromRoot(root: TraceRow, maxDepth: number): Promise<TraceTreeLoad> {
    return root.kind === "chat" && root.chatId
      ? await unwrap(api.traces.chatTree({ chatId: root.chatId, maxDepth }), "trace chat tree load")
      : await unwrap(api.traces.subtree({ id: root.id, maxDepth }), "trace tree load");
  }

  const failedChats = createMemo(() => {
    const grouped = new Map<string, { chatId: string; title: string; lastMs: number; count: number }>();
    for (const hit of failures()) {
      const chat = [...hit.ancestors, hit.node].find((row) => row.kind === "chat" || row.chatId === row.id);
      const chatId = hit.node.chatId || chat?.id || "unknown";
      const prev = grouped.get(chatId);
      const lastMs = rowEndedNs(hit.node) || rowStartedNs(hit.node) || 0;
      if (prev) {
        prev.count += 1;
        prev.lastMs = Math.max(prev.lastMs, lastMs);
      } else {
        grouped.set(chatId, { chatId, title: chat ? nodeTitle(chat) : chatId, lastMs, count: 1 });
      }
    }
    return [...grouped.values()].sort((a, b) => b.lastMs - a.lastMs).slice(0, TRACE_PAGE_LIMIT);
  });

  const treeRows = createMemo<TreeRow[]>(() => {
    const byParent = new Map<string | null, TraceRow[]>();
    const virtualByParent = new Map<string, TraceRow[]>();
    const allNodes = nodes();
    const ids = new Set(allNodes.map((node) => node.id));
    for (const node of allNodes) {
      const parent = node.parentId && ids.has(node.parentId) ? node.parentId : node.parentId ? undefined : null;
      if (parent !== undefined) {
        const list = byParent.get(parent) || [];
        list.push(node);
        byParent.set(parent, list);
      }
      if (node.invokedFromStepId && ids.has(node.invokedFromStepId) && node.parentId !== node.invokedFromStepId) {
        const virtual = virtualByParent.get(node.invokedFromStepId) || [];
        virtual.push(node);
        virtualByParent.set(node.invokedFromStepId, virtual);
      }
    }
    for (const list of byParent.values()) list.sort((a, b) => (rowStartedNs(a) - rowStartedNs(b)) || (a.seq - b.seq));
    for (const list of virtualByParent.values()) list.sort((a, b) => (rowStartedNs(a) - rowStartedNs(b)) || (a.seq - b.seq));
    const preferredRootId = rootId();
    const preferredRoot = preferredRootId ? nodeById().get(preferredRootId) : null;
    const roots = preferredRoot ? [preferredRoot] : (byParent.get(null) || []).filter(isCanonicalRoot);
    const rows: TreeRow[] = [];
    const seen = new Set<string>();
    const visit = (node: TraceRow, depth: number, ghost = false, parentId: string | null = node.parentId) => {
      const key = `${ghost ? "ghost:" : ""}${node.id}:${parentId || "root"}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ node, depth, ghost, parentId });
      if (!expanded().has(node.id)) return;
      for (const child of byParent.get(node.id) || []) visit(child, depth + 1, false, node.id);
      for (const child of virtualByParent.get(node.id) || []) visit(child, depth + 1, true, node.id);
    };
    for (const root of roots) visit(root, 0, false, null);
    return rows;
  });

  async function loadTraceRoots(opts: { more?: boolean } = {}) {
    const request = nextRootsRequest();
    if (ageFilterError() || durationFilterError()) {
      setRootsState("idle");
      return;
    }
    setRootsState("loading");
    setError(null);
    try {
      const query = rootQuery().trim() || undefined;
      const rootArgs: TraceSearchArgs = { limit: TRACE_PAGE_LIMIT, beforeNs: opts.more ? rootsCursorNs() || undefined : undefined, query };
      const minDurationNs = durationMinNs();
      const kind = kindFilter();
      const status = statusFilter();
      const scope = scopeFilter();
      const maxDurationNs = durationMaxNs();
      const afterNs = startedAfterNs();
      if (minDurationNs != null) rootArgs.minDurationNs = minDurationNs;
      if (maxDurationNs != null) rootArgs.maxDurationNs = maxDurationNs;
      if (kind !== "any") rootArgs.kind = kind;
      if (status !== "any") rootArgs.status = status;
      if (scope !== "any") rootArgs.scope = scope;
      if (afterNs != null) rootArgs.startedAfterNs = afterNs;
      const beforeNs = startedBeforeNs();
      if (beforeNs != null) rootArgs.startedBeforeNs = beforeNs;
      const value = await unwrap(api.traces.roots(rootArgs), "trace roots load");
      if (!isCurrentRoots(request)) return;
      const next = opts.more ? mergeRootRowsNewestFirst(traceRoots(), value.roots) : [...value.roots].sort(compareRowsNewestFirst);
      setTraceRoots(next);
      setRootsCanLoadMore(value.roots.length >= TRACE_PAGE_LIMIT);
      const oldest = next.reduce<number | null>((min, row) => {
        const t = rowStartedNs(row) || 0;
        return t > 0 && (min == null || t < min) ? t : min;
      }, null);
      setRootsCursorNs(oldest);
      if (!selectedRootKey() && next[0]) void selectTraceRoot(next[0]);
      setRootsState("idle");
    } catch (err) {
      if (!isCurrentRoots(request)) return;
      setRootsState("error");
      setError(errMessage(err));
    }
  }

  async function selectTraceRoot(root: TraceRow, opts: SelectTraceRootOptions = {}) {
    const request = opts.request ?? nextSelectionRequest();
    if (!isCurrentSelection(request)) return;
    setSelectedRootKey(root.id);
    setSelectedChatId(root.chatId);
    if (!opts.preserveUrl) {
      if (root.kind === "chat" && root.chatId) {
        props.bag.showTraces?.(root.chatId);
      } else {
        props.bag.showTrace?.(root.id);
      }
    }
    if (!opts.preserveTab) setActiveTab("all");
    setTreeState("loading");
    setError(null);
    try {
      const value = await loadTraceTreeFromRoot(root, DEFAULT_TREE_DEPTH);
      if (!isCurrentSelection(request)) return;
      const canonicalRoot = value.root || value.nodes.find(isCanonicalRoot) || value.nodes[0] || root;
      if (canonicalRoot.id !== root.id) {
        setSelectedRootKey(canonicalRoot.id);
        setSelectedChatId(canonicalRoot.chatId);
        if (!opts.preserveUrl) {
          if (canonicalRoot.kind === "chat" && canonicalRoot.chatId) props.bag.showTraces?.(canonicalRoot.chatId);
          else props.bag.showTrace?.(canonicalRoot.id);
        }
      }
      setNodes(value.nodes);
      setRootId(canonicalRoot.id);
      const baseDepth = canonicalRoot.depth || value.nodes[0]?.depth || 0;
      const pathIds = new Set(opts.expandIds || []);
      const open = new Set<string>();
      for (const node of value.nodes) if (node.depth - baseDepth < DEFAULT_TREE_OPEN_DEPTH) open.add(node.id);
      for (const id of pathIds) open.add(id);
      setExpanded(open);
      setLoadedBoundary(new Map(value.nodes.filter((node) => node.depth - baseDepth >= DEFAULT_TREE_DEPTH - 1).map((node) => [node.id, DEFAULT_TREE_DEPTH])));
      const first = opts.focusId || canonicalRoot.id;
      setSelectedId(first);
      if (first) void loadDetail(first, { request });
      if (opts.focusId) scrollTraceRowIntoView(opts.focusId);
      setTreeState("idle");
    } catch (err) {
      if (!isCurrentSelection(request)) return;
      setTreeState("error");
      setError(errMessage(err));
    }
  }

  async function selectChat(chatId: string) {
    const request = nextSelectionRequest();
    const known = traceRoots().find((row) => row.kind === "chat" && (row.chatId === chatId || row.id === chatId));
    if (known) return selectTraceRoot(known, { request });
    setSelectedRootKey(chatId);
    setSelectedChatId(chatId);
    setActiveTab("all");
    setTreeState("loading");
    setError(null);
    try {
      const value = await unwrap(api.traces.chatTree({ chatId, maxDepth: DEFAULT_TREE_DEPTH }), "trace chat tree load");
      if (!isCurrentSelection(request)) return;
      const canonicalRoot = value.root || value.nodes.find(isCanonicalRoot) || value.nodes[0] || null;
      if (!canonicalRoot) {
        setTreeState("idle");
        return;
      }
      setSelectedRootKey(canonicalRoot.id);
      setSelectedChatId(canonicalRoot.chatId || chatId);
      setNodes(value.nodes);
      setRootId(canonicalRoot.id);
      const baseDepth = canonicalRoot.depth || value.nodes[0]?.depth || 0;
      const open = new Set<string>();
      for (const node of value.nodes) if (node.depth - baseDepth < DEFAULT_TREE_OPEN_DEPTH) open.add(node.id);
      setExpanded(open);
      setLoadedBoundary(new Map(value.nodes.filter((node) => node.depth - baseDepth >= DEFAULT_TREE_DEPTH - 1).map((node) => [node.id, DEFAULT_TREE_DEPTH])));
      setSelectedId(canonicalRoot.id);
      void loadDetail(canonicalRoot.id, { request });
      setTreeState("idle");
    } catch (err) {
      if (!isCurrentSelection(request)) return;
      setTreeState("error");
      setError(errMessage(err));
    }
  }

  async function selectTraceId(id: string) {
    const request = nextSelectionRequest();
    const known = traceRoots().find((row) => row.id === id);
    if (known) return selectTraceRoot(known, { request });
    setSelectedRootKey(id);
    setSelectedChatId(null);
    setActiveTab("all");
    setTreeState("loading");
    setDetailState("loading");
    setError(null);
    try {
      const value = await unwrap(api.traces.node({ id }), "trace span lookup");
      if (!isCurrentSelection(request)) return;
      setDetail(value);
      const chain = [...value.ancestors, value.node];
      const root = value.root || traceRootOf(value.node, value.ancestors);
      const rootIndex = chain.findIndex((row) => row.id === root.id);
      const expandIds = (rootIndex >= 0 ? chain.slice(rootIndex, -1) : chain.slice(0, -1)).map((row) => row.id);
      await selectTraceRoot(root, { request, focusId: value.node.id, expandIds, preserveUrl: true });
    } catch (err) {
      if (!isCurrentSelection(request)) return;
      setTreeState("error");
      setDetailState("error");
      setError(errMessage(err));
    }
  }

  async function loadFailures(chatId?: string) {
    if (ageFilterError() || durationFilterError()) return;
    const request = nextFailedRequest();
    setFailedState("loading");
    setError(null);
    try {
      const args: TraceSearchArgs = { chatId, limit: 200 };
      const minDurationNs = durationMinNs();
      const maxDurationNs = durationMaxNs();
      const afterNs = startedAfterNs();
      if (minDurationNs != null) args.minDurationNs = minDurationNs;
      if (maxDurationNs != null) args.maxDurationNs = maxDurationNs;
      if (afterNs != null) args.startedAfterNs = afterNs;
      const beforeNs = startedBeforeNs();
      if (beforeNs != null) args.startedBeforeNs = beforeNs;
      const value = await unwrap(api.traces.failed(args), "trace failed load");
      if (!isCurrentFailed(request)) return;
      setFailures(value.failures);
      setFailedState("idle");
    } catch (err) {
      if (!isCurrentFailed(request)) return;
      setFailedState("error");
      setError(errMessage(err));
    }
  }

  async function runSearch() {
    if (ageFilterError() || durationFilterError()) return;
    const request = nextSearchRequest();
    setSearchState("loading");
    setError(null);
    try {
      const args: TraceSearchArgs = { limit: 100 };
      if (kindFilter() !== "any") args.kind = kindFilter();
      if (statusFilter() !== "any") args.status = statusFilter();
      if (scopeFilter() === "chat" && selectedChatId()) args.chatId = selectedChatId()!;
      if (scopeFilter() !== "any") args.scope = scopeFilter();
      if (rootQuery().trim()) args.query = rootQuery().trim();
      const minDurationNs = durationMinNs();
      const maxDurationNs = durationMaxNs();
      const afterNs = startedAfterNs();
      if (minDurationNs != null) args.minDurationNs = minDurationNs;
      if (maxDurationNs != null) args.maxDurationNs = maxDurationNs;
      if (afterNs != null) args.startedAfterNs = afterNs;
      const beforeNs = startedBeforeNs();
      if (beforeNs != null) args.startedBeforeNs = beforeNs;
      const value = await unwrap(api.traces.search(args), "trace search load");
      if (!isCurrentSearch(request)) return;
      setSearchHits(value.hits);
      setSearchState("idle");
    } catch (err) {
      if (!isCurrentSearch(request)) return;
      setSearchState("error");
      setError(errMessage(err));
    }
  }

  async function loadSubtree(id: string, opts: { focus?: string; append?: boolean; request?: number } = {}) {
    const request = opts.request;
    if (request != null && !isCurrentSelection(request)) return;
    setTreeState("loading");
    setError(null);
    try {
      const value = await unwrap(api.traces.subtree({ id, maxDepth: SUBTREE_DEPTH }), "trace subtree load");
      if (request != null && !isCurrentSelection(request)) return;
      setNodes(opts.append ? mergeRows(nodes(), value.nodes) : value.nodes);
      const focus = opts.focus || id;
      const focusNode = value.nodes.find((node) => node.id === focus) || value.nodes.find((node) => node.id === id) || value.nodes[0];
      const chatId = focusNode?.chatId || null;
      setSelectedChatId(chatId);
      setRootId(opts.append ? rootId() : value.nodes[0]?.id || id);
      if (!opts.append) setSelectedRootKey(id);
      setExpanded((prev) => {
        const next = new Set(prev);
        next.add(id);
        for (const node of value.nodes) if (node.depth < (value.nodes[0]?.depth || 0) + SUBTREE_DEPTH - 1) next.add(node.id);
        return next;
      });
      setLoadedBoundary((prev) => {
        const next = new Map(prev);
        next.set(id, SUBTREE_DEPTH);
        return next;
      });
      setSelectedId(focus);
      void loadDetail(focus, { request });
      setTreeState("idle");
    } catch (err) {
      if (request != null && !isCurrentSelection(request)) return;
      setTreeState("error");
      setError(errMessage(err));
    }
  }

  async function focusHit(hit: SearchHit) {
    const request = nextSelectionRequest();
    revealHitInTree(hit);
    const chain = [...hit.ancestors, hit.node];
    const root = hit.root || traceRootOf(hit.node, hit.ancestors);
    const rootIndex = chain.findIndex((row) => row.id === root.id);
    const expandIds = (rootIndex >= 0 ? chain.slice(rootIndex, -1) : chain.slice(0, -1)).map((row) => row.id);
    await selectTraceRoot(root, { request, focusId: hit.node.id, expandIds, preserveTab: true });
    if (!isCurrentSelection(request)) return;
    scrollTraceRowIntoView(hit.node.id);
  }

  function revealHitInTree(hit: SearchHit) {
    const chain = [...hit.ancestors, hit.node];
    const root = hit.root || traceRootOf(hit.node, hit.ancestors);
    const existingRoot = rootId();
    const keepCurrentTree = !!existingRoot && existingRoot === root.id;
    const nextNodes = keepCurrentTree ? mergeRows(nodes(), chain) : mergeRows([], chain);
    const nextChatId = hit.node.chatId || root.chatId || null;
    const nextIds = new Set(nextNodes.map((node) => node.id));

    setNodes(nextNodes);
    setRootId(root.id);
    setSelectedRootKey(root.id);
    setSelectedChatId(nextChatId);
    if (root.kind === "chat" && nextChatId) {
      props.bag.showTraces?.(nextChatId);
    } else if (props.bag.traceChatId?.()) {
      props.bag.showTraces?.(null);
    }
    setSelectedId(hit.node.id);
    setExpanded((prev) => {
      const next = keepCurrentTree ? new Set(prev) : new Set<string>();
      for (const ancestor of hit.ancestors) {
        if (nextIds.has(ancestor.id)) next.add(ancestor.id);
      }
      const parentId = hit.node.parentId;
      if (parentId && nextIds.has(parentId)) next.add(parentId);
      return next;
    });
    scrollTraceRowIntoView(hit.node.id);
  }

  async function loadDetail(id: string, opts: { request?: number } = {}) {
    const request = opts.request;
    if (request != null && !isCurrentSelection(request)) return;
    setSelectedId(id);
    setDetailState("loading");
    try {
      const value = await unwrap(api.traces.node({ id }), "trace node load");
      if (request != null && !isCurrentSelection(request)) return;
      setDetail(value);
      const bestRoot = value.root || traceRootOf(value.node, value.ancestors);
      const currentRootId = rootId();
      if (bestRoot.id !== currentRootId && (value.node.id !== currentRootId || value.ancestors.length > 0)) {
        const chain = [...value.ancestors, value.node];
        const rootIndex = chain.findIndex((row) => row.id === bestRoot.id);
        const expandIds = (rootIndex >= 0 ? chain.slice(rootIndex, -1) : chain.slice(0, -1)).map((row) => row.id);
        await selectTraceRoot(bestRoot, { request, focusId: value.node.id, expandIds, preserveTab: true });
        if (!isCurrentSelection(request ?? selectionRequest)) return;
      } else {
        revealDetailInTree(value);
      }
      setDetailState("idle");
    } catch (err) {
      if (request != null && !isCurrentSelection(request)) return;
      setDetailState("error");
      setError(errMessage(err));
    }
  }

  function revealDetailInTree(value: DetailState) {
    const visible = new Set(nodes().map((node) => node.id));
    const missing = [value.node, ...value.ancestors].filter((node) => node && !visible.has(node.id));
    const updated = [value.node, ...value.children, ...value.ancestors];
    const nextNodes = mergeRows(nodes(), updated);
    const nextIds = new Set(nextNodes.map((node) => node.id));
    const loadedAncestors = value.ancestors.filter((ancestor) => nextIds.has(ancestor.id));

    setNodes(nextNodes);
    const bestRoot = value.root || traceRootOf(value.node, loadedAncestors);
    const currentRootId = rootId();
    const currentRootIsFocusedNode = !currentRootId || currentRootId === value.node.id;
    const currentRootIsBestRoot = !!currentRootId && currentRootId === bestRoot.id;
    if (bestRoot && (currentRootIsFocusedNode || !currentRootIsBestRoot)) {
      setRootId(bestRoot.id);
    }
    if (!selectedRootKey()) setSelectedRootKey(bestRoot.id);
    if (!selectedChatId() && value.node.chatId) setSelectedChatId(value.node.chatId);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const ancestor of loadedAncestors) next.add(ancestor.id);
      const parentId = value.node.parentId;
      if (parentId && nextIds.has(parentId)) next.add(parentId);
      return next;
    });

    scrollTraceRowIntoView(value.node.id);
  }

  function scrollTraceRowIntoView(id: string) {
    window.requestAnimationFrame(() => {
      const escapedId = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      document.querySelector<HTMLElement>(`.trace-tree-row[data-trace-id="${escapedId}"]`)?.scrollIntoView({ block: "nearest" });
    });
  }

  function preserveTimelineScroll<T>(fn: () => T): T {
    const scroller = document.querySelector<HTMLElement>(".trace-tree-list");
    const scrollTop = scroller?.scrollTop ?? 0;
    const scrollLeft = scroller?.scrollLeft ?? 0;
    const result = fn();
    if (scroller) {
      window.requestAnimationFrame(() => {
        scroller.scrollTop = scrollTop;
        scroller.scrollLeft = scrollLeft;
      });
    }
    return result;
  }

  function toggleExpanded(id: string) {
    preserveTimelineScroll(() => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    });
  }

  function shouldOfferLoadMore(row: TraceRow): boolean {
    const directChildren = nodes().filter((node) => node.parentId === row.id).length;
    const count = childCount(row);
    if (count != null) return count > directChildren;
    return row.depth >= DEFAULT_TREE_DEPTH - 1 && !loadedBoundary().has(row.id);
  }

  function installColumnResizer(handle: HTMLDivElement) {
    let dragging = false;
    let startX = 0;
    let startW = 0;
    let maxW = TRACE_SELECTOR_MAX_W;

    const onMove = (event: MouseEvent) => {
      if (!dragging) return;
      setSelectorWidth(clampNumber(startW + event.clientX - startX, TRACE_SELECTOR_MIN_W, maxW));
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    const onDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const workbench = handle.closest(".trace-workbench") as HTMLElement | null;
      const selector = workbench?.querySelector(".trace-selector-pane") as HTMLElement | null;
      const workbenchW = workbench?.getBoundingClientRect().width || document.documentElement.clientWidth || window.innerWidth || 0;
      startW = selector?.getBoundingClientRect().width ?? selectorWidth();
      maxW = Math.max(TRACE_SELECTOR_MIN_W, Math.min(TRACE_SELECTOR_MAX_W, workbenchW - 360));
      startX = event.clientX;
      dragging = true;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      event.preventDefault();
    };
    const onDoubleClick = () => setSelectorWidth(TRACE_SELECTOR_DEFAULT_W);

    handle.addEventListener("mousedown", onDown);
    handle.addEventListener("dblclick", onDoubleClick);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    onCleanup(() => {
      handle.removeEventListener("mousedown", onDown);
      handle.removeEventListener("dblclick", onDoubleClick);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    });
  }

  function installRowResizer(handle: HTMLDivElement) {
    let dragging = false;
    let startY = 0;
    let startH = 0;
    let availableH = TRACE_DETAIL_MIN_H + TRACE_TIMELINE_MIN_H;
    let maxH = TRACE_DETAIL_MIN_H;

    const onMove = (event: MouseEvent) => {
      if (!dragging) return;
      setDetailSplit(clampNumber(startH + startY - event.clientY, TRACE_DETAIL_MIN_H, maxH) / availableH);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    const onDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const workbench = handle.closest(".trace-workbench") as HTMLElement | null;
      const detail = workbench?.querySelector(".trace-detail-panel") as HTMLElement | null;
      const workbenchH = workbench?.getBoundingClientRect().height || window.innerHeight || TRACE_DETAIL_MIN_H + TRACE_TIMELINE_MIN_H;
      availableH = Math.max(1, workbenchH - 1);
      startH = detail?.getBoundingClientRect().height ?? (availableH * detailSplit());
      maxH = Math.max(TRACE_DETAIL_MIN_H, availableH - TRACE_TIMELINE_MIN_H);
      startY = event.clientY;
      dragging = true;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";
      event.preventDefault();
    };
    const onDoubleClick = () => setDetailSplit(TRACE_DETAIL_DEFAULT_SPLIT);

    handle.addEventListener("mousedown", onDown);
    handle.addEventListener("dblclick", onDoubleClick);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    onCleanup(() => {
      handle.removeEventListener("mousedown", onDown);
      handle.removeEventListener("dblclick", onDoubleClick);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    });
  }

  function maybeLoadOlderTraceRoots() {
    const scroller = document.querySelector<HTMLElement>(".trace-selector-results");
    if (!scroller || activeTab() !== "all" || rootsState() === "loading" || !rootsCanLoadMore()) return;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 96) void loadTraceRoots({ more: true });
  }

  function installTraceSelectorAutoLoad(el: HTMLDivElement) {
    const onScroll = () => maybeLoadOlderTraceRoots();
    el.addEventListener("scroll", onScroll, { passive: true });
    onCleanup(() => el.removeEventListener("scroll", onScroll));
  }

  function chooseTraceView(next: TraceTab) {
    setActiveTab(next);
    if (next === "failed") void loadFailures();
    if (next === "search") void runSearch();
  }


  function renderTreeRow(row: TreeRow): JSX.Element {
    const kids = nodes().some((node) => node.parentId === row.node.id || node.invokedFromStepId === row.node.id);
    const selected = () => selectedId() === row.node.id;
    const rowBounds = () => timelineBounds();
    const events = () => (((row.node.dataJson || {}) as Record<string, unknown>).eventCount as number) || 0;
    const rowDuration = () => formatDurationNs(durationNs(row.node));
    return (
      <>
        <button
          type="button"
          class="trace-tree-row"
          classList={{ selected: selected(), ghost: row.ghost }}
          data-trace-id={row.node.id}
          style={{ "--trace-indent": `${row.depth * 1.05}rem`, ...timelineStyle(row.node, rowBounds()) }}
          onClick={() => loadDetail(row.node.id)}
        >
          <span class="trace-tree-cell">
            <span
              class="trace-expander"
              onClick={(event) => {
                event.stopPropagation();
                toggleExpanded(row.node.id);
              }}
            >
              {kids || shouldOfferLoadMore(row.node) ? (expanded().has(row.node.id) ? "▾" : "▸") : ""}
            </span>
            <span class="trace-tree-branch" />
            <span class="trace-row-main">
              <span class="trace-row-title"><KindBadge kind={row.node.kind} /><span>{nodeTitle(row.node)}</span><Show when={isCanonicalRoot(row.node)}><span class="trace-row-note trace-root-note">root</span></Show><Show when={events()}>{(n) => <span class="trace-row-note">{n()} ev</span>}</Show><Show when={row.node.invokedFromStepId}><span class="trace-row-note">↩</span></Show></span>
            </span>
          </span>
          <span class="trace-row-timeline" title={`${formatTimeNs(rowStartedNs(row.node))} → ${rowIsRunning(row.node) ? "running" : formatTimeNs(rowEndedNs(row.node))}`}>
            <span class="trace-row-axis" />
            <span class={`trace-row-bar trace-kind-${row.node.kind}`} classList={{ error: rowDisplayStatus(row.node) === "error", running: rowIsRunning(row.node) }} />
            <Show when={errorCount(row.node) > 0}><span class="trace-row-marker error" /></Show>
          </span>
          <span class="trace-row-right">
            <span class="trace-row-duration">{rowDuration()}</span>
            <StatusBadge status={rowDisplayStatus(row.node)} />
          </span>
        </button>
        <Show when={expanded().has(row.node.id) && shouldOfferLoadMore(row.node)}>
          <ActionButton class="trace-small-button trace-load-more" style={{ "--trace-indent": `${(row.depth + 1) * 1.05}rem` }} disabled={treeState() === "loading"} onClick={() => loadSubtree(row.node.id, { append: true })}>
            <Show when={treeState() === "loading"} fallback={"… load more"}>loading <LoadingDots class="trace-loading-dots" label="loading subtree" /></Show>
          </ActionButton>
        </Show>
      </>
    );
  }

  async function refreshActiveRunningTrace() {
    const root = rootId();
    if (!root || !nodes().some(rowIsRunning)) return;
    const request = selectionRequest;
    try {
      const value = await unwrap(api.traces.subtree({ id: root, maxDepth: SUBTREE_DEPTH }), "trace subtree refresh");
      if (!isCurrentSelection(request)) return;
      preserveTimelineScroll(() => {
        setNodes(mergeRows(nodes(), value.nodes));
      });
      const selected = selectedId();
      if (!selected || !value.nodes.some((node) => node.id === selected)) return;
      const detailValue = await unwrap(api.traces.node({ id: selected }), "trace node refresh");
      if (!isCurrentSelection(request)) return;
      setDetail(detailValue);
    } catch {
      // Background refresh should not replace the visible trace with an error state.
    }
  }

  createEffect(() => {
    const root = rootId();
    const hasRunningRows = nodes().some(rowIsRunning);
    if (!root || !hasRunningRows) return;
    const timer = window.setInterval(() => { void refreshActiveRunningTrace(); }, 2_000);
    onCleanup(() => window.clearInterval(timer));
  });

  createEffect(() => {
    storeNumber(TRACE_SELECTOR_WIDTH_STORAGE_KEY, selectorWidth());
  });

  createEffect(() => {
    storeNumber(TRACE_DETAIL_SPLIT_STORAGE_KEY, detailSplit());
  });

  onMount(() => {
    void loadTraceRoots();
    void loadFailures();
    const initial = props.bag.traceChatId?.();
    const initialTrace = props.bag.traceId?.();
    if (initial) void selectChat(initial);
    else if (initialTrace) void selectTraceId(initialTrace);
  });

  createEffect(() => {
    rootQuery();
    if (!rootsFilterReady) {
      rootsFilterReady = true;
      return;
    }
    const timer = window.setTimeout(() => { if (activeTab() === "search") void runSearch(); else if (activeTab() === "all") void loadTraceRoots(); }, 200);
    onCleanup(() => window.clearTimeout(timer));
  });


  createEffect(() => {
    const tab = activeTab();
    kindFilter();
    statusFilter();
    scopeFilter();
    durationRangeFilter();
    durationFilterError();
    ageFilter();
    ageFilterError();
    if (tab === "all") {
      const timer = window.setTimeout(() => { void loadTraceRoots(); }, 150);
      onCleanup(() => window.clearTimeout(timer));
      return;
    }
    if (tab === "failed") {
      const timer = window.setTimeout(() => { void loadFailures(); }, 150);
      onCleanup(() => window.clearTimeout(timer));
      return;
    }
    if (!spanFilterReady) {
      spanFilterReady = true;
      return;
    }
    const timer = window.setTimeout(() => { void runSearch(); }, 150);
    onCleanup(() => window.clearTimeout(timer));
  });

  createEffect(() => {
    const chatId = props.bag.traceChatId?.() || null;
    const id = props.bag.traceId?.() || null;
    if (chatId) {
      if (untrack(() => chatId === selectedChatId() && !id)) return;
      void selectChat(chatId);
    } else if (id && untrack(() => id !== selectedRootKey() && id !== selectedId())) {
      void selectTraceId(id);
    }
  });

  createEffect(() => {
    const tab = props.bag.activeRightSidebarTab?.();
    if (props.bag.traceId?.() || props.bag.traceChatId?.()) return;
    if (!tab || tab.kind !== "trace") return;
    const trace = tab.trace;
    if (!trace?.id || trace.id === syncedSidebarTraceId) return;
    const request = nextSelectionRequest();
    syncedSidebarTraceId = trace.id;
    void (async () => {
      try {
        const value = await unwrap(api.traces.node({ id: trace.id }), "trace sidebar trace load");
        if (!isCurrentSelection(request)) return;
        const chain = [...value.ancestors, value.node];
        const root = value.root || traceRootOf(value.node, value.ancestors);
        const rootIndex = chain.findIndex((row) => row.id === root.id);
        const expandIds = (rootIndex >= 0 ? chain.slice(rootIndex, -1) : chain.slice(0, -1)).map((row) => row.id);
        await selectTraceRoot(root, { request, focusId: value.node.id, expandIds, preserveTab: true });
      } catch (err) {
        if (!isCurrentSelection(request)) return;
        setError(errMessage(err));
      }
    })();
  });

  return (
    <div class="chat-shell traces-view trace-hierarchical">
      <section class="main trace-hierarchical-shell">
        <PageHeader
          bag={props.bag}
          title="Traces"
          onToggleSidebar={props.onToggleSidebar}
          navigation={<BackToChatButton bag={props.bag} />}
          actions={
            <HeaderIconButton title="refresh traces" aria-label="refresh traces" onClick={() => {
              void loadTraceRoots();
              void loadFailures(selectedChatId() || undefined);
              const current = traceRoots().find((row) => rootMatchesSelection(row));
              if (current) void selectTraceRoot(current);
            }}><RefreshIcon /></HeaderIconButton>
          }
          showRightSidebarToggle
        />
        <Show when={error()}>{(message) => <Notice tone="error" class="trace-error">{message()}</Notice>}</Show>
        <div class="trace-workbench" style={{ "--trace-selector-w": `${selectorWidth()}px`, "--trace-timeline-fr": `${1 - detailSplit()}fr`, "--trace-detail-fr": `${detailSplit()}fr` } as JSX.CSSProperties}>
          <aside class="trace-pane trace-selector-pane" aria-label="trace selector">
            <div class="trace-selector-head">
              <div>
                <span class="trace-eyebrow">Traces</span>
                <strong class="trace-loading-label"><span>{selectorSummary()}</span><Show when={selectorState() === "loading"}><LoadingDots class="trace-loading-dots" label="loading trace results" /></Show></strong>
              </div>
              <ActionButton class="trace-small-button" aria-label="refresh trace results" title="refresh trace results" onClick={() => activeTab() === "search" ? runSearch() : activeTab() === "failed" ? loadFailures() : loadTraceRoots()}><RefreshIcon /></ActionButton>
            </div>
            <form class="trace-direct-filter" onSubmit={(event) => { event.preventDefault(); activeTab() === "search" ? void runSearch() : activeTab() === "failed" ? void loadFailures() : void loadTraceRoots(); }}>
              <div class="trace-filter-primary">
                <label class="trace-filter-query"><span>Text</span><input aria-label="filter traces" placeholder="filter traces…" value={rootQuery()} onInput={(event) => setRootQuery(event.currentTarget.value)} /></label>
                <label><span>List</span><select aria-label="trace result view" value={activeTab()} onChange={(event) => chooseTraceView(event.currentTarget.value as TraceTab)}><option value="all">roots</option><option value="failed">failed</option><option value="search">spans</option></select></label>
              </div>
              <details class="trace-filter-advanced">
                <summary>More filters</summary>
                <div class="trace-filter-grid">
                  <label><span>Kind</span><select aria-label="trace kind filter" value={kindFilter()} onChange={(event) => setKindFilter(event.currentTarget.value as TraceKindFilter)}><For each={KIND_FILTERS}>{(kind) => <option value={kind}>{kind}</option>}</For></select></label>
                  <label><span>Status</span><select aria-label="trace status filter" value={statusFilter()} onChange={(event) => setStatusFilter(event.currentTarget.value as TraceStatusFilter)}><For each={STATUS_FILTERS}>{(status) => <option value={status}>{status}</option>}</For></select></label>
                  <label><span>Scope</span><select aria-label="trace scope" value={scopeFilter()} onChange={(event) => setScopeFilter(event.currentTarget.value as TraceScopeFilter)}><option value="any">all</option><option value="chat">chat</option><option value="global">global</option></select></label>
                  <label><span>Duration range</span><input aria-label="trace duration range filter" placeholder=">=100ms, <5s, 100ms..2s" value={durationRangeFilter()} onInput={(event) => setDurationRangeFilter(event.currentTarget.value)} /></label>
                  <label class="trace-filter-age"><span>Age/time</span><input aria-label="trace age filter" placeholder="<15m, >2h, 30m..2h, ISO..ISO" value={ageFilter()} onInput={(event) => setAgeFilter(event.currentTarget.value)} /></label>
                </div>
              </details>
            </form>
            <Show when={durationFilterError()}>{(message) => <Notice tone="error" class="trace-filter-error">{message()}</Notice>}</Show>
            <Show when={ageFilterError()}>{(message) => <Notice tone="error" class="trace-filter-error">{message()}</Notice>}</Show>
            <div class="trace-selector-results" ref={installTraceSelectorAutoLoad}>
              <Show when={activeTab() === "all"}>
                <For each={filteredTraceRoots()} fallback={<Show when={rootsState() === "loading"} fallback={<EmptyState class="trace-empty">No traces found.</EmptyState>}><BareTraceLoading label="loading traces" /></Show>}>
                  {(root) => (
                    <button type="button" class="trace-root-row" classList={{ selected: rootMatchesSelection(root) }} onClick={() => selectTraceRoot(root)}>
                      <div class="trace-root-title" title={rootTitle(root)}>
                        <KindBadge kind={root.kind} />
                        <span class="trace-root-name">{nodeTitle(root)}</span>
                        <span class="trace-root-badge">{rootLabel(root)}</span>
                        <Show when={formatRootDuration(root)}>{(duration) => <span class="trace-root-duration">{duration()}</span>}</Show>
                        <Show when={errorCount(root)}>{(n) => <span class="trace-error-count">{n()} err</span>}</Show>
                      </div>
                      <div class="trace-root-meta"><span class="trace-root-meta-text">{rootMeta(root)}</span><span class="trace-root-age">{relativeTimeNs(rowEndedNs(root) || rowStartedNs(root))}</span></div>
                    </button>
                  )}
                </For>
                <Show when={rootsState() === "loading" && filteredTraceRoots().length > 0}><div class="trace-load-more" aria-live="polite"><LoadingDots class="trace-loading-dots" label="loading traces" /></div></Show>
              </Show>
              <Show when={activeTab() === "failed"}>
                <For each={filteredFailures()} fallback={<Show when={failedState() === "loading"} fallback={<EmptyState class="trace-empty">No failed spans match the filters.</EmptyState>}><BareTraceLoading label="loading failed spans" /></Show>}>
                  {(hit) => (<button type="button" class="trace-root-row trace-hit-row" classList={{ selected: selectedId() === hit.node.id }} onClick={() => focusHit(hit)}><div class="trace-root-title"><KindBadge kind={hit.node.kind} /><span class="trace-root-name">{nodeTitle(hit.node)}</span><StatusBadge status={hit.node.status} /></div><div class="trace-root-meta"><span class="trace-root-meta-text">{crumbText([...hit.ancestors, hit.node])}</span></div></button>)}
                </For>
              </Show>
              <Show when={activeTab() === "search"}>
                <For each={filteredSearchHits()} fallback={<Show when={searchState() === "loading"} fallback={<EmptyState class="trace-empty">No spans match the filters.</EmptyState>}><BareTraceLoading label="loading spans" /></Show>}>
                  {(hit) => (<button type="button" class="trace-root-row trace-hit-row" classList={{ selected: selectedId() === hit.node.id }} onClick={() => focusHit(hit)}><div class="trace-root-title"><KindBadge kind={hit.node.kind} /><span class="trace-root-name">{nodeTitle(hit.node)}</span><StatusBadge status={hit.node.status} /></div><div class="trace-root-meta"><span class="trace-root-meta-text">{crumbText([...hit.ancestors, hit.node])}</span></div></button>)}
                </For>
              </Show>
            </div>
          </aside>

          <div class="trace-panel-resizer trace-panel-resizer-column" title="resize trace selector" ref={(el) => installColumnResizer(el)} />

          <main class="trace-pane trace-timeline-pane">
            <div class="trace-timeline-head"><div><span class="trace-eyebrow">Tree timeline</span><strong class="trace-loading-label"><span>{`${nodes().length} spans`}</span><Show when={treeState() === "loading"}><LoadingDots class="trace-loading-dots" label="loading trace tree" /></Show></strong></div><div class="trace-timeline-range"><span>{formatTimeNs(timelineBounds()?.startNs ?? NaN)}</span><strong>{formatDurationNs(timelineBounds()?.durationNs)}</strong><span>{formatTimeNs(timelineBounds()?.endNs ?? NaN)}</span></div></div>
            <div class="trace-timeline-grid"><div class="trace-timeline-columns" aria-hidden="true"><span /><span><TraceTimelineRuler bounds={timelineBounds()} /></span><span /></div><div class="trace-tree-list" role="tree" aria-label="trace tree timeline"><For each={treeRows()} fallback={<Show when={treeState() === "loading"} fallback={<EmptyState class="trace-empty">Select a trace on the left.</EmptyState>}><BareTraceLoading label="loading trace tree" /></Show>}>{(row) => renderTreeRow(row)}</For></div></div>
          </main>

          <div class="trace-panel-resizer trace-panel-resizer-row" title="resize trace detail" ref={(el) => installRowResizer(el)} />

          <section class="trace-pane trace-detail-panel trace-inspector-pane">
            <div class="trace-pane-header"><span>Detail</span><span>{detailState() === "loading" ? "loading…" : selectedNode()?.id || "—"}</span></div>
            <div class="trace-detail-scroll">
              <Show when={detail()} fallback={<Show when={detailState() === "loading"} fallback={<EmptyState class="trace-empty">Select a tree entry to inspect input, output, errors, and events.</EmptyState>}><BareTraceLoading label="loading trace detail" /></Show>}>
                {(state) => (
                  <>
                    <div class="trace-detail-title"><KindBadge kind={state().node.kind} /><h2>{nodeTitle(state().node)}</h2><StatusBadge status={rowDisplayStatus(state().node)} /></div>
                    <div class="trace-detail-meta">
                      <span>started {relativeTimeNs(rowStartedNs(state().node))} ({formatTimeNs(rowStartedNs(state().node))})</span>
                      <span>ended {state().node.t1Ns != null ? `${relativeTimeNs(rowEndedNs(state().node))} (${formatTimeNs(rowEndedNs(state().node))})` : "running"}</span>
                      <span>{formatDurationNs(durationNs(state().node))}</span>
                      <span>{state().children.length} children · {markRows(state().children).length} events</span>
                      <Show when={state().root?.id !== state().node.id ? state().root : null}>
                        {(root) => <span class="trace-parent-link">root <ActionButton class="trace-link-button" onClick={() => loadDetail(root().id)}>{nodeTitle(root())}</ActionButton></span>}
                      </Show>
                      <Show when={state().node.parentId}>
                        {(parentId) => (
                          <span class="trace-parent-link">
                            parent{" "}
                            <Show
                              when={directParent(state())}
                              fallback={<ActionButton class="trace-link-button" onClick={() => loadDetail(parentId())}>{parentId()}</ActionButton>}
                            >
                              {(parent) => (
                                <ActionButton class="trace-link-button" onClick={() => loadDetail(parent().id)}>{nodeTitle(parent())}</ActionButton>
                              )}
                            </Show>
                          </span>
                        )}
                      </Show>
                    </div>
                    <div class="trace-crumbs" aria-label="trace ancestors"><For each={state().ancestors}>{(ancestor) => <ActionButton class="trace-link-button" onClick={() => loadDetail(ancestor.id)}>{nodeTitle(ancestor)}</ActionButton>}</For><span>› {nodeTitle(state().node)}</span></div>
                    <Show when={state().node.inputHash}>
                      {(hash) => <HashBlock label="Input" hash={hash()} onOpenStore={props.bag.openStorePreviewInSidebar} />}
                    </Show>
                    <Show when={state().node.outputHash}>
                      {(hash) => <HashBlock label="Output" hash={hash()} onOpenStore={props.bag.openStorePreviewInSidebar} />}
                    </Show>
                    <Show when={state().node.errorHash}>
                      {(hash) => <HashBlock label="Errors" hash={hash()} onOpenStore={props.bag.openStorePreviewInSidebar} />}
                    </Show>
                    <DataBlock label="Trace data" value={state().node.dataJson} onOpenStore={props.bag.openStorePreviewInSidebar} />
                    <section class="trace-detail-section trace-events-section"><h3>Event log ({markRows(state().children).length})</h3><div class="trace-event-ruler"><span>offset</span><span>level</span><span>message</span></div><div class="trace-events-timeline"><For each={markRows(state().children)} fallback={<EmptyState class="trace-empty">No marks.</EmptyState>}>{(event) => (<div class="trace-event-row" classList={{ [eventLevelClass(markLevel(event))]: true }} style={eventTimelineStyle(event, boundsForDetail(state().node, state().children))}><span class="trace-event-stem" /><span class="trace-event-pin" /><div class="trace-event-card"><div class="trace-row-meta"><span>{formatOffsetNs(rowStartedNs(event), boundsForDetail(state().node, state().children)?.startNs)}</span><span>{formatTimeNs(rowStartedNs(event))}</span><span class="trace-event-level">{markLevel(event) || "event"}</span></div><div class="trace-event-message">{markMessage(event)}</div><Show when={event.dataHash}>{(hash) => <pre class="trace-event-data">data {hash()}</pre>}</Show></div></div>)}</For></div></section>
                  </>
                )}
              </Show>
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
