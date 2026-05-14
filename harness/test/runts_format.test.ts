import { describe, expect, test } from "bun:test";
import { serializeToolValue } from "../src/agent";

describe("runTS result formatting", () => {
  test("uses indented multiline HJSON for code-like strings", () => {
    const code = [
      "function greet(name) {",
      "  if (!name) {",
      '    return "hello";',
      "  }",
      "",
      "  return `hello ${name}`;",
      "}",
    ].join("\n");

    const text = serializeToolValue({ snippets: { typescript: code } });

    expect(text).toContain("typescript: '''");
    expect(text).toContain("    function greet(name) {");
    expect(text).toContain("        if (!name) {");
    expect(text).toContain("          return \"hello\";");
  });

  test("still uses indented multiline HJSON for plain text", () => {
    expect(serializeToolValue({ output: "first\nsecond" })).toBe(`{
  output: '''
    first
    second
    '''
}`);
  });
});
