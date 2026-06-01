import { beforeEach, describe, expect, test } from "bun:test";

const dirs = new Map<string, string[]>();
const stats = new Map<string, { kind: string; size: number; mtime: number }>();
const refs = new Map<string, string>();
const files = new Map<string, string>();
const procCalls: Array<{ cmd: string[]; cwd?: string }> = [];

function normalize(path: string): string {
  return String(path || ".").replace(/\/+$/, "") || "/";
}

function addDir(path: string, names: string[] = []) {
  const normalized = normalize(path);
  dirs.set(normalized, names);
  stats.set(normalized, { kind: "dir", size: 0, mtime: 0 });
  const slash = normalized.lastIndexOf("/");
  const parent = slash > 0 ? normalized.slice(0, slash) : "/";
  const name = normalized.slice(slash + 1);
  const parentNames = dirs.get(parent);
  if (normalized !== "/" && parentNames && !parentNames.includes(name)) parentNames.push(name);
}

function removeParentEntry(path: string) {
  const slash = path.lastIndexOf("/");
  const parent = slash > 0 ? path.slice(0, slash) : "/";
  const name = path.slice(slash + 1);
  const names = dirs.get(parent);
  if (!names) return;
  const index = names.indexOf(name);
  if (index >= 0) names.splice(index, 1);
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
(globalThis as any).__op_proc_run = (cmdJson: string, cwdArg: string | null = null) => {
  const cmd = JSON.parse(cmdJson || "[]") as string[];
  procCalls.push({ cmd, cwd: cwdArg ?? undefined });
  if (cmd[0] === "pwd" && cmd[1] === "-P") {
    const cwd = normalize(String(cwdArg ?? "."));
    return dirs.has(cwd)
      ? { code: 0, stdout: cwd + "\n", stderr: "", durationNs: 0, timedOut: false }
      : { code: 1, stdout: "", stderr: `not a directory: ${cwd}`, durationNs: 0, timedOut: false };
  }
  if (cmd[0] === "git" && cmd[1] === "worktree" && cmd[2] === "add") {
    const targetArg = cmd.includes("--detach") ? cmd[cmd.indexOf("--detach") + 1] : cmd[4];
    const target = normalize(targetArg || "");
    addDir(target, ["src"]);
    addDir(target + "/src", []);
    stats.set(target + "/src", { kind: "dir", size: 0, mtime: 0 });
    return { code: 0, stdout: "", stderr: "", durationNs: 0, timedOut: false };
  }
  if (cmd[0] === "git" && cmd[1] === "rev-parse" && cmd[2] === "--show-toplevel") {
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
(globalThis as any).__op_fs_delete = (path: string, recursive = false) => {
  const normalized = normalize(path);
  const stat = stats.get(normalized);
  if (!stat) throw new Error("not found");
  if (stat.kind === "dir") {
    const children = dirs.get(normalized) ?? [];
    if (children.length > 0 && !recursive) throw new Error("directory not empty");
    const prefix = normalized === "/" ? "/" : normalized + "/";
    for (const key of Array.from(files.keys())) if (key.startsWith(prefix)) files.delete(key);
    for (const key of Array.from(dirs.keys())) if (key === normalized || key.startsWith(prefix)) dirs.delete(key);
    for (const key of Array.from(stats.keys())) if (key === normalized || key.startsWith(prefix)) stats.delete(key);
    removeParentEntry(normalized);
    return;
  }
  files.delete(normalized);
  stats.delete(normalized);
  removeParentEntry(normalized);
};
(globalThis as any).__op_fs_glob = () => [];
(globalThis as any).__op_ref_get = (name: string) => refs.get(name) ?? null;
(globalThis as any).__op_ref_set = (name: string, target: string) => { refs.set(name, target); return true; };
(globalThis as any).__op_ref_cas = (name: string, expected: string | null, next: string) => { const cur = refs.get(name) ?? null; if (cur !== (expected ?? null)) return false; refs.set(name, next); return true; };
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
(globalThis as any).__op_facts_refs = () => [];
(globalThis as any).__op_facts_graph_summaries = () => "[]";
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
(globalThis as any).__op_trace_set_parent = () => null;
(globalThis as any).__op_trace_enabled = () => false;
(globalThis as any).__op_broadcast = () => {};

const { fsListCommand, recentChatPathsCommand, removeRecentChatPathCommand } = await import("../src/commands/chats");
const { moo, withMooChatContext } = await import("../src/moo");

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
    expect(procCalls.some((call) => call.cmd[0] === "git" && call.cmd[1] === "worktree" && call.cwd === "/repo")).toBe(true);
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
    expect(procCalls.some((call) => call.cmd[0] === "git" && call.cmd[1] === "worktree")).toBe(false);
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
    expect(procCalls.map((call) => [call.cmd[0], call.cmd[1]])).toContainEqual([
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

  test("defaults active moo.fs operations to the chat scratch root", async () => {
    refs.set("chat/active/created-at", "1");
    refs.set("chat/active/path", "/repo");
    addFile("/home/test/moo/active/src/example.txt", "from scratch");

    await expect(withMooChatContext("active", () => moo.fs.read({ path: "src/example.txt" }))).resolves.toBe("from scratch");
    await withMooChatContext("active", () => moo.fs.write({ path: "generated.txt", content: "created" }));

    expect(files.get("/home/test/moo/active/generated.txt")).toBe("created");
  });

  test("defaults active moo.proc cwd to the chat scratch root", async () => {
    refs.set("chat/active/created-at", "1");
    refs.set("chat/active/path", "/repo");
    addDir("/home/test/moo/active", []);

    await expect(withMooChatContext("active", () => moo.proc.run({ cmd: ["pwd", "-P"] }))).resolves.toMatchObject({
      code: 0,
      stdout: "/home/test/moo/active\n",
    });

    expect(procCalls.at(-1)).toMatchObject({ cmd: ["pwd", "-P"], cwd: "/home/test/moo/active" });
  });

  test("resolves relative moo.proc cwd under the chat scratch root", async () => {
    refs.set("chat/active/created-at", "1");
    refs.set("chat/active/path", "/repo");
    addDir("/home/test/moo/active", ["src"]);
    addDir("/home/test/moo/active/src", []);

    await expect(withMooChatContext("active", () => moo.proc.run({ cmd: ["pwd", "-P"], cwd: "src" }))).resolves.toMatchObject({
      code: 0,
      stdout: "/home/test/moo/active/src\n",
    });

    expect(procCalls.at(-1)).toMatchObject({ cmd: ["pwd", "-P"], cwd: "/home/test/moo/active/src" });
  });

  test("exposes split patch and delete helpers", async () => {
    expect("patch" in moo.fs).toBe(true);
    expect("delete" in moo.fs).toBe(true);
    const workspace = await moo.workspace.current({ root: "/repo" });
    expect("patch" in workspace.fs).toBe(true);
    expect("delete" in workspace.fs).toBe(true);
  });

  test("patches and deletes within scoped workspace", async () => {
    const workspace = await moo.workspace.current({ root: "/repo" });

    await workspace.fs.write({ path: "src/example.txt", content: "hello\nworld\n" });
    expect(files.get("/repo/src/example.txt")).toBe("hello\nworld\n");
    await expect(workspace.fs.patch({
      path: "src/example.txt",
      diff: "@@ -1,2 +1,2 @@\n hello\n-world\n+moo\n",
    })).resolves.toMatchObject({ status: "completed" });
    expect(files.get("/repo/src/example.txt")).toBe("hello\nmoo\n");

    await expect(workspace.fs.delete({ path: "src/example.txt" })).resolves.toMatchObject({ status: "completed" });
    expect(files.has("/repo/src/example.txt")).toBe(false);
  });

  test("removes empty directories and requires recursive for non-empty directories", async () => {
    const workspace = await moo.workspace.current({ root: "/repo" });
    addDir("/repo/empty", []);
    addDir("/repo/full", []);
    addFile("/repo/full/example.txt", "content");

    await expect(workspace.fs.delete({ path: "empty" })).resolves.toMatchObject({ status: "completed" });
    expect(dirs.has("/repo/empty")).toBe(false);

    await expect(workspace.fs.delete({ path: "full" })).resolves.toMatchObject({
      status: "failed",
      output: "Cannot delete non-empty directory 'full' without recursive: true.",
    });
    expect(dirs.has("/repo/full")).toBe(true);
    expect(files.has("/repo/full/example.txt")).toBe(true);

    await expect(workspace.fs.delete({ path: "full", recursive: true })).resolves.toMatchObject({ status: "completed" });
    expect(dirs.has("/repo/full")).toBe(false);
    expect(files.has("/repo/full/example.txt")).toBe(false);
  });

  test("patch accepts apply-patch envelope metadata", async () => {
    const workspace = await moo.workspace.current({ root: "/repo" });
    addFile("/repo/example.txt", "alpha\nbeta\n");

    await expect(workspace.fs.patch({
      path: "example.txt",
      diff: "*** Begin Patch\n*** Update File: example.txt\n@@\n alpha\n-beta\n+gamma\n*** End Patch\n",
    })).resolves.toMatchObject({ status: "completed" });

    expect(files.get("/repo/example.txt")).toBe("alpha\ngamma\n");
  });
  test("patch rejects apply-patch envelopes for other operations", async () => {
    const workspace = await moo.workspace.current({ root: "/repo" });
    addFile("/repo/example.txt", "alpha\nbeta\n");

    await expect(workspace.fs.patch({
      path: "example.txt",
      diff: "*** Begin Patch\n*** Update File: other.txt\n@@\n alpha\n-beta\n+gamma\n*** End Patch\n",
    })).rejects.toThrow("does not match requested path");

    await expect(workspace.fs.patch({
      path: "example.txt",
      diff: "*** Begin Patch\n*** Delete File: example.txt\n@@\n-alpha\n*** End Patch\n",
    })).rejects.toThrow("only supports updating one existing file");

    expect(files.get("/repo/example.txt")).toBe("alpha\nbeta\n");
  });

  test("throws patch failures for invalid paths and mismatched hunks", async () => {
    const workspace = await moo.workspace.current({ root: "/repo" });
    addFile("/repo/example.txt", "alpha\n");

    await expect(workspace.fs.patch({ path: "../example.txt", diff: "" })).rejects.toThrow(
      "patch paths must stay within the workspace root.",
    );

    await expect(workspace.fs.patch({ path: "example.txt", diff: "@@ -1 +1 @@\n-beta\n+gamma\n" })).rejects.toThrow(
      "Could not patch 'example.txt'",
    );
    expect(files.get("/repo/example.txt")).toBe("alpha\n");
  });

  test("throws active scratch patch failures as tool errors", async () => {
    refs.set("chat/active/created-at", "1");
    refs.set("chat/active/path", "/repo");
    addDir("/home/test/moo/active", []);
    addFile("/home/test/moo/active/example.txt", "alpha\n");

    await expect(withMooChatContext("active", () => moo.fs.patch({
      path: "example.txt",
      diff: "@@ -1 +1 @@\n-beta\n+gamma\n",
    }))).rejects.toThrow("Could not patch 'example.txt'");
    expect(files.get("/home/test/moo/active/example.txt")).toBe("alpha\n");
  });
});
