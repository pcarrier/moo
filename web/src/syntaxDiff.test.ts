import { describe, expect, test } from "bun:test";
import { formatHjsonTextForView, highlightDiff, highlightAuto } from "./syntax";

describe("highlightDiff", () => {
  test("does not put source newlines inside block-level diff rows", () => {
    const html = highlightDiff("-old\n+new\n", "example.ts");

    expect(html).toContain('<span class="diff-code-line diff-code-del">');
    expect(html).toContain('<span class="diff-code-line diff-code-add">');
    expect(html).not.toContain("\n</span>");
    expect(html).not.toContain("\r</span>");
  });
});

describe("HJSON text formatting", () => {
  test("unwraps JSON strings that contain structured JSON", () => {
    const text = JSON.stringify(JSON.stringify({ nested: { answer: 42 }, list: ["a", "b"] }));

    expect(formatHjsonTextForView(text)).toBe(`{
  nested: {
    answer: 42
  }
  list: [
    "a"
    "b"
  ]
}`);
  });

  test("highlights double-encoded structured JSON as nested HJSON", () => {
    const html = highlightAuto(JSON.stringify(JSON.stringify({ nested: { answer: 42 } })));

    expect(html).toContain('<span class="json-key">nested</span>');
    expect(html).toContain('<span class="json-num">42</span>');
    expect(html).not.toContain('\\&quot;nested\\&quot;');
  });
});
