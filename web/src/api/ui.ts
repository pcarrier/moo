import type { ApiResult } from "./transport";
import { callCommand } from "./contract";
import type { ApiCommand, ApiCommandReq } from "./contract";
import { optional } from "./utils";
import type { ChatId, Sha256Hash, UiApp, UiBundle, UiId, UiInstance, UiInstanceId } from "./types";

export type UiCommands =
  | ApiCommand<"ui-list", Record<string, never>, { apps: UiApp[] }>
  | ApiCommand<"ui-remove", { uiId: UiId }, { uiId: UiId; removed: boolean; refsDeleted: number; factsRemoved: number }>
  | ApiCommand<"ui-bundle", { uiId: UiId }, { manifest: UiApp; bundle: UiBundle }>
  | ApiCommand<"ui-chat", { chatId: ChatId }, { chatId: ChatId; apps: UiApp[]; instances: UiInstance[]; primaryUiId: string | null }>
  | ApiCommand<"ui-open", { chatId: ChatId; uiId: UiId; instanceId?: UiInstanceId | null }, { chatId: ChatId; uiId: UiId; instanceId: UiInstanceId }>
  | ApiCommand<"ui-close", { chatId: ChatId; uiId: UiId; instanceId?: UiInstanceId | null }, { chatId: ChatId; uiId: UiId; instanceId: UiInstanceId | null }>
  | ApiCommand<"ui-state-get", { instanceId: UiInstanceId }, { instanceId: UiInstanceId; state: unknown; hash: Sha256Hash | null }>
  | ApiCommand<"ui-state-set", { instanceId: UiInstanceId; state: unknown }, { instanceId: UiInstanceId; state: unknown; hash: Sha256Hash }>
  | ApiCommand<"ui-call", { uiId: UiId; instanceId: UiInstanceId | null; chatId: ChatId | null; name: string; input: unknown }, unknown>;

export const uiApi = {
  list: () => callCommand("ui-list", {}),
  remove: (uiId: UiId) =>
    callCommand("ui-remove", { uiId }),
  bundle: (uiId: UiId) =>
    callCommand("ui-bundle", { uiId }),
  chat: (chatId: ChatId) =>
    callCommand("ui-chat", { chatId }),
  open: (chatId: ChatId, uiId: UiId, instanceId?: UiInstanceId | null) =>
    callCommand("ui-open", { chatId, uiId, ...optional({ instanceId }) }),
  close: (chatId: ChatId, uiId: UiId, instanceId?: UiInstanceId | null) =>
    callCommand("ui-close", { chatId, uiId, ...optional({ instanceId }) }),
  state: {
    get: (instanceId: UiInstanceId) =>
      callCommand("ui-state-get", { instanceId }),
    set: (instanceId: UiInstanceId, state: unknown) =>
      callCommand("ui-state-set", { instanceId, state }),
  },
  call: <T = unknown>(params: ApiCommandReq<"ui-call">): Promise<ApiResult<T>> =>
    callCommand("ui-call", params) as Promise<ApiResult<T>>,
};
