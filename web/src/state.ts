// Reactive Solid state for the moo frontend.
//
// One ChatState owns the timeline + memory + sidebar signals. Mutations come
// from two sources: explicit user actions (createSignal setters) and the
// backend WS event stream (which schedules refresh fetches).

import { createSignal, createEffect, on, onCleanup } from "solid-js";

import {
  api,
  bindWS,
  type ApiResult,
  type ChatSummary,
  type CompactionsValue,
  type ImageAttachment,
  type Predicate,
  type ChatModelInfo,
  type DescribeValue,
  type TimelineItem,
  type FileDiffItem,
  type Triple,
  type UiApp,
  type UiInstance,
  type McpServerConfig,
} from "./api";
import { EventStream, type Event } from "./events";
import { mergedFileDiffs, sameDiffPath } from "./diffs";

const SIDEBAR_KEY = "moo.sidebar.w";
const COLLAPSED_KEY = "moo.sidebar.collapsed";
const ARCHIVED_COLLAPSED_KEY = "moo.sidebar.archivedCollapsed";
const INITIAL_TIMELINE_LIMIT = 160;
const TIMELINE_PAGE_SIZE = 160;
const LIVE_TIMELINE_SLACK = 80;
const MAX_REMEMBERED_TIMELINE_KEYS = 1200;
const RIGHT_SIDEBAR_CHAT_MAX = 24;
const RIGHT_SIDEBAR_TABS_MAX = 8;
const CHAT_LOAD_RETRY_DELAYS_MS = [200, 600, 1200];
const CHAT_CACHE_MAX = 12;
const CHAT_CACHE_KEY = "moo.chat.cache.v1";
const CHAT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MODEL_MRU_KEY = "moo.model.mru.v1";
const MODEL_MRU_MAX = 20;
const RIGHT_SIDEBAR_LAYOUT_KEY = "moo.rightSidebar.layout.v1";
const RIGHT_SIDEBAR_DEFAULT_W = 520;
const RIGHT_SIDEBAR_MAX_W = 900;
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

function decodeSimpleTurtleString(value: string): string {
  const trimmed = value.trim();
  const m = /^"((?:[^"\\\r\n]|\\["\\nrtbf])*)"(?:@[A-Za-z]+(?:-[A-Za-z0-9]+)*|\^\^\S+)?$/.exec(trimmed);
  if (!m) return trimmed;
  return m[1].replace(/\\(["\\nrtbf])/g, (_all, ch: string) => {
    switch (ch) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "b": return "\b";
      case "f": return "\f";
      default: return ch;
    }
  });
}

function normalizeEffort(value: unknown): string | null {
  const effort = decodeSimpleTurtleString(String(value ?? "")).trim().toLowerCase();
  return EFFORT_LEVELS.includes(effort) ? effort : null;
}

function clampRightSidebarWidth(width: unknown): number {
  const n = typeof width === "number" ? width : Number.parseInt(String(width ?? ""), 10);
  if (!Number.isFinite(n)) return RIGHT_SIDEBAR_DEFAULT_W;
  return Math.max(0, Math.min(RIGHT_SIDEBAR_MAX_W, n));
}

function readRightSidebarLayout(): Record<string, RightSidebarLayoutState> {
  try {
    const raw = localStorage.getItem(RIGHT_SIDEBAR_LAYOUT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, RightSidebarLayoutState> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const layout = value as Record<string, unknown>;
      out[id] = {
        width: clampRightSidebarWidth(layout.width),
        collapsed: layout.collapsed === true,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function persistRightSidebarLayout(layout: Record<string, RightSidebarLayoutState>) {
  try {
    const entries = Object.entries(layout).filter(([id]) => id);
    if (entries.length === 0) {
      localStorage.removeItem(RIGHT_SIDEBAR_LAYOUT_KEY);
      return;
    }
    localStorage.setItem(RIGHT_SIDEBAR_LAYOUT_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* ignore storage failures */
  }
}

export type OpenRepoFile = {
  requestedPath: string;
  path: string | null;
  content: string;
  size: number;
  mtime: number;
  loading: boolean;
  error: string | null;
};

export type RightSidebarTab =
  | { id: "diffs"; kind: "diffs"; title: string }
  | { id: string; kind: "file"; title: string; file: OpenRepoFile }
  | { id: string; kind: "diff"; title: string; diffId: string; path: string; item?: FileDiffItem; scope: "history" | "timeline" }
  | { id: string; kind: "app"; title: string; uiId: string; instanceId: string | null; icon?: string | null };

type RightSidebarLayoutState = {
  width?: number;
  collapsed?: boolean;
};

type RightSidebarState = {
  tabs: RightSidebarTab[];
  activeTabId: string;
  width: number;
  collapsed: boolean;
};

type ChatCacheEntry = {
  describe?: DescribeValue;
  describeLimit?: number;
  model?: ChatModelInfo;
  ui?: { apps: UiApp[]; instances: UiInstance[]; primaryUiId?: string | null };
  updatedAt: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function retryChatLoad<T>(
  fn: () => Promise<ApiResult<T>>,
  keepGoing: () => boolean,
): Promise<ApiResult<T>> {
  let result = await fn();
  for (const delayMs of CHAT_LOAD_RETRY_DELAYS_MS) {
    if (result.ok || !keepGoing()) return result;
    await sleep(delayMs);
    if (!keepGoing()) return result;
    result = await fn();
  }
  return result;
}

function createSingleFlight<TArgs extends unknown[], TValue>(
  fn: (...args: TArgs) => Promise<ApiResult<TValue>>,
  keyOf: (...args: TArgs) => string,
): (...args: TArgs) => Promise<ApiResult<TValue>> {
  const inFlight = new Map<string, Promise<ApiResult<TValue>>>();
  return (...args: TArgs) => {
    const key = keyOf(...args);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const p = fn(...args).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  };
}

export type Bag = ReturnType<typeof createState>;

function normalizeModelMru(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const model = String(item ?? "").trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
    if (out.length >= MODEL_MRU_MAX) break;
  }
  return out;
}

function readModelMru(): string[] {
  try {
    return normalizeModelMru(JSON.parse(localStorage.getItem(MODEL_MRU_KEY) || "[]"));
  } catch {
    return [];
  }
}

function persistModelMru(models: string[]) {
  try {
    localStorage.setItem(MODEL_MRU_KEY, JSON.stringify(normalizeModelMru(models)));
  } catch {
    /* ignore storage failures */
  }
}

export function createState() {
  const chatModelsSingle = createSingleFlight(api.chatModels, (id: string) => id);
  const uiListSingle = createSingleFlight(api.uiList, () => "ui-list");
  const uiChatSingle = createSingleFlight(api.uiChat, (id: string) => id);
  const mcpListSingle = createSingleFlight(api.mcpList, () => "mcp-list");
  const [startupLoading, setStartupLoading] = createSignal(true);
  const [startupLoadingMessage, setStartupLoadingMessage] = createSignal("Loading chat…");
  const [chats, setChats] = createSignal<ChatSummary[]>([]);
  const [chatsLoaded, setChatsLoaded] = createSignal(false);
  const [archivedCollapsed, setArchivedCollapsed] = createSignal(
    localStorage.getItem(ARCHIVED_COLLAPSED_KEY) !== "0",
  );
  const [chatId, setChatId] = createSignal<string | null>(null);
  const currentChat = () => chats().find((chat) => chat.chatId === chatId()) ?? null;
  const currentChatTitle = () => {
    const chat = currentChat();
    if (!chat) return null;
    return chat.title?.trim() || chat.chatId;
  };
  const [chatFocusRequest, setChatFocusRequest] = createSignal(0);
  const [timeline, setTimeline] = createSignal<TimelineItem[]>([]);
  const [timelineJumpRequest, setTimelineJumpRequest] = createSignal<{ id: number; target: { key?: string; at?: number; id?: string } } | null>(null);
  let timelineJumpSeq = 0;
  const jumpToTimeline = (target: { key?: string; at?: number; id?: string }) => {
    setTimelineJumpRequest({ id: ++timelineJumpSeq, target });
  };
  const [timelineLimit, setTimelineLimit] = createSignal(INITIAL_TIMELINE_LIMIT);
  const [timelineExpansionVersion, setTimelineExpansionVersion] = createSignal(0);
  const timelineOpen = new Set<string>();
  const timelineShown = new Map<string, number>();
  const expansionStore = {
    isOpen: (key: string) => {
      timelineExpansionVersion();
      return timelineOpen.has(key);
    },
    setOpen: (key: string, open: boolean) => {
      const had = timelineOpen.has(key);
      if (open) timelineOpen.add(key);
      else timelineOpen.delete(key);
      if (had !== open) setTimelineExpansionVersion((v) => v + 1);
    },
    shown: (key: string) => {
      timelineExpansionVersion();
      return timelineShown.get(key) ?? 0;
    },
    setShown: (key: string, shown: number) => {
      const next = Math.max(0, shown);
      if ((timelineShown.get(key) ?? 0) === next) return;
      if (next === 0) timelineShown.delete(key);
      else timelineShown.set(key, next);
      setTimelineExpansionVersion((v) => v + 1);
    },
  };
  const [hiddenTimelineItems, setHiddenTimelineItems] = createSignal(0);
  const [compactions, setCompactions] = createSignal<CompactionsValue | null>(null);
  const [compactionsLoading, setCompactionsLoading] = createSignal(false);
  // chatId whose timeline has been loaded at least once. Used to gate the
  // "nothing yet" empty state so it doesn't flash during chat switches /
  // initial load when the timeline is briefly empty before the describe
  // round-trip lands.
  const [loadedChatId, setLoadedChatId] = createSignal<string | null>(null);
  const [totalFacts, setTotalFacts] = createSignal(0);
  const [totalTurns, setTotalTurns] = createSignal(0);
  const [totalSteps, setTotalSteps] = createSignal(0);
  const [totalCodeCalls, setTotalCodeCalls] = createSignal(0);
  const [chatModel, setChatModel] = createSignal<ChatModelInfo | null>(null);
  const [modelMru, setModelMru] = createSignal<string[]>(readModelMru());
  const [tokens, setTokens] = createSignal<{
    used: number;
    budget: number;
    threshold: number;
    fraction: number;
  } | null>(null);
  const [triples, setTriples] = createSignal<Triple[]>([]);
  const [triplesLoaded, setTriplesLoaded] = createSignal(false);
  const [triplesRemovedMode, setTriplesRemovedMode] = createSignal<"exclude" | "include" | "only">("exclude");
  const [vocabulary, setVocabulary] = createSignal<Predicate[]>([]);
  const [vocabularyLoaded, setVocabularyLoaded] = createSignal(false);
  const [chatMemory, setChatMemory] = createSignal<Record<string, { effort: string | null }>>({});
  let chatMemoryRequestSeq = 0;
  let chatModelRequestSeq = 0;
  const [uiApps, setUiApps] = createSignal<UiApp[]>([]);
  const [uiAppsLoaded, setUiAppsLoaded] = createSignal(false);
  const [mcpServers, setMcpServers] = createSignal<McpServerConfig[]>([]);
  const [mcpServersLoaded, setMcpServersLoaded] = createSignal(false);
  const [chatUiApps, setChatUiApps] = createSignal<UiApp[]>([]);
  const [uiInstances, setUiInstances] = createSignal<UiInstance[]>([]);
  const chatCache = new Map<string, ChatCacheEntry>();
  let persistChatCacheSoonHandle: number | null = null;

  function isDescribeFreshForSummary(value: DescribeValue | undefined, summary: ChatSummary | undefined): boolean {
    if (!value || !summary) return !!value;
    return (
      value.head === summary.head &&
      value.totalFacts === summary.totalFacts &&
      value.totalTurns === summary.totalTurns &&
      value.totalSteps === summary.totalSteps
    );
  }

  function pruneExpiredChatCache(now = Date.now()) {
    for (const [id, entry] of chatCache) {
      if (now - entry.updatedAt > CHAT_CACHE_TTL_MS) chatCache.delete(id);
    }
    while (chatCache.size > CHAT_CACHE_MAX) {
      const oldest = chatCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      chatCache.delete(oldest);
    }
  }

  function loadPersistentChatCache() {
    try {
      const raw = localStorage.getItem(CHAT_CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { entries?: Array<[string, ChatCacheEntry]> };
      for (const [id, entry] of parsed.entries ?? []) {
        if (!id || !entry || typeof entry.updatedAt !== "number") continue;
        chatCache.set(id, entry);
      }
      pruneExpiredChatCache();
    } catch {
      localStorage.removeItem(CHAT_CACHE_KEY);
    }
  }

  function persistChatCache() {
    pruneExpiredChatCache();
    try {
      localStorage.setItem(CHAT_CACHE_KEY, JSON.stringify({ entries: [...chatCache.entries()] }));
    } catch {
      // If the bounded timeline payloads hit quota, keep the freshest half and
      // try once more. The in-memory cache remains valid for this tab either way.
      const keep = Math.max(1, Math.floor(CHAT_CACHE_MAX / 2));
      const entries = [...chatCache.entries()].slice(-keep);
      chatCache.clear();
      for (const [id, entry] of entries) chatCache.set(id, entry);
      try {
        localStorage.setItem(CHAT_CACHE_KEY, JSON.stringify({ entries }));
      } catch {
        localStorage.removeItem(CHAT_CACHE_KEY);
      }
    }
  }

  function persistChatCacheSoon() {
    if (persistChatCacheSoonHandle !== null) return;
    persistChatCacheSoonHandle = window.setTimeout(() => {
      persistChatCacheSoonHandle = null;
      persistChatCache();
    }, 250);
  }

  function touchChatCache(id: string, patch: Partial<ChatCacheEntry>) {
    const next = { ...(chatCache.get(id) ?? { updatedAt: 0 }), ...patch, updatedAt: Date.now() };
    chatCache.delete(id);
    chatCache.set(id, next);
    while (chatCache.size > CHAT_CACHE_MAX) {
      const oldest = chatCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      chatCache.delete(oldest);
    }
    persistChatCacheSoon();
  }

  function updateChatSummary(id: string, patch: Partial<ChatSummary>) {
    setChats((current) =>
      current.map((chat) => (chat.chatId === id ? { ...chat, ...patch } : chat)),
    );
  }

  function applyChatModelToSummary(model: ChatModelInfo) {
    updateChatSummary(model.chatId, {
      selectedModel: model.selectedModel,
      model: model.effectiveModelId ?? model.effectiveModel,
    });
  }

  function applyDescribeValue(id: string, value: DescribeValue, current: TimelineItem[] = timeline()) {
    setTimeline(mergeTimelineRows(value.timeline, current));
    updateChatSummary(id, {
      head: value.head,
      totalFacts: value.totalFacts,
      totalTurns: value.totalTurns,
      totalSteps: value.totalSteps,
    });
    setTotalFacts(value.totalFacts);
    setTotalTurns(value.totalTurns);
    setTotalSteps(value.totalSteps);
    setTotalCodeCalls(
      value.totalCodeCalls ??
        value.timeline.filter((it) => it.type === "step" && it.kind === "agent:RunJS").length,
    );
    setTokens(value.tokens);
    setHiddenTimelineItems(value.hiddenTimelineItems ?? 0);
    setLoadedChatId(id);
  }

  function restoreCachedChat(id: string, summary?: ChatSummary): boolean {
    const cached = chatCache.get(id);
    if (!cached) return false;
    if (cached.describe && isDescribeFreshForSummary(cached.describe, summary)) {
      setTimelineLimit(cached.describeLimit ?? cached.describe.timelineLimit ?? INITIAL_TIMELINE_LIMIT);
      applyDescribeValue(id, cached.describe, []);
    }
    if (cached.model) setChatModel(cached.model);
    if (cached.ui) {
      setChatUiApps(cached.ui.apps);
      setUiInstances(cached.ui.instances);
      restorePrimaryUi(cached.ui.primaryUiId ?? null, cached.ui.instances);
    }
    touchChatCache(id, {});
    return !!cached.describe && isDescribeFreshForSummary(cached.describe, summary);
  }

  function forgetChatCache(id: string) {
    if (!chatCache.delete(id)) return;
    persistChatCacheSoon();
  }
  // Set of chat IDs the server has confirmed are currently running a step
  // (driven by step-start / step-end WS events from the Rust chat driver, and
  // reconciled from chat-list status). Only this server-confirmed state drives
  // the visible "thinking" UI.
  const [activeChats, setActiveChats] = createSignal<Set<string>>(new Set());
  // Server-confirmed start time for each active chat. This lives in global
  // state instead of Timeline so the elapsed Thinking timer does not restart
  // when the user switches chats/tabs and Timeline remounts.
  const [activeChatStartedAt, setActiveChatStartedAt] = createSignal<Map<string, number>>(new Map());
  // Local dispatch locks prevent sending another queued message for the same
  // chat while /api/run is being accepted and before the corresponding
  // step-start event arrives. These locks must not make the UI look like the
  // agent is thinking.
  const [dispatchingChats, setDispatchingChats] = createSignal<Set<string>>(new Set());
  const setHas = (set: Set<string>, id: string) => set.has(id);
  const chatBusy = (id: string) => setHas(activeChats(), id) || setHas(dispatchingChats(), id);
  function addToSet(setter: (value: Set<string>) => void, current: () => Set<string>, id: string) {
    const next = new Set(current());
    next.add(id);
    setter(next);
  }
  function deleteFromSet(setter: (value: Set<string>) => void, current: () => Set<string>, id: string) {
    const next = new Set(current());
    next.delete(id);
    setter(next);
  }
  const thinking = () => {
    const id = chatId();
    return id ? activeChats().has(id) : false;
  };
  const thinkingStartedAt = () => {
    const id = chatId();
    return id ? activeChatStartedAt().get(id) ?? null : null;
  };
  function setChatStartedAt(id: string, at: unknown) {
    const ms = Number(at);
    const startedAt = Number.isFinite(ms) && ms > 0 ? ms : Date.now();
    setActiveChatStartedAt((current) => {
      const next = new Map(current);
      next.set(id, startedAt);
      return next;
    });
  }
  function deleteChatStartedAt(id: string) {
    setActiveChatStartedAt((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }
  const [connected, setConnected] = createSignal(false);

  // Toast queue for surfacing API/WS failures to the user. Each entry
  // self-dismisses after a few seconds; the UI can also dismiss by id.
  type Toast = { id: number; source: string; message: string; at: number };
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  let toastSeq = 0;
  function notify(source: string, message: string) {
    const id = ++toastSeq;
    setToasts([...toasts(), { id, source, message, at: Date.now() }]);
    window.setTimeout(() => dismissToast(id), 6000);
  }
  function dismissToast(id: number) {
    setToasts(toasts().filter((t) => t.id !== id));
  }
  function wsErrorMessage(err: unknown): string {
    return err && typeof err === "object" && "message" in (err as any)
      ? String((err as any).message)
      : String(err);
  }
  function isTransientWsError(err: unknown): boolean {
    return /^ws (disconnected|closed|not bound|request timed out)/i.test(wsErrorMessage(err));
  }
  function reportError(source: string, err: unknown) {
    const message = wsErrorMessage(err);
    // Don't toast in-flight requests that fail because the WS dropped or a
    // background RPC got stuck behind a busy worker. The ws-status indicator
    // shows disconnects, and reconnect/heartbeat/ref handlers resync data once
    // the backend catches up. Without this filter, transient stalls flood the
    // screen with one toast per pending call (models/apps/describe/etc.).
    if (isTransientWsError(err)) return;
    notify(source, message);
  }
  // Streaming reply buffer keyed by the current chat. Cleared by:
  // - draft-end events from the agent
  // - new chat selection
  // - the real Reply step landing (caller can clear via setDraftReply)
  const [draftReply, setDraftReply] = createSignal<{
    chatId: string;
    draftId: string;
    content: string;
  } | null>(null);

  const [rightSidebarByChat, setRightSidebarByChat] = createSignal<Record<string, RightSidebarState>>({});
  const [rightSidebarLayoutByChat, setRightSidebarLayoutByChat] = createSignal<Record<string, RightSidebarLayoutState>>(readRightSidebarLayout());
  const currentChatPath = () => currentChat()?.path ?? null;
  const currentChatWorktreePath = () => {
    const chat = currentChat();
    return chat?.worktreePath ?? chat?.path ?? null;
  };
  const repoFileReadSeq = new Map<string, number>();

  function fileName(path: string): string {
    const trimmed = path.replace(/\/+$/, "");
    return trimmed.split("/").pop() || trimmed || "file";
  }

  function repoFileTabId(path: string): string {
    return `file:${path.replace(/\\/g, "/")}`;
  }

  function diffHistoryTabId(path: string): string {
    return `diff-history:${path.replace(/\\/g, "/").replace(/\/+$/, "")}`;
  }

  function diffTimelineTabId(item: FileDiffItem): string {
    const path = item.path.replace(/\\/g, "/").replace(/\/+$/, "");
    return `diff-timeline:${item.id}:${path}`;
  }

  function appTabId(uiId: string, instanceId?: string | null): string {
    return `app:${uiId}:${instanceId || "new"}`;
  }

  function appTitle(uiId: string): string {
    const app = uiApps().find((candidate) => candidate.id === uiId);
    return app?.title || uiId;
  }

  function defaultRightSidebarState(layout?: RightSidebarLayoutState): RightSidebarState {
    return {
      tabs: [
        { id: "diffs", kind: "diffs", title: "Trails" },
      ],
      activeTabId: "diffs",
      width: clampRightSidebarWidth(layout?.width),
      collapsed: layout?.collapsed === true,
    };
  }

  function normalizeRightSidebarState(state: RightSidebarState | undefined, layout?: RightSidebarLayoutState): RightSidebarState {
    const fallback = defaultRightSidebarState(layout);
    const tabs = (state?.tabs ? [...state.tabs] : fallback.tabs)
      .filter((tab) => tab.id !== "agent-trail");
    if (!tabs.some((tab) => tab.id === "diffs")) {
      tabs.unshift({ id: "diffs", kind: "diffs", title: "Trails" });
    }
    const diffsTab = tabs.find((tab) => tab.id === "diffs");
    if (diffsTab) diffsTab.title = "Trails";
    const activeTabId = state?.activeTabId && tabs.some((tab) => tab.id === state.activeTabId)
      ? state.activeTabId
      : tabs[0]!.id;
    return {
      tabs,
      activeTabId,
      width: clampRightSidebarWidth(state?.width ?? layout?.width),
      collapsed: state?.collapsed ?? layout?.collapsed === true,
    };
  }

  function trimRightSidebarTabs(tabs: RightSidebarTab[], activeTabId: string): RightSidebarTab[] {
    if (tabs.length <= RIGHT_SIDEBAR_TABS_MAX) return tabs;
    const keep = new Set(["diffs", activeTabId]);
    const newest = [...tabs].reverse();
    const out: RightSidebarTab[] = [];
    for (const tab of newest) {
      if (keep.has(tab.id) || out.length < RIGHT_SIDEBAR_TABS_MAX) out.push(tab);
      if (out.length >= RIGHT_SIDEBAR_TABS_MAX && [...keep].every((id) => out.some((tab) => tab.id === id))) break;
    }
    return out.reverse();
  }

  function pruneRightSidebarChats(next: Record<string, RightSidebarState>, activeChatId: string): Record<string, RightSidebarState> {
    const ids = Object.keys(next);
    if (ids.length <= RIGHT_SIDEBAR_CHAT_MAX) return next;
    const keep = new Set([activeChatId, ...chats().slice(0, RIGHT_SIDEBAR_CHAT_MAX - 1).map((chat) => chat.chatId)]);
    const pruned: Record<string, RightSidebarState> = {};
    for (const id of ids) if (keep.has(id)) pruned[id] = next[id]!;
    if (!pruned[activeChatId] && next[activeChatId]) pruned[activeChatId] = next[activeChatId]!;
    return pruned;
  }

  function currentRightSidebarState(): RightSidebarState | null {
    const id = chatId();
    if (!id) return null;
    return normalizeRightSidebarState(rightSidebarByChat()[id], rightSidebarLayoutByChat()[id]);
  }

  const rightSidebarTabs = () => currentRightSidebarState()?.tabs ?? [];
  const activeRightSidebarTabId = () => currentRightSidebarState()?.activeTabId ?? null;
  const activeRightSidebarTab = () => {
    const state = currentRightSidebarState();
    return state?.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
  };
  const rightSidebarW = () => currentRightSidebarState()?.width ?? RIGHT_SIDEBAR_DEFAULT_W;
  const rightSidebarCollapsed = () => currentRightSidebarState()?.collapsed ?? false;
  const openRepoFile = () => {
    const tab = activeRightSidebarTab();
    return tab?.kind === "file" ? tab.file : null;
  };

  function updateCurrentRightSidebarState(fn: (state: RightSidebarState) => RightSidebarState) {
    const id = chatId();
    if (!id) return;
    const layout = rightSidebarLayoutByChat()[id];
    setRightSidebarByChat((prev) => {
      const normalized = normalizeRightSidebarState(fn(normalizeRightSidebarState(prev[id], layout)), layout);
      const tabs = trimRightSidebarTabs(normalized.tabs, normalized.activeTabId);
      const activeTabId = tabs.some((tab) => tab.id === normalized.activeTabId) ? normalized.activeTabId : tabs[0]!.id;
      return pruneRightSidebarChats({
        ...prev,
        [id]: { ...normalized, tabs, activeTabId },
      }, id);
    });
  }

  function upsertRightSidebarTab(tab: RightSidebarTab, activate = true) {
    const id = chatId();
    updateCurrentRightSidebarState((state) => {
      const tabs = state.tabs.some((existing) => existing.id === tab.id)
        ? state.tabs.map((existing) => existing.id === tab.id ? tab : existing)
        : [...state.tabs, tab];
      return { ...state, tabs, activeTabId: activate ? tab.id : state.activeTabId, collapsed: activate ? false : state.collapsed };
    });
    if (activate && id) {
      setRightSidebarLayoutByChat((prev) => ({
        ...prev,
        [id]: { ...prev[id], collapsed: false },
      }));
    }
  }

  function setActiveRightSidebarTab(tabId: string) {
    const tab = rightSidebarTabs().find((candidate) => candidate.id === tabId);
    if (tab?.kind === "app") {
      setOpenUiId(tab.uiId);
      setOpenUiInstanceId(tab.instanceId);
    } else if (tab) {
      setOpenUiId(null);
      setOpenUiInstanceId(null);
    }
    updateCurrentRightSidebarState((state) => ({
      ...state,
      activeTabId: state.tabs.some((candidate) => candidate.id === tabId) ? tabId : state.activeTabId,
    }));
  }

  async function closeRightSidebarTab(tabId: string) {
    if (tabId === "diffs") return;
    repoFileReadSeq.delete(tabId);
    const closing = rightSidebarTabs().find((tab) => tab.id === tabId);
    updateCurrentRightSidebarState((state) => {
      const idx = state.tabs.findIndex((tab) => tab.id === tabId);
      const tabs = state.tabs.filter((tab) => tab.id !== tabId);
      const fallback = tabs[Math.max(0, Math.min(idx, tabs.length - 1))] ?? tabs[0] ?? null;
      return { ...state, tabs, activeTabId: state.activeTabId === tabId ? fallback?.id ?? "diffs" : state.activeTabId };
    });
    if (closing?.kind === "app" && openUiId() === closing.uiId && openUiInstanceId() === closing.instanceId) {
      setOpenUiId(null);
      setOpenUiInstanceId(null);
    }
    const activeTabId = currentRightSidebarState()?.activeTabId;
    const activeAppTab = activeTabId
      ? rightSidebarTabs().find((tab): tab is Extract<RightSidebarTab, { kind: "app" }> => (tab.id === activeTabId && tab.kind === "app"))
      : null;
    if (activeAppTab) {
      setOpenUiId(activeAppTab.uiId);
      setOpenUiInstanceId(activeAppTab.instanceId);
    }
    const id = chatId();
    if (id && closing?.kind === "app" && closing.instanceId) {
      const r = await api.uiClose(id, closing.uiId, closing.instanceId);
      if (!r.ok) reportError(`close app ${closing.uiId}`, r.error);
      else await refreshChatUis();
    }
  }

  function updateFileTab(tabId: string, update: (file: OpenRepoFile | null) => OpenRepoFile) {
    updateCurrentRightSidebarState((state) => {
      const existing = state.tabs.find((tab) => tab.id === tabId && tab.kind === "file") as Extract<RightSidebarTab, { kind: "file" }> | undefined;
      const file = update(existing?.file ?? null);
      const tab: RightSidebarTab = { id: tabId, kind: "file", title: fileName(file.path || file.requestedPath), file };
      const tabs = existing
        ? state.tabs.map((candidate) => candidate.id === tabId ? tab : candidate)
        : [...state.tabs, tab];
      return { ...state, tabs, activeTabId: state.activeTabId === tabId || !existing ? tabId : state.activeTabId, collapsed: !existing ? false : state.collapsed };
    });
  }

  function sameRepoFilePath(a: string | null | undefined, b: string | null | undefined): boolean {
    return sameDiffPath(a, b);
  }

  async function readRepoFileIntoSidebar(requestedPath: string, basePath: string | null, showLoading: boolean) {
    const tabId = repoFileTabId(requestedPath);
    const seq = (repoFileReadSeq.get(tabId) ?? 0) + 1;
    repoFileReadSeq.set(tabId, seq);
    if (showLoading) {
      upsertRightSidebarTab({
        id: tabId,
        kind: "file",
        title: fileName(requestedPath),
        file: { requestedPath, path: null, content: "", size: 0, mtime: 0, loading: true, error: null },
      });
    }
    const r = await api.fsRead(requestedPath, basePath);
    if (repoFileReadSeq.get(tabId) !== seq) return;
    if (!r.ok) {
      updateFileTab(tabId, (prev) => ({
        requestedPath,
        path: prev?.path ?? null,
        content: "",
        size: 0,
        mtime: 0,
        loading: false,
        error: r.error.message,
      }));
      return;
    }
    updateFileTab(tabId, () => ({
      requestedPath,
      path: r.value.path,
      content: r.value.content,
      size: r.value.size,
      mtime: r.value.mtime,
      loading: false,
      error: null,
    }));
  }

  async function refreshOpenRepoFile() {
    const file = openRepoFile();
    if (!file) return;
    await readRepoFileIntoSidebar(file.requestedPath, currentChatWorktreePath(), false);
  }

  async function refreshMatchingRepoFiles(path: string) {
    const files = rightSidebarTabs()
      .filter((tab): tab is Extract<RightSidebarTab, { kind: "file" }> => tab.kind === "file")
      .filter((tab) => sameRepoFilePath(tab.file.path, path) || sameRepoFilePath(tab.file.requestedPath, path));
    await Promise.all(files.map((tab) => readRepoFileIntoSidebar(tab.file.requestedPath, currentChatWorktreePath(), false)));
  }

  async function openFileInSidebar(path: string) {
    const requestedPath = path.trim();
    if (!requestedPath) return;
    await readRepoFileIntoSidebar(requestedPath, currentChatWorktreePath(), true);
  }

  function closeRepoFile() {
    const tab = activeRightSidebarTab();
    if (tab?.kind === "file") void closeRightSidebarTab(tab.id);
  }

  function openDiffInSidebar(item: FileDiffItem, scope: "history" | "timeline" = "timeline") {
    const diff = scope === "history"
      ? mergedFileDiffs(timeline()).find((candidate) => sameDiffPath(candidate.path, item.path)) ?? item
      : item;
    upsertRightSidebarTab({
      id: scope === "history" ? diffHistoryTabId(diff.path) : diffTimelineTabId(diff),
      kind: "diff",
      title: diff.path,
      diffId: diff.id,
      path: diff.path,
      item: diff,
      scope,
    });
  }

  function setRightSidebarW(width: number) {
    const next = clampRightSidebarWidth(width);
    const id = chatId();
    if (!id) return;
    updateCurrentRightSidebarState((state) => ({ ...state, width: next }));
    setRightSidebarLayoutByChat((prev) => ({
      ...prev,
      [id]: { ...prev[id], width: next },
    }));
  }

  function setRightSidebarCollapsed(collapsed: boolean) {
    const id = chatId();
    if (!id) return;
    updateCurrentRightSidebarState((state) => ({ ...state, collapsed }));
    setRightSidebarLayoutByChat((prev) => ({
      ...prev,
      [id]: { ...prev[id], collapsed },
    }));
  }

  function toggleRightSidebarCollapsed() {
    setRightSidebarCollapsed(!rightSidebarCollapsed());
  }

  const stored = localStorage.getItem(SIDEBAR_KEY);
  const [sidebarW, setSidebarW] = createSignal(stored ? parseInt(stored, 10) : 260);
  const [collapsed, setCollapsed] = createSignal(
    localStorage.getItem(COLLAPSED_KEY) === "1",
  );

  // URL routing: `/chat/<id>` for chats, `/apps/<appId>` for app panes, `/memory[/<graph>][#<subject>]` for facts view, `/apps` for apps.
  type Loc =
    | { view: "chat"; chatId: string | null }
    | { view: "memory"; graph: string | null; subject: string | null }
    | { view: "apps"; instanceId: string | null }
    | { view: "mcp" };

  function parseLocation(): Loc {
    const path = location.pathname.replace(/\/$/, "") || "/";
    if (path.startsWith("/chat/")) {
      const parts = path.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
      return { view: "chat", chatId: parts[1] || null };
    }
    if (path === "/apps" || path.startsWith("/apps/")) {
      const parts = path.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
      return { view: "apps", instanceId: parts[1] || null };
    }
    if (path === "/memory" || path.startsWith("/memory/")) {
      const parts = path.split("/").filter(Boolean);
      const graph = parts.length > 1 ? decodeURIComponent(parts.slice(1).join("/")) : null;
      const hash = location.hash;
      return {
        view: "memory",
        graph,
        subject: hash ? decodeURIComponent(hash.slice(1)) : null,
      };
    }
    if (path === "/mcp" || path.startsWith("/mcp/")) return { view: "mcp" };
    return { view: "chat", chatId: null };
  }

  function buildPath(v: "chat" | "memory" | "apps" | "mcp", id: string | null, subject: string | null, graph: string | null = null): string {
    if (v === "apps") {
      const uiId = openUiId();
      return uiId ? `/apps/${encodeURIComponent(uiId)}` : "/apps";
    }
    if (v === "memory") {
      const base = graph ? `/memory/${encodeURIComponent(graph)}` : "/memory";
      return subject ? `${base}#${encodeURIComponent(subject)}` : base;
    }
    if (v === "mcp") return "/mcp";
    if (!id) return "/";
    return `/chat/${encodeURIComponent(id)}`;
  }

  const initialLoc = parseLocation();
  const initialOAuthCallback = (() => {
    if (location.pathname.replace(/\/$/, "") !== "/mcp/oauth/callback") return null;
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const oauthState = params.get("state");
    const error = params.get("error");
    if (code && oauthState) return { code, state: oauthState };
    if (error) {
      return { error: params.get("error_description") || error || "OAuth login failed" };
    }
    return null;
  })();
  const [openUiId, setOpenUiId] = createSignal<string | null>(null);
  const [openUiInstanceId, setOpenUiInstanceId] = createSignal<string | null>(initialLoc.view === "apps" ? initialLoc.instanceId : null);
  const [view, setView] = createSignal<"chat" | "memory" | "apps" | "mcp">(initialLoc.view);
  const [focusedSubject, setFocusedSubject] = createSignal<string | null>(
    initialLoc.view === "memory" ? initialLoc.subject : null,
  );
  const [focusedGraph, setFocusedGraph] = createSignal<string | null>(
    initialLoc.view === "memory" ? initialLoc.graph : null,
  );

  function pushUrl() {
    const path = buildPath(view(), chatId(), focusedSubject(), focusedGraph());
    if (location.pathname + location.search + location.hash !== path) {
      history.pushState(null, "", path);
    }
  }
  function replaceUrl() {
    const path = buildPath(view(), chatId(), focusedSubject(), focusedGraph());
    history.replaceState(null, "", path);
  }

  function showMemory(subject?: string | null, graph?: string | null) {
    setView("memory");
    setFocusedSubject(subject ?? null);
    setFocusedGraph(graph ?? null);
    // Memory triples/vocab aren't refreshed on chat fact changes (too
    // expensive), so pull fresh data when the user actually opens the view.
    refreshTriples();
    refreshVocabulary();
    pushUrl();
  }

  function showChat() {
    setView("chat");
    setFocusedSubject(null);
    setFocusedGraph(null);
    const id = chatId();
    if (id && !openUiId()) {
      const cached = chatCache.get(id)?.ui;
      if (cached) restorePrimaryUi(cached.primaryUiId ?? null, cached.instances);
      else void refreshChatUis();
    }
    pushUrl();
  }

  async function showApps() {
    setOpenUiId(null);
    setOpenUiInstanceId(null);
    setView("apps");
    setFocusedSubject(null);
    setFocusedGraph(null);
    await refreshUis();
    pushUrl();
  }

  function showMcp() {
    setOpenUiId(null);
    setOpenUiInstanceId(null);
    setView("mcp");
    setFocusedSubject(null);
    setFocusedGraph(null);
    void refreshMcpServers();
    pushUrl();
  }

  const popstateHandler = () => {
    const loc = parseLocation();
    if (loc.view === "memory") {
      setView("memory");
      setFocusedSubject(loc.subject);
      setFocusedGraph(loc.graph);
    } else if (loc.view === "apps") {
      setView("apps");
      setFocusedSubject(null);
      setFocusedGraph(null);
      if (loc.instanceId) {
        void openUiFromRoute(loc.instanceId, "none");
      } else {
        setOpenUiId(null);
        setOpenUiInstanceId(null);
      }
    } else if (loc.view === "mcp") {
      setView("mcp");
      setFocusedSubject(null);
      setFocusedGraph(null);
      setOpenUiId(null);
      setOpenUiInstanceId(null);
    } else {
      setView("chat");
      setFocusedSubject(null);
      setFocusedGraph(null);
      setOpenUiId(null);
      setOpenUiInstanceId(null);
      const target = loc.chatId ?? chats()[0]?.chatId ?? null;
      if (target && target !== chatId()) {
        void selectChat(target, true);
      } else if (!target) {
        setChatId(null);
        setDraftReply(null);
        setTimeline([]);
        setTimelineLimit(INITIAL_TIMELINE_LIMIT);
        setHiddenTimelineItems(0);
        setTotalCodeCalls(0);
        setLoadedChatId(null);
        setTotalFacts(0);
        setTotalTurns(0);
        setTotalSteps(0);
        setTokens(null);
        setChatModel(null);
        setChatUiApps([]);
        setUiInstances([]);
        replaceUrl();
      } else {
        const cached = target ? chatCache.get(target)?.ui : null;
        if (cached) restorePrimaryUi(cached.primaryUiId ?? null, cached.instances);
        else if (target) void refreshChatUis();
        replaceUrl();
      }
    }
  };
  window.addEventListener("popstate", popstateHandler);
  onCleanup(() => window.removeEventListener("popstate", popstateHandler));

  createEffect(() => localStorage.setItem(SIDEBAR_KEY, String(sidebarW())));
  createEffect(() => persistRightSidebarLayout(rightSidebarLayoutByChat()));
  createEffect(() =>
    localStorage.setItem(COLLAPSED_KEY, collapsed() ? "1" : "0"),
  );
  createEffect(() =>
    localStorage.setItem(ARCHIVED_COLLAPSED_KEY, archivedCollapsed() ? "1" : "0"),
  );

  // -- fetchers ----------------------------------------------------------

  async function refreshChats() {
    const r = await api.chats();
    if (r.ok) {
      setChats(r.value.chats);
      setChatsLoaded(true);
      refreshChatMemory(r.value.chats.map((c) => c.chatId));
      // Sync activeChats from the server's running-chat truth so page
      // refreshes / reconnects reflect reality (step-start events that
      // fired before we connected aren't replayed). The chats listing now
      // returns status:"agent:Running" for any chat the Rust driver is
      // actively running; mirror that into the client-side set so
      // thinking() and the stop button work on cold load without relying on
      // local dispatch locks.
      const runningChats = r.value.chats.filter((c) => c.status === "agent:Running");
      const live = new Set(runningChats.map((c) => c.chatId));
      setActiveChats(live);
      setActiveChatStartedAt((current) => {
        const next = new Map<string, number>();
        for (const c of runningChats) {
          const hinted = Number(c.runningStartedAt);
          next.set(c.chatId, Number.isFinite(hinted) && hinted > 0 ? hinted : current.get(c.chatId) ?? Date.now());
        }
        return next;
      });
      if (chatId() && pending().some((p) => !live.has(p.chatId))) queueMicrotask(drain);
    } else {
      setChatsLoaded(true);
      reportError("chats", r.error);
    }
  }

  async function refreshChatMemory(ids = chats().map((c) => c.chatId)) {
    const requestSeq = ++chatMemoryRequestSeq;
    if (ids.length === 0) {
      setChatMemory({});
      return;
    }
    const r = await api.chatSettings(ids);
    if (requestSeq !== chatMemoryRequestSeq) return;
    if (!r.ok) {
      reportError("chat memory", r.error);
      return;
    }
    const next: Record<string, { effort: string | null }> = {};
    for (const [id, settings] of Object.entries(r.value.settings)) {
      next[id] = { effort: normalizeEffort(settings.effort) };
    }
    setChatMemory((current) => {
      const merged: Record<string, { effort: string | null }> = { ...current };
      for (const id of ids) {
        const value = next[id]?.effort ?? null;
        if (value) merged[id] = { effort: value };
        else delete merged[id];
      }
      return merged;
    });
  }

  async function refreshChatModel(opts?: { force?: boolean }) {
    const id = chatId();
    if (!id) return;
    const requestSeq = ++chatModelRequestSeq;
    const r = await retryChatLoad(
      () => (opts?.force ? api.chatModels(id) : chatModelsSingle(id)),
      () => chatId() === id && requestSeq === chatModelRequestSeq,
    );
    if (chatId() !== id || requestSeq !== chatModelRequestSeq) return;
    if (r.ok) {
      setChatModel(r.value);
      touchChatCache(id, { model: r.value });
    }
    else reportError(`models ${id}`, r.error);
  }

  // Single-flight describe per chat. Multiple in-flight describes can race:
  // a slower, earlier-issued one can clobber the timeline with stale data.
  // Coalesce into one in-flight + at most one queued re-fetch.
  let describeInFlight: string | null = null;
  let describeRequeued = false;
  async function refreshTimeline() {
    const id = chatId();
    if (!id) return;
    if (describeInFlight === id) {
      describeRequeued = true;
      return;
    }
    describeInFlight = id;
    try {
      const limit = timelineLimit();
      const r = await retryChatLoad(() => api.describe(id, limit), () => chatId() === id);
      if (chatId() !== id) return;
      if (r.ok) {
        applyDescribeValue(id, r.value);
        touchChatCache(id, { describe: r.value, describeLimit: limit });
      } else {
        reportError(`describe ${id}`, r.error);
      }
    } finally {
      describeInFlight = null;
      if (describeRequeued) {
        describeRequeued = false;
        queueMicrotask(refreshTimeline);
      }
    }
  }

  // The drain loop inserts optimistic UserInput rows (id `opt-…`) the moment
  // the user submits, since /api/run for `step` returns immediately and the
  // driver hasn't recorded the real fact yet. A describe that lands during
  // that window would otherwise wipe the opt row. Keep any opt whose text
  // hasn't yet shown up in the server's UserInput list (FIFO match for
  // back-to-back duplicates).
  function timelineItemKey(item: TimelineItem): string {
    if (item.type === "step") return `step:${item.step}`;
    if (item.type === "input") return `input:${item.requestId}`;
    if (item.type === "log") return `log:${item.id}`;
    if (item.type === "memory-diff") return `memory-diff:${item.id}`;
    return `file-diff:${item.id}`;
  }

  function timelineItemEqual(a: TimelineItem, b: TimelineItem): boolean {
    // Timeline payloads are plain JSON-compatible data from /api/describe.
    // Reusing unchanged objects lets Solid's keyed <For> keep DOM nodes stable
    // across refreshes instead of remounting the whole scrollback.
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function preserveTimelineItems(server: TimelineItem[], current: TimelineItem[]): TimelineItem[] {
    const currentByKey = new Map(current.map((item) => [timelineItemKey(item), item]));
    return server.map((item) => {
      const previous = currentByKey.get(timelineItemKey(item));
      return previous && timelineItemEqual(previous, item) ? previous : item;
    });
  }

  function sortTimelineItems(items: TimelineItem[]): TimelineItem[] {
    return [...items].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  }

  function trimTimelineRows(items: TimelineItem[]): TimelineItem[] {
    const max = Math.max(timelineLimit(), INITIAL_TIMELINE_LIMIT) + LIVE_TIMELINE_SLACK;
    if (items.length <= max) return items;
    return sortTimelineItems(items).slice(-max);
  }

  function rememberTimelineKeys(items: TimelineItem[]) {
    for (const item of items) timelineShown.set(timelineItemKey(item), item.at ?? Date.now());
    if (timelineShown.size <= MAX_REMEMBERED_TIMELINE_KEYS) return;
    const keep = [...timelineShown.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_REMEMBERED_TIMELINE_KEYS);
    timelineShown.clear();
    for (const [key, at] of keep) timelineShown.set(key, at);
  }

  function compactTimelineRows(items: TimelineItem[]): TimelineItem[] {
    const trimmed = trimTimelineRows(items);
    rememberTimelineKeys(trimmed);
    return trimmed;
  }

  function mergeTimelineRows(server: TimelineItem[], current: TimelineItem[]): TimelineItem[] {
    const stableServer = preserveTimelineItems(server, current);
    const opts = current.filter(
      (it): it is TimelineItem & { type: "step"; step: string; text: string } =>
        it.type === "step" && (it as any).step?.startsWith?.("opt-"),
    );
    if (opts.length === 0) return compactTimelineRows(stableServer);
    const remaining = new Map<string, number>();
    for (const it of stableServer) {
      if (it.type === "step" && (it as any).kind === "agent:UserInput") {
        const t = (it as any).text ?? "";
        remaining.set(t, (remaining.get(t) ?? 0) + 1);
      }
    }
    const survivors: TimelineItem[] = [];
    for (const opt of opts) {
      const t = (opt as any).text ?? "";
      const n = remaining.get(t) ?? 0;
      if (n > 0) {
        remaining.set(t, n - 1);
      } else {
        survivors.push(opt);
      }
    }
    if (survivors.length === 0) return compactTimelineRows(stableServer);
    return compactTimelineRows(sortTimelineItems([...stableServer, ...survivors]));
  }

  async function refreshTriples(removed: "exclude" | "include" | "only" = triplesRemovedMode()) {
    setTriplesRemovedMode(removed);
    const r = await api.triples(undefined, undefined, undefined, { removed });
    setTriplesLoaded(true);
    if (r.ok) setTriples(r.value.triples);
    else reportError("triples", r.error);
  }

  async function refreshVocabulary() {
    const r = await api.vocabulary();
    setVocabularyLoaded(true);
    if (r.ok) setVocabulary(r.value.predicates);
    else reportError("vocabulary", r.error);
  }

  async function refreshUis() {
    const r = await uiListSingle();
    setUiAppsLoaded(true);
    if (r.ok) setUiApps(r.value.apps);
    else reportError("apps", r.error);
  }

  async function refreshMcpServers() {
    const r = await mcpListSingle();
    setMcpServersLoaded(true);
    if (r.ok) setMcpServers(r.value.servers);
    else reportError("mcp", r.error);
  }

  async function refreshChatUis() {
    const id = chatId();
    if (!id) return;
    const r = await retryChatLoad(() => uiChatSingle(id), () => chatId() === id);
    if (chatId() !== id) return;
    if (r.ok) {
      setChatUiApps(r.value.apps);
      setUiInstances(r.value.instances);
      restorePrimaryUi(r.value.primaryUiId ?? null, r.value.instances);
      touchChatCache(id, { ui: { apps: r.value.apps, instances: r.value.instances, primaryUiId: r.value.primaryUiId ?? null } });
    } else reportError("chat apps", r.error);
  }

  function normalizeUiInstanceId(id: string): string {
    return id.replace(/^uiinst:/, "");
  }

  function stripPrefix(value: string, prefix: string): string {
    return value.startsWith(prefix) ? value.slice(prefix.length) : value;
  }

  function restorePrimaryUi(primaryUiId: string | null, instances: UiInstance[]) {
    if (!primaryUiId || view() !== "chat") return;
    const current = openUiId();
    if (current && current !== primaryUiId) return;
    const instanceId = instances.find((inst) => inst.uiId === primaryUiId)?.instanceId ?? null;
    setOpenUiId(primaryUiId);
    setOpenUiInstanceId(instanceId);
  }

  async function resolveUiInstance(instanceId: string): Promise<{ uiId: string | null; chatId: string | null } | null> {
    const subject = "uiinst:" + normalizeUiInstanceId(instanceId);
    const r = await api.triples(subject);
    if (!r.ok) {
      reportError("resolve app instance " + instanceId, r.error);
      return null;
    }
    const live = r.value.triples.filter((row) => row[4] !== "remove");
    const appRow = [...live].reverse().find((row) => row[2] === "ui:app");
    const chatRow = [...live].reverse().find((row) => row[2] === "ui:chat");
    return {
      uiId: appRow ? stripPrefix(appRow[3], "ui:") : null,
      chatId: chatRow ? stripPrefix(chatRow[3], "chat:") : null,
    };
  }

  async function openUiFromRoute(routeId: string, urlMode: "replace" | "none" = "none") {
    const appId = routeId;
    if (!uiApps().some((app) => app.id === appId)) await refreshUis();
    if (uiApps().some((app) => app.id === appId)) {
      await openUi(appId, undefined, urlMode);
      return;
    }

    // Backward compatibility for old /apps/<instanceId> links: resolve the
    // instance, open its app, then canonicalize to /apps/<appId> when replacing.
    await openUiInstanceFromRoute(routeId);
    if (urlMode === "replace") replaceUrl();
  }

  async function openUiInstanceFromRoute(instanceId: string) {
    setOpenUiInstanceId(normalizeUiInstanceId(instanceId));
    const resolved = await resolveUiInstance(instanceId);
    if (openUiInstanceId() !== normalizeUiInstanceId(instanceId) || view() !== "apps") return;
    if (!resolved?.uiId) {
      reportError("open app instance", { message: "app instance not found: " + instanceId });
      return;
    }
    setOpenUiId(resolved.uiId);
    if (resolved.chatId && resolved.chatId !== chatId()) {
      setChatId(resolved.chatId);
      setDraftReply(null);
      const summary = chats().find((c) => c.chatId === resolved.chatId);
      const restored = restoreCachedChat(resolved.chatId, summary);
      if (!restored) {
        setTimeline([]);
        setTimelineLimit(INITIAL_TIMELINE_LIMIT);
        setHiddenTimelineItems(0);
        setLoadedChatId(null);
      }
      setTotalFacts((restored ? totalFacts() : undefined) ?? summary?.totalFacts ?? 0);
      setTotalTurns((restored ? totalTurns() : undefined) ?? summary?.totalTurns ?? 0);
      setTotalSteps((restored ? totalSteps() : undefined) ?? summary?.totalSteps ?? 0);
      setTotalCodeCalls(restored ? totalCodeCalls() : 0);
      if (!restored) setTokens(null);
      if (!chatCache.get(resolved.chatId)?.model) setChatModel(null);
      if (!chatCache.get(resolved.chatId)?.ui) {
        setChatUiApps([]);
        setUiInstances([]);
      }
      loadWipText(resolved.chatId);
      await Promise.all([refreshTimeline(), refreshChatModel(), refreshChatUis()]);
    } else if (resolved.chatId) {
      await refreshChatUis();
    }
  }

  // -- chat lifecycle ----------------------------------------------------

  async function selectChat(id: string, replace = false, opts?: { hydrate?: boolean }) {
    setChatId(id);
    setDraftReply(null);
    // A sidebar chat click should always return to the chat itself, not carry
    // over an app/dashboard query such as ?ui=apps-dashboards from the
    // previously selected chat.
    setOpenUiId(null);
    setOpenUiInstanceId(null);
    setView("chat");
    setFocusedSubject(null);
    // Clear stale view synchronously: old chat's content must not linger
    // under the new chatId while the describe round-trip is in flight.
    // Backfill totalFacts from the sidebar summary so the conv-stats line
    // doesn't flash "0 facts" while describe is in flight.
    const summary = chats().find((c) => c.chatId === id);
    const restored = restoreCachedChat(id, summary);
    if (!restored) {
      setTimeline([]);
      setTimelineLimit(INITIAL_TIMELINE_LIMIT);
      setHiddenTimelineItems(0);
      setCompactions(null);
      setCompactionsLoading(false);
      setTotalCodeCalls(0);
      setLoadedChatId(null);
    }
    setTotalFacts((restored ? totalFacts() : undefined) ?? summary?.totalFacts ?? 0);
    setTotalTurns((restored ? totalTurns() : undefined) ?? summary?.totalTurns ?? 0);
    setTotalSteps((restored ? totalSteps() : undefined) ?? summary?.totalSteps ?? 0);
    setTotalCodeCalls(restored ? totalCodeCalls() : 0);
    if (!restored) setTokens(null);
    if (!chatCache.get(id)?.model) setChatModel(null);
    if (!chatCache.get(id)?.ui) {
      setChatUiApps([]);
      setUiInstances([]);
    }
    loadWipText(id);
    setChatFocusRequest((n) => n + 1);
    if (replace) replaceUrl();
    else pushUrl();
    // Load the heavy conversation payload immediately unless the caller has
    // just created an empty chat and only needs navigation to complete.
    if (opts?.hydrate === false) return;
    // Chat-scoped UI app metadata is independent and must not serialize the
    // first timeline paint.
    await Promise.all([refreshTimeline(), refreshChatModel(), refreshChatUis()]);
  }

  function olderTimelineLoadCount() {
    const hidden = hiddenTimelineItems();
    // Avoid a silly second click for a tiny tail (e.g. 184 hidden: load all,
    // not 160 and leave 24). Very long chats still page in bounded chunks.
    if (hidden <= TIMELINE_PAGE_SIZE * 2) return hidden;
    return Math.min(hidden, TIMELINE_PAGE_SIZE);
  }

  async function loadOlderTimeline() {
    const id = chatId();
    const count = olderTimelineLoadCount();
    if (!id || count <= 0) return;
    setTimelineLimit((n) => n + count);
    await refreshTimeline();
  }

  async function refreshCompactions() {
    const id = chatId();
    if (!id) {
      setCompactions(null);
      return;
    }
    setCompactionsLoading(true);
    const r = await api.compactions(id);
    if (chatId() !== id) return;
    setCompactionsLoading(false);
    if (r.ok) setCompactions(r.value);
    else reportError("compactions " + id, r.error);
  }

  async function createChat(path?: string): Promise<string | null> {
    const r = await api.newChat(undefined, path);
    if (!r.ok) {
      reportError("new chat", r.error);
      return null;
    }

    // New chats are empty; don't block navigation on the full sidebar list or
    // initial describe/model/app hydration. Show/select an optimistic summary
    // immediately, then reconcile with server metadata in the background.
    const now = Date.now();
    const summary: ChatSummary = {
      chatId: r.value.chatId,
      createdAt: now,
      lastAt: now,
      head: null,
      title: null,
      path: r.value.path ?? path ?? null,
      status: "agent:Done",
      totalFacts: 0,
      totalTurns: 0,
      totalSteps: 0,
      usage: null,
      costUsd: 0,
      costEstimated: true,
      unpricedModels: [],
      selectedModel: null,
      archived: false,
      archivedAt: null,
    };
    setChats((current) => [summary, ...current.filter((c) => c.chatId !== summary.chatId)]);
    setChatsLoaded(true);
    await selectChat(r.value.chatId, false, { hydrate: false });
    queueMicrotask(() => {
      refreshChatModel();
      refreshChatUis();
    });
    return r.value.chatId;
  }

  async function removeChat(id: string) {
    const r = await api.removeChat(id);
    if (!r.ok) {
      reportError(`remove ${id}`, r.error);
      return;
    }
    setChats((current) => current.filter((chat) => chat.chatId !== id));
    forgetChatCache(id);
    if (chatId() === id) {
      const remaining = chats().filter((c) => c.chatId !== id);
      if (remaining.length > 0) {
        await selectChat(remaining[0]!.chatId);
      } else {
        setChatId(null);
        setDraftReply(null);
        setOpenUiId(null);
        setOpenUiInstanceId(null);
        setView("chat");
        setFocusedSubject(null);
        setTimeline([]);
        setTimelineLimit(INITIAL_TIMELINE_LIMIT);
        setHiddenTimelineItems(0);
        setCompactions(null);
        setCompactionsLoading(false);
        setTotalFacts(0);
        setTotalTurns(0);
        setTotalSteps(0);
        setTotalCodeCalls(0);
        setTokens(null);
        setLoadedChatId(null);
        setChatModel(null);
        setChatUiApps([]);
        setUiInstances([]);
        setWipText("");
        replaceUrl();
      }
    }
  }

  async function removeGraph(graph: string) {
    if (!confirm(`Delete graph "${graph}"? This wipes every fact in it.`)) return;
    const r = await api.removeGraph(graph);
    if (!r.ok) {
      reportError(`remove graph ${graph}`, r.error);
      return;
    }
    // Chat graphs round-trip through chat removal, which also dropped the
    // chat's metadata refs — remove the row locally instead of refreshing the
    // full sidebar list.
    if (r.value.chatId) {
      setChats((current) => current.filter((chat) => chat.chatId !== r.value.chatId));
      forgetChatCache(r.value.chatId);
    }
    await Promise.all([refreshTriples(), refreshVocabulary()]);
  }

  async function openUi(uiId: string, instanceId?: string, urlMode: "push" | "replace" | "none" = "push") {
    let chat = chatId();
    if (!chat) chat = await createChat();
    if (!chat) return;

    // Open apps in the shared right sidebar, preserving the current main view.
    const app = uiApps().find((candidate) => candidate.id === uiId);
    const pendingTabId = appTabId(uiId, instanceId ?? null);
    setOpenUiId(uiId);
    setOpenUiInstanceId(instanceId ?? null);
    upsertRightSidebarTab({
      id: pendingTabId,
      kind: "app",
      title: app?.title || uiId,
      uiId,
      instanceId: instanceId ?? null,
      icon: app?.icon,
    });
    setFocusedSubject(null);
    if (urlMode === "push") pushUrl();
    else if (urlMode === "replace") replaceUrl();

    const r = await api.uiOpen(chat, uiId, instanceId);
    if (!r.ok) {
      if (openUiId() === uiId && openUiInstanceId() === (instanceId ?? null)) {
        setOpenUiId(null);
        setOpenUiInstanceId(null);
        void closeRightSidebarTab(pendingTabId);
        if (urlMode === "push") pushUrl();
        else if (urlMode === "replace") replaceUrl();
      }
      reportError(`open app ${uiId}`, r.error);
      return;
    }
    if (openUiId() !== uiId) return;
    const resolvedTabId = appTabId(r.value.uiId, r.value.instanceId);
    setOpenUiId(r.value.uiId);
    setOpenUiInstanceId(r.value.instanceId);
    updateCurrentRightSidebarState((state) => {
      const tab: RightSidebarTab = {
        id: resolvedTabId,
        kind: "app",
        title: appTitle(r.value.uiId),
        uiId: r.value.uiId,
        instanceId: r.value.instanceId,
        icon: uiApps().find((candidate) => candidate.id === r.value.uiId)?.icon,
      };
      const withoutPending = state.tabs.filter((candidate) => candidate.id !== pendingTabId && candidate.id !== resolvedTabId);
      return { ...state, tabs: [...withoutPending, tab], activeTabId: resolvedTabId, collapsed: false };
    });
    if (urlMode === "push" || urlMode === "replace") replaceUrl();
    refreshChatUis();
  }

  async function removeUi(uiId: string) {
    const app = uiApps().find((a) => a.id === uiId);
    const label = app?.title && app.title !== uiId ? `${app.title} (${uiId})` : uiId;
    if (!confirm(`Delete app "${label}"? This removes it from the apps list.`)) return;
    const r = await api.uiRemove(uiId);
    if (!r.ok) {
      reportError(`delete app ${uiId}`, r.error);
      return;
    }
    setUiApps((apps) => apps.filter((a) => a.id !== uiId));
    setChatUiApps((apps) => apps.filter((a) => a.id !== uiId));
    if (openUiId() === uiId) {
      setOpenUiId(null);
      setOpenUiInstanceId(null);
      for (const tab of rightSidebarTabs()) if (tab.kind === "app" && tab.uiId === uiId) void closeRightSidebarTab(tab.id);
      replaceUrl();
    }
    await Promise.all([refreshUis(), refreshChatUis()]);
  }

  async function closeUi() {
    setOpenUiId(null);
    setOpenUiInstanceId(null);
    const tab = activeRightSidebarTab();
    if (tab?.kind === "app") await closeRightSidebarTab(tab.id);
    pushUrl();
  }

  // -- pending message queue --------------------------------------------
  //
  // Every submit goes through the queue. A single drainer sends messages only
  // when their chat is idle so follow-up inputs stay editable while the agent
  // is working. Pending entries can be edited or removed until picked.

  const [pending, setPending] = createSignal<
    {
      id: string;
      text: string;
      chatId: string;
      attachments?: ImageAttachment[];
    }[]
  >([]);
  // Current draft text in the input bar. Persisted per chat so switching
  // chats doesn't drop in-flight typing.
  const [wipText, setWipText] = createSignal("");
  let draining = false;

  const wipKey = (id: string) => `moo.wip.${id}`;
  function loadWipText(id: string) {
    setWipText(localStorage.getItem(wipKey(id)) ?? "");
  }
  createEffect(() => {
    const id = chatId();
    if (!id) return;
    const text = wipText();
    if (text === "") localStorage.removeItem(wipKey(id));
    else localStorage.setItem(wipKey(id), text);
  });

  const PENDING_KEY = "moo.pending";
  const rawPending = localStorage.getItem(PENDING_KEY);
  if (rawPending) setPending(JSON.parse(rawPending));
  createEffect(() => {
    const pen = pending();
    if (pen.length === 0) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify(pen));
  });

  function enqueueMessage(text: string, attachments: ImageAttachment[] = []) {
    const cid = chatId();
    if (!cid) {
      reportError("send message", "Start a new chat first.");
      return;
    }
    const id = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 6)}`;
    setPending([
      ...pending(),
      { id, text, chatId: cid, ...(attachments.length ? { attachments } : {}) },
    ]);
    drain();
  }

  function editPending(id: string, text: string) {
    setPending(pending().map((p) => (p.id === id ? { ...p, text } : p)));
  }

  function removePending(id: string) {
    setPending(pending().filter((p) => p.id !== id));
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (true) {
        const pen = pending();
        const idx = pen.findIndex((p) => !chatBusy(p.chatId));
        if (idx < 0) break;
        const head = pen[idx]!;
        setPending([...pen.slice(0, idx), ...pen.slice(idx + 1)]);

        // Lock local dispatch before /api/run returns so another queued item
        // for the same chat cannot be picked before the step-start WS event.
        // Do not mark the chat active here: the visible thinking state should
        // wait for the server-confirmed step-start event or running status.
        addToSet(setDispatchingChats, dispatchingChats, head.chatId);

        if (chatId() === head.chatId) {
          setTimeline([
            ...timeline(),
            {
              type: "step",
              step: `opt-${head.id}`,
              kind: "agent:UserInput",
              status: "agent:Done",
              at: Date.now(),
              text: head.text,
              ...(head.attachments?.length
                ? { attachments: head.attachments }
                : {}),
            } as TimelineItem,
          ]);
          forgetChatCache(head.chatId);
        }
        // /api/run now returns immediately; the chat driver runs the agent
        // loop in the background. Keep the local dispatch lock until
        // step-start/step-end (or an error) so follow-up messages remain
        // queued/editable without showing the thinking indicator early.
        const r = await api.step(head.chatId, head.text, head.attachments || []);
        if (!r.ok) {
          reportError(`step ${head.chatId}`, r.error);
          deleteFromSet(setDispatchingChats, dispatchingChats, head.chatId);
        }
      }
    } finally {
      draining = false;
    }
  }

  function touchModelMru(model: string | null | undefined) {
    const normalized = String(model ?? "").trim();
    if (!normalized) return;
    setModelMru((current) => {
      const next = normalizeModelMru([normalized, ...current.filter((m) => m !== normalized)]);
      persistModelMru(next);
      return next;
    });
  }

  async function deleteMessage(step: string) {
    const id = chatId();
    if (!id) return;
    const r = await api.deleteMessage(id, step);
    if (!r.ok) {
      reportError("hide message", r.error);
      return;
    }
    await refreshTimeline();
  }

  async function restoreMessage(step: string) {
    const id = chatId();
    if (!id) return;
    const r = await api.restoreMessage(id, step);
    if (!r.ok) {
      reportError("restore message", r.error);
      return;
    }
    await refreshTimeline();
  }

  async function setSelectedModel(model: string | null) {
    const id = chatId();
    if (!id) return;
    const requestSeq = ++chatModelRequestSeq;
    const r = await api.setChatModel(id, model);
    if (chatId() !== id || requestSeq !== chatModelRequestSeq) return;
    if (r.ok) {
      setChatModel(r.value);
      touchChatCache(id, { model: r.value });
      touchModelMru(r.value.effectiveModelId || r.value.effectiveModel || model);
      applyChatModelToSummary(r.value);
    } else {
      reportError(`set model ${id}`, r.error);
    }
  }

  async function setSelectedEffort(effort: string | null) {
    const id = chatId();
    if (!id) return;
    const requestSeq = ++chatModelRequestSeq;
    const r = await api.setChatEffort(id, effort);
    if (chatId() !== id || requestSeq !== chatModelRequestSeq) return;
    if (r.ok) {
      setChatModel(r.value);
      touchChatCache(id, { model: r.value });
      setChatMemory((current) => {
        const next = { ...current };
        if (r.value.selectedEffort) next[id] = { effort: r.value.selectedEffort };
        else delete next[id];
        return next;
      });
      refreshChatMemory([id]);
    } else {
      reportError(`set effort ${id}`, r.error);
    }
  }

  async function renameChat(id: string, title: string | null) {
    const r = await api.renameChat(id, title);
    if (r.ok) updateChatSummary(id, { title: r.value.title });
    else reportError(`rename ${id}`, r.error);
  }

  async function archiveChat(id: string, archived: boolean) {
    const previous = chats().find((chat) => chat.chatId === id) ?? null;
    const optimisticArchivedAt = archived ? Date.now() : null;

    // Move the row immediately. A full chat refresh is comparatively expensive
    // because it scans per-chat refs/facts, so waiting for it makes archive feel
    // like it takes multiple seconds to propagate in the sidebar.
    setChats((current) =>
      current.map((chat) =>
        chat.chatId === id
          ? { ...chat, archived, archivedAt: optimisticArchivedAt }
          : chat,
      ),
    );

    const r = await api.archiveChat(id, archived);
    if (!r.ok) {
      if (previous) {
        setChats((current) =>
          current.map((chat) => (chat.chatId === id ? previous : chat)),
        );
      }
      reportError(`${archived ? "archive" : "unarchive"} ${id}`, r.error);
      return;
    }

    setChats((current) =>
      current.map((chat) =>
        chat.chatId === r.value.chatId
          ? { ...chat, archived: r.value.archived, archivedAt: r.value.archivedAt }
          : chat,
      ),
    );
  }

  async function exportChat(id: string) {
    notify("chat export", "uploading…");

    // Open the tab synchronously from the click handler. If we wait until after
    // the async upload completes, browsers commonly treat it as an unsolicited
    // popup and silently block it.
    const tab = window.open("about:blank", "_blank");
    const writeTab = (title: string, body: string) => {
      if (!tab) return;
      try {
        tab.document.title = title;
        tab.document.body.style.font = "14px/1.45 system-ui, sans-serif";
        tab.document.body.style.padding = "2rem";
        tab.document.body.textContent = body;
      } catch {
        // The tab may have navigated cross-origin or been closed by the user.
      }
    };
    writeTab("Exporting chat…", "Uploading chat export…");

    const r = await api.chatExport(id);
    if (!r.ok) {
      writeTab("Chat export failed", `Chat export failed:

${r.error.message}`);
      reportError(`export ${id}`, r.error);
      return;
    }

    notify("chat export", `${Math.round(r.value.bytes / 1024)} KB uploaded`);
    if (tab && !tab.closed) {
      try {
        tab.location.assign(r.value.url);
      } catch {
        writeTab("Chat export uploaded", `Chat export uploaded:

${r.value.url}`);
      }
    } else {
      window.open(r.value.url, "_blank", "noopener,noreferrer");
    }
  }

  async function interruptAgent() {
    const id = chatId();
    if (!id) return;
    if (!activeChats().has(id)) return;
    // Drop the chat from activeChats optimistically so the UI reflects the
    // cancel immediately; step-end from the aborted task will arrive shortly
    // and idempotently keep it removed.
    deleteFromSet(setActiveChats, activeChats, id);
    deleteFromSet(setDispatchingChats, dispatchingChats, id);
    setDraftReply(null);
    // Kick the queue drainer optimistically: server-side step-end may be
    // delayed if the aborted task is parked in a blocking V8 call, but the
    // chat is no longer busy from the UI's perspective so any queued
    // messages should be sent now.
    if (pending().length > 0) queueMicrotask(drain);
    const r = await api.interrupt(id);
    if (!r.ok) reportError(`interrupt ${id}`, r.error);
  }

  // -- WS routing --------------------------------------------------------

  // Coalesce bursts of WS events into a single refresh per target. WS can
  // emit ~10 events for a single agent step (ref+facts changes), so without
  // debouncing we fire 10 describe calls back to back.
  const debounce = (fn: () => void, ms = 60) => {
    let t: number | null = null;
    const run = () => {
      if (t != null) return;
      t = window.setTimeout(() => {
        t = null;
        fn();
      }, ms);
    };
    run.cancel = () => {
      if (t == null) return;
      window.clearTimeout(t);
      t = null;
    };
    return run;
  };
  const refreshTimelineSoon = debounce(refreshTimeline);
  const refreshChatsSoon = debounce(refreshChats);
  // Triples/vocabulary cost a full scan of every chat's facts. Coalesce
  // bursts more aggressively than other refreshes so a thinking agent
  // hammering chat facts doesn't starve the worker pool.
  const refreshTriplesSoon = debounce(refreshTriples, 1500);
  const refreshVocabularySoon = debounce(refreshVocabulary, 1500);
  const refreshUisSoon = debounce(refreshUis);
  const refreshChatUisSoon = debounce(refreshChatUis);

  const events = new EventStream();
  bindWS(events);
  const offEvents = events.on((ev: any) => {
    if (ev.kind === "ping") return;
    if (ev.kind === "online") {
      setConnected(true);
      return;
    }
    if (ev.kind === "offline") {
      setConnected(false);
      return;
    }
    if (ev.kind === "reconnect") {
      // WS just (re)connected; resync everything that could have drifted.
      refreshChats();
      refreshTimeline();
      refreshTriples();
      refreshVocabulary();
      refreshUis();
      refreshChatUis();
      refreshMcpServers();
      return;
    }
    if (ev.kind === "file-diff") {
      const cid = chatId();
      if (cid && ev.chatId === cid) {
        const id = ev.stepId || ev.hash || `file-diff-${ev.path}-${ev.at}`;
        setTimeline((items) => compactTimelineRows([
          ...items.filter((item: any) => !(item.type === "file-diff" && item.id === id)),
          {
            type: "file-diff",
            id,
            step: ev.stepId,
            chatId: ev.chatId,
            path: ev.path,
            diff: ev.diff,
            stats: ev.stats,
            before: ev.before,
            after: ev.after,
            hash: ev.hash,
            at: ev.at || Date.now(),
          } as TimelineItem,
        ]));
        void refreshMatchingRepoFiles(ev.path);
      }
      return;
    }
    if (ev.kind === "memory-diff") {
      const cid = chatId();
      if (cid && ev.chatId === cid) {
        const id = ev.stepId || ev.hash || `memory-diff-${ev.refName}-${ev.at}`;
        setTimeline((items) => compactTimelineRows([
          ...items.filter((item: any) => !(item.type === "memory-diff" && item.id === id)),
          {
            type: "memory-diff",
            id,
            step: ev.stepId,
            chatId: ev.chatId,
            refName: ev.refName,
            graph: ev.graph,
            path: ev.path,
            diff: ev.diff,
            stats: ev.stats,
            before: ev.before,
            after: ev.after,
            hash: ev.hash,
            at: ev.at || Date.now(),
          } as TimelineItem,
        ]));
      }
      return;
    }
    if (ev.kind === "tokens") {
      const cid = chatId();
      if (cid && ev.chatId === cid) {
        const used = Number(ev.used);
        if (Number.isFinite(used)) {
          setTokens((cur) => {
            const budget = Number.isFinite(Number(ev.budget))
              ? Number(ev.budget)
              : Number(cur?.budget ?? 0);
            const threshold = Number.isFinite(Number(ev.threshold))
              ? Number(ev.threshold)
              : Number(cur?.threshold ?? 0);
            const explicitFraction = Number(ev.fraction);
            return {
              used,
              budget,
              threshold,
              fraction: Number.isFinite(explicitFraction)
                ? explicitFraction
                : budget > 0 ? used / budget : 0,
            };
          });
        }
      }
      return;
    }
    if (ev.kind === "draft") {
      const cid = chatId();
      if (cid && ev.chatId === cid) {
        setDraftReply({ chatId: cid, draftId: ev.draftId, content: ev.content });
      }
      return;
    }
    if (ev.kind === "draft-end") {
      const cur = draftReply();
      if (cur && cur.draftId === ev.draftId) setDraftReply(null);
      return;
    }
    if (ev.kind === "step-start") {
      addToSet(setActiveChats, activeChats, ev.chatId);
      setChatStartedAt(ev.chatId, ev.at);
      deleteFromSet(setDispatchingChats, dispatchingChats, ev.chatId);
      updateChatSummary(ev.chatId, { status: "agent:Running", runningStartedAt: Number(ev.at) || Date.now() });
      return;
    }
    if (ev.kind === "step-end") {
      deleteFromSet(setActiveChats, activeChats, ev.chatId);
      deleteChatStartedAt(ev.chatId);
      deleteFromSet(setDispatchingChats, dispatchingChats, ev.chatId);
      updateChatSummary(ev.chatId, { status: "agent:Done", runningStartedAt: null });
      queueMicrotask(drain);
      return;
    }
    const ref = ev.ref || "";
    const cid = chatId();
    if (
      ref.startsWith("chat/") &&
      (ref.endsWith("/facts") || ref.endsWith("/head") || ref.endsWith("/compaction"))
    ) {
      forgetChatCache(ref.split("/")[1] ?? "");
    }
    if (
      cid &&
      (ref === `chat/${cid}/facts` || ref === `chat/${cid}/head` || ref === `chat/${cid}/compaction`)
    ) {
      refreshTimelineSoon();
      // The Reply step that follows clears the draft for us.
      if (ref === `chat/${cid}/head`) setDraftReply(null);
    }
    if (ref.startsWith("chat/") && ref.endsWith("/last-at")) {
      const changedChatId = ref.split("/")[1];
      if (changedChatId) updateChatSummary(changedChatId, { lastAt: Date.now() });
    } else if (
      ref.startsWith("chat/") &&
      (ref.endsWith("/created-at") || ref.endsWith("/title") || ref.endsWith("/archived-at"))
    ) {
      refreshChatsSoon();
    }
    if (cid && ref === `chat/${cid}/facts`) {
      refreshChatModel();
    }
    // Chat fact changes only invalidate triples/vocab when the user is
    // actually looking at the memory view. Otherwise the sidebar's predicate
    // count is the only consumer and a slightly stale number is fine — far
    // better than running a multi-chat full scan on every step the agent
    // takes.
    const isMemoryRef =
      ref === "memory/facts" ||
      ref === "vocab/facts" ||
      (ref.startsWith("memory/project/") && ref.endsWith("/facts"));
    const isChatFactRef =
      ref.startsWith("chat/") && ref.endsWith("/facts");
    const memoryViewOpen = view() === "memory";
    if (isChatFactRef) refreshChatMemory([ref.split("/")[1] ?? ""]);
    if (isMemoryRef || (isChatFactRef && memoryViewOpen)) {
      refreshTriplesSoon();
      refreshVocabularySoon();
    }
    if (ref.startsWith("ui/") || ref.startsWith("uiinst/")) {
      refreshUisSoon();
      refreshChatUisSoon();
    }
    if (ref.startsWith("mcp/")) {
      refreshMcpServers();
    }
  });

  async function completeInitialOAuthCallback() {
    if (!initialOAuthCallback) return;
    if ("error" in initialOAuthCallback) {
      console.error("mcp-oauth", initialOAuthCallback.error);
      alert(initialOAuthCallback.error);
      history.replaceState({}, "", "/mcp");
      return;
    }
    const r = await api.mcpOAuthComplete(initialOAuthCallback.state, initialOAuthCallback.code);
    if (!r.ok) {
      console.error("mcp-oauth", r.error);
      alert(r.error.message);
    } else {
      void mcpListSingle();
    }
    history.replaceState({}, "", "/mcp");
  }

  // -- bootstrap ---------------------------------------------------------

  loadPersistentChatCache();

  // Set up disposables synchronously so they bind to the current Solid
  // owner. After any await, getOwner() is null and onCleanup leaks.
  events.start();
  void completeInitialOAuthCallback();
  onCleanup(() => {
    offEvents();
    events.stop();
    refreshTimelineSoon.cancel();
    refreshChatsSoon.cancel();
    refreshTriplesSoon.cancel();
    refreshVocabularySoon.cancel();
    refreshUisSoon.cancel();
    refreshChatUisSoon.cancel();
  });
  onCleanup(() => {
    if (persistChatCacheSoonHandle !== null) window.clearTimeout(persistChatCacheSoonHandle);
    persistChatCache();
  });

  // Heartbeat: catches anything missed during a WS reconnect.
  //
  // Timeline is single-chat scoped, so refresh it even while the agent is
  // thinking — otherwise the timeline goes stale during long turns. Avoid
  // refreshing the full chat list here; WS events and describe responses patch
  // the sidebar fields that change during a run.
  //
  // Triples + vocabulary do a full scan of every chat's facts; firing them
  // every 10s while an agent is hammering chat facts starves the worker
  // pool. Only run them when idle, and only when the user is on the memory
  // view (the sidebar predicate count tolerates staleness).
  const heartbeat = window.setInterval(async () => {
    await refreshTimeline();
    if (!thinking() && view() === "memory") {
      await refreshTriples();
      await refreshVocabulary();
      await refreshChatMemory();
    }
  }, 10_000);
  onCleanup(() => clearInterval(heartbeat));

  // Esc cancels the running agent. We listen on document so it works
  // regardless of focus (textarea, sidebar, anywhere). Skipping when there's
  // no active chat or when the user is in the middle of a native action
  // (IME composition, modal prompt) — those events have isComposing or are
  // intercepted by the browser before we see them.
  const escHandler = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (e.isComposing) return;
    const id = chatId();
    if (!id || !activeChats().has(id)) return;
    e.preventDefault();
    interruptAgent();
  };
  document.addEventListener("keydown", escHandler);
  onCleanup(() => document.removeEventListener("keydown", escHandler));

  async function start() {
    setStartupLoading(true);
    setStartupLoadingMessage("Loading chat…");
    try {
      const initialView = parseLocation().view;
    // If the user lands directly on /memory, start loading the data that backs
    // the memory stats immediately. Do not wait for the chat list first: that
    // request can be slow or blocked behind other work, leaving the page stuck
    // showing the initial 0 graphs / 0 predicates even though memory exists.
      if (initialView === "memory") {
        setStartupLoadingMessage("Loading memory data…");
        refreshTriples();
        refreshVocabulary();
      }
    // Refresh chats so the sidebar populates. Triples and vocabulary do full
    // scans across every chat's facts and can take seconds, so they load in the
    // background instead of holding the UI on "no chats yet".
      setStartupLoadingMessage("Loading chat…");
      await refreshChats();
      if (initialView === "apps") {
        setStartupLoadingMessage("Loading apps…");
        await refreshUis();
      } else refreshUis();
      refreshMcpServers();
      const loc = parseLocation();
      const list = chats();
    if (loc.view === "memory" || loc.view === "apps" || loc.view === "mcp") {
      if (loc.view === "apps" && loc.instanceId) {
        setView("apps");
        setStartupLoadingMessage("Opening app…");
        await openUiFromRoute(loc.instanceId, "replace");
        if (pending().length > 0) drain();
        return;
      }
      if (list.length > 0) {
        setChatId(list[0]!.chatId);
        loadWipText(list[0]!.chatId);
        setStartupLoadingMessage("Loading chat…");
        await Promise.all([refreshTimeline(), refreshChatModel()]);
      }
      if (loc.view === "apps") setView("apps");
      else if (loc.view === "mcp") setView("mcp");
      replaceUrl();
      if (pending().length > 0) drain();
      return;
    }
    const desired = loc.chatId;
    let target: string | null = null;
    // Respect an explicit /chat/<id> even if the chat summary list is stale
    // or from an older store that lacks chat metadata; describe can still load
    // the chat-scoped refs/facts directly.
    if (desired) target = desired;
    else if (list.length > 0) target = list[0]!.chatId;
      if (target) {
        setStartupLoadingMessage("Loading chat…");
        await selectChat(target, true);
      }
    // Drain after selectChat so chatId is set and the optimistic UserInput
    // row gets added to the timeline (otherwise the user posts a message,
    // hits reload, and sees only "agent thinking…" until the server's
    // UserInput fact catches up).
      if (pending().length > 0) drain();
    } finally {
      setStartupLoading(false);
    }
  }

  // 1-second tick for relative-time labels.
  const [tick, setTick] = createSignal(0);
  const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
  onCleanup(() => clearInterval(timer));

  return {
    startupLoading,
    startupLoadingMessage,
    chats,
    chatsLoaded,
    chatId,
    currentChatTitle,
    currentChatPath,
    currentChatWorktreePath,
    chatFocusRequest,
    timeline,
    timelineJumpRequest,
    jumpToTimeline,
    timelineLimit,
    expansionStore: () => expansionStore,
    hiddenTimelineItems,
    olderTimelineLoadCount,
    compactions,
    compactionsLoading,
    loadedChatId,
    totalFacts,
    totalTurns,
    totalSteps,
    totalCodeCalls,
    tokens,
    chatModel,
    modelMru,
    chatMemory,
    triples,
    triplesLoaded,
    triplesRemovedMode,
    setTriplesRemovedMode,
    vocabulary,
    vocabularyLoaded,
    uiApps,
    uiAppsLoaded,
    mcpServers,
    mcpServersLoaded,
    chatUiApps,
    uiInstances,
    openUiId,
    openUiInstanceId,
    thinking,
    thinkingStartedAt,
    isChatActive: (id: string) => activeChats().has(id),
    connected,
    draftReply,
    pending,
    wipText,
    setWipText,
    sidebarW,
    setSidebarW,
    collapsed,
    setCollapsed,
    rightSidebarTabs,
    rightSidebarW,
    setRightSidebarW,
    rightSidebarCollapsed,
    setRightSidebarCollapsed,
    toggleRightSidebarCollapsed,
    activeRightSidebarTabId,
    activeRightSidebarTab,
    setActiveRightSidebarTab,
    closeRightSidebarTab,
    openDiffInSidebar,
    openRepoFile,
    openFileInSidebar,
    closeRepoFile,
    archivedCollapsed,
    setArchivedCollapsed,
    tick,
    view,
    focusedSubject,
    focusedGraph,
    showMemory,
    showApps,
    showMcp,
    showChat,
    openUi,
    removeUi,
    closeUi,
    selectChat,
    createChat,
    removeChat,
    removeGraph,
    renameChat,
    archiveChat,
    exportChat,
    setSelectedModel,
    setSelectedEffort,
    refreshChatModel,
    refreshChatMemory,
    sendMessage: enqueueMessage,
    deleteMessage,
    restoreMessage,
    interruptAgent,
    editPending,
    removePending,
    refreshTimeline,
    loadOlderTimeline,
    refreshCompactions,
    refreshChats,
    refreshTriples,
    refreshVocabulary,
    refreshUis,
    refreshMcpServers,
    refreshChatUis,
    retract: async (s: string, p: string, o: string) => {
      const r = await api.retract(s, p, o);
      if (!r.ok) reportError("retract", r.error);
      await refreshTriples();
      await refreshVocabulary();
    },
    removeTriple: async (graph: string, s: string, p: string, o: string) => {
      const r = await api.tripleRemove(graph, s, p, o);
      if (!r.ok) reportError("delete triple", r.error);
      await refreshTriples();
      await refreshVocabulary();
    },
    restoreTriple: async (graph: string, s: string, p: string, o: string) => {
      const r = await api.tripleRestore(graph, s, p, o);
      if (!r.ok) reportError("undelete triple", r.error);
      await refreshTriples();
      await refreshVocabulary();
    },
    submitForm: async (
      requestId: string,
      values: Record<string, unknown>,
    ) => {
      const r = await api.submit(chatId()!, requestId, values);
      if (!r.ok) reportError("submit form", r.error);
      await refreshTimeline();
    },
    cancelForm: async (requestId: string) => {
      const r = await api.cancel(chatId()!, requestId);
      if (!r.ok) reportError("cancel form", r.error);
      await refreshTimeline();
    },
    toasts,
    dismissToast,
    notify,
    start,
  };
}

export function relativeTime(ms: number, _tick: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))}h ago`;
  return `${Math.round(diff / (24 * 60 * 60_000))}d ago`;
}

export function absoluteTime(ms: number): string {
  return ms ? new Date(ms).toISOString() : "";
}
