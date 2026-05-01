import { beforeEach, describe, expect, test } from "bun:test";

const files = new Map<string, string>();

(globalThis as any).__op_fs_read = (path: string) => {
  if (!files.has(path)) throw new Error(`missing file: ${path}`);
  return files.get(path)!;
};
(globalThis as any).__op_fs_write = (path: string, content: string) => {
  files.set(path, content);
};
(globalThis as any).__op_fs_remove = (path: string) => {
  files.delete(path);
};
(globalThis as any).__op_fs_mkdir = () => {};
(globalThis as any).__op_fs_list = () => [];
(globalThis as any).__op_fs_glob = () => [];
(globalThis as any).__op_fs_stat = (path: string) => files.has(path) ? { kind: "file", size: files.get(path)!.length, mtime: 0 } : null;
(globalThis as any).__op_fs_canonical = (path: string) => path;
(globalThis as any).__op_now = () => 0;
(globalThis as any).__op_id = (prefix: string) => `${prefix}1`;
(globalThis as any).__op_sha256_base64url = () => "hash";
(globalThis as any).__op_object_put = () => `sha256:${"a".repeat(64)}`;
(globalThis as any).__op_ref_set = () => {};

const { moo } = await import("../src/moo");

beforeEach(() => files.clear());

describe("moo.fs.patch", () => {
  test("modifies an existing file", async () => {
    files.set("/repo/a.txt", "one\ntwo\nthree\n");

    const receipt = await moo.fs.patch({
      cwd: "/repo",
      patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n",
    });

    expect(files.get("/repo/a.txt")).toBe("one\nTWO\nthree\n");
    expect(receipt.files[0]).toMatchObject({ path: "/repo/a.txt", beforeExists: true, afterExists: true, added: 1, removed: 1, hunks: 1 });
  });

  test("creates and deletes files", async () => {
    await moo.fs.patch({
      cwd: "/repo",
      patch: "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+alpha\n+beta\n",
    });
    expect(files.get("/repo/new.txt")).toBe("alpha\nbeta\n");

    const receipt = await moo.fs.patch({
      cwd: "/repo",
      patch: "--- a/new.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-alpha\n-beta\n",
    });
    expect(files.has("/repo/new.txt")).toBe(false);
    expect(receipt.files[0]).toMatchObject({ path: "/repo/new.txt", beforeExists: true, afterExists: false, added: 0, removed: 2 });
  });

  test("writes renamed targets without deleting the source", async () => {
    files.set("/repo/old.txt", "old\n");

    await moo.fs.patch({
      cwd: "/repo",
      patch: "--- a/old.txt\n+++ b/renamed.txt\n@@ -1 +1 @@\n-old\n+new\n",
    });

    expect(files.get("/repo/old.txt")).toBe("old\n");
    expect(files.get("/repo/renamed.txt")).toBe("new\n");
  });

  test("dryRun reports without writing", async () => {
    files.set("/repo/dry.txt", "x\n");

    const receipt = await moo.fs.patch({
      cwd: "/repo",
      dryRun: true,
      patch: "--- a/dry.txt\n+++ b/dry.txt\n@@ -1 +1 @@\n-x\n+y\n",
    });

    expect(files.get("/repo/dry.txt")).toBe("x\n");
    expect(receipt.dryRun).toBe(true);
  });

  test("preserves empty files when deleting the only line", async () => {
    files.set("/repo/empty.txt", "x\n");

    await moo.fs.patch({
      cwd: "/repo",
      patch: "--- a/empty.txt\n+++ b/empty.txt\n@@ -1 +0,0 @@\n-x\n",
    });

    expect(files.get("/repo/empty.txt")).toBe("");
  });

  test("honors no-newline markers on added and context lines", async () => {
    files.set("/repo/nonew.txt", "a");
    await moo.fs.patch({
      cwd: "/repo",
      patch: "--- a/nonew.txt\n+++ b/nonew.txt\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n",
    });
    expect(files.get("/repo/nonew.txt")).toBe("b");

    files.set("/repo/context.txt", "a\nb");
    await moo.fs.patch({
      cwd: "/repo",
      patch: "--- a/context.txt\n+++ b/context.txt\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n\\ No newline at end of file\n",
    });
    expect(files.get("/repo/context.txt")).toBe("A\nb");
  });

  test("rejects cwd-relative path escapes", async () => {
    await expect(moo.fs.patch({
      cwd: "/repo",
      patch: "--- a/../outside.txt\n+++ b/../outside.txt\n@@ -0,0 +1 @@\n+x\n",
    })).rejects.toMatchObject({ code: "path_escape" });
  });
});
