import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");

describe("timeline runJS state merging", () => {
  test("replaces rows when lazy result metadata changes", () => {
    expect(state).toContain("a.lazyRunjsResult === right.lazyRunjsResult");
    expect(state).toContain("a.resultHash === right.resultHash");
  });

  test("handles explicit runJS completion events", () => {
    expect(state).toContain('ev.kind === "runjs-step-finished"');
    expect(state).toContain('item.step !== ev.stepId');
    expect(state).toContain('status: ev.status || (ev.error ? "agent:Failed" : "agent:Done")');
    expect(state).toContain('refreshTimelineIncrementalSoon();');
  });
});
