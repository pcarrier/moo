import { callCommand } from "./contract";
import type { ApiCommand, ApiCommandReq, ApiCommandResult } from "./contract";
import { optional } from "./utils";
import type {
  ChatAutocompleteSuggestion,
  ChatId,
  ChatModelInfo,
  ChatSummary,
  CompactionsValue,
  DescribeValue,
  ImageAttachment,
  StepId,
} from "./types";

export type ChatCommands =
  | ApiCommand<"describe", { chatId: ChatId; limit?: number }, DescribeValue>
  | ApiCommand<"compactions", { chatId: ChatId }, CompactionsValue>
  | ApiCommand<"step", { chatId: ChatId; message: string; attachments?: ImageAttachment[] }, { chatId: ChatId; userStepId: StepId }>
  | ApiCommand<"interrupt", { chatId: ChatId }, { chatId: ChatId; aborted: boolean }>
  | ApiCommand<"submit", { chatId: ChatId; requestId: string; values?: Record<string, unknown>; cancelled?: true }, { chatId: ChatId; requestId: string; kind: string }>
  | ApiCommand<"chats", Record<string, never>, { chats: ChatSummary[]; homeDir: string | null }>
  | ApiCommand<"chat-autocomplete", { query: string; limit?: number }, { suggestions: ChatAutocompleteSuggestion[] }>
  | ApiCommand<"chat-new", { chatId?: ChatId; path?: string; model?: string | null; effort?: string | null }, { chatId: ChatId; path?: string | null; worktreePath?: string | null; recent?: string[] }>
  | ApiCommand<"chat-recent-paths", Record<string, never>, { paths: string[] }>
  | ApiCommand<"chat-rm", { chatId: ChatId }, { chatId: ChatId; refsDeleted: number; quadsCleared: number }>
  | ApiCommand<"chat-fork", { chatId: ChatId; step: StepId; forkChatId?: ChatId }, { chatId: ChatId; sourceChatId: ChatId; forkedFromStep: StepId; forkedFromAt: number; path?: string | null; copiedFacts: number }>
  | ApiCommand<"chat-rename", { chatId: ChatId; title: string | null }, { chatId: ChatId; title: string | null }>
  | ApiCommand<"chat-archive", { chatId: ChatId; archived: boolean }, { chatId: ChatId; archived: boolean; archivedAt: number | null }>
  | ApiCommand<"chat-export", { chatId: ChatId }, { chatId: ChatId; url: string; bytes: number }>
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
  describe: (chatId: ChatId, limit?: number) =>
    callCommand("describe", { chatId, ...optional({ limit }) }),
  compactions: (chatId: ChatId) =>
    callCommand("compactions", { chatId }),
  step: (chatId: ChatId, message: string, attachments: ImageAttachment[] = []) =>
    callCommand("step", {
      chatId,
      message,
      ...(attachments.length ? { attachments } : {}),
    }),
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
  recentPaths: () => callCommand("chat-recent-paths", {}),
  remove: (chatId: ChatId) =>
    callCommand("chat-rm", { chatId }),
  rename: (chatId: ChatId, title: string | null) =>
    callCommand("chat-rename", { chatId, title }),
  fork: (chatId: ChatId, step: StepId) =>
    callCommand("chat-fork", { chatId, step }),
  archive: (chatId: ChatId, archived: boolean) =>
    callCommand("chat-archive", { chatId, archived }),
  export: (chatId: ChatId) =>
    callCommand("chat-export", { chatId }),
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
