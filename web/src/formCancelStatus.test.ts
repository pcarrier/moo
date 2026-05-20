import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const stateSource = readFileSync(new URL("./state.ts", import.meta.url), "utf8");

describe("form cancellation chat status", () => {
  test("refreshes chat summaries after submit and cancel", () => {
    const submitStart = stateSource.indexOf("submitForm: async");
    expect(submitStart).toBeGreaterThanOrEqual(0);
    const cancelStart = stateSource.indexOf("cancelForm: async", submitStart);
    expect(cancelStart).toBeGreaterThan(submitStart);
    const end = stateSource.indexOf("toasts,", cancelStart);
    expect(end).toBeGreaterThan(cancelStart);
    const block = stateSource.slice(submitStart, end);

    expect(block).toContain("await Promise.all([refreshTimeline(), refreshChats()]);");
    expect(block.match(/refreshChats\(\)/g)?.length).toBe(2);
  });
});
