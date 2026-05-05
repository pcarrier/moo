import { beforeEach, describe, expect, test } from "bun:test";

const dirs = new Map<string, string[]>();
const stats = new Map<string, { kind: string; size: number; mtime: number }>();
const refs = new Map<string, string>();
const procCalls: Array<{ cmd: string; args?: string[]; cwd?: string }> = [];

function normalize(path: string): string {
  return String(path || ".").replace(/\/+$/, "") || "/";
}

function addDir(path: string, names: string[] = []) {
  const normalized = normalize(path);
  dirs.set(normalized, names);
  stats.set(normalized, { kind: "dir", size: 0, mtime: 0 });
}

(globalThis as any).__op_env_get = (name: string) => name === "HOME" ? "/home/test" : null;
(globalThis as any).__op_proc_run = (cmd: string, argsJson: string = "[]", cwdArg: string | null = null) => {
  const args = JSON.parse(argsJson || "[]") as string[];
  procCalls.push({ cmd, args, cwd: cwdArg ?? undefined });
  if (cmd === "pwd" && args[0] === "-P") {
    const cwd = normalize(String(cwdArg ?? "."));
    return dirs.has(cwd)
      ? { code: 0, stdout: cwd + "\n", stderr: "", durationMs: 0, timedOut: false }
      : { code: 1, stdout: "", stderr: `not a directory: ${cwd}`, durationMs: 0, timedOut: false };
  }
  if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
    const target = normalize(args[3] || "");
    addDir(target, ["src"]);
    addDir(target + "/src", []);
    stats.set(target + "/src", { kind: "dir", size: 0, mtime: 0 });
    return { code: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false };
  }
  return { code: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false };
};
(globalThis as any).__op_fs_list = (path: string) => dirs.get(normalize(path)) ?? [];
(globalThis as any).__op_fs_stat = (path: string) => stats.get(normalize(path)) ?? null;
(globalThis as any).__op_fs_canonical = (path: string) => normalize(path);
(globalThis as any).__op_fs_mkdir = (path: string) => addDir(path, []);
(globalThis as any).__op_fs_read = () => { throw new Error("unexpected read"); };
(globalThis as any).__op_fs_write = () => {};
(globalThis as any).__op_fs_remove = () => {};
(globalThis as any).__op_fs_glob = () => [];
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
(globalThis as any).__op_facts_match = () => [];
(globalThis as any).__op_facts_match_all = () => [];
(globalThis as any).__op_facts_history = () => [];
(globalThis as any).__op_facts_count = () => 0;
(globalThis as any).__op_chat_fact_summaries = () => [];

const { fsListCommand } = await import("../src/commands/chats");

describe("fsListCommand", () => {
  beforeEach(() => {
    dirs.clear();
    stats.clear();
    refs.clear();
    procCalls.length = 0;
    addDir("/repo", [".git"]);
    addDir("/repo/.git", []);
    refs.set("chat/fresh/created-at", "1");
    refs.set("chat/fresh/path", "/repo");
  });

  test("materializes a fresh chat worktree before listing @path suggestions", async () => {
    const result = await fsListCommand({ path: "/repo/.moo/fresh" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe("/repo/.moo/fresh");
    expect(result.value.entries.map((entry: any) => entry.name)).toEqual(["src"]);
    expect(procCalls.some((call) => call.cmd === "git" && call.args?.[0] === "worktree" && call.cwd === "/repo")).toBe(true);
  });
});
