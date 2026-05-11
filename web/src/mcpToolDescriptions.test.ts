import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";

const view = readFileSync(new URL("./McpView.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles/mcp.css", import.meta.url), "utf8");
const markdown = readFileSync(new URL("./markdown.ts", import.meta.url), "utf8");

describe("MCP tool descriptions", () => {
  test("preserves description newlines while rendering markdown", () => {
    expect(view).toContain("renderToolDescriptionMarkdown");
    expect(markdown).toContain("const markedWithBreaks = new Marked({ gfm: true, breaks: true, renderer });");
    expect(markdown).toContain("export function renderToolDescriptionMarkdown(content: string): string");
  });

  test("renders full block markdown", () => {
    expect(view).toContain('import { renderToolDescriptionMarkdown } from "./markdown";');
    expect(view).toContain('<div class="mcp-tool-description markdown" innerHTML={renderToolDescriptionMarkdown(detail.summary)} />');
    expect(view).not.toContain("innerHTML={renderUserMessage(detail.summary)}");
    expect(view).not.toContain('<span class="mcp-tool-summary">{detail.summary}</span>');
    expect(css).toContain(".mcp-tool-description.markdown pre");
    expect(css).toContain(".mcp-tool-description.markdown h1");
    expect(css).toContain("white-space: pre-wrap;");
  });
  test("renders tool titles separately from descriptions", () => {
    expect(view).toContain('<div class="mcp-tool-title">{tool.title || tool.name}</div>');
    expect(view).toContain('<div class="mcp-tool-name">{tool.name}</div>');
    expect(view.indexOf('class="mcp-tool-description markdown"')).toBeLessThan(view.indexOf('class="mcp-tool-signature"'));
  });

  test("uses full tool descriptions instead of truncated dense summaries", () => {
    expect(view).toContain("return { shape, summary: tool.description || denseSummary };");
    expect(view).not.toContain("return { shape: text.slice(0, idx), summary: text.slice(idx + 2) };");
  });
});



test("renders XML-like example blocks as highlighted code blocks", async () => {
  const { renderToolDescriptionMarkdown } = await import("./markdown");
  const html = renderToolDescriptionMarkdown("Use this:\n<example>{\n  \"team\": \"MOO\"\n}</example>");
  expect(html).toContain('class="mcp-example-title">EXAMPLE</div>');
  expect(html.indexOf('class="mcp-example-title"')).toBeLessThan(html.indexOf('class="trace-json-block mcp-example-json"'));
  expect(html).toContain('<pre class="trace-json-block mcp-example-json"><code>');
  expect(html).toContain('class="hjson-collapsible hjson-object"');
  expect(html).toContain('class="hjson-toggle"');
  expect(html).toContain("team");
  expect(html).not.toContain("<example>");
});

test("normalizes multiline strings in example blocks", async () => {
  const { renderToolDescriptionMarkdown } = await import("./markdown");
  const html = renderToolDescriptionMarkdown(`<example>{
  "content_updates": [
    {
      "old_str": "# Old Section
Old content here",
      "new_str": "# New Section
Updated content goes here"
    }
  ]
}</example>`);
  expect(html).toContain('class="hjson-collapsible hjson-object"');
  expect(html).toContain(`<span class="json-str">'''</span>`);
  expect(html).toContain("Old content here");
  expect(html).toContain("Updated content goes here");
  expect(html).not.toContain(`Old Section
Old content here"<span`);
});


test("formats escaped multiline strings in examples as expanded HJSON", async () => {
  const { renderToolDescriptionMarkdown } = await import("./markdown");
  const html = renderToolDescriptionMarkdown(`<example>{
    "pages": [
      {
        "properties": {"title": "Page title"},
        "content": "# Section 1 {color=\\"blue\\"}\\nSection 1 content\\n<details>\\n<summary>Toggle block</summary>\\n   Hidden content inside toggle\\n</details>"
      }
    ]
  }</example>`);

  expect(html).toContain('class="hjson-collapsible hjson-object"');
  expect(html).toContain("'''");
  expect(html).toContain("Section 1");
  expect(html).toContain('class="hjson-toggle"');
  expect(html).not.toContain('\\\\nSection 1 content');
});


test("repairs unescaped quotes before escaped multiline strings in examples", async () => {
  const { renderToolDescriptionMarkdown } = await import("./markdown");
  const html = renderToolDescriptionMarkdown(String.raw`<example>{
    "pages": [
      {
        "properties": {"title": "Page title"},
        "content": "# Section 1 {color="blue"}\nSection 1 content\n<details>\n<summary>Toggle block</summary>\n   Hidden content inside toggle\n</details>"
      }
    ]
  }</example>`);

  expect(html).toContain('class="hjson-collapsible hjson-object"');
  expect(html).toContain("'''");
  expect(html).toContain("Toggle block");
  expect(html).not.toContain('token string');
  expect(html).not.toContain('\\\\nSection 1 content');
});


test("formats compact JSON examples through collapsible HJSON", async () => {
  const { renderToolDescriptionMarkdown } = await import("./markdown");
  const html = renderToolDescriptionMarkdown(String.raw`<example>{"query": "design review", "data_source_url": "collection://f336d0bc-b841-465b-8045-024475c079dd", "filters": {"created_date_range": {"start_date": "2024-10-01"}, "created_by_user_ids": ["a1b2c3d4-e5f6-7890-abcd-ef1234567890", "b2c3d4e5-f6a7-8901-bcde-f12345678901"]}}</example>`);

  expect(html).toContain('class="trace-json-block mcp-example-json"');
  expect(html).toContain('class="hjson-collapsible hjson-object"');
  expect(html).toContain('class="hjson-toggle"');
  expect(html).toContain('created_by_user_ids');
  expect(html).not.toContain('language-hjson');
});
