import { callCommand } from "./contract";
import type { ApiCommand } from "./contract";
import type { TraceConfig, TraceConfigTestValue, TraceRow, TraceSearchArgs, TraceSettingsValue } from "./types";

export type TraceCommands =
  | ApiCommand<"trace-frontend", { name: string; startedNs: number; endedNs: number; status: "ok" | "error" | "cancelled" | "timeout"; route?: string; error?: string; rpcDurationMs?: number }, { id: string }>
  | ApiCommand<"trace-chats", { limit?: number; beforeNs?: number }, { chats: TraceRow[] }>
  | ApiCommand<"trace-roots", TraceSearchArgs, { roots: TraceRow[] }>
  | ApiCommand<"trace-node", { id: string }, { node: TraceRow; children: TraceRow[]; ancestors: TraceRow[] }>
  | ApiCommand<"trace-subtree", { id: string; maxDepth?: number }, { nodes: TraceRow[] }>
  | ApiCommand<"trace-search", TraceSearchArgs, { hits: { node: TraceRow; ancestors: TraceRow[] }[] }>
  | ApiCommand<"trace-failed", TraceSearchArgs, { failures: { node: TraceRow; ancestors: TraceRow[] }[] }>
  | ApiCommand<"trace-chat-tree", { chatId: string; maxDepth?: number }, { root: TraceRow | null; nodes: TraceRow[] }>
  | ApiCommand<"trace-config-get", Record<string, never>, TraceSettingsValue>
  | ApiCommand<"trace-config-save", { config: TraceConfig }, TraceSettingsValue>
  | ApiCommand<"trace-config-test", { config: TraceConfig }, TraceConfigTestValue>;

export const tracesApi = {
  chats: (args: { limit?: number; beforeNs?: number } = {}) => callCommand("trace-chats", args),
  roots: (args: TraceSearchArgs = {}) => callCommand("trace-roots", args),
  node: (args: { id: string }) => callCommand("trace-node", args),
  subtree: (args: { id: string; maxDepth?: number }) => callCommand("trace-subtree", args),
  search: (args: TraceSearchArgs = {}) => callCommand("trace-search", args),
  failed: (args: TraceSearchArgs = {}) => callCommand("trace-failed", args),
  chatTree: (args: { chatId: string; maxDepth?: number }) => callCommand("trace-chat-tree", args),
  settings: () => callCommand("trace-config-get", {}),
  saveSettings: (config: TraceConfig) => callCommand("trace-config-save", { config }),
  testSettings: (config: TraceConfig) => callCommand("trace-config-test", { config }),
};
