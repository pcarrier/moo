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

export type ApiCommand<K extends string, Req extends Record<string, unknown>, Res> = {
  command: K;
  req: Req;
  res: Res;
};

export type AnyApiCommand = ApiCommand<string, Record<string, unknown>, unknown>;

export type ApiCommandRequest<C extends AnyApiCommand> = C["req"] & { command: C["command"] };

export type KnownApiCommand =
  | ChatCommands
  | FsCommands
  | ObjectCommands
  | MemoryCommands
  | UiCommands
  | McpCommands
  | V8Commands
  | LlmAuthCommands;

export type ApiCommandMap = {
  [K in KnownCommandName]: Extract<KnownApiCommand, { command: K }>;
};

export type KnownCommandName = KnownApiCommand["command"];
export type ApiCommandReq<K extends KnownCommandName> = ApiCommandMap[K]["req"];
export type ApiCommandRes<K extends KnownCommandName> = ApiCommandMap[K]["res"];
export type ApiCommandResult<K extends KnownCommandName> = Promise<ApiResult<ApiCommandRes<K>>>;

export async function callCommand<K extends KnownCommandName>(
  command: K,
  req: ApiCommandReq<K>,
): ApiCommandResult<K> {
  return call<ApiCommandRes<K>>({ command, ...req });
}
