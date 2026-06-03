import { beforeEach, describe, expect, test } from "bun:test";

import { chatNewCommand } from "./chats";

const refs = new Map<string, string>();
const dirs = new Set<string>();
let scratchDirs: string[] = [];

function normalizePath(path: string): string {
  const raw = String(path || "/");
  const absolute = raw.startsWith("/");
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return (absolute ? "/" : "") + parts.join("/") || (absolute ? "/" : ".");
}

globalThis.__op_now = () => Date.UTC(2026, 0, 1);
globalThis.__op_id = (prefix: string) => prefix + ":generated";
globalThis.__op_ref_get = (name: string) => refs.get(name) ?? null;
globalThis.__op_ref_set = (name: string, target: string) => { refs.set(name, target); };
globalThis.__op_ref_cas = (name: string, expected: string | null, next: string) => {
  const current = refs.get(name) ?? null;
  if (current !== expected) return false;
  refs.set(name, next);
  return true;
};
globalThis.__op_refs_list = (prefix: string) => Array.from(refs.keys()).filter((name) => name.startsWith(prefix));
globalThis.__op_refs_entries = (prefix: string) => JSON.stringify(Array.from(refs.entries()).filter(([name]) => name.startsWith(prefix)));
globalThis.__op_ref_delete = (name: string) => refs.delete(name);
globalThis.__op_object_put = (kind: string) => "sha256:" + kind.padEnd(64, "0").slice(0, 64);
globalThis.__op_object_get = () => null;
globalThis.__op_fs_read = () => { throw new Error("not found"); };
globalThis.__op_fs_write = () => {};
globalThis.__op_fs_mkdir = (path: string) => {
  const normalized = normalizePath(path);
  dirs.add(normalized);
  if (normalized.includes("/moo/")) scratchDirs.push(normalized);
};
globalThis.__op_fs_list = () => [];
globalThis.__op_fs_glob = () => [];
globalThis.__op_fs_stat = (path: string) => dirs.has(normalizePath(path)) ? { kind: "dir", size: 0, mtime: Date.UTC(2026, 0, 2) } : null;
globalThis.__op_fs_canonical = (path: string) => normalizePath(path);
globalThis.__op_env_get = (name: string) => name === "HOME" ? "/home/test" : null;
globalThis.__op_proc_run = () => ({ code: 1, stdout: "", stderr: "", durationNs: 0, timedOut: false });
globalThis.__op_http_fetch = () => ({ status: 404, headers: "{}", body: "" });
globalThis.__op_broadcast = () => {};
globalThis.__op_chat_running_ids = () => "[]";
globalThis.__op_chat_running_started_at = () => "{}";
globalThis.__op_trace_current = () => "null";
globalThis.__op_trace_start_root = () => JSON.stringify({ id: "trace:test", traceId: "trace:test" });
globalThis.__op_trace_finish = () => "true";
globalThis.__op_trace_insert = () => "null";
globalThis.__op_trace_set_parent = () => null;
globalThis.__op_trace_leave = () => {};
globalThis.__op_trace_get = () => "null";
globalThis.__op_trace_children = () => "[]";
globalThis.__op_trace_chats = () => "[]";
globalThis.__op_trace_chat_tree = () => "null";
globalThis.__op_fact_add = () => ({ store: "", added: 1, removed: 0 });
globalThis.__op_fact_remove = () => ({ store: "", added: 0, removed: 1 });
globalThis.__op_facts_match = () => [];
globalThis.__op_facts_match_all = () => [];
globalThis.__op_facts_stores = () => [];
globalThis.__op_facts_count = () => 0;
globalThis.__op_fact_history = () => [];
globalThis.__op_facts_clear_store = () => ({ store: "", removed: 0 });
globalThis.__op_chat_fact_summaries = () => "[]";

describe("chat creation", () => {
  beforeEach(() => {
    refs.clear();
    dirs.clear();
    scratchDirs = [];
  });

  test("materializes and returns the checkout before chat-new completes", async () => {
    const result = await chatNewCommand({ chatId: "early" });

    expect(result.ok).toBe(true);
    expect(result.value.chatId).toBe("early");
    expect(result.value.worktreePath).toBe("/home/test/moo/early");
    expect(scratchDirs).toEqual(["/home/test/moo/early"]);
  });

  test("can start directly in the selected worktree", async () => {
    dirs.add("/repo/worktree");

    const result = await chatNewCommand({
      chatId: "here",
      path: "/repo/worktree",
      useExistingWorktree: true,
    });

    expect(result.ok).toBe(true);
    expect(result.value.chatId).toBe("here");
    expect(result.value.path).toBe("/repo/worktree");
    expect(result.value.worktreePath).toBe("/repo/worktree");
    expect(refs.get("chat/here/worktree-path")).toBe("/repo/worktree");
    expect(scratchDirs).toEqual([]);
  });
});
