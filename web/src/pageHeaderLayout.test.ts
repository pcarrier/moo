import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";

const css = readStylesheetForTest();

function cssRuleBody(selector: string) {
  const marker = selector + " {";
  const start = css.indexOf(marker);
  if (start < 0) throw new Error("missing CSS rule: " + selector);
  const bodyStart = start + marker.length;
  const end = css.indexOf("}\n", bodyStart);
  if (end < 0) throw new Error("unterminated CSS rule: " + selector);
  return css.slice(bodyStart, end);
}


describe("page header layout", () => {
  test("keeps page sidebar toggles the same compact size as chat headers", () => {
    const chatToggle = cssRuleBody(".conv-header .header-icon-button,\n.conv-header .right-sidebar-toggle");
    expect(chatToggle).toContain("inline-size: 22px");
    expect(chatToggle).toContain("block-size: 22px");

    const pageToggle = cssRuleBody(".page-header > .header-icon-button:first-child");
    expect(pageToggle).toContain("inline-size: 22px");
    expect(pageToggle).toContain("block-size: 22px");
    expect(pageToggle).toContain("flex-basis: 22px");
    expect(pageToggle).toContain("font-size: 0.9rem");
  });

  test("uses shared page chrome on memory, mcp, and settings routes", () => {
    const memory = readFileSync(new URL("./MemoryView.tsx", import.meta.url), "utf8");
    const mcp = readFileSync(new URL("./McpView.tsx", import.meta.url), "utf8");
    const settings = readFileSync(new URL("./SettingsView.tsx", import.meta.url), "utf8");

    expect(memory).toContain("<PageHeader");
    expect(mcp).toContain("<PageHeader");
    expect(settings).toContain("<PageHeader");
  });
});


describe("shared header controls", () => {
  test("page chrome delegates sidebar controls to shared components", () => {
    const pageChrome = readFileSync(new URL("./PageChrome.tsx", import.meta.url), "utf8");
    expect(pageChrome).toContain('import { HeaderIconButton, LeftSidebarToggle, RightSidebarToggle, joinClasses } from "./HeaderControls";');
    expect(pageChrome).toContain("<LeftSidebarToggle onToggleSidebar={props.onToggleSidebar} />");
    expect(pageChrome).not.toContain("<MenuIcon />");
  });

  test("shared controls own sidebar toggle icons and button sizing class", () => {
    const controls = readFileSync(new URL("./HeaderControls.tsx", import.meta.url), "utf8");
    expect(controls).toContain("export function HeaderIconButton");
    expect(controls).toContain("export function LeftSidebarToggle");
    expect(controls).toContain("export function RightSidebarToggle");
    expect(controls).toContain('class={joinClasses("header-icon-button", local.class)}');
    expect(controls).toContain("<MenuIcon />");
    expect(controls).toContain("<PanelIcon />");
  });
});


describe("path ellipsis", () => {
  test("keeps left-side ellipsis without reordering path separators", () => {
    const diffPathRule = cssRuleBody(
      ".diff-file-jump-path,\n.right-diff-row:not(.trail-memory-diff-row) .right-diff-path,\n.repo-file-header .right-diff-title-row strong",
    );
    expect(diffPathRule).toContain("direction: rtl;");
    expect(diffPathRule).toContain("text-align: left;");
    expect(diffPathRule).toContain("unicode-bidi: isolate;");

    const textRule = cssRuleBody(".path-ellipsis-text");
    expect(textRule).toContain("direction: ltr;");
    expect(textRule).toContain("unicode-bidi: isolate;");

    const trailPathRule = cssRuleBody(".agent-trail-path");
    expect(trailPathRule).toContain("direction: rtl;");
    expect(trailPathRule).toContain("unicode-bidi: isolate;");

    const sidebar = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
    expect(sidebar).toContain('class="diff-file-jump-path"><span class="path-ellipsis-text"');
    expect(sidebar).toContain('class="right-diff-path"><span class="path-ellipsis-text"');
    expect(sidebar).toContain('<strong title={props.displayPath}><span class="path-ellipsis-text"');
  });
});
