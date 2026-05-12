import { describe, expect, test } from "bun:test";
import { buildLLMMessages } from "../src/agent";
import { chatRefs } from "../src/lib";

type Quad = [string, string, string, string];

const g = globalThis as any;
let objectSeq = 0;
let nowValue = 1_000;
const objects = new Map<string, { kind: string; content: string }>();
const refs = new Map<string, string>();
const facts = new Map<string, Quad[]>();

function installHostOps() {
  objectSeq = 0;
  nowValue = 1_000;
  objects.clear();
  refs.clear();
  facts.clear();

  g.__op_now = () => nowValue++;
  g.__op_id = (prefix: string) => `${prefix}:${nowValue++}`;
  g.__op_object_put = (kind: string, content: string) => {
    const hash = `sha256:${String(++objectSeq).padStart(64, "0")}`;
    objects.set(hash, { kind, content });
    return hash;
  };
  g.__op_object_get = (hash: string) => objects.get(hash) ?? null;
  g.__op_ref_set = (name: string, target: string) => { refs.set(name, target); };
  g.__op_ref_get = (name: string) => refs.get(name) ?? null;
  g.__op_ref_cas = (name: string, expected: string | null, next: string) => {
    if ((refs.get(name) ?? null) !== expected) return false;
    refs.set(name, next);
    return true;
  };
  g.__op_refs_list = (prefix: string) => [...refs.keys()].filter((name) => name.startsWith(prefix));
  g.__op_refs_entries = (prefix: string) => JSON.stringify([...refs.entries()].filter(([name]) => name.startsWith(prefix)));
  g.__op_ref_delete = (name: string) => refs.delete(name);
  g.__op_facts_swap = (store: string, removesJson: string, addsJson: string) => {
    const current = facts.get(store) ?? [];
    const removes = JSON.parse(removesJson) as Quad[];
    const adds = JSON.parse(addsJson) as Quad[];
    const kept = current.filter((q) => !removes.some((r) => r.every((v, i) => v === q[i])));
    facts.set(store, [...kept, ...adds]);
  };
  g.__op_facts_match = (store: string, graph: string | null, subject: string | null, predicate: string | null, object: string | null, limit: number | null) => {
    const rows = (facts.get(store) ?? []).filter(([g, s, p, o]) =>
      (graph == null || g === graph) &&
      (subject == null || s === subject) &&
      (predicate == null || p === predicate) &&
      (object == null || o === object)
    );
    return limit == null ? rows : rows.slice(0, limit);
  };
  g.__op_facts_match_all = (store: string, patternsJson: string, graph: string | null, limit: number | null) => {
    const patterns = JSON.parse(patternsJson) as Array<[string, string, string]>;
    let bindings: Record<string, string>[] = [{}];
    for (const pattern of patterns) {
      const next: Record<string, string>[] = [];
      for (const binding of bindings) {
        for (const quad of facts.get(store) ?? []) {
          if (graph != null && quad[0] !== graph) continue;
          const candidate = { ...binding };
          let ok = true;
          for (let i = 0; i < 3; i++) {
            const pat = pattern[i];
            const value = quad[i + 1];
            if (pat.startsWith("?")) {
              if (candidate[pat] != null && candidate[pat] !== value) ok = false;
              candidate[pat] = value;
            } else if (pat !== value) {
              ok = false;
            }
          }
          if (ok) next.push(candidate);
        }
      }
      bindings = next;
    }
    return limit == null ? bindings : bindings.slice(0, limit);
  };
  g.__op_facts_history = () => [];
  g.__op_facts_refs = () => [];
  g.__op_facts_count = (store: string) => (facts.get(store) ?? []).length;
  g.__op_facts_clear = (store: string) => { const count = facts.get(store)?.length ?? 0; facts.delete(store); return count; };
  g.__op_facts_purge = g.__op_facts_clear;
  g.__op_facts_purge_graph = () => 0;
  g.__op_facts_add = (store: string, graph: string, subject: string, predicate: string, object: string) => {
    facts.set(store, [...(facts.get(store) ?? []), [graph, subject, predicate, object]]);
  };
  g.__op_facts_remove = () => {};
  g.__op_facts_present = () => [];
  g.__op_env_get = () => null;
  g.__op_chat_scratch = (chatId: string) => `/tmp/${chatId}`;
  g.__op_proc_run = () => JSON.stringify({ code: 0, stdout: "", stderr: "", durationNs: 0, timedOut: false });
  g.__op_fs_stat = () => null;
  g.__op_fs_read = () => "";
  g.__op_fs_write = () => {};
  g.__op_fs_mkdir = () => {};
  g.__op_fs_list = () => [];
  g.__op_fs_glob = () => [];
  g.__op_fs_canonical = (path: string) => path;
  g.__op_trace_enabled = () => false;
  g.__op_trace_current = () => JSON.stringify(null);
  g.__op_trace_mark = () => {};
}

function putJSON(kind: string, value: unknown): string {
  return g.__op_object_put(kind, JSON.stringify(value));
}

describe("LLM prompt context", () => {
  test("includes post-compaction RunJS calls and results", async () => {
    installHostOps();
    const chatId = "prompt-context-runjs";
    const c = chatRefs(chatId);
    refs.set(c.compaction, "json:" + JSON.stringify({ summary: "Earlier work.", throughAt: 1000, at: 1000 }));

    const userPayload = putJSON("agent:UserInput", { message: "What did the tool say?" });
    const runPayload = putJSON("agent:RunJS", { label: "Inspect thing", description: "Read the thing.", code: "return 'secret-tool-result';" });
    const runResult = putJSON("agent:ToolResult", { ok: true, value: "secret-tool-result" });

    facts.set(c.facts, [
      [c.graph, "step:user", "rdf:type", "agent:Step"],
      [c.graph, "step:user", "agent:kind", "agent:UserInput"],
      [c.graph, "step:user", "agent:status", "agent:Done"],
      [c.graph, "step:user", "agent:createdAt", "1001"],
      [c.graph, "step:user", "agent:payload", userPayload],
      [c.graph, "step:run", "rdf:type", "agent:Step"],
      [c.graph, "step:run", "agent:kind", "agent:RunJS"],
      [c.graph, "step:run", "agent:status", "agent:Done"],
      [c.graph, "step:run", "agent:createdAt", "1002"],
      [c.graph, "step:run", "agent:payload", runPayload],
      [c.graph, "step:run", "agent:result", runResult],
    ]);

    const messages = await buildLLMMessages(chatId);
    const joined = JSON.stringify(messages);

    expect(joined).toContain("What did the tool say?");
    expect(joined).toContain("[RunJS · Done]");
    expect(joined).toContain("Inspect thing");
    expect(joined).toContain("secret-tool-result");
    const runMessage = messages.find((m) => JSON.stringify(m).includes("Inspect thing"));
    expect(runMessage?.role).toBe("system");
    expect(runMessage?.content).toContain("Internal tool transcript for context only");
    expect(messages.some((m) => m.role === "assistant" && JSON.stringify(m).includes("[RunJS · Done]"))).toBe(false);
  });
});
