import type { Moo, Quad, Bindings, Triple, ObjectInput, MemoryScope, UiAskSpec, UiChooseSpec, McpServerConfig, McpTool, McpOAuthStartOptions, McpOAuthStatus, McpOAuthStart, SubagentSpec, SubagentResult } from "./types";
import { Term } from "./types";
import { assertFactObject, assertFactObjects, chatRefs, unpackQuad, stringifyForLog } from "./lib";
import { appendStep } from "./steps";

// IRIs and prefixed names render bare. Anything else is encoded as a Turtle
// string literal with proper escaping. Numbers and booleans become bare
// numeric/boolean literals. Variables (`?x`) pass through.
function encodeObject(o: ObjectInput): string {
  if (o instanceof Term) return o.turtle;
  if (typeof o === "number") {
    if (!Number.isFinite(o)) return `"${String(o)}"`;
    return String(o);
  }
  if (typeof o === "boolean") return o ? "true" : "false";
  if (typeof o === "string") {
    if (o.startsWith("?")) return o; // variable
    if (/^[A-Za-z][A-Za-z0-9_-]*:[^\s]+$/.test(o)) return o; // prefixed IRI
    if (/^<[^>\s]+>$/.test(o)) return o; // full IRI
    return encodeStringLiteral(o);
  }
  return encodeStringLiteral(String(o));
}

function encodeStringLiteral(s: string): string {
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out + '"';
}

const term: Moo["term"] = {
  iri(uri) {
    if (/^<[^>\s]+>$/.test(uri)) return new Term(uri);
    if (/^[A-Za-z][A-Za-z0-9_-]*:[^\s]+$/.test(uri)) return new Term(uri);
    return new Term(`<${uri}>`);
  },
  string(s, opts) {
    let t = encodeStringLiteral(s);
    if (opts?.lang) t += `@${opts.lang}`;
    else if (opts?.type) t += `^^${opts.type}`;
    return new Term(t);
  },
  int(n) {
    return new Term(String(Math.trunc(n)));
  },
  decimal(n) {
    const s = String(n);
    return new Term(s.includes(".") ? s : `${s}.0`);
  },
  bool(b) {
    return new Term(b ? "true" : "false");
  },
  datetime(d) {
    const iso = typeof d === "string" ? d : d.toISOString();
    return new Term(`"${iso}"^^xsd:dateTime`);
  },
};

const time: Moo["time"] = {
  async now() {
    return __op_now();
  },
  async nowPlus(ms) {
    return __op_now() + Number(ms);
  },
};

const id: Moo["id"] = {
  async new(prefix = "id") {
    return __op_id(prefix);
  },
};

const log: Moo["log"] = (...args) => {
  const message = args.map(stringifyForLog).join(" ");
  const chatId = activeChatId;
  if (!chatId) return;
  const c = chatRefs(chatId);
  const logId = __op_id("log");
  const at = String(__op_now());
  __op_facts_swap(
    c.facts,
    EMPTY_JSON_ARRAY,
    JSON.stringify([
      [c.graph, logId, "rdf:type", "agent:Log"],
      [c.graph, logId, "agent:createdBy", "agent:moo"],
      [c.graph, logId, "agent:createdAt", at],
      [c.graph, logId, "agent:message", message],
    ]),
  );
};

let activeChatId: string | null = null;
let activeRunJSContext: { chatId: string; runJsStepId: string; depth: number; outstanding: Set<string> } | null = null;

export async function withMooChatContext<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const previous = activeChatId;
  activeChatId = chatId;
  try {
    return await fn();
  } finally {
    activeChatId = previous;
  }
}

export async function withMooRunJSContext<T>(
  chatId: string,
  runJsStepId: string,
  depth: number,
  fn: () => Promise<T>,
): Promise<T> {
  const previousChat = activeChatId;
  const previousRunJS = activeRunJSContext;
  activeChatId = chatId;
  activeRunJSContext = { chatId, runJsStepId, depth, outstanding: new Set() };
  try {
    return await fn();
  } finally {
    const ctx = activeRunJSContext;
    activeRunJSContext = previousRunJS;
    activeChatId = previousChat;
    if (ctx) {
      for (const childChatId of ctx.outstanding) {
        try {
          await markOutstandingSubagentCancelled(ctx.chatId, childChatId, "runJS finished before awaiting this subagent");
        } catch {
          // best effort only
        }
      }
    }
  }
}

function splitLinesForDiff(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type DiffStats = { added: number; removed: number; lines: number };

const DIFF_CONTEXT_LINES = 3;
const EMPTY_JSON_ARRAY = "[]";

function unifiedDiffWithStats(path: string, before: string | null, after: string): { diff: string; stats: DiffStats } {
  const a = splitLinesForDiff(before ?? "");
  const b = splitLinesForDiff(after);
  const n = a.length;
  const m = b.length;

  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;

  if (prefix === n && prefix === m) {
    const from = before == null ? "/dev/null" : "a/" + path;
    const diff = ["--- " + from, "+++ b/" + path, "@@ -1,0 +1,0 @@", " (no textual changes)"].join("\n");
    return { diff, stats: { added: 0, removed: 0, lines: 4 } };
  }

  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - suffix - 1] === b[m - suffix - 1]) suffix++;

  const oldChangeEnd = n - suffix;
  const newChangeEnd = m - suffix;
  const oldStart = Math.max(0, prefix - DIFF_CONTEXT_LINES);
  const newStart = oldStart;
  const oldEnd = Math.min(n, oldChangeEnd + DIFF_CONTEXT_LINES);
  const newEnd = Math.min(m, newChangeEnd + DIFF_CONTEXT_LINES);
  const body: string[] = [];
  let added = 0;
  let removed = 0;

  for (let i = oldStart; i < prefix; i++) body.push(" " + a[i]);

  let i = prefix;
  let j = prefix;
  while (i < oldChangeEnd && j < newChangeEnd) {
    if (a[i] === b[j]) {
      body.push(" " + a[i]);
      i++;
      j++;
    } else {
      body.push("-" + a[i++]);
      body.push("+" + b[j++]);
      removed++;
      added++;
    }
  }
  while (i < oldChangeEnd) {
    body.push("-" + a[i++]);
    removed++;
  }
  while (j < newChangeEnd) {
    body.push("+" + b[j++]);
    added++;
  }

  for (let k = newChangeEnd; k < newEnd; k++) body.push(" " + b[k]);

  const from = before == null ? "/dev/null" : "a/" + path;
  const header = ["--- " + from, "+++ b/" + path, "@@ -" + (oldStart + 1) + "," + (oldEnd - oldStart) + " +" + (newStart + 1) + "," + (newEnd - newStart) + " @@"];
  const diff = [...header, ...body].join("\n");
  return { diff, stats: { added, removed, lines: header.length + body.length } };
}

async function displayPathForChat(chatId: string, path: string): Promise<string> {
  const normalizedPath = String(path).replace(/\\/g, "/");
  const scratch = (await chat.scratch(chatId)).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!scratch) return normalizedPath;
  if (normalizedPath === scratch) return ".";
  if (normalizedPath.startsWith(scratch + "/")) return normalizedPath.slice(scratch.length + 1) || ".";
  return normalizedPath;
}

async function recordFileWriteDiff(path: string, before: string | null, after: string): Promise<void> {
  const chatId = activeChatId;
  if (!chatId) return;
  const displayPath = await displayPathForChat(chatId, path);
  const { diff, stats } = unifiedDiffWithStats(displayPath, before, after);
  const at = await time.now();
  const hash = await objects.put(
    "agent:FileDiff",
    JSON.stringify({ chatId, path: displayPath, beforeExists: before != null, before, after, diff, stats, at }),
  );
  const { stepId } = await appendStep(chatId, {
    kind: "agent:FileDiff",
    status: "agent:Done",
    payloadHash: hash,
    extras: [["agent:path", displayPath]],
  });
  const diffId = await id.new("fsdiff");
  await refs.set(`fs-diffs/${diffId}`, hash);
  events.publish({ kind: "file-diff", chatId, path: displayPath, before, after, diff, stats, hash, stepId, at });
}

function turtleTriple(subject: string, predicate: string, object: string): string {
  const pred = predicate === "rdf:type" ? "a" : predicate;
  return `${subject} ${pred} ${object} .`;
}

type MemoryChange = { subject: string; predicate: string; object: string };

function memorySnapshot(changes: MemoryChange[]): string {
  if (!changes.length) return "";
  return changes.map(({ subject, predicate, object }) => turtleTriple(subject, predicate, object)).join("\n") + "\n";
}

async function recordMemoryDiff(
  refName: string,
  graph: string,
  action: "assert" | "retract",
  changes: MemoryChange[],
): Promise<void> {
  const chatId = activeChatId;
  if (!chatId || changes.length === 0) return;
  const path = `${refName}.ttl`;
  const snapshot = memorySnapshot(changes);
  const before = action === "assert" ? "" : snapshot;
  const after = action === "assert" ? snapshot : "";
  const { diff, stats } = unifiedDiffWithStats(path, before, after);
  const at = await time.now();
  const first = changes[0]!;
  const payload: Record<string, unknown> = {
    chatId,
    refName,
    graph,
    action,
    path,
    diff,
    stats,
    at,
    changes,
    count: changes.length,
    subject: first.subject,
    predicate: first.predicate,
    object: first.object,
  };
  const hash = await objects.put("agent:MemoryDiff", JSON.stringify(payload));
  const { stepId } = await appendStep(chatId, {
    kind: "agent:MemoryDiff",
    status: "agent:Done",
    payloadHash: hash,
    extras: [["agent:path", path], ["agent:graph", graph]],
  });
  const diffId = await id.new("memdiff");
  await refs.set(`memory-diffs/${diffId}`, hash);
  events.publish({ kind: "memory-diff", chatId, refName, graph, path, diff, stats, hash, stepId, at, count: changes.length });
}

const objects: Moo["objects"] = {
  async put(kind, content) {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    return __op_object_put(kind, text);
  },
  async get(hash) {
    return __op_object_get(hash);
  },
  async getJSON(hash) {
    const row = __op_object_get(hash);
    if (!row) return null;
    try {
      return { kind: row.kind, value: JSON.parse(row.content) };
    } catch (_) {
      return { kind: row.kind, value: row.content as any };
    }
  },
};

const refs: Moo["refs"] = {
  async get(name) {
    return __op_ref_get(name);
  },
  async set(name, target) {
    __op_ref_set(name, target);
  },
  async cas(name, expected, next) {
    return __op_ref_cas(name, expected ?? null, next);
  },
  async list(prefix = "") {
    return __op_refs_list(prefix);
  },
  async delete(name) {
    return __op_ref_delete(name);
  },
};


function unpackMemoryFact(fact: unknown): [string, string, ObjectInput] {
  if (Array.isArray(fact) && fact.length >= 3) {
    return [String(fact[0]), String(fact[1]), fact[2] as ObjectInput];
  }
  if (fact && typeof fact === "object") {
    const row = fact as { subject?: unknown; predicate?: unknown; object?: unknown };
    if (row.subject != null && row.predicate != null && row.object != null) {
      return [String(row.subject), String(row.predicate), row.object as ObjectInput];
    }
  }
  throw new Error("memory fact must be [subject, predicate, object] or {subject,predicate,object}");
}

function unpackMemoryFacts(input: unknown): Array<[string, string, ObjectInput]> {
  if (!Array.isArray(input)) throw new Error("bulk memory write requires an array of facts");
  return input.map(unpackMemoryFact);
}


const sparql: Moo["sparql"] = {
  async query(query, opts) {
    const { ref, graph = null, limit = null } = opts || ({} as any);
    if (!ref) throw new Error("sparql.query requires opts.ref");
    const decoded = __op_sparql_query(query, ref, graph, limit ?? null);
    return decoded.result;
  },
  async select(query, opts) {
    const decoded = __op_sparql_query(query, opts.ref, opts.graph ?? null, opts.limit ?? null);
    if (decoded.type !== "select") throw new Error("SPARQL query returned " + decoded.type + ", not select");
    return decoded.result;
  },
  async ask(query, opts) {
    const decoded = __op_sparql_query(query, opts.ref, opts.graph ?? null, opts.limit ?? null);
    if (decoded.type !== "ask") throw new Error("SPARQL query returned " + decoded.type + ", not ask");
    return decoded.result;
  },
  async construct(query, opts) {
    const decoded = __op_sparql_query(query, opts.ref, opts.graph ?? null, opts.limit ?? null);
    if (decoded.type !== "construct") throw new Error("SPARQL query returned " + decoded.type + ", not construct");
    return decoded.result;
  },
};

const facts: Moo["facts"] = {
  async add(refName, graph, subject, predicate, object) {
    assertFactObject(object);
    __op_facts_add(refName, graph, subject, predicate, object);
  },
  async addAll(refName, quads) {
    const adds = (quads as Quad[]).map((q) => unpackQuad(q));
    if (!adds.length) return;
    assertFactObjects(adds);
    __op_facts_swap(refName, EMPTY_JSON_ARRAY, JSON.stringify(adds));
  },
  async remove(refName, graph, subject, predicate, object) {
    __op_facts_remove(refName, graph, subject, predicate, object);
  },
  async match(refName, pattern = {}) {
    const {
      graph = null,
      subject = null,
      predicate = null,
      object = null,
      limit = null,
    } = pattern;
    const rows = __op_facts_match(refName, graph, subject, predicate, object, limit);
    return rows as Quad[];
  },
  async history(refName, pattern = {}) {
    const {
      graph = null,
      subject = null,
      predicate = null,
      object = null,
      limit = null,
    } = pattern;
    const rows = __op_facts_history(refName, graph, subject, predicate, object, limit);
    return rows as import("./types").FactHistoryRow[];
  },
  async matchAll(patterns: Triple[], opts) {
    const { ref, limit = null } = opts;
    if (!ref) throw new Error("matchAll requires opts.ref");
    return __op_facts_match_all(
      ref,
      JSON.stringify(patterns),
      opts.graph ?? null,
      limit ?? null,
    ) as Bindings[];
  },
  async refs(prefix = null) {
    return __op_facts_refs(prefix);
  },
  async count(refName) {
    return __op_facts_count(refName);
  },
  async swap(refName, removes, adds) {
    const r = (removes || []).map((q) => unpackQuad(q as Quad));
    const a = (adds || []).map((q) => unpackQuad(q as Quad));
    assertFactObjects(a);
    __op_facts_swap(refName, JSON.stringify(r), JSON.stringify(a));
  },
  async update(refName, fn) {
    const adds: Quad[] = [];
    const removes: Quad[] = [];
    const txn = {
      add: (g: string, s: string, p: string, o: string) => adds.push([g, s, p, o]),
      remove: (g: string, s: string, p: string, o: string) => removes.push([g, s, p, o]),
    };
    await fn(txn);
    if (adds.length || removes.length) {
      assertFactObjects(adds);
      __op_facts_swap(refName, JSON.stringify(removes), JSON.stringify(adds));
    }
  },
  async clear(refName) {
    return __op_facts_clear(refName);
  },
  async purge(refName) {
    return __op_facts_purge(refName);
  },
  async purgeGraph(graph) {
    return __op_facts_purge_graph(graph);
  },
};

const fs: Moo["fs"] = {
  async read(path) {
    return __op_fs_read(path);
  },
  async write(path, content) {
    const text = typeof content === "string" ? content : String(content);
    let before: string | null = null;
    try {
      before = __op_fs_read(path);
    } catch (_) {
      before = null;
    }
    __op_fs_write(path, text);
    await recordFileWriteDiff(path, before, text);
  },
  async list(path) {
    return __op_fs_list(path);
  },
  async glob(pattern) {
    return __op_fs_glob(pattern);
  },
  async stat(path) {
    return __op_fs_stat(path);
  },
  async exists(path) {
    return (await fs.stat(path)) != null;
  },
  async ensureDir(path) {
    __op_fs_mkdir(path);
  },
};

const proc: Moo["proc"] = {
  async run(cmd, args = [], opts = {}) {
    return __op_proc_run(
      cmd,
      JSON.stringify(args),
      opts.cwd ?? null,
      opts.stdin ?? null,
      opts.timeoutMs ?? 60_000,
    );
  },
};

function buildBody(opts: any): { body: string | null; headers: Record<string, string> } {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  let body: string | null = null;
  if (opts.body != null) {
    if (typeof opts.body === "string") {
      body = opts.body;
    } else {
      body = JSON.stringify(opts.body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    }
  }
  return { body, headers };
}

const http: Moo["http"] = {
  async fetch(opts) {
    const method = opts.method || "GET";
    if (!opts.url) throw new Error("http.fetch requires url");
    const { body, headers } = buildBody(opts);
    return __op_http_fetch(method, opts.url, JSON.stringify(headers), body, opts.timeoutMs ?? 60_000);
  },
  async stream(opts) {
    const method = opts.method || "GET";
    if (!opts.url) throw new Error("http.stream requires url");
    const { body, headers } = buildBody(opts);
    const opened = __op_http_stream_open(
      method,
      opts.url,
      JSON.stringify(headers),
      body,
      opts.timeoutMs ?? 120_000,
    );
    return {
      status: opened.status,
      async next() {
        return __op_http_stream_next(opened.handle);
      },
      async close() {
        __op_http_stream_close(opened.handle);
      },
    };
  },
};


// -- Model Context Protocol ---------------------------------------------

function cleanMcpId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const v = id.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(v) ? v : null;
}

function mcpRef(id: string): string {
  return `mcp/${id}/config`;
}

function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    const key = String(k).trim();
    if (!key) continue;
    if (v == null) continue;
    out[key] = String(v);
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeMcpOAuth(oauth: unknown): McpServerConfig["oauth"] | undefined {
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return undefined;
  const src = oauth as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of [
    "clientId",
    "clientSecret",
    "authorizationUrl",
    "tokenUrl",
    "scope",
    "redirectUri",
    "resourceMetadataUrl",
    "authorizationServerMetadataUrl",
    "registrationUrl",
  ]) {
    const value = src[key];
    if (value != null && String(value).trim()) out[key] = String(value).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeMcpServer(input: McpServerConfig): McpServerConfig {
  const id = cleanMcpId(input?.id);
  if (!id) throw new Error("MCP server id must match [a-zA-Z0-9_.-]+");
  const url = String(input.url || "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("MCP server url must be http(s)");
  const transport = input.transport === "sse" ? "sse" : "http";
  const timeoutMs = Number(input.timeoutMs ?? 60_000);
  return {
    id,
    title: String(input.title || id).trim() || id,
    url,
    transport,
    enabled: input.enabled !== false,
    headers: normalizeHeaders(input.headers),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 60_000,
    oauth: normalizeMcpOAuth(input.oauth),
  };
}

function parseMcpSseBody(body: string): any {
  const messages: any[] = [];
  let dataLines: string[] = [];
  let parseError: any = null;
  const flush = () => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") return;
    try {
      messages.push(JSON.parse(data));
    } catch (err: any) {
      parseError = err;
    }
  };

  for (const rawLine of body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (rawLine === "") {
      flush();
      continue;
    }
    if (rawLine.startsWith("data:")) {
      let data = rawLine.slice(5);
      if (data.startsWith(" ")) data = data.slice(1);
      dataLines.push(data);
    }
  }
  flush();

  if (messages.length) {
    return messages.find((message) => message?.error) || messages.find((message) => message?.result !== undefined) || messages[messages.length - 1];
  }
  if (parseError) throw parseError;
  throw new Error("no JSON data events found");
}

function parseMcpBody(body: string): any {
  try {
    return JSON.parse(body || "null");
  } catch (jsonErr: any) {
    try {
      return parseMcpSseBody(body || "");
    } catch (sseErr: any) {
      throw new Error(`MCP server returned non-JSON response: ${jsonErr?.message || jsonErr}; SSE parse failed: ${sseErr?.message || sseErr}`);
    }
  }
}

function mcpEndpoint(server: McpServerConfig): string {
  // Streamable HTTP MCP servers usually expose their JSON-RPC endpoint at the
  // configured URL. For SSE configs, the same request helper targets a sibling
  // /message endpoint unless the user already supplied one explicitly.
  if (server.transport !== "sse") return server.url;
  if (/\/message\/?$/i.test(server.url)) return server.url;
  return server.url.replace(/\/?$/, "/message");
}

type McpOAuthToken = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  expires_at?: number;
  refresh_token?: string;
  scope?: string;
};

type McpOAuthPending = {
  serverId: string;
  codeVerifier: string;
  redirectUri: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  expiresAt: number;
};

function mcpOAuthTokenRef(id: string): string {
  return `mcp/${id}/oauth/token`;
}

function mcpOAuthPendingRef(state: string): string {
  return `mcp/oauth/state/${state}`;
}

function parseHttpUrl(url: string): { origin: string; path: string } | null {
  const m = /^(https?:\/\/[^/?#]+)([^?#]*)/i.exec(url);
  if (!m) return null;
  return { origin: m[1]!, path: m[2] || "/" };
}

function formEncode(values: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (v == null) continue;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
  }
  return parts.join("&");
}

function addQuery(url: string, values: Record<string, string | undefined>): string {
  const qs = formEncode(values);
  if (!qs) return url;
  const hash = url.indexOf("#");
  const base = hash >= 0 ? url.slice(0, hash) : url;
  const frag = hash >= 0 ? url.slice(hash) : "";
  return base + (base.includes("?") ? "&" : "?") + qs + frag;
}

function oauthSecret(prefix: string): string {
  let out = "";
  while (out.length < 64) out += __op_id(prefix).replace(/[^A-Za-z0-9._~-]/g, "");
  return out.slice(0, 96);
}

async function getJsonMaybe(url: string, timeoutMs = 10_000): Promise<any | null> {
  try {
    const response = await http.fetch({ method: "GET", url, headers: { Accept: "application/json" }, timeoutMs });
    if (response.status < 200 || response.status >= 300) return null;
    return parseMcpBody(response.body);
  } catch {
    return null;
  }
}

async function discoverMcpOAuth(server: McpServerConfig): Promise<Required<Pick<NonNullable<McpServerConfig["oauth"]>, "authorizationUrl" | "tokenUrl">> & NonNullable<McpServerConfig["oauth"]> & { registrationUrl?: string }> {
  let oauth = { ...(server.oauth || {}) };
  if ((!oauth.authorizationUrl || !oauth.tokenUrl) && oauth.resourceMetadataUrl) {
    const meta = await getJsonMaybe(oauth.resourceMetadataUrl, server.timeoutMs);
    const issuer = meta?.authorization_servers?.[0] || meta?.authorization_server;
    if (issuer && !oauth.authorizationServerMetadataUrl) {
      oauth.authorizationServerMetadataUrl = String(issuer).replace(/\/$/, "") + "/.well-known/oauth-authorization-server";
    }
  }
  if ((!oauth.authorizationUrl || !oauth.tokenUrl) && !oauth.resourceMetadataUrl) {
    const parsed = parseHttpUrl(server.url);
    if (parsed) {
      const candidates = [
        parsed.origin + "/.well-known/oauth-protected-resource" + parsed.path.replace(/\/$/, ""),
        parsed.origin + "/.well-known/oauth-protected-resource",
      ];
      for (const candidate of candidates) {
        const meta = await getJsonMaybe(candidate, server.timeoutMs);
        const issuer = meta?.authorization_servers?.[0] || meta?.authorization_server;
        if (issuer) {
          oauth.resourceMetadataUrl = candidate;
          oauth.authorizationServerMetadataUrl = String(issuer).replace(/\/$/, "") + "/.well-known/oauth-authorization-server";
          break;
        }
      }
    }
  }
  if ((!oauth.authorizationUrl || !oauth.tokenUrl) && oauth.authorizationServerMetadataUrl) {
    const meta = await getJsonMaybe(oauth.authorizationServerMetadataUrl, server.timeoutMs);
    oauth.authorizationUrl ||= meta?.authorization_endpoint;
    oauth.tokenUrl ||= meta?.token_endpoint;
    oauth.registrationUrl ||= meta?.registration_endpoint;
  }
  if (!oauth.authorizationUrl || !oauth.tokenUrl) {
    throw new Error(`MCP server ${server.id} needs oauth.authorizationUrl and oauth.tokenUrl (or discoverable metadata)`);
  }
  return oauth as any;
}

async function loadMcpOAuthToken(serverId: string): Promise<McpOAuthToken | null> {
  const clean = cleanMcpId(serverId);
  if (!clean) return null;
  const hash = await refs.get(mcpOAuthTokenRef(clean));
  if (!hash) return null;
  const row = await objects.getJSON<McpOAuthToken>(hash);
  return row?.value?.access_token ? row.value : null;
}

async function saveMcpOAuthToken(serverId: string, token: McpOAuthToken): Promise<McpOAuthToken> {
  const now = await time.now();
  if (token.expires_in && !token.expires_at) token.expires_at = now + Number(token.expires_in) * 1000;
  const hash = await objects.put("mcp:OAuthToken", JSON.stringify(token));
  await refs.set(mcpOAuthTokenRef(serverId), hash);
  return token;
}

type McpOAuthClientRegistration = {
  client_id: string;
  client_secret?: string;
  redirect_uris?: string[];
  token_endpoint_auth_method?: string;
};

async function registerMcpOAuthClient(server: McpServerConfig, oauth: Awaited<ReturnType<typeof discoverMcpOAuth>>, redirectUri: string): Promise<Awaited<ReturnType<typeof discoverMcpOAuth>>> {
  if (!oauth.registrationUrl) return oauth;
  if (oauth.clientId && oauth.clientId !== "moo" && oauth.redirectUri === redirectUri) return oauth;
  const response = await http.fetch({
    method: "POST",
    url: oauth.registrationUrl,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "moo " + (server.title || server.id),
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
    timeoutMs: server.timeoutMs ?? 60_000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`MCP OAuth client registration failed with HTTP ${response.status}: ${response.body}`);
  }
  const registered = parseMcpBody(response.body) as McpOAuthClientRegistration;
  if (!registered?.client_id) throw new Error("MCP OAuth client registration response missing client_id");
  const nextOauth = {
    ...oauth,
    clientId: registered.client_id,
    clientSecret: registered.client_secret || oauth.clientSecret,
    redirectUri,
  };
  await mcpCore.saveServer({ ...server, oauth: nextOauth });
  return nextOauth;
}

async function refreshMcpOAuthToken(server: McpServerConfig, token: McpOAuthToken): Promise<McpOAuthToken | null> {
  if (!token.refresh_token) return token;
  if (token.expires_at && token.expires_at - (await time.now()) > 60_000) return token;
  const oauth = await discoverMcpOAuth(server);
  const response = await http.fetch({
    method: "POST",
    url: oauth.tokenUrl,
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: formEncode({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: oauth.clientId || "moo",
      client_secret: oauth.clientSecret,
    }),
    timeoutMs: server.timeoutMs ?? 60_000,
  });
  if (response.status < 200 || response.status >= 300) return token;
  const next = parseMcpBody(response.body) as McpOAuthToken;
  if (!next.refresh_token) next.refresh_token = token.refresh_token;
  return saveMcpOAuthToken(server.id, next);
}

const mcpCore = {
  async listServers(): Promise<McpServerConfig[]> {
    const ids = new Set<string>();
    for (const refName of await refs.list("mcp/")) {
      const m = /^mcp\/([^/]+)\/config$/.exec(refName);
      if (m) ids.add(m[1]!);
    }
    const out: McpServerConfig[] = [];
    for (const id of [...ids].sort()) {
      const server = await mcpCore.getServer(id);
      if (server) out.push(server);
    }
    return out;
  },
  async getServer(id: string): Promise<McpServerConfig | null> {
    const clean = cleanMcpId(id);
    if (!clean) return null;
    const hash = await refs.get(mcpRef(clean));
    if (!hash) return null;
    const row = await objects.getJSON<McpServerConfig>(hash);
    return row?.value ? normalizeMcpServer(row.value) : null;
  },
  async saveServer(config: McpServerConfig): Promise<McpServerConfig> {
    const server = normalizeMcpServer(config);
    const hash = await objects.put("mcp:ServerConfig", JSON.stringify(server));
    await refs.set(mcpRef(server.id), hash);
    return server;
  },
  async removeServer(id: string): Promise<boolean> {
    const clean = cleanMcpId(id);
    if (!clean) return false;
    await refs.delete(mcpOAuthTokenRef(clean));
    return refs.delete(mcpRef(clean));
  },
  async login(serverId: string, opts: McpOAuthStartOptions = {}): Promise<McpOAuthStart> {
    const server = await mcpCore.getServer(serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}`);
    let oauth = await discoverMcpOAuth(server);
    const redirectUri = opts.redirectUri || oauth.redirectUri || ((opts.origin || "http://127.0.0.1:7777").replace(/\/$/, "") + "/mcp/oauth/callback");
    oauth = await registerMcpOAuthClient(server, oauth, redirectUri);
    const clientId = oauth.clientId || "moo";
    const state = oauthSecret("mcpstate");
    const codeVerifier = oauthSecret("mcpverifier");
    const codeChallenge = __op_sha256_base64url(codeVerifier);
    const expiresAt = (await time.now()) + 10 * 60_000;
    const pending: McpOAuthPending = {
      serverId: server.id,
      codeVerifier,
      redirectUri,
      tokenUrl: oauth.tokenUrl,
      clientId,
      clientSecret: oauth.clientSecret,
      scope: opts.scope || oauth.scope,
      expiresAt,
    };
    const hash = await objects.put("mcp:OAuthPending", JSON.stringify(pending));
    await refs.set(mcpOAuthPendingRef(state), hash);
    return {
      serverId: server.id,
      state,
      redirectUri,
      expiresAt,
      authorizeUrl: addQuery(oauth.authorizationUrl, {
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: opts.scope || oauth.scope,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }),
    };
  },
  async completeLogin(state: string, code: string): Promise<McpOAuthStatus> {
    const cleanState = String(state || "").trim();
    const hash = cleanState ? await refs.get(mcpOAuthPendingRef(cleanState)) : null;
    if (!hash) throw new Error("unknown or expired MCP OAuth state");
    const row = await objects.getJSON<McpOAuthPending>(hash);
    const pending = row?.value;
    if (!pending) throw new Error("invalid MCP OAuth state");
    if (pending.expiresAt < await time.now()) {
      await refs.delete(mcpOAuthPendingRef(cleanState));
      throw new Error("expired MCP OAuth state");
    }
    const response = await http.fetch({
      method: "POST",
      url: pending.tokenUrl,
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: formEncode({
        grant_type: "authorization_code",
        code: String(code || ""),
        redirect_uri: pending.redirectUri,
        client_id: pending.clientId,
        client_secret: pending.clientSecret,
        code_verifier: pending.codeVerifier,
      }),
      timeoutMs: 60_000,
    });
    await refs.delete(mcpOAuthPendingRef(cleanState));
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`MCP OAuth token exchange failed with HTTP ${response.status}: ${response.body}`);
    }
    const token = parseMcpBody(response.body) as McpOAuthToken;
    if (!token?.access_token) throw new Error("MCP OAuth token response missing access_token");
    await saveMcpOAuthToken(pending.serverId, token);
    return mcpCore.authStatus(pending.serverId);
  },
  async logout(serverId: string): Promise<boolean> {
    const clean = cleanMcpId(serverId);
    if (!clean) return false;
    return refs.delete(mcpOAuthTokenRef(clean));
  },
  async authStatus(serverId: string): Promise<McpOAuthStatus> {
    const clean = cleanMcpId(serverId);
    if (!clean) throw new Error("invalid MCP server id");
    const token = await loadMcpOAuthToken(clean);
    return { serverId: clean, authenticated: !!token, expiresAt: token?.expires_at ?? null, scope: token?.scope ?? null };
  },
  async request<T = unknown>(serverId: string, method: string, params: unknown = {}): Promise<T> {
    const server = await mcpCore.getServer(serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}`);
    if (server.enabled === false) throw new Error(`MCP server disabled: ${serverId}`);
    let token = await loadMcpOAuthToken(server.id);
    if (token) token = await refreshMcpOAuthToken(server, token);
    const headers = {
      Accept: "application/json, text/event-stream",
      ...(server.headers || {}),
      ...(token?.access_token ? { Authorization: `Bearer ${token.access_token}` } : {}),
    };
    const response = await http.fetch({
      method: "POST",
      url: mcpEndpoint(server),
      headers,
      body: {
        jsonrpc: "2.0",
        id: await id.new("mcp"),
        method,
        params,
      },
      timeoutMs: server.timeoutMs ?? 60_000,
    });
    if (response.status === 401 && server.oauth && !token) {
      throw new Error(`MCP ${server.id} requires OAuth login; run moo.mcp.login("${server.id}") from the UI or use the MCP settings Login button`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`MCP ${method} failed with HTTP ${response.status}: ${response.body}`);
    }
    const payload = parseMcpBody(response.body);
    if (payload?.error) {
      throw new Error(payload.error.message || JSON.stringify(payload.error));
    }
    return payload?.result as T;
  },
  async listTools(serverId?: string): Promise<McpTool[]> {
    const servers = serverId ? [await mcpCore.getServer(serverId)] : await mcpCore.listServers();
    const out: McpTool[] = [];
    for (const server of servers) {
      if (!server || server.enabled === false) continue;
      const result: any = await mcpCore.request(server.id, "tools/list", {});
      for (const tool of result?.tools || []) {
        const name = String(tool.name || "");
        if (!name) continue;
        out.push({
          serverId: server.id,
          server: server.id,
          name,
          title: tool.title ?? tool.annotations?.title ?? null,
          description: tool.description ?? null,
          inputSchema: tool.inputSchema ?? tool.input_schema ?? undefined,
        });
      }
    }
    return out;
  },
  async callTool<T = unknown>(serverId: string, name: string, arguments_: unknown = {}): Promise<T> {
    return mcpCore.request<T>(serverId, "tools/call", { name, arguments: arguments_ ?? {} });
  },
};

function createMcpProxy(): Moo["mcp"] {
  const serverProxies = new Map<string, Record<string, unknown>>();
  const target = {
    list: () => mcpCore.listServers(),
    tools: (server?: string) => mcpCore.listTools(server),
    listServers: () => mcpCore.listServers(),
    getServer: (id: string) => mcpCore.getServer(id),
    saveServer: (config: McpServerConfig) => mcpCore.saveServer(config),
    removeServer: (id: string) => mcpCore.removeServer(id),
    login: (serverId: string, opts?: McpOAuthStartOptions) => mcpCore.login(serverId, opts),
    completeLogin: (state: string, code: string) => mcpCore.completeLogin(state, code),
    logout: (serverId: string) => mcpCore.logout(serverId),
    authStatus: (serverId: string) => mcpCore.authStatus(serverId),
    listTools: (serverId?: string) => mcpCore.listTools(serverId),
    callTool: <T = unknown>(serverId: string, name: string, arguments_?: unknown) =>
      mcpCore.callTool<T>(serverId, name, arguments_),
    request: <T = unknown>(serverId: string, method: string, params?: unknown) =>
      mcpCore.request<T>(serverId, method, params),
  };
  const getServerProxy = (serverId: string) => {
    let proxy = serverProxies.get(serverId);
    if (!proxy) {
      proxy = new Proxy({}, {
        get(_toolTarget, tool) {
          if (typeof tool !== "string") return undefined;
          if (tool === "then") return undefined;
          return (args?: unknown) => mcpCore.callTool(serverId, tool, args ?? {});
        },
      });
      serverProxies.set(serverId, proxy);
    }
    return proxy;
  };
  return new Proxy(target, {
    get(t, server) {
      if (typeof server !== "string") return undefined;
      if (server === "then") return undefined;
      if (server in t) return t[server as keyof typeof t];
      return getServerProxy(server);
    },
  }) as Moo["mcp"];
}

const mcp: Moo["mcp"] = createMcpProxy();

const events: Moo["events"] = {
  publish(payload) {
    const text =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    __op_broadcast(text);
  },
};

const env: Moo["env"] = {
  async get(name) {
    return __op_env_get(name);
  },
  async getMany(names) {
    const out: Record<string, string | null> = {};
    for (const n of names) out[n] = __op_env_get(n);
    return out;
  },
};


async function recordChatTrailEntry(
  chatId: string,
  kind: string,
  payload: Record<string, unknown>,
  opts: { touch?: boolean } = {},
): Promise<string> {
  if (!chatId) throw new Error("trail entry requires chatId");
  const factsRef = `chat/${chatId}/facts`;
  const graph = `chat:${chatId}`;
  const now = await time.now();
  if (opts.touch) await chat.touch(chatId);
  const entryId = await id.new("trail");
  const payloadHash = await objects.put(
    kind,
    JSON.stringify({ ...payload, at: now }),
  );
  await facts.update(factsRef, (txn) => {
    txn.add(graph, entryId, "rdf:type", "agent:TrailEntry");
    txn.add(graph, entryId, "agent:kind", kind);
    txn.add(graph, entryId, "agent:createdBy", "agent:moo");
    txn.add(graph, entryId, "agent:createdAt", String(now));
    txn.add(graph, entryId, "agent:payload", payloadHash);
  });
  return entryId;
}

async function recordInputRequest(chatId: string, kind: string, spec: unknown): Promise<string> {
  const factsRef = `chat/${chatId}/facts`;
  const graph = `chat:${chatId}`;
  const reqId = await id.new("uireq");
  const payload = await objects.put(kind, JSON.stringify(spec || {}));
  const now = await time.now();
  await facts.update(factsRef, (txn) => {
    txn.add(graph, reqId, "rdf:type", "ui:InputRequest");
    txn.add(graph, reqId, "ui:kind", kind);
    txn.add(graph, reqId, "ui:status", "ui:Pending");
    txn.add(graph, reqId, "ui:payload", payload);
    txn.add(graph, reqId, "ui:createdAt", String(now));
  });
  return reqId;
}


const UI_FIELD_TYPES = new Set(["text", "textarea", "url", "number", "boolean", "select", "secretRef"]);

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateUiOption(option: unknown, path: string): void {
  if (typeof option === "string") return;
  if (!isRecord(option)) throw new Error(path + " must be a string or {label?, value?}");
  if (option.label != null && typeof option.label !== "string") throw new Error(path + ".label must be a string");
  if (option.value != null && typeof option.value !== "string") throw new Error(path + ".value must be a string");
}

function validateAskSpec(spec: unknown): UiAskSpec {
  if (!isRecord(spec)) throw new Error("moo.ui.ask spec must be an object");
  if (spec.title != null && typeof spec.title !== "string") throw new Error("moo.ui.ask spec.title must be a string");
  if (!Array.isArray(spec.fields) || spec.fields.length === 0) {
    throw new Error("moo.ui.ask spec.fields must be a non-empty array");
  }
  for (let i = 0; i < spec.fields.length; i++) {
    const field = spec.fields[i];
    const path = "moo.ui.ask spec.fields[" + i + "]";
    if (!isRecord(field)) throw new Error(path + " must be an object");
    if (typeof field.name !== "string" || field.name.length === 0) throw new Error(path + ".name must be a non-empty string");
    if (field.label != null && typeof field.label !== "string") throw new Error(path + ".label must be a string");
    if (field.type != null && (typeof field.type !== "string" || !UI_FIELD_TYPES.has(field.type))) {
      throw new Error(path + ".type must be one of " + Array.from(UI_FIELD_TYPES).join(", "));
    }
    if (field.required != null && typeof field.required !== "boolean") throw new Error(path + ".required must be a boolean");
    if (field.options != null) {
      if (!Array.isArray(field.options)) throw new Error(path + ".options must be an array");
      field.options.forEach((option: unknown, j: number) => validateUiOption(option, path + ".options[" + j + "]"));
    }
  }
  if (spec.submitLabel != null && typeof spec.submitLabel !== "string") throw new Error("moo.ui.ask spec.submitLabel must be a string");
  return spec as UiAskSpec;
}

function validateChooseSpec(spec: unknown): UiChooseSpec {
  if (!isRecord(spec)) throw new Error("moo.ui.choose spec must be an object");
  if (spec.title != null && typeof spec.title !== "string") throw new Error("moo.ui.choose spec.title must be a string");
  if (!Array.isArray(spec.items) || spec.items.length === 0) {
    throw new Error("moo.ui.choose spec.items must be a non-empty array");
  }
  for (let i = 0; i < spec.items.length; i++) {
    const item = spec.items[i];
    const path = "moo.ui.choose spec.items[" + i + "]";
    if (!isRecord(item)) throw new Error(path + " must be an object");
    if (typeof item.id !== "string" || item.id.length === 0) throw new Error(path + ".id must be a non-empty string");
    if (item.label != null && typeof item.label !== "string") throw new Error(path + ".label must be a string");
    if (item.description != null && typeof item.description !== "string") throw new Error(path + ".description must be a string");
  }
  return spec as UiChooseSpec;
}

const ui: Moo["ui"] = {
  async ask(chatId, spec) {
    return recordInputRequest(chatId, "ui:Form", validateAskSpec(spec));
  },
  async choose(chatId, spec) {
    return recordInputRequest(chatId, "ui:Choice", validateChooseSpec(spec));
  },
  async say(chatId, text) {
    const payload = await objects.put("agent:Reply", JSON.stringify({ text, at: await time.now() }));
    return (await appendStep(chatId, {
      kind: "agent:Reply",
      status: "agent:Done",
      payloadHash: payload,
      extras: [["agent:via", "ui:say"]],
    })).stepId;
  },
};

type ChatFactsSummary = {
  totalFacts: number;
  totalTurns: number;
  totalSteps: number;
  status: string;
};

async function summarizeChatFacts(chatId: string): Promise<ChatFactsSummary> {
  const ref = `chat/${chatId}/facts`;
  const graph = `chat:${chatId}`;
  const [totalFacts, turnRows, pendingInputs, stepRows] = await Promise.all([
    facts.count(ref),
    facts.match(ref, {
      graph,
      predicate: "agent:kind",
      object: "agent:UserInput",
    }),
    facts.matchAll(
      [
        ["?req", "rdf:type", "ui:InputRequest"],
        ["?req", "ui:status", "ui:Pending"],
      ],
      { ref, graph, limit: 1 },
    ),
    facts.matchAll(
      [
        ["?step", "rdf:type", "agent:Step"],
        ["?step", "agent:status", "?status"],
        ["?step", "agent:createdAt", "?at"],
      ],
      { ref, graph },
    ),
  ]);

  let status = "agent:Done";
  if (pendingInputs.length > 0) {
    status = "ui:Pending";
  } else if (stepRows.some((s) => s["?status"] === "agent:Running")) {
    status = "agent:Running";
  } else if (stepRows.some((s) => s["?status"] === "agent:Queued")) {
    status = "agent:Queued";
  } else {
    const latest = stepRows
      .map((s) => ({ status: s["?status"] || "agent:Done", at: Number(s["?at"] || 0) }))
      .sort((a, b) => b.at - a.at)[0];
    status = latest?.status || "agent:Done";
  }

  return {
    totalFacts,
    totalTurns: turnRows.length,
    totalSteps: stepRows.length,
    status,
  };
}
function joinPath(base: string, child: string): string {
  const b = String(base || ".").replace(/\/+$/, "") || ".";
  return b + "/" + child.replace(/^\/+/, "");
}

async function chatScratchRoot(chatId: string): Promise<string> {
  return (await refs.get(`chat/${chatId}/path`)) || ".";
}

function chatWorktreePath(chatId: string, root: string): string {
  return joinPath(root, `.moo/${chatId}`);
}

async function canonicalDir(path: string): Promise<string> {
  const result = await proc.run("pwd", ["-P"], { cwd: path, timeoutMs: 5_000 });
  if (result.code !== 0) return path;
  return result.stdout.trim() || path;
}

const chat: Moo["chat"] = {
  async scratch(chatId) {
    const root = await chatScratchRoot(chatId);
    const path = chatWorktreePath(chatId, root);
    if (await fs.exists(path)) return await canonicalDir(path);
    // If the cwd is a git repo, prefer a real `git worktree add` from HEAD so
    // the agent gets per-chat branches, diffs, and clean state. Fall back to
    // a plain mkdir when not in a repo (or when worktree creation fails).
    if (await fs.exists(joinPath(root, ".git"))) {
      const result = await proc.run(
        "git",
        ["worktree", "add", "--quiet", path, "HEAD"],
        { cwd: root, timeoutMs: 10_000 },
      );
      if (result.code === 0) return await canonicalDir(path);
    }
    await fs.ensureDir(path);
    return await canonicalDir(path);
  },
  async touch(chatId) {
    const createdRef = `chat/${chatId}/created-at`;
    const existing = await refs.get(createdRef);
    if (!existing) {
      await refs.set(createdRef, String(await time.now()));
    }
    await refs.set(`chat/${chatId}/last-at`, String(await time.now()));
  },
  async list() {
    const all = await refs.list("chat/");
    const ids = new Set<string>();
    const byChat = new Map<string, Record<string, string>>();
    for (const name of all) {
      const parts = name.split("/");
      if (parts.length < 3) continue;
      const cid = parts[1]!;
      ids.add(cid);
      const key = parts.slice(2).join("/");
      let refsForChat = byChat.get(cid);
      if (!refsForChat) {
        refsForChat = {};
        byChat.set(cid, refsForChat);
      }
      refsForChat[key] = name;
    }
    const canonicalRoots = new Map<string, Promise<string>>();
    function canonicalRoot(root: string): Promise<string> {
      let promise = canonicalRoots.get(root);
      if (!promise) {
        promise = canonicalDir(root);
        canonicalRoots.set(root, promise);
      }
      return promise;
    }

    const chats = await Promise.all(
      Array.from(ids, async (cid) => {
        const refsForChat = byChat.get(cid) || {};
        const refValue = async (key: string) => {
          const name = refsForChat[key];
          return name ? await refs.get(name) : null;
        };
        const [created, lastAt, head, title, path, archivedRaw, hiddenRaw, parentChatId, usageObj, summary] = await Promise.all([
          refValue("created-at"),
          refValue("last-at"),
          refValue("head"),
          refValue("title"),
          refValue("path"),
          refValue("archived-at"),
          refValue("hidden"),
          refValue("parent"),
          refValue("usage").then(async (usageHash) => {
            if (!usageHash) return null;
            return await objects.getJSON<{ models: Record<string, { input: number; cachedInput: number; output: number }> }>(usageHash);
          }),
          summarizeChatFacts(cid),
        ]);
        const root = path || ".";
        const archivedAt = archivedRaw ? Number(archivedRaw) : null;
        const absoluteRoot = await canonicalRoot(root);
        return {
          chatId: cid,
          title: title || null,
          createdAt: created ? Number(created) : 0,
          lastAt: lastAt ? Number(lastAt) : created ? Number(created) : 0,
          head: head || null,
          path,
          worktreePath: joinPath(absoluteRoot, `.moo/${cid}`),
          archived: archivedAt != null,
          archivedAt,
          hidden: hiddenRaw === "true",
          parentChatId,
          totalFacts: summary.totalFacts,
          totalTurns: summary.totalTurns,
          totalSteps: summary.totalSteps,
          status: summary.status,
          usage: usageObj?.value ?? null,
        };
      }),
    );

    return chats.sort((a, b) => (b.lastAt || b.createdAt || 0) - (a.lastAt || a.createdAt || 0));
  },
  async create(chatId, path = null) {
    let cid = chatId;
    if (!cid) {
      const raw = await id.new("chat");
      cid = raw.replace(/^chat:/, "").slice(0, 12);
    }
    if (path && String(path).trim()) {
      await refs.set(`chat/${cid}/path`, String(path).trim());
    }
    await chat.touch(cid);
    // Do not materialize the per-chat scratch/worktree during creation.
    // Creating a git worktree can be slow in large repositories, and the UI
    // only needs the chat metadata to navigate to an empty chat. The worktree
    // is still created lazily by chat.scratch() before any repo operation or
    // agent run that actually needs it.
    return cid;
  },
  async remove(chatId) {
    if (!chatId) throw new Error("remove requires chatId");
    const root = await chatScratchRoot(chatId);
    const path = chatWorktreePath(chatId, root);
    // If this scratch was set up as a git worktree, the directory contains a
    // .git *file* (not a dir) pointing back at the main repo. Clean it via
    // the git CLI so we don't leave dangling worktree metadata.
    const gitFile = await fs.stat(`${path}/.git`);
    if (gitFile && gitFile.kind === "file") {
      await proc.run(
        "git",
        ["worktree", "remove", "--force", path],
        { timeoutMs: 10_000 },
      );
    } else if (await fs.exists(path)) {
      await proc.run("rm", ["-rf", path], { timeoutMs: 10_000 });
    }
    const all = await refs.list(`chat/${chatId}/`);
    let clearedQuads = 0;
    for (const name of all) {
      if (name.endsWith("/facts")) {
        clearedQuads += await facts.purge(name);
      }
      await refs.delete(name);
    }
    clearedQuads += await facts.purge(`chat/${chatId}/facts`);
    return { chatId, refsDeleted: all.length, quadsCleared: clearedQuads };
  },
  async setTitle(chatId, title) {
    const ref = `chat/${chatId}/title`;
    const previousTitle = await refs.get(ref);
    const nextTitle = title == null || title.trim() === "" ? null : title.trim();
    if (nextTitle == null) {
      await refs.delete(ref);
    } else {
      await refs.set(ref, nextTitle);
    }
    if ((previousTitle || null) !== nextTitle) {
      await recordChatTrailEntry(chatId, "agent:TitleUpdate", {
        title: nextTitle,
        previousTitle: previousTitle || null,
      });
    }
  },
  async recordSummary(chatId, summary, title = null) {
    const body = String(summary ?? "").trim();
    if (!body) throw new Error("recordSummary requires a non-empty summary");
    const cleanTitle = title == null ? null : String(title).trim() || null;
    return await recordChatTrailEntry(chatId, "agent:Summary", {
      title: cleanTitle,
      body,
    }, { touch: true });
  },
  async archive(chatId) {
    const at = String(await time.now());
    await refs.set(`chat/${chatId}/archived-at`, at);
    return Number(at);
  },
  async unarchive(chatId) {
    await refs.delete(`chat/${chatId}/archived-at`);
    return null;
  },
};

const MAX_SUBAGENT_DEPTH = 1;
const MAX_OUTSTANDING_SUBAGENTS_PER_RUNJS = 4;
const DEFAULT_SUBAGENT_TURNS = 6;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60_000;
const MAX_SUBAGENT_TIMEOUT_MS = 30 * 60_000;

type NormalizedSubagentSpec = Required<Pick<SubagentSpec, "label" | "task" | "worktree">> & Omit<SubagentSpec, "label" | "task" | "worktree"> & {
  maxTurns: number;
  timeoutMs: number;
};

function normalizeSubagentSpec(spec: SubagentSpec): NormalizedSubagentSpec {
  if (!spec || typeof spec !== "object") throw new Error("moo.agent.run requires a spec object");
  const label = String(spec.label ?? "").trim();
  const task = String(spec.task ?? "").trim();
  if (!label) throw new Error("moo.agent.run requires spec.label");
  if (!task) throw new Error("moo.agent.run requires spec.task");
  const maxTurns = Math.max(1, Math.min(20, Math.floor(Number(spec.maxTurns ?? DEFAULT_SUBAGENT_TURNS) || DEFAULT_SUBAGENT_TURNS)));
  const timeoutMs = Math.max(1_000, Math.min(MAX_SUBAGENT_TIMEOUT_MS, Math.floor(Number(spec.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS) || DEFAULT_SUBAGENT_TIMEOUT_MS)));
  const worktree = spec.worktree === "inherit" ? "inherit" : "isolated";
  return {
    ...spec,
    label,
    task,
    maxTurns,
    timeoutMs,
    worktree,
    ...(typeof spec.context === "string" && spec.context.trim() ? { context: spec.context } : {}),
    ...(typeof spec.expectedOutput === "string" && spec.expectedOutput.trim() ? { expectedOutput: spec.expectedOutput } : {}),
    ...(typeof spec.model === "string" && spec.model.trim() ? { model: spec.model.trim() } : {}),
    ...(typeof spec.effort === "string" && spec.effort.trim() ? { effort: spec.effort.trim() } : {}),
  };
}

function statusForSubagentResult(status: string): "agent:Done" | "agent:Failed" | "agent:Cancelled" {
  if (status === "done") return "agent:Done";
  if (status === "cancelled") return "agent:Cancelled";
  return "agent:Failed";
}

function truncateTitle(title: string): string {
  const t = String(title || "subagent").replace(/\s+/g, " ").trim() || "subagent";
  return t.length <= 60 ? t : t.slice(0, 57).trimEnd() + "…";
}

async function replaceStepStatus(chatId: string, stepId: string, status: string, extras: Array<[string, string]> = []) {
  const c = chatRefs(chatId);
  const cur = await facts.match(c.facts, { graph: c.graph, subject: stepId, predicate: "agent:status" });
  await facts.update(c.facts, (txn) => {
    for (const [g, s, p, o] of cur) txn.remove(g, s, p, o);
    txn.add(c.graph, stepId, "agent:status", status);
    for (const [p, o] of extras) txn.add(c.graph, stepId, p, o);
  });
}

async function markOutstandingSubagentCancelled(parentChatId: string, childChatId: string, error: string) {
  const stepId = await refs.get(`chat/${childChatId}/parent-step`);
  if (!stepId) return;
  const result: SubagentResult = {
    status: "cancelled",
    childChatId,
    text: "",
    error,
    durationMs: 0,
  };
  const resultHash = await objects.put("agent:ToolResult", JSON.stringify(result));
  await replaceStepStatus(parentChatId, stepId, "agent:Cancelled", [["agent:result", resultHash], ["agent:error", error]]);
}

async function createSubagentRunRequest(spec: NormalizedSubagentSpec) {
  const ctx = activeRunJSContext;
  if (!ctx) throw new Error("moo.agent.run is only available inside runJS");
  if (ctx.depth >= MAX_SUBAGENT_DEPTH) throw new Error("subagent depth limit reached");
  if (ctx.outstanding.size >= MAX_OUTSTANDING_SUBAGENTS_PER_RUNJS) {
    throw new Error(`too many outstanding subagents; max is ${MAX_OUTSTANDING_SUBAGENTS_PER_RUNJS}`);
  }

  const parentChatId = ctx.chatId;
  const childChatId = (await id.new("chat")).replace(/:/g, "-");
  const parentRoot = await refs.get(`chat/${parentChatId}/path`);
  if (parentRoot) await refs.set(`chat/${childChatId}/path`, parentRoot);
  await chat.create(childChatId, parentRoot);
  await chat.setTitle(childChatId, truncateTitle(spec.label));
  await refs.set(`chat/${childChatId}/hidden`, "true");
  await refs.set(`chat/${childChatId}/parent`, parentChatId);
  await refs.set(`chat/${childChatId}/subagent-depth`, String(ctx.depth + 1));
  await refs.set(`chat/${childChatId}/subagent-parent-runjs`, ctx.runJsStepId);
  if (spec.model) await refs.set(chatRefs(childChatId).model, spec.model);
  if (spec.effort) await memory.assert(`chat:${childChatId}`, "ui:effortLevel", spec.effort);

  const specHash = await objects.put("agent:SubagentSpec", JSON.stringify(spec));
  await refs.set(`chat/${childChatId}/subagent-spec`, specHash);

  const payloadHash = await objects.put("agent:Subagent", JSON.stringify({
    label: spec.label,
    task: spec.task,
    context: spec.context ?? null,
    expectedOutput: spec.expectedOutput ?? null,
    childChatId,
    parentRunJsStepId: ctx.runJsStepId,
    spec,
  }));
  const appended = await appendStep(parentChatId, {
    kind: "agent:Subagent",
    status: "agent:Running",
    payloadHash,
    extras: [
      ["agent:childChat", childChatId],
      ["agent:parentRunJS", ctx.runJsStepId],
    ],
  });
  await refs.set(`chat/${childChatId}/parent-step`, appended.stepId);
  ctx.outstanding.add(childChatId);

  if (spec.worktree === "inherit") {
    // Never share writable dirs. For now inherit only selects the same repo root;
    // the child still gets its own lazy git worktree from chat.scratch().
    await refs.set(`chat/${childChatId}/worktree-mode`, "inherit");
  }

  return {
    requestId: await id.new("subagent"),
    parentChatId,
    parentRunJsStepId: ctx.runJsStepId,
    parentSubagentStepId: appended.stepId,
    childChatId,
    spec,
    limits: {
      maxTurns: spec.maxTurns,
      timeoutMs: spec.timeoutMs,
      depth: ctx.depth + 1,
    },
  };
}

async function finishSubagentRun(childChatId: string, result: SubagentResult) {
  const ctx = activeRunJSContext;
  const parentChatId = ctx?.chatId || (await refs.get(`chat/${childChatId}/parent`));
  const stepId = await refs.get(`chat/${childChatId}/parent-step`);
  if (ctx) ctx.outstanding.delete(childChatId);
  if (!parentChatId || !stepId) return;
  const resultHash = await objects.put("agent:ToolResult", JSON.stringify(result));
  const extras: Array<[string, string]> = [["agent:result", resultHash]];
  if (result.error) extras.push(["agent:error", String(result.error)]);
  await replaceStepStatus(parentChatId, stepId, statusForSubagentResult(result.status), extras);
}

async function failSubagentRun(childChatId: string | null, err: unknown) {
  if (!childChatId) return;
  const message = (err as any)?.message || String(err);
  const result: SubagentResult = {
    status: "failed",
    childChatId,
    text: "",
    error: message,
    durationMs: 0,
  };
  await finishSubagentRun(childChatId, result);
}

const agent: Moo["agent"] = {
  async claim(refName, graph, runId, leaseMs = 60_000) {
    const queued = await facts.match(refName, {
      graph,
      predicate: "agent:status",
      object: "agent:Queued",
    });
    for (const [, stepId] of queued) {
      if (runId) {
        const runRows = await facts.match(refName, {
          graph,
          subject: stepId,
          predicate: "agent:run",
          limit: 1,
        });
        if (runRows.length && runRows[0]![3] !== runId) continue;
      }
      const leaseId = await id.new("lease");
      const expiresAt = (await time.now()) + leaseMs;
      await facts.update(refName, (txn) => {
        txn.remove(graph, stepId, "agent:status", "agent:Queued");
        txn.add(graph, stepId, "agent:status", "agent:Running");
        txn.add(graph, stepId, "agent:lease", leaseId);
        txn.add(graph, leaseId, "agent:expiresAt", String(expiresAt));
      });
      return { stepId, leaseId, expiresAt };
    }
    return null;
  },
  async complete(refName, graph, stepId, status = "agent:Done") {
    const cur = await facts.match(refName, {
      graph,
      subject: stepId,
      predicate: "agent:status",
    });
    await facts.update(refName, (txn) => {
      for (const [g, s, p, o] of cur) txn.remove(g, s, p, o);
      txn.add(graph, stepId, "agent:status", status);
    });
  },
  async fork(chatId, fromStepId = null) {
    const c = {
      facts: `chat/${chatId}/facts`,
      run: `chat/${chatId}/run`,
      graph: `chat:${chatId}`,
      head: `chat/${chatId}/head`,
    };
    const runId = await id.new("run");
    const forkedFrom = fromStepId ?? (await refs.get(c.head));
    await refs.set(c.run, runId);
    await facts.update(c.facts, (txn) => {
      txn.add(c.graph, runId, "rdf:type", "agent:Run");
      txn.add(c.graph, runId, "agent:chat", c.graph);
      txn.add(c.graph, runId, "agent:createdBy", "agent:moo");
      if (forkedFrom) txn.add(c.graph, runId, "agent:forkedFrom", forkedFrom);
    });
    return { chatId, runId, forkedFrom };
  },
  async run(spec: SubagentSpec): Promise<SubagentResult> {
    const normalized = normalizeSubagentSpec(spec);
    let request: Awaited<ReturnType<typeof createSubagentRunRequest>> | null = null;
    try {
      request = await createSubagentRunRequest(normalized);
      const raw = await __op_agent_run(JSON.stringify(request));
      const result = JSON.parse(raw) as SubagentResult;
      await finishSubagentRun(request.childChatId, result);
      return result;
    } catch (err) {
      await failSubagentRun(request?.childChatId ?? null, err);
      throw err;
    }
  },
};

// -- cross-chat memory + vocabulary ---------------------------------------
//
// Memory is plain RDF: every fact is a (subject, predicate, object) triple
// stored in graph `memory:facts` under ref `memory/facts`. No envelope
// objects — the LLM writes triples directly.
//
// Vocabulary lives in graph `vocab:facts` under `vocab/facts`. Each declared
// predicate is a subject of type `vocab:Predicate` with rdfs:label,
// vocab:description, and vocab:example annotations. `vocab.list()` merges
// declared metadata with usage counts gathered from the memory graph, so the
// LLM can ask "which verbs exist?" before guessing one.

const MEMORY_REF = "memory/facts";
const MEMORY_GRAPH = "memory:facts";
const PROJECT_MEMORY_REF_PREFIX = "memory/project/";
const PROJECT_MEMORY_GRAPH_PREFIX = "memory:project/";
const ALLOWED_MEMORY_KINDS = new Set([
  "memory:Note",
  "memory:Preference",
  "memory:Decision",
  "memory:Summary",
  "memory:Observation",
]);
function validateMemoryKind(subject: string, predicate: string, object: ObjectInput) {
  const value = object instanceof Term ? object.turtle : String(object);
  if ((predicate === "rdf:type" || predicate === "a") && value.startsWith("memory:") && !ALLOWED_MEMORY_KINDS.has(value)) {
    throw new Error(`unknown memory kind ${value}; use one of ${[...ALLOWED_MEMORY_KINDS].join(", ")}`);
  }
  if (subject.startsWith("memory:") && !ALLOWED_MEMORY_KINDS.has(subject) && !subject.startsWith("memory:item/")) {
    throw new Error(`unknown memory subject template ${subject}`);
  }
}
function encodeProjectMemoryId(projectId: string): string {
  const trimmed = projectId.trim();
  if (!trimmed) throw new Error("project memory id cannot be empty");
  return encodeURIComponent(trimmed).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
async function currentProjectMemoryId(): Promise<string> {
  const git = await proc.run("git", ["rev-parse", "--show-toplevel"], { timeoutMs: 2_000 });
  if (git.code === 0 && git.stdout.trim()) return git.stdout.trim();
  const pwd = await env.get("PWD");
  if (pwd && pwd.trim()) return pwd.trim();
  return ".";
}
function memoryScope(refName: string, graph: string): MemoryScope {
  function encodeMemoryFacts(factsInput: unknown, validate: boolean): Array<[string, string, string]> {
    const seen = new Set<string>();
    const encoded: Array<[string, string, string]> = [];
    for (const [subject, predicate, object] of unpackMemoryFacts(factsInput)) {
      if (validate) validateMemoryKind(subject, predicate, object);
      const value = encodeObject(object);
      const key = JSON.stringify([subject, predicate, value]);
      if (seen.has(key)) continue;
      seen.add(key);
      encoded.push([subject, predicate, value]);
    }
    return encoded;
  }

  async function applyAll(action: "assert" | "retract", factsInput: unknown): Promise<void> {
    const encoded = encodeMemoryFacts(factsInput, action === "assert");
    if (encoded.length === 0) return;
    const quads: Quad[] = encoded.map(([subject, predicate, object]) => [graph, subject, predicate, object]);
    assertFactObjects(quads);
    const present = __op_facts_present(refName, JSON.stringify(quads));
    const changedQuads: Quad[] = [];
    const changes: MemoryChange[] = [];
    for (let i = 0; i < quads.length; i++) {
      const shouldChange = action === "assert" ? !present[i] : present[i];
      if (!shouldChange) continue;
      const quad = quads[i]!;
      changedQuads.push(quad);
      changes.push({ subject: quad[1], predicate: quad[2], object: quad[3] });
    }
    if (changedQuads.length === 0) return;
    if (action === "assert") {
      await facts.swap(refName, [], changedQuads);
    } else {
      await facts.swap(refName, changedQuads, []);
    }
    await recordMemoryDiff(refName, graph, action, changes);
  }

  return {
    async assert(subjectOrFacts, predicate?, object?) {
      if (Array.isArray(subjectOrFacts) && predicate === undefined && object === undefined) {
        return this.assertAll(subjectOrFacts);
      }
      if (predicate == null || object == null) throw new Error("memory.assert requires subject, predicate, object");
      return applyAll("assert", [[String(subjectOrFacts), String(predicate), object as ObjectInput]]);
    },
    async assertAll(factsInput) {
      return applyAll("assert", factsInput);
    },
    async retract(subjectOrFacts, predicate?, object?) {
      if (Array.isArray(subjectOrFacts) && predicate === undefined && object === undefined) {
        return this.retractAll(subjectOrFacts);
      }
      if (predicate == null || object == null) throw new Error("memory.retract requires subject, predicate, object");
      return applyAll("retract", [[String(subjectOrFacts), String(predicate), object as ObjectInput]]);
    },
    async retractAll(factsInput) {
      return applyAll("retract", factsInput);
    },
    async query(patterns, opts) {
      const encoded: Triple[] = patterns.map(([s, p, o]) => [
        s as string,
        p as string,
        typeof o === "string" && o.startsWith("?")
          ? o
          : encodeObject(o as ObjectInput),
      ]);
      return facts.matchAll(encoded, {
        ref: refName,
        graph,
        ...(opts?.limit ? { limit: opts.limit } : {}),
      });
    },
    async triples(opts) {
      return facts.match(refName, {
        graph,
        subject: opts?.subject ?? null,
        predicate: opts?.predicate ?? null,
        object: opts?.object == null ? null : encodeObject(opts.object as ObjectInput),
        ...(opts?.limit ? { limit: opts.limit } : {}),
      });
    },
  };
}
const globalMemory = memoryScope(MEMORY_REF, MEMORY_GRAPH);
const memory: Moo["memory"] = Object.assign(globalMemory, {
  project(projectId?: string): MemoryScope {
    let cached: MemoryScope | null = null;
    let pending: Promise<MemoryScope> | null = null;
    async function resolve(): Promise<MemoryScope> {
      if (cached) return cached;
      if (!pending) {
        pending = (async () => {
          const raw = projectId == null ? await currentProjectMemoryId() : projectId;
          const id = encodeProjectMemoryId(raw);
          const refName = `${PROJECT_MEMORY_REF_PREFIX}${id}/facts`;
          const graph = `${PROJECT_MEMORY_GRAPH_PREFIX}${id}`;
          await refs.set(refName, raw);
          cached = memoryScope(refName, graph);
          return cached;
        })();
      }
      return pending;
    }
    return {
      async assert(subjectOrFacts, predicate?, object?) {
        return (await resolve()).assert(subjectOrFacts as any, predicate as any, object as any);
      },
      async assertAll(factsInput) {
        return (await resolve()).assertAll(factsInput);
      },
      async retract(subjectOrFacts, predicate?, object?) {
        return (await resolve()).retract(subjectOrFacts as any, predicate as any, object as any);
      },
      async retractAll(factsInput) {
        return (await resolve()).retractAll(factsInput);
      },
      async query(patterns, opts) {
        return (await resolve()).query(patterns, opts);
      },
      async triples(opts) {
        return (await resolve()).triples(opts);
      },
    };
  },
});

const VOCAB_REF = "vocab/facts";
const VOCAB_GRAPH = "vocab:facts";

const vocab: Moo["vocab"] = {
  async define(name, opts) {
    if (!name || !name.trim()) throw new Error("vocab.define requires name");
    // Subject is the literal predicate as used in triples — no auto-prefix.
    // That way `vocab.define('prefers',…)` annotates the same predicate the
    // agent uses in `moo.memory.assert(s,'prefers',o)`.
    const subject = name;
    await facts.update(VOCAB_REF, (txn) => {
      txn.add(VOCAB_GRAPH, subject, "rdf:type", "vocab:Predicate");
      txn.add(VOCAB_GRAPH, subject, "rdfs:label", opts?.label || name);
      if (opts?.description) {
        txn.add(VOCAB_GRAPH, subject, "vocab:description", opts.description);
      }
      if (opts?.example) {
        txn.add(VOCAB_GRAPH, subject, "vocab:example", opts.example);
      }
    });
  },
  async list() {
    // Declared predicates: read all subjects of type vocab:Predicate plus
    // their annotations.
    const declared = await facts.match(VOCAB_REF, {
      graph: VOCAB_GRAPH,
    });
    const byPredicate = new Map<
      string,
      { label: string | null; description: string | null; example: string | null }
    >();
    const isPredicate = new Set<string>();
    for (const [, s, p, o] of declared) {
      if (p === "rdf:type" && o === "vocab:Predicate") {
        isPredicate.add(s);
        if (!byPredicate.has(s)) {
          byPredicate.set(s, { label: null, description: null, example: null });
        }
      }
    }
    for (const [, s, p, o] of declared) {
      if (!isPredicate.has(s)) continue;
      const entry = byPredicate.get(s)!;
      if (p === "rdfs:label") entry.label = o;
      else if (p === "vocab:description") entry.description = o;
      else if (p === "vocab:example") entry.example = o;
    }

    // Observed predicates: count occurrences in memory, vocab, project, and chat fact graphs.
    const memoryRefs = [
      MEMORY_REF,
      VOCAB_REF,
      ...(await refs.list(PROJECT_MEMORY_REF_PREFIX)),
      ...(await refs.list("chat/")).filter((refName) =>
        refName.startsWith("chat/") && refName.endsWith("/facts"),
      ),
    ];
    const counts = new Map<string, number>();
    for (const refName of memoryRefs) {
      const observed = await facts.match(refName);
      for (const [, , p] of observed) {
        counts.set(p, (counts.get(p) || 0) + 1);
      }
    }

    // Backward-compat: older harness builds wrote vocab subjects as
    // "vocab:<name>". Treat those as describing the bare "<name>" predicate
    // so they line up with observed counts.
    const canonical = (s: string) =>
      s.startsWith("vocab:") ? s.slice("vocab:".length) : s;

    const out: Awaited<ReturnType<Moo["vocab"]["list"]>> = [];
    const seen = new Set<string>();
    for (const [subject, meta] of byPredicate) {
      const name = canonical(subject);
      seen.add(name);
      out.push({
        name,
        declared: true,
        count: counts.get(name) || 0,
        ...meta,
      });
    }
    for (const [name, count] of counts) {
      if (seen.has(name)) continue;
      out.push({
        name,
        declared: false,
        count,
        label: null,
        description: null,
        example: null,
      });
    }
    out.sort((a, b) =>
      b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    return out;
  },
};

export const moo: Moo = {
  time,
  id,
  log,
  objects,
  refs,
  sparql,
  facts,
  fs,
  proc,
  http,
  env,
  chat,
  ui,
  mcp,
  agent,
  memory,
  vocab,
  events,
  term,
};
