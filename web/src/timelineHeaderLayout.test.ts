import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";

const css = readStylesheetForTest();
const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");

function cssRuleBody(selector: string) {
  const marker = `${selector} {`;
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`missing CSS rule: ${selector}`);
  const bodyStart = start + marker.length;
  const end = css.indexOf("}\n", bodyStart);
  if (end < 0) throw new Error(`unterminated CSS rule: ${selector}`);
  return css.slice(bodyStart, end);
}

describe("timeline loading header layout", () => {
  test("keeps the loaded header aligned with sidebar chrome", () => {
    const body = cssRuleBody(".conv-header");
    expect(body).toContain("block-size: var(--top-bar-h)");
    expect(body).toContain("max-block-size: var(--top-bar-h)");
    expect(body).toContain("flex: 0 0 var(--top-bar-h)");
    expect(body).toContain("padding: calc((var(--top-bar-h) - var(--top-bar-button-size)) / 2) 0.55rem");
  });

  test("pins the loading header to the top-bar height", () => {
    const body = cssRuleBody(".conv-header.chat-loading");
    expect(body).toContain("block-size: var(--top-bar-h)");
    expect(body).toContain("min-block-size: var(--top-bar-h)");
    expect(body).toContain("max-block-size: var(--top-bar-h)");
    expect(body).toContain("flex: 0 0 var(--top-bar-h)");
    expect(body).toContain('grid-template-areas: "nav parent title right"');
    expect(body).toContain("overflow: hidden");
    expect(css.indexOf(".conv-header.chat-loading")).toBeGreaterThan(css.indexOf("@container conversation-main (max-width: 30rem)"));
  });

  test("keeps bulky controls out until the timeline is loaded", () => {
    expect(timeline).toContain('classList={{ "chat-loading": chatLoading() }}');
    expect(timeline).toContain("<Show when={!chatLoading()}>");
    expect(timeline).toContain("<ModelPicker bag={bag} />");
    expect(timeline).toContain("<TokenBar tokens={bag.tokens} onCompact={bag.compactChat}");
    expect(timeline).toContain("token-compact-button");
  });

  test("places compact as a square icon button after the token bar", () => {
    const tokenBarIndex = timeline.indexOf('class="token-bar"');
    const compactButtonIndex = timeline.indexOf('class="token-compact-button"');
    expect(tokenBarIndex).toBeGreaterThan(0);
    expect(compactButtonIndex).toBeGreaterThan(tokenBarIndex);
    expect(timeline).toContain('aria-label={props.compacting() ? "Compacting older turns" : "Compact older turns"}');
    expect(timeline).toContain('<CompactIcon class="token-compact-icon" />');
    expect(timeline).toContain('import { CompactIcon } from "./icons";');
    expect(timeline).toContain('import { LeftSidebarToggle, RightSidebarToggle } from "./HeaderControls";');
    expect(timeline).not.toContain('>⇥<');

    const body = cssRuleBody(".token-compact-button");
    expect(body).toContain("inline-size: var(--compact-header-button-size)");
    expect(body).toContain("block-size: var(--compact-header-button-size)");
    expect(body).toContain("appearance: none");
    expect(body).toContain("display: inline-flex");
    expect(body).toContain("align-items: center");
    expect(body).toContain("justify-content: center");
    expect(body).toContain("border-radius: 0");
  });
});


describe("timeline diff overflow", () => {
  test("wraps inline timeline diffs instead of showing horizontal scrollbars", () => {
    const diffBodyRule = cssRuleBody(".file-diff-body");
    expect(diffBodyRule).toContain("overflow-x: hidden;");
    expect(diffBodyRule).toContain("white-space: pre-wrap;");

    const diffContentStart = css.indexOf(".file-diff-body .diff-scroll-content");
    const diffContentRule = css.slice(diffContentStart, css.indexOf("}\n", diffContentStart));
    expect(diffContentRule).toContain("width: 100%;");
    expect(diffContentRule).toContain("min-width: 0;");

    const diffLineStart = css.indexOf(".file-diff-body .diff-line");
    const diffLineRule = css.slice(diffLineStart, css.indexOf("}\n", diffLineStart));
    expect(diffLineRule).toContain("overflow-wrap: anywhere;");
  });

  test("keeps expanded hidden diff lines unboxed", () => {
    const diffBodyRule = cssRuleBody(".file-diff-body");
    expect(diffBodyRule).toContain("border: 0;");
    expect(diffBodyRule).toContain("background: transparent;");
    expect(diffBodyRule).not.toContain("border: 1px solid var(--line);");

    const collapsedRule = cssRuleBody(".diff-collapsed");
    expect(collapsedRule).not.toContain("border:");
    expect(collapsedRule).not.toContain("background:");

    const collapsedControlsRule = cssRuleBody(".diff-collapsed-controls");
    expect(collapsedControlsRule).toContain("background: transparent;");
    expect(collapsedControlsRule).not.toContain("border-block:");
  });
});


describe("timeline shared header controls", () => {
  test("timeline uses the shared left sidebar toggle", () => {
    expect(timeline).toContain("<LeftSidebarToggle onToggleSidebar={onToggleSidebar} />");
    expect(timeline).not.toContain('title="toggle sidebar"');
  });
});
