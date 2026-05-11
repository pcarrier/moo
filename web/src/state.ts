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
  type TraceRow,
  type TriplesValue,
  type UiApp,
  type UiInstance,
  type McpServerConfig,
  type SkillSummary,
  type WorkflowDefinitionSummary,
  type V8StatsValue,
  type LlmAuthSettings,
  type TraceSettingsValue,
  type V8SettingsValue,
} from "./api";
import { collapseHome, setHomeDir_ } from "./paths";
import { EventStream, type Event } from "./events";
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
import {
  chatCacheHasData,
  isDescribeFreshForSummary,
  mergeCachedOverviewWithSummary,
  normalizeChatCacheEntry,
  pruneCachedPages,
  timelineCacheKey,
  trailCacheKey,
} from "./state/chatCache";
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
const RIGHT_SIDEBAR_VIEW_SCOPE_IDS = [
  "view:apps",
  "view:facts",
  "view:pointers",
  "view:skills",
  "view:v8",
  "view:traces",
];
const RIGHT_SIDEBAR_TABS_MAX = 8;
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
  at: number;
};

export function createState() {
  const chatModelsSingle = createSingleFlight(
    api.chat.models,
    (id: string) => id,
  );
  const uiListSingle = createSingleFlight(api.ui.list, () => "ui-list");
  const uiChatSingle = createSingleFlight(api.ui.chat, (id: string) => id);
  const mcpListSingle = createSingleFlight(api.mcp.list, () => "mcp-list");
  const settingsSingle = createSingleFlight(api.llmAuth.get, () => "settings");
  const v8SettingsSingle = createSingleFlight(
    api.v8.settings,
    () => "v8-settings",
  );
  const traceSettingsSingle = createSingleFlight(
    api.traces.settings,
    () => "trace-settings",
  );
  const skillsListSingle = createSingleFlight(
    api.skills.list,
    (opts?: { enabled?: boolean; chatId?: string | null; root?: string | null }) =>
      `skills:${opts?.chatId ?? ""}:${opts?.root ?? ""}:${opts?.enabled ?? ""}`,
  );
  const workflowsListSingle = createSingleFlight(
    api.workflows.list,
    () => "workflows-list",
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
  const shouldShowTimelineItem = (item: TimelineItem) =>
    item.type !== "todo-diff" ||
    (Array.isArray(item.changes) && item.changes.length > 0);
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
  const [workflowDefinitions, setWorkflowDefinitions] =
    createSignal<WorkflowDefinitionSummary[]>([]);
  const [workflowDefinitionsLoaded, setWorkflowDefinitionsLoaded] =
    createSignal(false);
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
  const [traceSettingsCache, setTraceSettingsCache] =
    createSignal<TraceSettingsValue | null>(null);
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
    const mergedTimeline = page.sinceAt
      ? mergeTimelineUpdateRows(page.items, current)
      : mergeTimelineRows(page.items, current);
    setTimeline(mergedTimeline);
    rememberServerTimelineWatermark(id, page.items);
    pruneDismissedReplies(id, mergedTimeline);

    const currentDraft = untrack(draftReply);
    if (currentDraft?.chatId === id) {
      const matchingReplyLanded = mergedTimeline.some(
        (item) =>
          item.type === "step" &&
          item.kind === "agent:Reply" &&
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
        endedDraftReplyIds.delete(currentDraft.draftId);
        setDraftReply(null);
      }
    }

    return mergedTimeline;
  }

  function applyOverviewValue(id: string, value: DescribeOverviewValue) {
    applyDescribeToChatSummary(id, value);
    setTotalFacts(value.totalFacts);
    setTotalTurns(value.totalTurns);
    setTotalSteps(value.totalSteps);
    setTotalCodeCalls(value.totalCodeCalls ?? totalCodeCalls());
    setTokens((cur) =>
      mergeTokenProgress(
        cur,
        value.tokens,
        id === chatId() && activeChats().has(id),
      ),
    );
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
          (it) => it.type === "step" && it.kind === "agent:RunJS",
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
          (it) => it.type === "step" && it.kind === "agent:RunJS",
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
      restorePrimaryUi(cached.ui.primaryUiId ?? null, cached.ui.instances);
    }
    if (cached.rightSidebar) {
      const layout = rightSidebarLayoutForScope(id);
      setRightSidebarByChat((prev) => ({
        ...prev,
        [id]: normalizeRightSidebarState(cached.rightSidebar, layout),
      }));
    }
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
  // Chat IDs currently inside the automatic compaction LLM call. This refines
  // the active-chat state so the same running row can say "Compacting…" while
  // a summary is being generated, then go back to "Thinking…" for the real turn.
  const [compactingChats, setCompactingChats] = createSignal<Set<string>>(
    new Set(),
  );
  // Server-confirmed start time for each active chat. This lives in global
  // state instead of Timeline so the elapsed Thinking timer does not restart
  // when the user switches chats/tabs and Timeline remounts.
  const [activeChatStartedAt, setActiveChatStartedAt] = createSignal<
    Map<string, number>
  >(new Map());
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
  const setHas = (set: Set<string>, id: string) => set.has(id);
  const chatBusy = (id: string) =>
    setHas(activeChats(), id) ||
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

  // Toast queue for surfacing API/WS failures to the user. Each entry
  // self-dismisses after a few seconds; the UI can also dismiss by id.
  type Toast = {
    id: number;
    source: string;
    message: string;
    details?: string;
    at: number;
  };
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  let toastSeq = 0;
  function notify(source: string, message: string, details?: string) {
    const id = ++toastSeq;
    setToasts([...toasts(), { id, source, message, details, at: Date.now() }]);
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
  function wsErrorDetails(err: unknown): string | undefined {
    if (!err || typeof err !== "object") return undefined;
    const e = err as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["stack", "backtrace", "trace", "details", "detail"]) {
      const value = e[key];
      if (typeof value === "string" && value.trim()) parts.push(value);
    }
    if (parts.length === 0 && "data" in e) {
      parts.push(formatErrorData(e.data));
    }
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
  function formatErrorData(data: unknown): string {
    if (typeof data === "string")
      return data.length > 4000 ? data.slice(0, 4000) + "…" : data;
    try {
      const text = JSON.stringify(data, null, 2);
      return text.length > 4000 ? text.slice(0, 4000) + "…" : text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return "Unable to format error details: " + message;
    }
  }
  function isTransientWsError(err: unknown): boolean {
    return /^ws (disconnected|closed|not bound|request timed out)/i.test(
      wsErrorMessage(err),
    );
  }
  function reportError(source: string, err: unknown) {
    const message = wsErrorMessage(err);
    // Don't toast in-flight requests that fail because the WS dropped or a
    // background RPC got stuck behind a busy worker. The ws-status indicator
    // shows disconnects, and reconnect/ref handlers resync data once the
    // backend catches up. Without this filter, transient stalls flood the
    // screen with one toast per pending call (models/apps/describe/etc.).
    if (isTransientWsError(err)) return;
    notify(
      source,
      message,
      wsErrorDetails(err) ?? "No additional details were provided.",
    );
  }
  // Streaming reply buffer keyed by the current chat. Cleared by:
  // - draft-end events from the agent
  // - new chat selection
  // - stop/interrupt, after the partial content is moved to dismissedReplies
  // - the real Reply step landing (caller can clear via setDraftReply)
  const [draftReply, setDraftReply] = createSignal<{
    chatId: string;
    draftId: string;
    content: string;
    at: number;
  } | null>(null);
  const endedDraftReplyIds = new Map<string, number>();
  const [dismissedReplies, setDismissedReplies] = createSignal<
    DismissedReply[]
  >([]);

  function dismissedReplyId(chatId: string, draftId: string): string {
    return `dismissed-${chatId}-${draftId}`;
  }

  function rememberDismissedReply(
    chatId: string,
    draftId: string,
    content: string,
    at = Date.now(),
  ) {
    if (!content.trim()) return;
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
          at: previous?.at ?? at,
        },
      ];
      return next.slice(-MAX_DISMISSED_REPLIES);
    });
  }

  function dismissCurrentDraftReply(chatId: string) {
    const cur = untrack(draftReply);
    if (!cur || cur.chatId !== chatId) return;
    rememberDismissedReply(chatId, cur.draftId, cur.content);
  }

  function pruneDismissedReplies(chatId: string, rows: TimelineItem[]) {
    const replyTexts = rows
      .filter((item) => item.type === "step" && item.kind === "agent:Reply")
      .map((item) => String((item as any).text ?? "").trim())
      .filter(Boolean);
    if (replyTexts.length === 0) return;
    setDismissedReplies((items) =>
      items.filter((item) => {
        if (item.chatId !== chatId) return true;
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
    return (
      status === "agent:Failed" ||
      status === "agent:Cancelled" ||
      (status === "agent:Done" && hasUnansweredUserInput(timeline()))
    );
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

  function appTitle(uiId: string): string {
    const app = uiApps().find((candidate) => candidate.id === uiId);
    return app?.title || uiId;
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
      expandedDiffViewState: {},
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
      expandedDiffViewState: normalizeExpandedDiffViewState(
        state?.expandedDiffViewState,
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
      case "traces":
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
      case "traces":
        return (
          tab.kind === "store" || tab.kind === "json" || tab.kind === "trace"
        );
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
      case "trace":
        return (
          a.trace.id ===
          (b as Extract<RightSidebarTab, { kind: "trace" }>).trace.id
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
      const r = await api.ui.close(id, closing.uiId, closing.instanceId);
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
    const r = await api.fs.read(requestedPath, basePath, true);
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

  async function refreshMatchingRepoFiles(path: string) {
    const files = rightSidebarTabs()
      .filter(
        (tab): tab is Extract<RightSidebarTab, { kind: "file" }> =>
          tab.kind === "file",
      )
      .filter(
        (tab) =>
          sameRepoFilePath(tab.file.path, path) ||
          sameRepoFilePath(tab.file.requestedPath, path),
      );
    await Promise.all(
      files.map((tab) =>
        readRepoFileIntoSidebar(
          tab.file.requestedPath,
          currentChatWorktreePath(),
          false,
        ),
      ),
    );
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
    if (existing) return;
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
    const r = await api.objects.get(normalized);
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

  function openTraceEventInSidebar(trace: TraceRow, title?: string) {
    const tab = {
      id: "trace:" + encodeURIComponent(trace.id),
      kind: "trace" as const,
      title:
        title?.trim() ||
        String(trace.name || trace.kind || trace.id || "trace"),
      trace,
    };
    if (view() === "traces") {
      updateCurrentRightSidebarState((state) => ({
        ...state,
        tabs: [tab],
        activeTabId: tab.id,
        collapsed: false,
      }));
      return;
    }
    upsertRightSidebarTab(tab);
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

  // URL routing: `/chat/<id>` for chats, `/apps/<appId>` for app panes, `/new`, `/facts[/<graph>][#<subject>]`, `/pointers`, `/skills`, `/apps`, `/traces[/<traceId>]`, `/traces/chat/<chatId>`.
  type Loc =
    | { view: "chat"; chatId: string | null }
    | { view: "new" }
    | { view: "facts"; graph: string | null; subject: string | null }
    | { view: "pointers" }
    | { view: "skills" }
    | { view: "apps"; instanceId: string | null }
    | { view: "mcp" }
    | { view: "workflows" }
    | { view: "v8" }
    | { view: "traces"; traceId: string | null; chatId: string | null }
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
    if (path === "/workflows" || path.startsWith("/workflows/")) return { view: "workflows" };
    if (path === "/v8" || path.startsWith("/v8/")) return { view: "v8" };
    if (path === "/traces" || path.startsWith("/traces/")) {
      const parts = path
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
      if (parts[1] === "chat") {
        return { view: "traces", traceId: null, chatId: parts[2] || null };
      }
      return { view: "traces", traceId: parts[1] || null, chatId: null };
    }
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
      | "workflows"
      | "v8"
      | "traces"
      | "settings",
    id: string | null,
    subject: string | null,
    graph: string | null = null,
    traceChat: string | null = null,
    traceId: string | null = null,
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
    if (v === "workflows") return "/workflows";
    if (v === "v8") return "/v8";
    if (v === "traces")
      return traceChat
        ? `/traces/chat/${encodeURIComponent(traceChat)}`
        : traceId
          ? `/traces/${encodeURIComponent(traceId)}`
          : "/traces";
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
    | "workflows"
    | "v8"
    | "traces"
    | "settings"
  >(initialLoc.view);
  const [traceChatId, setTraceChatId] = createSignal<string | null>(
    initialLoc.view === "traces" ? (initialLoc.chatId ?? null) : null,
  );
  const [traceId, setTraceId] = createSignal<string | null>(
    initialLoc.view === "traces" ? (initialLoc.traceId ?? null) : null,
  );
  const [focusedSubject, setFocusedSubject] = createSignal<string | null>(
    initialLoc.view === "facts" ? initialLoc.subject : null,
  );
  const [focusedGraph, setFocusedGraph] = createSignal<string | null>(
    initialLoc.view === "facts" ? initialLoc.graph : null,
  );

  function pushUrl() {
    const path = buildPath(
      view(),
      chatId(),
      focusedSubject(),
      focusedGraph(),
      traceChatId(),
      traceId(),
    );
    if (location.pathname + location.search + location.hash !== path) {
      history.pushState(null, "", path);
    }
  }
  function replaceUrl() {
    const path = buildPath(
      view(),
      chatId(),
      focusedSubject(),
      focusedGraph(),
      traceChatId(),
      traceId(),
    );
    history.replaceState(null, "", path);
  }

  function showNewChat() {
    setOpenUiId(null);
    setOpenUiInstanceId(null);
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

  function showWorkflows() {
    setOpenUiId(null);
    setOpenUiInstanceId(null);
    setView("workflows");
    setFocusedSubject(null);
    setFocusedGraph(null);
    void refreshWorkflows();
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

  function showTraces(chatId?: string | null) {
    setOpenUiId(null);
    setOpenUiInstanceId(null);
    setView("traces");
    setTraceChatId(chatId ?? null);
    setTraceId(null);
    setFocusedSubject(null);
    setFocusedGraph(null);
    pushUrl();
  }

  function showTrace(id?: string | null) {
    setOpenUiId(null);
    setOpenUiInstanceId(null);
    setView("traces");
    setTraceChatId(null);
    setTraceId(id ?? null);
    setFocusedSubject(null);
    setFocusedGraph(null);
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
      setView("new");
      setFocusedSubject(null);
      setFocusedGraph(null);
      setOpenUiId(null);
      setOpenUiInstanceId(null);
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
    } else if (loc.view === "workflows") {
      setView("workflows");
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
    } else if (loc.view === "traces") {
      setView("traces");
      setTraceChatId(loc.chatId ?? null);
      setTraceId(loc.traceId ?? null);
      setFocusedSubject(null);
      setFocusedGraph(null);
      setOpenUiId(null);
      setOpenUiInstanceId(null);
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
      const target = loc.view === "chat" ? (loc.chatId ?? chats()[0]?.chatId ?? null) : (chats()[0]?.chatId ?? null);
      if (target && target !== chatId()) {
        void selectChat(target, true);
      } else if (!target) {
        setChatId(null);
        showTodosForChat(null);
        setDraftReply(null);
        setTimeline([]);
        setTrail([]);
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
    const archiveRefreshGuard = captureChatArchiveRefreshGuard();
    const keepHiddenChatId = chatId();
    const existingHidden = keepHiddenChatId
      ? chats().find((chat) => chat.chatId === keepHiddenChatId && chat.hidden)
      : null;
    const normalizedExistingHidden = existingHidden
      ? withExpectedChatWorktreePath(existingHidden)
      : null;
    const r = await api.chat.list();
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
      const runningChats = r.value.chats.filter(
        (c) => c.status === "agent:Running",
      );
      const live = new Set(runningChats.map((c) => c.chatId));
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
        return next;
      });
      setCompactingChats((current) => {
        const next = new Set<string>();
        for (const id of live) if (current.has(id)) next.add(id);
        return next;
      });
      if (chatId() && pending().some((p) => !live.has(p.chatId)))
        queueMicrotask(drain);
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
    const r = await api.chat.settings(ids);
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
    const requestSeq = ++chatModelRequestSeq;
    const bypassSingleFlight = Boolean(
      opts?.force ||
      pendingModelWritesByChat.has(id) ||
      pendingEffortWritesByChat.has(id),
    );
    if (bypassSingleFlight) chatModelsSingle.forget(id);
    const r = await retryChatLoad(
      () => (bypassSingleFlight ? api.chat.models(id) : chatModelsSingle(id)),
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
  // Coalesce into one in-flight + at most one queued re-fetch.
  let describeInFlight: string | null = null;
  let describeRequeued = false;
  let timelineMutationSeq = 0;
  const serverTimelineWatermarkByChat = new Map<string, number>();

  function newestTimelineWatermark(items: TimelineItem[]): number {
    let latest = 0;
    for (const item of items) {
      const at = Number((item as any).at ?? 0);
      const updatedAt = item.type === "step" ? Number((item as any).updatedAt ?? 0) : 0;
      const watermark = Math.max(
        Number.isFinite(at) ? at : 0,
        Number.isFinite(updatedAt) ? updatedAt : 0,
      );
      if (watermark > latest) latest = watermark;
    }
    return latest;
  }

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
    if (describeInFlight === id) {
      describeRequeued = true;
      if (showInlineRefresh) setTimelineRefreshing(true);
      return;
    }
    describeInFlight = id;
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
            api.chat.describeUpdate(id, {
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
          describeRequeued = true;
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
        () => api.chat.describeSnapshot(id, limit),
        keepCurrentChat,
      );
      if (r.ok) {
        cacheDescribeSnapshot(id, r.value, limit);
        if (chatId() !== id) return;
        if (describeSeq !== timelineMutationSeq) {
          describeRequeued = true;
          return;
        }
        applyDescribeValue(id, r.value);
      } else {
        if (chatId() !== id) return;
        reportError(`describe ${id}`, r.error);
      }
    } finally {
      describeInFlight = null;
      if (chatId() === id) setTimelineRefreshing(false);
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
    if (item.type === "step") {
      return item.kind === "agent:Reply" && item.draftId
        ? `step:draft:${item.draftId}`
        : `step:${item.step}`;
    }
    if (item.type === "input") return `input:${item.requestId}`;
    if (item.type === "input-response")
      return `input-response:${item.responseId}`;
    if (item.type === "log") return `log:${item.id}`;
    if (item.type === "trail") return `trail:${item.id}`;
    if (item.type === "memory-diff") return `memory-diff:${item.id}`;
    if (item.type === "todo-diff") return `todo-diff:${item.id}`;
    if (item.type === "blob-add") return `blob-add:${item.id}`;
    return `file-diff:${item.id}`;
  }

  function jsonEqual(a: unknown, b: unknown): boolean {
    return a === b || JSON.stringify(a) === JSON.stringify(b);
  }

  function imageAttachmentsEqual(
    a: ImageAttachment[] | undefined,
    b: ImageAttachment[] | undefined,
  ): boolean {
    if (a === b) return true;
    if (!a || !b) return !a && !b;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      const left = a[i] as any;
      const right = b[i] as any;
      if (
        left?.name !== right?.name ||
        left?.type !== right?.type ||
        left?.mimeType !== right?.mimeType ||
        left?.dataUrl !== right?.dataUrl ||
        left?.size !== right?.size
      )
        return false;
    }
    return true;
  }

  function diffStatsEqual(
    a: FileDiffItem["stats"] | MemoryDiffItem["stats"] | undefined,
    b: FileDiffItem["stats"] | MemoryDiffItem["stats"] | undefined,
  ): boolean {
    if (a === b) return true;
    if (!a || !b) return !a && !b;
    return (
      (a as any).added === (b as any).added &&
      (a as any).removed === (b as any).removed &&
      (a as any).lines === (b as any).lines
    );
  }

  function stepErrorEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (!a || !b) return !a && !b;
    const left = a as any;
    const right = b as any;
    return (
      left.kind === right.kind &&
      left.at === right.at &&
      jsonEqual(left.detail, right.detail)
    );
  }

  function runJsDetailsEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (!a || !b) return !a && !b;
    const left = a as any;
    const right = b as any;
    return (
      left.label === right.label &&
      left.description === right.description &&
      left.code === right.code &&
      left.result === right.result &&
      left.error === right.error &&
      left.durationNs === right.durationNs &&
      jsonEqual(left.args, right.args)
    );
  }

  function subagentDetailsEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (!a || !b) return !a && !b;
    const left = a as any;
    const right = b as any;
    const leftResult = left.result;
    const rightResult = right.result;
    const resultEqual =
      leftResult === rightResult ||
      (!leftResult || !rightResult
        ? !leftResult && !rightResult
        : leftResult.status === rightResult.status &&
          leftResult.childChatId === rightResult.childChatId &&
          leftResult.text === rightResult.text &&
          leftResult.error === rightResult.error &&
          leftResult.durationNs === rightResult.durationNs &&
          jsonEqual(leftResult.usage, rightResult.usage));
    return (
      left.label === right.label &&
      left.task === right.task &&
      left.childChatId === right.childChatId &&
      left.parentRunJsStepId === right.parentRunJsStepId &&
      resultEqual
    );
  }

  function timelineItemEqual(a: TimelineItem, b: TimelineItem): boolean {
    // Avoid serializing every row on each describe refresh. Large RunJS results
    // and diffs dominate timeline cost; compare hot fields directly so unchanged
    // objects can still be reused without allocating a full JSON copy per row.
    if (a === b) return true;
    if (a.type !== b.type || a.at !== b.at) return false;
    switch (a.type) {
      case "step": {
        if (b.type !== "step") return false;
        const right = b;
        return (
          a.step === right.step &&
          a.kind === right.kind &&
          a.status === right.status &&
          a.text === right.text &&
          a.model === right.model &&
          a.effort === right.effort &&
          a.thoughtDurationNs === right.thoughtDurationNs &&
          a.draftId === right.draftId &&
          a.deletedAt === right.deletedAt &&
          a.lazyRunjsResult === right.lazyRunjsResult &&
          a.resultHash === right.resultHash &&
          imageAttachmentsEqual(a.attachments, right.attachments) &&
          stepErrorEqual(a.error, right.error) &&
          runJsDetailsEqual(a.runjs, right.runjs) &&
          subagentDetailsEqual(a.subagent, right.subagent)
        );
      }
      case "input": {
        if (b.type !== "input") return false;
        const right = b;
        return (
          a.requestId === right.requestId &&
          a.kind === right.kind &&
          a.status === right.status &&
          jsonEqual(a.spec, right.spec) &&
          jsonEqual(a.response, right.response)
        );
      }
      case "input-response": {
        if (b.type !== "input-response") return false;
        const right = b;
        return (
          a.responseId === right.responseId &&
          a.requestId === right.requestId &&
          a.kind === right.kind &&
          jsonEqual(a.spec, right.spec) &&
          jsonEqual(a.response, right.response)
        );
      }
      case "file-diff": {
        if (b.type !== "file-diff") return false;
        const right = b;
        return (
          a.id === right.id &&
          a.step === right.step &&
          a.chatId === right.chatId &&
          a.path === right.path &&
          a.hash === right.hash &&
          a.diff === right.diff &&
          a.before === right.before &&
          a.after === right.after &&
          diffStatsEqual(a.stats, right.stats)
        );
      }
      case "todo-diff": {
        if (b.type !== "todo-diff") return false;
        const right = b;
        return (
          a.id === right.id &&
          a.step === right.step &&
          a.chatId === right.chatId &&
          a.hash === right.hash &&
          a.at === right.at &&
          jsonEqual(a.changes, right.changes) &&
          jsonEqual(a.todos, right.todos)
        );
      }
      case "memory-diff": {
        if (b.type !== "memory-diff") return false;
        const right = b;
        return (
          a.id === right.id &&
          a.step === right.step &&
          a.chatId === right.chatId &&
          a.store === right.store &&
          a.graph === right.graph &&
          a.action === right.action &&
          a.count === right.count &&
          a.path === right.path &&
          a.hash === right.hash &&
          a.diff === right.diff &&
          a.before === right.before &&
          a.after === right.after &&
          diffStatsEqual(a.stats, right.stats) &&
          jsonEqual(a.changes, right.changes)
        );
      }
      case "blob-add": {
        if (b.type !== "blob-add") return false;
        const right = b;
        return (
          a.id === right.id &&
          a.step === right.step &&
          a.chatId === right.chatId &&
          a.objectKind === right.objectKind &&
          a.hash === right.hash &&
          a.size === right.size &&
          a.chars === right.chars &&
          a.encoding === right.encoding
        );
      }
      case "log": {
        if (b.type !== "log") return false;
        const right = b;
        return a.id === right.id && a.message === right.message;
      }
      case "trail": {
        if (b.type !== "trail") return false;
        const right = b;
        return (
          a.id === right.id &&
          a.kind === right.kind &&
          a.title === right.title &&
          a.body === right.body &&
          a.summary === right.summary
        );
      }
    }
    return false;
  }

  function preserveTimelineItems(
    server: TimelineItem[],
    current: TimelineItem[],
  ): TimelineItem[] {
    const currentByKey = new Map(
      current.map((item) => [timelineItemKey(item), item]),
    );
    return server.flatMap((item) => {
      if (!shouldShowTimelineItem(item)) return [];
      const previous = currentByKey.get(timelineItemKey(item));
      return [previous && timelineItemEqual(previous, item) ? previous : item];
    });
  }

  function sortTimelineItems(items: TimelineItem[]): TimelineItem[] {
    return [...items].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  }

  function isConversationStepKind(kind: string): boolean {
    return (
      kind === "agent:UserInput" ||
      kind === "agent:Reply" ||
      kind === "agent:Final" ||
      kind === "agent:Error"
    );
  }


  function hasUnansweredUserInput(items: TimelineItem[]): boolean {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item?.type !== "step") continue;
      if (!isConversationStepKind(item.kind)) continue;
      return (
        item.kind === "agent:UserInput" &&
        item.status === "agent:Done" &&
        item.deletedAt == null
      );
    }
    return false;
  }

  function trimTimelineRows(items: TimelineItem[]): TimelineItem[] {
    const max =
      Math.max(timelineLimit(), INITIAL_TIMELINE_LIMIT) + LIVE_TIMELINE_SLACK;
    if (items.length <= max) return items;
    return sortTimelineItems(items).slice(-max);
  }

  function rememberTimelineKeys(items: TimelineItem[]) {
    for (const item of items)
      timelineShown.set(timelineItemKey(item), item.at ?? Date.now());
    if (timelineShown.size <= MAX_REMEMBERED_TIMELINE_KEYS) return;
    const keep = [...timelineShown.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_REMEMBERED_TIMELINE_KEYS);
    timelineShown.clear();
    for (const [key, at] of keep) timelineShown.set(key, at);
  }

  function compactTimelineRows(items: TimelineItem[]): TimelineItem[] {
    const trimmed = trimTimelineRows(items.filter(shouldShowTimelineItem));
    rememberTimelineKeys(trimmed);
    return trimmed;
  }

  function dedupeTimelineRows(items: TimelineItem[]): TimelineItem[] {
    const byKey = new Map<string, TimelineItem>();
    for (const item of items) byKey.set(timelineItemKey(item), item);
    return sortTimelineItems([...byKey.values()]);
  }

  function withoutConfirmedOptimisticRows(
    server: TimelineItem[],
    current: TimelineItem[],
  ): TimelineItem[] {
    const remaining = new Map<string, number>();
    for (const item of server) {
      if (item.type === "step" && (item as any).kind === "agent:UserInput") {
        const text = (item as any).text ?? "";
        remaining.set(text, (remaining.get(text) ?? 0) + 1);
      }
    }
    return current.filter((item) => {
      if (!(item.type === "step" && item.step?.startsWith?.("opt-")))
        return true;
      const text = (item as any).text ?? "";
      const count = remaining.get(text) ?? 0;
      if (count <= 0) return true;
      remaining.set(text, count - 1);
      return false;
    });
  }

  function mergeTimelineUpdateRows(
    server: TimelineItem[],
    current: TimelineItem[],
  ): TimelineItem[] {
    return compactTimelineRows(
      dedupeTimelineRows([
        ...withoutConfirmedOptimisticRows(server, current),
        ...preserveTimelineItems(server, current),
      ]),
    );
  }

  function mergeTimelineRows(
    server: TimelineItem[],
    current: TimelineItem[],
  ): TimelineItem[] {
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
    return compactTimelineRows(
      sortTimelineItems([...stableServer, ...survivors]),
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
      const r = await api.memory.graphs.summaries({ removed });
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
      const r = await api.memory.pointers.list(prefix);
      if (r.ok) setPointers(r.value.pointers);
      else reportError("pointers", r.error);
    } catch (err) {
      reportError("pointers", err);
    } finally {
      setPointersLoaded(true);
    }
  }

  async function removePointer(name: string, recursive = false) {
    const r = await api.memory.pointers.remove(
      name,
      recursive ? { recursive: true } : undefined,
    );
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
      const r = await api.memory.triples({
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
    const r = await api.memory.vocabulary();
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

  async function refreshSkills() {
    const current = chatId();
    const r = await skillsListSingle(current ? { chatId: current } : {});
    setSkillsLoaded(true);
    if (r.ok) setSkills(r.value.skills);
    else reportError("skills", r.error);
  }

  async function refreshWorkflows() {
    const r = await workflowsListSingle();
    setWorkflowDefinitionsLoaded(true);
    if (r.ok) setWorkflowDefinitions(r.value.workflows);
    else reportError("workflows", r.error);
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
    const traceSettings = traceSettingsSingle()
      .then((result) => {
        if (result.ok) setTraceSettingsCache(result.value);
        else noteError(result.error.message);
      })
      .catch((reason) => noteError(errorMessage(reason)));

    await Promise.all([settings, v8Settings, traceSettings]);
    setSettingsError(firstError);
  }

  function setCachedSettings(next: LlmAuthSettings) {
    setSettingsCache(next);
  }

  function setCachedV8Settings(next: V8SettingsValue) {
    setV8SettingsCache(next);
  }

  function setCachedTraceSettings(next: TraceSettingsValue) {
    setTraceSettingsCache(next);
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
          const r = await api.v8.stats();
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
    setOpenUiId(primaryUiId);
    setOpenUiInstanceId(instanceId);
  }

  async function resolveUiInstance(
    instanceId: string,
  ): Promise<{ uiId: string | null; chatId: string | null } | null> {
    const subject = "uiinst:" + normalizeUiInstanceId(instanceId);
    const r = await api.memory.triples({ subject });
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
      showTodosForChat(resolved.chatId);
      setDraftReply(null);
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
      if (!restored) setTokens(null);
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
    opts?: { hydrate?: boolean },
  ) {
    setChatId(id);
    showTodosForChat(id);
    setDraftReply(null);
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
        if (chatId() !== id) return;
        void refreshTimeline({
          showRefreshing: cachedDescribeNeedsRefresh(id, summary),
        });
        void refreshChatModel();
        void refreshChatUis();
      });
      return;
    }
    await refreshTimeline();
    if (chatId() !== id) return;
    queueMicrotask(() => {
      if (chatId() !== id) return;
      void refreshChatModel();
      void refreshChatUis();
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
    const r = await api.chat.compactions(id);
    if (chatId() !== id) return;
    setCompactionsLoading(false);
    if (r.ok) setCompactions(r.value);
    else reportError("compactions " + id, r.error);
  }

  const pendingChatCreations = new Map<string, Promise<boolean>>();

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
    const now = Date.now();
    const summary: ChatSummary = {
      chatId: requestedChatId,
      createdAt: now,
      lastAt: now,
      head: null,
      title: null,
      path: path ?? null,
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
    if (opts?.select === false) {
      setChatId(requestedChatId);
      showTodosForChat(requestedChatId);
      setDraftReply(null);
      loadWipText(requestedChatId);
    } else {
      await selectChat(requestedChatId, false, { hydrate: false });
      queueMicrotask(() => {
        refreshChatModel();
        refreshChatUis();
      });
    }

    const creation = (async () => {
      const r = await api.chat.new({
        chatId: requestedChatId,
        path,
        branch: opts?.branch ?? undefined,
      });
      if (!r.ok) {
        reportError("new chat", r.error);
        setChats((current) =>
          current.filter((c) => c.chatId !== requestedChatId),
        );
        if (chatId() === requestedChatId) {
          const fallback = chats().find((c) => c.chatId !== requestedChatId);
          if (fallback) void selectChat(fallback.chatId);
          else {
            setChatId(null);
            showTodosForChat(null);
          }
        }
        return false;
      }
      setChats((current) =>
        current.map((c) =>
          c.chatId === requestedChatId
            ? {
                ...c,
                chatId: r.value.chatId,
                path: r.value.path ?? c.path,
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

    return requestedChatId;
  }

  async function removeChat(id: string) {
    const deleteSeq = ++chatDeleteSeq;
    chatDeleteSeqByChat.set(id, deleteSeq);
    const previousChats = chats();
    const previousChatId = chatId();
    const wasSelected = previousChatId === id;
    const nextChats = previousChats.filter((chat) => chat.chatId !== id);

    // Delete should feel instantaneous even for a chat that is currently
    // thinking. Drop all local activity state and remove the sidebar row before
    // waiting for the backend, which pre-interrupts any running driver.
    setChats(nextChats);
    forgetChatCache(id);
    forgetTodosForChat(id);
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
        setChatId(null);
        showTodosForChat(null);
        setDraftReply(null);
        setOpenUiId(null);
        setOpenUiInstanceId(null);
        setView("chat");
        setFocusedSubject(null);
        setTimeline([]);
        setTrail([]);
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

    const r = await api.chat.remove(id);
    if (!r.ok) {
      if (chatDeleteSeqByChat.get(id) === deleteSeq)
        chatDeleteSeqByChat.delete(id);
      setChats(previousChats);
      if (wasSelected && previousChatId) void selectChat(previousChatId);
      reportError(`remove ${id}`, r.error);
    }
  }

  async function removeGraph(graph: string) {
    const r = await api.memory.graphs.remove(graph);
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

    const r = await api.ui.open(chat, uiId, instanceId);
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
    const r = await api.ui.remove(uiId);
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
  let pendingLoaded = false;
  let suppressPendingSave = false;

  async function loadPendingMessages() {
    const r = await api.chat.pendingMessages();
    if (!r.ok) {
      reportError("load pending messages", r.error);
      pendingLoaded = true;
      return;
    }
    suppressPendingSave = true;
    setPending(r.value.messages);
    suppressPendingSave = false;
    pendingLoaded = true;
    queueMicrotask(drain);
  }

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

  void loadPendingMessages();
  createEffect(() => {
    const pen = pending();
    if (!pendingLoaded || suppressPendingSave) return;
    void api.chat.savePendingMessages(pen).then((r) => {
      if (!r.ok) reportError("save pending messages", r.error);
    });
  });

  function isMcpSetupMessage(text: string): boolean {
    return text.trim().toLowerCase() === "mcp setup";
  }

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
    deleteFromSet(setInterruptedChats, interruptedChats, cid);
    queueMicrotask(drain);
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
    queueMicrotask(drain);
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
    const id = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 6)}`;
    appendOptimisticUserInput(chat, id, text, attachments);
    if (!(await waitForChatCreation(chat))) return;
    await waitForChatSettingsWrites(chat);
    const r = await api.chat.step(chat, text, attachments);
    if (!r.ok) reportError(`${label} ${chat}`, r.error);
  }

  async function drain() {
    if (draining || !pendingLoaded) return;
    draining = true;
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

        if (isMcpSetupMessage(head.text)) {
          deleteFromSet(setInterruptedChats, interruptedChats, head.chatId);
          void dispatchMessageNow(
            head.chatId,
            head.text,
            head.attachments || [],
            "MCP setup",
          );
          continue;
        }

        // Lock local dispatch before /api/run returns so another queued item
        // for the same chat cannot be picked before the step-start WS event.
        // Do not mark the chat active here: the visible thinking state should
        // wait for the server-confirmed step-start event or running status.
        addToSet(setDispatchingChats, dispatchingChats, head.chatId);

        appendOptimisticUserInput(
          head.chatId,
          head.id,
          head.text,
          head.attachments || [],
        );
        // /api/run now returns immediately; the chat driver runs the agent
        // loop in the background. Keep the local dispatch lock until
        // step-start/step-end (or an error) so follow-up messages remain
        // queued/editable without showing the thinking indicator early.
        if (!(await waitForChatCreation(head.chatId))) {
          deleteFromSet(setDispatchingChats, dispatchingChats, head.chatId);
          continue;
        }
        await waitForChatSettingsWrites(head.chatId);
        const r = await api.chat.step(
          head.chatId,
          head.text,
          head.attachments || [],
        );
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
    const r = await api.chat.deleteMessage(id, step);
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
    const r = await api.chat.restoreMessage(id, step);
    if (!r.ok) {
      patchMessageVisibility(id, step, previousDeletedAt ?? Date.now());
      reportError("restore message", r.error);
      return;
    }
    if (chatId() !== id || mutationSeq !== timelineMutationSeq) return;
    patchMessageVisibility(id, step, null);
    void refreshTimeline();
  }

  async function forkChatAtStep(step: string) {
    const id = chatId();
    if (!id) return null;
    const r = await api.chat.fork(id, step);
    if (!r.ok) {
      reportError("fork chat", r.error);
      return null;
    }
    await refreshChats();
    await selectChat(r.value.chatId, false);
    return r.value.chatId;
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
      const r = await api.chat.setModel(id, model);
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
      const r = await api.chat.setEffort(id, effort);
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
    const r = await api.chat.rename(id, title);
    if (r.ok) updateChatSummary(id, { title: r.value.title });
    else reportError(`rename ${id}`, r.error);
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

    const r = await api.chat.archive(id, archived);
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
    const r = await api.chat.compact(id);
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
    const r = await api.chat.resume(id);
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
    setDraftReply(null);
    if (options.offerResume) setResumeOfferRequest((n) => n + 1);
    // Keep queued follow-ups paused until the interrupt RPC reaches Rust.
    // Draining earlier can start a fresh turn that the delayed interrupt then
    // aborts, leaving the user's follow-up apparently queued/stuck.
    const r = await api.chat.interrupt(id);
    deleteFromSet(setInterruptingChats, interruptingChats, id);
    if (!r.ok) reportError(`interrupt ${id}`, r.error);
    if (options.resumeQueued) queueMicrotask(drain);
  }

  function stopAgent() {
    return interruptAgent({ resumeQueued: true, offerResume: true });
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
  const refreshWorkflowsSoon = debounce(refreshWorkflows);
  const refreshV8StatsSoon = debounce(refreshV8Stats, 1000);
  const pendingRepoFileRefreshPaths = new Set<string>();
  const refreshPendingRepoFilesSoon = debounce(() => {
    const paths = Array.from(pendingRepoFileRefreshPaths);
    pendingRepoFileRefreshPaths.clear();
    void Promise.all(paths.map((path) => refreshMatchingRepoFiles(path)));
  }, 150);
  function refreshMatchingRepoFilesSoon(path: string) {
    pendingRepoFileRefreshPaths.add(path);
    refreshPendingRepoFilesSoon();
  }

  const events = new EventStream();
  bindWS(events);
  void refreshSettingsCache();
  void refreshSkills();
  void refreshWorkflows();
  const offEvents = events.on((ev: any) => {
    if (ev.kind === "ping") return;
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
      refreshWorkflows();
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
              (item: any) => !(item.type === "file-diff" && item.id === id),
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
              changes: ev.changes,
              hash: ev.hash,
              at: ev.at || Date.now(),
            } as TimelineItem,
          ]),
        );
        refreshMatchingRepoFilesSoon(ev.path);
      }
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
              (item: any) => !(item.type === "todo-diff" && item.id === id),
            ),
            {
              type: "todo-diff",
              id,
              step: ev.stepId,
              chatId: ev.chatId,
              path: ev.path,
              diff: ev.diff,
              stats: ev.stats,
              before: ev.before,
              after: ev.after,
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
              (item: any) => !(item.type === "memory-diff" && item.id === id),
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
              (item: any) => !(item.type === "blob-add" && item.id === id),
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

    if (ev.kind === "runjs-step-finished") {
      const cid = chatId();
      if (cid && ev.chatId === cid && ev.stepId) {
        setTimeline((items) =>
          compactTimelineRows(
            items.map((item: any) => {
              if (item.type !== "step" || item.step !== ev.stepId) return item;
              const runjs = item.runjs
                ? {
                    ...item.runjs,
                    error:
                      typeof ev.error === "string"
                        ? ev.error
                        : item.runjs.error,
                    durationNs:
                      typeof ev.durationNs === "number"
                        ? ev.durationNs
                        : item.runjs.durationNs,
                  }
                : item.runjs;
              return {
                ...item,
                status: ev.status || (ev.error ? "agent:Failed" : "agent:Done"),
                resultHash: ev.resultHash || item.resultHash,
                lazyRunjsResult: !!(ev.resultHash || item.resultHash),
                runjs,
              } as TimelineItem;
            }),
          ),
        );
        refreshTimelineIncrementalSoon();
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
            const next: TokenProgressValue = {
              used,
              budget,
              threshold,
              fraction: Number.isFinite(explicitFraction)
                ? explicitFraction
                : budget > 0
                  ? used / budget
                  : 0,
            };
            const source =
              typeof ev.source === "string" ? ev.source : cur?.source;
            if (source) next.source = source;
            if (typeof ev.estimated === "boolean")
              next.estimated = ev.estimated;
            else if (typeof cur?.estimated === "boolean")
              next.estimated = cur.estimated;
            return mergeTokenProgress(cur, next, activeChats().has(cid), {
              reset: ev.reset === true,
            });
          });
        }
      }
      return;
    }
    if (ev.kind === "draft") {
      const cid = chatId();
      if (cid && ev.chatId === cid) {
        // A draft event can only come from the real answer stream; compaction
        // summary calls do not emit drafts. If compaction-end was missed, don't
        // let the compacting status leak into the streamed reply UI.
        deleteFromSet(setCompactingChats, compactingChats, cid);
        if (
          dismissedReplies().some(
            (item) => item.chatId === cid && item.draftId === ev.draftId,
          )
        ) {
          rememberDismissedReply(cid, ev.draftId, ev.content);
          const cur = draftReply();
          if (cur?.draftId === ev.draftId) setDraftReply(null);
          return;
        }
        endedDraftReplyIds.delete(ev.draftId);
        const previous = draftReply();
        setDraftReply({
          chatId: cid,
          draftId: ev.draftId,
          content: ev.content,
          at:
            previous?.draftId === ev.draftId
              ? (previous?.at ?? (Number(ev.at) || Date.now()))
              : Number(ev.at) || Date.now(),
        });
      }
      return;
    }
    if (ev.kind === "draft-end") {
      const cur = draftReply();
      if (cur && cur.draftId === ev.draftId) {
        endedDraftReplyIds.set(ev.draftId, Date.now());
        window.setTimeout(() => {
          const latest = draftReply();
          if (
            latest?.draftId === ev.draftId &&
            endedDraftReplyIds.has(ev.draftId)
          ) {
            endedDraftReplyIds.delete(ev.draftId);
            setDraftReply(null);
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
        if (ev.chatId === chatId()) refreshTimelineIncrementalSoon();
      }
      return;
    }
    if (ev.kind === "step-start") {
      addToSet(setActiveChats, activeChats, ev.chatId);
      if (ev.compacting === true) {
        addToSet(setCompactingChats, compactingChats, ev.chatId);
      }
      setChatStartedAt(ev.chatId, ev.at);
      deleteFromSet(setDispatchingChats, dispatchingChats, ev.chatId);
      deleteFromSet(setInterruptingChats, interruptingChats, ev.chatId);
      updateChatSummary(ev.chatId, {
        status: "agent:Running",
        runningStartedAt: Number(ev.at) || Date.now(),
      });
      return;
    }
    if (ev.kind === "step-end") {
      deleteFromSet(setActiveChats, activeChats, ev.chatId);
      deleteFromSet(setCompactingChats, compactingChats, ev.chatId);
      deleteChatStartedAt(ev.chatId);
      deleteFromSet(setDispatchingChats, dispatchingChats, ev.chatId);
      deleteFromSet(setInterruptingChats, interruptingChats, ev.chatId);
      updateChatSummary(ev.chatId, {
        status: "agent:Done",
        runningStartedAt: null,
      });
      queueMicrotask(drain);
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
      if (typeof ref === "string" && (ref === "skills/index" || ref.startsWith("skills/"))) refreshSkillsSoon();
      if (
        typeof ref === "string" &&
        ref.startsWith("workflow/") &&
        !ref.startsWith("workflow/run/")
      ) {
        refreshWorkflowsSoon();
      }
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
      const r = await api.llmAuth.oauthComplete(
        initialOAuthCallback.state,
        initialOAuthCallback.code,
      );
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
    const r = await api.mcp.oauth.complete(
      initialOAuthCallback.state,
      initialOAuthCallback.code,
    );
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
    refreshWorkflowsSoon.cancel();
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
      await refreshChats();
      if (initialView !== "facts") refreshGraphSummaries();
      if (initialView === "apps") {
        await refreshUis();
      } else refreshUis();
      refreshMcpServers();
      const loc = parseLocation();
      const list = chats();
      if (
        loc.view === "new" ||
        loc.view === "facts" ||
        loc.view === "pointers" ||
        loc.view === "skills" ||
        loc.view === "apps" ||
        loc.view === "mcp" ||
        loc.view === "workflows" ||
        loc.view === "v8" ||
        loc.view === "traces" ||
        loc.view === "settings"
      ) {
        if (loc.view === "apps" && loc.instanceId) {
          setView("apps");
          await openUiFromRoute(loc.instanceId, "replace");
          if (pending().length > 0) drain();
          return;
        }
        if (list.length > 0) {
          setChatId(list[0]!.chatId);
          showTodosForChat(list[0]!.chatId);
          loadWipText(list[0]!.chatId);
          await Promise.all([refreshTimeline(), refreshChatModel()]);
        }
        if (loc.view === "new") setView("new");
        else if (loc.view === "apps") setView("apps");
        else if (loc.view === "mcp") setView("mcp");
        else if (loc.view === "workflows") setView("workflows");
        else if (loc.view === "skills") {
          setView("skills");
          void refreshSkills();
        }
        else if (loc.view === "v8") {
          setView("v8");
          void refreshV8Stats();
        } else if (loc.view === "traces") {
          setView("traces");
          setTraceChatId(loc.chatId);
        } else if (loc.view === "settings") setView("settings");
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
    workflowDefinitions,
    workflowDefinitionsLoaded,
    v8Stats,
    v8StatsLoaded,
    settingsCache,
    v8SettingsCache,
    traceSettingsCache,
    settingsError,
    chatUiApps,
    uiInstances,
    openUiId,
    openUiInstanceId,
    thinking,
    compacting,
    canResumeAgent,
    thinkingStartedAt,
    isChatActive: (id: string) => activeChats().has(id),
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
    openTraceEventInSidebar,
    archivedCollapsed,
    setArchivedCollapsed,
    tick,
    view,
    traceChatId,
    traceId,
    focusedSubject,
    focusedGraph,
    showNewChat,
    showFacts,
    showPointers,
    showApps,
    showMcp,
    showWorkflows,
    showSkills,
    showV8,
    showTraces,
    showTrace,
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
    setCachedTraceSettings,
    refreshChatUis,
    retract: async (s: string, p: string, o: string) => {
      const r = await api.memory.retract({
        subject: s,
        predicate: p,
        object: o,
      });
      if (!r.ok) reportError("retract", r.error);
      await refreshFactsView();
      await refreshVocabulary();
    },
    removeSubject: async (graph: string, s: string) => {
      const r = await api.memory.subject.remove(graph, s);
      if (!r.ok) reportError("delete subject", r.error);
      await refreshFactsView();
      await refreshVocabulary();
    },
    removeTriple: async (graph: string, s: string, p: string, o: string) => {
      const r = await api.memory.triple.remove(graph, s, p, o);
      if (!r.ok) reportError("delete triple", r.error);
      await refreshFactsView();
      await refreshVocabulary();
    },
    restoreTriple: async (graph: string, s: string, p: string, o: string) => {
      const r = await api.memory.triple.restore(graph, s, p, o);
      if (!r.ok) reportError("undelete triple", r.error);
      await refreshFactsView();
      await refreshVocabulary();
    },
    submitForm: async (requestId: string, values: Record<string, unknown>) => {
      const r = await api.chat.submit(chatId()!, requestId, values);
      if (!r.ok) reportError("submit form", r.error);
      await refreshTimeline();
    },
    cancelForm: async (requestId: string) => {
      const r = await api.chat.cancel(chatId()!, requestId);
      if (!r.ok) reportError("cancel form", r.error);
      await refreshTimeline();
    },
    toasts,
    dismissToast,
    notify,
    start,
  };
}
