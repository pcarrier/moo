import { beforeEach, describe, expect, test } from "bun:test";

const files = new Map<string, string>();
const refs = new Map<string, string>();
let traceSeq = 0;

function normalize(path: string): string {
  return String(path || ".").replace(/\/+$/, "") || "/";
}

(globalThis as any).__op_env_get = (name: string) => name === "HOME" ? "/home/test" : null;
(globalThis as any).__op_proc_run = () => ({ code: 0, stdout: "", stderr: "", durationNs: 0, timedOut: false });
(globalThis as any).__op_fs_read = (path: string) => {
  const normalized = normalize(path);
  if (!files.has(normalized)) throw new Error("missing file: " + normalized);
  return files.get(normalized);
};
(globalThis as any).__op_fs_write = (path: string, content: string) => { files.set(normalize(path), content); };
(globalThis as any).__op_fs_list = () => [];
(globalThis as any).__op_fs_glob = () => [];
(globalThis as any).__op_fs_stat = (path: string) => files.has(normalize(path)) ? { kind: "file", size: files.get(normalize(path))!.length, mtime: 0 } : null;
(globalThis as any).__op_fs_canonical = (path: string) => normalize(path);
(globalThis as any).__op_fs_mkdir = () => {};
(globalThis as any).__op_ref_get = (name: string) => refs.get(name) ?? null;
(globalThis as any).__op_ref_set = (name: string, target: string) => { refs.set(name, target); return true; };
(globalThis as any).__op_ref_cas = () => true;
(globalThis as any).__op_ref_delete = () => true;
(globalThis as any).__op_refs_list = () => [];
(globalThis as any).__op_refs_entries = () => [];
(globalThis as any).__op_now = () => 0;
(globalThis as any).__op_id = (prefix: string) => `${prefix}:1`;
(globalThis as any).__op_object_put = () => `sha256:${"a".repeat(64)}`;
(globalThis as any).__op_object_get = () => null;
(globalThis as any).__op_sha256_base64url = () => "hash";
(globalThis as any).__op_facts_swap = () => {};
(globalThis as any).__op_facts_snapshot_copy = () => 0;
(globalThis as any).__op_facts_match = () => [];
(globalThis as any).__op_facts_match_all = () => [];
(globalThis as any).__op_facts_history = () => [];
(globalThis as any).__op_facts_count = () => 0;
(globalThis as any).__op_chat_fact_summaries = () => [];
(globalThis as any).__op_trace_start_root = () => Promise.resolve("trace:test");
(globalThis as any).__op_trace_current = () => Promise.resolve("trace:test");
(globalThis as any).__op_trace_get = () => Promise.resolve(null);
(globalThis as any).__op_trace_events = () => Promise.resolve([]);
(globalThis as any).__op_trace_recent = () => Promise.resolve([]);
(globalThis as any).__op_trace_insert = () => Promise.resolve(`trace:event:${++traceSeq}`);
(globalThis as any).__op_trace_mark = () => Promise.resolve(null);
(globalThis as any).__op_trace_finish = () => Promise.resolve(null);
(globalThis as any).__op_trace_set_parent = () => null;

const { moo, withMooChatContext } = await import("../src/moo");

describe("moo.fs.readLines", () => {
  beforeEach(() => {
    files.clear();
    refs.clear();
    traceSeq = 0;
    refs.set("chat/test/created-at", "1");
  });

  test("returns selected ranges with ellipses between omitted regions", async () => {
    files.set("/home/test/moo/test/sample.txt", Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n"));

    const lines = await withMooChatContext("test", () => moo.fs.readLines({ path: "sample.txt", ranges: [[1, 3], [50, 51]] }));

    expect(lines).toEqual(["line 1", "line 2", "line 3", "…", "line 50", "line 51", "…"]);
  });

  test("sorts and merges overlapping ranges in file order", async () => {
    files.set("/home/test/moo/test/sample.txt", Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"));

    const lines = await withMooChatContext("test", () => moo.fs.readLines({ path: "sample.txt", ranges: [[5, 7], [2, 5]] }));

    expect(lines).toEqual(["…", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "…"]);
  });

  test("formats numbered output with aligned 1-based line numbers", async () => {
    files.set("/home/test/moo/test/sample.txt", Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");

    const lines = await withMooChatContext("test", () => moo.fs.readLines({ path: "sample.txt", ranges: [[1, 3], [50, 51]], opts: { numbered: true } }));

    expect(lines).toEqual([
      "   1: line 1",
      "   2: line 2",
      "   3: line 3",
      "…",
      "  50: line 50",
      "  51: line 51",
      "…",
    ]);
  });

  test("clamps ranges to existing lines and normalizes CRLF input", async () => {
    files.set("/home/test/moo/test/sample.txt", "alpha\r\nbeta\r\ngamma\r\n");

    const lines = await withMooChatContext("test", () => moo.fs.readLines({ path: "sample.txt", ranges: [[2, 10]], opts: { numbered: true } }));

    expect(lines).toEqual(["…", "   2: beta", "   3: gamma"]);
  });

  test("is available on workspace scopes", async () => {
    files.set("/tmp/ws/sample.txt", "one\ntwo\nthree");

    const workspace = await moo.workspace.current({ root: "/tmp/ws" });
    const lines = await workspace.fs.readLines({ path: "sample.txt", ranges: [[2, 2]], opts: { numbered: true } });

    expect(lines).toEqual(["…", "   2: two", "…"]);
  });
});
