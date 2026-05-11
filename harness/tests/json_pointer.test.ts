import { beforeEach, describe, expect, test } from "bun:test";

const refs = new Map<string, string>();
const objects = new Map<string, { kind: string; content: string }>();
let objectId = 0;
let now = 1_000;

(globalThis as any).__op_now = () => now++;
(globalThis as any).__op_id = (prefix: string) => `${prefix}:1`;
(globalThis as any).__op_sha256_base64url = () => "hash";
(globalThis as any).__op_env_get = () => null;
(globalThis as any).__op_broadcast = () => {};
(globalThis as any).__op_ref_get = (name: string) => refs.get(name) ?? null;
(globalThis as any).__op_ref_set = (name: string, target: string) => { refs.set(name, target); return true; };
(globalThis as any).__op_ref_cas = (name: string, expected: string | null, next: string) => {
  if ((refs.get(name) ?? null) !== expected) return false;
  refs.set(name, next);
  return true;
};
(globalThis as any).__op_ref_delete = (name: string) => refs.delete(name);
(globalThis as any).__op_refs_list = (prefix = "") => [...refs.keys()].filter((name) => name.startsWith(prefix));
(globalThis as any).__op_refs_entries = (prefix = "") => JSON.stringify([...refs.entries()].filter(([name]) => name.startsWith(prefix)).map(([name, target]) => [name, target]));
(globalThis as any).__op_object_put = (kind: string, content: string) => {
  const hash = "sha256:" + String(++objectId).padStart(64, "0");
  objects.set(hash, { kind, content });
  return hash;
};
(globalThis as any).__op_object_get = (hash: string) => objects.get(hash) ?? null;
(globalThis as any).__op_http_fetch = () => ({ status: 200, headers: "{}", body: "{}" });
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
const { uiStateGetCommand, uiStateSetCommand } = await import("../src/commands/ui");
const { recordUsage } = await import("../src/agent");

beforeEach(() => {
  refs.clear();
  objects.clear();
  objectId = 0;
  now = 1_000;
});

describe("inline JSON pointer targets", () => {
  test("stores and reads UI state directly in the pointer", async () => {
    const set = await uiStateSetCommand({ instanceId: "inst1", state: { count: 1 } } as any);

    expect(set.ok).toBe(true);
    expect(refs.get("uiinst/inst1/state")).toBe('json:{"count":1}');
    expect([...objects.values()].filter((object) => object.kind === "ui:State")).toHaveLength(0);

    const get = await uiStateGetCommand({ instanceId: "inst1" } as any);
    expect(get.ok && get.value.state).toEqual({ count: 1 });
    expect(get.ok && "hash" in get.value).toBe(false);
  });
});
