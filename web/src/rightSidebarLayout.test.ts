import { describe, expect, test } from "bun:test";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";

const css = readStylesheetForTest();

function cssBlockAfter(selector: string) {
  const start = css.indexOf(selector);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf("{", start) + 1;
  expect(bodyStart).toBeGreaterThan(0);
  const end = css.indexOf("}\n", bodyStart);
  expect(end).toBeGreaterThan(bodyStart);
  return css.slice(bodyStart, end);
}

describe("right sidebar layout", () => {
  test("maximized right sidebar collapses the hidden timeline column", () => {
    const collapsedOpenRule = css.indexOf("#app.collapsed.repo-file-open {");
    const maximizedCollapsedOpenRule = css.indexOf(
      "#app.collapsed.repo-file-open.right-sidebar-maximized",
    );

    expect(collapsedOpenRule).toBeGreaterThanOrEqual(0);
    expect(maximizedCollapsedOpenRule).toBeGreaterThan(collapsedOpenRule);
    expect(
      cssBlockAfter("#app.collapsed.repo-file-open.right-sidebar-maximized"),
    ).toContain("grid-template-columns: 0 0 minmax(0, 1fr);");
  });
});
