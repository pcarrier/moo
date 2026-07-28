import type { TimelineItem } from "../api";

type StepTimelineItem = Extract<TimelineItem, { type: "step" }>;

export type TimelineRowCompactionOptions = {
  limit: number;
  minimumLimit?: number;
  liveSlack?: number;
  rememberedKeys?: Map<string, number>;
  maxRememberedKeys?: number;
  nowMs?: () => number;
};

export function shouldShowTimelineItem(item: TimelineItem): boolean {
  return (
    item.type !== "task-diff" ||
    (Array.isArray(item.changes) && item.changes.length > 0)
  );
}

export function newestTimelineWatermark(items: TimelineItem[]): number {
  let latest = 0;
  for (const item of items) {
    const at = Number(item.at ?? 0);
    const updatedAt = item.type === "step" ? Number(item.updatedAt ?? 0) : 0;
    const watermark = Math.max(
      Number.isFinite(at) ? at : 0,
      Number.isFinite(updatedAt) ? updatedAt : 0,
    );
    if (watermark > latest) latest = watermark;
  }
  return latest;
}

export function timelineItemKey(item: TimelineItem): string {
  if (item.type === "step") {
    return (item.kind === "agent:Reply" || item.kind === "agent:Compaction") &&
      item.draftId
      ? `step:draft:${item.draftId}`
      : `step:${item.step}`;
  }
  if (item.type === "input") return `input:${item.requestId}`;
  if (item.type === "input-response")
    return `input-response:${item.responseId}`;
  if (item.type === "log") return `log:${item.id}`;
  if (item.type === "trail") return `trail:${item.id}`;
  if (item.type === "memory-diff") return `memory-diff:${item.id}`;
  if (item.type === "task-diff") return `task-diff:${item.id}`;
  if (item.type === "blob-add") return `blob-add:${item.id}`;
  return `file-diff:${item.id}`;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(bo, key)) return false;
    if (!deepEqual(ao[key], bo[key])) return false;
  }
  return true;
}

export function timelineItemEqual(a: TimelineItem, b: TimelineItem): boolean {
  // Reuse the previous object when the server-rendered row is unchanged so
  // Solid signals don't churn. A generic structural compare keeps this honest
  // as TimelineItem grows new fields.
  return deepEqual(a, b);
}

export function preserveTimelineItems(
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

export function sortTimelineItems(items: TimelineItem[]): TimelineItem[] {
  return [...items].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

export function trimTimelineRows(
  items: TimelineItem[],
  options: TimelineRowCompactionOptions,
): TimelineItem[] {
  const max =
    Math.max(options.limit, options.minimumLimit ?? 1) +
    (options.liveSlack ?? 0);
  if (items.length <= max) return items;
  return sortTimelineItems(items).slice(-max);
}

export function rememberTimelineKeys(
  items: TimelineItem[],
  options: TimelineRowCompactionOptions,
): void {
  const remembered = options.rememberedKeys;
  const maxRemembered = options.maxRememberedKeys;
  if (!remembered || !maxRemembered || maxRemembered <= 0) return;
  const nowMs = options.nowMs ?? Date.now;
  for (const item of items)
    remembered.set(timelineItemKey(item), item.at ?? nowMs());
  if (remembered.size <= maxRemembered) return;
  const keep = [...remembered.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxRemembered);
  remembered.clear();
  for (const [key, at] of keep) remembered.set(key, at);
}

export function compactTimelineRows(
  items: TimelineItem[],
  options: TimelineRowCompactionOptions,
): TimelineItem[] {
  const trimmed = trimTimelineRows(
    items.filter(shouldShowTimelineItem),
    options,
  );
  rememberTimelineKeys(trimmed, options);
  return trimmed;
}

export function dedupeTimelineRows(items: TimelineItem[]): TimelineItem[] {
  const byKey = new Map<string, TimelineItem>();
  for (const item of items) byKey.set(timelineItemKey(item), item);
  return sortTimelineItems([...byKey.values()]);
}

export function reconcileOptimisticStepId(
  items: TimelineItem[],
  optimisticStepId: string,
  stepId: string,
): TimelineItem[] {
  const confirmed = items.some(
    (item) => item.type === "step" && item.step === stepId,
  );
  let changed = false;
  const next = items.flatMap((item) => {
    if (item.type !== "step" || item.step !== optimisticStepId) return [item];
    changed = true;
    return confirmed ? [] : [{ ...item, step: stepId } as TimelineItem];
  });
  return changed ? dedupeTimelineRows(next) : items;
}

function isUserInputStep(item: TimelineItem): item is StepTimelineItem {
  return item.type === "step" && item.kind === "agent:UserInput";
}

function isOptimisticStep(item: TimelineItem): item is StepTimelineItem {
  return item.type === "step" && item.step.startsWith("opt-");
}

function isLiveClientOnlyStep(item: TimelineItem): item is StepTimelineItem {
  return (
    item.type === "step" &&
    item.status === "agent:Queued" &&
    (item.kind === "agent:RunTS" || item.kind === "agent:RunJS")
  );
}

export function withoutConfirmedOptimisticRows(
  server: TimelineItem[],
  current: TimelineItem[],
): TimelineItem[] {
  const remaining = new Map<string, number>();
  for (const item of server) {
    if (isUserInputStep(item)) {
      remaining.set(item.text, (remaining.get(item.text) ?? 0) + 1);
    }
  }
  return current.filter((item) => {
    if (!isOptimisticStep(item)) return true;
    const count = remaining.get(item.text) ?? 0;
    if (count <= 0) return true;
    remaining.set(item.text, count - 1);
    return false;
  });
}

export function mergeTimelineUpdateRows(
  server: TimelineItem[],
  current: TimelineItem[],
  options: TimelineRowCompactionOptions,
): TimelineItem[] {
  return compactTimelineRows(
    dedupeTimelineRows([
      ...withoutConfirmedOptimisticRows(server, current),
      ...preserveTimelineItems(server, current),
    ]),
    options,
  );
}

export function mergeTimelineRows(
  server: TimelineItem[],
  current: TimelineItem[],
  options: TimelineRowCompactionOptions,
): TimelineItem[] {
  const stableServer = preserveTimelineItems(server, current);
  const stableServerKeys = new Set(stableServer.map(timelineItemKey));
  const liveClientOnly = current.filter(
    (item) =>
      isLiveClientOnlyStep(item) &&
      !stableServerKeys.has(timelineItemKey(item)),
  );
  const opts = current.filter(isOptimisticStep);
  if (opts.length === 0 && liveClientOnly.length === 0)
    return compactTimelineRows(stableServer, options);
  const remaining = new Map<string, number>();
  for (const it of stableServer) {
    if (isUserInputStep(it)) {
      remaining.set(it.text, (remaining.get(it.text) ?? 0) + 1);
    }
  }
  const survivors: TimelineItem[] = [];
  for (const opt of opts) {
    const n = remaining.get(opt.text) ?? 0;
    if (n > 0) {
      remaining.set(opt.text, n - 1);
    } else {
      survivors.push(opt);
    }
  }
  const clientOnly = [...liveClientOnly, ...survivors];
  if (clientOnly.length === 0)
    return compactTimelineRows(stableServer, options);
  return compactTimelineRows(
    sortTimelineItems([...stableServer, ...clientOnly]),
    options,
  );
}
