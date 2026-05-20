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

describe("moo.fs.partialRead", () => {
  beforeEach(() => {
    files.clear();
    refs.clear();
    traceSeq = 0;
    refs.set("chat/test/created-at", "1");
  });

  test("returns selected ranges with ellipses between omitted regions", async () => {
    files.set("/home/test/moo/test/sample.txt", Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n"));

    const text = await withMooChatContext("test", () => moo.fs.partialRead({ path: "sample.txt", lineRanges: [[1, 3], [50, 51]] }));

    expect(text).toBe("line 1\nline 2\nline 3\n…\nline 50\nline 51\n…");
  });

  test("sorts and merges overlapping ranges in file order", async () => {
    files.set("/home/test/moo/test/sample.txt", Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"));

    const text = await withMooChatContext("test", () => moo.fs.partialRead({ path: "sample.txt", lineRanges: [[5, 7], [2, 5]] }));

    expect(text).toBe("…\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\n…");
  });

  test("formats numbered output with aligned 1-based line numbers", async () => {
    files.set("/home/test/moo/test/sample.txt", Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");

    const text = await withMooChatContext("test", () => moo.fs.partialRead({ path: "sample.txt", lineRanges: [[1, 3], [50, 51]], numbered: true }));

    expect(text).toBe("   1: line 1\n   2: line 2\n   3: line 3\n…\n  50: line 50\n  51: line 51\n…");
  });

  test("clamps ranges to existing lines and normalizes CRLF input", async () => {
    files.set("/home/test/moo/test/sample.txt", "alpha\r\nbeta\r\ngamma\r\n");

    const text = await withMooChatContext("test", () => moo.fs.partialRead({ path: "sample.txt", lineRanges: [[2, 10]], numbered: true }));

    expect(text).toBe("…\n   2: beta\n   3: gamma");
  });

  test("is available on workspace scopes", async () => {
    files.set("/tmp/ws/sample.txt", "one\ntwo\nthree");

    const workspace = await moo.workspace.current({ root: "/tmp/ws" });
    const text = await workspace.fs.partialRead({ path: "sample.txt", lineRanges: [[2, 2]], numbered: true });

    expect(text).toBe("…\n   2: two\n…");
  });
});
