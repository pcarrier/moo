import { callCommand } from "./contract";
import type { ApiCommand } from "./contract";
import type { TraceEventRow, TraceRow, TraceSearchArgs, TraceSummary } from "./types";

export type TraceCommands =
  | ApiCommand<"trace-chats", { limit?: number; beforeMs?: number }, { chats: TraceRow[] }>
  | ApiCommand<"trace-node", { id: string }, { node: TraceRow; children: TraceRow[]; ancestors: TraceRow[]; events: TraceEventRow[] }>
  | ApiCommand<"trace-subtree", { id: string; maxDepth?: number }, { nodes: TraceRow[] }>
  | ApiCommand<"trace-events", { spanId: string; limit?: number; beforeMs?: number }, { events: TraceEventRow[] }>
  | ApiCommand<"trace-search", TraceSearchArgs, { hits: { node: TraceRow; ancestors: TraceRow[] }[] }>
  | ApiCommand<"trace-failed", { chatId?: string; limit?: number; beforeMs?: number }, { failures: { node: TraceRow; ancestors: TraceRow[] }[] }>
  | ApiCommand<"trace-summary", { id: string }, TraceSummary>
  | ApiCommand<"trace-chat-tree", { chatId: string; maxDepth?: number }, { root: TraceRow | null; nodes: TraceRow[] }>;

export const tracesApi = {
  chats: (args: { limit?: number; beforeMs?: number } = {}) => callCommand("trace-chats", args),
  node: (args: { id: string }) => callCommand("trace-node", args),
  subtree: (args: { id: string; maxDepth?: number }) => callCommand("trace-subtree", args),
  events: (args: { spanId: string; limit?: number; beforeMs?: number } = {}) => callCommand("trace-events", args),
  search: (args: TraceSearchArgs = {}) => callCommand("trace-search", args),
  failed: (args: { chatId?: string; limit?: number; beforeMs?: number } = {}) => callCommand("trace-failed", args),
  summary: (args: { id: string }) => callCommand("trace-summary", args),
  chatTree: (args: { chatId: string; maxDepth?: number }) => callCommand("trace-chat-tree", args),
};
