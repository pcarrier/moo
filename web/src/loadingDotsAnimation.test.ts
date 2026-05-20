import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";

const css = readStylesheetForTest();
const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const loadingDots = readFileSync(new URL("./LoadingDots.tsx", import.meta.url), "utf8");
const memoryView = readFileSync(new URL("./MemoryView.tsx", import.meta.url), "utf8");
const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");

function cssRuleBody(selector: string) {
  const marker = `${selector} {`;
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`missing CSS rule: ${selector}`);
  const bodyStart = start + marker.length;
  const end = css.indexOf("}\n", bodyStart);
  if (end < 0) throw new Error(`unterminated CSS rule: ${selector}`);
  return css.slice(bodyStart, end);
}

describe("loading dot animation", () => {
  test("uses one shared component structure for thinking and tool dots", () => {
    expect(loadingDots).toContain("export function LoadingDots");
    expect(loadingDots.match(/class=\"loading-dot\"/g)).toHaveLength(3);

    expect(timeline).toContain('<LoadingDots class="thinking-dots" label="loading chat" />');
    expect(timeline).toContain('class="thinking-dots"');
    expect(timeline).toContain('label="thinking"');
    expect(timeline).toContain('<LoadingDots class="compaction-dots" label="compacting" />');
    expect(timeline).toContain('<LoadingDots class="runts-loading" label="running" />');
    expect(timeline.match(/<LoadingDots class="runts-loading" label="running" \/>/g)).toHaveLength(2);

    expect(timeline).not.toContain('<span /><span /><span />');
    expect(timeline).not.toContain('class="dot"');
    expect(app).not.toContain('startup-loading-dots');
  });

  test("uses shared size and animation timing", () => {
    expect(cssRuleBody(":root")).toContain("--loading-dot-size: 0.45rem");
    expect(cssRuleBody(":root")).toContain("--loading-dot-duration: 1.2s");
    expect(cssRuleBody(":root")).toContain("--loading-dot-delay-step: 0.2s");

    expect(cssRuleBody(".loading-dots")).toContain("gap: var(--loading-dot-gap)");

    const body = cssRuleBody(".loading-dot");
    expect(body).toContain("width: var(--loading-dot-size)");
    expect(body).toContain("height: var(--loading-dot-size)");
    expect(body.replace(/\s+/g, " ")).toContain(
      "animation: loading-dot-blink var(--loading-dot-duration) infinite var(--loading-dot-easing)",
    );
  });

  test("keeps staggered dots in phase across indicators", () => {
    expect(loadingDots).toContain("Date.now() % 1200");
    expect(loadingDots).toContain('style={{ "--loading-dot-phase-delay": phaseDelay }}');

    expect(cssRuleBody(".loading-dot")).toContain(
      "animation-delay: var(--loading-dot-phase-delay, 0ms)",
    );
    expect(cssRuleBody(".loading-dot:nth-child(2)")).toContain(
      "var(--loading-dot-phase-delay, 0ms) + var(--loading-dot-delay-step)",
    );
    expect(cssRuleBody(".loading-dot:nth-child(3)")).toContain(
      "var(--loading-dot-phase-delay, 0ms) + var(--loading-dot-delay-step) * 2",
    );
  });

  test("does not keep divergent legacy loading dot selectors or animations", () => {
    expect(css).not.toContain(".thinking-dots .dot");
    expect(css).not.toContain(".runts-loading > span");
    expect(css).not.toContain(".boot-loading-dots span");
    expect(css).not.toContain("runts-loading-pulse");
    expect(css).not.toContain("animation: blink 1.2s");
    expect(css).not.toContain("animation: runts-loading-pulse 1.05s");
    expect(css).not.toContain("animation-delay: 0.18s");
    expect(css).not.toContain("animation-delay: 0.36s");
  });
});


describe("facts loading states", () => {
  test("shows loading dots only while facts requests are in flight", () => {
    expect(memoryView).toContain('when={bag.graphSummariesLoaded()}');
    expect(memoryView).toContain('when={bag.triplesLoaded()}');
    expect(memoryView).toContain('<LoadingDots label="loading facts" />');
    expect(memoryView).toContain('<LoadingDots label="loading pointers" />');
    expect(memoryView).not.toContain('loading pointers…');
    expect(state).toContain('setGraphSummariesLoaded(false);');
    expect(state).toContain('setTriplesLoaded(false);');
    expect(state).toContain('finally {\n      setGraphSummariesLoaded(true);\n    }');
    expect(state).toContain('finally {\n      setTriplesLoaded(true);\n    }');
  });

  test("only shows the facts limit note for loaded truncated results", () => {
    expect(memoryView).toContain('bag.triplesLoaded() && bag.triplesTruncated()');
    expect(memoryView).toContain('Showing {bag.triples().length} of {bag.triplesTotal() ?? "many"} facts');
    expect(memoryView).not.toContain('Showing the first {bag.triplesLimit() ?? bag.triples().length} facts');
  });
});
