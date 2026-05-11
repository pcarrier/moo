import { describe, expect, test } from "bun:test";

import { applyUnifiedDiff } from "./applyPatch";

describe("applyUnifiedDiff", () => {
  test("empty diff returns original", () => {
    expect(applyUnifiedDiff("hello\n", "")).toBe("hello\n");
  });

  test("applies unified additions, removals, and replacements", () => {
    expect(applyUnifiedDiff("a\nb\nc\n", "@@ -1,3 +1,4 @@\n a\n+x\n b\n c\n")).toBe("a\nx\nb\nc\n");
    expect(applyUnifiedDiff("a\nb\nc\n", "@@ -1,3 +1,2 @@\n a\n-b\n c\n")).toBe("a\nc\n");
    expect(applyUnifiedDiff("a\nb\nc\n", "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n")).toBe("a\nB\nc\n");
  });

  test("preserves no-newline-at-eof marker", () => {
    const diff = "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n";
    expect(applyUnifiedDiff("a\nb", diff)).toBe("a\nB");
  });

  test("preserves dominant CRLF endings", () => {
    const original = "alpha\r\nbeta\r\ngamma\r\n";
    const diff = "@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n";
    expect(applyUnifiedDiff(original, diff)).toBe("alpha\r\nBETA\r\ngamma\r\n");
  });

  test("rejects blank hunk lines like the Python implementation", () => {
    const diff = "@@ -1,3 +1,3 @@\n a\n-b\n\n+B\n c\n";
    expect(() => applyUnifiedDiff("a\nb\nc\n", diff)).toThrow();
  });
});
