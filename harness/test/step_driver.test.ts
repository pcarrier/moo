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
      { type: "Start", mode: "step", input: { chatId: "c1", mode: "step", message: "hi", attachments: undefined } },
    ]);
  });

  test("plans resume without adding a user step", () => {
    let state = initialStepDriverState({ state: { chatId: "c1", mode: "resume" } });
    for (const event of stepNextInputEvents({}, state)) state = reduceStepDriverState(state, event);
    expect(planStepDriverEffects(state)).toEqual([
      { type: "Start", mode: "resume", input: { chatId: "c1", mode: "resume" } },
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
      requestAuthMode: "apiKey",
      url: "https://llm.test",
      headers: { authorization: "x" },
      body: { model: "m" },
      streamEvents: { draftEvent: { kind: "draft" } },
      countThoughtDuration: true,
    };
    const state = reduceStepDriverState({ chatId: "c1", provider: { name: "anthropic", authMode: "apiKey" }, phase: "prepare" } as any, { type: "Prepared", prepared });
    expect(planStepDriverEffects(state)).toEqual([{ type: "Return", value: expect.objectContaining({ kind: "llm", url: "https://llm.test" }) }]);
    const handled = reduceStepDriverState(state as any, { type: "LlmResultReceived", llmResult: { ok: false, status: 429 }, llmDurationNs: 100 });
    expect(handled.llmHandling).toEqual(expect.objectContaining({ requestProvider: "anthropic", requestAuthMode: "apiKey" }));
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
      headers: { authorization: "x" },
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
        forceCompact: false,
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

  test("honors rate-limit reset windows when no explicit retry-after", () => {
    const policy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, maxRetryAfterMs: 30 * 60_000, jitterMs: 0 };
    // OpenAI surfaces Go-style durations on reset headers.
    expect(retryAfterDelayMs({ headers: { "x-ratelimit-reset-tokens": "6m0s" } }, policy)).toBe(360_000);
    expect(retryAfterDelayMs({ headers: { "x-ratelimit-reset": "1m30s" } }, policy)).toBe(90_000);
    // Anthropic surfaces an absolute reset timestamp.
    const at = new Date(Date.now() + 90_000).toISOString();
    const delay = retryAfterDelayMs({ headers: { "anthropic-ratelimit-requests-reset": at } }, policy);
    expect(delay).not.toBeNull();
    expect(Math.abs((delay as number) - 90_000)).toBeLessThan(2_000);
    // Unix epoch reset (seconds) is treated as absolute, not a 60M-second delay.
    const epoch = Math.floor(Date.now() / 1000) + 45;
    const epochDelay = retryAfterDelayMs({ headers: { "x-ratelimit-reset-requests": String(epoch) } }, policy);
    expect(epochDelay).not.toBeNull();
    expect(Math.abs((epochDelay as number) - 45_000)).toBeLessThan(2_000);
    // Explicit retry-after still wins over reset headers.
    expect(retryAfterDelayMs({ headers: { "retry-after": "5", "x-ratelimit-reset": "10m0s" } }, policy)).toBe(5_000);
  });

  test("mid-stream HTTP 200 decode failures retry and wait for the reset window", () => {
    const policy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, maxRetryAfterMs: 30 * 60_000, jitterMs: 0 };
    const decision = llmRetryDecision(
      {
        ok: false,
        status: 200,
        errorBody: "stream: error decoding response body",
        headers: { "anthropic-ratelimit-requests-reset": new Date(Date.now() + 120_000).toISOString() },
      },
      1,
      policy,
    );
    expect(decision.retry).toBe(true);
    expect(decision.reason).toBe("stream");
    expect(decision.delayMs).toBeGreaterThan(60_000);
  });

  test("retries provider errors surfaced inside streaming responses", () => {
    const policy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterMs: 0 };
    expect(llmRetryDecision({
      ok: false,
      status: 200,
      errorBody: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
    }, 1, policy)).toEqual({ retry: true, reason: "overloaded", delayMs: 10 });
    expect(llmRetryDecision({ ok: false, status: 200, errorBody: "stream: connection reset" }, 1, policy)).toEqual({ retry: true, reason: "stream", delayMs: 10 });
    expect(llmRetryDecision({ ok: false, status: 200, errorBody: "websocket connection closed before terminal response event" }, 1, policy)).toEqual({ retry: true, reason: "stream", delayMs: 10 });
    expect(llmRetryDecision({ ok: false, status: 200, errorBody: "websocket stream: protocol reset" }, 1, policy)).toEqual({ retry: true, reason: "stream", delayMs: 10 });
  });

  test("does not retry permanent or exhausted failures", () => {
    expect(llmRetryDecision({ ok: false, status: 400 }, 1, policy).retry).toBe(false);
    expect(llmRetryDecision({ ok: false, status: 503 }, 3, policy)).toEqual({ retry: false, reason: "attempts-exhausted", delayMs: 0 });
  });
});


describe("trace helpers", () => {
  test("preserves trace payloads", async () => {
    const { traceJsonValue } = await import("../src/moo");
    const value: any = { text: "abc" };
    value.self = value;
    expect(traceJsonValue(value)).toEqual({ text: "abc", self: "[Circular]" });
  });

  test("keeps synchronous moo helpers synchronous under trace proxy", async () => {
    const { moo } = await import("../src/moo");
    expect(typeof moo.validate.pointerName("p")).toBe("boolean");
    expect(String(moo.term.string({ s: "literal:value" }))).toBe('"literal:value"');
  });
});
