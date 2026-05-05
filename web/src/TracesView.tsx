import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import type { Bag } from "./state";
import { BackToChatButton, EmptyState, HeaderIconButton, Notice, PageHeader } from "./PageChrome";
import { api, type TraceEventRow, type TraceRow, type TraceSearchArgs, type TraceSummary } from "./api";
import { formatHjson } from "./syntax";

type LoadState = "idle" | "loading" | "error";
type TraceTab = "chats" | "failed" | "search";
type TraceKindFilter = "any" | TraceRow["kind"];
type TraceStatusFilter = "any" | TraceRow["status"];
type SearchHit = { node: TraceRow; ancestors: TraceRow[] };
type DetailState = { node: TraceRow; children: TraceRow[]; ancestors: TraceRow[]; events: TraceEventRow[] };
type TreeRow = { node: TraceRow; depth: number; ghost?: boolean; parentId: string | null };

const CHAT_PAGE_LIMIT = 50;
const DEFAULT_TREE_DEPTH = 6;
const SUBTREE_DEPTH = 4;
const TRACE_LOAD_TIMEOUT_MS = 30_000;
const KIND_FILTERS: TraceKindFilter[] = ["any", "chat", "turn", "step", "llm", "tool", "runjs", "system", "user"];
const STATUS_FILTERS: TraceStatusFilter[] = ["any", "ok", "error", "running"];
const INTERESTING_ANCESTORS = new Set<TraceRow["kind"]>(["step", "turn", "chat"]);

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

async function unwrap<T>(promise: Promise<{ ok: true; value: T } | { ok: false; error: { message?: string } }>, label: string): Promise<T> {
  const result = await withTimeout(promise, TRACE_LOAD_TIMEOUT_MS, label);
  if (!result.ok) throw new Error(result.error?.message || `${label} failed`);
  return result.value;
}

function durationMs(row: TraceRow, now = Date.now()): number | null {
  const start = Number(row.startedMs);
  if (!Number.isFinite(start) || start <= 0) return null;
  const end = row.endedMs == null ? now : Number(row.endedMs);
  if (!Number.isFinite(end) || end < start) return null;
  return end - start;
}

function formatDuration(ms: number | null | undefined): string {
  const n = Number(ms ?? NaN);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1) return `${Math.round(n * 1000)} µs`;
  if (n < 1000) return `${n.toFixed(n < 10 ? 1 : 0)} ms`;
  const s = n / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function formatTime(ms: number | null | undefined): string {
  const n = Number(ms ?? NaN);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Date(n).toISOString().replace("T", " ").replace(".000Z", "Z");
}

function relativeTime(ms: number | null | undefined, now = Date.now()): string {
  const n = Number(ms ?? NaN);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const delta = now - n;
  const abs = Math.abs(delta);
  const suffix = delta >= 0 ? "ago" : "from now";
  if (abs < 1000) return "now";
  if (abs < 60_000) return `${Math.round(abs / 1000)}s ${suffix}`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ${suffix}`;
  return `${Math.round(abs / 86_400_000)}d ${suffix}`;
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

function jsonText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return formatHjson(value);
  } catch {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
}

function copyText(text: string) {
  if (!text) return;
  void navigator.clipboard?.writeText(text);
}

function nearestInterestingAncestor(hit: SearchHit): TraceRow {
  const chain = [...hit.ancestors, hit.node];
  for (let i = chain.length - 1; i >= 0; i--) {
    if (INTERESTING_ANCESTORS.has(chain[i].kind)) return chain[i];
  }
  return hit.node;
}

function mergeRows(existing: TraceRow[], incoming: TraceRow[]): TraceRow[] {
  const byId = new Map<string, TraceRow>();
  for (const row of existing) byId.set(row.id, row);
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => (a.startedMs - b.startedMs) || (a.seq - b.seq) || a.id.localeCompare(b.id));
}

function crumbText(rows: TraceRow[]): string {
  return rows.map(nodeTitle).join(" › ");
}

function StatusBadge(props: { status: TraceRow["status"] }) {
  const icon = () => (props.status === "ok" ? "✓" : props.status === "error" ? "!" : "•");
  return <span class={`trace-status-badge trace-status-${props.status}`}>{icon()} {props.status}</span>;
}

function KindBadge(props: { kind: TraceRow["kind"] }) {
  return <span class={`trace-kind-badge trace-kind-${props.kind}`}>{props.kind}</span>;
}

function HashBlock(props: { label: string; hash: string | null }) {
  return (
    <section class="trace-detail-section">
      <h3>{props.label}</h3>
      <Show when={props.hash} fallback={<EmptyState class="trace-empty">—</EmptyState>}>
        {(hash) => (
          <div>
            <pre class="trace-hash-block">{hash()}</pre>
            <div class="trace-inline-actions">
              <button type="button" class="trace-small-button" onClick={() => copyText(hash())}>copy hash</button>
            </div>
          </div>
        )}
      </Show>
    </section>
  );
}

function DataBlock(props: { label: string; value: unknown; hash?: string | null }) {
  const text = () => jsonText(props.value);
  return (
    <section class="trace-detail-section">
      <h3>{props.label}</h3>
      <Show when={props.value != null} fallback={<HashBlock label={props.label} hash={props.hash || null} />}>
        <pre class="trace-json-block">{text()}</pre>
      </Show>
    </section>
  );
}


export function TraceEventDetails(props: { event: TraceRow; onOpenStore?: (hash: string) => void }) {
  const data = () => props.event.dataJson;
  const openHash = (hash: string | null | undefined) => {
    if (hash) props.onOpenStore?.(hash);
  };
  return (
    <div class="trace-detail-scroll">
      <div class="trace-detail-title">
        <KindBadge kind={props.event.kind} />
        <h2>{nodeTitle(props.event)}</h2>
        <StatusBadge status={props.event.status} />
      </div>
      <div class="trace-detail-meta">
        <span>{formatDuration(durationMs(props.event))}</span>
        <span>{formatTime(props.event.startedMs)}</span>
      </div>
      <Show when={data()}>
        <section class="trace-detail-section">
          <h3>Data</h3>
          <pre class="trace-json-block">{jsonText(data())}</pre>
        </section>
      </Show>
      <section class="trace-detail-section">
        <h3>Hashes</h3>
        <div class="trace-inline-actions">
          <button type="button" class="trace-link-button" disabled={!props.event.inputHash} onClick={() => openHash(props.event.inputHash)}>input</button>
          <button type="button" class="trace-link-button" disabled={!props.event.outputHash} onClick={() => openHash(props.event.outputHash)}>output</button>
          <button type="button" class="trace-link-button" disabled={!props.event.errorHash} onClick={() => openHash(props.event.errorHash)}>error</button>
        </div>
      </section>
    </div>
  );
}

export function TracesView(props: { bag: Bag; onToggleSidebar?: () => void; onOpenSidebar?: () => void }) {
  const [activeTab, setActiveTab] = createSignal<TraceTab>("chats");
  const [chats, setChats] = createSignal<TraceRow[]>([]);
  const [chatsState, setChatsState] = createSignal<LoadState>("idle");
  const [chatCursor, setChatCursor] = createSignal<number | null>(null);
  const [selectedChatId, setSelectedChatId] = createSignal<string | null>(props.bag.traceChatId?.() || null);
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
  const [summary, setSummary] = createSignal<TraceSummary | null>(null);
  const [kindFilter, setKindFilter] = createSignal<TraceKindFilter>("any");
  const [statusFilter, setStatusFilter] = createSignal<TraceStatusFilter>("any");
  const [scopeFilter, setScopeFilter] = createSignal<"any" | "current">("any");

  const nodeById = createMemo(() => new Map(nodes().map((node) => [node.id, node])));
  const selectedNode = createMemo(() => (selectedId() ? nodeById().get(selectedId()!) || detail()?.node || null : null));
  const failedChats = createMemo(() => {
    const grouped = new Map<string, { chatId: string; title: string; lastMs: number; count: number }>();
    for (const hit of failures()) {
      const chat = [...hit.ancestors, hit.node].find((row) => row.kind === "chat" || row.chatId === row.id);
      const chatId = hit.node.chatId || chat?.id || "unknown";
      const prev = grouped.get(chatId);
      const lastMs = hit.node.endedMs || hit.node.startedMs || 0;
      if (prev) {
        prev.count += 1;
        prev.lastMs = Math.max(prev.lastMs, lastMs);
      } else {
        grouped.set(chatId, { chatId, title: chat ? nodeTitle(chat) : chatId, lastMs, count: 1 });
      }
    }
    return [...grouped.values()].sort((a, b) => b.lastMs - a.lastMs).slice(0, CHAT_PAGE_LIMIT);
  });

  const treeRows = createMemo<TreeRow[]>(() => {
    const byParent = new Map<string | null, TraceRow[]>();
    const virtualByParent = new Map<string, TraceRow[]>();
    const allNodes = nodes();
    const ids = new Set(allNodes.map((node) => node.id));
    for (const node of allNodes) {
      const parent = ids.has(node.parentId || "") ? node.parentId : null;
      const list = byParent.get(parent) || [];
      list.push(node);
      byParent.set(parent, list);
      if (node.invokedFromStepId && ids.has(node.invokedFromStepId) && node.parentId !== node.invokedFromStepId) {
        const virtual = virtualByParent.get(node.invokedFromStepId) || [];
        virtual.push(node);
        virtualByParent.set(node.invokedFromStepId, virtual);
      }
    }
    for (const list of byParent.values()) list.sort((a, b) => (a.startedMs - b.startedMs) || (a.seq - b.seq));
    for (const list of virtualByParent.values()) list.sort((a, b) => (a.startedMs - b.startedMs) || (a.seq - b.seq));
    const roots = rootId() && nodeById().has(rootId()!) ? [nodeById().get(rootId()!)!] : (byParent.get(null) || []);
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

  async function loadChats(opts: { more?: boolean } = {}) {
    setChatsState("loading");
    setError(null);
    try {
      const value = await unwrap(api.traces.chats({ limit: CHAT_PAGE_LIMIT, beforeMs: opts.more ? chatCursor() || undefined : undefined }), "trace chats load");
      const next = opts.more ? mergeRows(chats(), value.chats) : value.chats;
      setChats(next);
      const oldest = next.reduce<number | null>((min, row) => {
        const t = row.endedMs || row.startedMs || 0;
        return t > 0 && (min == null || t < min) ? t : min;
      }, null);
      setChatCursor(oldest);
      if (!selectedChatId() && next[0]) void selectChat(next[0].chatId || next[0].id);
      setChatsState("idle");
    } catch (err) {
      setChatsState("error");
      setError(errMessage(err));
    }
  }

  async function selectChat(chatId: string) {
    if (!chatId) return;
    setSelectedChatId(chatId);
    props.bag.showTraces?.(chatId);
    setActiveTab("chats");
    setTreeState("loading");
    setError(null);
    try {
      const value = await unwrap(api.traces.chatTree({ chatId, maxDepth: DEFAULT_TREE_DEPTH }), "trace chat tree load");
      setNodes(value.nodes);
      setRootId(value.root?.id || value.nodes[0]?.id || null);
      const open = new Set<string>();
      for (const node of value.nodes) if (node.depth < DEFAULT_TREE_DEPTH - 1) open.add(node.id);
      setExpanded(open);
      setLoadedBoundary(new Map(value.nodes.filter((node) => node.depth >= DEFAULT_TREE_DEPTH - 1).map((node) => [node.id, DEFAULT_TREE_DEPTH])));
      const first = value.root?.id || value.nodes[0]?.id || null;
      setSelectedId(first);
      if (first) void loadDetail(first);
      setTreeState("idle");
    } catch (err) {
      setTreeState("error");
      setError(errMessage(err));
    }
  }

  async function loadFailures(chatId?: string) {
    setFailedState("loading");
    setError(null);
    try {
      const value = await unwrap(api.traces.failed({ chatId, limit: 200 }), "trace failed load");
      setFailures(value.failures);
      setFailedState("idle");
    } catch (err) {
      setFailedState("error");
      setError(errMessage(err));
    }
  }

  async function runSearch() {
    setSearchState("loading");
    setActiveTab("search");
    setError(null);
    try {
      const args: TraceSearchArgs = { limit: 100 };
      if (kindFilter() !== "any") args.kind = kindFilter();
      if (statusFilter() !== "any") args.status = statusFilter();
      if (scopeFilter() === "current" && selectedChatId()) args.chatId = selectedChatId()!;
      const value = await unwrap(api.traces.search(args), "trace search load");
      setSearchHits(value.hits);
      setSearchState("idle");
    } catch (err) {
      setSearchState("error");
      setError(errMessage(err));
    }
  }

  async function loadSubtree(id: string, opts: { focus?: string; append?: boolean } = {}) {
    setTreeState("loading");
    setError(null);
    try {
      const value = await unwrap(api.traces.subtree({ id, maxDepth: SUBTREE_DEPTH }), "trace subtree load");
      setNodes(opts.append ? mergeRows(nodes(), value.nodes) : value.nodes);
      setRootId(opts.append ? rootId() : value.nodes[0]?.id || id);
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
      const focus = opts.focus || id;
      setSelectedId(focus);
      void loadDetail(focus);
      setTreeState("idle");
    } catch (err) {
      setTreeState("error");
      setError(errMessage(err));
    }
  }

  async function focusHit(hit: SearchHit) {
    const ancestor = nearestInterestingAncestor(hit);
    await loadSubtree(ancestor.id, { focus: hit.node.id });
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const row of hit.ancestors) next.add(row.id);
      next.add(ancestor.id);
      return next;
    });
  }

  async function loadDetail(id: string) {
    setSelectedId(id);
    setDetailState("loading");
    try {
      const value = await unwrap(api.traces.node({ id }), "trace node load");
      setDetail(value);
      setSummary(null);
      void api.traces.summary({ id }).then((res) => {
        if (res.ok && selectedId() === id) setSummary(res.value);
      });
      setDetailState("idle");
    } catch (err) {
      setDetailState("error");
      setError(errMessage(err));
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function shouldOfferLoadMore(row: TraceRow): boolean {
    const directChildren = nodes().filter((node) => node.parentId === row.id).length;
    const count = childCount(row);
    if (count != null) return count > directChildren;
    return row.depth >= DEFAULT_TREE_DEPTH - 1 && !loadedBoundary().has(row.id);
  }

  function renderTreeRow(row: TreeRow): JSX.Element {
    const kids = nodes().some((node) => node.parentId === row.node.id || node.invokedFromStepId === row.node.id);
    const selected = () => selectedId() === row.node.id;
    return (
      <>
        <button
          type="button"
          class="trace-tree-row"
          classList={{ selected: selected(), ghost: row.ghost }}
          style={{ "padding-left": `${0.45 + row.depth * 0.9}rem` }}
          onClick={() => {
            if (row.ghost || row.node.kind === "chat") void loadSubtree(row.node.id, { focus: row.node.id });
            else void loadDetail(row.node.id);
          }}
        >
          <span
            class="trace-expander"
            onClick={(event) => {
              event.stopPropagation();
              toggleExpanded(row.node.id);
            }}
          >
            {kids || shouldOfferLoadMore(row.node) ? (expanded().has(row.node.id) ? "▾" : "▸") : ""}
          </span>
          <span class="trace-row-title"><KindBadge kind={row.node.kind} /><span>{nodeTitle(row.node)}</span></span>
          <span class="trace-row-meta">{formatDuration(durationMs(row.node))}</span>
          <StatusBadge status={row.node.status} />
        </button>
        <Show when={expanded().has(row.node.id) && shouldOfferLoadMore(row.node)}>
          <button type="button" class="trace-small-button trace-load-more" onClick={() => loadSubtree(row.node.id, { append: true })}>
            … load more
          </button>
        </Show>
      </>
    );
  }

  onMount(() => {
    void loadChats();
    void loadFailures();
    const initial = props.bag.traceChatId?.();
    if (initial) void selectChat(initial);
  });

  createEffect(() => {
    if (activeTab() === "failed" && failures().length === 0 && failedState() === "idle") void loadFailures();
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
              void loadChats();
              void loadFailures(selectedChatId() || undefined);
              if (selectedChatId()) void selectChat(selectedChatId()!);
            }}>↻</HeaderIconButton>
          }
          showRightSidebarToggle
        />
        <Show when={error()}>{(message) => <Notice tone="error" class="trace-error">{message()}</Notice>}</Show>
        <header class="trace-explorer-header" aria-label="trace explorer controls">
          <div class="trace-toolbar-group">
            <span class="trace-toolbar-label">View</span>
            <div class="trace-tabs" role="tablist" aria-label="trace tabs">
              <button type="button" class="trace-tab" classList={{ active: activeTab() === "chats" }} onClick={() => setActiveTab("chats")}>Chats</button>
              <button type="button" class="trace-tab" classList={{ active: activeTab() === "failed" }} onClick={() => { setActiveTab("failed"); void loadFailures(); }}>Failed</button>
              <button type="button" class="trace-tab" classList={{ active: activeTab() === "search" }} onClick={() => setActiveTab("search")}>Filter</button>
            </div>
          </div>
          <Show when={activeTab() === "search"}>
            <form class="trace-filter-bar trace-toolbar-group" onSubmit={(event) => { event.preventDefault(); void runSearch(); }}>
              <span class="trace-toolbar-label">Filters</span>
              <div class="trace-filter-fields">
                <label>
                  <span>Kind</span>
                  <select aria-label="trace kind filter" value={kindFilter()} onChange={(event) => setKindFilter(event.currentTarget.value as TraceKindFilter)}>
                    <For each={KIND_FILTERS}>{(kind) => <option value={kind}>{kind}</option>}</For>
                  </select>
                </label>
                <label>
                  <span>Status</span>
                  <select aria-label="trace status filter" value={statusFilter()} onChange={(event) => setStatusFilter(event.currentTarget.value as TraceStatusFilter)}>
                    <For each={STATUS_FILTERS}>{(status) => <option value={status}>{status}</option>}</For>
                  </select>
                </label>
                <label>
                  <span>Scope</span>
                  <select aria-label="trace chat scope" value={scopeFilter()} onChange={(event) => setScopeFilter(event.currentTarget.value as "any" | "current")}>
                    <option value="any">any chat</option>
                    <option value="current">current chat</option>
                  </select>
                </label>
              </div>
              <button type="submit" class="trace-small-button">apply filters</button>
            </form>
          </Show>
        </header>
        <div class="trace-three-pane">
          <aside class="trace-pane trace-left-pane">
            <Show when={activeTab() === "failed"} fallback={
              <>
                <div class="trace-pane-header"><span>Chats</span><span>{chatsState() === "loading" ? "loading…" : `${chats().length}`}</span></div>
                <div class="trace-chat-list">
                  <For each={chats()} fallback={<EmptyState class="trace-empty">No trace chats.</EmptyState>}>
                    {(chat) => (
                      <button type="button" class="trace-chat-row" classList={{ selected: selectedChatId() === (chat.chatId || chat.id) }} onClick={() => selectChat(chat.chatId || chat.id)}>
                        <div class="trace-chat-title"><span>{nodeTitle(chat)}</span><Show when={errorCount(chat)}>{(n) => <span class="trace-error-count">{n()} err</span>}</Show></div>
                        <div class="trace-chat-meta">{relativeTime(chat.endedMs || chat.startedMs)} · {chat.chatId || chat.id}</div>
                      </button>
                    )}
                  </For>
                  <button type="button" class="trace-small-button trace-load-more" disabled={chatsState() === "loading"} onClick={() => loadChats({ more: true })}>load more</button>
                </div>
              </>
            }>
              <div class="trace-pane-header"><span>Failed chats</span><span>{failedState() === "loading" ? "loading…" : `${failedChats().length}`}</span></div>
              <div class="trace-chat-list">
                <For each={failedChats()} fallback={<EmptyState class="trace-empty">No failures found.</EmptyState>}>
                  {(chat) => (
                    <button type="button" class="trace-chat-row" classList={{ selected: selectedChatId() === chat.chatId }} onClick={() => { setSelectedChatId(chat.chatId); void loadFailures(chat.chatId); void selectChat(chat.chatId); }}>
                      <div class="trace-chat-title"><span>{chat.title}</span><span class="trace-error-count">{chat.count} err</span></div>
                      <div class="trace-chat-meta">{relativeTime(chat.lastMs)} · {chat.chatId}</div>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </aside>

          <main class="trace-pane trace-middle-pane">
            <Show when={activeTab() === "search"}>
              <div class="trace-pane-header"><span>Filtered spans</span><span>{searchState() === "loading" ? "loading…" : `${searchHits().length}`}</span></div>
              <div class="trace-results-list">
                <For each={searchHits()} fallback={<EmptyState class="trace-empty">Apply filters to list matching spans.</EmptyState>}>
                  {(hit) => (
                    <button type="button" class="trace-result-row" classList={{ selected: selectedId() === hit.node.id }} onClick={() => focusHit(hit)}>
                      <div class="trace-row-title"><KindBadge kind={hit.node.kind} /><span>{nodeTitle(hit.node)}</span><StatusBadge status={hit.node.status} /></div>
                      <div class="trace-row-meta">{crumbText([...hit.ancestors, hit.node])}</div>
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <Show when={activeTab() === "failed"}>
              <div class="trace-pane-header"><span>Failures</span><span>{failedState() === "loading" ? "loading…" : `${failures().length}`}</span></div>
              <div class="trace-results-list">
                <For each={failures()} fallback={<EmptyState class="trace-empty">No failed spans.</EmptyState>}>
                  {(hit) => (
                    <button type="button" class="trace-result-row" classList={{ selected: selectedId() === hit.node.id }} onClick={() => focusHit(hit)}>
                      <div class="trace-row-title"><KindBadge kind={hit.node.kind} /><span>{nodeTitle(hit.node)}</span><StatusBadge status={hit.node.status} /></div>
                      <div class="trace-row-meta">{crumbText([...hit.ancestors, hit.node])}</div>
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <Show when={activeTab() === "chats"}>
              <div class="trace-pane-header"><span>Tree</span><span>{treeState() === "loading" ? "loading…" : `${nodes().length} spans`}</span></div>
              <div class="trace-tree-list" role="tree" aria-label="trace tree">
                <For each={treeRows()} fallback={<EmptyState class="trace-empty">Select a chat to load its trace tree.</EmptyState>}>
                  {(row) => renderTreeRow(row)}
                </For>
              </div>
            </Show>
          </main>

          <aside class="trace-pane trace-detail-panel">
            <div class="trace-pane-header"><span>Detail</span><span>{detailState() === "loading" ? "loading…" : selectedNode()?.id || "—"}</span></div>
            <div class="trace-detail-scroll">
              <Show when={detail()} fallback={<EmptyState class="trace-empty">Select a span to inspect input, output, errors, and events.</EmptyState>}>
                {(state) => (
                  <>
                    <div class="trace-detail-title">
                      <KindBadge kind={state().node.kind} />
                      <h2>{nodeTitle(state().node)}</h2>
                      <StatusBadge status={state().node.status} />
                    </div>
                    <div class="trace-detail-meta">
                      <span>started {relativeTime(state().node.startedMs)} ({formatTime(state().node.startedMs)})</span>
                      <span>ended {state().node.endedMs ? `${relativeTime(state().node.endedMs)} (${formatTime(state().node.endedMs)})` : "—"}</span>
                      <span>{formatDuration(durationMs(state().node))}</span>
                    </div>
                    <div class="trace-crumbs" aria-label="trace ancestors">
                      <For each={state().ancestors}>
                        {(ancestor) => <button type="button" class="trace-link-button" onClick={() => loadDetail(ancestor.id)}>{nodeTitle(ancestor)}</button>}
                      </For>
                      <span>› {nodeTitle(state().node)}</span>
                    </div>

                    <DataBlock label="Input" value={state().node.dataJson} hash={state().node.inputHash} />
                    <HashBlock label="Output" hash={state().node.outputHash} />
                    <HashBlock label="Error" hash={state().node.errorHash} />

                    <section class="trace-detail-section">
                      <h3>Children</h3>
                      <div class="trace-inline-actions">
                        <span>{state().children.length} child spans</span>
                        <button type="button" class="trace-link-button" onClick={() => loadSubtree(state().node.id, { focus: state().node.id })}>focus tree here</button>
                      </div>
                    </section>

                    <Show when={summary()}>
                      {(s) => (
                        <section class="trace-detail-section">
                          <h3>Summary</h3>
                          <pre class="trace-json-block">{jsonText(s().totals)}</pre>
                        </section>
                      )}
                    </Show>

                    <section class="trace-detail-section">
                      <h3>Events ({state().events.length})</h3>
                      <For each={[...state().events].sort((a, b) => a.tsMs - b.tsMs)} fallback={<EmptyState class="trace-empty">No events.</EmptyState>}>
                        {(event) => (
                          <div class="trace-event-row">
                            <div class="trace-row-meta"><span>{formatTime(event.tsMs)}</span><span>{event.level || "event"}</span></div>
                            <div>{event.message || "—"}</div>
                            <Show when={event.dataHash}>
                              {(hash) => <pre class="trace-event-data">{hash()}</pre>}
                            </Show>
                          </div>
                        )}
                      </For>
                    </section>
                  </>
                )}
              </Show>
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}
