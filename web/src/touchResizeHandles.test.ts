import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";

const css = readStylesheetForTest();
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const chatApps = readFileSync(
  new URL("./ChatApps.tsx", import.meta.url),
  "utf8",
);
const sidebar = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
const terminal = readFileSync(
  new URL("./TerminalView.tsx", import.meta.url),
  "utf8",
);
const resizeDrag = readFileSync(
  new URL("./resizeDrag.ts", import.meta.url),
  "utf8",
);

function cssRuleBody(selector: string) {
  const marker = selector + " {";
  const start = css.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = start + marker.length;
  const end = css.indexOf("}\n", bodyStart);
  expect(end).toBeGreaterThan(bodyStart);
  return css.slice(bodyStart, end);
}

describe("touch resize handles", () => {
  test("resizers use pointer capture instead of mouse-only window drags", () => {
    expect(resizeDrag).toContain('addEventListener("pointerdown"');
    expect(resizeDrag).toContain("handle.setPointerCapture?.(event.pointerId)");

    for (const source of [app, chatApps, sidebar, terminal]) {
      expect(source).toContain("installPointerResize");
      expect(source).not.toContain('addEventListener("mousemove"');
      expect(source).not.toContain('addEventListener("mouseup"');
    }
    expect(chatApps).not.toContain("onMouseDown={");
  });

  test("resize handles suppress page panning and have touch-sized hit targets", () => {
    const terminalResizer = cssRuleBody(".chat-terminal-resizer");
    expect(terminalResizer).toContain("block-size: 1rem;");
    expect(terminalResizer).toContain("touch-action: none;");

    const leftResizer = cssRuleBody(".resizer");
    expect(leftResizer).toContain("width: 1rem;");
    expect(leftResizer).toContain("touch-action: none;");

    const rightResizer = cssRuleBody(".right-sidebar-resizer");
    expect(rightResizer).toContain("width: 1rem;");
    expect(rightResizer).toContain("touch-action: none;");

    const panelResizer = cssRuleBody(".ui-panel-resizer");
    expect(panelResizer).toContain("width: 1rem;");
    expect(panelResizer).toContain("touch-action: none;");
  });

  test("mobile overlays keep resize handles enabled and width-backed", () => {
    expect(css).toContain(
      "width: min(var(--sidebar-mobile-w, 20rem), calc(100vw - 3.25rem));",
    );
    expect(css).toContain(
      "inset: 0 auto 0 min(var(--sidebar-mobile-w, 20rem), calc(100vw - 3.25rem));",
    );
    expect(css).toContain(
      "width: min(var(--right-sidebar-mobile-w, 24rem), calc(100vw - 2rem));",
    );
    expect(css).toContain("width: min(var(--ui-panel-w, 100vw), 100vw);");
    expect(css).toContain(".right-sidebar-resizer {\n    display: block;");
    expect(css).toContain(".ui-panel-resizer {\n    display: block;");
  });
});
