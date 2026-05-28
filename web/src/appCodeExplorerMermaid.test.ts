import { readFileSync } from "fs";
import { describe, expect, test } from "bun:test";

const source = readFileSync(
  new URL("./AppCodeExplorer.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("./styles/apps.css", import.meta.url),
  "utf8",
);

describe("code explorer Mermaid source preview", () => {
  test("detects Mermaid source files", () => {
    expect(source).toContain(
      'lower.endsWith(".mmd") || lower.endsWith(".mermaid")',
    );
  });

  test("renders Mermaid files as diagrams only in pretty mode", () => {
    expect(source).toContain("props.pretty && isMermaidSourcePath(props.path)");
    expect(source).toContain(
      'class="apps-code-rendered apps-code-mermaid mermaid"',
    );
    expect(source).toContain("data-mermaid-source={props.text}");
  });

  test("keeps oversized Mermaid diagrams scrollable from the top", () => {
    expect(styles).toContain(".apps-code-mermaid {");
    expect(styles).toContain("align-items: flex-start;");
    expect(styles).toContain("justify-content: flex-start;");
    expect(styles).not.toContain(`align-items: center;
  justify-content: center;`);
  });

  test("keeps Mermaid syntax errors within the source pane", () => {
    const errorRule = styles.match(/\.apps-code-mermaid\[data-mermaid-error\]\s*\{[^}]+\}/)?.[0] ?? "";
    expect(errorRule).toContain("max-inline-size: 100%;");
    expect(errorRule).toContain("min-inline-size: 0;");
    expect(errorRule).toContain("white-space: pre-wrap;");
    expect(errorRule).toContain("overflow-wrap: anywhere;");
    expect(errorRule).toContain("word-break: break-word;");
  });

  test("keeps Source mode as highlighted code", () => {
    expect(source).toContain('<pre class="apps-code-block">');
    expect(source).toContain("<code innerHTML={props.highlighted} />");
  });
});

describe("source view tabs", () => {
  test("uses Source/Preview tabs instead of a raw/pretty toggle", () => {
    expect(source).toContain('role="tablist"');
    expect(source).toContain('aria-label="source view"');
    expect(source).toContain("Source");
    expect(source).toContain("Preview");
    expect(source).not.toContain("apps-format-toggle");
    expect(source).not.toContain('{formatEnabled() ? "raw" : "pretty"}');
  });
});

