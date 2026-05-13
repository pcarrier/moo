import type { ApiCommand } from "./contract";
import type { TraceConfig, TraceConfigTestValue, TraceRow, TraceSearchArgs, TraceSettingsValue } from "./types";

export type TraceCommands =
  | ApiCommand<"trace-frontend", { id?: string; name: string; startedNs: number; endedNs: number; status: "ok" | "error" | "cancelled" | "timeout"; route?: string; error?: string; rpcDurationNs?: number }, { id: string }>
  | ApiCommand<"trace-chats", { limit?: number; beforeNs?: number }, { chats: TraceRow[] }>
  | ApiCommand<"trace-roots", TraceSearchArgs, { roots: TraceRow[] }>
  | ApiCommand<"trace-node", { id: string }, { node: TraceRow; children: TraceRow[]; ancestors: TraceRow[]; root?: TraceRow | null }>
  | ApiCommand<"trace-subtree", { id: string; maxDepth?: number }, { root?: TraceRow | null; nodes: TraceRow[] }>
  | ApiCommand<"trace-search", TraceSearchArgs, { hits: { node: TraceRow; ancestors: TraceRow[]; root?: TraceRow | null }[] }>
  | ApiCommand<"trace-failed", TraceSearchArgs, { failures: { node: TraceRow; ancestors: TraceRow[]; root?: TraceRow | null }[] }>
  | ApiCommand<"trace-chat-tree", { chatId: string; maxDepth?: number }, { root: TraceRow | null; nodes: TraceRow[] }>
  | ApiCommand<"trace-config-get", Record<string, never>, TraceSettingsValue>
  | ApiCommand<"trace-config-save", { config: TraceConfig }, TraceSettingsValue>
  | ApiCommand<"trace-config-test", { config: TraceConfig }, TraceConfigTestValue>;
