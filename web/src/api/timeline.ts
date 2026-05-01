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
    durationMs?: number;
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
  durationMs?: number;
};

export type StepItem = {
  type: "step";
  step: StepId;
  kind: string;
  status: string;
  at: number;
  text: string;
  error?: {
    kind?: string;
    detail?: {
      source?: string;
      status?: number | string;
      message?: string;
      type?: string | null;
      code?: string | null;
      body?: unknown;
      [key: string]: unknown;
    };
    at?: number | string;
  };
  runjs?: RunJSDetails;
  subagent?: SubagentDetails;
  attachments?: ImageAttachment[];
  // Provider-echoed model that produced the step (for LLM-driven kinds).
  model?: string;
  // Reasoning/thinking effort used for the step, when applicable.
  effort?: string;
  // Milliseconds spent waiting on model responses for the final reply.
  thoughtDurationMs?: number;
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

export type MemoryDiffItem = {
  type: "memory-diff";
  id: string;
  step?: string;
  chatId: ChatId;
  refName: string;
  graph: string;
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

export type TrailItem = {
  type: "trail";
  id: string;
  kind: string;
  at: number;
  title?: string | null;
  previousTitle?: string | null;
  body?: string | null;
  summary?: string | null;
};

export type TimelineItem = StepItem | InputItem | InputResponseItem | FileDiffItem | MemoryDiffItem | LogItem | TrailItem;

