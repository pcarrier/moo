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
      kind: "trace-init-error",
      message: "connect failed",
      backend: "clickhouse",
      endpoint: "http://localhost:8123",
      database: "moo",
      at: 123,
    });
    expect(trace?.kind).toBe("trace-init-error");
    if (trace?.kind !== "trace-init-error") throw new Error("trace event did not parse");
    expect(trace.message).toBe("connect failed");
    expect(trace.backend).toBe("clickhouse");
    expect(trace.endpoint).toBe("http://localhost:8123");

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
    expect(stateSource).not.toContain("events.on((ev: any) =>");
    expect(stateSource).not.toContain('ev.kind === "runts-step-finished" || ev.kind === "runts-step-finished"');
  });
});
