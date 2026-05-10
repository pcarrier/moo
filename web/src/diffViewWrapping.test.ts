import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";

const diffView = readFileSync(new URL("./DiffView.tsx", import.meta.url), "utf8");
const css = readStylesheetForTest();

describe("sidebar diff wrapping", () => {
  test("keeps the diff gutter in a non-wrapping flex item", () => {
    expect(diffView).toContain('<span class="diff-line-body">');
    expect(diffView).toContain('prefix = { text: "+" };');
    expect(diffView).toContain('prefix = { text: "-" };');
    expect(diffView).toContain('return { cls, prefix, parts: linkifyHighlightedText(body, path, highlightBody) };');
    expect(diffView).not.toContain('linkifyHighlightedText(prefixHtml');

    expect(css).toContain(`.diff-line {
  display: flex;
  align-items: baseline;`);
    expect(css).toContain(`.diff-line-body {
  flex: 1 1 auto;
  min-inline-size: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;`);
    expect(css).toContain(`.diff-prefix {
  display: inline-block;
  flex: 0 0 1.2em;
  width: 1.2em;`);
    expect(css).toContain(`.diff-prefix {
  display: inline-block;
  flex: 0 0 1.2em;
  width: 1.2em;
  user-select: none;
  color: var(--muted);
  white-space: pre;
  overflow-wrap: normal;
  word-break: normal;`);
    expect(css).toContain(`.file-diff-body .diff-line {
  white-space: pre-wrap;
  overflow-wrap: normal;`);
  });
});
