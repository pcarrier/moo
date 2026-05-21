import { describe, expect, test } from "bun:test";
import {
  mergeFileDiffItems,
  mergedFileDiffs,
  sameDiffPath,
  sameDiffPathInRoot,
  diffDisplaySections,
  type MergedFileDiffItem,
} from "./diffs";
import type { FileDiffItem } from "./api";

function item(partial: Partial<FileDiffItem> & Pick<FileDiffItem, "id" | "diff" | "at">): FileDiffItem {
  return {
    type: "file-diff",
    chatId: "chat" as FileDiffItem["chatId"],
    path: "src/example.ts",
    ...partial,
  };
}

function hasOwn(value: MergedFileDiffItem, key: "before" | "after"): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

describe("mergeFileDiffItems", () => {
  test("does not treat omitted snapshots as an explicit new-file before", () => {
    const merged = mergeFileDiffItems([
      item({
        id: "first",
        at: 1,
        diff: "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new",
      }),
      item({
        id: "last",
        at: 2,
        diff: "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -2 +2 @@\n-before\n+after",
      }),
    ]);

    expect(hasOwn(merged, "before")).toBe(false);
    expect(hasOwn(merged, "after")).toBe(false);
    expect(merged.before).toBeUndefined();
    expect(merged.after).toBeUndefined();
    expect(merged.diff).not.toContain("--- /dev/null");
    expect(merged.diff).toContain("--- a/src/example.ts");
  });

  test("keeps explicit null before snapshots for real new-file diffs", () => {
    const merged = mergeFileDiffItems([
      item({
        id: "first",
        at: 1,
        before: null,
        diff: "--- /dev/null\n+++ b/src/example.ts\n@@ -0,0 +1 @@\n+one",
      }),
      item({
        id: "last",
        at: 2,
        after: "one\ntwo\n",
        diff: "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1,2 @@\n one\n+two",
      }),
    ]);

    expect(hasOwn(merged, "before")).toBe(true);
    expect(merged.before).toBeNull();
    expect(merged.after).toBe("one\ntwo\n");
    expect(merged.diff).toContain("--- /dev/null");
    expect(merged.diff).toContain("+++ b/src/example.ts");
  });

  test("synthesizes a full before/after diff after first and last snapshots are hydrated", () => {
    const merged = mergeFileDiffItems([
      item({
        id: "first",
        at: 1,
        before: "one\ntwo\nthree\n",
        diff: "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three",
      }),
      item({
        id: "middle",
        at: 2,
        diff: "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,3 +1,4 @@\n one\n TWO\n three\n+four",
      }),
      item({
        id: "last",
        at: 3,
        after: "zero\none\nTWO\nthree\nfour\n",
        diff: "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,4 +1,5 @@\n+zero\n one\n TWO\n three\n four",
      }),
    ]);

    expect(merged.diff).not.toMatch(/^diff --git /m);
    expect(merged.diff.match(/^@@ /gm)?.length).toBe(1);
    expect(merged.diff).toContain("-two");
    expect(merged.diff).toContain("+zero");
    expect(merged.diff).toContain("+TWO");
    expect(merged.diff).toContain("+four");
    expect(merged.before).toBe("one\ntwo\nthree\n");
    expect(merged.after).toBe("zero\none\nTWO\nthree\nfour\n");
  });

  test("uses hydrated snapshots when recorded patch text falsely looks like a deletion", () => {
    const merged = mergeFileDiffItems([
      item({
        id: "only",
        at: 1,
        before: "one\ntwo\nthree\n",
        after: "one\nTWO\nthree\n",
        diff: "--- a/src/example.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-one\n-two\n-three",
        stats: { added: 0, removed: 3, lines: 6 },
      }),
    ]);

    expect(merged.stats).toEqual({ added: 1, removed: 1, lines: 7 });
    expect(merged.diff).toContain("--- a/src/example.ts");
    expect(merged.diff).toContain("+++ b/src/example.ts");
    expect(merged.diff).toContain("-two");
    expect(merged.diff).toContain("+TWO");
    expect(merged.diff).not.toContain("+++ /dev/null");
    expect(merged.after).toBe("one\nTWO\nthree\n");
  });

  test("recomputes a hydrated single-item changeset from before and after snapshots", () => {
    const merged = mergeFileDiffItems([
      item({
        id: "only",
        at: 1,
        before: "one\ntwo\nthree\n",
        after: "one\nTWO\nthree\n",
        diff: "--- a/src/example.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-one\n-two\n-three",
        stats: { added: 0, removed: 3, lines: 6 },
      }),
    ]);

    expect(merged.stats).toEqual({ added: 1, removed: 1, lines: 7 });
    expect(merged.diff).toContain("--- a/src/example.ts");
    expect(merged.diff).toContain("+++ b/src/example.ts");
    expect(merged.diff).toContain("-two");
    expect(merged.diff).toContain("+TWO");
    expect(merged.diff).not.toContain("+++ /dev/null");
  });

  test("keeps real hydrated deletion changesets as full-file removals", () => {
    const merged = mergeFileDiffItems([
      item({
        id: "only",
        at: 1,
        before: "one\ntwo\n",
        after: null,
        diff: "--- a/src/example.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two",
        stats: { added: 0, removed: 2, lines: 5 },
      }),
    ]);

    expect(merged.stats).toEqual({ added: 0, removed: 2, lines: 5 });
    expect(merged.diff).toContain("+++ /dev/null");
    expect(merged.after).toBeNull();
  });

  test("collapses a create-then-delete lifecycle into one net diff", () => {
    const merged = mergeFileDiffItems([
      item({
        id: "create",
        at: 1,
        before: null,
        after: "temporary\n",
        diff: "--- /dev/null\n+++ b/src/example.ts\n@@ -0,0 +1 @@\n+temporary",
        stats: { added: 1, removed: 0, lines: 4 },
      }),
      item({
        id: "delete",
        at: 2,
        before: "temporary\n",
        after: null,
        diff: "--- a/src/example.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-temporary",
        stats: { added: 0, removed: 1, lines: 4 },
      }),
    ]);

    expect(merged.items?.map((source) => source.id)).toEqual([
      "create",
      "delete",
    ]);
    expect(merged.before).toBeNull();
    expect(merged.after).toBeNull();
    expect(merged.stats?.added).toBe(0);
    expect(merged.stats?.removed).toBe(0);
    expect(merged.diff.match(/^--- /gm)?.length).toBe(1);
    expect(merged.diff).toContain("--- /dev/null");
    expect(merged.diff).toContain("+++ /dev/null");
    expect(merged.diff).not.toContain("+temporary");
    expect(merged.diff).not.toContain("-temporary");
  });

});


describe("diffDisplaySections", () => {
  test("does not map concatenated patch hunks onto one final snapshot", () => {
    const diff = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1,3 +1,4 @@",
      " {",
      "   \"scripts\": {",
      "+    \"typecheck\": \"tsc --noEmit\",",
      "     \"dev\": \"bun build\"",
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1,4 +1,4 @@",
      " {",
      "   \"scripts\": {",
      "-    \"typecheck\": \"tsc --noEmit\",",
      "+    \"typecheck\": \"tsc --noEmit --noCheck\",",
      "     \"dev\": \"bun build\"",
    ].join("\n");
    const snapshot = [
      "{",
      "  \"scripts\": {",
      "    \"dev\": \"bun build\",",
      "    \"typecheck\": \"tsc --noEmit --noCheck\"",
      "  }",
      "}",
    ].join("\n");

    const renderedLines = diffDisplaySections(diff, snapshot).flatMap((section) => section.lines);

    expect(renderedLines.join("\n")).toContain("@@ -1,3 +1,4 @@");
    expect(renderedLines.join("\n")).toContain("diff --git a/package.json b/package.json");
    expect(renderedLines.filter((line) => line.includes('\"scripts\": {')).length).toBe(2);
  });

  test("places snapshot expansion controls next to the remaining hidden side", () => {
    const snapshot = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const diff = [
      "diff --git a/example.txt b/example.txt",
      "--- a/example.txt",
      "+++ b/example.txt",
      "@@ -15,1 +15,1 @@",
      "-line 15",
      "+line 15 changed",
    ].join("\n");

    const collapsed = diffDisplaySections(diff, snapshot).filter(
      (section): section is Extract<ReturnType<typeof diffDisplaySections>[number], { kind: "collapsed" }> => section.kind === "collapsed",
    );

    expect(collapsed).toMatchObject([
      { expandFrom: "end", controlsPosition: "before", location: "above" },
      { expandFrom: "start", controlsPosition: "after", location: "below" },
    ]);
  });
});


describe("diff path matching", () => {
  test("does not match unrelated relative paths that share a suffix", () => {
    expect(sameDiffPath("src/commands/chats.ts", "harness/src/commands/chats.ts")).toBe(false);
    expect(sameDiffPath("commands/chats.ts", "harness/src/commands/chats.ts")).toBe(false);
  });

  test("still matches absolute paths to their relative form", () => {
    expect(sameDiffPath("/tmp/work/src/example.ts", "src/example.ts")).toBe(true);
    expect(sameDiffPath("src/example.ts", "/tmp/work/src/example.ts")).toBe(true);
  });

  test("uses the chat root when comparing opened files to diff items", () => {
    const root = "/tmp/work";

    expect(
      sameDiffPathInRoot(
        "src/commands/chats.ts",
        "/tmp/work/src/commands/chats.ts",
        root,
      ),
    ).toBe(true);
    expect(
      sameDiffPathInRoot(
        "src/commands/chats.ts",
        "/tmp/work/harness/src/commands/chats.ts",
        root,
      ),
    ).toBe(false);
  });

  test("keeps distinct suffix-sharing files in separate merged groups", () => {
    const groups = mergedFileDiffs([
      item({
        id: "src",
        path: "src/commands/chats.ts",
        at: 1,
        diff: "--- a/src/commands/chats.ts\n+++ b/src/commands/chats.ts\n@@ -1 +1 @@\n-old\n+new",
      }),
      item({
        id: "harness",
        path: "harness/src/commands/chats.ts",
        at: 2,
        diff: "--- a/harness/src/commands/chats.ts\n+++ b/harness/src/commands/chats.ts\n@@ -1 +1 @@\n-old\n+new",
      }),
    ]);

    expect(groups.map((group) => group.path).sort()).toEqual([
      "harness/src/commands/chats.ts",
      "src/commands/chats.ts",
    ]);
  });

  test("groups create and delete patches for the same path", () => {
    const groups = mergedFileDiffs([
      item({
        id: "create",
        path: "src/example.ts",
        at: 1,
        before: null,
        after: "temporary\n",
        diff: "--- /dev/null\n+++ b/src/example.ts\n@@ -0,0 +1 @@\n+temporary",
      }),
      item({
        id: "delete",
        path: "./src/example.ts",
        at: 2,
        before: "temporary\n",
        after: null,
        diff: "--- a/src/example.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-temporary",
      }),
    ]);

    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.path).toBe("./src/example.ts");
    expect(group.items?.map((source) => source.id)).toEqual([
      "create",
      "delete",
    ]);
    expect(group.stats?.added).toBe(0);
    expect(group.stats?.removed).toBe(0);
  });
});
