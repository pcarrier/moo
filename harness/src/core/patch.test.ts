import { describe, expect, test } from "bun:test";

import { patchText, validatePatchEnvelopeTarget } from "./patch";

describe("patchText", () => {
  test("empty diff returns original", () => {
    expect(patchText("hello\n", "")).toBe("hello\n");
  });

  test("applies unified additions, removals, and replacements", () => {
    expect(patchText("a\nb\nc\n", "@@ -1,3 +1,4 @@\n a\n+x\n b\n c\n")).toBe("a\nx\nb\nc\n");
    expect(patchText("a\nb\nc\n", "@@ -1,3 +1,2 @@\n a\n-b\n c\n")).toBe("a\nc\n");
    expect(patchText("a\nb\nc\n", "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n")).toBe("a\nB\nc\n");
  });

  test("accepts apply-patch envelopes around hunks", () => {
    const diff = "*** Begin Patch\n*** Update File: sample.txt\n@@\n a\n-b\n+B\n c\n*** End Patch\n";
    expect(patchText("a\nb\nc\n", diff)).toBe("a\nB\nc\n");
  });
  test("validates apply-patch envelope targets for single-file patching", () => {
    expect(() => validatePatchEnvelopeTarget(
      "*** Begin Patch\n*** Update File: sample.txt\n@@\n-a\n+b\n*** End Patch\n",
      "sample.txt",
    )).not.toThrow();

    expect(() => validatePatchEnvelopeTarget(
      "*** Begin Patch\n*** Update File: other.txt\n@@\n-a\n+b\n*** End Patch\n",
      "sample.txt",
    )).toThrow("does not match requested path");

    for (const directive of ["*** Add File: sample.txt", "*** Delete File: sample.txt", "*** Move to: other.txt"]) {
      expect(() => validatePatchEnvelopeTarget(
        "*** Begin Patch\n" + directive + "\n@@\n-a\n+b\n*** End Patch\n",
        "sample.txt",
      )).toThrow("only supports updating one existing file");
    }
  });

  test("preserves no-newline-at-eof marker", () => {
    const diff = "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n";
    expect(patchText("a\nb", diff)).toBe("a\nB");
  });

  test("preserves dominant CRLF endings", () => {
    const original = "alpha\r\nbeta\r\ngamma\r\n";
    const diff = "@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n";
    expect(patchText(original, diff)).toBe("alpha\r\nBETA\r\ngamma\r\n");
  });

  test("rejects blank hunk lines like the Python implementation", () => {
    const diff = "@@ -1,3 +1,3 @@\n a\n-b\n\n+B\n c\n";
    expect(() => patchText("a\nb\nc\n", diff)).toThrow();
  });

  test("applies unified hunks whose header counts do not match the body", () => {
    const diff = "@@ -1,1 +1,2 @@\n a\n b\n+B\n c\n";
    expect(patchText("a\nb\nc\n", diff)).toBe("a\nb\nB\nc\n");
  });

  test("relocates unified hunks by source body when header line numbers are stale", () => {
    const diff = "@@ -1,2 +1,2 @@\n c\n-d\n+D\n";
    expect(patchText("a\nb\nc\nd\ne\n", diff)).toBe("a\nb\nc\nD\ne\n");
  });

  test("skips stale context-only lines in unified hunks", () => {
    const diff = "@@ -1,4 +1,5 @@\n a\n stale\n b\n+added\n c\n";
    expect(patchText("a\nb\nc\n", diff)).toBe("a\nb\nadded\nc\n");
  });

  test("handles pure insertion hunks at file boundaries", () => {
    expect(patchText("a\nb\n", "@@ -3,0 +3,2 @@\n+c\n+d\n")).toBe("a\nb\nc\nd\n");
    expect(patchText("a\n", "@@ -1,0 +1,3 @@\n+inserted_line1\n+inserted_line2\n a\n")).toBe("inserted_line1\ninserted_line2\na\n");
  });

  test("relocates stale hunks while preserving idempotency failures", () => {
    expect(patchText("line1\nline2\nline3\n", "@@ -1,2 +1,3 @@\n line1\n line2\n+inserted\n")).toBe("line1\nline2\ninserted\nline3\n");
    expect(patchText("a\nb\nc\n", "@@ -1,2 +1,3 @@\n a\n b\n+inserted\n")).toBe("a\nb\ninserted\nc\n");

    const diff = "@@ -1,3 +1,4 @@\n a\n b\n+inserted\n c\n";
    const once = patchText("a\nb\nc\n", diff);
    expect(once).toBe("a\nb\ninserted\nc\n");
    expect(() => patchText(once, diff)).toThrow();
  });
});
