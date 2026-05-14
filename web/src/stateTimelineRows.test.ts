import { describe, expect, test } from "bun:test";

import type { TimelineItem } from "./api";
import {
  compactTimelineRows,
  mergeTimelineRows,
  mergeTimelineUpdateRows,
  newestTimelineWatermark,
  sortTimelineItems,
  timelineItemKey,
} from "./state/timelineRows";

type StepItem = Extract<TimelineItem, { type: "step" }>;
type FileDiff = Extract<TimelineItem, { type: "file-diff" }>;
type TodoDiff = Extract<TimelineItem, { type: "todo-diff" }>;

function step(partial: Partial<StepItem> & Pick<StepItem, "step" | "kind" | "text">): StepItem {
  return {
    type: "step",
    status: "agent:Done",
    at: 1,
    ...partial,
  };
}

function fileDiff(id: string, at: number): FileDiff {
  return {
    type: "file-diff",
    id,
    chatId: "chat1",
    path: id + ".txt",
    diff: "+" + id,
    at,
  };
}

function todoDiff(id: string, changes: TodoDiff["changes"]): TodoDiff {
  return {
    type: "todo-diff",
    id,
    chatId: "chat1",
    changes,
    at: 1,
  };
}

describe("timeline row helpers", () => {
  test("keys replies by draft id and other rows by stable ids", () => {
    expect(timelineItemKey(step({ step: "s1", kind: "agent:Reply", text: "hi", draftId: "draft1" }))).toBe("step:draft:draft1");
    expect(timelineItemKey(step({ step: "s1", kind: "agent:Reply", text: "hi" }))).toBe("step:s1");
    expect(timelineItemKey(fileDiff("diff1", 1))).toBe("file-diff:diff1");
  });

  test("keeps updatedAt in timeline watermarks", () => {
    expect(newestTimelineWatermark([
      step({ step: "s1", kind: "agent:RunTS", text: "run", at: 10, updatedAt: 25 }),
      fileDiff("later", 20),
    ])).toBe(25);
  });

  test("compacts hidden TODO diffs and remembers visible row keys", () => {
    const remembered = new Map<string, number>();
    const rows = compactTimelineRows([
      fileDiff("old", 1),
      todoDiff("empty", []),
      fileDiff("new", 3),
    ], {
      limit: 1,
      liveSlack: 0,
      rememberedKeys: remembered,
      maxRememberedKeys: 10,
      nowMs: () => 99,
    });
    expect(rows.map((item) => item.type === "file-diff" ? item.id : item.type)).toEqual(["new"]);
    expect(remembered.has("file-diff:new")).toBe(true);
    expect(remembered.has("todo-diff:empty")).toBe(false);
  });

  test("merges full pages while preserving unconfirmed optimistic user input", () => {
    const optimistic = step({ step: "opt-local", kind: "agent:UserInput", text: "hello", at: 30 });
    const confirmedOther = step({ step: "real-other", kind: "agent:UserInput", text: "other", at: 20 });
    const merged = mergeTimelineRows([confirmedOther], [optimistic], {
      limit: 10,
      liveSlack: 0,
    });
    expect(merged.map((item) => item.type === "step" ? item.step : item.type)).toEqual(["real-other", "opt-local"]);
  });

  test("incremental updates dedupe by key and reuse unchanged server rows", () => {
    const existing = step({ step: "s1", kind: "agent:Reply", text: "done", at: 10, resultHash: "h1" });
    const sameFromServer = { ...existing };
    const update = step({ step: "s2", kind: "agent:Reply", text: "next", at: 20 });
    const merged = mergeTimelineUpdateRows([sameFromServer, update], [existing], {
      limit: 10,
      liveSlack: 0,
    });
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(existing);
    expect(merged[1]).toEqual(update);
  });

  test("sortTimelineItems returns a sorted copy", () => {
    const original = [fileDiff("b", 2), fileDiff("a", 1)];
    const sorted = sortTimelineItems(original);
    expect(sorted.map((item) => item.type === "file-diff" ? item.id : item.type)).toEqual(["a", "b"]);
    expect(original.map((item) => item.type === "file-diff" ? item.id : item.type)).toEqual(["b", "a"]);
  });
});
