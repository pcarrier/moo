import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");

describe("timeline subagent prompt formatting", () => {
  test("preserves fenced code block line breaks in expanded prompt markdown", () => {
    expect(css).toContain(".runjs-markdown :not(pre) > code");
    expect(css).toContain(".runjs-markdown pre code");
    expect(css).toContain("white-space: inherit;");
    expect(css).not.toContain(`.runjs-markdown code {
  white-space: nowrap;`);
  });
});
