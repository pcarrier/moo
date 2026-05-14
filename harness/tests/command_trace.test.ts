import { beforeEach, describe, expect, test } from "bun:test";

type Root = { id: string; kind: string; name: string; status?: string; chatId?: string | null; data?: Record<string, unknown> };
type Span = { id: string; parentId: string; data?: Record<string, unknown> };
type Row = { id: string; rootId: string; rootKind: string; parentId?: string | null; data?: Record<string, unknown> | null };

const roots = new Map<string, Root>();
const spans = new Map<string, Span>();
const rows = new Map<string, Row>();
const objectPuts: Array<{ kind: string; content: string }> = [];
const finished: Array<{ id: string; status: string; data: unknown }> = [];
let currentTrace: { id: string; traceId: string; rootId: string; parentId: string } | null = null;
let traceSeq = 0;
let objectSeq = 0;

function installOps() {
  const g = globalThis as any;
  g.__op_now = () => 1_000;
  g.__op_id = (prefix: string) => `${prefix}:${++traceSeq}`;
  g.__op_sha256_base64url = () => "hash";
  g.__op_env_get = () => null;
  g.__op_broadcast = () => {};
  g.__op_ref_get = () => null;
  g.__op_ref_set = () => true;
  g.__op_ref_cas = () => true;
  g.__op_ref_delete = () => true;
  g.__op_refs_list = () => [];
  g.__op_refs_entries = () => "[]";
  g.__op_object_put = (kind: string, content: string) => {
    objectPuts.push({ kind, content });
    return `sha256:${String(++objectSeq).padStart(64, "0")}`;
  };
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
    const id = args.id || args.traceId;
    const row = rows.get(id);
    if (!row) return null;
    return JSON.stringify({ ...row, data: row.data ?? null });
  };
  g.__op_trace_events = () => "[]";
  g.__op_trace_recent = () => "[]";
  g.__op_trace_insert = () => null;
  g.__op_trace_finish = (id: string, status = "ok", dataJson = "{}") => {
    finished.push({ id, status, data: JSON.parse(dataJson || "{}") });
    if (currentTrace?.id === id) currentTrace = null;
    return "true";
  };
  g.__op_trace_set_parent = () => null;
  g.__op_trace_leave = () => { currentTrace = null; };
  g.__op_trace_ensure_root = (optsJson: string) => {
    const root = JSON.parse(optsJson) as Root;
    roots.set(root.id, root);
    if (!rows.has(root.id)) rows.set(root.id, { id: root.id, rootId: root.id, rootKind: root.kind, parentId: null, data: root.data ?? null });
  };
  g.__op_trace_ensure_span = (optsJson: string) => {
    const span = JSON.parse(optsJson) as Span;
    spans.set(span.id, span);
    const parent = rows.get(span.parentId);
    if (!rows.has(span.id)) rows.set(span.id, { id: span.id, rootId: parent?.rootId ?? span.parentId, rootKind: parent?.rootKind ?? "system", parentId: span.parentId, data: span.data ?? null });
  };
  g.__op_trace_start_root = () => { throw new Error("legacy trace root API should not be used"); };
  g.__op_trace_enter = (optsJson: string) => {
    const opts = JSON.parse(optsJson || "{}");
    if (!rows.has(opts.id)) {
      if (!opts.rootId || !rows.has(opts.rootId)) return null;
      currentTrace = { id: opts.id, traceId: opts.rootId, rootId: opts.rootId, parentId: opts.id };
      return JSON.stringify(currentTrace);
    }
    currentTrace = { id: opts.id, traceId: opts.rootId, rootId: opts.rootId, parentId: opts.id };
    return JSON.stringify(currentTrace);
  };
}

installOps();
const { dispatch } = await import("../src/commands");
const { reply } = await import("../src/agent");

describe("command tracing", () => {
  beforeEach(() => {
    roots.clear();
    spans.clear();
    rows.clear();
    objectPuts.length = 0;
    finished.length = 0;
    currentTrace = null;
    traceSeq = 0;
    objectSeq = 0;
  });

  test("finishes the visible command root", async () => {
    const result = await dispatch({ command: "unknown-test-command", chatId: "chat1" } as any);

    expect(result).toEqual({ ok: false, error: { message: "unknown command: unknown-test-command" } });
    expect(roots.get("chattrace:chat1")?.kind).toBe("chat");
    expect(finished.map((row) => row.id)).toEqual(["command:unknown-test-command:trace:1"]);
    expect(finished.every((row) => row.status === "error")).toBe(true);
    expect(currentTrace).toBeNull();
  });

  test("falls back to the command root when trace_enter cannot see the command span", async () => {
    const originalEnsureSpan = (globalThis as any).__op_trace_ensure_span;
    (globalThis as any).__op_trace_ensure_span = (optsJson: string) => {
      const span = JSON.parse(optsJson) as Span;
      spans.set(span.id, span);
    };
    try {
      const result = await dispatch({ command: "llm-stream-accumulate", chatId: "chat1", state: {}, events: [] } as any);

      expect(result).toEqual({ ok: true, value: expect.any(Object) });
      expect(roots.get("chattrace:chat1")?.kind).toBe("chat");
      expect(spans.has("command:llm-stream-accumulate:trace:1")).toBe(true);
      expect(currentTrace).toBeNull();
      expect(finished.some((row) => row.id === "command:llm-stream-accumulate:trace:1" && row.status === "ok")).toBe(true);
      expect(finished.some((row) => row.id === "chattrace:chat1")).toBe(false);
    } finally {
      (globalThis as any).__op_trace_ensure_span = originalEnsureSpan;
    }
  });

  test("persists model reasoning content with replies", async () => {
    const reasoning = "**thinking**\n\n- item";
    await reply("chat1", "answer", "deepseek-v4-pro", "max", 123, "draft1", reasoning);

    const payload = objectPuts.find((put) => put.kind === "agent:Reply");
    expect(payload).toBeDefined();
    expect(JSON.parse(payload!.content)).toMatchObject({
      text: "answer",
      draftId: "draft1",
      reasoningContent: reasoning,
    });
  });

  test("persists reasoning-only tool-call drafts", async () => {
    const reasoning = "checked tools first";
    const result = await dispatch({
      command: "step-next",
      state: {
        chatId: "chat1",
        phase: "handleLlm",
        thoughtDurationNs: 0,
        inflight: {
          purpose: "step",
          draftId: "draft2",
          messages: [],
          requestModel: "deepseek-v4-pro",
          requestEffort: "max",
          countThoughtDuration: true,
        },
      },
      llmResult: {
        status: 200,
        ok: true,
        content: "",
        reasoningContent: reasoning,
        toolCalls: [{ id: "call_1", type: "function", function: { name: "runTS", arguments: "{}" } }],
        errorBody: null,
        model: "deepseek-v4-pro",
        usage: null,
      },
    } as any);

    expect(result.ok).toBe(true);
    const payload = objectPuts.find((put) => put.kind === "agent:Reply");
    expect(payload).toBeDefined();
    expect(JSON.parse(payload!.content)).toMatchObject({
      text: "",
      draftId: "draft2",
      reasoningContent: reasoning,
    });
  });
});


describe("LLM stream provider details", () => {
  beforeEach(() => {
    roots.clear();
    spans.clear();
    rows.clear();
    objectPuts.length = 0;
    finished.length = 0;
    currentTrace = null;
    traceSeq = 0;
    objectSeq = 0;
  });

  test("parses DeepSeek think tags out of streamed content", async () => {
    const accumulated = await dispatch({
      command: "llm-stream-accumulate",
      chatId: "chat1",
      state: {},
      streamEvents: { provider: "deepseek", model: "deepseek-v4-pro", draftEvent: { kind: "draft", chatId: "chat1", draftId: "draft1" } },
      events: [
        JSON.stringify({ choices: [{ delta: { content: "<thi" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "nk>think" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "ing</thi" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "nk> summary" } }] }),
      ],
    } as any);
    expect(accumulated.ok).toBe(true);
    expect((accumulated.value as any).state.content).toBe(" summary");
    expect((accumulated.value as any).state.reasoningContent).toBe("thinking");
    expect((accumulated.value as any).events.some((ev: any) => ev.kind === "reasoning-draft" && ev.reasoningContent === "thinking")).toBe(true);
    expect((accumulated.value as any).events.some((ev: any) => ev.kind === "draft" && ev.content === " summary")).toBe(true);

    const finalized = await dispatch({ command: "llm-stream-finalize", chatId: "chat1", state: (accumulated.value as any).state, status: 200 } as any);
    expect(finalized.ok).toBe(true);
    expect((finalized.value as any).content).toBe(" summary");
    expect((finalized.value as any).reasoningContent).toBe("thinking");
  });

  test("strips DeepSeek non-think closing marker", async () => {
    const accumulated = await dispatch({
      command: "llm-stream-accumulate",
      chatId: "chat1",
      state: {},
      streamEvents: { provider: "deepseek", model: "deepseek-v4-flash" },
      events: [
        JSON.stringify({ choices: [{ delta: { content: "</thi" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "nk> summary" } }] }),
      ],
    } as any);
    expect(accumulated.ok).toBe(true);
    expect((accumulated.value as any).state.content).toBe(" summary");
    expect((accumulated.value as any).state.reasoningContent).toBe("");
  });

  test("preserves DeepSeek reasoning content for tool-call continuations", async () => {
    const accumulated = await dispatch({
      command: "llm-stream-accumulate",
      chatId: "chat1",
      state: {},
      events: [
        JSON.stringify({ choices: [{ delta: { reasoning_content: "think ", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "runTS", arguments: "{\"code\"" } }] } }] }),
        JSON.stringify({ choices: [{ delta: { reasoning_content: "more", tool_calls: [{ index: 0, function: { arguments: ":\"return 1\"}" } }] } }] }),
      ],
    } as any);
    expect(accumulated.ok).toBe(true);
    expect((accumulated.value as any).state.reasoningContent).toBe("think more");
    expect((accumulated.value as any).state.toolCalls[0].function.arguments).toBe('{"code":"return 1"}');

    const finalized = await dispatch({ command: "llm-stream-finalize", chatId: "chat1", state: (accumulated.value as any).state, status: 200 } as any);
    expect(finalized.ok).toBe(true);
    expect((finalized.value as any).reasoningContent).toBe("think more");
  });
});
