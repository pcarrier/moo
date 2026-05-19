import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildStreamingLLMRequest } from "../src/agent";
import { reduceStepDriverState } from "../src/driver/step";
import { llmStreamAccumulateEffect, llmStreamFinalizeEffect } from "../src/llm_stream";

const g = globalThis as any;
g.__op_trace_current ??= () => null;
g.__op_trace_insert ??= () => null;
g.__op_trace_finish ??= () => "true";
g.__op_trace_leave ??= () => null;
g.__op_trace_enter ??= () => null;

describe("step driver compaction", () => {
  test("automatic compaction success resumes the agent loop", () => {
    const next = reduceStepDriverState(
      { chatId: "chat-1", mode: "compact", phase: "startLoop" },
      { type: "Started", started: { kind: "loop", provider: { name: "openai" }, mode: "resume" } },
    );

    expect(next.phase).toBe("prepare");
    expect(next.mode).toBe("resume");
    expect(next.provider).toEqual({ name: "openai" });
  });

  test("manual compaction success stops after the compaction row", () => {
    const source = readFileSync(new URL("../src/commands/step.ts", import.meta.url), "utf8");

    expect(source).toContain('if (result === "compacted")');
    expect(source).toContain('return { ok: true, value: { kind: "done" } };');
    expect(source).not.toContain('return { ok: true, value: { kind: "loop", provider, mode: "resume" } };');
    expect(source).not.toContain("compacted older turns into a summary");
  });

  test("manual compaction empty result does not persist a status reply", () => {
    const source = readFileSync(
      new URL("../src/commands/step.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("nothing to compact yet");
    expect(source).toContain('if (result === "failed")');
    expect(source).toContain('"compaction failed; see the error above"');
  });
});

describe("step driver tool result ids", () => {
  test("falls back to the pending tool call id for detached runTS results", () => {
    const next = reduceStepDriverState(
      {
        chatId: "chat-1",
        messages: [{ role: "assistant", content: null, tool_calls: [{ id: "call_1" }] }],
        pendingToolCalls: [
          { id: "call_1", type: "function", function: { name: "runTS", arguments: "{}" } },
        ],
      },
      {
        type: "ToolResultReceived",
        toolResult: { content: "detached: runTS continues in background" },
      },
    );

    expect(next.messages?.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      content: "detached: runTS continues in background",
    });
    expect(next.pendingToolCalls).toEqual([
      { id: "call_1", type: "function", function: { name: "runTS", arguments: "{}" } },
    ]);
  });

  test("synthesizes missing streamed tool call ids before Responses conversion", async () => {
    const accumulated = await llmStreamAccumulateEffect({
      state: {},
      events: [
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, type: "function", function: { name: "runTS", arguments: "{}" } }] } }] }),
      ],
    }).runPromise();
    const finalized = await llmStreamFinalizeEffect({ state: accumulated.state, status: 200 }).runPromise();

    expect(finalized.toolCalls[0].id).toMatch(/^call_moo_\d+$/);

    const request = buildStreamingLLMRequest(
      { name: "openai", model: "gpt-5", baseUrl: "https://api.openai.com/v1" } as any,
      [
        { role: "assistant", content: null, tool_calls: finalized.toolCalls },
        { role: "tool", tool_call_id: finalized.toolCalls[0].id, content: "ok" },
      ],
      null,
    );

    expect((request.body as any).input).toEqual([
      {
        type: "function_call",
        call_id: finalized.toolCalls[0].id,
        name: "runTS",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: finalized.toolCalls[0].id, output: "ok" },
    ]);
  });
});

describe("step driver startup cleanup", () => {
  test("cleans orphaned running step rows even when chat summaries are normalized", () => {
    const source = readFileSync(new URL("../src/commands/step.ts", import.meta.url), "utf8");

    expect(source).toContain("async function hasChatInFlightSteps(chatId: string): Promise<boolean>");
    expect(source).toContain("[\"agent:Running\", \"agent:Queued\"].map((status) =>");
    expect(source).toContain("if (await hasChatInFlightSteps(c.chatId))");
    expect(source).toContain("cleared stale in-flight status during startup");
  });
});
