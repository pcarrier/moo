import type { ChatId, ChoiceSpec, FormSpec, ImageAttachment, StepId } from "./types";

export type SubagentDetails = {
  label?: string | null;
  task?: string | null;
  childChatId?: string | null;
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

export type RunJSDetails = {
  label?: string | null;
  description?: string | null;
  args?: unknown;
  code?: string | null;
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
  runjs?: RunJSDetails;
  lazyRunjsResult?: boolean;
  resultHash?: string | null;
  subagent?: SubagentDetails;
  attachments?: ImageAttachment[];
  // Provider-echoed model that produced the step (for LLM-driven kinds).
  model?: string;
  // Reasoning/thinking effort used for the step, when applicable.
  effort?: string;
  // Nanoseconds spent waiting on model responses for the final reply.
  thoughtDurationNs?: number;
  // Streaming draft id that produced this finalized reply, when available.
  draftId?: string;
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

export type TodoStatus = "todo" | "doing" | "done" | "blocked" | "dropped";
export type AgentTodo = {
  id: string;
  text: string;
  status: TodoStatus;
  note?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type TodoDiffChange =
  | { kind: "added"; after: AgentTodo }
  | { kind: "removed"; before: AgentTodo }
  | { kind: "updated"; before: AgentTodo; after: AgentTodo; fields?: string[] };

export type TodoDiffItem = {
  type: "todo-diff";
  id: string;
  step?: string;
  chatId: string;
  changes?: TodoDiffChange[];
  todos?: AgentTodo[];
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

export type TimelineItem = StepItem | InputItem | InputResponseItem | FileDiffItem | TodoDiffItem | MemoryDiffItem | BlobAddItem | LogItem | TrailItem;

