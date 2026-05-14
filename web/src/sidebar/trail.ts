import type {
  StepItem,
  TimelineItem,
  TodoDiffChange,
  TodoDiffItem,
  TrailItem,
} from "../api";

export type AgentTrailItem = {
  id: string;
  at: number;
  title: string;
  timelineKey?: string;
  detail?: string;
  kind: string;
  tone?: "title" | "summary" | "todo" | "subagent";
  todoStatus?: "todo" | "doing" | "done" | "blocked" | "dropped";
  path?: string;
  targetChatId?: string;
  stats?: { added: number; removed: number };
  titleMarkdown?: boolean;
  detailMarkdown?: boolean;
};

export type AgentTrailSource = {
  trail: TimelineItem[];
  timeline: TimelineItem[];
};

export function trailSourceItems(source: AgentTrailSource): TimelineItem[] {
  const byKey = new Map<string, TimelineItem>();
  // `trail` can lag behind websocket-pushed timeline updates. Seed it first,
  // then let live timeline rows replace stale rows with the same key so TODO
  // trail entries refresh immediately.
  for (const item of source.trail) byKey.set(trailSourceKey(item), item);
  for (const item of source.timeline) byKey.set(trailSourceKey(item), item);
  return [...byKey.values()];
}

export function buildTrailItems(source: AgentTrailSource): AgentTrailItem[] {
  return trailSourceItems(source)
    .flatMap((item) => {
      if (item.type === "trail") return trailTimelineItem(item);
      if (item.type === "todo-diff") return todoTrailItems(item);
      if (item.type === "step" && item.kind === "agent:Subagent")
        return subagentTimelineItem(item);
      return null;
    })
    .filter((item): item is AgentTrailItem => item !== null)
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
}

export function trailSourceKey(item: TimelineItem): string {
  if (item.type === "step") return `step:${item.step}`;
  if (item.type === "input") return `input:${item.requestId}`;
  if (item.type === "input-response")
    return `input-response:${item.responseId}`;
  if (item.type === "log") return `log:${item.id}`;
  if (item.type === "trail") return `trail:${item.id}`;
  if (item.type === "todo-diff") return `todo-diff:${item.id}`;
  return `file-diff:${item.id}`;
}

export function trailTimelineItem(item: TrailItem): AgentTrailItem | null {
  if (item.kind === "agent:TitleUpdate") {
    const nextTitle = String(item.title || "").trim();
    return {
      id: item.id,
      at: item.at,
      title: nextTitle || "Untitled",
      timelineKey: `trail:${item.id}`,
      kind: item.kind,
      tone: "title",
    };
  }
  if (item.kind === "agent:Summary") {
    const title = String(item.title || "").trim() || "Agent summary";
    const detail = String(item.body || item.summary || "").trim();
    if (!detail && !title) return null;
    return {
      id: item.id,
      at: item.at,
      title,
      timelineKey: `trail:${item.id}`,
      detail,
      kind: item.kind,
      tone: "summary",
      titleMarkdown: true,
      detailMarkdown: true,
    };
  }
  return null;
}

export function subagentTimelineItem(item: StepItem): AgentTrailItem | null {
  const info = item.subagent || {};
  const label = String(info.label || "Subagent").trim() || "Subagent";
  const task = String(info.task || "").trim();
  const status = String(info.result?.status || item.status || "").replace(
    /^agent:/,
    "",
  );
  const childChatId = String(
    info.childChatId || info.result?.childChatId || "",
  ).trim();
  const duration =
    typeof info.result?.durationNs === "number"
      ? ` · ${formatTrailDuration(info.result.durationNs / 1_000_000)}`
      : "";
  const error = String(info.result?.error || "").trim();
  const detail = [
    status ? `${status}${duration}` : "",
    error ? `error: ${error}` : "",
    task,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    id: item.step,
    at: item.at,
    title: label,
    timelineKey: `step:${item.step}`,
    targetChatId: childChatId || undefined,
    detail,
    kind: item.kind,
    tone: "subagent",
  };
}

export function formatTrailDuration(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}m ${remaining}s`;
}

export function todoChangeTextForTrail(change: TodoDiffChange): string {
  const item = todoFromChange(change);
  if (item.status === "dropped") return "X";
  if (item.status === "blocked") return "!";
  if (item.status === "done") return "-";
  if (change.kind === "added") return "+";
  return "~";
}

export function todoFromChange(change: TodoDiffChange) {
  return change.kind === "removed" ? change.before : change.after;
}

export function previousTodoFromChange(change: TodoDiffChange) {
  return change.kind === "updated" ? change.before : undefined;
}

export function todoTrailItems(item: TodoDiffItem): AgentTrailItem[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return changes.map((change, index) => {
    const todo = todoFromChange(change);
    const previous = previousTodoFromChange(change);
    const action = todoChangeTextForTrail(change);
    const todoText = `${todo.id}. ${todo.text}`;
    const note = todo.note ? String(todo.note).trim() : "";
    const previousText =
      previous && previous.text !== todo.text
        ? `was: ${previous.id}. ${previous.text}`
        : "";
    const detail = [note, previousText].filter(Boolean).join("\n");
    return {
      id: changes.length === 1 ? item.id : `${item.id}:${index}`,
      at: item.at,
      title: `${action} ${todoText}`,
      timelineKey: `todo-diff:${item.id}`,
      kind: "todo-diff",
      tone: "todo",
      detail,
      titleMarkdown: true,
      detailMarkdown: true,
      todoStatus: todo.status,
    };
  });
}
