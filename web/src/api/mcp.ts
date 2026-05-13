import type { ApiCommand } from "./contract";
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
