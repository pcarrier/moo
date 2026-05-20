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

  test("keys compactions by draft id so patched and synthetic rows collapse", () => {
    const persisted = step({
      step: "step:real",
      kind: "agent:Compaction",
      text: "automatic compaction\nsummary",
      draftId: "draft-compact",
      at: 1,
    });
    const synthetic = step({
      step: "compaction:sha256:patched",
      kind: "agent:Compaction",
      text: "automatic compaction\nsummary",
      draftId: "draft-compact",
      at: 2,
    });

    expect(timelineItemKey(persisted)).toBe("step:draft:draft-compact");
    expect(timelineItemKey(synthetic)).toBe("step:draft:draft-compact");
    expect(
      mergeTimelineUpdateRows([synthetic], [persisted], {
        limit: 10,
        liveSlack: 0,
      }).filter(
        (item) => item.type === "step" && item.kind === "agent:Compaction",
      ),
    ).toEqual([synthetic]);
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

  test("merges full pages while preserving a live queued RunTS draft", () => {
    const serverReply = step({ step: "s1", kind: "agent:Reply", text: "done", at: 10 });
    const streamedRunTS = step({
      step: "step:draft-runts",
      kind: "agent:RunTS",
      status: "agent:Queued",
      text: "",
      at: 20,
      runts: { label: "Read files", description: "Inspect target", code: "return 1" },
    });

    const merged = mergeTimelineRows([serverReply], [streamedRunTS], {
      limit: 10,
      liveSlack: 0,
    });

    expect(merged.map((item) => item.type === "step" ? item.step : item.type)).toEqual([
      "s1",
      "step:draft-runts",
    ]);
  });

  test("server RunTS rows replace matching live queued RunTS drafts", () => {
    const streamedRunTS = step({
      step: "step:runts",
      kind: "agent:RunTS",
      status: "agent:Queued",
      text: "",
      at: 20,
      runts: { label: "Draft label", description: "Draft desc", code: "return 1" },
    });
    const serverRunTS = step({
      step: "step:runts",
      kind: "agent:RunTS",
      status: "agent:Running",
      text: "",
      at: 20,
      runts: { label: "Server label", description: "Server desc", code: "return 2" },
    });

    const merged = mergeTimelineRows([serverRunTS], [streamedRunTS], {
      limit: 10,
      liveSlack: 0,
    });

    expect(merged).toEqual([serverRunTS]);
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
