export type StepStatus = "running" | "done" | "error";

export type Role = "user" | "assistant" | "system" | "tool";

export type SharedTimelineKind =
  | "input"
  | "message"
  | "tool"
  | "runjs"
  | "diff"
  | "memory-diff"
  | "compact"
  | "trail";

export type TimelineItemBase = {
  id?: string;
  kind?: SharedTimelineKind | string;
  ts?: string | number | null;
};
