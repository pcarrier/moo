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

describe("mobile sidebar button sizing", () => {
  const sidebarRowsSelector = [".chat-select,", "  .sidebar-tab"].join("\n");

  test("does not inflate left sidebar rows across the full iPad-width mobile layout", () => {
    const mobileLayoutStart = css.indexOf("@media (max-width: 48rem) {");
    const phoneLayoutStart = css.indexOf("@media (max-width: 40rem) {");
    const touchErgonomicsStart = css.indexOf(
      "@media (hover: none) and (pointer: coarse) {",
    );
    expect(mobileLayoutStart).toBeGreaterThanOrEqual(0);
    expect(phoneLayoutStart).toBeGreaterThan(mobileLayoutStart);
    expect(touchErgonomicsStart).toBeGreaterThan(phoneLayoutStart);

    const ipadMobileLayout = css.slice(mobileLayoutStart, phoneLayoutStart);
    expect(ipadMobileLayout).not.toContain(sidebarRowsSelector);
    expect(ipadMobileLayout).toContain("padding-right: 2.15em;");
    expect(ipadMobileLayout).toContain(
      "width: var(--top-bar-button-mobile-size);",
    );

    const phoneLayout = css.slice(phoneLayoutStart, touchErgonomicsStart);
    expect(phoneLayout).toContain(sidebarRowsSelector);
    expect(phoneLayout).toContain("min-height: 2.75rem;");
    expect(phoneLayout).toContain("padding-right: 3rem;");
    expect(phoneLayout).toContain("width: 2.75rem;");

    const coarsePointerLayout = css.slice(touchErgonomicsStart);
    expect(coarsePointerLayout).not.toContain(sidebarRowsSelector);
    expect(coarsePointerLayout).toContain(
      "@media (hover: none) and (pointer: coarse) and (min-width: 40rem)",
    );
    expect(coarsePointerLayout).toContain(".sidebar .icon-btn {");
    expect(cssRuleBody(".sidebar .icon-btn")).toContain("min-width: 0;");
    expect(cssRuleBody(".sidebar .icon-btn")).toContain("min-height: 0;");
  });
});
