import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";

const css = readStylesheetForTest();

describe("timeline subagent prompt formatting", () => {
  test("preserves fenced code block line breaks in expanded prompt markdown", () => {
    expect(css).toContain(".runts-markdown :not(pre) > code");
    expect(css).toContain(".runts-markdown pre code");
    expect(css).toContain("white-space: inherit;");
    expect(css).not.toContain(`.runts-markdown code {
  white-space: nowrap;`);
  });
});
