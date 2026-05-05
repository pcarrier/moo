import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");

describe("timeline thinking status", () => {
  test("hides standalone Thinking row during running tool calls", () => {
    expect(timeline).toContain("const hasRunningToolRow = createMemo(() => visibleTimeline().some(isRunningToolTimelineItem));");
    expect(timeline).toContain("const showStandaloneThinking = () =>");
    expect(timeline).toContain("!hasRunningToolRow()");
    expect(timeline).toContain("when={showStandaloneThinking()}");
  });

  test("labels streaming replies as Thinking", () => {
    expect(timeline).toContain('props.item.kind === "agent:Reply" && !isTerminalStepStatus(props.item.status) ? "Thinking…"');
    expect(timeline).not.toContain('"streaming…"');
  });
});
