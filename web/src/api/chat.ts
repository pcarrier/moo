import { callCommand } from "./contract";
import type { ApiCommand, ApiCommandReq, ApiCommandResult } from "./contract";
import type { ApiResult } from "./transport";
import { optional } from "./utils";
import type {
  ChatAutocompleteSuggestion,
  ChatId,
  ChatModelInfo,
  ChatSummary,
  CompactionsValue,
  DescribeSnapshotValue,
  DescribeUpdateValue,
  DescribeValue,
  ImageAttachment,
  StepId,
  RepoKind,
} from "./types";

export type PendingMessage = { id: string; chatId: ChatId; text: string; attachments?: ImageAttachment[] };

export type ChatCommands =
  | ApiCommand<"describe", { chatId: ChatId; mode: "snapshot"; limit?: number } | { chatId: ChatId; mode: "update"; limit?: number; sinceAt?: number; knownHead?: string | null; knownTotalTimelineItems?: number; knownCompaction?: string | null }, DescribeValue>
  | ApiCommand<"compactions", { chatId: ChatId }, CompactionsValue>
  | ApiCommand<"step", { chatId: ChatId; message: string; attachments?: ImageAttachment[] }, { chatId: ChatId; userStepId: StepId }>
  | ApiCommand<"pending-messages", Record<string, never>, { messages: PendingMessage[] }>
  | ApiCommand<"pending-messages-save", { messages: PendingMessage[] }, { messages: PendingMessage[] }>
  | ApiCommand<"compact", { chatId: ChatId }, { chatId: ChatId; accepted: boolean }>
  | ApiCommand<"resume", { chatId: ChatId }, { chatId: ChatId; accepted: boolean }>
  | ApiCommand<"interrupt", { chatId: ChatId }, { chatId: ChatId; aborted: boolean }>
  | ApiCommand<"submit", { chatId: ChatId; requestId: string; values?: Record<string, unknown>; cancelled?: true }, { chatId: ChatId; requestId: string; kind: string }>
  | ApiCommand<"chats", Record<string, never>, { chats: ChatSummary[]; homeDir: string | null }>
  | ApiCommand<"chat-autocomplete", { query: string; limit?: number }, { suggestions: ChatAutocompleteSuggestion[] }>
  | ApiCommand<"chat-new", { chatId?: ChatId; path?: string; branch?: string | null; model?: string | null; effort?: string | null }, { chatId: ChatId; path?: string | null; branch?: string | null; worktreePath?: string | null; recent?: string[] }>
  | ApiCommand<"chat-recent-paths", { includeRepos?: boolean }, { paths: string[]; repos?: Array<{ path: string; repoKind: RepoKind }> }>
  | ApiCommand<"chat-rm", { chatId: ChatId }, { chatId: ChatId; refsDeleted: number; quadsCleared: number }>
  | ApiCommand<"chat-fork", { chatId: ChatId; step: StepId; forkChatId?: ChatId }, { chatId: ChatId; sourceChatId: ChatId; forkedFromStep: StepId; forkedFromAt: number; path?: string | null; worktreePath?: string | null; copiedFacts: number }>
  | ApiCommand<"chat-rename", { chatId: ChatId; title: string | null }, { chatId: ChatId; title: string | null }>
  | ApiCommand<"chat-archive", { chatId: ChatId; archived: boolean }, { chatId: ChatId; archived: boolean; archivedAt: number | null }>
  | ApiCommand<"chat-models", { chatId: ChatId }, ChatModelInfo>
  | ApiCommand<"chat-settings", { chatIds: ChatId[] }, { settings: Record<string, { effort: string | null }> }>
  | ApiCommand<"chat-model-set", { chatId: ChatId; model: string | null }, ChatModelInfo>
  | ApiCommand<"chat-effort-set", { chatId: ChatId; effort: string | null }, ChatModelInfo>
  | ApiCommand<"message-delete", { chatId: ChatId; step: StepId }, { chatId: ChatId; step: StepId; deletedAt: number | string }>
  | ApiCommand<"message-restore", { chatId: ChatId; step: StepId }, { chatId: ChatId; step: StepId; deletedAt: null }>;

function newChat(params: ApiCommandReq<"chat-new"> = {}): ApiCommandResult<"chat-new"> {
  return callCommand("chat-new", params);
}

export const chatApi = {
  describeSnapshot: (chatId: ChatId, limit?: number): Promise<ApiResult<DescribeSnapshotValue>> =>
    callCommand("describe", { chatId, mode: "snapshot", ...optional({ limit }) }) as Promise<ApiResult<DescribeSnapshotValue>>,
  describeUpdate: (chatId: ChatId, input: { limit?: number; sinceAt?: number; knownHead?: string | null; knownTotalTimelineItems?: number; knownCompaction?: string | null } = {}): Promise<ApiResult<DescribeUpdateValue>> =>
    callCommand("describe", { chatId, mode: "update", ...optional(input) }) as Promise<ApiResult<DescribeUpdateValue>>,
  compactions: (chatId: ChatId) =>
    callCommand("compactions", { chatId }),
  step: (chatId: ChatId, message: string, attachments: ImageAttachment[] = []) =>
    callCommand("step", {
      chatId,
      message,
      ...(attachments.length ? { attachments } : {}),
    }),
  pendingMessages: () => callCommand("pending-messages", {}),
  savePendingMessages: (messages: PendingMessage[]) =>
    callCommand("pending-messages-save", { messages }),
  compact: (chatId: ChatId) => callCommand("compact", { chatId }),
  resume: (chatId: ChatId) =>
    callCommand("resume", { chatId }),
  interrupt: (chatId: ChatId) =>
    callCommand("interrupt", { chatId }),
  submit: (chatId: ChatId, requestId: string, values: Record<string, unknown>) =>
    callCommand("submit", { chatId, requestId, values }),
  cancel: (chatId: ChatId, requestId: string) =>
    callCommand("submit", { chatId, requestId, cancelled: true }),
  list: () => callCommand("chats", {}),
  autocomplete: (query: string, limit = 12) =>
    callCommand("chat-autocomplete", { query, limit }),
  new: newChat,
  recentPaths: (includeRepos = false) => callCommand("chat-recent-paths", { ...(includeRepos ? { includeRepos } : {}) }),
  remove: (chatId: ChatId) =>
    callCommand("chat-rm", { chatId }),
  rename: (chatId: ChatId, title: string | null) =>
    callCommand("chat-rename", { chatId, title }),
  fork: (chatId: ChatId, step: StepId, forkChatId?: ChatId) =>
    callCommand("chat-fork", {
      chatId,
      step,
      ...(forkChatId ? { forkChatId } : {}),
    }),
  archive: (chatId: ChatId, archived: boolean) =>
    callCommand("chat-archive", { chatId, archived }),
  models: (chatId: ChatId) =>
    callCommand("chat-models", { chatId }),
  settings: (chatIds: ChatId[]) =>
    callCommand("chat-settings", { chatIds }),
  setModel: (chatId: ChatId, model: string | null) =>
    callCommand("chat-model-set", { chatId, model }),
  setEffort: (chatId: ChatId, effort: string | null) =>
    callCommand("chat-effort-set", { chatId, effort }),
  deleteMessage: (chatId: ChatId, step: StepId) =>
    callCommand("message-delete", { chatId, step }),
  restoreMessage: (chatId: ChatId, step: StepId) =>
    callCommand("message-restore", { chatId, step }),
};
