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

describe("terminal layout", () => {
  test("reserves a fixed-height panel above the timeline", () => {
    const shell = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
    expect(shell).toContain("<ChatTerminals");
    expect(shell.indexOf("<ChatTerminals")).toBeLessThan(shell.indexOf('<main class="timeline"'));

    const terminal = cssRuleBody(".chat-terminal");
    expect(terminal).toContain("flex: 0 0 auto;");
    expect(terminal).toContain("--chat-terminal-h: 36vh;");

    const panel = cssRuleBody(".chat-terminal-panel");
    expect(panel).toContain("block-size: var(--chat-terminal-h);");
    expect(panel).toContain("overflow: hidden;");

    const timeline = cssRuleBody(".conversation-main > .timeline");
    expect(timeline).toContain("flex: 1 1 0;");
    expect(timeline).toContain("min-block-size: 0;");
  });

  test("fills the reserved panel with the Blit terminal surface", () => {
    const surface = cssRuleBody(".moo-blit-terminal");
    expect(surface).toContain("width: 100%;");
    expect(surface).toContain("height: 100%;");

    const resizer = cssRuleBody(".chat-terminal-resizer");
    expect(resizer).toContain("position: absolute;");
    expect(resizer).toContain("cursor: row-resize;");
  });
});
