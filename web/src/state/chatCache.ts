import type { ChatSummary, DescribeOverviewValue, TimelineItem } from "../api";
import type {
  CachedTimelinePage,
  CachedTrailPage,
  ChatCacheEntry,
} from "./types";

const INITIAL_TIMELINE_LIMIT = 160;

export function timelineCacheKey(limit: number): string {
  const n = Math.max(1, Math.floor(Number(limit) || INITIAL_TIMELINE_LIMIT));
  return `limit:${n}`;
}

export function trailCacheKey(limit: number): string {
  const n = Math.max(1, Math.floor(Number(limit) || INITIAL_TIMELINE_LIMIT));
  return `limit:${n}`;
}

export function pruneCachedPages<
  T extends { accessedAt?: number; cachedAt?: number },
>(
  pages: Record<string, T> | undefined,
  max: number,
  keepKey?: string,
): Record<string, T> | undefined {
  if (!pages) return undefined;
  const entries = Object.entries(pages).filter(([, page]) => !!page);
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => {
    if (a[0] === keepKey) return -1;
    if (b[0] === keepKey) return 1;
    const atA = Number(a[1].accessedAt ?? a[1].cachedAt ?? 0);
    const atB = Number(b[1].accessedAt ?? b[1].cachedAt ?? 0);
    return atB - atA;
  });
  return Object.fromEntries(entries.slice(0, max));
}

export function chatCacheHasData(entry: ChatCacheEntry): boolean {
  return !!(
    entry.checkpoint ||
    entry.overview ||
    (entry.timelinePages && Object.keys(entry.timelinePages).length > 0) ||
    (entry.trailPages && Object.keys(entry.trailPages).length > 0) ||
    entry.model ||
    entry.ui ||
    entry.rightSidebar
  );
}

export function isDescribeFreshForSummary(
  value: DescribeOverviewValue | undefined,
  summary: ChatSummary | undefined,
): boolean {
  if (!value || !summary) return !!value;
  return (
    value.head === summary.head &&
    value.totalFacts === summary.totalFacts &&
    value.totalTurns === summary.totalTurns &&
    value.totalSteps === summary.totalSteps
  );
}

export function mergeCachedOverviewWithSummary(
  overview: DescribeOverviewValue,
  summary: ChatSummary | undefined,
): DescribeOverviewValue {
  if (!summary) return overview;
  const next: DescribeOverviewValue = {
    ...overview,
    head: summary.head,
    title: summary.title,
    path: summary.path,
    totalFacts: summary.totalFacts,
    totalTurns: summary.totalTurns,
    totalSteps: summary.totalSteps,
  };
  if (summary.baseBranch !== undefined) {
    next.baseBranch = summary.baseBranch;
  }
  if (summary.worktreePath !== undefined) {
    next.worktreePath = summary.worktreePath;
  }
  if (Number.isFinite(summary.createdAt) && summary.createdAt > 0) {
    next.createdAt = summary.createdAt;
  }
  if (Number.isFinite(summary.lastAt) && summary.lastAt > 0) {
    next.lastAt = summary.lastAt;
  }
  if (summary.hidden !== undefined) next.hidden = summary.hidden;
  if (summary.parentChatId !== undefined) {
    next.parentChatId = summary.parentChatId;
  }
  return next;
}

function normalizeCachedTimelinePage(
  value: unknown,
  fallbackAt: number,
): CachedTimelinePage | null {
  if (!value || typeof value !== "object") return null;
  const page = value as Partial<CachedTimelinePage>;
  if (!Array.isArray(page.items) || typeof page.hiddenItems !== "number")
    return null;
  const limit = Math.max(
    1,
    Math.floor(Number(page.limit) || INITIAL_TIMELINE_LIMIT),
  );
  return {
    ...page,
    items: page.items as TimelineItem[],
    hiddenItems: page.hiddenItems,
    limit,
    cachedAt: Number(page.cachedAt ?? fallbackAt),
    accessedAt: Number(page.accessedAt ?? page.cachedAt ?? fallbackAt),
  };
}

function normalizeCachedTrailPage(
  value: unknown,
  fallbackAt: number,
): CachedTrailPage | null {
  if (!value || typeof value !== "object") return null;
  const page = value as Partial<CachedTrailPage>;
  if (!Array.isArray(page.items)) return null;
  const limit = Math.max(
    1,
    Math.floor(Number(page.limit) || INITIAL_TIMELINE_LIMIT),
  );
  return {
    ...page,
    items: page.items as TimelineItem[],
    limit,
    cachedAt: Number(page.cachedAt ?? fallbackAt),
    accessedAt: Number(page.accessedAt ?? page.cachedAt ?? fallbackAt),
  };
}

export function normalizeChatCacheEntry(raw: unknown): ChatCacheEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<ChatCacheEntry>;
  const updatedAt = Number(value.updatedAt || Date.now());
  const timelinePages: Record<string, CachedTimelinePage> = {};
  if (value.timelinePages && typeof value.timelinePages === "object") {
    for (const [key, page] of Object.entries(value.timelinePages)) {
      const normalized = normalizeCachedTimelinePage(page, updatedAt);
      if (normalized) timelinePages[key] = normalized;
    }
  }
  const trailPages: Record<string, CachedTrailPage> = {};
  if (value.trailPages && typeof value.trailPages === "object") {
    for (const [key, page] of Object.entries(value.trailPages)) {
      const normalized = normalizeCachedTrailPage(page, updatedAt);
      if (normalized) trailPages[key] = normalized;
    }
  }
  return {
    updatedAt,
    checkpoint: value.checkpoint,
    overview: value.overview,
    timelinePages,
    trailPages,
    model: value.model,
    ui: value.ui,
    rightSidebar: value.rightSidebar,
  };
}
