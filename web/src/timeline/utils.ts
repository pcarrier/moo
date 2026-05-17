import type { DismissedReply } from "../state";
import type { StepItem, TimelineItem } from "../api";

export type DismissedTimelineEntry =
  | { kind: "draft"; reply: DismissedReply }
  | { kind: "item"; item: StepItem };

export type TimelineRenderEntry =
  | { kind: "item"; item: TimelineItem }
  | { kind: "thought"; item: StepItem }
  | {
      kind: "dismissed";
      id: string;
      at: number;
      entries: DismissedTimelineEntry[];
    };

export function timelineTypeOrder(item: TimelineItem): number {
  switch (item.type) {
    case "input":
      return 10;
    case "input-response":
      return 20;
    case "step":
      return 30;
    case "log":
      return 40;
    case "trail":
      return 50;
    case "file-diff":
    case "todo-diff":
    case "blob-add":
    case "memory-diff":
      return 60;
    default:
      return 100;
  }
}

export function compareTimelineItems(a: TimelineItem, b: TimelineItem): number {
  return (
    (a.at ?? 0) - (b.at ?? 0) || timelineTypeOrder(a) - timelineTypeOrder(b)
  );
}

export function insertTimelineItemChronologically(
  rows: TimelineItem[],
  item: TimelineItem,
): TimelineItem[] {
  const next = rows.slice();
  const index = next.findIndex((row) => compareTimelineItems(item, row) < 0);
  if (index < 0) next.push(item);
  else next.splice(index, 0, item);
  return next;
}

export function timelineExpansionKey(item: TimelineItem): string {
  if (item.type === "step") return `step:${item.step}`;
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

export function replyDraftKey(item: TimelineItem): string | null {
  if (item.type !== "step") return null;
  return (item.kind === "agent:Reply" || item.kind === "agent:Compaction") &&
    item.draftId
    ? `step:draft:${item.draftId}`
    : null;
}

export function timelineItemKey(item: TimelineItem): string {
  if (item.type === "step") return replyDraftKey(item) ?? `step:${item.step}`;
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

export function timelineThoughtKey(item: StepItem): string {
  return `thought:${replyDraftKey(item) ?? `step:${item.step}`}`;
}

export function timelineAnchorKey(item: TimelineItem): string {
  if (item.type === "step") return `step:${item.step}`;
  return timelineItemKey(item);
}

export function timelineJumpKeys(item: TimelineItem): string[] {
  const keys = [timelineAnchorKey(item)];
  if (hasReplyReasoning(item)) keys.push(timelineThoughtKey(item));
  const renderKey = timelineItemKey(item);
  if (!keys.includes(renderKey)) keys.push(renderKey);
  if (
    (item.type === "file-diff" ||
      item.type === "memory-diff" ||
      item.type === "todo-diff" ||
      item.type === "blob-add") &&
    item.step
  ) {
    keys.push(`step:${item.step}`);
  }
  return keys;
}

export function isCancelledTimelineItem(item: TimelineItem): item is StepItem {
  return item.type === "step" && item.status === "agent:Cancelled";
}

export function dismissedTimelineEntryKey(
  entry: DismissedTimelineEntry,
): string {
  if (entry.kind === "draft") return `draft:${entry.reply.id}`;
  return timelineItemKey(entry.item);
}

export function dismissedTimelineEntryAt(
  entry: DismissedTimelineEntry,
): number {
  return entry.kind === "draft" ? entry.reply.at : entry.item.at;
}

export function sameDismissedTimelineEntries(
  a: DismissedTimelineEntry[],
  b: DismissedTimelineEntry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.kind !== right.kind) return false;
    if (left.kind === "draft" && right.kind === "draft") {
      if (left.reply !== right.reply) return false;
    } else if (left.kind === "item" && right.kind === "item") {
      if (left.item !== right.item) return false;
    } else {
      return false;
    }
  }
  return true;
}

export function timelineRenderEntries(
  items: TimelineItem[],
  dismissedReplies: DismissedReply[],
  cache?: Map<string, TimelineRenderEntry>,
): TimelineRenderEntry[] {
  const rows: Array<
    | { bucket: "item"; at: number; order: number; item: TimelineItem }
    | {
        bucket: "dismissed";
        at: number;
        order: number;
        entry: DismissedTimelineEntry;
      }
  > = [];

  items.forEach((item, order) => {
    const at = Number(item.at) || 0;
    if (isCancelledTimelineItem(item)) {
      rows.push({
        bucket: "dismissed",
        at,
        order,
        entry: { kind: "item", item },
      });
    } else {
      rows.push({ bucket: "item", at, order, item });
    }
  });

  dismissedReplies.forEach((reply, index) => {
    rows.push({
      bucket: "dismissed",
      at: Number(reply.at) || Date.now(),
      order: items.length + index,
      entry: { kind: "draft", reply },
    });
  });

  rows.sort((a, b) => a.at - b.at || a.order - b.order);

  const rendered: TimelineRenderEntry[] = [];
  let dismissed: DismissedTimelineEntry[] = [];
  const flushDismissed = () => {
    if (dismissed.length === 0) return;
    const first = dismissed[0]!;
    const id = `dismissed:${dismissed.map(dismissedTimelineEntryKey).join(":")}`;
    const at = dismissedTimelineEntryAt(first);
    const previous = cache?.get(id);
    if (
      previous?.kind === "dismissed" &&
      previous.at === at &&
      sameDismissedTimelineEntries(previous.entries, dismissed)
    ) {
      rendered.push(previous);
    } else {
      rendered.push({
        kind: "dismissed",
        id,
        at,
        entries: dismissed,
      });
    }
    dismissed = [];
  };

  for (const row of rows) {
    if (row.bucket === "dismissed") {
      dismissed.push(row.entry);
    } else {
      flushDismissed();
      if (hasReplyReasoning(row.item)) {
        const thoughtKey = timelineThoughtKey(row.item);
        const previousThought = cache?.get(thoughtKey);
        rendered.push(
          previousThought?.kind === "thought" &&
            previousThought.item === row.item
            ? previousThought
            : { kind: "thought", item: row.item },
        );
      }
      const key = timelineItemKey(row.item);
      const previous = cache?.get(key);
      rendered.push(
        previous?.kind === "item" && previous.item === row.item
          ? previous
          : { kind: "item", item: row.item },
      );
    }
  }
  flushDismissed();
  if (cache) {
    cache.clear();
    for (const entry of rendered) {
      const key =
        entry.kind === "dismissed"
          ? entry.id
          : entry.kind === "thought"
            ? timelineThoughtKey(entry.item)
            : timelineItemKey(entry.item);
      cache.set(key, entry);
    }
  }
  return rendered;
}

function hasReplyReasoning(item: TimelineItem): item is StepItem {
  return (
    item.type === "step" &&
    item.kind === "agent:Reply" &&
    !!item.reasoningContent?.trim()
  );
}

export function formatThoughtDuration(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}m ${remaining}s`;
}

export function isTerminalStepStatus(status: string | undefined): boolean {
  return (
    status === "agent:Done" ||
    status === "agent:Failed" ||
    status === "agent:Cancelled"
  );
}

export function isRunningTimelineItem(item: TimelineItem): boolean {
  return item.type === "step" && !isTerminalStepStatus(item.status);
}

export function isRunningToolTimelineItem(item: TimelineItem): boolean {
  return (
    item.type === "step" &&
    item.kind === "agent:ToolCall" &&
    isRunningTimelineItem(item)
  );
}

export function latestTerminalReplySettlesActiveTurn(
  items: TimelineItem[],
  activeStartedAt: number | null | undefined,
): boolean {
  const startedAt = Number(activeStartedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return false;
  const latest = items[items.length - 1];
  return (
    latest?.type === "step" &&
    latest.kind === "agent:Reply" &&
    isTerminalStepStatus(latest.status) &&
    Number(latest.at) >= startedAt
  );
}

export function formatThinkingElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
