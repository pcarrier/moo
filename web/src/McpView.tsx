import { For, Show, createEffect, createSignal, onMount } from "solid-js";

import { api, type ApiResult, type McpServerConfig, type McpTool } from "./api";
import { RightSidebarToggle } from "./Sidebar";
import { highlightByPath } from "./syntax";
import type { Bag } from "./state";

type Draft = {
  id: string;
  title: string;
  url: string;
  transport: "http" | "sse";
  enabled: boolean;
  headers: string;
  timeoutMs: string;
  oauthEnabled: boolean;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScope: string;
  oauthAuthorizationUrl: string;
  oauthTokenUrl: string;
  oauthResourceMetadataUrl: string;
  oauthAuthorizationServerMetadataUrl: string;
};

const emptyDraft = (): Draft => ({
  id: "",
  title: "",
  url: "",
  transport: "http",
  enabled: true,
  headers: "",
  timeoutMs: "60000",
  oauthEnabled: true,
  oauthClientId: "moo",
  oauthClientSecret: "",
  oauthScope: "",
  oauthAuthorizationUrl: "",
  oauthTokenUrl: "",
  oauthResourceMetadataUrl: "",
  oauthAuthorizationServerMetadataUrl: "",
});

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(new RegExp("^https?://"), "")
    .replace(new RegExp("/.*"), "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function inferredId(draft: Draft): string {
  return draft.id.trim() || slugify(draft.title) || slugify(draft.url) || "mcp";
}

function prettyTitleFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const first = host.split(".")[0] || host;
    return first ? first[0].toUpperCase() + first.slice(1) : "";
  } catch {
    return "";
  }
}

function splitDenseDescription(tool: McpTool): { shape: string; summary: string } {
  const text = tool.denseDescription || "";
  const idx = text.indexOf(": ");
  if (idx >= 0) return { shape: text.slice(0, idx), summary: text.slice(idx + 2) };
  if (text) return { shape: text, summary: "" };
  return { shape: "{}", summary: tool.description || "" };
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function signaturePrefix(tool: McpTool): string {
  return `moo.mcp.${tool.serverId || tool.server}.${tool.name}`;
}

function propertyLine(value: string, trailingComma: boolean): string {
  const match = value.match(/^([^:]+):(.*)$/);
  if (!match) return `  ${value}${trailingComma ? "," : ""}`;

  const rawName = match[1].trim();
  const typeName = match[2].trim();

  return `  ${rawName}: ${typeName}${trailingComma ? "," : ""}`;
}

function signatureText(tool: McpTool, shape: string): string {
  const prefix = signaturePrefix(tool);
  if (shape.startsWith("{") && shape.endsWith("}")) {
    const body = shape.slice(1, -1).trim();
    if (body) {
      const parts = splitTopLevel(body);
      return [
        `${prefix}({`,
        ...parts.map((part, index) => propertyLine(part, index < parts.length - 1)),
        "})",
      ].join("\n");
    }
  }
  return `${prefix}(${shape})`;
}

function highlightSignature(text: string): string {
  let html = highlightByPath(text, "signature.js");

  html = html.replace(
    /<span class="code-str">(&quot;(?:[^&]|&(?!quot;))*&quot;|&#39;(?:[^&]|&(?!#39;))*&#39;)<\/span>/g,
    '<span class="code-type">$1</span>',
  );
  html = html.replace(/\b(string|number|boolean|object|unknown|any|null|undefined)\b/g, '<span class="code-type">$1</span>');
  html = html.replace(/\b(moo|mcp)\b/g, '<span class="code-namespace">$1</span>');

  return html;
}

function signatureHtml(tool: McpTool, shape: string): string {
  return highlightSignature(signatureText(tool, shape));
}

function draftFromServer(server: McpServerConfig): Draft {
  return {
    id: server.id,
    title: server.title || server.id,
    url: server.url,
    transport: server.transport || "http",
    enabled: server.enabled !== false,
    headers: server.headers ? JSON.stringify(server.headers, null, 2) : "",
    timeoutMs: String(server.timeoutMs ?? 60000),
    oauthEnabled: !!server.oauth,
    oauthClientId: server.oauth?.clientId || "moo",
    oauthClientSecret: server.oauth?.clientSecret || "",
    oauthScope: server.oauth?.scope || "",
    oauthAuthorizationUrl: server.oauth?.authorizationUrl || "",
    oauthTokenUrl: server.oauth?.tokenUrl || "",
    oauthResourceMetadataUrl: server.oauth?.resourceMetadataUrl || "",
    oauthAuthorizationServerMetadataUrl: server.oauth?.authorizationServerMetadataUrl || "",
  };
}

function configFromDraft(draft: Draft): McpServerConfig {
  const headersText = draft.headers.trim();
  let headers: Record<string, string> | undefined;
  if (headersText) {
    const parsed = JSON.parse(headersText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("headers must be a JSON object");
    }
    headers = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
  }
  const id = inferredId(draft);
  const title = draft.title.trim() || prettyTitleFromUrl(draft.url) || id;
  return {
    id,
    title,
    url: draft.url.trim(),
    transport: draft.transport,
    enabled: draft.enabled,
    headers,
    timeoutMs: draft.timeoutMs.trim() ? Number(draft.timeoutMs) : undefined,
    oauth: draft.oauthEnabled ? {
      clientId: draft.oauthClientId.trim() || "moo",
      clientSecret: draft.oauthClientSecret.trim() || undefined,
      scope: draft.oauthScope.trim() || undefined,
      authorizationUrl: draft.oauthAuthorizationUrl.trim() || undefined,
      tokenUrl: draft.oauthTokenUrl.trim() || undefined,
      resourceMetadataUrl: draft.oauthResourceMetadataUrl.trim() || undefined,
      authorizationServerMetadataUrl: draft.oauthAuthorizationServerMetadataUrl.trim() || undefined,
    } : undefined,
  };
}

function errorMessage(result: ApiResult<unknown>) {
  return result.ok ? null : result.error.message;
}

export function McpView(props: { bag: Bag; onToggleSidebar?: () => void }) {
  const { bag } = props;
  const [servers, setServers] = createSignal<McpServerConfig[]>([]);
  const [tools, setTools] = createSignal<McpTool[]>([]);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal<Draft>(emptyDraft());
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal<string | null>(null);
  const [auth, setAuth] = createSignal<Record<string, boolean>>({});
  let titleInputEl: HTMLInputElement | undefined;

  onMount(() => {
    titleInputEl?.focus({ preventScroll: true });
  });

  async function refresh() {
    setBusy(true);
    setMessage(null);
    const listed = await api.mcp.list();
    if (!listed.ok) {
      setMessage(listed.error.message);
      setBusy(false);
      return;
    }
    const nextServers = listed.value.servers;
    setServers(nextServers);
    void bag.refreshMcpServers();
    const sel = selected();
    if (sel && !nextServers.some((s) => s.id === sel)) setSelected(null);
    const statuses: Record<string, boolean> = {};
    await Promise.all(nextServers.map(async (s) => {
      if (!s.oauth) return;
      const status = await api.mcp.oauth.status(s.id);
      if (status.ok) statuses[s.id] = status.value.status.authenticated;
    }));
    setAuth(statuses);
    const allTools = await api.mcp.tools();
    if (allTools.ok) setTools(allTools.value.tools);
    else setMessage(allTools.error.message);
    setBusy(false);
  }

  createEffect(() => {
    if (bag.view() === "mcp") void refresh();
  });

  function edit(server: McpServerConfig) {
    setSelected(server.id);
    setDraft(draftFromServer(server));
    setMessage(null);
  }

  async function save(options: { login?: boolean } = {}) {
    setBusy(true);
    setMessage(null);
    try {
      const config = configFromDraft(draft());
      const saved = await api.mcp.save(config);
      const err = errorMessage(saved);
      if (err || !saved.ok) {
        setMessage(err || "failed to save");
        return;
      }
      setSelected(saved.value.server.id);
      setDraft(draftFromServer(saved.value.server));
      if (options.login && saved.value.server.oauth) {
        const started = await api.mcp.oauth.start({ serverId: saved.value.server.id, origin: window.location.origin, returnChatId: bag.chatId() || undefined });
        if (!started.ok) {
          setMessage(started.error.message);
          return;
        }
        window.location.href = started.value.login.authorizeUrl;
        return;
      }
      setMessage("saved");
      await refresh();
    } catch (err: any) {
      setMessage(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function login(id: string) {
    setBusy(true);
    setMessage(null);
    const started = await api.mcp.oauth.start({ serverId: id, origin: window.location.origin, returnChatId: bag.chatId() || undefined });
    setBusy(false);
    if (!started.ok) {
      setMessage(started.error.message);
      return;
    }
    window.location.href = started.value.login.authorizeUrl;
  }

  async function logout(id: string) {
    setBusy(true);
    const removed = await api.mcp.oauth.logout(id);
    if (!removed.ok) setMessage(removed.error.message);
    else {
      setMessage("logged out");
      await refresh();
    }
    setBusy(false);
  }

  async function remove(id: string) {
    setBusy(true);
    const removed = await api.mcp.remove(id);
    if (!removed.ok) setMessage(removed.error.message);
    else {
      if (selected() === id) {
        setSelected(null);
        setDraft(emptyDraft());
      }
      await refresh();
    }
    setBusy(false);
  }

  const toolsFor = (id: string) => tools().filter((tool) => (tool.serverId || tool.server) === id);
  const authLabel = () => draft().oauthEnabled ? "Save & connect OAuth" : "Save server";

  function resetForm() {
    setSelected(null);
    setDraft(emptyDraft());
    setMessage(null);
  }

  function canReset() {
    const d = draft();
    return !!selected() || !!d.id.trim() || !!d.title.trim() || !!d.url.trim() || !!d.headers.trim();
  }

  return (
    <div class="chat-shell mcp-dashboard-view">
      <section class="main mcp-view">
        <header class="conv-header">
          <button
            class="header-icon-button"
            title="toggle sidebar"
            aria-label="toggle sidebar"
            onClick={props.onToggleSidebar}
          >
            ☰
          </button>
          <button class="header-icon-button" title="back to chat" onClick={() => bag.showChat()}>
            ←
          </button>
          <strong>MCP servers</strong>
          <small class="conv-stats">
            {servers().length} configured server{servers().length === 1 ? "" : "s"}
          </small>
          <button class="header-icon-button" title="refresh MCP servers" disabled={busy()} onClick={refresh}>
            ↻
          </button>
          <RightSidebarToggle bag={bag} />
        </header>
        <main class="timeline mcp-settings">
          <Show when={message()}>
            <div class="mcp-message">{message()}</div>
          </Show>

          <section class="mcp-hero-card">
            <div class="mcp-hero-copy">
              <p class="mcp-kicker">connect a remote MCP server</p>
              <h2>{selected() ? "Edit " + selected() : "Add MCP server"}</h2>
              <p>Paste the MCP URL, then save or sign in.</p>
            </div>
            <form class="mcp-quick-form" onSubmit={(e) => { e.preventDefault(); void save({ login: draft().oauthEnabled }); }}>
              <label>
                Server name
                <input
                  ref={titleInputEl}
                  value={draft().title}
                  onInput={(e) => setDraft({ ...draft(), title: e.currentTarget.value })}
                  placeholder="Linear"
                />
              </label>
              <label>
                MCP URL
                <input
                  type="url"
                  required
                  value={draft().url}
                  onInput={(e) => setDraft({ ...draft(), url: e.currentTarget.value })}
                  placeholder="https://example.com/mcp"
                />
              </label>
              <div class="mcp-quick-row">
                <label class="mcp-switch">
                  <input
                    type="checkbox"
                    checked={draft().oauthEnabled}
                    onChange={(e) => setDraft({ ...draft(), oauthEnabled: e.currentTarget.checked })}
                  />
                  <span>Use OAuth</span>
                </label>
                <label class="mcp-switch">
                  <input
                    type="checkbox"
                    checked={draft().enabled}
                    onChange={(e) => setDraft({ ...draft(), enabled: e.currentTarget.checked })}
                  />
                  <span>Enabled</span>
                </label>
              </div>
              <div class="mcp-actions mcp-primary-actions">
                <button type="submit" class="primary" disabled={busy() || !draft().url.trim()}>{authLabel()}</button>
                <button
                  type="button"
                  class="mcp-reset-btn"
                  disabled={busy() || !canReset()}
                  title="Clear the form without deleting saved servers"
                  onClick={resetForm}
                >
                  Reset
                </button>
                <Show when={selected() && draft().oauthEnabled && auth()[selected()!]}>
                  <button type="button" disabled={busy()} onClick={() => logout(selected()!)}>Log out</button>
                </Show>
              </div>

              <details class="mcp-advanced">
                <summary>Advanced options</summary>
                <div class="mcp-form">
                  <label>
                    tool namespace id
                    <input value={draft().id} onInput={(e) => setDraft({ ...draft(), id: e.currentTarget.value })} placeholder={inferredId(draft())} />
                  </label>
                  <label>
                    transport
                    <select value={draft().transport} onChange={(e) => setDraft({ ...draft(), transport: e.currentTarget.value as "http" | "sse" })}>
                      <option value="http">http</option>
                      <option value="sse">sse</option>
                    </select>
                  </label>
                  <label>
                    timeout ms
                    <input value={draft().timeoutMs} onInput={(e) => setDraft({ ...draft(), timeoutMs: e.currentTarget.value })} />
                  </label>
                  <label>
                    OAuth client id
                    <input value={draft().oauthClientId} onInput={(e) => setDraft({ ...draft(), oauthClientId: e.currentTarget.value })} placeholder="moo" />
                  </label>
                  <label>
                    OAuth scope
                    <input value={draft().oauthScope} onInput={(e) => setDraft({ ...draft(), oauthScope: e.currentTarget.value })} placeholder="optional" />
                  </label>
                  <label>
                    OAuth client secret
                    <input type="password" value={draft().oauthClientSecret} onInput={(e) => setDraft({ ...draft(), oauthClientSecret: e.currentTarget.value })} placeholder="optional" />
                  </label>
                  <label class="wide">
                    headers JSON
                    <textarea rows={4} value={draft().headers} onInput={(e) => setDraft({ ...draft(), headers: e.currentTarget.value })} placeholder={'{"Authorization":"Bearer token"}'} />
                  </label>
                  <label class="wide">
                    authorization URL override
                    <input value={draft().oauthAuthorizationUrl} onInput={(e) => setDraft({ ...draft(), oauthAuthorizationUrl: e.currentTarget.value })} placeholder="discovered automatically" />
                  </label>
                  <label class="wide">
                    token URL override
                    <input value={draft().oauthTokenUrl} onInput={(e) => setDraft({ ...draft(), oauthTokenUrl: e.currentTarget.value })} placeholder="discovered automatically" />
                  </label>
                  <label class="wide">
                    resource metadata URL
                    <input value={draft().oauthResourceMetadataUrl} onInput={(e) => setDraft({ ...draft(), oauthResourceMetadataUrl: e.currentTarget.value })} placeholder="discovered automatically" />
                  </label>
                  <label class="wide">
                    authorization server metadata URL
                    <input value={draft().oauthAuthorizationServerMetadataUrl} onInput={(e) => setDraft({ ...draft(), oauthAuthorizationServerMetadataUrl: e.currentTarget.value })} placeholder="discovered automatically" />
                  </label>
                </div>
              </details>
            </form>
          </section>

          <section class="mcp-card">
            <header class="mcp-card-header"><strong>Configured</strong></header>
            <Show when={servers().length > 0} fallback={<Show when={bag.mcpServersLoaded()}><div class="empty">No MCP servers configured yet.</div></Show>}>
              <ul class="mcp-server-list">
                <For each={servers()}>{(server) => (
                  <li class="mcp-server-row" classList={{ disabled: server.enabled === false }}>
                    <button type="button" class="mcp-server-main" onClick={() => edit(server)}>
                      <span class="mcp-server-title">{server.title || server.id}</span>
                      <span class="mcp-server-meta">
                        moo.mcp.{server.id} · {server.transport || "http"} · {server.oauth ? (auth()[server.id] ? "OAuth connected" : "OAuth not connected") : "no OAuth"} · {toolsFor(server.id).length} tool{toolsFor(server.id).length === 1 ? "" : "s"}
                      </span>
                      <span class="mcp-server-url">{server.url}</span>
                    </button>
                    <div class="mcp-row-actions">
                      <Show when={server.oauth}>
                        <button type="button" onClick={() => auth()[server.id] ? logout(server.id) : login(server.id)} disabled={busy()}>
                          {auth()[server.id] ? "logout" : "login"}
                        </button>
                      </Show>
                      <button type="button" class="danger" onClick={() => remove(server.id)}>remove</button>
                    </div>
                  </li>
                )}</For>
              </ul>
            </Show>
          </section>

          <section class="mcp-card">
            <header class="mcp-card-header"><strong>Tools</strong></header>
            <Show when={tools().length > 0} fallback={<div class="empty">No tools discovered.</div>}>
              <ul class="mcp-tool-list">
                <For each={tools()}>{(tool) => {
                  const detail = splitDenseDescription(tool);
                  return (
                    <li>
                      <code
                        class="mcp-tool-signature"
                        aria-label={signatureText(tool, detail.shape)}
                        innerHTML={signatureHtml(tool, detail.shape)}
                      />
                      <Show when={detail.summary}>
                        <span class="mcp-tool-summary">{detail.summary}</span>
                      </Show>
                    </li>
                  );
                }}</For>
              </ul>
            </Show>
          </section>
        </main>
      </section>
    </div>
  );
}
