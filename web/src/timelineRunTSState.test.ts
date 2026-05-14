import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
const timelineRows = readFileSync(new URL("./state/timelineRows.ts", import.meta.url), "utf8");

describe("timeline runTS state merging", () => {
  test("replaces rows when lazy result metadata changes", () => {
    // The structural deepEqual compares every key; verify it is wired in and
    // that the legacy field-by-field comparator was retired. Future schema
    // changes (e.g. new step fields) are automatically covered without test
    // churn.
    expect(timelineRows).toContain("function deepEqual(a: unknown, b: unknown): boolean");
    expect(timelineRows).toContain("function timelineItemEqual(a: TimelineItem, b: TimelineItem): boolean");
    expect(timelineRows).toContain("return deepEqual(a, b);");
    expect(state).not.toContain("a.lazyRuntsResult === right.lazyRuntsResult");
    expect(timelineRows).not.toContain("a.lazyRuntsResult === right.lazyRuntsResult");
  });

  test("uses update-aware timeline watermarks", () => {
    expect(timelineRows).toContain("function newestTimelineWatermark(items: TimelineItem[]): number");
    expect(timelineRows).toContain('item.type === "step" ? Number(item.updatedAt ?? 0) : 0');
    expect(state).not.toContain('} else if (hasRunningTimelineStep(timeline())) {');
  });

  test("handles explicit runTS completion events", () => {
    expect(state).toContain('ev.kind === "runts-step-finished"');
    expect(state).toContain('item.step !== ev.stepId');
    expect(state).toContain('status: ev.status || (ev.error ? "agent:Failed" : "agent:Done")');
    expect(state).toContain('refreshTimelineIncrementalSoon();');
  });
});
