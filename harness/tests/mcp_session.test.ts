import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const refs = new Map<string, string>();
const objects = new Map<string, { kind: string; content: string }>();
const httpCalls: Array<{ method: string; url: string; headers: Record<string, string>; body: any }> = [];
const refSetCalls: Array<{ name: string; target: string }> = [];
let objectId = 0;
let now = 1_000;

(globalThis as any).__op_now = () => now++;
(globalThis as any).__op_id = (prefix: string) => `${prefix}:1`;
(globalThis as any).__op_sha256_base64url = () => "hash";
(globalThis as any).__op_env_get = () => null;
(globalThis as any).__op_broadcast = () => {};
(globalThis as any).__op_ref_get = (name: string) => refs.get(name) ?? null;
(globalThis as any).__op_ref_set = (name: string, target: string) => { refSetCalls.push({ name, target }); refs.set(name, target); return true; };
(globalThis as any).__op_ref_cas = (name: string, expected: string | null, next: string) => {
  if ((refs.get(name) ?? null) !== expected) return false;
  refs.set(name, next);
  return true;
};
(globalThis as any).__op_ref_delete = (name: string) => refs.delete(name);
(globalThis as any).__op_refs_list = (prefix = "") => [...refs.keys()].filter((name) => name.startsWith(prefix));
(globalThis as any).__op_refs_entries = (prefix = "") => JSON.stringify([...refs.entries()].filter(([name]) => name.startsWith(prefix)).map(([name, target]) => ({ name, target })));
(globalThis as any).__op_object_put = (kind: string, content: string) => {
  const hash = "sha256:" + String(++objectId).padStart(64, "0");
  objects.set(hash, { kind, content });
  return hash;
};
(globalThis as any).__op_object_get = (hash: string) => objects.get(hash) ?? null;
(globalThis as any).__op_http_fetch = (method: string, url: string, headersJson: string, body: string | null) => {
  const parsedBody = body ? JSON.parse(body) : null;
  httpCalls.push({ method, url, headers: JSON.parse(headersJson || "{}"), body: parsedBody });
  return {
    status: 200,
    headers: JSON.stringify({ "mcp-session-id": "session-1" }),
    body: JSON.stringify({ jsonrpc: "2.0", id: parsedBody?.id ?? null, result: parsedBody?.method === "tools/list" ? { tools: [] } : {} }),
  };
};
(globalThis as any).__op_http_stream_open = () => ({ handle: 1, status: 200, headers: "{}" });
(globalThis as any).__op_http_stream_next = () => null;
(globalThis as any).__op_http_stream_close = () => {};
(globalThis as any).__op_fs_read = () => { throw new Error("unexpected read"); };
(globalThis as any).__op_fs_write = () => {};
(globalThis as any).__op_fs_delete = () => {};
(globalThis as any).__op_fs_mkdir = () => {};
(globalThis as any).__op_fs_list = () => [];
(globalThis as any).__op_fs_glob = () => [];
(globalThis as any).__op_fs_stat = () => null;
(globalThis as any).__op_fs_canonical = (path: string) => path;
(globalThis as any).__op_proc_run = () => ({ code: 0, stdout: "", stderr: "", durationNs: 0, timedOut: false });
(globalThis as any).__op_facts_add = () => {};
(globalThis as any).__op_facts_remove = () => {};
(globalThis as any).__op_facts_present = () => [];
(globalThis as any).__op_facts_match = () => [];
(globalThis as any).__op_facts_match_all = () => [];
(globalThis as any).__op_facts_history = () => [];
(globalThis as any).__op_facts_refs = () => [];
(globalThis as any).__op_facts_count = () => 0;
(globalThis as any).__op_chat_fact_summaries = () => "[]";
(globalThis as any).__op_facts_swap = () => {};
(globalThis as any).__op_facts_snapshot_copy = () => 0;
(globalThis as any).__op_facts_clear = () => 0;
(globalThis as any).__op_facts_purge = () => 0;
(globalThis as any).__op_facts_purge_graph = () => 0;
(globalThis as any).__op_sparql_query = () => ({ type: "select", result: [] });
(globalThis as any).__op_chat_running_ids = () => "[]";
(globalThis as any).__op_chat_running_started_at = () => "{}";
(globalThis as any).__op_agent_run = async () => JSON.stringify({ status: "ok", childChatId: "child", output: null, durationNs: 0 });
(globalThis as any).__op_llm_stream_chat = () => "";
(globalThis as any).__op_trace_current = () => null;
(globalThis as any).__op_trace_get = () => null;
(globalThis as any).__op_trace_events = () => "[]";
(globalThis as any).__op_trace_recent = () => "[]";
(globalThis as any).__op_trace_insert = () => null;
(globalThis as any).__op_trace_finish = () => true;
(globalThis as any).__op_trace_set_parent = () => null;
(globalThis as any).__op_trace_leave = () => {};
(globalThis as any).__op_trace_ensure_root = () => {};
(globalThis as any).__op_trace_start_root = () => "trace";

const { moo } = await import("../src/moo");

function sessionPointer(): string {
  const value = refs.get("mcp/test/session");
  if (!value) throw new Error("missing MCP session pointer");
  return value;
}

function sessionValue(): any {
  const target = sessionPointer();
  expect(target.startsWith("json:")).toBe(true);
  return JSON.parse(target.slice("json:".length));
}

function sessionBlobCount(): number {
  return [...objects.values()].filter((object) => object.kind === "mcp:Session").length;
}

function sessionRefSetCount(): number {
  return refSetCalls.filter((call) => call.name === "mcp/test/session").length;
}

beforeEach(async () => {
  refs.clear();
  objects.clear();
  httpCalls.length = 0;
  refSetCalls.length = 0;
  objectId = 0;
  now = 1_000;
  await moo.mcp.saveServer({ id: "test", url: "https://mcp.example/rpc", transport: "http", enabled: true });
  refSetCalls.length = 0;
});

describe("MCP session persistence", () => {
  test("stores sessions inline in the session pointer without mcp:Session blobs", async () => {
    await moo.mcp.request("test", "tools/list", {});

    expect(sessionBlobCount()).toBe(0);
    expect(sessionValue()).toEqual({ id: "session-1", initializedAt: 1000 });
    expect(httpCalls.map((call) => call.body.method)).toEqual(["initialize", "tools/list"]);
    expect(httpCalls[0].headers["Mcp-Session-Id"]).toBeUndefined();
    expect(httpCalls[1].headers["Mcp-Session-Id"]).toBe("session-1");
  });

  test("does not rewrite the session pointer for repeated responses with the same id", async () => {
    await moo.mcp.request("test", "tools/list", {});
    const firstTarget = sessionPointer();
    const sessionSetsAfterFirstRequest = sessionRefSetCount();

    await moo.mcp.request("test", "tools/list", {});

    expect(sessionPointer()).toBe(firstTarget);
    expect(sessionBlobCount()).toBe(0);
    expect(sessionRefSetCount()).toBe(sessionSetsAfterFirstRequest);
    expect(httpCalls.length).toBe(3);
    expect(httpCalls[2].headers["Mcp-Session-Id"]).toBe("session-1");
  });
});

describe("MCP OAuth discovery", () => {
  const originalFetch = (globalThis as any).__op_http_fetch;

  beforeEach(() => {
    (globalThis as any).__op_http_fetch = (
      method: string,
      url: string,
      headersJson: string,
      body: string | null,
    ) => {
      const parsedBody = body ? JSON.parse(body) : null;
      httpCalls.push({ method, url, headers: JSON.parse(headersJson || "{}"), body: parsedBody });
      if (url === "https://mcp.example/.well-known/oauth-protected-resource/rpc") {
        return {
          status: 200,
          headers: "{}",
          body: JSON.stringify({ authorization_servers: ["https://github.com/login/oauth"] }),
        };
      }
      if (url === "https://github.com/.well-known/oauth-authorization-server/login/oauth") {
        return {
          status: 200,
          headers: "{}",
          body: JSON.stringify({
            authorization_endpoint: "https://github.com/login/oauth/authorize",
            token_endpoint: "https://github.com/login/oauth/access_token",
          }),
        };
      }
      return {
        status: 200,
        headers: JSON.stringify({ "mcp-session-id": "session-1" }),
        body: JSON.stringify({ jsonrpc: "2.0", id: parsedBody?.id ?? null, result: parsedBody?.method === "tools/list" ? { tools: [] } : {} }),
      };
    };
  });

  afterEach(() => {
    (globalThis as any).__op_http_fetch = originalFetch;
  });

  test("discovers authorization server metadata at the issuer root per RFC 8414", async () => {
    const start = await moo.mcp.login("test", { redirectUri: "http://127.0.0.1:7777/mcp/oauth/callback" });
    const fetchedUrls = httpCalls.map((call) => call.url);
    expect(fetchedUrls).toContain("https://mcp.example/.well-known/oauth-protected-resource/rpc");
    expect(fetchedUrls).toContain("https://github.com/.well-known/oauth-authorization-server/login/oauth");
    expect(fetchedUrls).not.toContain("https://github.com/login/oauth/.well-known/oauth-authorization-server");
    expect(start.authorizeUrl.startsWith("https://github.com/login/oauth/authorize?")).toBe(true);
  });
});
