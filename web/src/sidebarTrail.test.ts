import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { TimelineItem, TodoDiffChange } from "./api";
import {
  buildTrailItems,
  formatTrailDuration,
  todoChangeTextForTrail,
  trailSourceItems,
  trailSourceKey,
} from "./sidebar/trail";

const baseCss = readFileSync(new URL("./styles/base.css", import.meta.url), "utf8");

type StepItem = Extract<TimelineItem, { type: "step" }>;
type TrailTimelineItem = Extract<TimelineItem, { type: "trail" }>;
type TodoDiffTimelineItem = Extract<TimelineItem, { type: "todo-diff" }>;

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

function todoChange(
  kind: TodoDiffChange["kind"],
  status: "todo" | "doing" | "done" | "blocked" | "dropped" = "todo",
): TodoDiffChange {
  const before = { id: "1", text: "old", status };
  const after = { id: "1", text: "new", status };
  if (kind === "added") return { kind, after };
  if (kind === "removed") return { kind, before };
  return { kind, before, after, fields: ["text"] };
}

function todoDiff(changes: TodoDiffChange[]): TodoDiffTimelineItem {
  return {
    type: "todo-diff",
    id: "todo-step",
    chatId: "chat1",
    changes,
    at: 5,
  };
}

describe("sidebar trail helpers", () => {
  test("live timeline rows replace stale trail rows with matching source keys", () => {
    const stale = todoDiff([todoChange("added", "todo")]);
    const fresh = todoDiff([todoChange("updated", "done")]);
    const items = trailSourceItems({ trail: [stale], timeline: [fresh] });
    expect(items).toEqual([fresh]);
    expect(trailSourceKey(fresh)).toBe("todo-diff:todo-step");
  });

  test("builds title, summary, TODO, and subagent trail items in time order", () => {
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
        todoDiff([todoChange("updated", "done")]),
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
    expect(items[0]?.tone).toBe("todo");
    expect(items[0]?.todoStatus).toBe("done");
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

  test("formats TODO action markers and durations", () => {
    expect(todoChangeTextForTrail(todoChange("added", "todo"))).toBe("+");
    expect(todoChangeTextForTrail(todoChange("updated", "blocked"))).toBe("!");
    expect(todoChangeTextForTrail(todoChange("updated", "done"))).toBe("-");
    expect(todoChangeTextForTrail(todoChange("removed", "dropped"))).toBe("X");
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
