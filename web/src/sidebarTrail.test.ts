import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { TimelineItem, TaskDiffChange } from "./api";
import {
  buildTrailItems,
  formatTrailDuration,
  taskChangeTextForTrail,
  trailSourceItems,
  trailSourceKey,
} from "./sidebar/trail";

const baseCss = readFileSync(new URL("./styles/base.css", import.meta.url), "utf8");

type StepItem = Extract<TimelineItem, { type: "step" }>;
type TrailTimelineItem = Extract<TimelineItem, { type: "trail" }>;
type TaskDiffTimelineItem = Extract<TimelineItem, { type: "task-diff" }>;

function step(
  partial: Partial<StepItem> & Pick<StepItem, "step" | "kind" | "text">,
): StepItem {
  return {
    type: "step",
    status: "agent:Done",
    at: 1,
    ...partial,
  };
}

function trail(
  partial: Partial<TrailTimelineItem> & Pick<TrailTimelineItem, "id" | "kind">,
): TrailTimelineItem {
  return {
    type: "trail",
    at: 1,
    ...partial,
  };
}

function taskChange(
  kind: TaskDiffChange["kind"],
  status: "todo" | "doing" | "done" | "blocked" | "dropped" = "todo",
): TaskDiffChange {
  const before = { id: "1", text: "old", status };
  const after = { id: "1", text: "new", status };
  if (kind === "added") return { kind, after };
  if (kind === "removed") return { kind, before };
  return { kind, before, after, fields: ["text"] };
}

function taskDiff(changes: TaskDiffChange[]): TaskDiffTimelineItem {
  return {
    type: "task-diff",
    id: "task-step",
    chatId: "chat1",
    changes,
    at: 5,
  };
}

describe("sidebar trail helpers", () => {
  test("live timeline rows replace stale trail rows with matching source keys", () => {
    const stale = taskDiff([taskChange("added", "todo")]);
    const fresh = taskDiff([taskChange("updated", "done")]);
    const items = trailSourceItems({ trail: [stale], timeline: [fresh] });
    expect(items).toEqual([fresh]);
    expect(trailSourceKey(fresh)).toBe("task-diff:task-step");
  });

  test("builds title, summary, task, and subagent trail items in time order", () => {
    const items = buildTrailItems({
      trail: [
        trail({
          id: "summary",
          kind: "agent:Summary",
          title: "Daily",
          body: "Finished **work**",
          at: 30,
        }),
        trail({
          id: "title",
          kind: "agent:TitleUpdate",
          title: "New title",
          at: 10,
        }),
      ],
      timeline: [
        taskDiff([taskChange("updated", "done")]),
        step({
          step: "sub1",
          kind: "agent:Subagent",
          text: "run child",
          at: 20,
          subagent: {
            label: "Child",
            task: "Investigate",
            childChatId: "chat-child",
            result: { status: "agent:Done", durationNs: 2_500_000_000 },
          },
        }),
      ],
    });
    expect(items.map((item) => item.title)).toEqual([
      "- 1. new",
      "New title",
      "Child",
      "Daily",
    ]);
    expect(items[0]?.tone).toBe("task");
    expect(items[0]?.taskStatus).toBe("done");
    expect(items[2]?.targetChatId).toBe("chat-child");
    expect(items[2]?.status).toBe("done");
    expect(items[2]?.detail).toContain("2.5s");
    expect(items[3]?.detailMarkdown).toBe(true);
  });

  test("normalizes subagent status case", () => {
    const items = buildTrailItems({
      trail: [],
      timeline: [
        step({
          step: "sub1",
          kind: "agent:Subagent",
          text: "run child",
          subagent: { result: { status: "agent:Cancelled" } },
        }),
      ],
    });
    expect(items[0]?.status).toBe("cancelled");
  });

  test("formats task action markers and durations", () => {
    expect(taskChangeTextForTrail(taskChange("added", "todo"))).toBe("+");
    expect(taskChangeTextForTrail(taskChange("updated", "blocked"))).toBe("!");
    expect(taskChangeTextForTrail(taskChange("updated", "done"))).toBe("-");
    expect(taskChangeTextForTrail(taskChange("removed", "dropped"))).toBe("X");
    expect(formatTrailDuration(250)).toBe("0.3s");
    expect(formatTrailDuration(12_000)).toBe("12s");
    expect(formatTrailDuration(75_000)).toBe("1m 15s");
  });
});

test("subagent trail status badges keep visible block size", () => {
  expect(baseCss).toContain(".agent-trail-title-line.has-status,");
  expect(baseCss).toContain(".agent-trail-title-line.has-status-loading");
  expect(baseCss).not.toContain(":has(.agent-trail-status)");
  expect(baseCss).toContain(".agent-trail-status {");
  expect(baseCss).toContain("display: inline-block;");
  expect(baseCss).toContain("min-block-size: 1.1em;");
});
