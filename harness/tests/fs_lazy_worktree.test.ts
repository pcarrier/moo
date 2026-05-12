import { beforeEach, describe, expect, test } from "bun:test";

const dirs = new Map<string, string[]>();
const stats = new Map<string, { kind: string; size: number; mtime: number }>();
const refs = new Map<string, string>();
const files = new Map<string, string>();
const procCalls: Array<{ cmd: string; args?: string[]; cwd?: string }> = [];

function normalize(path: string): string {
  return String(path || ".").replace(/\/+$/, "") || "/";
}

function addDir(path: string, names: string[] = []) {
  const normalized = normalize(path);
  dirs.set(normalized, names);
  stats.set(normalized, { kind: "dir", size: 0, mtime: 0 });
}

function addFile(path: string, content: string) {
  const normalized = normalize(path);
  files.set(normalized, content);
  stats.set(normalized, { kind: "file", size: content.length, mtime: 0 });
  const slash = normalized.lastIndexOf("/");
  const parent = slash > 0 ? normalized.slice(0, slash) : "/";
  const name = normalized.slice(slash + 1);
  const names = dirs.get(parent);
  if (names && !names.includes(name)) names.push(name);
}

(globalThis as any).__op_env_get = (name: string) => name === "HOME" ? "/home/test" : null;
(globalThis as any).__op_proc_run = (cmd: string, argsJson: string = "[]", cwdArg: string | null = null) => {
  const args = JSON.parse(argsJson || "[]") as string[];
  procCalls.push({ cmd, args, cwd: cwdArg ?? undefined });
  if (cmd === "pwd" && args[0] === "-P") {
    const cwd = normalize(String(cwdArg ?? "."));
    return dirs.has(cwd)
      ? { code: 0, stdout: cwd + "\n", stderr: "", durationNs: 0, timedOut: false }
      : { code: 1, stdout: "", stderr: `not a directory: ${cwd}`, durationNs: 0, timedOut: false };
  }
  if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
    const targetArg = args.includes("--detach") ? args[args.indexOf("--detach") + 1] : args[3];
    const target = normalize(targetArg || "");
    addDir(target, ["src"]);
    addDir(target + "/src", []);
    stats.set(target + "/src", { kind: "dir", size: 0, mtime: 0 });
    return { code: 0, stdout: "", stderr: "", durationNs: 0, timedOut: false };
  }
  if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
    const cwd = normalize(String(cwdArg ?? "."));
    return dirs.has(cwd + "/.git")
      ? { code: 0, stdout: cwd + "\n", stderr: "", durationNs: 0, timedOut: false }
      : { code: 128, stdout: "", stderr: "not a git repository", durationNs: 0, timedOut: false };
  }
  return { code: 0, stdout: "", stderr: "", durationNs: 0, timedOut: false };
};
(globalThis as any).__op_fs_list = (path: string) => dirs.get(normalize(path)) ?? [];
(globalThis as any).__op_fs_stat = (path: string) => stats.get(normalize(path)) ?? null;
(globalThis as any).__op_fs_canonical = (path: string) => normalize(path);
(globalThis as any).__op_fs_mkdir = (path: string) => addDir(path, []);
(globalThis as any).__op_fs_read = (path: string) => {
  const normalized = normalize(path);
  if (!files.has(normalized)) throw new Error("unexpected read");
  return files.get(normalized) ?? "";
};
(globalThis as any).__op_fs_write = (path: string, content: string) => addFile(path, content);
(globalThis as any).__op_fs_delete = (path: string) => {
  const normalized = normalize(path);
  if (!files.delete(normalized)) throw new Error("not found");
  stats.delete(normalized);
};
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
(globalThis as any).__op_trace_insert = () => Promise.resolve("trace:event");
(globalThis as any).__op_trace_mark = () => Promise.resolve(null);
(globalThis as any).__op_trace_finish = () => Promise.resolve(null);

const { fsListCommand, recentChatPathsCommand, removeRecentChatPathCommand } = await import("../src/commands/chats");
const { moo } = await import("../src/moo");

describe("fsListCommand", () => {
  beforeEach(() => {
    dirs.clear();
    stats.clear();
    refs.clear();
    files.clear();
    procCalls.length = 0;
    addDir("/repo", [".git"]);
    addDir("/repo/.git", []);
    refs.set("chat/fresh/created-at", "1");
    refs.set("chat/fresh/path", "/repo");
  });

  test("materializes a fresh chat worktree before listing @path suggestions", async () => {
    const result = await fsListCommand({ path: "/home/test/moo/fresh" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe("/home/test/moo/fresh");
    expect(result.value.entries.map((entry: any) => entry.name)).toEqual(["src"]);
    expect(dirs.has("/home/test/moo")).toBe(true);
    expect(procCalls.some((call) => call.cmd === "git" && call.args?.[0] === "worktree" && call.cwd === "/repo")).toBe(true);
  });

  test("materializes repo-less chats as empty scratch directories", async () => {
    refs.delete("chat/fresh/path");

    const result = await fsListCommand({ path: "/home/test/moo/fresh" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe("/home/test/moo/fresh");
    expect(result.value.entries).toEqual([]);
    expect(dirs.has("/home/test/moo")).toBe(true);
    expect(dirs.has("/home/test/moo/fresh")).toBe(true);
    expect(procCalls.some((call) => call.cmd === "git" && call.args?.[0] === "worktree")).toBe(false);
  });
});

describe("recentChatPathsCommand", () => {
  beforeEach(() => {
    dirs.clear();
    stats.clear();
    refs.clear();
    files.clear();
    procCalls.length = 0;
    addDir("/repo", [".git"]);
    addDir("/repo/.git", []);
    refs.set("user/recent-chat-paths", JSON.stringify(["/repo"]));
  });

  test("returns recent paths without probing repo kinds by default", async () => {
    const result = await recentChatPathsCommand();

    expect(result).toEqual({ ok: true, value: { paths: ["/repo"] } });
    expect(procCalls).toEqual([]);
  });

  test("probes repo kinds only when requested", async () => {
    const result = await recentChatPathsCommand({ includeRepos: true });

    expect(result).toEqual({
      ok: true,
      value: { paths: ["/repo"], repos: [{ path: "/repo", repoKind: "git" }] },
    });
    expect(procCalls.map((call) => [call.cmd, call.args?.[0]])).toContainEqual([
      "git",
      "rev-parse",
    ]);
  });

  test("removes a recent path", async () => {
    refs.set("user/recent-chat-paths", JSON.stringify(["/repo", "/other"]));

    const result = await removeRecentChatPathCommand({ path: "/repo" });

    expect(result).toEqual({ ok: true, value: { removed: true, paths: ["/other"] } });
    expect(JSON.parse(refs.get("user/recent-chat-paths") || "[]")).toEqual(["/other"]);
  });
});


describe("filesystem API", () => {
  beforeEach(() => {
    dirs.clear();
    stats.clear();
    refs.clear();
    files.clear();
    procCalls.length = 0;
    addDir("/repo", []);
  });

  test("exposes split patch and delete helpers", async () => {
    expect("patch" in moo.fs).toBe(true);
    expect("delete" in moo.fs).toBe(true);
    expect("applyPatch" in moo.fs).toBe(false);

    const workspace = await moo.workspace.current({ root: "/repo" });
    expect("patch" in workspace.fs).toBe(true);
    expect("delete" in workspace.fs).toBe(true);
    expect("applyPatch" in workspace.fs).toBe(false);
  });

  test("patches and deletes within scoped workspace", async () => {
    const workspace = await moo.workspace.current({ root: "/repo" });

    await workspace.fs.write("src/example.txt", "hello\nworld\n");
    expect(files.get("/repo/src/example.txt")).toBe("hello\nworld\n");

    await expect(workspace.fs.patch(
      "src/example.txt",
      "@@ -1,2 +1,2 @@\n hello\n-world\n+moo\n",
    )).resolves.toMatchObject({ status: "completed" });
    expect(files.get("/repo/src/example.txt")).toBe("hello\nmoo\n");

    await expect(workspace.fs.delete("src/example.txt")).resolves.toMatchObject({ status: "completed" });
    expect(files.has("/repo/src/example.txt")).toBe(false);
  });

  test("returns patch failures for invalid paths and mismatched hunks", async () => {
    const workspace = await moo.workspace.current({ root: "/repo" });
    addFile("/repo/example.txt", "alpha\n");

    await expect(workspace.fs.patch("../example.txt", "")).resolves.toMatchObject({
      status: "failed",
      output: "apply_patch paths must stay within the workspace root.",
    });

    await expect(workspace.fs.patch("example.txt", "@@ -1 +1 @@\n-beta\n+gamma\n")).resolves.toMatchObject({
      status: "failed",
    });
    expect(files.get("/repo/example.txt")).toBe("alpha\n");
  });
});
