import { moo } from "../moo";
import type { McpServerConfig } from "../types";
import type { Input } from "./_shared";

export type McpServerConfigInput = {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  transport?: unknown;
  enabled?: unknown;
  headers?: unknown;
  timeoutMs?: unknown;
  oauth?: unknown;
};

export function mcpConfigFromInput(input: McpServerConfigInput): McpServerConfig {
  let headers = input.headers;
  if (typeof headers === "string" && headers.trim()) {
    try {
      headers = JSON.parse(headers);
    } catch (err: any) {
      throw new Error(`headers must be a JSON object: ${err?.message || err}`);
    }
  }
  return {
    id: String(input.id ?? "").trim(),
    title: input.title == null ? undefined : String(input.title),
    url: String(input.url ?? "").trim(),
    transport: input.transport === "sse" ? "sse" : "http",
    enabled: input.enabled !== false,
    headers: headers && typeof headers === "object" && !Array.isArray(headers)
      ? Object.fromEntries(Object.entries(headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : undefined,
    timeoutMs: input.timeoutMs == null || input.timeoutMs === "" ? undefined : Number(input.timeoutMs),
    oauth: input.oauth && typeof input.oauth === "object" && !Array.isArray(input.oauth)
      ? Object.fromEntries(Object.entries(input.oauth as Record<string, unknown>).filter(([, v]) => v != null && String(v).trim()).map(([k, v]) => [k, String(v)]))
      : undefined,
  };
}

export async function mcpListCommand() {
  return { ok: true, value: { servers: await moo.mcp.listServers() } };
}

export async function mcpSaveCommand(input: Input) {
  try {
    const server = await moo.mcp.saveServer(mcpConfigFromInput(input));
    return { ok: true, value: { server } };
  } catch (err: any) {
    return { ok: false, error: { message: err?.message || String(err) } };
  }
}

export async function mcpRemoveCommand(input: Input) {
  const id = String(input.id ?? input.serverId ?? "").trim();
  if (!id) return { ok: false, error: { message: "mcp-remove requires id" } };
  return { ok: true, value: { id, removed: await moo.mcp.removeServer(id) } };
}

export async function mcpToolsCommand(input: Input) {
  try {
    return { ok: true, value: { tools: await moo.mcp.listTools(input.serverId || input.id) } };
  } catch (err: any) {
    return { ok: false, error: { message: err?.message || String(err) } };
  }
}

export async function mcpOAuthStartCommand(input: Input) {
  const serverId = String(input.serverId ?? input.id ?? "").trim();
  if (!serverId) return { ok: false, error: { message: "mcp-oauth-start requires serverId" } };
  try {
    return { ok: true, value: { login: await moo.mcp.login(serverId, { origin: input.origin, redirectUri: input.redirectUri, scope: input.scope }) } };
  } catch (err: any) {
    return { ok: false, error: { message: err?.message || String(err) } };
  }
}

export async function mcpOAuthCompleteCommand(input: Input) {
  const state = String(input.state ?? "").trim();
  const code = String(input.code ?? "").trim();
  if (!state || !code) return { ok: false, error: { message: "mcp-oauth-complete requires state and code" } };
  try {
    return { ok: true, value: { status: await moo.mcp.completeLogin(state, code) } };
  } catch (err: any) {
    return { ok: false, error: { message: err?.message || String(err) } };
  }
}

export async function mcpOAuthLogoutCommand(input: Input) {
  const serverId = String(input.serverId ?? input.id ?? "").trim();
  if (!serverId) return { ok: false, error: { message: "mcp-oauth-logout requires serverId" } };
  try {
    return { ok: true, value: { serverId, removed: await moo.mcp.logout(serverId) } };
  } catch (err: any) {
    return { ok: false, error: { message: err?.message || String(err) } };
  }
}

export async function mcpOAuthStatusCommand(input: Input) {
  const serverId = String(input.serverId ?? input.id ?? "").trim();
  if (!serverId) return { ok: false, error: { message: "mcp-oauth-status requires serverId" } };
  try {
    return { ok: true, value: { status: await moo.mcp.authStatus(serverId) } };
  } catch (err: any) {
    return { ok: false, error: { message: err?.message || String(err) } };
  }
}

export async function mcpCallCommand(input: Input) {
  const serverId = String(input.serverId ?? input.id ?? "").trim();
  const name = String(input.name ?? input.tool ?? "").trim();
  if (!serverId || !name) return { ok: false, error: { message: "mcp-call requires serverId and name" } };
  try {
    return { ok: true, value: await moo.mcp.callTool(serverId, name, input.arguments ?? input.input ?? {}) };
  } catch (err: any) {
    return { ok: false, error: { message: err?.message || String(err) } };
  }
}

// -- small interactive UIs -----------------------------------------------

