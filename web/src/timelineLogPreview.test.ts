import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";

const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
const stateTypes = readFileSync(new URL("./state/types.ts", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
const css = readStylesheetForTest();

describe("timeline moo.log previews", () => {
  test("renders log rows collapsed and opens the right sidebar", () => {
    expect(timeline).toContain("function Log(props: { item: LogItem; bag: Bag; timelineKey: string })");
    expect(timeline).toContain("props.bag.openLogPreviewInSidebar(props.item)");
    expect(timeline).toContain('class="step log collapsed-log"');
    expect(timeline).toContain('class="log-open"');
    expect(timeline).not.toContain('class="body log-message"');
    expect(css).toContain(".log-open {");
    expect(css).toContain("text-overflow: ellipsis;");
  });

  test("opens logs as auto-highlighted JSON preview tabs", () => {
    expect(state).toContain("function openLogPreviewInSidebar(item: LogItem)");
    expect(state).toContain('label: "moo.log"');
    expect(state).toContain("autoHighlight: true");
    expect(state).toContain('layout: "bare"');
    expect(state).toContain("openLogPreviewInSidebar,");
    expect(stateTypes).toContain("autoHighlight?: boolean;");
    expect(stateTypes).toContain('layout?: "boxed" | "bare";');
    expect(stateTypes).toContain("displayTarget?: string;");
    expect(sidebar).toContain("props.json.autoHighlight || props.json.error");
    expect(sidebar).toContain("highlightAuto(props.json.raw || props.json.target)");
    expect(sidebar).toContain('props.json.label || "json pointer"');
    expect(sidebar).toContain("json-preview-bare");
    expect(css).toContain(".json-preview-bare .store-preview-body");
    expect(css).toContain(".json-preview-bare .trace-json-block");
    expect(css).toContain("border: 0;");
    expect(css).toContain("border-radius: 0;");
    expect(css).toContain("padding: 0;");
    expect(css).toContain("background: transparent;");
  });
});
