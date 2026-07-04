import { beforeEach, describe, expect, test } from "bun:test";

const refs = new Map<string, string>();
const objects = new Map<string, { kind: string; content: string }>();
let objectId = 0;
let now = 1_000;
// Optional hook run before every CAS attempt; used to simulate a concurrent
// writer mutating the pointer between a command's read and its CAS.
let beforeCas: (() => void) | null = null;

(globalThis as any).__op_now = () => now++;
(globalThis as any).__op_id = (prefix: string) => `${prefix}:1`;
(globalThis as any).__op_sha256_base64url = () => "hash";
(globalThis as any).__op_env_get = () => null;
(globalThis as any).__op_broadcast = () => {};
(globalThis as any).__op_ref_get = (name: string) => refs.get(name) ?? null;
(globalThis as any).__op_ref_set = (name: string, target: string) => { refs.set(name, target); return true; };
(globalThis as any).__op_ref_cas = (name: string, expected: string | null, next: string) => {
  if (beforeCas) {
    const hook = beforeCas;
    beforeCas = null;
    hook();
  }
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

const {
  chatQueueEditCommand,
  chatQueueListCommand,
  chatQueueRemoveCommand,
  chatQueueRunNextCommand,
  pendingMessagesSaveCommand,
  stepLifecycleEvents,
} = await import("../src/commands/step");
const { encodeJsonPointer } = await import("../src/lib");

const QUEUE_REF = "chat/pending-messages";

type QueueMessage = { id: string; chatId: string; text: string };

function seedQueue(messages: QueueMessage[]) {
  refs.set(QUEUE_REF, encodeJsonPointer(messages));
}

function queueIds(result: { ok: boolean; value?: { messages?: { id: string }[] } }) {
  if (!result.ok) throw new Error("command failed");
  return (result.value?.messages ?? []).map((message) => message.id);
}

beforeEach(() => {
  refs.clear();
  objects.clear();
  objectId = 0;
  now = 1_000;
  beforeCas = null;
});

describe("pending message queue persistence", () => {
  test("save with knownIds keeps messages added by other clients", async () => {
    seedQueue([
      { id: "a", chatId: "c1", text: "mine" },
      { id: "b", chatId: "c2", text: "someone else's" },
    ]);
    // This client only ever saw "a"; it edits it and adds "c".
    const r = await pendingMessagesSaveCommand({
      messages: [
        { id: "a", chatId: "c1", text: "mine, edited" },
        { id: "c", chatId: "c1", text: "new here" },
      ],
      knownIds: ["a", "c"],
    } as never);
    expect(queueIds(r as never).sort()).toEqual(["a", "b", "c"]);
    const list = await chatQueueListCommand({ chatId: "" } as never);
    expect(list.ok && list.value.messages.find((m: { id: string }) => m.id === "a")?.text).toBe(
      "mine, edited",
    );
  });

  test("save with knownIds drops messages this client deleted", async () => {
    seedQueue([
      { id: "a", chatId: "c1", text: "one" },
      { id: "b", chatId: "c1", text: "two" },
    ]);
    const r = await pendingMessagesSaveCommand({
      messages: [{ id: "b", chatId: "c1", text: "two" }],
      knownIds: ["a", "b"],
    } as never);
    expect(queueIds(r as never)).toEqual(["b"]);
  });

  test("remove survives a concurrent writer via CAS retry", async () => {
    seedQueue([
      { id: "a", chatId: "c1", text: "remove me" },
      { id: "b", chatId: "c1", text: "keep me" },
    ]);
    // Between the command's read and its CAS, another client appends "d".
    beforeCas = () =>
      seedQueue([
        { id: "a", chatId: "c1", text: "remove me" },
        { id: "b", chatId: "c1", text: "keep me" },
        { id: "d", chatId: "c2", text: "added concurrently" },
      ]);
    const r = await chatQueueRemoveCommand({ id: "a", chatId: "c1" } as never);
    expect(queueIds(r as never).sort()).toEqual(["b", "d"]);
  });

  test("run-next moves the chosen message to the front", async () => {
    seedQueue([
      { id: "a", chatId: "c1", text: "one" },
      { id: "b", chatId: "c1", text: "two" },
      { id: "c", chatId: "c2", text: "three" },
    ]);
    const r = await chatQueueRunNextCommand({ id: "b", chatId: "c1" } as never);
    expect(r.ok && (r.value as { moved: boolean }).moved).toBe(true);
    expect(queueIds(r as never)).toEqual(["b", "a", "c"]);
  });

  test("edit removes and returns the chosen message", async () => {
    seedQueue([
      { id: "a", chatId: "c1", text: "one" },
      { id: "b", chatId: "c1", text: "two" },
    ]);
    const r = await chatQueueEditCommand({ id: "a", chatId: "c1" } as never);
    expect(r.ok && (r.value as { item: QueueMessage | null }).item?.text).toBe("one");
    expect(queueIds(r as never)).toEqual(["b"]);
  });
});

describe("step lifecycle events", () => {
  test("carry the userStepId so clients can settle queued messages", () => {
    const events = stepLifecycleEvents("c1", false, "step:42");
    expect(events.start).toEqual({ kind: "step-start", chatId: "c1", userStepId: "step:42" });
    expect(events.end).toEqual({ kind: "step-end", chatId: "c1", userStepId: "step:42" });
  });

  test("omit userStepId when there is none", () => {
    const events = stepLifecycleEvents("c1", true);
    expect(events.start).toEqual({ kind: "step-start", chatId: "c1", compacting: true });
    expect(events.end).toEqual({ kind: "step-end", chatId: "c1" });
  });
});
