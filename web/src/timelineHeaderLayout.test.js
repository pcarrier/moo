import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");

function cssRuleBody(selector) {
  const marker = `${selector} {`;
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`missing CSS rule: ${selector}`);
  const bodyStart = start + marker.length;
  const end = css.indexOf("}\n", bodyStart);
  if (end < 0) throw new Error(`unterminated CSS rule: ${selector}`);
  return css.slice(bodyStart, end);
}

describe("timeline loading header layout", () => {
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
    expect(timeline).toContain("<TokenBar tokens={bag.tokens} />");
  });
});
