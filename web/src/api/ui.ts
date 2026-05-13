import type { ApiCommand } from "./contract";
import type { ChatId, UiApp, UiBundle, UiId, UiInstance, UiInstanceId } from "./types";

export type UiCommands =
  | ApiCommand<"ui-list", Record<string, never>, { apps: UiApp[] }>
  | ApiCommand<"ui-remove", { uiId: UiId }, { uiId: UiId; removed: boolean; refsDeleted: number; factsRemoved: number }>
  | ApiCommand<"ui-bundle", { uiId: UiId }, { manifest: UiApp; bundle: UiBundle }>
  | ApiCommand<"ui-chat", { chatId: ChatId }, { chatId: ChatId; apps: UiApp[]; instances: UiInstance[]; primaryUiId: string | null }>
  | ApiCommand<"ui-open", { chatId: ChatId; uiId: UiId; instanceId?: UiInstanceId | null }, { chatId: ChatId; uiId: UiId; instanceId: UiInstanceId }>
  | ApiCommand<"ui-close", { chatId: ChatId; uiId: UiId; instanceId?: UiInstanceId | null }, { chatId: ChatId; uiId: UiId; instanceId: UiInstanceId | null }>
  | ApiCommand<"ui-state-get", { instanceId: UiInstanceId }, { instanceId: UiInstanceId; state: unknown; target: string | null }>
  | ApiCommand<"ui-state-set", { instanceId: UiInstanceId; state: unknown }, { instanceId: UiInstanceId; state: unknown; target: string }>
  | ApiCommand<"ui-call", { uiId: UiId; instanceId: UiInstanceId | null; chatId: ChatId | null; name: string; input: unknown }, unknown>;
