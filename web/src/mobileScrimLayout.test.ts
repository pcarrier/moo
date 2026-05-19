import { describe, expect, test } from "bun:test";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";

const css = readStylesheetForTest();

function cssRuleBody(selector: string) {
  const marker = selector + " {";
  const start = css.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = start + marker.length;
  const end = css.indexOf("}\n", bodyStart);
  expect(end).toBeGreaterThan(bodyStart);
  return css.slice(bodyStart, end);
}

describe("mobile scrim layout", () => {
  test("keeps scrim hover from inheriting generic button hover", () => {
    const genericHoverStart = css.indexOf("button:hover:not(:disabled) {");
    const scrimHoverStart = css.indexOf(
      ".mobile-scrim:hover:not(:disabled),\n  .mobile-scrim:active:not(:disabled) {",
    );

    expect(genericHoverStart).toBeGreaterThanOrEqual(0);
    expect(scrimHoverStart).toBeGreaterThan(genericHoverStart);
    expect(
      cssRuleBody(
        ".mobile-scrim:hover:not(:disabled),\n  .mobile-scrim:active:not(:disabled)",
      ),
    ).toContain("background: rgba(0, 0, 0, 0.35);");
  });
});
