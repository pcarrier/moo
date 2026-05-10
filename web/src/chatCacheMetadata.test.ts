import { describe, expect, test } from "bun:test";

import type { ChatSummary, DescribeOverviewValue } from "./api";
import { mergeCachedOverviewWithSummary } from "./state/chatCache";

function overview(value: Partial<DescribeOverviewValue> = {}): DescribeOverviewValue {
  return {
    chatId: "chat-a",
    title: "Stale title",
    path: "/old",
    worktreePath: "/old/worktree",
    createdAt: 1,
    lastAt: 2,
    hidden: false,
    parentChatId: null,
    head: "old-head",
    totalFacts: 1,
    totalTurns: 1,
    totalSteps: 1,
    totalCodeCalls: 7,
    tokens: { used: 0, budget: 0, threshold: 0, fraction: 0 },
    ...value,
  };
}

function summary(value: Partial<ChatSummary> = {}): ChatSummary {
  return {
    chatId: "chat-a",
    createdAt: 10,
    lastAt: 20,
    head: "new-head",
    title: "Current title",
    path: "/current",
    worktreePath: "/current/worktree",
    status: "agent:Done",
    totalFacts: 3,
    totalTurns: 4,
    totalSteps: 5,
    usage: null,
    costUsd: 0,
    costEstimated: true,
    unpricedModels: [],
    selectedModel: null,
    archived: false,
    archivedAt: null,
    hidden: true,
    parentChatId: "parent-chat",
    ...value,
  };
}

describe("chat cache metadata", () => {
  test("uses chat-list metadata when restoring cached overviews", () => {
    const restored = mergeCachedOverviewWithSummary(overview(), summary());

    expect(restored.title).toBe("Current title");
    expect(restored.path).toBe("/current");
    expect(restored.worktreePath).toBe("/current/worktree");
    expect(restored.createdAt).toBe(10);
    expect(restored.lastAt).toBe(20);
    expect(restored.hidden).toBe(true);
    expect(restored.parentChatId).toBe("parent-chat");
    expect(restored.head).toBe("new-head");
    expect(restored.totalFacts).toBe(3);
    expect(restored.totalTurns).toBe(4);
    expect(restored.totalSteps).toBe(5);
    expect(restored.totalCodeCalls).toBe(7);
  });

  test("preserves cached overview when no summary is available", () => {
    const cached = overview();
    expect(mergeCachedOverviewWithSummary(cached, undefined)).toBe(cached);
  });
});
