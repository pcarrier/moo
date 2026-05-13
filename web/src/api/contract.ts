import type { ApiResult } from "./transport";
import { call } from "./transport";
import type { ChatCommands } from "./chat";
import type { FsCommands } from "./fs";
import type { MemoryCommands } from "./memory";
import type { McpCommands } from "./mcp";
import type { ObjectCommands } from "./objects";
import type { UiCommands } from "./ui";
import type { V8Commands } from "./v8";
import type { LlmAuthCommands } from "./llmAuth";
import type { TraceCommands } from "./traces";
import type { SkillCommands } from "./skills";

export type ApiCommand<K extends string, Req extends Record<string, unknown>, Res> = {
  command: K;
  req: Req;
  res: Res;
};

export type KnownApiCommand =
  | ChatCommands
  | FsCommands
  | ObjectCommands
  | MemoryCommands
  | UiCommands
  | McpCommands
  | V8Commands
  | LlmAuthCommands
  | TraceCommands
  | SkillCommands;

export type KnownCommandName = KnownApiCommand["command"];
export type ApiCommandMap = {
  [K in KnownCommandName]: Extract<KnownApiCommand, { command: K }>;
};
export type ApiCommandReq<K extends KnownCommandName> = ApiCommandMap[K]["req"];
export type ApiCommandRes<K extends KnownCommandName> = ApiCommandMap[K]["res"];
export type ApiCommandResult<K extends KnownCommandName> = Promise<ApiResult<ApiCommandRes<K>>>;

export function api<K extends KnownCommandName>(
  command: K,
  req: ApiCommandReq<K>,
): ApiCommandResult<K> {
  return call<ApiCommandRes<K>>({ command, ...req });
}
