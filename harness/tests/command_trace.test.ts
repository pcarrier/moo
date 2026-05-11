import { beforeEach, describe, expect, test } from "bun:test";

type Root = { id: string; kind: string; name: string; chatId?: string | null; data?: Record<string, unknown> };
type Span = { id: string; parentId: string; data?: Record<string, unknown> };
type Row = { id: string; rootId: string; rootKind: string; data?: Record<string, unknown> | null };

const roots = new Map<string, Root>();
const spans = new Map<string, Span>();
const rows = new Map<string, Row>();
const finished: Array<{ id: string; status: string; data: unknown }> = [];
let currentTrace: { traceId: string; rootId: string; parentId: string } | null = null;
let traceSeq = 0;
let objectSeq = 0;

function installOps() {
  const g = globalThis as any;
  g.__op_now = () => 1_000;
  g.__op_id = (prefix: string) => `${prefix}:1`;
  g.__op_sha256_base64url = () => "hash";
  g.__op_env_get = () => null;
  g.__op_broadcast = () => {};
  g.__op_ref_get = () => null;
  g.__op_ref_set = () => true;
  g.__op_ref_cas = () => true;
  g.__op_ref_delete = () => true;
  g.__op_refs_list = () => [];
  g.__op_refs_entries = () => "[]";
  g.__op_object_put = () => `sha256:${String(++objectSeq).padStart(64, "0")}`;
  g.__op_object_get = () => null;
  g.__op_http_fetch = () => ({ status: 200, headers: "{}", body: "{}" });
  g.__op_http_stream_open = () => ({ handle: 1, status: 200, headers: "{}" });
  g.__op_http_stream_next = () => null;
  g.__op_http_stream_close = () => {};
  g.__op_fs_read = () => { throw new Error("unexpected read"); };
  g.__op_fs_write = () => {};
  g.__op_fs_delete = () => {};
  g.__op_fs_mkdir = () => {};
  g.__op_fs_list = () => [];
  g.__op_fs_glob = () => [];
  g.__op_fs_stat = () => null;
  g.__op_fs_canonical = (path: string) => path;
  g.__op_proc_run = () => ({ code: 0, stdout: "", stderr: "", durationNs: 0, timedOut: false });
  g.__op_facts_add = () => {};
  g.__op_facts_remove = () => {};
  g.__op_facts_present = () => [];
  g.__op_facts_match = () => [];
  g.__op_facts_match_all = () => [];
  g.__op_facts_history = () => [];
  g.__op_facts_refs = () => [];
  g.__op_facts_count = () => 0;
  g.__op_chat_fact_summaries = () => "[]";
  g.__op_facts_swap = () => {};
  g.__op_facts_snapshot_copy = () => 0;
  g.__op_facts_clear = () => 0;
  g.__op_facts_purge = () => 0;
  g.__op_facts_purge_graph = () => 0;
  g.__op_sparql_query = () => ({ type: "select", result: [] });
  g.__op_chat_running_ids = () => "[]";
  g.__op_chat_running_started_at = () => "{}";
  g.__op_agent_run = async () => JSON.stringify({ status: "ok", childChatId: "child", output: null, durationNs: 0 });
  g.__op_llm_stream_chat = () => "";
  g.__op_trace_current = () => currentTrace ? JSON.stringify(currentTrace) : null;
  g.__op_trace_get = (raw: string) => {
    const args = JSON.parse(raw || "{}");
    const id = args.traceId || args.id;
    const row = rows.get(id);
    if (!row) return null;
    return JSON.stringify({ ...row, data: row.data ?? null });
  };
  g.__op_trace_events = () => "[]";
  g.__op_trace_recent = () => "[]";
  g.__op_trace_insert = () => null;
  g.__op_trace_finish = (id: string, status = "ok", dataJson = "{}") => {
    finished.push({ id, status, data: JSON.parse(dataJson || "{}") });
    return "true";
  };
  g.__op_trace_set_parent = () => null;
  g.__op_trace_leave = () => { currentTrace = null; };
  g.__op_trace_ensure_root = (optsJson: string) => {
    const root = JSON.parse(optsJson) as Root;
    roots.set(root.id, root);
    rows.set(root.id, { id: root.id, rootId: root.id, rootKind: root.kind, data: root.data ?? null });
  };
  g.__op_trace_ensure_span = (optsJson: string) => {
    const span = JSON.parse(optsJson) as Span;
    spans.set(span.id, span);
  };
  g.__op_trace_start_root = (parentId: string, dataJson = "{}") => {
    const traceId = `trace:${++traceSeq}`;
    const root = rows.get(parentId) ?? { id: parentId, rootId: parentId, rootKind: "system", data: null };
    rows.set(traceId, { id: traceId, rootId: root.rootId, rootKind: root.rootKind, data: JSON.parse(dataJson || "{}") });
    currentTrace = { traceId, rootId: traceId, parentId: traceId };
    return JSON.stringify(currentTrace);
  };
}

installOps();
const { dispatch } = await import("../src/commands");

describe("command tracing", () => {
  beforeEach(() => {
    roots.clear();
    spans.clear();
    rows.clear();
    finished.length = 0;
    currentTrace = null;
    traceSeq = 0;
    objectSeq = 0;
  });

  test("finishes the visible command root", async () => {
    const result = await dispatch({ command: "unknown-test-command", chatId: "chat1" } as any);

    expect(result).toEqual({ ok: false, error: { message: "unknown command: unknown-test-command" } });
    expect(roots.get("command:unknown-test-command:chat1")?.kind).toBe("command");
    expect(finished.map((row) => row.id)).toEqual(["trace:1", "command:unknown-test-command:chat1"]);
    expect(finished.every((row) => row.status === "error")).toBe(true);
    expect(currentTrace).toBeNull();
  });
});
