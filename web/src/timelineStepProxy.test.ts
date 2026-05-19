import { describe, expect, test } from "bun:test";

import type { StepItem } from "./api";
import { draftStepItem, syncStepItem } from "./timeline/stepProxy";

describe("timeline draft step proxies", () => {
  test("represents active compaction drafts as compaction rows", () => {
    expect(
      draftStepItem({
        kind: "compaction",
        draftId: "draft-compact",
        content: "summary",
        at: 123,
      }),
    ).toMatchObject({
      type: "step",
      step: "draft:draft-compact",
      kind: "agent:Compaction",
      status: "agent:Running",
      text: "compaction\nsummary",
      draftId: "draft-compact",
      at: 123,
    });
  });

  test("syncs finalized compaction token metadata into reused draft proxies", () => {
    const proxy = draftStepItem({
      kind: "reply",
      draftId: "draft-compact",
      content: "",
      reasoningContent: "stale thought",
      reasoningStreaming: true,
      at: 1,
    });
    const finalized: StepItem = {
      type: "step",
      step: "step-real",
      kind: "agent:Compaction",
      status: "agent:Done",
      at: 2,
      text: "manual compaction\nsummary",
      draftId: "draft-compact",
      compaction: {
        promptTokens: 164_478,
        postPromptTokens: 21_512,
        tokenBudget: 400_000,
        tokenThreshold: 200_000,
      },
    };

    syncStepItem(proxy, finalized);

    expect(proxy).toEqual(finalized);
    expect(proxy.compaction?.promptTokens).toBe(164_478);
    expect(proxy.compaction?.postPromptTokens).toBe(21_512);
    expect(proxy.reasoningContent).toBeUndefined();
    expect(proxy.reasoningStreaming).toBeUndefined();
  });
});
