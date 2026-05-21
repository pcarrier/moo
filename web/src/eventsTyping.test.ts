import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseWsFrame } from "./events";

const eventsSource = readFileSync(new URL("./events.ts", import.meta.url), "utf8");
const stateSource = readFileSync(new URL("./state.ts", import.meta.url), "utf8");

describe("typed WS events", () => {
  test("parses lifecycle and server event frames used by state", () => {
    expect(parseWsFrame({ kind: "online" })).toEqual({ kind: "online" });
    expect(parseWsFrame({ kind: "offline" })).toEqual({ kind: "offline" });
    expect(parseWsFrame({ kind: "reconnect" })).toEqual({ kind: "reconnect" });

    const trace = parseWsFrame({
      kind: "otel-export-error",
      message: "export failed",
      endpoint: "http://localhost:4318/v1/traces",
      at: 123,
    });
    expect(trace?.kind).toBe("otel-export-error");
    if (trace?.kind !== "otel-export-error") throw new Error("otel event did not parse");
    expect(trace.message).toBe("export failed");
    expect(trace.endpoint).toBe("http://localhost:4318/v1/traces");

    const runts = parseWsFrame({
      kind: "runts-step-finished",
      chatId: "chat1",
      stepId: "step1",
      status: "agent:Done",
      resultHash: "hash1",
      durationNs: 42,
    });
    expect(runts?.kind).toBe("runts-step-finished");
    if (runts?.kind !== "runts-step-finished") throw new Error("runTS event did not parse");
    expect(runts.chatId).toBe("chat1");
    expect(runts.stepId).toBe("step1");
    expect(runts.resultHash).toBe("hash1");
    expect(runts.durationNs).toBe(42);

    const toolDraft = parseWsFrame({
      kind: "tool-call-draft",
      chatId: "chat1",
      stepId: "step2",
      toolCallId: "call_1",
      toolName: "runTS",
      model: "gpt-5",
      effort: "high",
      label: "Inspect files",
      description: "Read target files",
      code: "return 1",
      at: 44,
    });
    expect(toolDraft?.kind).toBe("tool-call-draft");
    if (toolDraft?.kind !== "tool-call-draft") throw new Error("tool-call draft did not parse");
    expect(toolDraft.stepId).toBe("step2");
    expect(toolDraft.model).toBe("gpt-5");
    expect(toolDraft.effort).toBe("high");
    expect(toolDraft.label).toBe("Inspect files");
    expect(toolDraft.description).toBe("Read target files");
    expect(toolDraft.code).toBe("return 1");

    const replyDraft = parseWsFrame({
      kind: "reasoning-draft",
      chatId: "chat1",
      draftId: "draft1",
      content: "",
      reasoningContent: "thinking",
      model: "gpt-5.5",
      effort: "xhigh",
      at: 45,
    });
    expect(replyDraft?.kind).toBe("reasoning-draft");
    if (replyDraft?.kind !== "reasoning-draft") throw new Error("reasoning draft did not parse");
    expect(replyDraft.model).toBe("gpt-5.5");
    expect(replyDraft.effort).toBe("xhigh");

    const tokens = parseWsFrame({
      kind: "tokens",
      chatId: "chat1",
      used: 200,
      budget: 1_000,
      threshold: 500,
      availableTokens: 300,
      compactionsInARow: 2,
    });
    expect(tokens?.kind).toBe("tokens");
    if (tokens?.kind !== "tokens") throw new Error("tokens event did not parse");
    expect(tokens.availableTokens).toBe(300);
    expect(tokens.compactionsInARow).toBe(2);
  });

  test("guards structured TODO and memory diff arrays", () => {
    const todo = {
      id: "1",
      text: "Fix events",
      status: "done",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
    };
    const todoDiff = parseWsFrame({
      kind: "todo-diff",
      chatId: "chat1",
      changes: [{ kind: "added", after: todo }],
      todos: [todo],
      at: 10,
    });
    expect(todoDiff?.kind).toBe("todo-diff");
    if (todoDiff?.kind !== "todo-diff") throw new Error("TODO diff did not parse");
    expect(todoDiff.changes?.[0]?.kind).toBe("added");
    expect(todoDiff.todos?.[0]?.text).toBe("Fix events");

    const rejectedTodo = parseWsFrame({
      kind: "todo-diff",
      chatId: "chat1",
      changes: [{ kind: "updated", before: todo, after: todo, fields: ["text", 1] }],
      at: 11,
    });
    expect(rejectedTodo?.kind).toBe("todo-diff");
    if (rejectedTodo?.kind !== "todo-diff") throw new Error("TODO diff with bad changes still returns an event");
    expect(rejectedTodo.changes).toBeUndefined();

    const memoryDiff = parseWsFrame({
      kind: "memory-diff",
      chatId: "chat1",
      store: "memory",
      graph: "memory:facts",
      action: "assert",
      path: "memory.ttl",
      diff: "+ fact",
      changes: [{ subject: "s", predicate: "p", object: "o" }],
      at: 12,
    });
    expect(memoryDiff?.kind).toBe("memory-diff");
    if (memoryDiff?.kind !== "memory-diff") throw new Error("memory diff did not parse");
    expect(memoryDiff.changes?.[0]?.predicate).toBe("p");
  });

  test("keeps RPC result frames separate from broadcast events", () => {
    expect(parseWsFrame({ kind: "run-result", id: "r1", result: { ok: true } })).toEqual({
      kind: "run-result",
      id: "r1",
      result: { ok: true },
    });
    expect(parseWsFrame({ id: "legacy", result: 7 })).toEqual({
      kind: "run-result",
      id: "legacy",
      result: 7,
    });
    expect(parseWsFrame({ kind: "file-diff", chatId: "chat1" })).toBeNull();
    expect(parseWsFrame({ kind: "not-a-real-event", id: "e1", result: 1 })).toBeNull();
  });

  test("source avoids broad event typing escapes", () => {
    expect(eventsSource).not.toContain("return raw as Event");
    expect(eventsSource).not.toContain("this.emit({ kind: \"online\" } as any)");
    expect(eventsSource).not.toContain("this.emit({ kind: \"offline\" } as any)");
    expect(eventsSource).not.toContain("this.emit({ kind: \"reconnect\" } as any)");
    expect(stateSource).toContain("events.on((ev: WsEvent) =>");
    expect(stateSource).toContain('ev.kind === "tool-call-draft"');
    expect(stateSource).not.toContain("events.on((ev: any) =>");
    expect(stateSource).not.toContain('ev.kind === "runts-step-finished" || ev.kind === "runts-step-finished"');
  });
});
