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

function cssBlockContaining(selector: string) {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`missing CSS selector: ${selector}`);
  const bodyStart = css.indexOf("{", start);
  if (bodyStart < 0) throw new Error(`missing CSS block: ${selector}`);
  const end = css.indexOf("}\n", bodyStart);
  if (end < 0) throw new Error(`unterminated CSS block: ${selector}`);
  return css.slice(start, end);
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

  test("keeps the token meter compact in narrow headers", () => {
    const narrowStart = css.indexOf("@container conversation-main (max-width: 30rem)");
    expect(narrowStart).toBeGreaterThan(0);
    const loadingStart = css.indexOf(".conv-header.chat-loading", narrowStart);
    expect(loadingStart).toBeGreaterThan(narrowStart);
    const narrowBlock = css.slice(narrowStart, loadingStart);

    expect(narrowBlock).toContain(".conv-token-slot");
    expect(narrowBlock).toContain("justify-content: flex-start");
    expect(narrowBlock).toContain(".token-meter {");
    expect(narrowBlock).toContain("inline-size: auto");
    expect(narrowBlock).toContain("flex: 0 0 auto");
    expect(narrowBlock).toContain(".token-meter-head");
    expect(narrowBlock).toContain("display: none");
    expect(narrowBlock).toContain(".token-bar {");
    expect(narrowBlock).toContain("inline-size: clamp(5rem, 28cqw, 8rem)");
    expect(narrowBlock).toContain("flex: 0 0 clamp(5rem, 28cqw, 8rem)");
  });

  test("renders token usage against full context with a compaction marker", () => {
    expect(timeline).toContain("tokens.used / safeBudget()");
    expect(timeline).toContain("(tokens.threshold / safeBudget()) * 100");
    expect(timeline).toContain('<span class="token-mark" style={{ left: thresholdPct() + "%" }} />');
    expect(timeline).toContain("formatTokenCount(safeTokens().budget)");
    expect(timeline).not.toContain("const safeThreshold = () => Math.max(0, safeTokens().threshold)");
    expect(timeline).not.toContain("safeTokens().threshold || safeTokens().budget");
  });

  test("sizes timeline app code buttons with the app pills", () => {
    expect(timeline).toContain('class="timeline-header-app-group"');
    expect(timeline).toContain('class="timeline-header-app-code"');

    const groupBody = cssRuleBody(".timeline-header-app-group");
    expect(groupBody).toContain("display: inline-flex");
    expect(groupBody).toContain("align-items: stretch");
    expect(groupBody).toContain("flex: 0 0 auto");

    const appBody = cssRuleBody(".timeline-header-app");
    const codeBody = cssRuleBody(".timeline-header-app-code");
    expect(appBody).toContain("block-size: 1.55rem");
    expect(appBody).toContain("font-size: 0.72rem");
    expect(codeBody).toContain("block-size: 1.55rem");
    expect(codeBody).toContain("font-size: 0.72rem");
    expect(codeBody).toContain("line-height: 1");
    expect(codeBody).toContain("padding: 0 0.45rem");
    expect(codeBody).toContain("display: inline-flex");
    expect(codeBody).toContain("align-items: center");
    expect(codeBody).toContain("justify-content: center");
    expect(codeBody).toContain("border-radius: 0");
    expect(codeBody).toContain("margin-left: -1px");
    expect(codeBody).toContain("position: relative");
    expect(codeBody).not.toContain("border-left: 0");

    const iconBody = cssRuleBody(".timeline-header-app .app-icon");
    expect(iconBody).toContain("display: inline-block");
    expect(iconBody).toContain("inline-size: 1.15em");
    expect(iconBody).toContain("max-inline-size: 1.15em");
    expect(iconBody).toContain("overflow: hidden");
    expect(iconBody).toContain("white-space: nowrap");
  });

  test("keeps timeline app code hover from falling back to generic button hover", () => {
    const appHoverBody = cssBlockContaining(
      ".timeline-header-app:hover:not(:disabled),",
    );
    expect(appHoverBody).toContain(".timeline-header-app:focus-visible,");
    expect(appHoverBody).toContain(".timeline-header-app.active");
    expect(appHoverBody).toContain(
      "background: color-mix(in srgb, dodgerblue 12%, var(--button-hover-bg))",
    );
    expect(appHoverBody).toContain("z-index: 1");

    const codeHoverBody = cssBlockContaining(
      ".timeline-header-app-code:hover:not(:disabled),",
    );
    expect(codeHoverBody).toContain(".timeline-header-app-code:focus-visible");
    expect(codeHoverBody).toContain(
      "border-color: color-mix(in srgb, dodgerblue 65%, var(--line-strong))",
    );
    expect(codeHoverBody).toContain(
      "background: color-mix(in srgb, dodgerblue 12%, var(--button-hover-bg))",
    );
    expect(codeHoverBody).toContain("z-index: 2");
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

    const diffLineRule = cssRuleBody(".file-diff-body .diff-line");
    expect(diffLineRule).toContain("overflow-wrap: normal;");

    const diffLineBodyRule = cssRuleBody(".diff-line-body");
    expect(diffLineBodyRule).toContain("overflow-wrap: anywhere;");
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
