import { describe, expect, test } from "bun:test";
import {
  initialStepDriverState,
  planStepDriverEffects,
  reduceStepDriverState,
  stepNextInputEvents,
} from "../src/driver/step";
import { llmRetryDecision, retryAfterDelayMs } from "../src/core/retry";

describe("step driver", () => {
  test("plans start from an initial user step", () => {
    let state = initialStepDriverState({ state: { chatId: "c1", mode: "step", message: "hi" } });
    for (const event of stepNextInputEvents({}, state)) state = reduceStepDriverState(state, event);
    expect(planStepDriverEffects(state)).toEqual([
      { type: "Start", mode: "step", input: { chatId: "c1", message: "hi", attachments: undefined } },
    ]);
  });

  test("returns an LLM effect after prepare", () => {
    const prepared = {
      kind: "llm",
      purpose: "step",
      draftId: "d1",
      messages: [{ role: "user", content: "hi" }],
      estimatedPromptTokens: 12,
      tokenBudget: 100,
      tokenThreshold: 50,
      requestModel: "m",
      requestEffort: "low",
      url: "https://llm.test",
      headers: { authorization: "Bearer x" },
      body: { model: "m" },
      streamEvents: { draftEvent: { kind: "draft" } },
      countThoughtDuration: true,
    };
    const state = reduceStepDriverState({ chatId: "c1", provider: { name: "openai" }, phase: "prepare" } as any, { type: "Prepared", prepared });
    expect(planStepDriverEffects(state)).toEqual([{ type: "Return", value: expect.objectContaining({ kind: "llm", url: "https://llm.test" }) }]);
  });


  test("propagates retry attempt and delay to the next LLM effect", () => {
    const prepared = {
      kind: "llm",
      purpose: "step",
      draftId: "d2",
      messages: [{ role: "user", content: "retry" }],
      estimatedPromptTokens: 12,
      tokenBudget: 100,
      tokenThreshold: 50,
      requestModel: "m",
      requestEffort: "low",
      url: "https://llm.test",
      headers: { authorization: "Bearer x" },
      body: { model: "m" },
      streamEvents: { draftEvent: { kind: "draft" } },
      countThoughtDuration: true,
    };
    const retried = reduceStepDriverState({ chatId: "c1", provider: { name: "openai" }, phase: "handleLlm" } as any, {
      type: "LlmHandled",
      handled: { kind: "iterate", messages: prepared.messages, retryAttempt: 2, retryReason: "http-529", retryDelayMs: 30_000 },
    });
    expect(planStepDriverEffects(retried)).toEqual([{
      type: "Prepare",
      input: {
        chatId: "c1",
        provider: { name: "openai" },
        messages: prepared.messages,
        attempt: 2,
        retryReason: "http-529",
      },
    }]);

    const state = reduceStepDriverState(retried as any, { type: "Prepared", prepared });
    expect(planStepDriverEffects(state)).toEqual([{
      type: "Return",
      value: expect.objectContaining({ kind: "llm", attempt: 2, delayMs: 30_000 }),
    }]);
  });

  test("threads a tool result back into messages", () => {
    const state = reduceStepDriverState({ chatId: "c1", messages: [] } as any, {
      type: "ToolResultReceived",
      toolResult: { toolCallId: "call-1", content: "42" },
    });
    expect(state.phase).toBe("continueToolCalls");
    expect(state.messages).toEqual([{ role: "tool", tool_call_id: "call-1", content: "42" }]);
  });
});

describe("llm retry policy", () => {
  const policy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterMs: 0 };

  test("retries transient failures before exhaustion", () => {
    expect(llmRetryDecision({ ok: false, status: 429 }, 1, policy)).toEqual({ retry: true, reason: "http-429", delayMs: 10 });
    expect(llmRetryDecision({ ok: false, status: 0 }, 2, policy)).toEqual({ retry: true, reason: "transport", delayMs: 20 });
  });


  test("honors retry-after headers and caps malformed long delays", () => {
    const policy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, maxRetryAfterMs: 30_000, jitterMs: 0 };
    expect(retryAfterDelayMs({ headers: { "Retry-After": "20" } }, policy)).toBe(20_000);
    expect(llmRetryDecision({ ok: false, status: 529, headers: { "retry-after": "20" } }, 1, policy)).toEqual({ retry: true, reason: "http-529", delayMs: 20_000 });
    expect(retryAfterDelayMs({ headers: { "retry-after": "120" } }, policy)).toBe(30_000);
  });

  test("retries provider errors surfaced inside streaming responses", () => {
    const policy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterMs: 0 };
    expect(llmRetryDecision({
      ok: false,
      status: 200,
      errorBody: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
    }, 1, policy)).toEqual({ retry: true, reason: "overloaded", delayMs: 10 });
    expect(llmRetryDecision({ ok: false, status: 200, errorBody: "stream: connection reset" }, 1, policy)).toEqual({ retry: true, reason: "stream", delayMs: 10 });
  });

  test("does not retry permanent or exhausted failures", () => {
    expect(llmRetryDecision({ ok: false, status: 400 }, 1, policy).retry).toBe(false);
    expect(llmRetryDecision({ ok: false, status: 503 }, 3, policy)).toEqual({ retry: false, reason: "attempts-exhausted", delayMs: 0 });
  });
});
