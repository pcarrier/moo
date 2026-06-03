import type { ApiCommand } from "./contract";
import type {
  ChatAutocompleteSuggestion,
  ChatId,
  ChatModelInfo,
  ChatSummary,
  CompactionsValue,
  DescribeUpdateValue,
  DescribeValue,
  ImageAttachment,
  StepId,
  RepoKind,
} from "./types";

export type PendingMessage = { id: string; chatId: ChatId; text: string; attachments?: ImageAttachment[] };

export type DescribeSnapshotReq = { chatId: ChatId; mode: "snapshot"; limit?: number };
export type DescribeUpdateReq = { chatId: ChatId; mode: "update"; limit?: number; sinceAt?: number; knownHead?: string | null; knownTotalTimelineItems?: number; knownCompaction?: string | null };

export type ChatCommands =
  | ApiCommand<"describe", DescribeSnapshotReq | DescribeUpdateReq, DescribeValue>
  | ApiCommand<"compactions", { chatId: ChatId }, CompactionsValue>
  | ApiCommand<"step", { chatId: ChatId; message: string; attachments?: ImageAttachment[] }, { chatId: ChatId; userStepId: StepId }>
  | ApiCommand<"pending-messages", Record<string, never>, { messages: PendingMessage[] }>
  | ApiCommand<"pending-messages-save", { messages: PendingMessage[] }, { messages: PendingMessage[] }>
  | ApiCommand<"compact", { chatId: ChatId }, { chatId: ChatId; accepted: boolean }>
  | ApiCommand<"resume", { chatId: ChatId }, { chatId: ChatId; accepted: boolean }>
  | ApiCommand<"interrupt", { chatId: ChatId }, { chatId: ChatId; aborted: boolean }>
  | ApiCommand<"run-ts-background", { chatId: ChatId; stepId?: StepId | null }, { chatId: ChatId; stepId: StepId | null; requested?: boolean }>
  | ApiCommand<"run-ts-cancel", { chatId: ChatId; stepId?: StepId | null }, { chatId: ChatId; stepId: StepId | null; cancelled?: number }>
  | ApiCommand<"run-ts-backgrounds", Record<string, never>, { jobs: Array<{ chatId: ChatId; stepId: StepId; label?: string | null; requestedBy?: string | null; startedAt?: number }> }>
  | ApiCommand<"submit", { chatId: ChatId; requestId: string; values?: Record<string, unknown>; cancelled?: true }, { chatId: ChatId; requestId: string; kind: string }>
  | ApiCommand<"chats", Record<string, never>, { chats: ChatSummary[]; homeDir: string | null }>
  | ApiCommand<"chat-autocomplete", { query: string; limit?: number }, { suggestions: ChatAutocompleteSuggestion[] }>
  | ApiCommand<"chat-new", { chatId?: ChatId; path?: string; branch?: string | null; useExistingWorktree?: boolean; model?: string | null; effort?: string | null }, { chatId: ChatId; path?: string | null; branch?: string | null; baseBranch?: string | null; worktreePath?: string | null; recent?: string[] }>
  | ApiCommand<"chat-recent-paths", { includeRepos?: boolean }, { paths: string[]; repos?: Array<{ path: string; repoKind: RepoKind }> }>
  | ApiCommand<"chat-remove-recent-path", { path: string }, { removed: boolean; paths: string[] }>
  | ApiCommand<"chat-rm", { chatId: ChatId }, { chatId: ChatId; refsDeleted: number; quadsCleared: number }>
  | ApiCommand<"chat-fork", { chatId: ChatId; step: StepId; forkChatId?: ChatId }, { chatId: ChatId; sourceChatId: ChatId; forkedFromStep: StepId; forkedFromAt: number; path?: string | null; baseBranch?: string | null; worktreePath?: string | null; copiedFacts: number }>
  | ApiCommand<"chat-rename", { chatId: ChatId; title: string | null }, { chatId: ChatId; title: string | null }>
  | ApiCommand<"chat-archive", { chatId: ChatId; archived: boolean }, { chatId: ChatId; archived: boolean; archivedAt: number | null }>
  | ApiCommand<"chat-models", { chatId: ChatId }, ChatModelInfo>
  | ApiCommand<"chat-settings", { chatIds: ChatId[] }, { settings: Record<string, { effort: string | null }> }>
  | ApiCommand<"chat-model-set", { chatId: ChatId; model: string | null }, ChatModelInfo>
  | ApiCommand<"chat-effort-set", { chatId: ChatId; effort: string | null }, ChatModelInfo>
  | ApiCommand<"message-delete", { chatId: ChatId; step: StepId }, { chatId: ChatId; step: StepId; deletedAt: number | string }>
  | ApiCommand<"message-restore", { chatId: ChatId; step: StepId }, { chatId: ChatId; step: StepId; deletedAt: null }>;
