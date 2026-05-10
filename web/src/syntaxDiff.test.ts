import { describe, expect, test } from "bun:test";
import { formatHjson, formatHjsonTextForView, highlightDiff, highlightAuto, highlightHjson, highlightHjsonValue, highlightJson, highlightLineFragmentByPath } from "./syntax";

describe("highlightDiff", () => {
  test("does not put source newlines inside block-level diff rows", () => {
    const html = highlightDiff("-old\n+new\n", "example.ts");

    expect(html).toContain('<span class="diff-code-line diff-code-del">');
    expect(html).toContain('<span class="diff-code-line diff-code-add">');
    expect(html).not.toContain("\n</span>");
    expect(html).not.toContain("\r</span>");
  });

  test("preserves diff body indentation while highlighting JSON", () => {
    const html = highlightDiff(`--- a/package.json
+++ b/package.json
@@ -1,4 +1,4 @@
 {
-  "preview": "vite preview"
+  "preview": "vite preview --host"
 }
`, "package.json");

    expect(html).toContain('<span class="diff-code-prefix">-</span>  <span class="token property">"preview"</span>');
    expect(html).toContain('<span class="diff-code-prefix">+</span>  <span class="token property">"preview"</span>');
    expect(html).not.toContain('<span class="diff-code-prefix">-</span><span class="token property">"preview"</span>');
  });


  test("highlights Nix diff line fragments by path", () => {
    const html = highlightLineFragmentByPath('  services.nginx.enable = true;', "flake.nix");

    expect(html).toContain('services<span class="token punctuation">.</span>nginx<span class="token punctuation">.</span>enable');
    expect(html).toContain('<span class="token operator">=</span>');
    expect(html).toContain('<span class="token boolean">true</span>');
  });

  test("highlights Nix diff bodies from file headers", () => {
    const html = highlightDiff(`--- a/flake.nix
+++ b/flake.nix
@@ -1 +1 @@
-  services.nginx.enable = false;
+  services.nginx.enable = true;
`, null);

    expect(html).toContain('<span class="diff-code-prefix">+</span>  services<span class="token punctuation">.</span>nginx<span class="token punctuation">.</span>enable');
    expect(html).toContain('<span class="token operator">=</span>');
    expect(html).toContain('<span class="token boolean">true</span>');
  });


  test("uses Prism's registered aliases for path languages", () => {
    const html = highlightLineFragmentByPath("const answer: number = 42;", "example.ts");

    expect(html).toContain('<span class="token keyword">const</span>');
    expect(html).toContain('<span class="token builtin">number</span>');
    expect(html).toContain('<span class="token number">42</span>');
  });

  test("keeps extension-only fallbacks that Prism does not alias", () => {
    const html = highlightLineFragmentByPath("fn main() { true; }", "main.rs");

    expect(html).toContain('<span class="token keyword">fn</span>');
    expect(html).toContain('<span class="token boolean">true</span>');
  });

  test("highlights JSON line fragments without formatting them as objects", () => {
    const html = highlightLineFragmentByPath('  "preview": "vite preview --host",', "web/package.json");

    expect(html).toContain('  <span class="token property">"preview"</span>');
    expect(html).toContain('<span class="token string">"vite preview --host"</span>');
    expect(html).not.toContain('<span class="json-punct">{</span>');
    expect(html).not.toContain("\n");
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


  test("preserves JSONC comments when formatting for HJSON view", () => {
    const text = `{
  // service command
  "command": "bun test", // runs tests
  "args": [
    // keep watch mode
    "--watch"
  ]
}`;

    expect(formatHjsonTextForView(text)).toBe(`{
  // service command
  command: "bun test" // runs tests
  args: [
    // keep watch mode
    "--watch"
  ]
}`);
  });


  test("preserves leading object and multiline block JSONC comments", () => {
    const text = `// line comments
{
  // object comments
  "id": "linear",
  "title": "Implement Linear ticket",

  /*
    block comments
  */
  "steps": [
    {
      "id": "ticket.get",
      "kind": "mcp.call",
      "server": "linear",
      "tool": "getIssue"
    }
  ]
}`;

    expect(formatHjsonTextForView(text)).toBe(`// line comments
{
  // object comments
  id: "linear"
  title: "Implement Linear ticket"
  /*
  block comments
  */
  steps: [
    {
      id: "ticket.get"
      kind: "mcp.call"
      server: "linear"
      tool: "getIssue"
    }
  ]
}`);
  });

  test("preserves JSONC comments in highlighted foldable HJSON", () => {
    const html = highlightHjson(`{
  // service command
  "command": "bun test" // runs tests
}`);

    expect(html).toContain('<span class="json-comment">// service command</span>');
    expect(html).toContain('<span class="json-comment">// runs tests</span>');
    expect(html).toContain('class="hjson-collapsible hjson-object"');

    const leadingHtml = highlightHjson(`// leading\n{\n  "command": "bun test"\n}`);
    expect(leadingHtml.indexOf('<span class="json-comment">// leading</span>')).toBeLessThan(leadingHtml.indexOf('class="hjson-collapsible hjson-object"'));
  });


  test("syntax-highlights markdown strings in highlighted JSON", () => {
    const html = highlightJson(JSON.stringify({ output: "# Result\n\n- **ok**\n- [file](web/src/syntax.ts)" }));

    expect(html).toContain('<span class="json-embedded">    <span class="token title important"><span class="token punctuation">#</span> Result</span>');
    expect(html).toContain('<span class="token list punctuation">-</span> <span class="token bold"><span class="token punctuation">**</span><span class="token content">ok</span><span class="token punctuation">**</span></span>');
    expect(html).toContain('<span class="token url">[<span class="token content">file</span>](<span class="token url">web/src/syntax.ts</span>)</span>');
    expect(html).not.toContain('<h1>Result</h1>');
    expect(html).not.toContain('\\n');
  });

  test("indents multiline string bodies below their delimiters", () => {
    expect(formatHjson({ output: "first\nsecond" })).toBe(`{
  output: '''
    first
    second
  '''
}`);
  });

  test("highlights multiline string bodies below their delimiters", () => {
    const html = highlightHjsonValue({ output: "first\nsecond" });

    expect(html).toContain('<span class="json-embedded">    first\n    second</span>');
    expect(html).toContain(`\n  <span class="json-str">'''</span>`);
  });

  test("uses multiline strings for code-like indentation", () => {
    const code = [
      'function greet(name) {',
      '  if (!name) {',
      '    return "hello";',
      '  }',
      '',
      '  return `hello ${name}`;',
      '}',
    ].join("\n");
    const text = formatHjson({ snippets: { javascript: code } });

    expect(text).toContain("javascript: '''");
    expect(text).toContain("    function greet(name) {");
    expect(text).toContain("        if (!name) {");
    expect(text).toContain("          return \"hello\";");
  });

  test("highlights code-like multiline strings without collapsing indentation", () => {
    const code = [
      'function greet(name) {',
      '  if (!name) {',
      '    return "hello";',
      '  }',
      '',
      '  return `hello ${name}`;',
      '}',
    ].join("\n");
    const html = highlightAuto(formatHjson({ snippets: { javascript: code } }));

    expect(html).toContain('\n        <span class="token keyword">if</span>');
    expect(html).toContain('\n          <span class="token keyword">return</span>');
  });

  test("highlights double-encoded structured JSON as nested HJSON", () => {
    const html = highlightAuto(JSON.stringify(JSON.stringify({ nested: { answer: 42 } })));

    expect(html).toContain('<span class="json-key">nested</span>');
    expect(html).toContain('<span class="json-num">42</span>');
    expect(html).not.toContain('\\&quot;nested\\&quot;');
  });

  test("wraps highlighted HJSON containers and long strings with collapsible controls", () => {
    const html = highlightHjsonValue({
      nested: { answer: 42 },
      list: ["a", "b"],
      output: "first\nsecond",
      long: "x".repeat(120),
    });

    expect(html).toContain('class="hjson-collapsible hjson-object" data-hjson-kind="object"');
    expect(html).toContain('class="hjson-collapsible hjson-array" data-hjson-kind="array"');
    expect(html).toContain('class="hjson-collapsible hjson-string" data-hjson-kind="string"');
    expect(html).toContain('class="hjson-toggle" aria-expanded="true" aria-label="collapse object"');
    expect(html).toContain('<span class="hjson-collapsed-preview" aria-hidden="true">… 4 keys</span>');
    expect(html).toContain('<span class="hjson-collapsed-preview" aria-hidden="true">… 2 items</span>');
    expect(html).toContain(`<span class="hjson-string-expanded"><span class="json-str">'''</span>`);
  });

  test("can link exact sha256 HJSON string values", () => {
    const html = highlightHjsonValue(
      {
        hash: "sha256:25462de28abcb84a7da69237ee277ea3c778105c5a2c7f0805eae082b07758b4",
        parent: "sha256:5506256380167bd8874366d81dc23c6c794c4577e93786b3fe380419ea3fff35",
        note: "prefix sha256:25462de28abcb84a7da69237ee277ea3c778105c5a2c7f0805eae082b07758b4 suffix",
      },
      { linkStoreHashes: true },
    );

    expect(html).toContain('data-store-hash="sha256:25462de28abcb84a7da69237ee277ea3c778105c5a2c7f0805eae082b07758b4"');
    expect(html).toContain('data-store-hash="sha256:5506256380167bd8874366d81dc23c6c794c4577e93786b3fe380419ea3fff35"');
    expect(html).toContain('class="store-link json-store-link"');
    expect(html).not.toContain('data-store-hash="prefix');
  });

});
