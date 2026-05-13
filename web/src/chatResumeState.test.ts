import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { hasRestartableConversationState } from "./state/resume";
import type { TimelineItem } from "./api";

const stateSource = readFileSync(new URL("./state.ts", import.meta.url), "utf8");

function step(kind: string, status: string, extra: Partial<Extract<TimelineItem, { type: "step" }>> = {}): TimelineItem {
  return {
    type: "step",
    step: (extra.step ?? `step-${kind}-${status}`) as Extract<TimelineItem, { type: "step" }>["step"],
    kind,
    status,
    at: extra.at ?? 1,
    text: extra.text ?? "",
    ...extra,
  } as TimelineItem;
}

describe("restartable chat state", () => {
  test("offers resume for terminal error rows even when chat summary is done", () => {
    expect(hasRestartableConversationState([
      step("agent:UserInput", "agent:Done"),
      step("agent:Error", "agent:Failed", {
        error: {
          kind: "authentication",
          detail: { source: "authentication", provider: "openai" },
        },
      }),
    ])).toBe(true);
  });

  test("keeps normal unanswered user inputs restartable", () => {
    expect(hasRestartableConversationState([
      step("agent:Reply", "agent:Done"),
      step("agent:UserInput", "agent:Done"),
    ])).toBe(true);
  });

  test("does not offer resume after a completed assistant reply", () => {
    expect(hasRestartableConversationState([
      step("agent:UserInput", "agent:Done"),
      step("agent:Reply", "agent:Done"),
    ])).toBe(false);
  });

  test("canResumeAgent consults timeline state after terminal summaries", () => {
    expect(stateSource).toContain('return hasRestartableConversationState(timeline());');
    expect(stateSource).toContain('status === "agent:Running" || status === "agent:Queued" || status === "ui:Pending"');
  });
});
