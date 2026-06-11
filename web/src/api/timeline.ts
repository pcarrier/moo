import type { ChatId, ChoiceSpec, FormSpec, ImageAttachment, StepId } from "./types";

export type SubagentDetails = {
  label?: string | null;
  task?: string | null;
  childChatId?: string | null;
  parentRunTsStepId?: string | null;
  parentRunJsStepId?: string | null;
  result?: {
    status?: string;
    childChatId?: string;
    text?: string;
    error?: string | null;
    durationNs?: number;
    usage?: unknown;
  } | null;
};

export type RunTSDetails = {
  label?: string | null;
  description?: string | null;
  args?: unknown;
  code?: string | null;
  backgroundAfterNs?: number;
  result?: string | null;
  error?: string | null;
  durationNs?: number;
};

export type StepItem = {
  type: "step";
  step: StepId;
  kind: string;
  status: string;
  at: number;
  updatedAt?: number;
  text: string;
  error?: {
    kind?: string;
    detail?: {
      source?: string;
      status?: number | string;
      message?: string;
      type?: string | null;
      code?: string | null;
      requestId?: string | null;
      retryAfter?: string | null;
      hint?: string | null;
      body?: unknown;
      [key: string]: unknown;
    };
    at?: number | string;
  };
  runts?: RunTSDetails;
  /** Legacy timeline payloads before the runTS rename. */
  runjs?: RunTSDetails;
  lazyRuntsResult?: boolean;
  lazyRunjsResult?: boolean;
  resultHash?: string | null;
  subagent?: SubagentDetails;
  compaction?: {
    promptTokens?: number | null;
    postPromptTokens?: number | null;
    summaryTokens?: number | null;
    tokenBudget?: number | null;
    tokenThreshold?: number | null;
    availableTokens?: number | null;
    compactionsInARow?: number | null;
  };
  attachments?: ImageAttachment[];
  // Provider-echoed model that produced the step (for LLM-driven kinds).
  model?: string;
  // Reasoning/thinking effort used for the step, when applicable.
  effort?: string;
  // Nanoseconds spent waiting on model responses for the final reply.
  thoughtDurationNs?: number;
  // Streaming draft id that produced this finalized reply, when available.
  draftId?: string;
  // Reasoning/thinking streamed before the final reply content, when available.
  reasoningContent?: string;
  // True while the reasoning/thinking stream itself is still receiving deltas.
  reasoningStreaming?: boolean;
  // Present when a user message is hidden from future LLM prompts.
  deletedAt?: number | string;
};

export type InputItem = {
  type: "input";
  requestId: string;
  kind: "ui:Form" | "ui:Choice";
  status: "ui:Pending" | "ui:Done" | "ui:Cancelled";
  at: number;
  spec: FormSpec | ChoiceSpec | null;
  response: { values: Record<string, unknown>; at: number; cancelled?: boolean } | null;
};

export type InputResponseItem = {
  type: "input-response";
  responseId: string;
  requestId: string;
  kind: "ui:Form" | "ui:Choice";
  at: number;
  spec: FormSpec | ChoiceSpec | null;
  response: { values: Record<string, unknown>; at: number; cancelled?: boolean };
};

export type DiffStats = { added: number; removed: number; lines: number };

export type MemoryFactChange = { subject: string; predicate: string; object: string };

export type FileDiffItem = {
  type: "file-diff";
  id: string;
  step?: string;
  chatId: ChatId;
  path: string;
  diff: string;
  stats?: DiffStats;
  before?: string | null;
  after?: string | null;
  hash?: string;
  at: number;
};

export type TaskStatus = "todo" | "doing" | "done" | "blocked" | "dropped";
export type AgentTask = {
  id: string;
  text: string;
  status: TaskStatus;
  note?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type TaskDiffChange =
  | { kind: "added"; after: AgentTask }
  | { kind: "removed"; before: AgentTask }
  | { kind: "updated"; before: AgentTask; after: AgentTask; fields?: string[] };

export type TaskDiffItem = {
  type: "task-diff";
  id: string;
  step?: string;
  chatId: string;
  changes?: TaskDiffChange[];
  tasks?: AgentTask[];
  hash?: string;
  at: number;
};

export type MemoryDiffItem = {
  type: "memory-diff";
  id: string;
  step?: string;
  chatId: ChatId;
  store: string;
  graph: string;
  action?: "assert" | "retract";
  count?: number;
  changes?: MemoryFactChange[];
  path: string;
  diff: string;
  stats?: DiffStats;
  before?: string;
  after?: string;
  hash?: string;
  at: number;
};

export type LogItem = {
  type: "log";
  id: string;
  at: number;
  message: string;
};

export type BlobAddItem = {
  type: "blob-add";
  id: string;
  step?: string;
  chatId: ChatId;
  objectKind: string;
  hash: string;
  size?: number;
  chars?: number;
  encoding?: "text" | "json" | string;
  at: number;
};

export type TrailItem = {
  type: "trail";
  id: string;
  kind: string;
  at: number;
  title?: string | null;
  body?: string | null;
  summary?: string | null;
};

export type TimelineItem = StepItem | InputItem | InputResponseItem | FileDiffItem | TaskDiffItem | MemoryDiffItem | BlobAddItem | LogItem | TrailItem;

