import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const baseCss = readFileSync(
  new URL("./styles/base.css", import.meta.url),
  "utf8",
);

describe("virtual-keyboard viewport offset (iPadOS)", () => {
  test("App.tsx tracks the visual-viewport offset, not just its height", () => {
    // iPadOS scrolls the layout viewport on keyboard open; the app must follow
    // the visual viewport's offset or it slides off-screen.
    expect(app).toContain("visualViewport?.offsetTop ?? 0");
    expect(app).toContain("visualViewport?.offsetLeft ?? 0");
    expect(app).toContain('"--app-viewport-offset-top"');
    expect(app).toContain('"--app-viewport-offset-left"');
    // Cleared on unmount alongside the other viewport vars.
    expect(app).toContain(
      'removeProperty("--app-viewport-offset-top")',
    );
  });

  test("base.css translates the shell to follow the visual viewport", () => {
    expect(baseCss).toContain("--app-viewport-offset-top: 0px;");
    expect(baseCss).toContain("--app-viewport-offset-left: 0px;");
    // The layout viewport is the clip container.
    expect(baseCss).toMatch(/html\s*\{[^}]*overflow:\s*hidden/);
    // The shell is translated by the offsets (no-op at rest).
    const body = baseCss.slice(
      baseCss.indexOf("\nbody {"),
      baseCss.indexOf("\nbutton {"),
    );
    expect(body).toContain("transform: translate(");
    expect(body).toContain("var(--app-viewport-offset-left, 0px)");
    expect(body).toContain("var(--app-viewport-offset-top, 0px)");
  });
});
