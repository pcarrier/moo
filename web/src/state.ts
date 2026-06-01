// Reactive Solid state for the moo frontend.
//
// One ChatState owns the timeline + memory + sidebar signals. Mutations come
// from two sources: explicit user actions (createSignal setters) and the
// backend WS event stream (which schedules refresh fetches).

import { createSignal, createEffect, on, onCleanup, untrack } from "solid-js";

import {
  api,
  bindWS,
  type ApiResult,
  type ChatSummary,
  type ChatId,
  type StepId,
  type CompactionsValue,
  type ImageAttachment,
  type AgentTodo,
  type FsEntry,
  type Predicate,
  type ChatModelInfo,
  type DescribeOverviewValue,
  type DescribeSnapshotValue,
  type DescribeTimelinePage,
  type DescribeUpdateValue,
  type TimelineItem,
  type DiffStats,
  type FileDiffItem,
  type LogItem,
  type DescribeTrailPage,
  type MemoryDiffItem,
  type TodoDiffItem,
  type StoreObject,
  type PointerEntry,
  type Triple,
  type TriplesValue,
  type UiApp,
  type UiInstance,
  type McpServerConfig,
  type SkillSummary,
  type V8StatsValue,
  type LlmAuthSettings,
  type OtelSettingsValue,
  type V8SettingsValue,
} from "./api";
import { collapseHome, setHomeDir_ } from "./paths";
import { EventStream, type Event as WsEvent } from "./events";
import { createChatSettingsWriteBarrier } from "./chatSettingsBarrier";
import { checkPsk, getPsk, setPsk } from "./auth";
import {
  mergedFileDiffs,
  mergedMemoryDiffs,
  sameDiffPath,
  sameDiffPathInRoot,
  type MemoryGraphDiffSummary,
} from "./diffs";
import { mergeTokenProgress, type TokenProgressValue } from "./tokenProgress";
import {
  clampRightSidebarWidth,
  persistRightSidebarLayout,
  readRightSidebarLayout,
  rightSidebarLayout,
  sidebarLayout,
  type RightSidebarLayoutState,
} from "./state/layout";
import { normalizeEffort } from "./state/effort";
import { hasRestartableConversationState } from "./state/resume";
import { hasOpenModalDialog } from "./modal";
import {
  expectedChatWorktreePath,
  withExpectedChatWorktreePath,
  withExpectedChatWorktreePaths,
} from "./state/chatPaths";
import {
  normalizeModelMru,
  readModelMru,
  persistModelMru,
} from "./state/modelMru";
import { createSingleFlight, retryChatLoad } from "./state/async";
import { createToastSystem, wsErrorMessage, type Toast } from "./state/toasts";
import {
  chatCacheHasData,
  isDescribeFreshForSummary,
  mergeCachedOverviewWithSummary,
  normalizeChatCacheEntry,
  pruneCachedPages,
  timelineCacheKey,
  trailCacheKey,
} from "./state/chatCache";
import {
  compactTimelineRows as compactTimelineRowsWithOptions,
  mergeTimelineRows as mergeTimelineRowsWithOptions,
  mergeTimelineUpdateRows as mergeTimelineUpdateRowsWithOptions,
  newestTimelineWatermark,
  sortTimelineItems,
  timelineItemKey,
  type TimelineRowCompactionOptions,
} from "./state/timelineRows";
import { displayChatId } from "./state/time";
import type {
  BrowserNavState,
  CachedTimelinePage,
  CachedTrailPage,
  ChatCacheEntry,
  DiffContentMode,
  DiffViewState,
  JsonPreviewFile,
  OpenRepoFile,
  RightSidebarState,
  RightSidebarTab,
  StorePreviewFile,
} from "./state/types";
export type {
  BrowserNavState,
  DiffContentMode,
  DiffViewState,
  JsonPreviewFile,
  OpenRepoFile,
  RightSidebarTab,
  StorePreviewFile,
} from "./state/types";
export { absoluteTime, displayChatId, relativeTime } from "./state/time";

const INITIAL_TIMELINE_LIMIT = 160;
const TIMELINE_PAGE_SIZE = 160;
const LIVE_TIMELINE_SLACK = 80;
const MAX_REMEMBERED_TIMELINE_KEYS = 1200;
const MAX_DISMISSED_REPLIES = 24;
const RIGHT_SIDEBAR_CHAT_MAX = 24;
const MISSING_REPO_FILE_REFRESH_MS = 2000;
const STALE_ACTIVE_CHAT_REFRESH_GRACE_MS = 2000;

const RIGHT_SIDEBAR_VIEW_SCOPE_IDS = [
  "view:apps",
  "view:facts",
  "view:pointers",
  "view:skills",
  "view:v8",
];
const RIGHT_SIDEBAR_TABS_MAX = 8;
const RIGHT_SIDEBAR_DIFF_EXPANSION_STATE_MAX = 300;
const CHAT_CACHE_MAX = 12;
const CHAT_CACHE_KEY = "moo.chat.cache.v2";
const CHAT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CHAT_CACHE_TIMELINE_PAGES_MAX = 5;
const CHAT_CACHE_TRAIL_PAGES_MAX = 5;

export type Bag = ReturnType<typeof createState>;

export type DismissedReply = {
  id: string;
  chatId: string;
  draftId: string;
  content: string;
  reasoningContent?: string;
  at: number;
};

type DraftReply = {
  kind?: "reply" | "compaction";
  chatId: string;
  draftId: string;
  content: string;
  reasoningContent?: string;
  reasoningStreaming?: boolean;
  model?: string;
  effort?: string;
  at: number;
};

export function createState() {
  const chatModelsSingle = createSingleFlight(
    (chatId: ChatId) => api("chat-models", { chatId }),
    (id: string) => id,
  );
  const uiListSingle = createSingleFlight(
    () => api("ui-list", {}),
    () => "ui-list",
  );
  const uiChatSingle = createSingleFlight(
    (chatId: ChatId) => api("ui-chat", { chatId }),
    (id: string) => id,
  );
  const mcpListSingle = createSingleFlight(
    () => api("mcp-list", {}),
    () => "mcp-list",
  );
  const settingsSingle = createSingleFlight(
    () => api("llm-auth-get", {}),
    () => "settings",
  );
  const v8SettingsSingle = createSingleFlight(
    () => api("v8-settings-get", {}),
    () => "v8-settings",
  );
  const otelSettingsSingle = createSingleFlight(
    () => api("otel-config-get", {}),
    () => "otel-settings",
  );
  const skillsListSingle = createSingleFlight(
    (
      opts: {
        enabled?: boolean;
        chatId?: string | null;
        root?: string | null;
      } = {},
    ) => api("skills-list", opts),
    (opts?: {
      enabled?: boolean;
      chatId?: string | null;
      root?: string | null;
    }) =>
      `skills:${opts?.chatId ?? ""}:${opts?.root ?? ""}:${opts?.enabled ?? ""}`,
  );
  const [startupLoading, setStartupLoading] = createSignal(true);
  const [chats, setChats] = createSignal<ChatSummary[]>([]);
  const [chatsLoaded, setChatsLoaded] = createSignal(false);
  const [archivedCollapsed, setArchivedCollapsed] = createSignal(
    localStorage.getItem(sidebarLayout.archivedCollapsedKey) !== "0",
  );
  const [chatId, setChatId] = createSignal<string | null>(null);
  const currentChat = () =>
    chats().find((chat) => chat.chatId === chatId()) ?? null;
  const currentChatTitle = () => {
    const chat = currentChat();
    if (chat) return chat.title?.trim() || displayChatId(chat.chatId);
    const id = chatId();
    return id ? displayChatId(id) : null;
  };
  const [chatFocusRequest, setChatFocusRequest] = createSignal(0);
  const requestChatComposerFocus = () =>
    setChatFocusRequest((request) => request + 1);
  const clearChatFocusRequest = (request: number) => {
    setChatFocusRequest((current) => (current === request ? 0 : current));
  };
  const [resumeOfferRequest, setResumeOfferRequest] = createSignal(0);
  const [timeline, setTimeline] = createSignal<TimelineItem[]>([]);
  const [timelineJumpRequest, setTimelineJumpRequest] = createSignal<{
    id: number;
    target: { key?: string; at?: number; id?: string };
  } | null>(null);
  let timelineJumpSeq = 0;
  const jumpToTimeline = (target: {
    key?: string;
    at?: number;
    id?: string;
  }) => {
    setTimelineJumpRequest({ id: ++timelineJumpSeq, target });
  };
  const [timelineLimit, setTimelineLimit] = createSignal(
    INITIAL_TIMELINE_LIMIT,
  );
  const [timelineExpansionVersion, setTimelineExpansionVersion] =
    createSignal(0);
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
  const [olderTimelineLoading, setOlderTimelineLoading] = createSignal(false);
  const [timelineRefreshing, setTimelineRefreshing] = createSignal(false);
  const [trail, setTrail] = createSignal<TimelineItem[]>([]);
  const [compactions, setCompactions] = createSignal<CompactionsValue | null>(
    null,
  );
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
  const [tokens, setTokens] = createSignal<TokenProgressValue | null>(null);
  const tokensByChat = new Map<string, TokenProgressValue>();

  function currentTokensForChat(id: string): TokenProgressValue | null {
    return tokensByChat.get(id) ?? null;
  }

  function applyTokensForChat(
    id: string,
    next: TokenProgressValue,
    opts: { active?: boolean; reset?: boolean } = {},
  ) {
    const merged = mergeTokenProgress(
      currentTokensForChat(id),
      next,
      opts.active === true,
      { reset: opts.reset === true },
    );
    tokensByChat.set(id, merged);
    if (chatId() === id) setTokens(merged);
  }

  function showTokensForChat(id: string | null) {
    setTokens(id ? currentTokensForChat(id) : null);
  }

  function forgetTokensForChat(id: string) {
    tokensByChat.delete(id);
    if (chatId() === id) showTokensForChat(id);
  }

  const [todos, setTodos] = createSignal<AgentTodo[]>([]);
  const todosByChat = new Map<string, AgentTodo[]>();

  function currentTodosForChat(id: string): AgentTodo[] {
    return todosByChat.get(id) ?? [];
  }

  function applyTodosForChat(id: string, next: AgentTodo[]) {
    todosByChat.set(id, next);
    if (chatId() === id) setTodos(next);
  }

  function showTodosForChat(id: string | null) {
    setTodos(id ? currentTodosForChat(id) : []);
  }
  const [triples, setTriples] = createSignal<Triple[]>([]);
  const [graphSummaries, setGraphSummaries] = createSignal<
    import("./api").GraphSummary[]
  >([]);
  const [graphSummariesLoaded, setGraphSummariesLoaded] = createSignal(false);
  const [pointers, setPointers] = createSignal<PointerEntry[]>([]);
  const [pointersLoaded, setPointersLoaded] = createSignal(false);
  const [triplesLoaded, setTriplesLoaded] = createSignal(false);
  const [triplesRemovedMode, setTriplesRemovedMode] = createSignal<
    "exclude" | "include" | "only"
  >("exclude");
  const [triplesTruncated, setTriplesTruncated] = createSignal(false);
  const [triplesLimit, setTriplesLimit] = createSignal<number | null>(null);
  const [triplesTotal, setTriplesTotal] = createSignal<number | null>(null);
  const initialLoc = parseLocation();
  let loadedTriplesGraph: string | null =
    initialLoc.view === "facts" ? initialLoc.graph : null;
  let loadedTriplesRemoved: "exclude" | "include" | "only" = "exclude";
  const [vocabulary, setVocabulary] = createSignal<Predicate[]>([]);
  const [vocabularyLoaded, setVocabularyLoaded] = createSignal(false);
  const [chatMemory, setChatMemory] = createSignal<
    Record<string, { effort: string | null }>
  >({});
  let chatMemoryRequestSeq = 0;
  let chatModelRequestSeq = 0;
  let chatArchiveWriteVersion = 0;
  const chatModelWriteSeqByChat = new Map<string, number>();
  const chatEffortWriteSeqByChat = new Map<string, number>();
  const chatArchiveWriteSeqByChat = new Map<string, number>();
  const chatArchiveWriteVersionByChat = new Map<string, number>();
  const pendingModelWritesByChat = new Map<
    string,
    { seq: number; model: string | null }
  >();
  const pendingEffortWritesByChat = new Map<
    string,
    { seq: number; effort: string | null }
  >();
  const pendingArchiveWritesByChat = new Map<
    string,
    { seq: number; archived: boolean; archivedAt: number | null }
  >();
  let chatDeleteSeq = 0;
  const chatDeleteSeqByChat = new Map<string, number>();
  const chatSettingsWrites = createChatSettingsWriteBarrier();

  async function waitForChatSettingsWrites(id: string) {
    await chatSettingsWrites.wait(id);
  }

  type ChatArchiveRefreshGuard = {
    startedArchiveWriteVersion: number;
    pendingArchiveSeqsAtStart: Map<string, number>;
  };

  function captureChatArchiveRefreshGuard(): ChatArchiveRefreshGuard {
    return {
      startedArchiveWriteVersion: chatArchiveWriteVersion,
      pendingArchiveSeqsAtStart: new Map(
        Array.from(pendingArchiveWritesByChat, ([id, pending]) => [
          id,
          pending.seq,
        ]),
      ),
    };
  }

  function applyChatArchiveRefreshGuard(
    list: ChatSummary[],
    guard: ChatArchiveRefreshGuard,
  ): ChatSummary[] {
    const currentById = new Map(chats().map((chat) => [chat.chatId, chat]));
    let changed = false;
    const guarded = list.map((chat) => {
      const pending = pendingArchiveWritesByChat.get(chat.chatId);
      const writeVersion = chatArchiveWriteVersionByChat.get(chat.chatId) ?? 0;
      const latestWriteSeq = chatArchiveWriteSeqByChat.get(chat.chatId) ?? 0;
      const pendingSeqAtStart =
        guard.pendingArchiveSeqsAtStart.get(chat.chatId) ?? 0;
      const shouldKeepCurrentArchiveState =
        writeVersion > guard.startedArchiveWriteVersion ||
        (pendingSeqAtStart > 0 && pendingSeqAtStart === latestWriteSeq);
      const current = shouldKeepCurrentArchiveState
        ? currentById.get(chat.chatId)
        : null;
      const archived = pending?.archived ?? current?.archived ?? chat.archived;
      const archivedAt = pending
        ? pending.archivedAt
        : current
          ? current.archivedAt
          : chat.archivedAt;
      if (archived === chat.archived && archivedAt === chat.archivedAt) {
        return chat;
      }
      changed = true;
      return { ...chat, archived, archivedAt };
    });
    return changed ? guarded : list;
  }

  function modelWithPendingSelection(
    model: ChatModelInfo,
    selectedModel: string | null,
  ): ChatModelInfo {
    if (!selectedModel) return model;
    const option = model.modelOptions?.find(
      (m) => m.id === selectedModel || m.model === selectedModel,
    );
    const colon = selectedModel.indexOf(":");
    const provider =
      option?.provider ??
      (colon > 0 ? selectedModel.slice(0, colon) : model.provider);
    const modelName =
      option?.model ??
      (colon > 0 ? selectedModel.slice(colon + 1) : selectedModel);
    const modelId = option?.id ?? selectedModel;
    return {
      ...model,
      provider,
      selectedProvider: provider,
      selectedModel: modelName,
      selectedModelId: modelId,
      effectiveModel: modelName,
      effectiveModelId: modelId,
      supportsAttachments:
        option?.supportsAttachments ?? model.supportsAttachments,
    };
  }

  function modelWithPendingWrites(
    id: string,
    model: ChatModelInfo,
  ): ChatModelInfo {
    let next = modelWithFactBackedEffort(id, model);
    const pendingModel = pendingModelWritesByChat.get(id);
    if (pendingModel)
      next = modelWithPendingSelection(next, pendingModel.model);
    return next;
  }

  function modelWithFactBackedEffort(
    id: string,
    model: ChatModelInfo,
  ): ChatModelInfo {
    const memory = chatMemory();
    if (!Object.prototype.hasOwnProperty.call(memory, id)) return model;
    const effort = normalizeEffort(memory[id]?.effort);
    const supportedEffort =
      effort && (model.efforts ?? []).includes(effort) ? effort : null;
    return {
      ...model,
      selectedEffort: supportedEffort,
      effectiveEffort: supportedEffort || model.defaultEffort,
    };
  }
  const [uiApps, setUiApps] = createSignal<UiApp[]>([]);
  const [uiAppsLoaded, setUiAppsLoaded] = createSignal(false);
  const [mcpServers, setMcpServers] = createSignal<McpServerConfig[]>([]);
  const [mcpServersLoaded, setMcpServersLoaded] = createSignal(false);
  const [skills, setSkills] = createSignal<SkillSummary[]>([]);
  const [skillsLoaded, setSkillsLoaded] = createSignal(false);
  const [v8Stats, setV8Stats] = createSignal<V8StatsValue | null>(null);
  const [v8StatsLoaded, setV8StatsLoaded] = createSignal(false);
  const [settingsCache, setSettingsCacheSignal] =
    createSignal<LlmAuthSettings | null>(null);
  function setSettingsCache(next: LlmAuthSettings) {
    setSettingsCacheSignal((current) => {
      const currentUpdatedAt = current?.updatedAt;
      const nextUpdatedAt = next.updatedAt;
      if (typeof currentUpdatedAt === "number") {
        if (
          typeof nextUpdatedAt !== "number" ||
          nextUpdatedAt < currentUpdatedAt
        )
          return current;
      }
      return next;
    });
  }
  const [v8SettingsCache, setV8SettingsCache] =
    createSignal<V8SettingsValue | null>(null);
  const [otelSettingsCache, setOtelSettingsCache] =
    createSignal<OtelSettingsValue | null>(null);
  const [settingsError, setSettingsError] = createSignal<string | null>(null);
  const [chatUiApps, setChatUiApps] = createSignal<UiApp[]>([]);
  const [uiInstances, setUiInstances] = createSignal<UiInstance[]>([]);
  const chatCache = new Map<string, ChatCacheEntry>();
  let persistChatCacheSoonHandle: number | null = null;

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
      const parsed = JSON.parse(raw) as {
        entries?: Array<[string, ChatCacheEntry]>;
      };
      for (const [id, rawEntry] of parsed.entries ?? []) {
        if (!id) continue;
        const entry = normalizeChatCacheEntry(rawEntry);
        if (entry) chatCache.set(id, entry);
      }
      pruneExpiredChatCache();
    } catch {
      localStorage.removeItem(CHAT_CACHE_KEY);
    }
  }

  function persistChatCache() {
    pruneExpiredChatCache();
    try {
      localStorage.setItem(
        CHAT_CACHE_KEY,
        JSON.stringify({ entries: [...chatCache.entries()] }),
      );
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
    const now = Date.now();
    const next = {
      ...(chatCache.get(id) ?? { updatedAt: 0 }),
      ...patch,
      accessedAt: now,
      updatedAt: now,
    };
    next.timelinePages = pruneCachedPages(
      next.timelinePages,
      CHAT_CACHE_TIMELINE_PAGES_MAX,
      next.activeTimelineKey,
    );
    next.trailPages = pruneCachedPages(
      next.trailPages,
      CHAT_CACHE_TRAIL_PAGES_MAX,
      next.activeTrailKey,
    );
    chatCache.delete(id);
    if (chatCacheHasData(next)) chatCache.set(id, next);
    while (chatCache.size > CHAT_CACHE_MAX) {
      const oldest = chatCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      chatCache.delete(oldest);
    }
    persistChatCacheSoon();
  }

  function chatOrderKey(chat: ChatSummary): number {
    return chat.lastAt || chat.createdAt || 0;
  }

  function sortChatsByRecency(list: ChatSummary[]): ChatSummary[] {
    // Match server-side ordering in harness/src/moo.ts so optimistic local
    // patches (e.g. bumped lastAt on step events) reorder the sidebar
    // immediately. Sidebar's FLIP effect animates the resulting move.
    return [...list].sort((a, b) => chatOrderKey(b) - chatOrderKey(a));
  }

  function updateChatSummary(id: string, patch: Partial<ChatSummary>) {
    setChats((current) => {
      const next = current.map((chat) =>
        chat.chatId === id ? { ...chat, ...patch } : chat,
      );
      // Only resort when an order-affecting field changed; status/title/etc.
      // shouldn't churn the array identity unnecessarily.
      if ("lastAt" in patch || "createdAt" in patch) {
        return sortChatsByRecency(next);
      }
      return next;
    });
  }

  function applyChatModelToSummary(model: ChatModelInfo) {
    updateChatSummary(model.chatId, {
      selectedModel: model.selectedModel,
      model: model.effectiveModelId ?? model.effectiveModel,
    });
  }

  function applyDescribeToChatSummary(
    id: string,
    value: DescribeOverviewValue,
  ) {
    const patch: Partial<ChatSummary> = {
      head: value.head,
      totalFacts: value.totalFacts,
      totalTurns: value.totalTurns,
      totalSteps: value.totalSteps,
    };
    if (value.title !== undefined) patch.title = value.title;
    if (value.path !== undefined) patch.path = value.path;
    if (value.baseBranch !== undefined) patch.baseBranch = value.baseBranch;
    if (value.worktreePath !== undefined)
      patch.worktreePath = value.worktreePath;
    if (value.hidden !== undefined) patch.hidden = value.hidden;
    if (value.parentChatId !== undefined)
      patch.parentChatId = value.parentChatId;

    setChats((current) => {
      const existing = current.findIndex((chat) => chat.chatId === id);
      if (existing >= 0) {
        return current.map((chat, i) =>
          i === existing ? { ...chat, ...patch } : chat,
        );
      }
      const now = Date.now();
      const createdAt = Number(value.createdAt ?? 0);
      const lastAt = Number(value.lastAt ?? 0);
      const created =
        Number.isFinite(createdAt) && createdAt > 0 ? createdAt : now;
      const summary: ChatSummary = {
        chatId: id,
        createdAt: created,
        lastAt: Number.isFinite(lastAt) && lastAt > 0 ? lastAt : created,
        head: value.head,
        title: value.title ?? null,
        path: value.path ?? null,
        baseBranch: value.baseBranch ?? null,
        worktreePath:
          value.worktreePath ??
          expectedChatWorktreePath({ chatId: id, path: value.path ?? null }),
        status: "agent:Done",
        totalFacts: value.totalFacts,
        totalTurns: value.totalTurns,
        totalSteps: value.totalSteps,
        usage: null,
        costUsd: 0,
        costEstimated: true,
        unpricedModels: [],
        selectedModel: null,
        archived: false,
        archivedAt: null,
        hidden: value.hidden ?? false,
        parentChatId: value.parentChatId ?? null,
      };
      return sortChatsByRecency([summary, ...current]);
    });
  }

  function applyUpdateValue(id: string, value: DescribeUpdateValue) {
    applyOverviewValue(id, value.overview);
  }

  function updateHasTimeline(
    value: DescribeUpdateValue,
  ): value is DescribeUpdateValue & { timeline: DescribeTimelinePage } {
    return Array.isArray(value.timeline?.items);
  }

  function applyTimelineRows(
    id: string,
    page: DescribeTimelinePage,
    current: TimelineItem[] = timeline(),
  ): TimelineItem[] {
    const baseCurrent = withoutLiveTimelineOverlayRows(id, current);
    const mergedTimeline = page.sinceAt
      ? mergeTimelineUpdateRows(page.items, baseCurrent)
      : mergeTimelineRows(page.items, baseCurrent);
    pruneLandedLiveTimelineOverlayRows(id, mergedTimeline);
    const displayedTimeline = applyLiveTimelineOverlayRows(id, mergedTimeline);
    setTimeline(displayedTimeline);
    rememberServerTimelineWatermark(id, page.items);
    pruneDismissedReplies(id, mergedTimeline);

    const currentDraft = untrack(draftReply);
    if (currentDraft?.chatId === id) {
      const matchingReplyLanded = mergedTimeline.some(
        (item) =>
          item.type === "step" &&
          (item.kind === "agent:Reply" ||
            item.kind === "agent:Compaction" ||
            item.kind === "agent:Error") &&
          item.draftId === currentDraft.draftId,
      );
      const endedAt = endedDraftReplyIds.get(currentDraft.draftId);
      const terminalNonReplyLanded =
        endedAt != null &&
        mergedTimeline.some(
          (item) =>
            item.type === "step" &&
            item.kind !== "agent:Reply" &&
            Number(item.at) >= endedAt &&
            (item.status === "agent:Done" ||
              item.status === "agent:Failed" ||
              item.status === "agent:Cancelled"),
        );
      if (matchingReplyLanded || terminalNonReplyLanded) {
        const activeStartedAt = Number(activeChatStartedAt().get(id));
        const hasOpenForegroundStep = timelineHasOpenForegroundStepSince(
          id,
          mergedTimeline,
          Number.isFinite(activeStartedAt) && activeStartedAt > 0
            ? activeStartedAt
            : currentDraft.at,
        );
        endedDraftReplyIds.delete(currentDraft.draftId);
        toolClosedDraftReplyIds.delete(currentDraft.draftId);
        clearDraftReply(currentDraft.chatId, currentDraft.draftId);
        if (currentDraft.kind !== "compaction" && !hasOpenForegroundStep)
          releaseSettledChatRuntime(id);
      }
    }
    if (timelineRowsSettleActiveTurn(id, displayedTimeline))
      releaseSettledChatRuntime(id);

    return displayedTimeline;
  }

  function applyOverviewValue(id: string, value: DescribeOverviewValue) {
    applyDescribeToChatSummary(id, value);
    setTotalFacts(value.totalFacts);
    setTotalTurns(value.totalTurns);
    setTotalSteps(value.totalSteps);
    setTotalCodeCalls(value.totalCodeCalls ?? totalCodeCalls());
    applyTokensForChat(id, value.tokens, {
      active: id === chatId() && activeChats().has(id),
    });
    applyTodosForChat(id, Array.isArray(value.todos) ? value.todos : []);
    setLoadedChatId(id);
  }

  function applyTimelineUpdateValue(
    id: string,
    value: DescribeUpdateValue & { timeline: DescribeTimelinePage },
    current: TimelineItem[] = timeline(),
  ) {
    const mergedTimeline = applyTimelineRows(id, value.timeline, current);
    applyOverviewValue(id, {
      ...value.overview,
      totalCodeCalls:
        value.overview.totalCodeCalls ??
        mergedTimeline.filter(
          (it) =>
            it.type === "step" &&
            (it.kind === "agent:RunTS" || it.kind === "agent:RunJS"),
        ).length,
    });
  }

  function applyDescribeValue(
    id: string,
    value: DescribeSnapshotValue,
    current: TimelineItem[] = timeline(),
  ) {
    applyTimelineRows(id, value.timeline, current);
    setTrail(sortTimelineItems(value.trail.items));
    applyOverviewValue(id, {
      ...value.overview,
      totalCodeCalls:
        value.overview.totalCodeCalls ??
        value.timeline.items.filter(
          (it) =>
            it.type === "step" &&
            (it.kind === "agent:RunTS" || it.kind === "agent:RunJS"),
        ).length,
    });
    setHiddenTimelineItems(value.timeline.hiddenItems);
  }

  function cachedSnapshotForLimit(
    id: string,
    summary?: ChatSummary,
    limit?: number,
    opts?: { allowStale?: boolean },
  ): DescribeSnapshotValue | null {
    const cached = chatCache.get(id);
    if (!cached?.overview || !cached.timelinePages) return null;
    if (
      !opts?.allowStale &&
      !isDescribeFreshForSummary(cached.overview, summary)
    )
      return null;
    const explicitKey = limit == null ? null : timelineCacheKey(limit);
    const timelineCandidates = [
      explicitKey,
      limit == null ? cached.activeTimelineKey : null,
      ...Object.entries(cached.timelinePages)
        .sort((a, b) => (b[1].accessedAt ?? 0) - (a[1].accessedAt ?? 0))
        .map(([key]) => key),
    ].filter((key): key is string => !!key);
    const timelineKey = timelineCandidates.find((key) => {
      const page = cached.timelinePages?.[key];
      return !!page && (limit == null || (page.limit ?? 0) >= limit);
    });
    if (!timelineKey) return null;
    const timeline = cached.timelinePages[timelineKey];
    const trailCandidates = [
      cached.activeTrailKey,
      trailCacheKey(timeline.limit),
      ...Object.entries(cached.trailPages ?? {})
        .sort((a, b) => (b[1].accessedAt ?? 0) - (a[1].accessedAt ?? 0))
        .map(([key]) => key),
    ].filter((key): key is string => !!key);
    const trailKey = trailCandidates.find((key) => !!cached.trailPages?.[key]);
    if (!trailKey || !cached.trailPages) return null;
    const trail = cached.trailPages[trailKey];
    const now = Date.now();
    touchChatCache(id, {
      activeTimelineKey: timelineKey,
      activeTrailKey: trailKey,
      timelinePages: {
        ...cached.timelinePages,
        [timelineKey]: { ...timeline, accessedAt: now },
      },
      trailPages: {
        ...cached.trailPages,
        [trailKey]: { ...trail, accessedAt: now },
      },
    });
    return {
      mode: "snapshot",
      overview: mergeCachedOverviewWithSummary(cached.overview, summary),
      timeline,
      trail,
    };
  }

  function restoreCachedChat(
    id: string,
    summary?: ChatSummary,
    opts?: { allowStale?: boolean },
  ): boolean {
    const cached = chatCache.get(id);
    if (!cached) return false;
    const snapshot = cachedSnapshotForLimit(id, summary, undefined, opts);
    if (snapshot) {
      setTimelineLimit(snapshot.timeline.limit ?? INITIAL_TIMELINE_LIMIT);
      applyDescribeValue(id, snapshot, []);
    } else if (
      cached.overview &&
      (opts?.allowStale || isDescribeFreshForSummary(cached.overview, summary))
    ) {
      applyOverviewValue(
        id,
        mergeCachedOverviewWithSummary(cached.overview, summary),
      );
    }
    if (cached.model) setChatModel(modelWithPendingWrites(id, cached.model));
    if (cached.ui) {
      setChatUiApps(cached.ui.apps);
      setUiInstances(cached.ui.instances);
    }
    if (cached.rightSidebar) {
      const layout = rightSidebarLayoutForScope(id);
      setRightSidebarByChat((prev) => ({
        ...prev,
        [id]: normalizeRightSidebarState(cached.rightSidebar, layout),
      }));
    }
    if (cached.ui)
      restorePrimaryUi(cached.ui.primaryUiId ?? null, cached.ui.instances);
    touchChatCache(id, {});
    return !!snapshot;
  }

  function cachedDescribeNeedsRefresh(
    id: string,
    summary?: ChatSummary,
  ): boolean {
    const cached = chatCache.get(id);
    return !isDescribeFreshForSummary(cached?.overview, summary);
  }

  function cacheDescribeSnapshot(
    id: string,
    value: DescribeSnapshotValue,
    requestedLimit: number,
  ) {
    const current = chatCache.get(id);
    const now = Date.now();
    const timelineKey = timelineCacheKey(
      value.timeline.limit || requestedLimit,
    );
    const trailKey = trailCacheKey(value.trail.limit);
    touchChatCache(id, {
      overview: value.overview,
      checkpoint: current?.checkpoint,
      activeTimelineKey: timelineKey,
      activeTrailKey: trailKey,
      timelinePages: {
        ...(current?.timelinePages ?? {}),
        [timelineKey]: { ...value.timeline, cachedAt: now, accessedAt: now },
      },
      trailPages: {
        ...(current?.trailPages ?? {}),
        [trailKey]: { ...value.trail, cachedAt: now, accessedAt: now },
      },
    });
  }

  function mergeCachedTimelinePage(
    page: CachedTimelinePage,
    update: DescribeUpdateValue & { timeline: DescribeTimelinePage },
    now: number,
  ): CachedTimelinePage {
    const byKey = new Map<string, TimelineItem>();
    for (const item of page.items) byKey.set(timelineItemKey(item), item);
    for (const item of update.timeline.items)
      byKey.set(timelineItemKey(item), item);
    const items = sortTimelineItems([...byKey.values()]).slice(-page.limit);
    const total = Number(update.overview.totalTimelineItems);
    const hiddenItems = Number.isFinite(total)
      ? Math.max(0, total - items.length)
      : page.hiddenItems;
    return { ...page, items, hiddenItems, cachedAt: now, accessedAt: now };
  }

  function cacheDescribeUpdate(id: string, value: DescribeUpdateValue) {
    const current = chatCache.get(id);
    const now = Date.now();
    let timelinePages = current?.timelinePages;
    if (current?.timelinePages && updateHasTimeline(value)) {
      timelinePages = Object.fromEntries(
        Object.entries(current.timelinePages).map(([key, page]) => [
          key,
          mergeCachedTimelinePage(page, value, now),
        ]),
      );
    }
    touchChatCache(id, {
      checkpoint: value,
      overview: value.overview,
      timelinePages,
    });
  }

  function forgetChatCache(id: string) {
    if (!chatCache.delete(id)) return;
    persistChatCacheSoon();
  }

  function forgetTodosForChat(id: string) {
    todosByChat.delete(id);
    if (chatId() === id) showTodosForChat(id);
  }

  function forgetRightSidebarForChat(id: string) {
    setRightSidebarByChat((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, id)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function invalidateChatCache(
    id: string,
    parts: { describe?: boolean; model?: boolean; ui?: boolean },
  ) {
    const current = chatCache.get(id);
    if (!current) return;
    const next: ChatCacheEntry = { ...current };
    if (parts.describe) {
      // Facts/head changes make the incremental checkpoint stale. Keep cached
      // snapshot pages so switching chats can hydrate immediately while the
      // background describe refresh reconciles with the latest server state.
      delete next.checkpoint;
    }
    if (parts.model) delete next.model;
    if (parts.ui) delete next.ui;
    if (!chatCacheHasData(next)) {
      chatCache.delete(id);
    } else {
      next.updatedAt = Date.now();
      chatCache.delete(id);
      chatCache.set(id, next);
    }
    persistChatCacheSoon();
  }
  // Set of chat IDs the server has confirmed are currently running a step
  // (driven by step-start / step-end WS events from the Rust chat driver, and
  // reconciled from chat-list status). Only this server-confirmed state drives
  // the visible "thinking" UI.
  const [activeChats, setActiveChats] = createSignal<Set<string>>(new Set());
  // Chat IDs currently inside the compaction LLM call. This refines the
  // active-chat state so compaction renders as its own streamed row instead of
  // the generic standalone Thinking status.
  const [compactingChats, setCompactingChats] = createSignal<Set<string>>(
    new Set(),
  );
  // Server-confirmed start time for each active chat. This lives in global
  // state so Timeline can distinguish old terminal rows from the active turn
  // even when the user switches chats/tabs and Timeline remounts.
  const [activeChatStartedAt, setActiveChatStartedAt] = createSignal<
    Map<string, number>
  >(new Map());
  const [activeChatModel, setActiveChatModel] = createSignal<
    Map<string, { model?: string | null; effort?: string | null }>
  >(new Map());
  const [backgroundRunTS, setBackgroundRunTS] = createSignal<
    Array<{
      chatId: string;
      stepId: string;
      label?: string | null;
      requestedBy?: string | null;
      startedAt?: number;
    }>
  >([]);
  const [backgroundRequestedRunTS, setBackgroundRequestedRunTS] = createSignal<
    Set<string>
  >(new Set());
  // Local dispatch locks prevent sending another queued message for the same
  // chat while /api/run is being accepted and before the corresponding
  // step-start event arrives. These locks must not make the UI look like the
  // agent is thinking.
  const [dispatchingChats, setDispatchingChats] = createSignal<Set<string>>(
    new Set(),
  );
  // Chat IDs with an interrupt request in flight. While present, new user
  // messages must stay queued: otherwise they can start a fresh driver turn
  // just before the interrupt RPC reaches Rust, and that interrupt aborts the
  // newly-started turn instead of the old one.
  const [interruptingChats, setInterruptingChats] = createSignal<Set<string>>(
    new Set(),
  );
  // Manual runTS background/cancel requests are accepted before chat-list can
  // stop reporting the old foreground turn as running. While present, this set
  // lets one queued follow-up drain for that chat despite stale activeChats.
  const [runTSQueueUnblockedChats, setRunTSQueueUnblockedChats] = createSignal<
    Set<string>
  >(new Set());
  const setHas = (set: Set<string>, id: string) => set.has(id);
  const isTerminalStepStatus = (status: string | undefined) =>
    status === "agent:Done" ||
    status === "agent:Failed" ||
    status === "agent:Cancelled";
  const hasRunningTimelineRowForChat = (id: string) =>
    chatId() === id &&
    timeline().some(
      (item) =>
        item.type === "step" &&
        !isTerminalStepStatus(item.status) &&
        !(item.runts && isRunTSBackgrounded(item.step, id)) &&
        !(item.runjs && isRunTSBackgrounded(item.step, id)),
    );
  const chatHasUnendedDraft = (id: string) => {
    const draft = draftReply();
    return (
      !!draft && draft.chatId === id && !endedDraftReplyIds.has(draft.draftId)
    );
  };
  const chatHasServerRun = (id: string) =>
    setHas(activeChats(), id) ||
    chats().some(
      (chat) => chat.chatId === id && chat.status === "agent:Running",
    );
  const chatHasInFlightTurn = (id: string) =>
    chatHasServerRun(id) || chatHasLocalOpenTurn(id);
  const chatHasLocalOpenTurn = (id: string) =>
    hasRunningTimelineRowForChat(id) || chatHasUnendedDraft(id);
  const chatVisiblyActive = (id: string) =>
    setHas(activeChats(), id) || chatHasLocalOpenTurn(id);
  const chatBusy = (id: string) =>
    (chatHasServerRun(id) && !setHas(runTSQueueUnblockedChats(), id)) ||
    // Queue unblocks only bypass stale server-running state after a foreground
    // RunTS backgrounds. They must not dequeue follow-ups while the current
    // chat still has streamed thinking/reply drafts or visible foreground rows.
    chatHasLocalOpenTurn(id) ||
    setHas(dispatchingChats(), id) ||
    setHas(interruptingChats(), id);
  function addToSet(
    setter: (value: Set<string>) => void,
    current: () => Set<string>,
    id: string,
  ) {
    const next = new Set(current());
    next.add(id);
    setter(next);
  }
  function deleteFromSet(
    setter: (value: Set<string>) => void,
    current: () => Set<string>,
    id: string,
  ) {
    const next = new Set(current());
    next.delete(id);
    setter(next);
  }
  const thinking = () => {
    const id = chatId();
    return id ? activeChats().has(id) : false;
  };
  const compacting = () => {
    const id = chatId();
    return id ? compactingChats().has(id) : false;
  };
  const thinkingStartedAt = () => {
    const id = chatId();
    return id ? (activeChatStartedAt().get(id) ?? null) : null;
  };
  const runningModel = () => {
    const id = chatId();
    return id ? (activeChatModel().get(id) ?? null) : null;
  };
  function setActiveChatRuntimeModel(
    id: string,
    model?: string | null,
    effort?: string | null,
  ) {
    const cleanModel = typeof model === "string" ? model.trim() : "";
    const cleanEffort = typeof effort === "string" ? effort.trim() : "";
    if (!cleanModel && !cleanEffort) return;
    const next = new Map(activeChatModel());
    const previous = next.get(id) ?? {};
    next.set(id, {
      model: cleanModel || previous.model || null,
      effort: cleanEffort || previous.effort || null,
    });
    setActiveChatModel(next);
  }
  function clearActiveChatRuntime(id: string) {
    deleteFromSet(setActiveChats, activeChats, id);
    deleteFromSet(setCompactingChats, compactingChats, id);
    deleteChatStartedAt(id);
    const nextActiveModels = new Map(activeChatModel());
    nextActiveModels.delete(id);
    setActiveChatModel(nextActiveModels);
    deleteFromSet(setDispatchingChats, dispatchingChats, id);
    deleteFromSet(setInterruptingChats, interruptingChats, id);
  }
  function unblockRunTSQueue(id: string) {
    addToSet(setRunTSQueueUnblockedChats, runTSQueueUnblockedChats, id);
  }
  function clearRunTSQueueUnblock(id: string) {
    deleteFromSet(setRunTSQueueUnblockedChats, runTSQueueUnblockedChats, id);
  }
  const runTSBackgroundKey = (
    chat: string,
    stepId: string | null | undefined,
  ) => JSON.stringify([chat, stepId || ""]);
  function runTSBackgroundKeyParts(key: string): [string, string] | null {
    try {
      const parsed = JSON.parse(key);
      return Array.isArray(parsed) &&
        typeof parsed[0] === "string" &&
        typeof parsed[1] === "string"
        ? [parsed[0], parsed[1]]
        : null;
    } catch {
      return null;
    }
  }
  function requestRunTSBackground(chat: string, stepId?: string | null) {
    setBackgroundRequestedRunTS((current) => {
      const next = new Set(current);
      next.add(runTSBackgroundKey(chat, stepId));
      return next;
    });
  }
  function clearRunTSBackgroundRequest(chat: string, stepId?: string | null) {
    const key = runTSBackgroundKey(chat, stepId);
    setBackgroundRequestedRunTS((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }
  function isRunTSBackgrounded(
    stepId?: string | null,
    targetChatId?: string | null,
  ) {
    const id = targetChatId || chatId();
    if (!id || !stepId) return false;
    const key = runTSBackgroundKey(id, stepId);
    return (
      backgroundRequestedRunTS().has(key) ||
      backgroundRunTS().some(
        (job) => job.chatId === id && job.stepId === stepId,
      )
    );
  }
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
  const [pskRequired, setPskRequired] = createSignal(false);
  const [pskChecking, setPskChecking] = createSignal(false);
  const [pskError, setPskError] = createSignal<string | null>(null);
  let eventsStarted = false;
  let startupRun = 0;

  const { toasts, dismissToast, notify, reportError } = createToastSystem();
  // Streaming reply buffer for the visible chat, plus a per-chat cache for
  // active streams that continue while the user is viewing another chat.
  // Cleared by:
  // - draft-end events from the agent
  // - stop/interrupt, after the partial content is moved to dismissedReplies
  // - the real Reply step landing (caller can clear via clearDraftReply)
  const [draftReply, setDraftReply] = createSignal<DraftReply | null>(null);
  const draftRepliesByChat = new Map<string, DraftReply>();
  const endedDraftReplyIds = new Map<string, number>();
  const toolClosedDraftReplyIds = new Set<string>();
  const [dismissedReplies, setDismissedReplies] = createSignal<
    DismissedReply[]
  >([]);

  function setActiveDraftReply(next: DraftReply) {
    draftRepliesByChat.set(next.chatId, next);
    if (chatId() === next.chatId) setDraftReply(next);
  }

  function clearDraftReply(
    chatIdToClear?: string | null,
    draftId?: string | null,
  ) {
    const current = untrack(draftReply);
    const targetChatId = chatIdToClear ?? current?.chatId ?? null;
    if (targetChatId) {
      const cached = draftRepliesByChat.get(targetChatId);
      if (!draftId || cached?.draftId === draftId) {
        draftRepliesByChat.delete(targetChatId);
      }
    }
    const latest = untrack(draftReply);
    if (
      latest &&
      (!targetChatId || latest.chatId === targetChatId) &&
      (!draftId || latest.draftId === draftId)
    ) {
      setDraftReply(null);
    }
  }

  function restoreDraftReplyForChat(id: string) {
    const draft = draftRepliesByChat.get(id);
    setDraftReply(draft ?? null);
  }

  function cachedDraftReplyForEnd(chatId: string | undefined, draftId: string) {
    if (chatId) return draftRepliesByChat.get(chatId) ?? null;
    for (const draft of draftRepliesByChat.values()) {
      if (draft.draftId === draftId) return draft;
    }
    return null;
  }

  function closeDraftReplyThinkingForToolCall(id: string) {
    const cur = draftRepliesByChat.get(id);
    if (!cur || cur.kind === "compaction") return;
    toolClosedDraftReplyIds.add(cur.draftId);
    if (cur.reasoningStreaming === false) return;
    setActiveDraftReply({ ...cur, reasoningStreaming: false });
  }

  function dismissedReplyId(chatId: string, draftId: string): string {
    return `dismissed-${chatId}-${draftId}`;
  }

  function rememberDismissedReply(
    chatId: string,
    draftId: string,
    content: string,
    reasoningContent = "",
    at = Date.now(),
  ) {
    if (!content.trim() && !reasoningContent.trim()) return;
    setDismissedReplies((items) => {
      const id = dismissedReplyId(chatId, draftId);
      const without = items.filter((item) => item.id !== id);
      const previous = items.find((item) => item.id === id);
      const next = [
        ...without,
        {
          id,
          chatId,
          draftId,
          content,
          reasoningContent,
          at: previous?.at ?? at,
        },
      ];
      return next.slice(-MAX_DISMISSED_REPLIES);
    });
  }

  function dismissCurrentDraftReply(chatId: string) {
    const cur = untrack(draftReply);
    if (!cur || cur.chatId !== chatId) return;
    rememberDismissedReply(
      chatId,
      cur.draftId,
      cur.content,
      cur.reasoningContent ?? "",
    );
  }

  function isDraftBackedStep(
    item: TimelineItem,
  ): item is Extract<TimelineItem, { type: "step" }> {
    return (
      item.type === "step" &&
      (item.kind === "agent:Reply" || item.kind === "agent:Compaction")
    );
  }

  function pruneDismissedReplies(chatId: string, rows: TimelineItem[]) {
    const replyRows = rows.filter(isDraftBackedStep);
    const replyDraftIds = new Set(
      replyRows
        .map((item) => item.draftId)
        .filter(
          (draftId): draftId is string =>
            typeof draftId === "string" && !!draftId,
        ),
    );
    const replyTexts = replyRows
      .map((item) => item.text.trim())
      .filter(Boolean);
    if (replyDraftIds.size === 0 && replyTexts.length === 0) return;
    setDismissedReplies((items) =>
      items.filter((item) => {
        if (item.chatId !== chatId) return true;
        if (replyDraftIds.has(item.draftId)) return false;
        const content = item.content.trim();
        return (
          !content ||
          !replyTexts.some(
            (replyText) =>
              replyText === content || replyText.startsWith(content),
          )
        );
      }),
    );
  }

  type LiveTimelineOverlayKind = "tool-call-draft";
  type ToolCallDraftEvent = Extract<WsEvent, { kind: "tool-call-draft" }>;

  const liveTimelineOverlayByChat = new Map<
    string,
    Map<string, { kind: LiveTimelineOverlayKind; item: TimelineItem }>
  >();

  function liveTimelineOverlayKey(item: TimelineItem): string {
    return timelineItemKey(item);
  }

  function liveTimelineOverlayForChat(id: string) {
    let overlay = liveTimelineOverlayByChat.get(id);
    if (!overlay) {
      overlay = new Map();
      liveTimelineOverlayByChat.set(id, overlay);
    }
    return overlay;
  }

  function rememberLiveTimelineOverlayItem(
    id: string,
    kind: LiveTimelineOverlayKind,
    item: TimelineItem,
  ) {
    liveTimelineOverlayForChat(id).set(liveTimelineOverlayKey(item), {
      kind,
      item,
    });
  }

  function clearLiveTimelineOverlayItem(id: string, key: string) {
    const overlay = liveTimelineOverlayByChat.get(id);
    if (!overlay) return;
    overlay.delete(key);
    if (overlay.size === 0) liveTimelineOverlayByChat.delete(id);
  }

  function clearLiveTimelineOverlayStep(id: string, stepId: string) {
    if (!stepId) return;
    clearLiveTimelineOverlayItem(id, `step:${stepId}`);
  }

  function withoutLiveTimelineOverlayRows(
    id: string,
    rows: TimelineItem[],
  ): TimelineItem[] {
    const overlay = liveTimelineOverlayByChat.get(id);
    if (!overlay?.size) return rows;
    return rows.filter((item) => !overlay.has(liveTimelineOverlayKey(item)));
  }

  function pruneLandedLiveTimelineOverlayRows(
    id: string,
    baseRows: TimelineItem[],
  ) {
    const overlay = liveTimelineOverlayByChat.get(id);
    if (!overlay?.size) return;
    for (const item of baseRows) overlay.delete(liveTimelineOverlayKey(item));
    if (overlay.size === 0) liveTimelineOverlayByChat.delete(id);
  }

  function applyLiveTimelineOverlayRows(
    id: string,
    baseRows: TimelineItem[],
  ): TimelineItem[] {
    const overlay = liveTimelineOverlayByChat.get(id);
    if (!overlay?.size) return baseRows;
    const byKey = new Map<string, TimelineItem>();
    for (const item of baseRows) byKey.set(liveTimelineOverlayKey(item), item);
    for (const { item } of overlay.values())
      byKey.set(liveTimelineOverlayKey(item), item);
    return compactTimelineRows(sortTimelineItems([...byKey.values()]));
  }

  function mergeToolCallDraftRow(
    rows: TimelineItem[],
    ev: ToolCallDraftEvent,
  ): TimelineItem[] {
    const stepId = String(ev.stepId);
    const at = Number(ev.at) || Date.now();
    const hasArgs = ev.hasArgs === true || typeof ev.args === "string";
    let streamedArgs: unknown = ev.args ?? "";
    if (typeof ev.args === "string") {
      try {
        streamedArgs = JSON.parse(ev.args);
      } catch {
        streamedArgs = ev.args;
      }
    }
    const existingIndex = rows.findIndex(
      (item) => item.type === "step" && item.step === stepId,
    );
    const existing = existingIndex >= 0 ? rows[existingIndex] : undefined;
    const existingRunts =
      existing?.type === "step" ? (existing.runts ?? existing.runjs) : null;
    const runts = {
      ...(existingRunts ?? {}),
      label:
        typeof ev.label === "string" ? ev.label : (existingRunts?.label ?? null),
      description:
        typeof ev.description === "string"
          ? ev.description
          : (existingRunts?.description ?? null),
      ...(hasArgs ? { args: streamedArgs } : {}),
      code: typeof ev.code === "string" ? ev.code : (existingRunts?.code ?? null),
      backgroundAfterNs:
        typeof ev.backgroundAfterNs === "number"
          ? ev.backgroundAfterNs
          : existingRunts?.backgroundAfterNs,
    };
    const model =
      typeof ev.model === "string"
        ? ev.model
        : existing?.type === "step"
          ? existing.model
          : undefined;
    const effort =
      typeof ev.effort === "string"
        ? ev.effort
        : existing?.type === "step"
          ? existing.effort
          : undefined;
    const nextItem = {
      type: "step",
      step: stepId,
      kind: "agent:RunTS",
      status:
        existing?.type === "step" && existing.status !== "agent:Queued"
          ? existing.status
          : "agent:Queued",
      at: existing?.type === "step" ? existing.at : at,
      updatedAt: at,
      text: existing?.type === "step" ? existing.text : "",
      runts,
      ...(existing?.type === "step" && existing.resultHash
        ? { resultHash: existing.resultHash }
        : {}),
      ...(existing?.type === "step" && existing.lazyRuntsResult
        ? { lazyRuntsResult: existing.lazyRuntsResult }
        : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    } as TimelineItem;
    if (existingIndex >= 0) {
      const next = rows.slice();
      next[existingIndex] = nextItem;
      return next;
    }
    return compactTimelineRows(sortTimelineItems([...rows, nextItem]));
  }

  function rememberToolCallDraftRow(
    ev: ToolCallDraftEvent,
    currentRows: TimelineItem[] = [],
  ): TimelineItem | null {
    if (!ev.chatId || !ev.stepId) return null;
    const overlayRows = [
      ...(liveTimelineOverlayByChat.get(ev.chatId)?.values() ?? []),
    ].map(({ item }) => item);
    const rows = currentRows.length
      ? mergeTimelineRows(overlayRows, currentRows)
      : overlayRows;
    const nextRows = mergeToolCallDraftRow(rows, ev);
    const item = nextRows.find(
      (row) => row.type === "step" && row.step === String(ev.stepId),
    );
    if (!item) return null;
    rememberLiveTimelineOverlayItem(ev.chatId, "tool-call-draft", item);
    return item;
  }

  function updateLiveTimelineOverlayStep(
    id: string,
    stepId: string,
    fn: (item: TimelineItem) => TimelineItem,
  ) {
    const overlay = liveTimelineOverlayByChat.get(id);
    const key = `step:${stepId}`;
    const entry = overlay?.get(key);
    if (!entry) return;
    overlay!.set(key, { ...entry, item: fn(entry.item) });
  }

  const [rightSidebarByChat, setRightSidebarByChat] = createSignal<
    Record<string, RightSidebarState>
  >({});
  const [rightSidebarLayoutByChat, setRightSidebarLayoutByChat] = createSignal<
    Record<string, RightSidebarLayoutState>
  >(readRightSidebarLayout());
  const currentChatSummary = () => currentChat();
  const canResumeAgent = () => {
    const id = chatId();
    if (!id) return false;
    if (chatBusy(id)) return false;
    const status = currentChat()?.status;
    if (status === "agent:Failed" || status === "agent:Cancelled") return true;
    if (
      status === "agent:Running" ||
      status === "agent:Queued" ||
      status === "ui:Pending"
    )
      return false;
    return hasRestartableConversationState(timeline());
  };
  const currentChatPath = () => currentChat()?.path ?? null;
  const currentChatWorktreePath = () => {
    const chat = currentChat();
    return chat?.worktreePath ?? expectedChatWorktreePath(chat);
  };
  const currentChatParent = () => {
    const chat = currentChat();
    const parentId = chat?.parentChatId ?? null;
    if (!parentId) return null;
    return chats().find((c) => c.chatId === parentId) ?? null;
  };
  const repoFileReadSeq = new Map<string, number>();
  const storePreviewReadSeq = new Map<string, number>();

  function fileName(path: string): string {
    const trimmed = path.replace(/\/+$/, "");
    return trimmed.split("/").pop() || trimmed || "file";
  }

  function repoFileTabId(path: string): string {
    return `file:${path.replace(/\\/g, "/")}`;
  }

  function normalizeSha256(hash: string): string {
    const trimmed = hash.trim().toLowerCase();
    return trimmed.startsWith("sha256:") ? trimmed : "sha256:" + trimmed;
  }

  function storePreviewTabId(hash: string): string {
    return `store:${normalizeSha256(hash)}`;
  }

  function storePreviewTitle(hash: string): string {
    const normalized = normalizeSha256(hash);
    return (
      "object " + normalized.slice("sha256:".length, "sha256:".length + 12)
    );
  }

  function shortStableTextId(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function jsonPreviewTabId(target: string): string {
    return "json:" + shortStableTextId(target);
  }

  function jsonPreviewTitle(target: string): string {
    return "json " + shortStableTextId(target);
  }

  function logPreviewTabId(item: LogItem): string {
    return "log:" + (item.id || shortStableTextId(item.message || ""));
  }

  function logPreviewTitle(item: LogItem): string {
    const shortId = (item.id || shortStableTextId(item.message || ""))
      .replace(/^log[:_-]?/, "")
      .slice(0, 12);
    return shortId ? "log " + shortId : "moo.log";
  }

  function decodeJsonPreviewTarget(target: string): JsonPreviewFile {
    const raw = target.startsWith("json:")
      ? target.slice("json:".length)
      : target;
    let value: unknown = null;
    let error: string | null = null;
    try {
      value = JSON.parse(raw);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      value = raw;
    }
    return { target, value, raw, error };
  }

  function diffHistoryTabId(path: string): string {
    return `diff-history:${path.replace(/\\/g, "/").replace(/\/+$/, "")}`;
  }

  function diffTimelineTabId(item: FileDiffItem): string {
    const path = item.path.replace(/\\/g, "/").replace(/\/+$/, "");
    return `diff-timeline:${item.id}:${path}`;
  }

  function memoryDiffHistoryTabId(store: string, graph: string): string {
    return `memory-diff-history:${store}:${graph}`;
  }

  function memoryDiffTimelineTabId(item: MemoryDiffItem): string {
    return `memory-diff-timeline:${item.id}:${item.store}:${item.graph}`;
  }

  function appTabId(uiId: string, instanceId?: string | null): string {
    return `app:${uiId}:${instanceId || "new"}`;
  }

  function appCodeTabId(uiId: string): string {
    return `app-code:${uiId}`;
  }

  function appManifest(uiId: string): UiApp | undefined {
    return (
      uiApps().find((candidate) => candidate.id === uiId) ??
      chatUiApps().find((candidate) => candidate.id === uiId)
    );
  }

  function appTitle(uiId: string): string {
    return appManifest(uiId)?.title || uiId;
  }

  function appIcon(uiId: string): string | null | undefined {
    return appManifest(uiId)?.icon;
  }

  function normalizeBrowserNavState(
    nav: BrowserNavState | undefined,
  ): BrowserNavState | undefined {
    if (!nav || typeof nav !== "object") return undefined;
    const history = Array.isArray(nav.history)
      ? nav.history
          .map((item) => String(item || "").trim())
          .filter(Boolean)
          .slice(-80)
      : [];
    const path =
      typeof nav.path === "string" && nav.path.trim()
        ? nav.path.trim()
        : (history[history.length - 1] ?? null);
    const fallbackIndex = path
      ? history.findIndex((item) => item === path)
      : -1;
    const rawIndex = Number.isFinite(nav.index)
      ? Math.trunc(nav.index)
      : fallbackIndex;
    const index =
      history.length > 0
        ? Math.max(
            0,
            Math.min(
              history.length - 1,
              rawIndex >= 0 ? rawIndex : history.length - 1,
            ),
          )
        : 0;
    const nextPath = history[index] ?? path;
    return { path: nextPath ?? null, history, index };
  }

  function normalizeExpandedDiffViewState(
    state: Record<string, DiffViewState> | undefined,
  ): Record<string, DiffViewState> {
    if (!state || typeof state !== "object") return {};
    const out: Record<string, DiffViewState> = {};
    for (const [key, value] of Object.entries(state).slice(-200)) {
      if (!key || !value || typeof value !== "object") continue;
      const mode =
        value.mode === "preview" || value.mode === "source"
          ? value.mode
          : "diff";
      const scrollTopByMode: Partial<Record<DiffContentMode, number>> = {};
      for (const candidate of [
        "diff",
        "preview",
        "source",
      ] as DiffContentMode[]) {
        const top = value.scrollTopByMode?.[candidate];
        if (typeof top === "number" && Number.isFinite(top) && top >= 0) {
          scrollTopByMode[candidate] = Math.min(Math.trunc(top), 1_000_000);
        }
      }
      out[key] = { mode, scrollTopByMode };
    }
    return out;
  }

  function normalizeDiffExpansionKey(key: string): string {
    const normalized = String(key || "");
    return normalized && normalized.length <= 2000 ? normalized : "";
  }

  function normalizeDiffExpansionShown(
    state: Record<string, number> | undefined,
  ): Record<string, number> {
    if (!state || typeof state !== "object") return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(state).slice(
      -RIGHT_SIDEBAR_DIFF_EXPANSION_STATE_MAX,
    )) {
      const normalizedKey = normalizeDiffExpansionKey(key);
      const shown = Math.trunc(Number(value));
      if (!normalizedKey || !Number.isFinite(shown) || shown <= 0) continue;
      out[normalizedKey] = Math.min(shown, 1_000_000);
    }
    return out;
  }

  function defaultRightSidebarState(
    layout?: RightSidebarLayoutState,
  ): RightSidebarState {
    return {
      tabs: [
        { id: "trail", kind: "trail", title: "Trails" },
        { id: "diffs", kind: "diffs", title: "Diff" },
        { id: "browser", kind: "browser", title: "Browser" },
      ],
      activeTabId: "trail",
      width: clampRightSidebarWidth(layout?.width),
      collapsed: layout?.collapsed === true,
      maximized: false,
      totalDiffExpanded: false,
      expandedDiffViewState: {},
      diffExpansionShown: {},
    };
  }

  function normalizeRightSidebarState(
    state: RightSidebarState | undefined,
    layout?: RightSidebarLayoutState,
  ): RightSidebarState {
    const fallback = defaultRightSidebarState(layout);
    const tabs = (state?.tabs ? [...state.tabs] : fallback.tabs).filter(
      (tab) => tab.id !== "agent-trail",
    );
    if (!tabs.some((tab) => tab.id === "trail")) {
      tabs.unshift({ id: "trail", kind: "trail", title: "Trails" });
    }
    const trailTab = tabs.find((tab) => tab.id === "trail");
    if (trailTab) trailTab.title = "Trails";
    if (!tabs.some((tab) => tab.id === "diffs")) {
      const insertAt = Math.min(1, tabs.length);
      tabs.splice(insertAt, 0, { id: "diffs", kind: "diffs", title: "Diff" });
    }
    const diffsTab = tabs.find((tab) => tab.id === "diffs");
    if (diffsTab) diffsTab.title = "Diff";
    if (!tabs.some((tab) => tab.id === "browser")) {
      const insertAt = Math.min(2, tabs.length);
      tabs.splice(insertAt, 0, {
        id: "browser",
        kind: "browser",
        title: "Browser",
      });
    }
    const browserTab = tabs.find((tab) => tab.id === "browser");
    if (browserTab && browserTab.kind === "browser") {
      browserTab.title = "Browser";
      browserTab.nav = normalizeBrowserNavState(browserTab.nav);
    }
    const activeTabId =
      state?.activeTabId && tabs.some((tab) => tab.id === state.activeTabId)
        ? state.activeTabId
        : tabs[0]!.id;
    return {
      tabs,
      activeTabId,
      width: clampRightSidebarWidth(state?.width ?? layout?.width),
      collapsed: state?.collapsed ?? layout?.collapsed === true,
      maximized: state?.maximized ?? false,
      totalDiffExpanded: state?.totalDiffExpanded === true,
      expandedDiffViewState: normalizeExpandedDiffViewState(
        state?.expandedDiffViewState,
      ),
      diffExpansionShown: normalizeDiffExpansionShown(
        state?.diffExpansionShown,
      ),
    };
  }

  function trimRightSidebarTabs(
    tabs: RightSidebarTab[],
    activeTabId: string,
  ): RightSidebarTab[] {
    if (tabs.length <= RIGHT_SIDEBAR_TABS_MAX) return tabs;
    const keep = new Set(["trail", "diffs", "browser", activeTabId]);
    const newest = [...tabs].reverse();
    const out: RightSidebarTab[] = [];
    for (const tab of newest) {
      if (keep.has(tab.id) || out.length < RIGHT_SIDEBAR_TABS_MAX)
        out.push(tab);
      if (
        out.length >= RIGHT_SIDEBAR_TABS_MAX &&
        [...keep].every((id) => out.some((tab) => tab.id === id))
      )
        break;
    }
    return out.reverse();
  }

  function pruneRightSidebarScopes(
    next: Record<string, RightSidebarState>,
    activeScopeId: string,
  ): Record<string, RightSidebarState> {
    const ids = Object.keys(next);
    const keep = new Set([
      activeScopeId,
      ...RIGHT_SIDEBAR_VIEW_SCOPE_IDS,
      ...chats()
        .slice(0, RIGHT_SIDEBAR_CHAT_MAX)
        .map((chat) => chat.chatId),
    ]);
    if (
      ids.every((id) => keep.has(id)) &&
      ids.filter((id) => !id.startsWith("view:")).length <=
        RIGHT_SIDEBAR_CHAT_MAX
    )
      return next;
    const pruned: Record<string, RightSidebarState> = {};
    for (const id of ids) if (keep.has(id)) pruned[id] = next[id]!;
    if (!pruned[activeScopeId] && next[activeScopeId])
      pruned[activeScopeId] = next[activeScopeId]!;
    return pruned;
  }

  function clearRememberedRightSidebarMaximized(): void {
    setRightSidebarByChat((prev) => {
      let changed = false;
      const next: Record<string, RightSidebarState> = {};
      for (const [id, state] of Object.entries(prev)) {
        if (state.maximized) {
          changed = true;
          next[id] = { ...state, maximized: false };
        } else {
          next[id] = state;
        }
      }
      return changed ? next : prev;
    });
  }

  function rightSidebarLayoutForScope(id: string): RightSidebarLayoutState {
    const layouts = rightSidebarLayoutByChat();
    const defaults = layouts[rightSidebarLayout.defaultLayoutId];
    const scopeLayout = layouts[id];
    return {
      width: scopeLayout?.width ?? defaults?.width,
      collapsed: scopeLayout?.collapsed,
    };
  }

  function currentRightSidebarScopeId(): string | null {
    switch (view()) {
      case "chat":
        return chatId();
      case "apps":
      case "facts":
      case "pointers":
      case "skills":
      case "v8":
        return `view:${view()}`;
      default:
        return null;
    }
  }

  function cachedRightSidebarState(id: string): RightSidebarState | undefined {
    if (id.startsWith("view:")) return undefined;
    return chatCache.get(id)?.rightSidebar;
  }

  function currentRightSidebarState(): RightSidebarState | null {
    const id = currentRightSidebarScopeId();
    if (!id) return null;
    return normalizeRightSidebarState(
      rightSidebarByChat()[id] ?? cachedRightSidebarState(id),
      rightSidebarLayoutForScope(id),
    );
  }

  function rightSidebarTabVisibleForView(tab: RightSidebarTab): boolean {
    switch (view()) {
      case "chat":
        return true;
      case "apps":
        return tab.kind === "app" || tab.kind === "app-code";
      case "facts":
      case "pointers":
      case "v8":
        return tab.kind === "store" || tab.kind === "json";
      default:
        return false;
    }
  }

  const rightSidebarTabs = () =>
    (currentRightSidebarState()?.tabs ?? []).filter(
      rightSidebarTabVisibleForView,
    );
  const activeRightSidebarTabId = () => activeRightSidebarTab()?.id ?? null;
  const activeRightSidebarTab = () => {
    const state = currentRightSidebarState();
    const tabs = rightSidebarTabs();
    return tabs.find((tab) => tab.id === state?.activeTabId) ?? tabs[0] ?? null;
  };
  const rightSidebarW = () =>
    currentRightSidebarState()?.width ?? rightSidebarLayout.defaultWidth;
  const rightSidebarCollapsed = () =>
    currentRightSidebarState()?.collapsed ?? false;
  const rightSidebarMaximized = () =>
    currentRightSidebarState()?.maximized ?? false;
  const openRepoFile = () => {
    const tab = activeRightSidebarTab();
    return tab?.kind === "file" ? tab.file : null;
  };

  function updateCurrentRightSidebarState(
    fn: (state: RightSidebarState) => RightSidebarState,
  ) {
    const id = currentRightSidebarScopeId();
    if (!id) return;
    const layout = rightSidebarLayoutForScope(id);
    setRightSidebarByChat((prev) => {
      const normalized = normalizeRightSidebarState(
        fn(
          normalizeRightSidebarState(
            prev[id] ?? cachedRightSidebarState(id),
            layout,
          ),
        ),
        layout,
      );
      const tabs = trimRightSidebarTabs(
        normalized.tabs,
        normalized.activeTabId,
      );
      const activeTabId = tabs.some((tab) => tab.id === normalized.activeTabId)
        ? normalized.activeTabId
        : tabs[0]!.id;
      const nextState = { ...normalized, tabs, activeTabId };
      if (!id.startsWith("view:"))
        touchChatCache(id, { rightSidebar: nextState });
      return pruneRightSidebarScopes(
        {
          ...prev,
          [id]: nextState,
        },
        id,
      );
    });
  }

  function activateExistingRightSidebarTab<T extends RightSidebarTab>(
    predicate: (tab: RightSidebarTab) => tab is T,
  ): T | null;
  function activateExistingRightSidebarTab(
    predicate: (tab: RightSidebarTab) => boolean,
  ): RightSidebarTab | null;
  function activateExistingRightSidebarTab(
    predicate: (tab: RightSidebarTab) => boolean,
  ): RightSidebarTab | null {
    const existing = rightSidebarTabs().find(predicate) ?? null;
    if (!existing) return null;
    setActiveRightSidebarTab(existing.id);
    setRightSidebarCollapsed(false);
    return existing;
  }

  function sameRightSidebarTabTarget(
    a: RightSidebarTab,
    b: RightSidebarTab,
  ): boolean {
    if (a.id === b.id) return true;
    if (a.kind !== b.kind) return false;
    switch (a.kind) {
      case "file": {
        const file = b as Extract<RightSidebarTab, { kind: "file" }>;
        return (
          sameRepoFilePath(a.file.requestedPath, file.file.requestedPath) ||
          sameRepoFilePath(a.file.path, file.file.path) ||
          sameRepoFilePath(a.file.requestedPath, file.file.path) ||
          sameRepoFilePath(a.file.path, file.file.requestedPath)
        );
      }
      case "store":
        return (
          a.store.hash ===
          (b as Extract<RightSidebarTab, { kind: "store" }>).store.hash
        );
      case "json":
        return (
          a.json.target ===
          (b as Extract<RightSidebarTab, { kind: "json" }>).json.target
        );
      case "diff": {
        const diff = b as Extract<RightSidebarTab, { kind: "diff" }>;
        if (a.scope !== diff.scope) return false;
        return a.scope === "timeline"
          ? a.diffId === diff.diffId
          : sameDiffPath(a.path, diff.path);
      }
      case "memory-diff": {
        const diff = b as Extract<RightSidebarTab, { kind: "memory-diff" }>;
        return (
          a.scope === diff.scope &&
          a.store === diff.store &&
          a.graph === diff.graph
        );
      }
      case "app": {
        const app = b as Extract<RightSidebarTab, { kind: "app" }>;
        return a.uiId === app.uiId && a.instanceId === app.instanceId;
      }
      case "app-code": {
        const appCode = b as Extract<RightSidebarTab, { kind: "app-code" }>;
        return a.uiId === appCode.uiId;
      }
      case "trail":
      case "diffs":
      case "browser":
        return true;
    }
  }

  function upsertRightSidebarTab(tab: RightSidebarTab, activate = true) {
    const id = currentRightSidebarScopeId();
    updateCurrentRightSidebarState((state) => {
      const existing = state.tabs.find((candidate) =>
        sameRightSidebarTabTarget(candidate, tab),
      );
      const activeTabId = activate
        ? (existing?.id ?? tab.id)
        : state.activeTabId;
      const nextTab: RightSidebarTab =
        existing?.kind === "diff" && tab.kind === "diff"
          ? {
              ...tab,
              id: existing.id,
              mode: existing.mode,
              scrollTopByMode: existing.scrollTopByMode,
            }
          : existing
            ? ({ ...tab, id: existing.id } as RightSidebarTab)
            : tab;
      const tabs = existing
        ? state.tabs.map((candidate) =>
            candidate.id === existing.id ? nextTab : candidate,
          )
        : [...state.tabs, nextTab];
      return {
        ...state,
        tabs,
        activeTabId,
        collapsed: activate ? false : state.collapsed,
      };
    });
    if (activate && id) {
      setRightSidebarLayoutByChat((prev) => ({
        ...prev,
        [id]: { ...prev[id], collapsed: false },
      }));
    }
  }

  function setBrowserTabNav(nav: BrowserNavState) {
    updateCurrentRightSidebarState((state) => ({
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.kind === "browser"
          ? {
              ...tab,
              nav: normalizeBrowserNavState(nav) ?? {
                path: null,
                history: [],
                index: 0,
              },
            }
          : tab,
      ),
    }));
  }

  function setDiffTabMode(tabId: string, mode: DiffContentMode) {
    updateCurrentRightSidebarState((state) => ({
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.id === tabId && tab.kind === "diff" ? { ...tab, mode } : tab,
      ),
    }));
  }

  function setDiffTabScrollTop(
    tabId: string,
    scrollTop: number,
    mode: DiffContentMode,
  ) {
    updateCurrentRightSidebarState((state) => ({
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.id === tabId && tab.kind === "diff"
          ? {
              ...tab,
              scrollTopByMode: {
                ...(tab.scrollTopByMode ?? {}),
                [mode]: scrollTop,
              },
            }
          : tab,
      ),
    }));
  }

  function expandedDiffViewState(key: string): DiffViewState {
    const state = currentRightSidebarState();
    return (
      state?.expandedDiffViewState?.[key] ?? {
        mode: "diff",
        scrollTopByMode: {},
      }
    );
  }

  function setExpandedDiffViewMode(key: string, mode: DiffContentMode) {
    updateCurrentRightSidebarState((state) => ({
      ...state,
      expandedDiffViewState: {
        ...(state.expandedDiffViewState ?? {}),
        [key]: {
          ...(state.expandedDiffViewState?.[key] ?? { scrollTopByMode: {} }),
          mode,
        },
      },
    }));
  }

  function setExpandedDiffViewScrollTop(
    key: string,
    scrollTop: number,
    mode: DiffContentMode,
  ) {
    updateCurrentRightSidebarState((state) => {
      const current = state.expandedDiffViewState?.[key] ?? {
        mode: "diff",
        scrollTopByMode: {},
      };
      return {
        ...state,
        expandedDiffViewState: {
          ...(state.expandedDiffViewState ?? {}),
          [key]: {
            ...current,
            scrollTopByMode: { ...current.scrollTopByMode, [mode]: scrollTop },
          },
        },
      };
    });
  }

  function rightSidebarDiffListExpanded(): boolean {
    return currentRightSidebarState()?.totalDiffExpanded ?? false;
  }

  function setRightSidebarDiffListExpanded(expanded: boolean) {
    updateCurrentRightSidebarState((state) =>
      state.totalDiffExpanded === expanded
        ? state
        : { ...state, totalDiffExpanded: expanded },
    );
  }

  function rightSidebarDiffExpansionShown(key: string): number {
    const normalizedKey = normalizeDiffExpansionKey(key);
    if (!normalizedKey) return 0;
    return currentRightSidebarState()?.diffExpansionShown?.[normalizedKey] ?? 0;
  }

  function setRightSidebarDiffExpansionShown(key: string, shown: number) {
    const normalizedKey = normalizeDiffExpansionKey(key);
    if (!normalizedKey) return;
    const nextShown = Math.min(
      Math.max(0, Math.trunc(Number(shown) || 0)),
      1_000_000,
    );
    updateCurrentRightSidebarState((state) => {
      const current = state.diffExpansionShown ?? {};
      if ((current[normalizedKey] ?? 0) === nextShown) return state;
      const entries = Object.entries(current).filter(
        ([candidate]) => candidate !== normalizedKey,
      );
      if (nextShown > 0) entries.push([normalizedKey, nextShown]);
      return {
        ...state,
        diffExpansionShown: Object.fromEntries(
          entries.slice(-RIGHT_SIDEBAR_DIFF_EXPANSION_STATE_MAX),
        ),
      };
    });
  }

  const sidebarDiffExpansionStore = {
    shown: rightSidebarDiffExpansionShown,
    setShown: setRightSidebarDiffExpansionShown,
  };

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
      activeTabId: state.tabs.some((candidate) => candidate.id === tabId)
        ? tabId
        : state.activeTabId,
    }));
  }

  async function closeRightSidebarTab(tabId: string) {
    if (tabId === "trail" || tabId === "diffs" || tabId === "browser") return;
    repoFileReadSeq.delete(tabId);
    storePreviewReadSeq.delete(tabId);
    const closing = rightSidebarTabs().find((tab) => tab.id === tabId);
    updateCurrentRightSidebarState((state) => {
      const idx = state.tabs.findIndex((tab) => tab.id === tabId);
      const tabs = state.tabs.filter((tab) => tab.id !== tabId);
      const fallback =
        tabs[Math.max(0, Math.min(idx, tabs.length - 1))] ?? tabs[0] ?? null;
      return {
        ...state,
        tabs,
        activeTabId:
          state.activeTabId === tabId
            ? (fallback?.id ?? "diffs")
            : state.activeTabId,
      };
    });
    if (
      closing?.kind === "app" &&
      openUiId() === closing.uiId &&
      openUiInstanceId() === closing.instanceId
    ) {
      setOpenUiId(null);
      setOpenUiInstanceId(null);
    }
    const activeTabId = currentRightSidebarState()?.activeTabId;
    const activeAppTab = activeTabId
      ? rightSidebarTabs().find(
          (tab): tab is Extract<RightSidebarTab, { kind: "app" }> =>
            tab.id === activeTabId && tab.kind === "app",
        )
      : null;
    if (activeAppTab) {
      setOpenUiId(activeAppTab.uiId);
      setOpenUiInstanceId(activeAppTab.instanceId);
    }
    const id = chatId();
    if (id && closing?.kind === "app" && closing.instanceId) {
      const r = await api("ui-close", {
        chatId: id,
        uiId: closing.uiId,
        instanceId: closing.instanceId,
      });
      if (!r.ok) reportError(`close app ${closing.uiId}`, r.error);
      else await refreshChatUis();
    }
  }

  function updateFileTab(
    tabId: string,
    update: (file: OpenRepoFile | null) => OpenRepoFile,
  ) {
    updateCurrentRightSidebarState((state) => {
      const existing = state.tabs.find(
        (tab) => tab.id === tabId && tab.kind === "file",
      ) as Extract<RightSidebarTab, { kind: "file" }> | undefined;
      const file = update(existing?.file ?? null);
      const tab: RightSidebarTab = {
        id: tabId,
        kind: "file",
        title: fileName(file.path || file.requestedPath),
        file,
      };
      const tabs = existing
        ? state.tabs.map((candidate) =>
            candidate.id === tabId ? tab : candidate,
          )
        : [...state.tabs, tab];
      return {
        ...state,
        tabs,
        activeTabId:
          state.activeTabId === tabId || !existing ? tabId : state.activeTabId,
        collapsed: !existing ? false : state.collapsed,
      };
    });
  }

  function sameRepoFilePath(
    a: string | null | undefined,
    b: string | null | undefined,
  ): boolean {
    return sameDiffPathInRoot(a, b, currentChatWorktreePath());
  }

  function isMissingRepoFileError(error: string | null | undefined): boolean {
    return /not found|does not exist|no such file/i.test(String(error || ""));
  }

  async function readRepoFileIntoSidebar(
    requestedPath: string,
    basePath: string | null,
    showLoading: boolean,
  ) {
    const tabId = repoFileTabId(requestedPath);
    const seq = (repoFileReadSeq.get(tabId) ?? 0) + 1;
    repoFileReadSeq.set(tabId, seq);
    if (showLoading) {
      upsertRightSidebarTab({
        id: tabId,
        kind: "file",
        title: fileName(requestedPath),
        file: {
          requestedPath,
          path: null,
          content: "",
          size: 0,
          mtime: 0,
          kind: "file",
          loading: true,
          error: null,
        },
      });
    }
    const r = await api("fs-read", {
      path: requestedPath,
      basePath,
      includeDiff: true,
    });
    if (repoFileReadSeq.get(tabId) !== seq) return;
    if (!r.ok) {
      updateFileTab(tabId, (prev) => ({
        requestedPath,
        path: prev?.path ?? null,
        content: "",
        size: 0,
        mtime: 0,
        kind: prev?.kind ?? "file",
        entries: prev?.entries,
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
      kind: r.value.kind,
      entries: r.value.entries,
      changed: r.value.changed,
      additions: r.value.additions,
      deletions: r.value.deletions,
      diff: r.value.diff,
      diffStats: r.value.diffStats,
      loading: false,
      error: null,
    }));
  }

  async function refreshOpenRepoFile() {
    const file = openRepoFile();
    if (!file) return;
    await readRepoFileIntoSidebar(
      file.requestedPath,
      currentChatWorktreePath(),
      false,
    );
  }

  function chatWorktreePathForId(id: string): string | null {
    const chat = chats().find((candidate) => candidate.chatId === id) ?? null;
    if (!chat) return null;
    return chat.worktreePath ?? expectedChatWorktreePath(chat);
  }

  function sameRepoFilePathInRoot(
    root: string | null | undefined,
    a: string | null | undefined,
    b: string | null | undefined,
  ): boolean {
    return sameDiffPathInRoot(a, b, root);
  }

  async function readRepoFileIntoSidebarScope(
    scopeId: string,
    requestedPath: string,
    basePath: string | null,
  ) {
    const tabId = repoFileTabId(requestedPath);
    const seqKey = `${scopeId}\n${tabId}`;
    const seq = (repoFileReadSeq.get(seqKey) ?? 0) + 1;
    repoFileReadSeq.set(seqKey, seq);
    const r = await api("fs-read", {
      path: requestedPath,
      basePath,
      includeDiff: true,
    });
    if (repoFileReadSeq.get(seqKey) !== seq) return;
    const layout = rightSidebarLayoutForScope(scopeId);
    setRightSidebarByChat((prev) => {
      const current = normalizeRightSidebarState(
        prev[scopeId] ?? cachedRightSidebarState(scopeId),
        layout,
      );
      let changed = false;
      const tabs = current.tabs.map((tab) => {
        if (tab.kind !== "file" || tab.id !== tabId) return tab;
        changed = true;
        if (!r.ok) {
          return {
            ...tab,
            file: {
              requestedPath,
              path: tab.file.path ?? null,
              content: tab.file.content,
              size: tab.file.size,
              mtime: tab.file.mtime,
              kind: tab.file.kind ?? "file",
              entries: tab.file.entries,
              loading: false,
              error: r.error.message,
            },
          } as RightSidebarTab;
        }
        const file: OpenRepoFile = {
          requestedPath,
          path: r.value.path,
          content: r.value.content,
          size: r.value.size,
          mtime: r.value.mtime,
          kind: r.value.kind,
          entries: r.value.entries,
          changed: r.value.changed,
          additions: r.value.additions,
          deletions: r.value.deletions,
          diff: r.value.diff,
          diffStats: r.value.diffStats,
          loading: false,
          error: null,
        };
        return {
          ...tab,
          title: fileName(file.path || file.requestedPath),
          file,
        } as RightSidebarTab;
      });
      if (!changed) return prev;
      const nextState = normalizeRightSidebarState({ ...current, tabs }, layout);
      if (!scopeId.startsWith("view:"))
        touchChatCache(scopeId, { rightSidebar: nextState });
      return pruneRightSidebarScopes({ ...prev, [scopeId]: nextState }, scopeId);
    });
  }

  function rightSidebarFileTabsForScope(scopeId: string) {
    return normalizeRightSidebarState(
      rightSidebarByChat()[scopeId] ?? cachedRightSidebarState(scopeId),
      rightSidebarLayoutForScope(scopeId),
    ).tabs.filter(
      (tab): tab is Extract<RightSidebarTab, { kind: "file" }> =>
        tab.kind === "file",
    );
  }

  async function refreshMatchingRepoFiles(path: string, targetChatId = chatId()) {
    const scopeId = targetChatId ?? currentRightSidebarScopeId();
    const root = scopeId
      ? chatWorktreePathForId(scopeId)
      : currentChatWorktreePath();
    if (!scopeId || !root) return;
    const files = rightSidebarFileTabsForScope(scopeId).filter(
      (tab) =>
        sameRepoFilePathInRoot(root, tab.file.path, path) ||
        sameRepoFilePathInRoot(root, tab.file.requestedPath, path),
    );
    await Promise.all(
      files.map((tab) =>
        scopeId === currentRightSidebarScopeId()
          ? readRepoFileIntoSidebar(tab.file.requestedPath, root, false)
          : readRepoFileIntoSidebarScope(scopeId, tab.file.requestedPath, root),
      ),
    );
  }

  function refreshMatchingDiffTabs(path: string, sourceRevision: string) {
    updateCurrentRightSidebarState((state) => ({
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.kind === "diff" &&
        tab.scope === "history" &&
        sameRepoFilePath(tab.path, path)
          ? { ...tab, sourceRevision }
          : tab,
      ),
    }));
  }

  async function openFileInSidebar(path: string) {
    const requestedPath = path.trim();
    if (!requestedPath) return;
    const existing = activateExistingRightSidebarTab(
      (tab) =>
        tab.kind === "file" &&
        (sameRepoFilePath(tab.file.requestedPath, requestedPath) ||
          sameRepoFilePath(tab.file.path, requestedPath)),
    );
    if (existing) {
      if (
        existing.kind === "file" &&
        (existing.file.error || existing.file.loading)
      ) {
        await readRepoFileIntoSidebar(
          requestedPath,
          currentChatWorktreePath(),
          true,
        );
      }
      return;
    }
    await readRepoFileIntoSidebar(
      requestedPath,
      currentChatWorktreePath(),
      true,
    );
  }

  function closeRepoFile() {
    const tab = activeRightSidebarTab();
    if (tab?.kind === "file") void closeRightSidebarTab(tab.id);
  }

  function updateStorePreviewTab(
    tabId: string,
    update: (store: StorePreviewFile | null) => StorePreviewFile,
  ) {
    updateCurrentRightSidebarState((state) => {
      const existing = state.tabs.find(
        (tab) => tab.id === tabId && tab.kind === "store",
      ) as Extract<RightSidebarTab, { kind: "store" }> | undefined;
      const store = update(existing?.store ?? null);
      const tab: RightSidebarTab = {
        id: tabId,
        kind: "store",
        title: storePreviewTitle(store.hash),
        store,
      };
      const tabs = existing
        ? state.tabs.map((candidate) =>
            candidate.id === tabId ? tab : candidate,
          )
        : [...state.tabs, tab];
      return {
        ...state,
        tabs,
        activeTabId:
          state.activeTabId === tabId || !existing ? tabId : state.activeTabId,
        collapsed: !existing ? false : state.collapsed,
      };
    });
  }

  async function readStorePreviewIntoSidebar(
    hash: string,
    showLoading: boolean,
  ) {
    const normalized = normalizeSha256(hash);
    const tabId = storePreviewTabId(normalized);
    const seq = (storePreviewReadSeq.get(tabId) ?? 0) + 1;
    storePreviewReadSeq.set(tabId, seq);
    if (showLoading) {
      upsertRightSidebarTab({
        id: tabId,
        kind: "store",
        title: storePreviewTitle(normalized),
        store: { hash: normalized, object: null, loading: true, error: null },
      });
    }
    const r = await api("object-get", { hash: normalized });
    if (storePreviewReadSeq.get(tabId) !== seq) return;
    if (!r.ok) {
      updateStorePreviewTab(tabId, () => ({
        hash: normalized,
        object: null,
        loading: false,
        error: r.error.message,
      }));
      return;
    }
    updateStorePreviewTab(tabId, () => ({
      hash: normalized,
      object: r.value.object,
      loading: false,
      error: r.value.object ? null : "object not found",
    }));
  }

  async function openStorePreviewInSidebar(hash: string) {
    const normalized = normalizeSha256(hash);
    const existing = activateExistingRightSidebarTab(
      (tab): tab is Extract<RightSidebarTab, { kind: "store" }> =>
        tab.kind === "store" && tab.store.hash === normalized,
    );
    if (existing) return;
    // Open an active tab synchronously so pointer clicks visibly open the right
    // sidebar even while the object read is still in flight.
    upsertRightSidebarTab({
      id: storePreviewTabId(normalized),
      kind: "store",
      title: storePreviewTitle(normalized),
      store: { hash: normalized, object: null, loading: true, error: null },
    });
    await readStorePreviewIntoSidebar(normalized, false);
  }

  function openJsonPreviewInSidebar(target: string) {
    if (!target.startsWith("json:")) return;
    const json = decodeJsonPreviewTarget(target);
    const existing = activateExistingRightSidebarTab(
      (tab): tab is Extract<RightSidebarTab, { kind: "json" }> =>
        tab.kind === "json" && tab.json.target === json.target,
    );
    if (existing) return;
    upsertRightSidebarTab({
      id: jsonPreviewTabId(json.target),
      kind: "json",
      title: jsonPreviewTitle(json.target),
      json,
    });
    setRightSidebarCollapsed(false);
  }

  function openLogPreviewInSidebar(item: LogItem) {
    const raw = item.message || "";
    const json: JsonPreviewFile = {
      target: logPreviewTabId(item),
      value: raw,
      raw,
      error: null,
      label: "moo.log",
      displayTarget: item.id,
      downloadName: "moo-log.txt",
      downloadMime: "text/plain",
      autoHighlight: true,
      layout: "bare",
    };
    upsertRightSidebarTab({
      id: logPreviewTabId(item),
      kind: "json",
      title: logPreviewTitle(item),
      json,
    });
    setRightSidebarCollapsed(false);
  }

  function openDiffInSidebar(
    item: FileDiffItem,
    scope: "history" | "timeline" = "timeline",
  ) {
    const diff =
      scope === "history"
        ? (mergedFileDiffs(trail()).find((candidate) =>
            sameDiffPath(candidate.path, item.path),
          ) ?? item)
        : item;
    const tabId =
      scope === "history"
        ? diffHistoryTabId(diff.path)
        : diffTimelineTabId(diff);
    const existing = activateExistingRightSidebarTab(
      (tab) =>
        tab.kind === "diff" &&
        (tab.id === tabId ||
          (scope === "history" &&
            tab.scope === "history" &&
            sameDiffPath(tab.path, diff.path))),
    );
    if (existing) return;
    upsertRightSidebarTab({
      id: tabId,
      kind: "diff",
      title: collapseHome(diff.path),
      diffId: diff.id,
      path: diff.path,
      item: diff,
      scope,
    });
  }

  function openMemoryDiffInSidebar(
    item: MemoryDiffItem | MemoryGraphDiffSummary,
    scope: "history" | "timeline" = "timeline",
  ) {
    const diff =
      scope === "history"
        ? (mergedMemoryDiffs(trail()).find(
            (candidate) =>
              candidate.store === item.store && candidate.graph === item.graph,
          ) ?? item)
        : item;
    const tabId =
      scope === "history"
        ? memoryDiffHistoryTabId(diff.store, diff.graph)
        : diff.type === "memory-diff"
          ? memoryDiffTimelineTabId(diff)
          : memoryDiffHistoryTabId(diff.store, diff.graph);
    const existing = activateExistingRightSidebarTab(
      (tab) =>
        tab.kind === "memory-diff" &&
        (tab.id === tabId ||
          (tab.scope === scope &&
            tab.store === diff.store &&
            tab.graph === diff.graph)),
    );
    if (existing) return;
    upsertRightSidebarTab({
      id: tabId,
      kind: "memory-diff",
      title: diff.graph || diff.store,
      diffId: diff.id,
      store: diff.store,
      graph: diff.graph,
      path: diff.path,
      item: diff,
      scope,
    });
  }

  function setRightSidebarW(width: number | string) {
    const next = clampRightSidebarWidth(width, "percent", true);
    const id = currentRightSidebarScopeId();
    if (!id) return;
    updateCurrentRightSidebarState((state) => ({
      ...state,
      width: next,
      maximized: false,
    }));
    setRightSidebarLayoutByChat((prev) => {
      const defaults = prev[rightSidebarLayout.defaultLayoutId];
      return {
        ...prev,
        [rightSidebarLayout.defaultLayoutId]: { ...defaults, width: next },
        [id]: { ...prev[id], width: next },
      };
    });
  }

  function setRightSidebarCollapsed(
    collapsed: boolean,
    opts?: { persist?: boolean },
  ) {
    const id = currentRightSidebarScopeId();
    if (!id) return;
    updateCurrentRightSidebarState((state) => ({
      ...state,
      collapsed,
      maximized: collapsed ? false : state.maximized,
    }));
    if (opts?.persist !== false) {
      setRightSidebarLayoutByChat((prev) => ({
        ...prev,
        [id]: { ...prev[id], collapsed },
      }));
    }
  }

  function toggleRightSidebarCollapsed() {
    setRightSidebarCollapsed(!rightSidebarCollapsed());
  }

  function setRightSidebarMaximized(maximized: boolean) {
    const id = currentRightSidebarScopeId();
    if (!id) return;
    updateCurrentRightSidebarState((state) => ({
      ...state,
      maximized,
      collapsed: maximized ? false : state.collapsed,
    }));
    if (maximized) {
      setRightSidebarLayoutByChat((prev) => ({
        ...prev,
        [id]: { ...prev[id], collapsed: false },
      }));
    }
  }

  function toggleRightSidebarMaximized() {
    setRightSidebarMaximized(!rightSidebarMaximized());
  }

  const stored = localStorage.getItem(sidebarLayout.key);
  const [sidebarW, setSidebarW_] = createSignal(
    sidebarLayout.clampWidth(stored),
  );
  function setSidebarW(width: number | string) {
    setSidebarW_(sidebarLayout.clampWidth(width, "percent", true));
  }
  const [collapsed, setCollapsed] = createSignal(
    localStorage.getItem(sidebarLayout.collapsedKey) === "1",
  );

  // URL routing: `/chat/<id>` for chats, `/apps/<appId>` for app panes, `/new`, `/facts[/<graph>][#<subject>]`, `/pointers`, `/skills`, `/apps`.
  type Loc =
    | { view: "chat"; chatId: string | null }
    | { view: "new" }
    | { view: "facts"; graph: string | null; subject: string | null }
    | { view: "pointers" }
    | { view: "skills" }
    | { view: "apps"; instanceId: string | null }
    | { view: "mcp" }
    | { view: "v8" }
    | { view: "settings" };

  function parseLocation(): Loc {
    const path = location.pathname.replace(/\/$/, "") || "/";
    if (path === "/new" || path.startsWith("/new/")) return { view: "new" };
    if (path.startsWith("/chat/")) {
      const parts = path
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
      return { view: "chat", chatId: parts[1] || null };
    }
    if (path === "/apps" || path.startsWith("/apps/")) {
      const parts = path
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
      return { view: "apps", instanceId: parts[1] || null };
    }
    if (path === "/facts" || path.startsWith("/facts/")) {
      const parts = path.split("/").filter(Boolean);
      const graph =
        parts.length > 1 ? decodeURIComponent(parts.slice(1).join("/")) : null;
      const hash = location.hash;
      return {
        view: "facts",
        graph,
        subject: hash ? decodeURIComponent(hash.slice(1)) : null,
      };
    }
    if (path === "/pointers" || path.startsWith("/pointers/"))
      return { view: "pointers" };
    if (path === "/skills" || path.startsWith("/skills/"))
      return { view: "skills" };
    if (path === "/mcp" || path.startsWith("/mcp/")) return { view: "mcp" };
    if (path === "/v8" || path.startsWith("/v8/")) return { view: "v8" };
    if (path === "/settings" || path.startsWith("/settings/"))
      return { view: "settings" };
    return { view: "chat", chatId: null };
  }

  function buildPath(
    v:
      | "chat"
      | "new"
      | "facts"
      | "pointers"
      | "skills"
      | "apps"
      | "mcp"
      | "v8"
      | "settings",
    id: string | null,
    subject: string | null,
    graph: string | null = null,
  ): string {
    if (v === "new") return "/new";
    if (v === "apps") {
      const uiId = openUiId();
      return uiId ? `/apps/${encodeURIComponent(uiId)}` : "/apps";
    }
    if (v === "facts") {
      const base = graph ? `/facts/${encodeURIComponent(graph)}` : "/facts";
      return subject ? `${base}#${encodeURIComponent(subject)}` : base;
    }
    if (v === "pointers") return "/pointers";
    if (v === "skills") return "/skills";
    if (v === "mcp") return "/mcp";
    if (v === "v8") return "/v8";
    if (v === "settings") return "/settings";
    if (!id) return "/";
    return `/chat/${encodeURIComponent(id)}`;
  }

  const initialOAuthCallback = (() => {
    const callbackPath = location.pathname.replace(/\/$/, "");
    if (
      callbackPath !== "/mcp/oauth/callback" &&
      callbackPath !== "/settings/oauth/callback"
    )
      return null;
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const oauthState = params.get("state");
    const error = params.get("error");
    if (code && oauthState)
      return {
        code,
        state: oauthState,
        kind: callbackPath === "/settings/oauth/callback" ? "llmAuth" : "mcp",
      };
    if (error) {
      return {
        error: params.get("error_description") || error || "OAuth login failed",
        kind: callbackPath === "/settings/oauth/callback" ? "llmAuth" : "mcp",
      };
    }
    return null;
  })();
  const [openUiId, setOpenUiId] = createSignal<string | null>(null);
  const [openUiInstanceId, setOpenUiInstanceId] = createSignal<string | null>(
    initialLoc.view === "apps" ? initialLoc.instanceId : null,
  );
  const [view, setView] = createSignal<
    | "chat"
    | "new"
    | "facts"
    | "pointers"
    | "skills"
    | "apps"
    | "mcp"
    | "v8"
    | "settings"
  >(initialLoc.view);
  const [focusedSubject, setFocusedSubject] = createSignal<string | null>(
    initialLoc.view === "facts" ? initialLoc.subject : null,
  );
  const [focusedGraph, setFocusedGraph] = createSignal<string | null>(
    initialLoc.view === "facts" ? initialLoc.graph : null,
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

  function showNewChat() {
    resetSelectedChatViewState({
      clearChatId: true,
      clearUi: true,
      clearWip: true,
    });
    setView("new");
    setFocusedSubject(null);
    setFocusedGraph(null);
    pushUrl();
  }

  function showFacts(subject?: string | null, graph?: string | null) {
    setView("facts");
    setFocusedSubject(subject ?? null);
    setFocusedGraph(graph ?? null);
    // Facts/vocab aren't refreshed on chat fact changes (too expensive),
    // so pull fresh data when the user actually opens the view.
    if (graph) refreshTriples(triplesRemovedMode(), graph);
    else refreshGraphSummaries();
    refreshVocabulary();
    pushUrl();
  }

  function showPointers() {
    setView("pointers");
    setFocusedSubject(null);
    setFocusedGraph(null);
    refreshPointers();
    pushUrl();
  }

  function showChat() {
    setView("chat");
    setFocusedSubject(null);
    setFocusedGraph(null);
    const id = chatId();
    if (id && !openUiId()) {
      const cached = chatCache.get(id)?.ui;
      if (cached)
        restorePrimaryUi(cached.primaryUiId ?? null, cached.instances);
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

  function showSkills() {
    setOpenUiId(null);
    setOpenUiInstanceId(null);
    setView("skills");
    setFocusedSubject(null);
    setFocusedGraph(null);
    void refreshSkills();
    pushUrl();
  }

  function showV8() {
    setOpenUiId(null);
    setOpenUiInstanceId(null);
    setView("v8");
    setFocusedSubject(null);
    setFocusedGraph(null);
    void refreshV8Stats();
    pushUrl();
  }

  function showSettings() {
    setOpenUiId(null);
    setOpenUiInstanceId(null);
    setView("settings");
    setFocusedSubject(null);
    setFocusedGraph(null);
    pushUrl();
  }

  const popstateHandler = () => {
    const loc = parseLocation();
    if (loc.view === "new") {
      resetSelectedChatViewState({
        clearChatId: true,
        clearUi: true,
        clearWip: true,
      });
      setView("new");
      setFocusedSubject(null);
      setFocusedGraph(null);
    } else if (loc.view === "facts") {
      setView("facts");
      setFocusedSubject(loc.subject);
      setFocusedGraph(loc.graph);
      if (loc.graph) void refreshTriples(triplesRemovedMode(), loc.graph);
      else void refreshGraphSummaries();
      void refreshVocabulary();
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
    } else if (loc.view === "skills") {
      setView("skills");
      setFocusedSubject(null);
      setFocusedGraph(null);
      setOpenUiId(null);
      setOpenUiInstanceId(null);
      void refreshSkills();
    } else if (loc.view === "v8") {
      setView("v8");
      setFocusedSubject(null);
      setFocusedGraph(null);
      setOpenUiId(null);
      setOpenUiInstanceId(null);
      void refreshV8Stats();
    } else if (loc.view === "settings") {
      setView(loc.view);
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
      const target =
        loc.view === "chat"
          ? (loc.chatId ?? chats()[0]?.chatId ?? null)
          : (chats()[0]?.chatId ?? null);
      if (target && target !== chatId()) {
        void selectChat(target, true);
      } else if (!target) {
        resetSelectedChatViewState({ clearChatId: true, clearWip: true });
        replaceUrl();
      } else {
        const cached = target ? chatCache.get(target)?.ui : null;
        if (cached)
          restorePrimaryUi(cached.primaryUiId ?? null, cached.instances);
        else if (target) void refreshChatUis();
        replaceUrl();
      }
    }
  };
  window.addEventListener("popstate", popstateHandler);
  onCleanup(() => window.removeEventListener("popstate", popstateHandler));

  createEffect(() => localStorage.setItem(sidebarLayout.key, sidebarW()));
  createEffect(() => persistRightSidebarLayout(rightSidebarLayoutByChat()));
  createEffect(on(chatId, () => clearRememberedRightSidebarMaximized()));
  createEffect(() =>
    localStorage.setItem(sidebarLayout.collapsedKey, collapsed() ? "1" : "0"),
  );
  createEffect(() =>
    localStorage.setItem(
      sidebarLayout.archivedCollapsedKey,
      archivedCollapsed() ? "1" : "0",
    ),
  );

  // -- fetchers ----------------------------------------------------------

  async function refreshChats() {
    const requestStartedAt = Date.now();
    const archiveRefreshGuard = captureChatArchiveRefreshGuard();
    const keepHiddenChatId = chatId();
    const existingHidden = keepHiddenChatId
      ? chats().find((chat) => chat.chatId === keepHiddenChatId && chat.hidden)
      : null;
    const normalizedExistingHidden = existingHidden
      ? withExpectedChatWorktreePath(existingHidden)
      : null;
    const r = await api("chats", {});
    if (r.ok) {
      const listedChats = withExpectedChatWorktreePaths(r.value.chats).filter(
        (chat) => !chatDeleteSeqByChat.has(chat.chatId),
      );
      const listedAndHiddenChats =
        normalizedExistingHidden &&
        !listedChats.some(
          (chat) => chat.chatId === normalizedExistingHidden.chatId,
        )
          ? sortChatsByRecency([normalizedExistingHidden, ...listedChats])
          : listedChats;
      const nextChats = applyChatArchiveRefreshGuard(
        listedAndHiddenChats,
        archiveRefreshGuard,
      );
      setChats(nextChats);
      setHomeDir_(r.value.homeDir ?? null);
      setChatsLoaded(true);
      refreshChatMemoryLater(nextChats.map((c) => c.chatId));
      // Sync activeChats from the server's running-chat truth so page
      // refreshes / reconnects reflect reality (step-start events that
      // fired before we connected aren't replayed). The chats listing now
      // returns status:"agent:Running" for any chat the Rust driver is
      // actively running; mirror that into the client-side set so
      // thinking() and the stop button work on cold load without relying on
      // local dispatch locks.
      // Use the same delete-tombstone filter as the sidebar list above: a
      // locally deleted chat the driver still reports as Running must not be
      // re-inserted into activeChats (it has no sidebar row and no future
      // step-end to clear it).
      const runningChats = r.value.chats.filter(
        (c) =>
          c.status === "agent:Running" && !chatDeleteSeqByChat.has(c.chatId),
      );
      const live = new Set(runningChats.map((c) => c.chatId));
      const staleActiveChats = new Set<string>();
      for (const id of activeChats()) {
        const activeStartedAt = Number(activeChatStartedAt().get(id));
        // Ignore chat-list responses that started before this turn, plus a
        // short start-race grace: step-start is published just before the Rust
        // running registry is updated, so an immediate chat-list can otherwise
        // make the sidebar blink idle while drafts/tools keep streaming.
        if (
          Number.isFinite(activeStartedAt) &&
          activeStartedAt + STALE_ACTIVE_CHAT_REFRESH_GRACE_MS >
            requestStartedAt
        ) {
          staleActiveChats.add(id);
          live.add(id);
        }
      }
      setActiveChats(live);
      setActiveChatStartedAt((current) => {
        const next = new Map<string, number>();
        for (const c of runningChats) {
          const hinted = Number(c.runningStartedAt);
          next.set(
            c.chatId,
            Number.isFinite(hinted) && hinted > 0
              ? hinted
              : (current.get(c.chatId) ?? Date.now()),
          );
        }
        for (const id of staleActiveChats) {
          const startedAt = current.get(id);
          if (startedAt != null) next.set(id, startedAt);
        }
        return next;
      });
      setCompactingChats((current) => {
        const next = new Set<string>();
        for (const id of live) if (current.has(id)) next.add(id);
        return next;
      });
      const currentChatId = chatId();
      if (currentChatId && !live.has(currentChatId)) {
        if (hasRunningTimelineRowForChat(currentChatId)) {
          await refreshBackgroundRunTS();
        }
        if (!chatHasLocalOpenTurn(currentChatId)) {
          releaseSettledChatRuntime(currentChatId);
        }
      }
      if (pending().some((p) => !live.has(p.chatId))) drainSoon();
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
    const r = await api("chat-settings", { chatIds: ids });
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
        const pending = pendingEffortWritesByChat.get(id);
        merged[id] = {
          effort: pending ? pending.effort : (next[id]?.effort ?? null),
        };
      }
      return merged;
    });
  }

  let chatMemoryRefreshTimer: number | null = null;
  let chatMemoryRefreshIds: Set<string> | null = null;
  function refreshChatMemoryLater(ids: string[], delayMs = 750) {
    if (ids.length === 0) return;
    if (!chatMemoryRefreshIds) chatMemoryRefreshIds = new Set();
    for (const id of ids) chatMemoryRefreshIds.add(id);
    if (chatMemoryRefreshTimer !== null) return;
    chatMemoryRefreshTimer = window.setTimeout(() => {
      chatMemoryRefreshTimer = null;
      const nextIds = [...(chatMemoryRefreshIds ?? new Set<string>())];
      chatMemoryRefreshIds = null;
      void refreshChatMemory(nextIds);
    }, delayMs);
  }

  async function refreshChatModel(opts?: { force?: boolean }) {
    const id = chatId();
    if (!id) return;
    if (!(await waitForChatCreation(id))) return;
    if (chatId() !== id) return;
    const requestSeq = ++chatModelRequestSeq;
    const bypassSingleFlight = Boolean(
      opts?.force ||
      pendingModelWritesByChat.has(id) ||
      pendingEffortWritesByChat.has(id),
    );
    if (bypassSingleFlight) chatModelsSingle.forget(id);
    const r = await retryChatLoad(
      () =>
        bypassSingleFlight
          ? api("chat-models", { chatId: id })
          : chatModelsSingle(id),
      () => chatId() === id && requestSeq === chatModelRequestSeq,
    );
    if (chatId() !== id || requestSeq !== chatModelRequestSeq) return;
    if (r.ok) {
      const model = modelWithPendingWrites(id, r.value);
      setChatModel(model);
      touchChatCache(id, { model });
    } else reportError(`models ${id}`, r.error);
  }

  // Single-flight describe per chat. Multiple in-flight describes can race:
  // a slower, earlier-issued one can clobber the timeline with stale data.
  // Coalesce into one in-flight + at most one queued re-fetch, keyed per chat
  // so that switching chats mid-flight does not clobber another chat's marker.
  const describeInFlight = new Set<string>();
  const describeRequeued = new Set<string>();
  let timelineMutationSeq = 0;
  const serverTimelineWatermarkByChat = new Map<string, number>();

  function rememberServerTimelineWatermark(id: string, items: TimelineItem[]) {
    const latest = newestTimelineWatermark(items);
    if (latest <= 0) return;
    serverTimelineWatermarkByChat.set(
      id,
      Math.max(serverTimelineWatermarkByChat.get(id) ?? 0, latest),
    );
  }

  function forgetServerTimelineWatermark(id: string) {
    serverTimelineWatermarkByChat.delete(id);
  }

  async function refreshTimeline(
    opts: { incremental?: boolean; showRefreshing?: boolean } = {},
  ) {
    const id = chatId();
    if (!id) return;
    const showInlineRefresh =
      opts.showRefreshing !== false &&
      loadedChatId() === id &&
      timeline().length > 0;
    if (describeInFlight.has(id)) {
      describeRequeued.add(id);
      if (showInlineRefresh) setTimelineRefreshing(true);
      return;
    }
    describeInFlight.add(id);
    const describeSeq = timelineMutationSeq;
    if (showInlineRefresh) setTimelineRefreshing(true);
    try {
      const limit = timelineLimit();
      const watermarkAt = serverTimelineWatermarkByChat.get(id) ?? 0;
      const incremental =
        opts.incremental === true && loadedChatId() === id && watermarkAt > 0;
      const sinceAt = incremental ? watermarkAt : undefined;
      const keepCurrentChat = () => chatId() === id;
      if (incremental) {
        const r = await retryChatLoad(
          () =>
            api("describe", {
              chatId: id,
              mode: "update",
              limit: Math.min(TIMELINE_PAGE_SIZE, limit),
              sinceAt,
            }),
          keepCurrentChat,
        );
        if (r.ok) cacheDescribeUpdate(id, r.value);
        if (chatId() !== id) return;
        if (!r.ok) {
          reportError(`describe ${id}`, r.error);
          return;
        }
        if (describeSeq !== timelineMutationSeq) {
          describeRequeued.add(id);
          return;
        }
        if (updateHasTimeline(r.value) && r.value.timeline.items.length) {
          applyTimelineUpdateValue(id, r.value);
        } else {
          applyUpdateValue(id, r.value);
        }
        return;
      }
      const r = await retryChatLoad(
        () => api("describe", { chatId: id, mode: "snapshot", limit }),
        keepCurrentChat,
      );
      if (r.ok) {
        cacheDescribeSnapshot(id, r.value, limit);
        if (chatId() !== id) return;
        if (describeSeq !== timelineMutationSeq) {
          describeRequeued.add(id);
          return;
        }
        applyDescribeValue(id, r.value);
      } else {
        if (chatId() !== id) return;
        reportError(`describe ${id}`, r.error);
      }
    } finally {
      describeInFlight.delete(id);
      if (chatId() === id) setTimelineRefreshing(false);
      if (describeRequeued.delete(id)) {
        queueMicrotask(refreshTimeline);
      }
    }
  }

  function timelineRowCompactionOptions(): TimelineRowCompactionOptions {
    return {
      limit: timelineLimit(),
      minimumLimit: INITIAL_TIMELINE_LIMIT,
      liveSlack: LIVE_TIMELINE_SLACK,
      rememberedKeys: timelineShown,
      maxRememberedKeys: MAX_REMEMBERED_TIMELINE_KEYS,
      nowMs: Date.now,
    };
  }

  function compactTimelineRows(items: TimelineItem[]): TimelineItem[] {
    return compactTimelineRowsWithOptions(
      items,
      timelineRowCompactionOptions(),
    );
  }

  function isBackgroundedRunTSTimelineItem(
    item: TimelineItem,
    id: string,
  ): boolean {
    return (
      item.type === "step" &&
      !!(item.runts || item.runjs) &&
      isRunTSBackgrounded(item.step, id)
    );
  }

  function timelineHasOpenForegroundStepSince(
    id: string,
    items: TimelineItem[],
    sinceAt?: number | null,
  ): boolean {
    const since = Number(sinceAt);
    return items.some(
      (item) =>
        item.type === "step" &&
        (!Number.isFinite(since) || since <= 0 || Number(item.at) >= since) &&
        !isTerminalStepStatus(item.status) &&
        item.kind !== "agent:UserInput" &&
        !isBackgroundedRunTSTimelineItem(item, id),
    );
  }

  function isManualCompactionStep(
    item: Extract<TimelineItem, { type: "step" }>,
  ): boolean {
    return (
      item.kind === "agent:Compaction" &&
      /^manual compaction(?:\n|$)/.test(item.text || "")
    );
  }

  function timelineRowsSettleActiveTurn(
    id: string,
    items: TimelineItem[],
  ): boolean {
    if (chatId() !== id) return false;
    const startedAt = Number(activeChatStartedAt().get(id));
    if (!Number.isFinite(startedAt) || startedAt <= 0) return false;
    if (timelineHasOpenForegroundStepSince(id, items, startedAt)) return false;
    const latest = items[items.length - 1];
    return (
      latest?.type === "step" &&
      (latest.kind === "agent:Reply" ||
        latest.kind === "agent:Error" ||
        isManualCompactionStep(latest)) &&
      isTerminalStepStatus(latest.status) &&
      Number(latest.at) >= startedAt
    );
  }

  function settleRunningTimelineRows(id: string) {
    if (chatId() !== id) return;
    setTimeline((items) => {
      let changed = false;
      const next = items.map((item) => {
        // Streaming-only rows such as RunTS drafts can still be agent:Queued
        // when the driver publishes step-end before the describe refresh lands.
        // Settle every nonterminal visible agent row here so chatBusy() stops
        // seeing a stale active turn and queued follow-ups can drain immediately.
        if (
          item.type !== "step" ||
          isTerminalStepStatus(item.status) ||
          item.kind === "agent:UserInput" ||
          isBackgroundedRunTSTimelineItem(item, id)
        )
          return item;
        changed = true;
        return { ...item, status: "agent:Done" } as TimelineItem;
      });
      return changed ? compactTimelineRows(next) : items;
    });
  }

  function settleTimelineStep(stepId: string, status: string = "agent:Done") {
    if (!stepId) return;
    setTimeline((items) => {
      let changed = false;
      const next = items.map((item) => {
        if (
          item.type !== "step" ||
          item.step !== stepId ||
          item.status !== "agent:Running"
        )
          return item;
        changed = true;
        return { ...item, status } as TimelineItem;
      });
      return changed ? compactTimelineRows(next) : items;
    });
  }

  function releaseSettledChatRuntime(id: string) {
    clearActiveChatRuntime(id);
    settleRunningTimelineRows(id);
    clearRunTSQueueUnblock(id);
    updateChatSummary(id, {
      status: "agent:Done",
      runningStartedAt: null,
    });
    if (pending().some((p) => p.chatId === id)) drainSoon();
  }

  function mergeTimelineUpdateRows(
    server: TimelineItem[],
    current: TimelineItem[],
  ): TimelineItem[] {
    return mergeTimelineUpdateRowsWithOptions(
      server,
      current,
      timelineRowCompactionOptions(),
    );
  }

  function mergeTimelineRows(
    server: TimelineItem[],
    current: TimelineItem[],
  ): TimelineItem[] {
    return mergeTimelineRowsWithOptions(
      server,
      current,
      timelineRowCompactionOptions(),
    );
  }

  function applyTriplesValue(value: TriplesValue) {
    setTriples(value.triples);
    setTriplesTruncated(Boolean(value.truncated));
    setTriplesLimit(typeof value.limit === "number" ? value.limit : null);
    setTriplesTotal(typeof value.total === "number" ? value.total : null);
  }

  function resetTriplesValue() {
    setTriples([]);
    setTriplesTruncated(false);
    setTriplesLimit(null);
    setTriplesTotal(null);
  }

  async function refreshGraphSummaries(
    removed: "exclude" | "include" | "only" = triplesRemovedMode(),
  ) {
    // Keep the current index visible during live updates. The loaded flag only
    // drives the initial empty-state spinner, so fact-change broadcasts update
    // the rows in place instead of blanking the page first.
    if (!graphSummariesLoaded()) setGraphSummariesLoaded(false);
    try {
      const r = await api("graph-summaries", { removed });
      if (r.ok) setGraphSummaries(r.value.graphs);
      else reportError("graph summaries", r.error);
    } catch (err) {
      reportError("graph summaries", err);
    } finally {
      setGraphSummariesLoaded(true);
    }
  }

  async function refreshPointers(prefix?: string) {
    try {
      const r = await api("pointers", { prefix });
      if (r.ok) setPointers(r.value.pointers);
      else reportError("pointers", r.error);
    } catch (err) {
      reportError("pointers", err);
    } finally {
      setPointersLoaded(true);
    }
  }

  async function removePointer(name: string, recursive = false) {
    const r = await api("pointer-rm", {
      name,
      ...(recursive ? { recursive: true } : {}),
    });
    if (!r.ok) {
      reportError(
        recursive ? "delete pointer hierarchy" : "delete pointer",
        r.error,
      );
      return;
    }
    if (!r.value.removed) {
      notify(
        "pointers",
        recursive ? "No pointers matched" : "Pointer was already gone",
      );
    } else if (recursive) {
      const removedCount = r.value.removedCount ?? 0;
      notify(
        "pointers",
        "Deleted " +
          removedCount +
          " pointer" +
          (removedCount === 1 ? "" : "s"),
      );
    }
    await refreshPointers();
  }

  async function refreshTriples(
    removed: "exclude" | "include" | "only" = triplesRemovedMode(),
    graph?: string | null,
  ) {
    setTriplesRemovedMode(removed);
    const nextGraph = graph ?? null;
    const sameScope =
      triplesLoaded() &&
      loadedTriplesGraph === nextGraph &&
      loadedTriplesRemoved === removed;
    // Preserve the current graph contents during same-scope live/background
    // refreshes. This avoids the /facts detail route flashing empty/loading
    // whenever a facts broadcast arrives; navigating to a different graph or
    // removed-facts mode still clears stale rows before loading.
    if (!sameScope) {
      setTriplesLoaded(false);
      resetTriplesValue();
    }
    try {
      const r = await api("triples", {
        removed,
        ...(graph ? { graph } : {}),
      });
      if (r.ok) {
        loadedTriplesGraph = nextGraph;
        loadedTriplesRemoved = removed;
        applyTriplesValue(r.value);
      } else reportError("triples", r.error);
    } catch (err) {
      reportError("triples", err);
    } finally {
      setTriplesLoaded(true);
    }
    if (graph) return;
    refreshGraphSummaries(removed);
  }

  async function refreshFactsView(
    removed: "exclude" | "include" | "only" = triplesRemovedMode(),
  ) {
    const graph = focusedGraph();
    if (graph) await refreshTriples(removed, graph);
    else await refreshGraphSummaries(removed);
  }

  async function refreshVocabulary() {
    const r = await api("vocabulary", {});
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

  function skillContext(): {
    enabled?: boolean;
    chatId?: string | null;
    root?: string | null;
  } {
    const current = chatId();
    return current ? { chatId: current } : {};
  }

  async function refreshSkills() {
    try {
      const r = await skillsListSingle(skillContext());
      if (r.ok) setSkills(r.value.skills);
      else reportError("skills", r.error);
    } catch (err) {
      reportError("skills", err);
    } finally {
      setSkillsLoaded(true);
    }
  }

  async function refreshSettingsCache() {
    setSettingsError(null);
    let firstError: string | null = null;
    const noteError = (message: string) => {
      if (!firstError) {
        firstError = message;
        setSettingsError(message);
      }
    };
    const errorMessage = (reason: unknown): string =>
      reason instanceof Error
        ? reason.message
        : String(reason || "Unknown settings error");

    const settings = settingsSingle()
      .then((result) => {
        if (result.ok) setSettingsCache(result.value.settings);
        else noteError(result.error.message);
      })
      .catch((reason) => noteError(errorMessage(reason)));
    const v8Settings = v8SettingsSingle()
      .then((result) => {
        if (result.ok) setV8SettingsCache(result.value);
        else noteError(result.error.message);
      })
      .catch((reason) => noteError(errorMessage(reason)));
    const otelSettingsReq = otelSettingsSingle()
      .then((result) => {
        if (result.ok) setOtelSettingsCache(result.value);
        else noteError(result.error.message);
      })
      .catch((reason) => noteError(errorMessage(reason)));

    await Promise.all([settings, v8Settings, otelSettingsReq]);
    setSettingsError(firstError);
  }

  function setCachedSettings(next: LlmAuthSettings) {
    setSettingsCache(next);
  }

  function setCachedV8Settings(next: V8SettingsValue) {
    setV8SettingsCache(next);
  }

  function setCachedOtelSettings(next: OtelSettingsValue) {
    setOtelSettingsCache(next);
  }

  let v8StatsRefreshInFlight: Promise<void> | null = null;
  let v8StatsRefreshQueued = false;

  async function refreshV8Stats() {
    if (v8StatsRefreshInFlight) {
      v8StatsRefreshQueued = true;
      return v8StatsRefreshInFlight;
    }
    v8StatsRefreshInFlight = (async () => {
      try {
        do {
          v8StatsRefreshQueued = false;
          const r = await api("v8-stats", {});
          setV8StatsLoaded(true);
          if (r.ok) setV8Stats(r.value);
          else reportError("v8 stats", r.error);
        } while (v8StatsRefreshQueued);
      } finally {
        v8StatsRefreshInFlight = null;
      }
    })();
    return v8StatsRefreshInFlight;
  }

  async function refreshChatUis() {
    const id = chatId();
    if (!id) return;
    const r = await retryChatLoad(
      () => uiChatSingle(id),
      () => chatId() === id,
    );
    if (chatId() !== id) return;
    if (r.ok) {
      setChatUiApps(r.value.apps);
      setUiInstances(r.value.instances);
      restorePrimaryUi(r.value.primaryUiId ?? null, r.value.instances);
      touchChatCache(id, {
        ui: {
          apps: r.value.apps,
          instances: r.value.instances,
          primaryUiId: r.value.primaryUiId ?? null,
        },
      });
    } else reportError("chat apps", r.error);
  }

  function normalizeUiInstanceId(id: string): string {
    return id.replace(/^uiinst:/, "");
  }

  function stripPrefix(value: string, prefix: string): string {
    return value.startsWith(prefix) ? value.slice(prefix.length) : value;
  }

  function restorePrimaryUi(
    primaryUiId: string | null,
    instances: UiInstance[],
  ) {
    if (!primaryUiId || view() !== "chat") return;
    const current = openUiId();
    if (current && current !== primaryUiId) return;
    const instanceId =
      instances.find((inst) => inst.uiId === primaryUiId)?.instanceId ?? null;
    const hasTab = hasAppRightSidebarTab(primaryUiId, instanceId);
    setOpenUiId(primaryUiId);
    setOpenUiInstanceId(instanceId);
    openAppRightSidebarTab(primaryUiId, instanceId, !hasTab);
  }

  async function resolveUiInstance(
    instanceId: string,
  ): Promise<{ uiId: string | null; chatId: string | null } | null> {
    const subject = "uiinst:" + normalizeUiInstanceId(instanceId);
    const r = await api("triples", { subject });
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

  async function openUiFromRoute(
    routeId: string,
    urlMode: "replace" | "none" = "none",
  ) {
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
    if (
      openUiInstanceId() !== normalizeUiInstanceId(instanceId) ||
      view() !== "apps"
    )
      return;
    if (!resolved?.uiId) {
      reportError("open app instance", {
        message: "app instance not found: " + instanceId,
      });
      return;
    }
    setOpenUiId(resolved.uiId);
    if (resolved.chatId && resolved.chatId !== chatId()) {
      setChatId(resolved.chatId);
      showTokensForChat(resolved.chatId);
      showTodosForChat(resolved.chatId);
      restoreDraftReplyForChat(resolved.chatId);
      forgetServerTimelineWatermark(resolved.chatId);
      const summary = chats().find((c) => c.chatId === resolved.chatId);
      const restored = restoreCachedChat(resolved.chatId, summary, {
        allowStale: true,
      });
      if (!restored) {
        setTimeline([]);
        setTrail([]);
        setTimelineLimit(INITIAL_TIMELINE_LIMIT);
        setHiddenTimelineItems(0);
        setLoadedChatId(null);
      }
      setTotalFacts(
        (restored ? totalFacts() : undefined) ?? summary?.totalFacts ?? 0,
      );
      setTotalTurns(
        (restored ? totalTurns() : undefined) ?? summary?.totalTurns ?? 0,
      );
      setTotalSteps(
        (restored ? totalSteps() : undefined) ?? summary?.totalSteps ?? 0,
      );
      setTotalCodeCalls(restored ? totalCodeCalls() : 0);
      if (!restored) showTokensForChat(resolved.chatId);
      if (!chatCache.get(resolved.chatId)?.model) setChatModel(null);
      if (!chatCache.get(resolved.chatId)?.ui) {
        setChatUiApps([]);
        setUiInstances([]);
      }
      loadWipText(resolved.chatId);
      await Promise.all([
        refreshTimeline(),
        refreshChatModel(),
        refreshChatUis(),
      ]);
    } else if (resolved.chatId) {
      await refreshChatUis();
    }
  }

  // -- chat lifecycle ----------------------------------------------------

  async function selectChat(
    id: string,
    replace = false,
    opts?: { hydrate?: boolean; focusComposer?: boolean },
  ) {
    setChatId(id);
    showTokensForChat(id);
    showTodosForChat(id);
    restoreDraftReplyForChat(id);
    forgetServerTimelineWatermark(id);
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
    const restored = restoreCachedChat(id, summary, { allowStale: true });
    if (!restored) {
      setTimeline([]);
      setTrail([]);
      setTimelineLimit(INITIAL_TIMELINE_LIMIT);
      setHiddenTimelineItems(0);
      setCompactions(null);
      setCompactionsLoading(false);
      setTimelineRefreshing(false);
      setTotalCodeCalls(0);
      setLoadedChatId(null);
    }
    setTotalFacts(
      (restored ? totalFacts() : undefined) ?? summary?.totalFacts ?? 0,
    );
    setTotalTurns(
      (restored ? totalTurns() : undefined) ?? summary?.totalTurns ?? 0,
    );
    setTotalSteps(
      (restored ? totalSteps() : undefined) ?? summary?.totalSteps ?? 0,
    );
    setTotalCodeCalls(restored ? totalCodeCalls() : 0);
    if (!restored) showTokensForChat(id);
    if (!chatCache.get(id)?.model) setChatModel(null);
    if (!chatCache.get(id)?.ui) {
      setChatUiApps([]);
      setUiInstances([]);
    }
    loadWipText(id);
    if (opts?.focusComposer) requestChatComposerFocus();
    if (replace) replaceUrl();
    else pushUrl();
    // Load the heavy conversation payload immediately unless the caller has
    // just created an empty chat and only needs navigation to complete.
    if (opts?.hydrate === false) {
      setLoadedChatId(id);
      return;
    }
    // The timeline is the only payload needed to make the chat readable. Model
    // settings and chat-scoped UI app metadata can be slower (env/provider
    // probing, app fact scans) and should not keep the startup overlay or route
    // navigation waiting on an otherwise ready conversation. Start them after
    // the first describe settles so they also do not contend with the initial
    // timeline request in small worker pools.
    if (restored) {
      queueMicrotask(() => {
        void (async () => {
          if (!(await waitForChatCreation(id))) return;
          if (chatId() !== id) return;
          void refreshTimeline({
            showRefreshing: cachedDescribeNeedsRefresh(id, summary),
          });
          void refreshChatModel();
          void refreshChatUis();
        })();
      });
      return;
    }
    if (!(await waitForChatCreation(id))) return;
    if (chatId() !== id) return;
    await refreshTimeline();
    if (chatId() !== id) return;
    queueMicrotask(() => {
      void (async () => {
        if (!(await waitForChatCreation(id))) return;
        if (chatId() !== id) return;
        void refreshChatModel();
        void refreshChatUis();
      })();
    });
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
    if (olderTimelineLoading()) return;
    const nextLimit = timelineLimit() + count;
    setTimelineLimit(nextLimit);
    const cached = cachedSnapshotForLimit(
      id,
      chats().find((chat) => chat.chatId === id),
      nextLimit,
    );
    if (cached) {
      applyDescribeValue(id, cached, []);
      return;
    }
    setOlderTimelineLoading(true);
    try {
      await refreshTimeline();
    } finally {
      setOlderTimelineLoading(false);
    }
  }

  async function refreshCompactions() {
    const id = chatId();
    if (!id) {
      setCompactions(null);
      return;
    }
    setCompactionsLoading(true);
    const r = await api("compactions", { chatId: id });
    if (chatId() !== id) return;
    setCompactionsLoading(false);
    if (r.ok) setCompactions(r.value);
    else reportError("compactions " + id, r.error);
  }

  const pendingChatCreations = new Map<string, Promise<boolean>>();
  const locallyCreatedChats = new Set<string>();

  async function waitForChatCreation(chat: string): Promise<boolean> {
    const pendingCreation = pendingChatCreations.get(chat);
    return pendingCreation ? await pendingCreation : true;
  }

  function optimisticChatId(): ChatId {
    const alphabet =
      "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const bytes = new Uint8Array(12);
    globalThis.crypto?.getRandomValues?.(bytes);
    let out = "";
    for (const byte of bytes) out += alphabet[byte % alphabet.length];
    if (out.length !== bytes.length || /^0+$/.test(out)) {
      out = Math.random().toString(36).slice(2, 14).padEnd(12, "0");
    }
    return out as ChatId;
  }

  async function createChat(
    path?: string,
    opts?: { select?: boolean; branch?: string | null },
  ): Promise<string | null> {
    // New chats are empty; don't block navigation on backend metadata writes,
    // path normalization, or branch checks. Pick the ID client-side, render the
    // empty chat immediately, then ask the backend to create that exact chat.
    const requestedChatId = optimisticChatId();
    locallyCreatedChats.add(requestedChatId);
    forgetChatCache(requestedChatId);
    forgetTokensForChat(requestedChatId);
    forgetTodosForChat(requestedChatId);
    forgetRightSidebarForChat(requestedChatId);
    const now = Date.now();
    const summary: ChatSummary = {
      chatId: requestedChatId,
      createdAt: now,
      lastAt: now,
      head: null,
      title: null,
      path: path ?? null,
      baseBranch: opts?.branch ?? null,
      worktreePath: expectedChatWorktreePath({
        chatId: requestedChatId,
        path: path ?? null,
      }),
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
    setChats((current) => [
      summary,
      ...current.filter((c) => c.chatId !== summary.chatId),
    ]);
    setChatsLoaded(true);

    const creation = (async () => {
      const r = await api("chat-new", {
        chatId: requestedChatId,
        path,
        branch: opts?.branch ?? undefined,
      });
      if (!r.ok) {
        reportError("new chat", r.error);
        locallyCreatedChats.delete(requestedChatId);
        setChats((current) =>
          current.filter((c) => c.chatId !== requestedChatId),
        );
        if (chatId() === requestedChatId) {
          const fallback = chats().find((c) => c.chatId !== requestedChatId);
          if (fallback) void selectChat(fallback.chatId);
          else {
            resetSelectedChatViewState({ clearChatId: true, clearWip: true });
          }
        }
        return false;
      }
      locallyCreatedChats.add(r.value.chatId);
      setChats((current) =>
        current.map((c) =>
          c.chatId === requestedChatId
            ? {
                ...c,
                chatId: r.value.chatId,
                path: r.value.path ?? c.path,
                baseBranch:
                  r.value.baseBranch ?? r.value.branch ?? c.baseBranch,
                worktreePath: r.value.worktreePath ?? c.worktreePath,
              }
            : c,
        ),
      );
      void refreshChats();
      return true;
    })();
    pendingChatCreations.set(requestedChatId, creation);
    void creation.finally(() => pendingChatCreations.delete(requestedChatId));

    if (opts?.select === false) {
      setChatId(requestedChatId);
      showTokensForChat(requestedChatId);
      showTodosForChat(requestedChatId);
      clearDraftReply(requestedChatId);
      setTimeline([]);
      setTrail([]);
      setTimelineLimit(INITIAL_TIMELINE_LIMIT);
      setHiddenTimelineItems(0);
      setCompactions(null);
      setCompactionsLoading(false);
      setTimelineRefreshing(false);
      setTotalFacts(0);
      setTotalTurns(0);
      setTotalSteps(0);
      setTotalCodeCalls(0);
      setLoadedChatId(requestedChatId);
      setChatModel(null);
      setChatUiApps([]);
      setUiInstances([]);
      loadWipText(requestedChatId);
    } else {
      await selectChat(requestedChatId, false, {
        hydrate: false,
        focusComposer: true,
      });
      queueMicrotask(() => {
        refreshChatModel();
        refreshChatUis();
      });
    }

    return requestedChatId;
  }

  async function removeChat(id: string) {
    const deleteSeq = ++chatDeleteSeq;
    chatDeleteSeqByChat.set(id, deleteSeq);
    const previousChats = chats();
    const previousChatId = chatId();
    const wasSelected = previousChatId === id;
    const nextChats = previousChats.filter((chat) => chat.chatId !== id);
    locallyCreatedChats.delete(id);

    // Delete should feel instantaneous even for a chat that is currently
    // thinking. Drop all local activity state and remove the sidebar row before
    // waiting for the backend, which pre-interrupts any running driver.
    setChats(nextChats);
    forgetChatCache(id);
    forgetTokensForChat(id);
    forgetTodosForChat(id);
    forgetRightSidebarForChat(id);
    // A chat deleted mid-stream would otherwise leak its in-flight draft and
    // live tool-call overlay, since no future event ever clears them.
    clearDraftReply(id);
    liveTimelineOverlayByChat.delete(id);
    deleteFromSet(setActiveChats, activeChats, id);
    deleteFromSet(setCompactingChats, compactingChats, id);
    deleteFromSet(setDispatchingChats, dispatchingChats, id);
    deleteFromSet(setInterruptingChats, interruptingChats, id);
    deleteFromSet(setInterruptedChats, interruptedChats, id);
    deleteChatStartedAt(id);

    if (wasSelected) {
      if (nextChats.length > 0) {
        void selectChat(nextChats[0]!.chatId);
      } else {
        resetSelectedChatViewState({
          clearChatId: true,
          clearUi: true,
          clearWip: true,
        });
        setView("chat");
        setFocusedSubject(null);
        replaceUrl();
      }
    }

    const r = await api("chat-rm", { chatId: id });
    if (!r.ok) {
      if (chatDeleteSeqByChat.get(id) === deleteSeq)
        chatDeleteSeqByChat.delete(id);
      setChats(previousChats);
      if (wasSelected && previousChatId) void selectChat(previousChatId);
      reportError(`remove ${id}`, r.error);
    } else if (chatDeleteSeqByChat.get(id) === deleteSeq) {
      // Delete confirmed server-side; drop the tombstone so the map doesn't
      // grow without bound. Guard on deleteSeq so a newer delete of a
      // recreated id isn't cleared out from under us.
      chatDeleteSeqByChat.delete(id);
    }
  }

  async function removeGraph(graph: string) {
    const r = await api("graph-rm", { graph });
    if (!r.ok) {
      reportError(`remove graph ${graph}`, r.error);
      return;
    }
    // Chat graphs round-trip through chat removal, which also dropped the
    // chat's metadata refs — remove the row locally instead of refreshing the
    // full sidebar list.
    if (r.value.chatId) {
      setChats((current) =>
        current.filter((chat) => chat.chatId !== r.value.chatId),
      );
      forgetChatCache(r.value.chatId);
    }
    await Promise.all([refreshFactsView(), refreshVocabulary()]);
  }

  function hasAppRightSidebarTab(
    uiId: string,
    instanceId: string | null,
  ): boolean {
    return rightSidebarTabs().some(
      (tab) =>
        tab.kind === "app" &&
        tab.uiId === uiId &&
        tab.instanceId === instanceId,
    );
  }

  function openAppRightSidebarTab(
    uiId: string,
    instanceId: string | null,
    activate = true,
  ) {
    upsertRightSidebarTab(
      {
        id: appTabId(uiId, instanceId),
        kind: "app",
        title: appTitle(uiId),
        uiId,
        instanceId,
        icon: appIcon(uiId),
      },
      activate,
    );
    setFocusedSubject(null);
  }

  function openAppCodeInSidebar(uiId: string) {
    const trimmed = uiId.trim();
    if (!trimmed) return;
    const app = uiApps().find((candidate) => candidate.id === trimmed);
    upsertRightSidebarTab({
      id: appCodeTabId(trimmed),
      kind: "app-code",
      title: app?.title || trimmed,
      uiId: trimmed,
      icon: app?.icon,
    });
    setOpenUiId(null);
    setOpenUiInstanceId(null);
    setFocusedSubject(null);
  }
  async function openUi(
    uiId: string,
    instanceId?: string,
    urlMode: "push" | "replace" | "none" = "push",
  ) {
    let chat = chatId();
    if (!chat) chat = await createChat(undefined, { select: false });
    if (!chat) return;

    // Open apps in the shared right sidebar, preserving the current main view.
    const targetInstanceId = instanceId ?? null;
    const existing = activateExistingRightSidebarTab(
      (tab): tab is Extract<RightSidebarTab, { kind: "app" }> =>
        tab.kind === "app" &&
        tab.uiId === uiId &&
        tab.instanceId === targetInstanceId,
    );
    if (existing) {
      setOpenUiId(existing.uiId);
      setOpenUiInstanceId(existing.instanceId);
      if (urlMode === "push") pushUrl();
      else if (urlMode === "replace") replaceUrl();
      return;
    }
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

    const r = await api("ui-open", { chatId: chat, uiId, instanceId });
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
        icon: appIcon(r.value.uiId),
      };
      const withoutPending = state.tabs.filter(
        (candidate) =>
          candidate.id !== pendingTabId && candidate.id !== resolvedTabId,
      );
      return {
        ...state,
        tabs: [...withoutPending, tab],
        activeTabId: resolvedTabId,
        collapsed: false,
      };
    });
    if (urlMode === "push" || urlMode === "replace") replaceUrl();
    refreshChatUis();
  }

  async function removeUi(uiId: string) {
    const r = await api("ui-remove", { uiId });
    if (!r.ok) {
      reportError(`delete app ${uiId}`, r.error);
      return;
    }
    setUiApps((apps) => apps.filter((a) => a.id !== uiId));
    setChatUiApps((apps) => apps.filter((a) => a.id !== uiId));
    if (openUiId() === uiId) {
      setOpenUiId(null);
      setOpenUiInstanceId(null);
      for (const tab of rightSidebarTabs())
        if (
          (tab.kind === "app" || tab.kind === "app-code") &&
          tab.uiId === uiId
        )
          void closeRightSidebarTab(tab.id);
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
  // Follow-up messages are mirrored to the harness DB so the queue survives
  // frontend reloads and is shared across clients. The frontend still owns
  // editability and drain timing; Rust driver state does not own this queue.

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
  // Chats explicitly interrupted with queue pausing stay paused even after the
  // server publishes step-end. Normal cancellation paths (Esc and Stop) resume
  // already-queued follow-up messages after the current run is interrupted.
  const [interruptedChats, setInterruptedChats] = createSignal<Set<string>>(
    new Set(),
  );
  const [editingPendingIds, setEditingPendingIds] = createSignal<Set<string>>(
    new Set(),
  );
  let draining = false;
  let drainRequested = false;
  let pendingLoaded = false;
  let suppressPendingSave = false;

  function drainSoon() {
    if (draining) {
      drainRequested = true;
      return;
    }
    queueMicrotask(drain);
  }

  async function loadPendingMessages() {
    const r = await api("pending-messages", {});
    if (!r.ok) {
      reportError("load pending messages", r.error);
      pendingLoaded = true;
      return;
    }
    suppressPendingSave = true;
    const local = pending();
    const localIds = new Set(local.map((message) => message.id));
    setPending([
      ...r.value.messages.filter((message) => !localIds.has(message.id)),
      ...local,
    ]);
    suppressPendingSave = false;
    pendingLoaded = true;
    if (local.length > 0) {
      void api("pending-messages-save", { messages: pending() }).then(
        (save) => {
          if (!save.ok) reportError("save pending messages", save.error);
        },
      );
    }
    drainSoon();
  }

  const wipKey = (id: string) => `moo.wip.${id}`;
  function loadWipText(id: string) {
    setWipText(localStorage.getItem(wipKey(id)) ?? "");
  }

  function resetSelectedChatViewState(
    opts: {
      clearChatId?: boolean;
      clearUi?: boolean;
      clearWip?: boolean;
    } = {},
  ) {
    if (opts.clearChatId) setChatId(null);
    showTokensForChat(null);
    showTodosForChat(null);
    clearDraftReply();
    setTimeline([]);
    setTrail([]);
    setTimelineLimit(INITIAL_TIMELINE_LIMIT);
    setHiddenTimelineItems(0);
    setOlderTimelineLoading(false);
    setCompactions(null);
    setCompactionsLoading(false);
    setTimelineRefreshing(false);
    setTotalFacts(0);
    setTotalTurns(0);
    setTotalSteps(0);
    setTotalCodeCalls(0);
    setLoadedChatId(null);
    setChatModel(null);
    setChatUiApps([]);
    setUiInstances([]);
    if (opts.clearUi) {
      setOpenUiId(null);
      setOpenUiInstanceId(null);
    }
    if (opts.clearWip) setWipText("");
  }
  createEffect(() => {
    const id = chatId();
    if (!id) return;
    const text = wipText();
    if (text === "") localStorage.removeItem(wipKey(id));
    else localStorage.setItem(wipKey(id), text);
  });

  void loadPendingMessages();
  createEffect(() => {
    const pen = pending();
    if (!pendingLoaded || suppressPendingSave) return;
    void api("pending-messages-save", { messages: pen }).then((r) => {
      if (!r.ok) reportError("save pending messages", r.error);
    });
  });

  function isMcpSetupMessage(text: string): boolean {
    return text.trim().toLowerCase() === "mcp setup";
  }

  function newPendingMessageId() {
    return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 6)}`;
  }

  function shouldSendImmediately(chat: string) {
    return (
      (pendingLoaded || locallyCreatedChats.has(chat)) &&
      !chatBusy(chat) &&
      !pending().some((message) => message.chatId === chat)
    );
  }

  function enqueueMessage(text: string, attachments: ImageAttachment[] = []) {
    const cid = chatId();
    if (!cid) {
      reportError("send message", "Start a new chat first.");
      return;
    }
    deleteFromSet(setInterruptedChats, interruptedChats, cid);
    const id = newPendingMessageId();
    if (shouldSendImmediately(cid)) {
      dispatchQueuedMessage({ id, text, chatId: cid, attachments });
      return;
    }
    setPending([
      ...pending(),
      { id, text, chatId: cid, ...(attachments.length ? { attachments } : {}) },
    ]);
    drainSoon();
  }

  function editPending(id: string, text: string) {
    setPending(pending().map((p) => (p.id === id ? { ...p, text } : p)));
  }

  function addPendingAttachments(id: string, attachments: ImageAttachment[]) {
    if (attachments.length === 0) return;
    setPending(
      pending().map((p) =>
        p.id === id
          ? { ...p, attachments: [...(p.attachments || []), ...attachments] }
          : p,
      ),
    );
  }

  function removePendingAttachment(id: string, index: number) {
    setPending(
      pending().map((p) => {
        if (p.id !== id) return p;
        const next = (p.attachments || []).filter((_, i) => i !== index);
        return next.length
          ? { ...p, attachments: next }
          : (({ attachments: _attachments, ...rest }) => rest)(p);
      }),
    );
  }

  function removePending(id: string) {
    setPending(pending().filter((p) => p.id !== id));
    setEditingPendingIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }
  async function steerPending(id: string) {
    const item = pending().find((p) => p.id === id);
    if (!item) return;
    setPending(pending().filter((p) => p.id !== id));
    setEditingPendingIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    addToSet(setInterruptedChats, interruptedChats, item.chatId);
    if (activeChats().has(item.chatId)) {
      const previousChatId = chatId();
      if (previousChatId !== item.chatId) setChatId(item.chatId);
      await interruptAgent({ resumeQueued: false, offerResume: false });
      if (previousChatId && previousChatId !== item.chatId)
        setChatId(previousChatId);
    }
    deleteFromSet(setInterruptedChats, interruptedChats, item.chatId);
    setPending([item, ...pending()]);
    drainSoon();
  }

  function beginPendingEdit(id: string) {
    setEditingPendingIds((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }

  function endPendingEdit(id: string) {
    setEditingPendingIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    drainSoon();
  }

  function appendOptimisticUserInput(
    chat: string,
    id: string,
    text: string,
    attachments: ImageAttachment[] = [],
  ) {
    if (chatId() !== chat) return;
    setTimeline([
      ...timeline(),
      {
        type: "step",
        step: `opt-${id}`,
        kind: "agent:UserInput",
        status: "agent:Done",
        at: Date.now(),
        text,
        ...(attachments.length ? { attachments } : {}),
      } as TimelineItem,
    ]);
    forgetChatCache(chat);
  }

  async function dispatchMessageNow(
    chat: string,
    text: string,
    attachments: ImageAttachment[] = [],
    label = "step",
  ) {
    const id = newPendingMessageId();
    appendOptimisticUserInput(chat, id, text, attachments);
    if (!(await waitForChatCreation(chat))) return;
    await waitForChatSettingsWrites(chat);
    const r = await api("step", {
      chatId: chat,
      message: text,
      ...(attachments.length ? { attachments } : {}),
    });
    if (!r.ok) reportError(`${label} ${chat}`, r.error);
  }

  async function dispatchQueuedMessage(head: {
    id: string;
    text: string;
    chatId: string;
    attachments?: ImageAttachment[];
  }) {
    clearRunTSQueueUnblock(head.chatId);
    const attachments = head.attachments || [];
    if (isMcpSetupMessage(head.text)) {
      deleteFromSet(setInterruptedChats, interruptedChats, head.chatId);
      void dispatchMessageNow(head.chatId, head.text, attachments, "MCP setup");
      return;
    }

    // Lock local dispatch before /api/run returns so another queued item
    // for the same chat cannot be picked before the step-start WS event.
    // Do not mark the chat active here: the visible thinking state should
    // wait for the server-confirmed step-start event or running status.
    addToSet(setDispatchingChats, dispatchingChats, head.chatId);

    appendOptimisticUserInput(head.chatId, head.id, head.text, attachments);
    // /api/run now returns immediately; the chat driver runs the agent
    // loop in the background. Keep the local dispatch lock until
    // step-start/step-end (or an error) so follow-up messages remain
    // queued/editable without showing the thinking indicator early.
    if (!(await waitForChatCreation(head.chatId))) {
      deleteFromSet(setDispatchingChats, dispatchingChats, head.chatId);
      return;
    }
    await waitForChatSettingsWrites(head.chatId);
    const r = await api("step", {
      chatId: head.chatId,
      message: head.text,
      ...(attachments.length ? { attachments } : {}),
    });
    if (!r.ok) {
      reportError(`step ${head.chatId}`, r.error);
      deleteFromSet(setDispatchingChats, dispatchingChats, head.chatId);
    }
  }

  async function drain() {
    if (draining) {
      drainRequested = true;
      return;
    }
    if (!pendingLoaded) return;
    draining = true;
    drainRequested = false;
    try {
      while (true) {
        const pen = pending();
        const paused = interruptedChats();
        const editing = editingPendingIds();
        const idx = pen.findIndex(
          (p, i) =>
            !editing.has(p.id) &&
            !paused.has(p.chatId) &&
            (isMcpSetupMessage(p.text) || !chatBusy(p.chatId)) &&
            (isMcpSetupMessage(p.text) ||
              !pen.slice(0, i).some((earlier) => earlier.chatId === p.chatId)),
        );
        if (idx < 0) break;
        const head = pen[idx]!;
        setPending([...pen.slice(0, idx), ...pen.slice(idx + 1)]);
        await dispatchQueuedMessage(head);
      }
    } finally {
      draining = false;
      if (drainRequested) drainSoon();
    }
  }

  function touchModelMru(model: string | null | undefined) {
    const normalized = String(model ?? "").trim();
    if (!normalized) return;
    setModelMru((current) => {
      const next = normalizeModelMru([
        normalized,
        ...current.filter((m) => m !== normalized),
      ]);
      persistModelMru(next);
      return next;
    });
  }

  function patchMessageVisibility(
    id: string,
    step: string,
    deletedAt: number | string | null,
  ) {
    const patchRows = (rows: TimelineItem[]): TimelineItem[] => {
      let changed = false;
      const next = rows.map((item) => {
        if (
          item.type !== "step" ||
          item.step !== step ||
          item.kind !== "agent:UserInput"
        ) {
          return item;
        }
        const currentDeletedAt = item.deletedAt ?? null;
        if (currentDeletedAt === deletedAt) return item;
        changed = true;
        if (deletedAt == null) {
          const { deletedAt: _deletedAt, ...rest } = item;
          return rest as TimelineItem;
        }
        return { ...item, deletedAt };
      });
      return changed ? next : rows;
    };

    setTimeline((current) => patchRows(current));

    const cached = chatCache.get(id);
    if (cached?.timelinePages || cached?.trailPages) {
      let changed = false;
      const timelinePages = cached.timelinePages
        ? Object.fromEntries(
            Object.entries(cached.timelinePages).map(([key, page]) => {
              const items = patchRows(page.items);
              if (items !== page.items) changed = true;
              return [key, items === page.items ? page : { ...page, items }];
            }),
          )
        : undefined;
      const trailPages = cached.trailPages
        ? Object.fromEntries(
            Object.entries(cached.trailPages).map(([key, page]) => {
              const items = patchRows(page.items);
              if (items !== page.items) changed = true;
              return [key, items === page.items ? page : { ...page, items }];
            }),
          )
        : undefined;
      if (changed) touchChatCache(id, { timelinePages, trailPages });
    }
  }

  async function deleteMessage(step: string) {
    const id = chatId();
    if (!id) return;
    const mutationSeq = ++timelineMutationSeq;
    const optimisticDeletedAt = Date.now();
    patchMessageVisibility(id, step, optimisticDeletedAt);
    const r = await api("message-delete", { chatId: id, step });
    if (!r.ok) {
      patchMessageVisibility(id, step, null);
      reportError("hide message", r.error);
      return;
    }
    if (chatId() !== id || mutationSeq !== timelineMutationSeq) return;
    patchMessageVisibility(id, step, r.value.deletedAt);
    void refreshTimeline();
  }

  async function restoreMessage(step: string) {
    const id = chatId();
    if (!id) return;
    const mutationSeq = ++timelineMutationSeq;
    const previousItem = timeline().find(
      (item): item is Extract<TimelineItem, { type: "step" }> =>
        item.type === "step" && item.step === step,
    );
    const previousDeletedAt = previousItem?.deletedAt;
    patchMessageVisibility(id, step, null);
    const r = await api("message-restore", { chatId: id, step });
    if (!r.ok) {
      patchMessageVisibility(id, step, previousDeletedAt ?? Date.now());
      reportError("restore message", r.error);
      return;
    }
    if (chatId() !== id || mutationSeq !== timelineMutationSeq) return;
    patchMessageVisibility(id, step, null);
    void refreshTimeline();
  }

  function forkTitle(title: string | null, id: string): string {
    const base = (title || displayChatId(id)).trim() || id;
    const suffix = " fork";
    const maxBase = 80 - suffix.length;
    return (
      (base.length > maxBase ? base.slice(0, maxBase).trimEnd() : base) + suffix
    );
  }

  function seededForkTimeline(step: string): {
    items: TimelineItem[];
    hiddenItems: number;
    totalSteps: number;
    totalTurns: number;
    totalCodeCalls: number;
  } | null {
    const current = timeline();
    const targetIndex = current.findIndex(
      (item) => item.type === "step" && item.step === step,
    );
    if (targetIndex < 0) return null;
    const items = current.slice(0, targetIndex + 1);
    const after = current.slice(targetIndex + 1);
    const stepsAfter = after.filter((item) => item.type === "step").length;
    const turnsAfter = after.filter(
      (item) => item.type === "step" && item.kind === "agent:UserInput",
    ).length;
    const runJsAfter = after.filter(
      (item) =>
        item.type === "step" &&
        (item.kind === "agent:RunTS" || item.kind === "agent:RunJS"),
    ).length;
    return {
      items,
      hiddenItems: hiddenTimelineItems(),
      totalSteps: Math.max(0, totalSteps() - stepsAfter),
      totalTurns: Math.max(0, totalTurns() - turnsAfter),
      totalCodeCalls: Math.max(0, totalCodeCalls() - runJsAfter),
    };
  }

  function seedForkChatCache(
    forkChatId: ChatId,
    sourceChatId: string,
    step: string,
    summary: ChatSummary,
    page: NonNullable<ReturnType<typeof seededForkTimeline>>,
  ) {
    const now = Date.now();
    const timelineKey = timelineCacheKey(
      Math.max(INITIAL_TIMELINE_LIMIT, page.items.length),
    );
    const trailItems = trail().filter((item) => {
      const target = page.items[page.items.length - 1];
      return !target || item.at <= target.at;
    });
    const trailKey = trailCacheKey(
      Math.max(INITIAL_TIMELINE_LIMIT, trailItems.length),
    );
    const overview: DescribeOverviewValue = {
      chatId: forkChatId,
      title: summary.title,
      path: summary.path,
      worktreePath: summary.worktreePath,
      createdAt: summary.createdAt,
      lastAt: summary.lastAt,
      parentChatId: sourceChatId as ChatId,
      head: step,
      totalFacts: summary.totalFacts,
      totalTurns: summary.totalTurns,
      totalSteps: summary.totalSteps,
      totalCodeCalls: page.totalCodeCalls,
      tokens: tokens() ?? {
        used: 0,
        budget: 0,
        threshold: 0,
        fraction: 0,
        estimated: true,
      },
      todos: currentTodosForChat(sourceChatId),
      totalTimelineItems: page.hiddenItems + page.items.length,
      compaction: null,
    };
    const model = chatModel();
    touchChatCache(forkChatId, {
      overview,
      timelinePages: {
        [timelineKey]: {
          items: page.items,
          hiddenItems: page.hiddenItems,
          limit: Math.max(INITIAL_TIMELINE_LIMIT, page.items.length),
          cachedAt: now,
          accessedAt: now,
        },
      },
      trailPages: {
        [trailKey]: {
          items: trailItems,
          limit: Math.max(INITIAL_TIMELINE_LIMIT, trailItems.length),
          cachedAt: now,
          accessedAt: now,
        },
      },
      activeTimelineKey: timelineKey,
      activeTrailKey: trailKey,
      ...(model ? { model: { ...model, chatId: forkChatId } } : {}),
    });
    applyTodosForChat(forkChatId, currentTodosForChat(sourceChatId));
  }

  async function forkChatAtStep(step: string) {
    const id = chatId();
    if (!id) return null;
    const sourceSummary = chats().find((chat) => chat.chatId === id);
    const page = seededForkTimeline(step);
    if (!page) return null;

    const requestedChatId = optimisticChatId();
    const now = Date.now();
    const summary: ChatSummary = {
      chatId: requestedChatId,
      createdAt: now,
      lastAt: now,
      head: step,
      title: forkTitle(sourceSummary?.title ?? null, id),
      path: sourceSummary?.path ?? null,
      baseBranch: sourceSummary?.baseBranch ?? null,
      worktreePath: expectedChatWorktreePath({
        chatId: requestedChatId,
        path: sourceSummary?.path ?? null,
      }),
      status: "agent:Done",
      totalFacts: totalFacts(),
      totalTurns: page.totalTurns,
      totalSteps: page.totalSteps,
      usage: null,
      costUsd: 0,
      costEstimated: true,
      unpricedModels: [],
      selectedModel:
        chatModel()?.selectedModel ?? sourceSummary?.selectedModel ?? null,
      archived: false,
      archivedAt: null,
      parentChatId: id as ChatId,
    };

    seedForkChatCache(requestedChatId, id, step, summary, page);
    setChats((current) => [
      summary,
      ...current.filter((chat) => chat.chatId !== requestedChatId),
    ]);
    setChatsLoaded(true);

    const creation = (async () => {
      const r = await api("chat-fork", {
        chatId: id as ChatId,
        step: step as StepId,
        forkChatId: requestedChatId,
      });
      if (!r.ok) {
        reportError("fork chat", r.error);
        setChats((current) =>
          current.filter((chat) => chat.chatId !== requestedChatId),
        );
        forgetChatCache(requestedChatId);
        forgetTodosForChat(requestedChatId);
        if (chatId() === requestedChatId) void selectChat(id);
        return false;
      }
      setChats((current) =>
        current.map((chat) =>
          chat.chatId === requestedChatId
            ? {
                ...chat,
                chatId: r.value.chatId,
                path: r.value.path ?? chat.path,
                baseBranch: r.value.baseBranch ?? chat.baseBranch,
                worktreePath: r.value.worktreePath ?? chat.worktreePath,
                lastAt: Date.now(),
              }
            : chat,
        ),
      );
      void refreshChats();
      return true;
    })();
    pendingChatCreations.set(requestedChatId, creation);
    void creation.finally(() => pendingChatCreations.delete(requestedChatId));

    await selectChat(requestedChatId, false);
    return requestedChatId;
  }

  async function setSelectedModel(model: string | null) {
    const id = chatId();
    if (!id) return;
    const writeSeq = (chatModelWriteSeqByChat.get(id) ?? 0) + 1;
    chatModelWriteSeqByChat.set(id, writeSeq);
    pendingModelWritesByChat.set(id, { seq: writeSeq, model });
    const currentModel = chatModel();
    if (currentModel?.chatId === id) {
      const optimisticModel = modelWithPendingWrites(id, currentModel);
      setChatModel(optimisticModel);
      touchChatCache(id, { model: optimisticModel });
    }
    // Invalidate any in-flight chat-models refresh for this chat before the
    // write starts. Fact-change events can also schedule refreshes while the
    // API call is pending; the write response is authoritative if it is still
    // the newest user write for this chat when it returns.
    ++chatModelRequestSeq;
    chatModelsSingle.forget(id);
    return chatSettingsWrites.run(id, async () => {
      const r = await api("chat-model-set", { chatId: id, model });
      chatModelsSingle.forget(id);
      if (writeSeq !== chatModelWriteSeqByChat.get(id)) {
        if (pendingModelWritesByChat.get(id)?.seq === writeSeq)
          pendingModelWritesByChat.delete(id);
        return;
      }
      if (pendingModelWritesByChat.get(id)?.seq === writeSeq)
        pendingModelWritesByChat.delete(id);
      if (r.ok) {
        const modelInfo = modelWithPendingWrites(id, r.value);
        touchChatCache(id, { model: modelInfo });
        touchModelMru(
          r.value.effectiveModelId || r.value.effectiveModel || model,
        );
        applyChatModelToSummary(r.value);
        if (chatId() === id) {
          ++chatModelRequestSeq;
          setChatModel(modelInfo);
        }
      } else {
        reportError(`set model ${id}`, r.error);
        if (chatId() === id) refreshChatModel({ force: true });
        else forgetChatCache(id);
      }
    });
  }

  async function setSelectedEffort(effort: string | null) {
    const id = chatId();
    if (!id) return;
    const writeSeq = (chatEffortWriteSeqByChat.get(id) ?? 0) + 1;
    chatEffortWriteSeqByChat.set(id, writeSeq);
    const normalizedEffort = normalizeEffort(effort);
    const isDefaultEffort = effort == null || !String(effort).trim();
    const optimisticEffort = isDefaultEffort ? null : normalizedEffort;
    // Prevent chat-settings refreshes from rolling back the optimistic
    // effort/default choice while the write is in flight.
    ++chatMemoryRequestSeq;
    if (isDefaultEffort || normalizedEffort) {
      pendingEffortWritesByChat.set(id, {
        seq: writeSeq,
        effort: optimisticEffort,
      });
      setChatMemory((current) => ({
        ...current,
        [id]: { effort: optimisticEffort },
      }));
      const currentModel = chatModel();
      if (currentModel?.chatId === id) {
        const optimisticModel = modelWithPendingWrites(id, currentModel);
        setChatModel(optimisticModel);
        touchChatCache(id, { model: optimisticModel });
      }
    }
    // Do not let a chat facts refresh, often emitted by this same write, make
    // the effort setter ignore its response or let stale model info remain in
    // the per-chat cache when the user switches away and back.
    ++chatModelRequestSeq;
    chatModelsSingle.forget(id);
    return chatSettingsWrites.run(id, async () => {
      const r = await api("chat-effort-set", { chatId: id, effort });
      chatModelsSingle.forget(id);
      if (writeSeq !== chatEffortWriteSeqByChat.get(id)) {
        if (pendingEffortWritesByChat.get(id)?.seq === writeSeq)
          pendingEffortWritesByChat.delete(id);
        ++chatMemoryRequestSeq;
        refreshChatMemory([id]);
        return;
      }
      if (pendingEffortWritesByChat.get(id)?.seq === writeSeq)
        pendingEffortWritesByChat.delete(id);
      ++chatMemoryRequestSeq;
      if (r.ok) {
        setChatMemory((current) => ({
          ...current,
          [id]: { effort: normalizeEffort(r.value.selectedEffort) },
        }));
        const modelInfo = modelWithPendingWrites(id, r.value);
        touchChatCache(id, { model: modelInfo });
        refreshChatMemory([id]);
        if (chatId() === id) {
          ++chatModelRequestSeq;
          setChatModel(modelInfo);
        }
      } else {
        reportError(`set effort ${id}`, r.error);
        refreshChatMemory([id]);
        if (chatId() === id) refreshChatModel({ force: true });
        else forgetChatCache(id);
      }
    });
  }

  async function renameChat(id: string, title: string | null) {
    const previous = chats().find((chat) => chat.chatId === id)?.title ?? null;
    updateChatSummary(id, { title });
    const r = await api("chat-rename", { chatId: id, title });
    if (r.ok) {
      updateChatSummary(id, { title: r.value.title });
    } else {
      updateChatSummary(id, { title: previous });
      reportError(`rename ${id}`, r.error);
    }
  }

  async function archiveChat(id: string, archived: boolean) {
    const previous = chats().find((chat) => chat.chatId === id) ?? null;
    const optimisticArchivedAt = archived ? Date.now() : null;
    const writeSeq = (chatArchiveWriteSeqByChat.get(id) ?? 0) + 1;
    chatArchiveWriteSeqByChat.set(id, writeSeq);
    chatArchiveWriteVersionByChat.set(id, ++chatArchiveWriteVersion);
    pendingArchiveWritesByChat.set(id, {
      seq: writeSeq,
      archived,
      archivedAt: optimisticArchivedAt,
    });

    // Move the row immediately. A full chat refresh is comparatively expensive
    // because it scans per-chat refs/facts, so waiting for it makes archive feel
    // like it takes multiple seconds to propagate in the sidebar. Keep the
    // pending write recorded so stale in-flight refreshes cannot move the row
    // back and make it appear to archive twice.
    setChats((current) =>
      current.map((chat) =>
        chat.chatId === id
          ? { ...chat, archived, archivedAt: optimisticArchivedAt }
          : chat,
      ),
    );

    const r = await api("chat-archive", { chatId: id, archived });
    if (chatArchiveWriteSeqByChat.get(id) !== writeSeq) {
      if (pendingArchiveWritesByChat.get(id)?.seq === writeSeq) {
        pendingArchiveWritesByChat.delete(id);
      }
      return;
    }
    if (pendingArchiveWritesByChat.get(id)?.seq === writeSeq) {
      pendingArchiveWritesByChat.delete(id);
    }
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
          ? {
              ...chat,
              archived: r.value.archived,
              archivedAt: r.value.archivedAt,
            }
          : chat,
      ),
    );
  }

  async function compactChat() {
    const id = chatId();
    if (!id) {
      reportError("compact chat", "Start a new chat first.");
      return;
    }
    if (activeChats().has(id) || dispatchingChats().has(id)) return;
    deleteFromSet(setInterruptedChats, interruptedChats, id);
    addToSet(setDispatchingChats, dispatchingChats, id);
    await waitForChatSettingsWrites(id);
    const r = await api("compact", { chatId: id });
    if (!r.ok) {
      deleteFromSet(setDispatchingChats, dispatchingChats, id);
      deleteFromSet(setInterruptingChats, interruptingChats, id);
      reportError(`compact ${id}`, r.error);
    }
  }

  async function resumeAgent() {
    const id = chatId();
    if (!id) return;
    if (activeChats().has(id) || dispatchingChats().has(id)) return;
    deleteFromSet(setInterruptedChats, interruptedChats, id);
    addToSet(setDispatchingChats, dispatchingChats, id);
    await waitForChatSettingsWrites(id);
    const r = await api("resume", { chatId: id });
    if (!r.ok) {
      deleteFromSet(setDispatchingChats, dispatchingChats, id);
      reportError(`resume ${id}`, r.error);
    }
  }

  async function interruptAgent(
    options: { resumeQueued?: boolean; offerResume?: boolean } = {},
  ) {
    const id = chatId();
    if (!id) return;
    if (!activeChats().has(id)) return;
    // Drop the chat from activeChats optimistically so the UI reflects the
    // cancel immediately; step-end from the aborted task will arrive shortly
    // and idempotently keep it removed.
    deleteFromSet(setActiveChats, activeChats, id);
    deleteFromSet(setDispatchingChats, dispatchingChats, id);
    addToSet(setInterruptingChats, interruptingChats, id);
    if (options.resumeQueued)
      deleteFromSet(setInterruptedChats, interruptedChats, id);
    else addToSet(setInterruptedChats, interruptedChats, id);
    updateChatSummary(id, { status: "agent:Done", runningStartedAt: null });
    dismissCurrentDraftReply(id);
    clearDraftReply(id);
    if (options.offerResume) setResumeOfferRequest((n) => n + 1);
    // Keep queued follow-ups paused until the interrupt RPC reaches Rust.
    // Draining earlier can start a fresh turn that the delayed interrupt then
    // aborts, leaving the user's follow-up apparently queued/stuck.
    const r = await api("interrupt", { chatId: id });
    deleteFromSet(setInterruptingChats, interruptingChats, id);
    if (!r.ok) reportError(`interrupt ${id}`, r.error);
    if (options.resumeQueued) drainSoon();
  }

  function stopAgent() {
    return interruptAgent({ resumeQueued: true, offerResume: true });
  }

  function currentRunningRunTSStepId(): string | null {
    const items = timeline();
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type !== "step") continue;
      if (item.status !== "agent:Running") continue;
      if (item.runts || item.runjs) return item.step || null;
    }
    return null;
  }

  function releaseRunTSForeground(
    id: string,
    stepId?: string | null,
    status = "agent:Done",
  ) {
    const targetStep = stepId || currentRunningRunTSStepId();
    if (targetStep) settleTimelineStep(targetStep, status);
    clearActiveChatRuntime(id);
    unblockRunTSQueue(id);
    updateChatSummary(id, {
      status: "agent:Done",
      runningStartedAt: null,
    });
    drainSoon();
  }

  async function backgroundRunTSStep(stepId?: string | null) {
    const id = chatId();
    if (!id) return;
    const targetStep = stepId || currentRunningRunTSStepId();
    if (targetStep && isRunTSBackgrounded(targetStep, id)) return;
    requestRunTSBackground(id, targetStep);
    // Do the local release before awaiting the control RPC. The RPC can be
    // delayed by host/db setup or transport backpressure, but the user's intent
    // is clear and queued follow-ups should become dispatchable immediately.
    releaseRunTSForeground(id, targetStep);
    const r = await api("run-ts-background", {
      chatId: id,
      stepId: targetStep || null,
    });
    if (!r.ok) {
      clearRunTSBackgroundRequest(id, targetStep);
      reportError("background runTS", r.error);
      return;
    }
    if (r.value.requested === false)
      clearRunTSBackgroundRequest(id, targetStep);
  }

  async function cancelRunTSStep(
    stepId?: string | null,
    targetChatId?: string | null,
  ) {
    const id = targetChatId || chatId();
    if (!id) return;
    const targetStep = stepId || currentRunningRunTSStepId();
    if (targetStep) requestRunTSBackground(id, targetStep);
    const r = await api("run-ts-cancel", {
      chatId: id,
      stepId: targetStep || null,
    });
    if (!r.ok) {
      if (targetStep) clearRunTSBackgroundRequest(id, targetStep);
      reportError("cancel runTS", r.error);
      return;
    }
    if (!r.value.cancelled && targetStep)
      clearRunTSBackgroundRequest(id, targetStep);
    if (r.value.cancelled && id === chatId()) {
      if (targetStep) clearRunTSBackgroundRequest(id, targetStep);
      clearActiveChatRuntime(id);
      unblockRunTSQueue(id);
      updateChatSummary(id, {
        status: "agent:Done",
        runningStartedAt: null,
      });
      drainSoon();
    }
    await refreshBackgroundRunTS();
  }

  async function refreshBackgroundRunTS() {
    const r = await api("run-ts-backgrounds", {});
    if (r.ok) {
      const jobs = r.value.jobs || [];
      setBackgroundRunTS(jobs);
      setBackgroundRequestedRunTS((current) => {
        const next = new Set<string>();
        for (const key of current) {
          const parts = runTSBackgroundKeyParts(key);
          if (
            parts &&
            jobs.some(
              (job) => job.chatId === parts[0] && job.stepId === parts[1],
            )
          )
            next.add(key);
        }
        return next;
      });
    }
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
  const refreshTimelineIncrementalSoon = debounce(() =>
    refreshTimeline({ incremental: true }),
  );
  const refreshChatsSoon = debounce(refreshChats);
  // Graph summaries/triples/vocabulary cost full scans across fact stores.
  // Coalesce bursts more aggressively than other refreshes so a thinking agent
  // hammering chat facts does not starve the worker pool.
  const refreshGraphSummariesSoon = debounce(refreshGraphSummaries, 1500);
  const refreshFactsViewSoon = debounce(() => {
    void refreshFactsView();
  }, 1500);
  const refreshVocabularySoon = debounce(refreshVocabulary, 1500);
  const refreshUisSoon = debounce(refreshUis);
  const refreshChatUisSoon = debounce(refreshChatUis);
  const refreshPointersSoon = debounce(refreshPointers);
  const refreshSkillsSoon = debounce(refreshSkills);
  const refreshV8StatsSoon = debounce(refreshV8Stats, 1000);
  const pendingRepoFileRefreshPaths = new Set<string>();
  const refreshPendingRepoFilesSoon = debounce(() => {
    const entries = Array.from(pendingRepoFileRefreshPaths).map((key) => {
      const sep = key.indexOf("\n");
      return sep >= 0
        ? { chatId: key.slice(0, sep), path: key.slice(sep + 1) }
        : { chatId: chatId(), path: key };
    });
    pendingRepoFileRefreshPaths.clear();
    void Promise.all(
      entries.map((entry) => refreshMatchingRepoFiles(entry.path, entry.chatId)),
    );
  }, 150);
  function refreshMatchingRepoFilesSoon(path: string, targetChatId = chatId()) {
    pendingRepoFileRefreshPaths.add(`${targetChatId ?? ""}\n${path}`);
    refreshPendingRepoFilesSoon();
  }

  const events = new EventStream();
  bindWS(events);
  void refreshSettingsCache();
  void refreshSkills();
  const offEvents = events.on((ev: WsEvent) => {
    if (ev.kind === "ping") return;
    if (ev.kind === "ui-open") {
      if (ev.chatId === chatId()) {
        refreshUisSoon();
        const uiId = typeof ev.uiId === "string" ? ev.uiId : "";
        const instanceId =
          typeof ev.instanceId === "string" ? ev.instanceId : null;
        if (uiId && view() === "chat") {
          setOpenUiId(uiId);
          setOpenUiInstanceId(instanceId);
          openAppRightSidebarTab(uiId, instanceId);
        }
        refreshChatUisSoon();
      }
      return;
    }
    if (ev.kind === "trace-write-error") {
      const rows = typeof ev.rows === "number" ? ev.rows : undefined;
      notify(
        "tracing",
        ev.message || "trace write failed",
        rows == null
          ? undefined
          : rows + " queued row" + (rows === 1 ? "" : "s"),
      );
      return;
    }
    if (ev.kind === "otel-export-error") {
      const rows =
        typeof ev.rows === "number"
          ? ` · ${ev.rows} row${ev.rows === 1 ? "" : "s"}`
          : "";
      const detail =
        typeof ev.endpoint === "string" && ev.endpoint
          ? `${ev.endpoint}${rows}`
          : rows || undefined;
      notify("otel", ev.message || "OTEL export failed", detail);
      return;
    }
    if (ev.kind === "v8") {
      if (ev.event && typeof ev.event === "object") {
        setV8Stats((current) => {
          if (!current) return current;
          const incoming = ev.event as V8StatsValue["events"][number];
          const events = [...(current.events ?? [])];
          const duplicate = events.some(
            (item) =>
              item.at === incoming.at &&
              item.worker === incoming.worker &&
              item.generation === incoming.generation &&
              item.kind === incoming.kind &&
              item.command === incoming.command &&
              item.reason === incoming.reason,
          );
          if (!duplicate) events.push(incoming);
          return {
            ...current,
            events: events.slice(-300),
          };
        });
      }
      // Keep the sidebar's V8 busy badge live after the user has visited the
      // V8 page once. Before that first load, leave it hidden instead of
      // implicitly subscribing the whole app to V8 stats. The snapshot refresh
      // fills in derived counters/heap data; the live event above prevents the
      // lifecycle list from looking empty while the debounce is pending.
      if (view() === "v8" || v8StatsLoaded()) refreshV8StatsSoon();
      return;
    }
    if (ev.kind === "online") {
      setConnected(true);
      return;
    }
    if (ev.kind === "offline") {
      setConnected(false);
      return;
    }
    if (ev.kind === "reconnect") {
      // WS just (re)connected; resync visible/subscribed panes that could have
      // missed notifications while the socket was down.
      refreshChats();
      refreshTimeline();
      // runts-background-start/end frames aren't replayed across reconnects, so
      // reconcile background RunTS jobs against the server's authoritative list.
      void refreshBackgroundRunTS();
      if (view() === "facts") {
        refreshFactsView();
        refreshVocabulary();
        refreshChatMemory();
      } else {
        refreshGraphSummaries();
      }
      refreshUis();
      refreshChatUis();
      refreshPointers();
      refreshMcpServers();
      if (view() === "v8" || v8StatsLoaded()) refreshV8Stats();
      return;
    }
    if (ev.kind === "file-diff") {
      const cid = chatId();
      if (cid && ev.chatId === cid) {
        const id = ev.stepId || ev.hash || `file-diff-${ev.path}-${ev.at}`;
        setTimeline((items) =>
          compactTimelineRows([
            ...items.filter(
              (item) => !(item.type === "file-diff" && item.id === id),
            ),
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
          ]),
        );
        refreshMatchingDiffTabs(
          ev.path,
          [id, ev.hash || "", ev.at || ""].join(":"),
        );
      }
      refreshMatchingRepoFilesSoon(ev.path, ev.chatId);
      return;
    }
    if (ev.kind === "todo-diff") {
      const cid = chatId();
      if (Array.isArray(ev.todos)) applyTodosForChat(ev.chatId, ev.todos);
      if (!Array.isArray(ev.changes) || ev.changes.length === 0) return;
      if (cid && ev.chatId === cid) {
        const id = ev.stepId || ev.hash || `todo-diff-${ev.at}`;
        setTimeline((items) =>
          compactTimelineRows([
            ...items.filter(
              (item) => !(item.type === "todo-diff" && item.id === id),
            ),
            {
              type: "todo-diff",
              id,
              step: ev.stepId,
              chatId: ev.chatId,
              changes: ev.changes,
              todos: ev.todos,
              hash: ev.hash,
              at: ev.at || Date.now(),
            } as TimelineItem,
          ]),
        );
      }
      return;
    }
    if (ev.kind === "memory-diff") {
      const cid = chatId();
      if (cid && ev.chatId === cid) {
        const id = ev.stepId || ev.hash || `memory-diff-${ev.store}-${ev.at}`;
        setTimeline((items) =>
          compactTimelineRows([
            ...items.filter(
              (item) => !(item.type === "memory-diff" && item.id === id),
            ),
            {
              type: "memory-diff",
              id,
              step: ev.stepId,
              chatId: ev.chatId,
              store: ev.store,
              graph: ev.graph,
              action: ev.action,
              count: ev.count,
              changes: ev.changes,
              path: ev.path,
              diff: ev.diff,
              stats: ev.stats,
              before: ev.before,
              after: ev.after,
              hash: ev.hash,
              at: ev.at || Date.now(),
            } as TimelineItem,
          ]),
        );
      }
      return;
    }
    if (ev.kind === "blob-add") {
      const cid = chatId();
      if (cid && ev.chatId === cid) {
        const id = ev.stepId || ev.hash || `blob-add-${ev.at}`;
        setTimeline((items) =>
          compactTimelineRows([
            ...items.filter(
              (item) => !(item.type === "blob-add" && item.id === id),
            ),
            {
              type: "blob-add",
              id,
              step: ev.stepId,
              chatId: ev.chatId,
              objectKind: ev.objectKind,
              hash: ev.hash,
              size: ev.size,
              chars: ev.chars,
              encoding: ev.encoding,
              at: ev.at || Date.now(),
            } as TimelineItem,
          ]),
        );
      }
      return;
    }

    if (ev.kind === "runts-step-finished") {
      if (ev.chatId && ev.stepId) {
        const patchRuntsFinishedRow = (item: TimelineItem): TimelineItem => {
          if (item.type !== "step" || item.step !== ev.stepId) return item;
          const existingRunts = item.runts ?? item.runjs;
          const runts = existingRunts
            ? {
                ...existingRunts,
                error:
                  typeof ev.error === "string" ? ev.error : existingRunts.error,
                durationNs:
                  typeof ev.durationNs === "number"
                    ? ev.durationNs
                    : existingRunts.durationNs,
              }
            : item.runts;
          return {
            ...item,
            status: ev.status || (ev.error ? "agent:Failed" : "agent:Done"),
            resultHash: ev.resultHash || item.resultHash,
            lazyRuntsResult: !!(ev.resultHash || item.resultHash),
            runts,
          } as TimelineItem;
        };
        updateLiveTimelineOverlayStep(ev.chatId, ev.stepId, patchRuntsFinishedRow);
        if (ev.chatId === chatId()) {
          setTimeline((items) => compactTimelineRows(items.map(patchRuntsFinishedRow)));
          refreshTimelineIncrementalSoon();
        }
      }
      return;
    }

    if (ev.kind === "tool-call-draft") {
      if (ev.chatId && ev.stepId) {
        closeDraftReplyThinkingForToolCall(ev.chatId);
        const currentRows = ev.chatId === chatId() ? timeline() : [];
        rememberToolCallDraftRow(ev, currentRows);
        if (ev.chatId === chatId())
          setTimeline((items) =>
            applyLiveTimelineOverlayRows(
              ev.chatId,
              mergeToolCallDraftRow(
                withoutLiveTimelineOverlayRows(ev.chatId, items),
                ev,
              ),
            ),
          );
      }
      return;
    }

    if (ev.kind === "runts-background-start") {
      setBackgroundRunTS((jobs) => {
        const stepId = String(ev.stepId || "");
        const job = {
          chatId: ev.chatId,
          stepId,
          label: typeof ev.label === "string" ? ev.label : null,
          requestedBy:
            typeof ev.requestedBy === "string" ? ev.requestedBy : null,
          startedAt: Number(ev.at) || Date.now(),
        };
        return [
          ...jobs.filter(
            (j) => !(j.chatId === job.chatId && j.stepId === stepId),
          ),
          job,
        ];
      });
      requestRunTSBackground(ev.chatId, ev.stepId);
      clearActiveChatRuntime(ev.chatId);
      unblockRunTSQueue(ev.chatId);
      updateChatSummary(ev.chatId, {
        status: "agent:Done",
        runningStartedAt: null,
      });
      drainSoon();
      return;
    }
    if (ev.kind === "runts-background-end") {
      setBackgroundRunTS((jobs) =>
        jobs.filter(
          (job) => !(job.chatId === ev.chatId && job.stepId === ev.stepId),
        ),
      );
      clearRunTSBackgroundRequest(ev.chatId, ev.stepId);
      drainSoon();
      return;
    }

    if (ev.kind === "tokens") {
      const used = Number(ev.used);
      if (Number.isFinite(used)) {
        const cur = currentTokensForChat(ev.chatId);
        const budget = Number.isFinite(Number(ev.budget))
          ? Number(ev.budget)
          : Number(cur?.budget ?? 0);
        const threshold = Number.isFinite(Number(ev.threshold))
          ? Number(ev.threshold)
          : Number(cur?.threshold ?? 0);
        const explicitFraction = Number(ev.fraction);
        const next: TokenProgressValue = {
          used,
          budget,
          threshold,
          availableTokens: Number.isFinite(Number(ev.availableTokens))
            ? Number(ev.availableTokens)
            : Math.max(0, threshold - used),
          compactionsInARow: Number.isFinite(Number(ev.compactionsInARow))
            ? Number(ev.compactionsInARow)
            : cur?.compactionsInARow,
          fraction: Number.isFinite(explicitFraction)
            ? explicitFraction
            : budget > 0
              ? used / budget
              : 0,
        };
        const source = typeof ev.source === "string" ? ev.source : cur?.source;
        if (source) next.source = source;
        if (typeof ev.estimated === "boolean") next.estimated = ev.estimated;
        else if (typeof cur?.estimated === "boolean")
          next.estimated = cur.estimated;
        applyTokensForChat(ev.chatId, next, {
          active: activeChats().has(ev.chatId),
          reset: ev.reset === true,
        });
      }
      return;
    }
    if (ev.kind === "compaction-draft") {
      const cid = ev.chatId;
      if (cid) {
        addToSet(setCompactingChats, compactingChats, cid);
        endedDraftReplyIds.delete(ev.draftId);
        const previous = draftRepliesByChat.get(cid);
        setActiveDraftReply({
          kind: "compaction",
          chatId: cid,
          draftId: ev.draftId,
          content: ev.content,
          reasoningContent: "",
          reasoningStreaming: false,
          at:
            previous?.draftId === ev.draftId
              ? (previous?.at ?? (Number(ev.at) || Date.now()))
              : Number(ev.at) || Date.now(),
        });
      }
      return;
    }
    if (ev.kind === "reasoning-draft") {
      const cid = ev.chatId;
      if (cid) {
        deleteFromSet(setCompactingChats, compactingChats, cid);
        if (
          dismissedReplies().some(
            (item) => item.chatId === cid && item.draftId === ev.draftId,
          )
        ) {
          rememberDismissedReply(
            cid,
            ev.draftId,
            ev.content ?? "",
            ev.reasoningContent ?? "",
          );
          const cur = draftReply();
          if (cur?.draftId === ev.draftId) {
            toolClosedDraftReplyIds.delete(ev.draftId);
            clearDraftReply(cid, ev.draftId);
          }
          return;
        }
        endedDraftReplyIds.delete(ev.draftId);
        const previous = draftRepliesByChat.get(cid);
        setActiveChatRuntimeModel(ev.chatId, ev.model, ev.effort);
        setActiveDraftReply({
          kind: "reply",
          chatId: cid,
          draftId: ev.draftId,
          content: ev.content ?? previous?.content ?? "",
          reasoningContent: ev.reasoningContent ?? "",
          reasoningStreaming: !toolClosedDraftReplyIds.has(ev.draftId),
          model: typeof ev.model === "string" ? ev.model : previous?.model,
          effort: typeof ev.effort === "string" ? ev.effort : previous?.effort,
          at:
            previous?.draftId === ev.draftId
              ? (previous?.at ?? (Number(ev.at) || Date.now()))
              : Number(ev.at) || Date.now(),
        });
      }
      return;
    }
    if (ev.kind === "draft") {
      const cid = ev.chatId;
      if (cid) {
        // A reply draft can only come from the real answer stream; compaction
        // summary calls emit compaction-draft instead. If compaction-end was
        // missed, don't let the compacting status leak into the reply UI.
        deleteFromSet(setCompactingChats, compactingChats, cid);
        if (
          dismissedReplies().some(
            (item) => item.chatId === cid && item.draftId === ev.draftId,
          )
        ) {
          rememberDismissedReply(
            cid,
            ev.draftId,
            ev.content,
            ev.reasoningContent ?? "",
          );
          const cur = draftReply();
          if (cur?.draftId === ev.draftId) {
            toolClosedDraftReplyIds.delete(ev.draftId);
            clearDraftReply(cid, ev.draftId);
          }
          return;
        }
        endedDraftReplyIds.delete(ev.draftId);
        const previous = draftRepliesByChat.get(cid);
        setActiveChatRuntimeModel(ev.chatId, ev.model, ev.effort);
        setActiveDraftReply({
          kind: "reply",
          chatId: cid,
          draftId: ev.draftId,
          content: ev.content,
          reasoningContent:
            ev.reasoningContent ?? previous?.reasoningContent ?? "",
          reasoningStreaming: false,
          model: typeof ev.model === "string" ? ev.model : previous?.model,
          effort: typeof ev.effort === "string" ? ev.effort : previous?.effort,
          at:
            previous?.draftId === ev.draftId
              ? (previous?.at ?? (Number(ev.at) || Date.now()))
              : Number(ev.at) || Date.now(),
        });
      }
      return;
    }
    if (ev.kind === "draft-end") {
      const cur = cachedDraftReplyForEnd(ev.chatId, ev.draftId);
      if (cur && cur.draftId === ev.draftId) {
        setActiveDraftReply({ ...cur, reasoningStreaming: false });
        endedDraftReplyIds.set(ev.draftId, Date.now());
        if (pending().some((p) => p.chatId === cur.chatId)) drainSoon();
        window.setTimeout(() => {
          const latest = cachedDraftReplyForEnd(ev.chatId, ev.draftId);
          if (
            latest?.draftId === ev.draftId &&
            endedDraftReplyIds.has(ev.draftId)
          ) {
            endedDraftReplyIds.delete(ev.draftId);
            toolClosedDraftReplyIds.delete(ev.draftId);
            clearDraftReply(latest.chatId, ev.draftId);
          }
        }, 15000);
      }
      return;
    }
    if (ev.kind === "llm-auth-required") {
      if (!ev.chatId || ev.chatId === chatId()) {
        showSettings();
      }
      return;
    }
    if (ev.kind === "compaction-start") {
      if (typeof ev.chatId === "string" && ev.chatId) {
        addToSet(setCompactingChats, compactingChats, ev.chatId);
      }
      return;
    }
    if (ev.kind === "compaction-end") {
      if (typeof ev.chatId === "string" && ev.chatId) {
        deleteFromSet(setCompactingChats, compactingChats, ev.chatId);
        const cur = draftReply();
        if (cur?.kind === "compaction" && cur.chatId === ev.chatId) {
          endedDraftReplyIds.delete(cur.draftId);
          toolClosedDraftReplyIds.delete(cur.draftId);
          clearDraftReply(ev.chatId, cur.draftId);
        }
        if (ev.chatId === chatId()) refreshTimelineIncrementalSoon();
      }
      return;
    }
    if (ev.kind === "step-start") {
      addToSet(setActiveChats, activeChats, ev.chatId);
      const currentModel = chatModel();
      if (currentModel?.chatId === ev.chatId) {
        setActiveChatRuntimeModel(
          ev.chatId,
          currentModel.effectiveModelId ?? currentModel.effectiveModel,
          currentModel.effectiveEffort,
        );
      } else {
        const summary = chats().find((chat) => chat.chatId === ev.chatId);
        setActiveChatRuntimeModel(ev.chatId, summary?.model ?? null, null);
      }
      if (ev.compacting === true) {
        addToSet(setCompactingChats, compactingChats, ev.chatId);
      }
      setChatStartedAt(ev.chatId, ev.at);
      deleteFromSet(setDispatchingChats, dispatchingChats, ev.chatId);
      deleteFromSet(setInterruptingChats, interruptingChats, ev.chatId);
      clearRunTSQueueUnblock(ev.chatId);
      updateChatSummary(ev.chatId, {
        status: "agent:Running",
        runningStartedAt: Number(ev.at) || Date.now(),
      });
      return;
    }
    if (ev.kind === "step-end") {
      clearActiveChatRuntime(ev.chatId);
      settleRunningTimelineRows(ev.chatId);
      updateChatSummary(ev.chatId, {
        status: "agent:Done",
        runningStartedAt: null,
      });
      drainSoon();
      return;
    }
    if (ev.kind === "driver-error") {
      reportError(`chat ${ev.chatId}`, ev.error);
      return;
    }
    // The pointer-changed and facts-changed events use different field names
    // for the changed name (`pointer` vs. `store`), but routing is identical:
    // both flow through this single switch on prefix/suffix patterns.
    const ref =
      (ev.kind === "pointer"
        ? ev.pointer
        : ev.kind === "facts"
          ? ev.store
          : "") || "";
    const cid = chatId();
    if (ev.kind === "pointer" && view() === "facts" && !focusedGraph())
      void refreshGraphSummaries();
    if (
      ref.startsWith("chat/") &&
      (ref.endsWith("/facts") ||
        ref.endsWith("/head") ||
        ref.endsWith("/compaction"))
    ) {
      const changedChatId = ref.split("/")[1] ?? "";
      // Conversation facts/head invalidate the cached timeline, but keep the
      // cached model picker state. The picker has its own refresh path, and
      // dropping it here makes model/effort choices appear to roll back when
      // the user switches chats while a write or running step is in flight.
      invalidateChatCache(changedChatId, {
        describe: true,
        ui: ref.endsWith("/facts"),
      });
    }
    if (
      cid &&
      (ref === `chat/${cid}/facts` ||
        ref === `chat/${cid}/head` ||
        ref === `chat/${cid}/compaction`)
    ) {
      refreshTimelineIncrementalSoon();
    }
    if (ref.startsWith("chat/") && ref.endsWith("/last-at")) {
      const changedChatId = ref.split("/")[1];
      if (changedChatId)
        updateChatSummary(changedChatId, { lastAt: Date.now() });
    } else if (
      ref.startsWith("chat/") &&
      (ref.endsWith("/created-at") ||
        ref.endsWith("/title") ||
        ref.endsWith("/archived-at") ||
        // Cost is derived from chat/{id}/usage; refresh summaries when a
        // completion records new usage so the sidebar price updates live.
        ref.endsWith("/usage"))
    ) {
      refreshChatsSoon();
    }
    if (cid && ref === `chat/${cid}/facts`) {
      // Fact changes include model/effort writes. Bypass the single-flight
      // refresh so a pre-write in-flight chat-models request cannot repopulate
      // the current chat or switch cache with stale settings.
      refreshChatModel({ force: true });
    }
    // Chat fact changes only invalidate triples/vocab when the user is
    // actually looking at the memory view. Otherwise the sidebar's fact count
    // is the only consumer and a slightly stale number is fine — far
    // better than running a multi-chat full scan on every step the agent
    // takes.
    const isMemoryRef =
      ref === "memory/facts" ||
      ref === "vocab/facts" ||
      (ref.startsWith("memory/project/") && ref.endsWith("/facts"));
    const isChatFactRef = ref.startsWith("chat/") && ref.endsWith("/facts");
    const factsViewOpen = view() === "facts";
    if (isChatFactRef) refreshChatMemory([ref.split("/")[1] ?? ""]);
    if (isMemoryRef || isChatFactRef) refreshGraphSummariesSoon();
    if (isMemoryRef || (isChatFactRef && factsViewOpen)) {
      refreshFactsViewSoon();
      refreshVocabularySoon();
    }
    if (ev.kind === "pointer") {
      refreshPointersSoon();
      if (
        typeof ref === "string" &&
        (ref === "skills/index" || ref.startsWith("skills/"))
      )
        refreshSkillsSoon();
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
    const kind = initialOAuthCallback.kind;
    const target = kind === "llmAuth" ? "/settings" : "/mcp";
    if ("error" in initialOAuthCallback) {
      console.error(
        kind === "llmAuth" ? "llm-auth-oauth" : "mcp-oauth",
        initialOAuthCallback.error,
      );
      alert(initialOAuthCallback.error);
      history.replaceState({}, "", target);
      setView(kind === "llmAuth" ? "settings" : "mcp");
      setFocusedSubject(null);
      setFocusedGraph(null);
      setOpenUiId(null);
      setOpenUiInstanceId(null);
      return;
    }
    if (kind === "llmAuth") {
      const r = await api("llm-auth-oauth-complete", {
        state: initialOAuthCallback.state,
        code: initialOAuthCallback.code,
      });
      if (!r.ok) {
        console.error("llm-auth-oauth", r.error);
        alert(r.error.message);
      }
      history.replaceState({}, "", "/settings");
      setView("settings");
      setFocusedSubject(null);
      setFocusedGraph(null);
      setOpenUiId(null);
      setOpenUiInstanceId(null);
      return;
    }
    const r = await api("mcp-oauth-complete", {
      state: initialOAuthCallback.state,
      code: initialOAuthCallback.code,
    });
    let returnChatId: string | null = null;
    if (!r.ok) {
      console.error("mcp-oauth", r.error);
      alert(r.error.message);
    } else {
      returnChatId = r.value.status.returnChatId || null;
      void mcpListSingle();
    }
    const mcpTarget = returnChatId
      ? "/chat/" + encodeURIComponent(returnChatId)
      : "/mcp";
    history.replaceState({}, "", mcpTarget);
    if (returnChatId) {
      setView("chat");
      setFocusedSubject(null);
      setFocusedGraph(null);
      setOpenUiId(null);
      setOpenUiInstanceId(null);
      if (returnChatId !== chatId()) {
        void selectChat(returnChatId, true);
      } else {
        void refreshTimeline();
      }
    } else {
      setView("mcp");
      setFocusedSubject(null);
      setFocusedGraph(null);
      setOpenUiId(null);
      setOpenUiInstanceId(null);
    }
  }

  // -- bootstrap ---------------------------------------------------------

  loadPersistentChatCache();

  // Set up disposables synchronously so they bind to the current Solid
  // owner. After any await, getOwner() is null and onCleanup leaks.
  void completeInitialOAuthCallback();
  onCleanup(() => {
    offEvents();
    events.stop();
    refreshTimelineSoon.cancel();
    refreshChatsSoon.cancel();
    refreshFactsViewSoon.cancel();
    refreshVocabularySoon.cancel();
    refreshUisSoon.cancel();
    refreshChatUisSoon.cancel();
    refreshPointersSoon.cancel();
    refreshSkillsSoon.cancel();
    refreshV8StatsSoon.cancel();
    if (chatMemoryRefreshTimer !== null)
      window.clearTimeout(chatMemoryRefreshTimer);
  });
  onCleanup(() => {
    if (persistChatCacheSoonHandle !== null)
      window.clearTimeout(persistChatCacheSoonHandle);
    persistChatCache();
  });

  // Facts/vocab/V8 are notification-driven after their first explicit load:
  // pointer/facts broadcasts schedule memory refreshes, V8 broadcasts schedule
  // stats refreshes, and reconnect performs a conditional resync. Avoid polling
  // these expensive side views in the background.

  // Esc follows the same stop path as the stop button. Listen on document so it
  // works regardless of focus.
  // Skipping when there's no active chat or when the user is in the middle of a
  // native action (IME composition, modal prompt) — those events have
  // isComposing or are intercepted by the browser before we see them.
  const escHandler = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (e.defaultPrevented || hasOpenModalDialog()) return;
    if (e.isComposing) return;
    const id = chatId();
    if (!id || !activeChats().has(id)) return;
    e.preventDefault();
    stopAgent();
  };
  document.addEventListener("keydown", escHandler);
  onCleanup(() => document.removeEventListener("keydown", escHandler));

  function startEvents() {
    if (eventsStarted) return;
    eventsStarted = true;
    events.start();
  }

  async function ensurePskAccepted(): Promise<boolean> {
    setPskChecking(true);
    try {
      const status = await checkPsk();
      if (!status.required || status.valid) {
        setPskRequired(false);
        setPskError(null);
        return true;
      }
      setPskRequired(true);
      setPskError(
        getPsk()
          ? "That pre-shared key was rejected. Enter the current PSK."
          : "This Moo server requires a pre-shared key.",
      );
      return false;
    } catch (err) {
      setPskRequired(true);
      setPskError(wsErrorMessage(err));
      return false;
    } finally {
      setPskChecking(false);
    }
  }

  async function submitPsk(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      setPskError("Enter the pre-shared key.");
      return;
    }
    setPsk(trimmed);
    setPskChecking(true);
    try {
      const status = await checkPsk(trimmed);
      if (!status.required || status.valid) {
        setPskRequired(false);
        setPskError(null);
        await start();
      } else {
        setPskError("That pre-shared key was rejected. Try again.");
      }
    } catch (err) {
      setPskError(wsErrorMessage(err));
    } finally {
      setPskChecking(false);
    }
  }

  async function start() {
    const run = ++startupRun;
    setStartupLoading(true);
    try {
      if (!(await ensurePskAccepted())) return;
      if (run !== startupRun) return;
      startEvents();
      const initialView = parseLocation().view;
      refreshPointers();
      // If the user lands directly on /facts, start loading the data that backs
      // the memory stats immediately. Do not wait for the chat list first: that
      // request can be slow or blocked behind other work, leaving the page stuck
      // showing the initial 0 graphs / 0 facts even though facts exist.
      if (initialView === "facts") {
        refreshGraphSummaries();
        const initialLoc = parseLocation();
        if (
          initialLoc.view === "facts" &&
          initialLoc.graph &&
          initialLoc.graph !== focusedGraph()
        ) {
          setFocusedGraph(initialLoc.graph);
        }
        refreshVocabulary();
      } else if (initialView === "v8") {
        refreshV8Stats();
      }
      // Refresh chats so the sidebar populates. Graph summaries/triples/vocabulary
      // do full scans across fact stores and can take seconds, so they load in the
      // background instead of holding the UI on "no chats yet".
      const startupLoc = parseLocation();
      const directChatId =
        startupLoc.view === "chat" || !startupLoc.view
          ? (startupLoc.chatId ?? null)
          : null;
      let directChatLoad: Promise<void> | null = null;
      if (directChatId) {
        // A direct /chat/<id> route can hydrate from chat-scoped refs/facts without
        // waiting for the global sidebar summary list. Queue it before the sidebar
        // request so first timeline paint is not stuck behind large chat lists.
        directChatLoad = selectChat(directChatId, true);
        const chatsLoad = refreshChats();
        await directChatLoad;
        refreshGraphSummaries();
        refreshUis();
        refreshMcpServers();
        if (pending().length > 0) drain();
        void chatsLoad;
        return;
      }
      const chatsLoad = refreshChats();
      if (initialView !== "facts") refreshGraphSummaries();
      if (initialView === "apps") {
        await refreshUis();
      } else refreshUis();
      refreshMcpServers();
      const loc = parseLocation();
      if (
        loc.view === "new" ||
        loc.view === "facts" ||
        loc.view === "pointers" ||
        loc.view === "skills" ||
        loc.view === "apps" ||
        loc.view === "mcp" ||
        loc.view === "v8" ||
        loc.view === "settings"
      ) {
        const hydrateFirstChat = () => {
          if (loc.view === "new" || chatId()) return;
          const list = chats();
          if (list.length === 0) return;
          setChatId(list[0]!.chatId);
          showTokensForChat(list[0]!.chatId);
          showTodosForChat(list[0]!.chatId);
          loadWipText(list[0]!.chatId);
        };
        void chatsLoad
          .then(() => {
            hydrateFirstChat();
            if (view() === "skills") void refreshSkills();
            if (pending().length > 0) drain();
          })
          .catch((err) => reportError("chats", err));
        if (loc.view === "apps" && loc.instanceId) {
          setView("apps");
          await openUiFromRoute(loc.instanceId, "replace");
          if (pending().length > 0) drain();
          return;
        }
        if (loc.view === "new") {
          resetSelectedChatViewState({
            clearChatId: true,
            clearUi: true,
            clearWip: true,
          });
          setView("new");
        } else if (loc.view === "apps") setView("apps");
        else if (loc.view === "mcp") setView("mcp");
        else if (loc.view === "skills") {
          setView("skills");
          void refreshSkills();
        } else if (loc.view === "v8") {
          setView("v8");
          void refreshV8Stats();
        } else if (loc.view === "settings") setView("settings");
        replaceUrl();
        if (pending().length > 0) drain();
        return;
      }
      await chatsLoad;
      const list = chats();
      const desired = loc.chatId;
      let target: string | null = null;
      // Respect an explicit /chat/<id> even if the chat summary list is stale
      // or from an older store that lacks chat metadata; describe can still load
      // the chat-scoped refs/facts directly.
      if (desired) target = desired;
      else if (list.length > 0) target = list[0]!.chatId;
      if (target) {
        if (directChatLoad && directChatId === target) await directChatLoad;
        else await selectChat(target, true);
      }
      // Drain after selectChat so chatId is set and the optimistic UserInput
      // row gets added to the timeline (otherwise the user posts a message,
      // hits reload, and sees only "agent thinking…" until the server's
      // UserInput fact catches up).
      if (pending().length > 0) drain();
    } finally {
      if (run === startupRun) setStartupLoading(false);
    }
  }

  // 1-second tick for relative-time labels.
  const [tick, setTick] = createSignal(0);
  const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
  onCleanup(() => clearInterval(timer));

  let missingRepoFileRefreshInFlight = false;
  const missingRepoFileRefreshTimer = window.setInterval(() => {
    if (missingRepoFileRefreshInFlight) return;
    const files = rightSidebarTabs()
      .filter(
        (tab): tab is Extract<RightSidebarTab, { kind: "file" }> =>
          tab.kind === "file",
      )
      .filter(
        (tab) =>
          !tab.file.loading &&
          isMissingRepoFileError(tab.file.error) &&
          Boolean(tab.file.requestedPath.trim()),
      );
    if (files.length === 0) return;
    missingRepoFileRefreshInFlight = true;
    void Promise.all(
      files.map((tab) =>
        readRepoFileIntoSidebar(
          tab.file.requestedPath,
          currentChatWorktreePath(),
          false,
        ),
      ),
    ).finally(() => {
      missingRepoFileRefreshInFlight = false;
    });
  }, MISSING_REPO_FILE_REFRESH_MS);
  onCleanup(() => clearInterval(missingRepoFileRefreshTimer));

  return {
    startupLoading,
    chats,
    chatsLoaded,
    chatId,
    currentChatTitle,
    currentChatSummary,
    currentChatPath,
    currentChatWorktreePath,
    currentChatParent,
    chatFocusRequest,
    clearChatFocusRequest,
    resumeOfferRequest,
    timeline,
    trail,
    timelineJumpRequest,
    jumpToTimeline,
    timelineLimit,
    expansionStore: () => expansionStore,
    hiddenTimelineItems,
    olderTimelineLoading,
    timelineRefreshing,
    olderTimelineLoadCount,
    compactions,
    compactionsLoading,
    loadedChatId,
    totalFacts,
    totalTurns,
    totalSteps,
    totalCodeCalls,
    tokens,
    todos,
    chatModel,
    modelMru,
    chatMemory,
    triples,
    graphSummaries,
    graphSummariesLoaded,
    pointers,
    pointersLoaded,
    triplesLoaded,
    triplesRemovedMode,
    setTriplesRemovedMode,
    triplesTruncated,
    triplesLimit,
    triplesTotal,
    vocabulary,
    vocabularyLoaded,
    uiApps,
    uiAppsLoaded,
    mcpServers,
    mcpServersLoaded,
    skills,
    skillsLoaded,
    v8Stats,
    v8StatsLoaded,
    settingsCache,
    v8SettingsCache,
    otelSettingsCache,
    settingsError,
    chatUiApps,
    uiInstances,
    openUiId,
    openUiInstanceId,
    thinking,
    compacting,
    canResumeAgent,
    thinkingStartedAt,
    runningModel,
    isChatActive: chatVisiblyActive,
    connected,
    pskRequired,
    pskChecking,
    pskError,
    submitPsk,
    draftReply,
    dismissedReplies,
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
    rightSidebarMaximized,
    setRightSidebarMaximized,
    toggleRightSidebarMaximized,
    activeRightSidebarTabId,
    activeRightSidebarTab,
    setActiveRightSidebarTab,
    setBrowserTabNav,
    setDiffTabMode,
    setDiffTabScrollTop,
    expandedDiffViewState,
    setExpandedDiffViewMode,
    setExpandedDiffViewScrollTop,
    rightSidebarDiffListExpanded,
    setRightSidebarDiffListExpanded,
    sidebarDiffExpansionStore: () => sidebarDiffExpansionStore,
    closeRightSidebarTab,
    openDiffInSidebar,
    openMemoryDiffInSidebar,
    openRepoFile,
    openFileInSidebar,
    closeRepoFile,
    openStorePreviewInSidebar,
    openJsonPreviewInSidebar,
    openLogPreviewInSidebar,
    openAppCodeInSidebar,
    archivedCollapsed,
    setArchivedCollapsed,
    tick,
    view,
    focusedSubject,
    focusedGraph,
    showNewChat,
    showFacts,
    showPointers,
    showApps,
    showMcp,
    showSkills,
    showV8,
    showSettings,
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
    setSelectedModel,
    setSelectedEffort,
    refreshChatModel,
    refreshChatMemory,
    sendMessage: enqueueMessage,
    compactChat,
    deleteMessage,
    restoreMessage,
    forkChatAtStep,
    interruptAgent,
    resumeAgent,
    stopAgent,
    backgroundRunTSStep,
    cancelRunTSStep,
    isRunTSBackgrounded,
    backgroundRunTS,
    refreshBackgroundRunTS,
    steerPending,
    editPending,
    beginPendingEdit,
    endPendingEdit,
    addPendingAttachments,
    removePendingAttachment,
    removePending,
    refreshTimeline,
    loadOlderTimeline,
    refreshCompactions,
    refreshChats,
    refreshTriples,
    refreshGraphSummaries,
    refreshPointers,
    removePointer,
    refreshVocabulary,
    refreshUis,
    refreshMcpServers,
    refreshSkills,
    refreshV8Stats,
    refreshSettingsCache,
    setCachedSettings,
    setCachedV8Settings,
    setCachedOtelSettings,
    refreshChatUis,
    retract: async (s: string, p: string, o: string) => {
      const r = await api("retract", { subject: s, predicate: p, object: o });
      if (!r.ok) reportError("retract", r.error);
      await refreshFactsView();
      await refreshVocabulary();
    },
    removeSubject: async (graph: string, s: string) => {
      const r = await api("subject-rm", { graph, subject: s });
      if (!r.ok) reportError("delete subject", r.error);
      await refreshFactsView();
      await refreshVocabulary();
    },
    removeTriple: async (graph: string, s: string, p: string, o: string) => {
      const r = await api("triple-rm", {
        graph,
        subject: s,
        predicate: p,
        object: o,
      });
      if (!r.ok) reportError("delete triple", r.error);
      await refreshFactsView();
      await refreshVocabulary();
    },
    restoreTriple: async (graph: string, s: string, p: string, o: string) => {
      const r = await api("triple-restore", {
        graph,
        subject: s,
        predicate: p,
        object: o,
      });
      if (!r.ok) reportError("undelete triple", r.error);
      await refreshFactsView();
      await refreshVocabulary();
    },
    submitForm: async (requestId: string, values: Record<string, unknown>) => {
      const r = await api("submit", { chatId: chatId()!, requestId, values });
      if (!r.ok) reportError("submit form", r.error);
      await Promise.all([refreshTimeline(), refreshChats()]);
    },
    cancelForm: async (requestId: string) => {
      const r = await api("submit", {
        chatId: chatId()!,
        requestId,
        cancelled: true,
      });
      if (!r.ok) reportError("cancel form", r.error);
      await Promise.all([refreshTimeline(), refreshChats()]);
    },
    toasts,
    dismissToast,
    notify,
    start,
  };
}
