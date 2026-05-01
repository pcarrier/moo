import type { ApiResult } from "./transport";
import { callCommand } from "./contract";
import type { ApiCommand, ApiCommandReq, ApiCommandResult } from "./contract";
import { optional } from "./utils";
import type { ChatId, McpOAuthStart, McpOAuthStatus, McpServerConfig, McpServerId, McpTool } from "./types";

export type McpCommands =
  | ApiCommand<"mcp-list", Record<string, never>, { servers: McpServerConfig[] }>
  | ApiCommand<"mcp-save", McpServerConfig, { server: McpServerConfig }>
  | ApiCommand<"mcp-remove", { id: string }, { id: string; removed: boolean }>
  | ApiCommand<"mcp-oauth-start", { serverId: McpServerId; origin?: string; returnChatId?: ChatId }, { login: McpOAuthStart }>
  | ApiCommand<"mcp-oauth-complete", { state: string; code: string }, { status: McpOAuthStatus }>
  | ApiCommand<"mcp-oauth-logout", { serverId: McpServerId }, { serverId: McpServerId; removed: boolean }>
  | ApiCommand<"mcp-oauth-status", { serverId: McpServerId }, { status: McpOAuthStatus }>
  | ApiCommand<"mcp-tools", { serverId?: string }, { tools: McpTool[] }>
  | ApiCommand<"mcp-call", { serverId: McpServerId; name: string; arguments: unknown }, unknown>;

function start(params: ApiCommandReq<"mcp-oauth-start">): ApiCommandResult<"mcp-oauth-start"> {
  return callCommand("mcp-oauth-start", params);
}

export const mcpApi = {
  list: () => callCommand("mcp-list", {}),
  save: (config: McpServerConfig) =>
    callCommand("mcp-save", config),
  remove: (id: string) =>
    callCommand("mcp-remove", { id }),
  tools: (serverId?: string) =>
    callCommand("mcp-tools", optional({ serverId })),
  call: <T = unknown>(serverId: McpServerId, name: string, args?: unknown) =>
    callCommand("mcp-call", { serverId, name, arguments: args ?? {} }) as Promise<ApiResult<T>>,
  oauth: {
    start,
    complete: (state: string, code: string) =>
      callCommand("mcp-oauth-complete", { state, code }),
    logout: (serverId: McpServerId) =>
      callCommand("mcp-oauth-logout", { serverId }),
    status: (serverId: McpServerId) =>
      callCommand("mcp-oauth-status", { serverId }),
  },
};
