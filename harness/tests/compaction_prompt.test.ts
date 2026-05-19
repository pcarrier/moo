import { describe, expect, test } from "bun:test";
import { planStepDriverEffects, reduceStepDriverState, type StepDriverState } from "../src/driver/step";
import { DEFAULT_COMPACTION_THRESHOLD_PERCENT } from "../src/commands/llm_auth";
import {
  buildCompactionSummaryPromptMessages,
  COMPACTION_CONTINUATION_INSTRUCTION,
  COMPACTION_CONTINUATION_USER_PROMPT,
  compactionContinuationSystemMessage,
} from "../src/prompt";
import {
  availableTokensBeforeCompaction,
  isContextLengthExceededError,
  tokenPressureForCompactionCheck,
  tokenPressureFromEstimates,
} from "../src/commands/step";
import {
  DYNAMIC_CONTEXT_MESSAGE_ROLE,
  buildStreamingLLMRequest,
  stripDynamicContextMessages,
  compactionProviderForRequest,
  compactionRequestTokenLimit,
  estimateTokens,
  fitCompactionSummaryMessages,
  MAX_CONSECUTIVE_COMPACTIONS,
  parseSseDataEvents,
  accumulateSummaryStreamEvent,
  toAnthropicMessages,
  TOOLS,
  type RawUsage,
} from "../src/agent";

type SummaryStreamState = { content: string; model: string | null; usage: RawUsage | null; error: unknown };

type ResponsesRequestBody = { instructions?: string; input?: unknown };

function responsesRequestBody(body: unknown): ResponsesRequestBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("expected object request body");
  return body;
}

describe("compaction prompts", () => {
  test("defaults automatic compaction near the context limit", () => {
    expect(DEFAULT_COMPACTION_THRESHOLD_PERCENT).toBe(50);
  });

  test("continuation message tells the resumed model to act", () => {
    const message = compactionContinuationSystemMessage("User asked to fix tests; patch is pending.");

    expect(message).toContain(COMPACTION_CONTINUATION_INSTRUCTION);
    expect(message).toContain("First reply: act");
    expect(message).toContain("Execute `Next action:`");
    expect(message).toContain("Do not wait");
    expect(message).toContain("If done, report result");
    expect(message).toContain("Summary of earlier conversation:\nUser asked to fix tests; patch is pending.");
  });

  test("continuation user turn forces action instead of readiness", () => {
    expect(COMPACTION_CONTINUATION_USER_PROMPT).toContain("Act on the `Next action:`");
    expect(COMPACTION_CONTINUATION_USER_PROMPT).toContain("Use tools");
    expect(COMPACTION_CONTINUATION_USER_PROMPT).toContain("Do not acknowledge or wait");
    expect(COMPACTION_CONTINUATION_USER_PROMPT).not.toContain("Ready");
  });

  test("summary prompt asks for next action", () => {
    const messages = buildCompactionSummaryPromptMessages([{ role: "system", content: "base" }, { role: "user", content: "fix it" }]);
    expect(messages.at(-1)?.content).toContain("End: `Next action:`");
    expect(messages.at(-1)?.content).toContain("no waiting");
  });

  test("fits oversized summary requests below the target limit", () => {
    const messages = [
      { role: "system", content: "Summarize the transcript." },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i} ` + "x".repeat(10_000),
      })),
      { role: "user", content: "Summarize. End with next action." },
    ];

    const fitted = fitCompactionSummaryMessages(messages, 1_000);

    expect(estimateTokens(fitted)).toBeLessThanOrEqual(1_000);
    expect(fitted[0]).toEqual(messages[0]);
    expect(fitted.at(-1)).toEqual(messages.at(-1));
    expect(fitted.some((m) => String(m.content).includes("oversized transcript entries were truncated"))).toBe(true);
  });

  test("uses request prompt tokens for visible token pressure", () => {
    expect(tokenPressureFromEstimates(40_000, 70_000)).toEqual({
      used: 70_000,
      source: "context",
    });
    expect(tokenPressureFromEstimates(70_000, 40_000)).toEqual({
      used: 70_000,
      source: "compaction",
    });
  });

  test("detects streamed OpenAI context length errors", () => {
    expect(isContextLengthExceededError({
      error: {
        code: "context_length_exceeded",
        message: "Your input exceeds the context window of this model. Please adjust your input and try again.",
        type: "invalid_request_error",
      },
      type: "error",
    })).toBe(true);
  });

  test("autocompaction uses provider-reported pressure from the prior turn", () => {
    expect(
      tokenPressureForCompactionCheck(40_000, 45_000, {
        used: 210_000,
        source: "context",
      }),
    ).toEqual({ used: 210_000, source: "context" });
  });

  test("autocompaction keeps larger fresh estimates over prior pressure", () => {
    expect(
      tokenPressureForCompactionCheck(220_000, 45_000, {
        used: 210_000,
        source: "context",
      }),
    ).toEqual({ used: 220_000, source: "compaction" });
  });

  test("reports available tokens before compaction", () => {
    expect(availableTokensBeforeCompaction(190_000, 200_000)).toBe(10_000);
    expect(availableTokensBeforeCompaction(210_000, 200_000)).toBe(0);
  });

  test("caps repeated automatic compactions at two", () => {
    expect(MAX_CONSECUTIVE_COMPACTIONS).toBe(2);
  });

  test("carries force-compaction retry state after context overflow", () => {
    const state: StepDriverState = {
      chatId: "c1",
      provider: { name: "openai", model: "gpt-5.5" },
      phase: "handleLlm",
    };
    const handled = reduceStepDriverState(
      state,
      { type: "LlmHandled", handled: { kind: "iterate", messages: null, retryAttempt: 2, retryReason: "context-length-compaction", forceCompact: true } },
    );
    expect(handled.forceCompact).toBe(true);

    const [effect] = planStepDriverEffects(handled);
    expect(effect?.type).toBe("Prepare");
    if (!effect || effect.type !== "Prepare") throw new Error("expected Prepare effect");
    expect(effect.input.forceCompact).toBe(true);
  });

  test("uses a conservative compaction request budget", () => {
    expect(compactionRequestTokenLimit(1_000_000, 500_000)).toBe(160_000);
    expect(compactionRequestTokenLimit(400_000, 200_000)).toBe(80_000);
  });

  test("omits image payloads from compaction requests", () => {
    const messages = [
      { role: "system", content: "Summarize the transcript." },
      {
        role: "user",
        content: [
          { type: "text", text: "Please inspect this image." },
          { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(10_000) } },
        ],
      },
      { role: "user", content: "Summarize. End with next action." },
    ];

    const fitted = fitCompactionSummaryMessages(messages, 10_000);

    expect(JSON.stringify(fitted)).not.toContain("data:image");
    expect(fitted[1].content).toContain("Please inspect this image.");
    expect(fitted[1].content).toContain("image attachment omitted from compaction request");
    expect(Array.isArray(fitted[1].content)).toBe(false);
  });

  test("continuation message can include current TODO reminders", () => {
    const message = compactionContinuationSystemMessage("Summary text.", "- doing 1: finish check");

    expect(message).toContain("Current TODO reminders:\n- doing 1: finish check");
  });

  test("strips legacy dynamic context instead of sending synthetic user turns", () => {
    const messages = stripDynamicContextMessages([
      { role: "system", content: "stable system" },
      { role: DYNAMIC_CONTEXT_MESSAGE_ROLE, content: "legacy tail todos" },
      { role: "user", content: "hello" },
    ]);

    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(messages.map((message) => message.content).join("\n")).not.toContain("legacy tail todos");
  });



  test("Anthropic Opus 4.7 enables summarized adaptive thinking by default", () => {
    const request = buildStreamingLLMRequest({
      name: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "key",
      model: "claude-opus-4-7",
      effort: null,
    } as any, [{ role: "user", content: "Think deeply" }], null);

    expect(request.requestEffort).toBe("high");
    expect(request.body).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
  });

  test("Anthropic requests summarized thinking and round-trips signed thinking blocks", () => {
    const request = buildStreamingLLMRequest({
      name: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "key",
      model: "claude-sonnet-4-6",
      effort: "high",
    } as any, [
      { role: "user", content: "Use a tool" },
      {
        role: "assistant",
        content: "",
        anthropic_thinking_blocks: [{ type: "thinking", thinking: "summary", signature: "sig" }],
        tool_calls: [{ id: "toolu_1", function: { name: "runTS", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "ok" },
    ], TOOLS);

    expect(request.body).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
    expect((request.body as any).messages[1].content[0]).toEqual({ type: "thinking", thinking: "summary", signature: "sig" });
  });

  test("Anthropic keeps post-compaction TODO reminders in the system prompt", () => {
    const messages = [
      { role: "system", content: "stable system" },
      { role: "system", content: compactionContinuationSystemMessage("Summary text.", "- todo 1: fix tests") },
      { role: "user", content: "hello" },
    ];

    const anthropic = toAnthropicMessages(messages);

    expect(anthropic.system).toContain("stable system");
    expect(anthropic.system).toContain("Current TODO reminders:\n- todo 1: fix tests");
    expect(JSON.stringify(anthropic.messages)).not.toContain("todo 1: fix tests");
  });

  test("Anthropic uses explicit post-compaction user turn instead of generic Continue", () => {
    const messages = [
      { role: "system", content: "stable system" },
      { role: "system", content: compactionContinuationSystemMessage("Next action: run tests.") },
      { role: "user", content: COMPACTION_CONTINUATION_USER_PROMPT },
    ];

    const anthropic = toAnthropicMessages(messages);

    expect(anthropic.messages.at(-1)).toEqual({ role: "user", content: COMPACTION_CONTINUATION_USER_PROMPT });
    expect(JSON.stringify(anthropic.messages)).not.toContain("Continue.");
  });

  test("OpenAI Responses keeps post-compaction TODO reminders in instructions", () => {
    const provider = { name: "openai" as const, apiKey: "key", baseUrl: "https://llm.test/v1", model: "gpt-5", effort: null, keyEnvHint: "KEY" };
    const messages = [
      { role: "system", content: "stable system" },
      { role: "system", content: compactionContinuationSystemMessage("Summary text.", "- todo 1: fix tests") },
      { role: "user", content: "hello" },
    ];

    const request = buildStreamingLLMRequest(provider, messages, null);

    expect(request.responsesApi).toBe(true);
    const body = responsesRequestBody(request.body);
    expect(body.instructions).toContain("stable system");
    expect(body.instructions).toContain("Current TODO reminders:\n- todo 1: fix tests");
    expect(JSON.stringify(body.input)).not.toContain("todo 1: fix tests");
  });

  test("uses low/no reasoning for compaction summary requests", () => {
    const base = { apiKey: "key", baseUrl: "https://llm.test", keyEnvHint: "KEY" };

    expect(compactionProviderForRequest({ ...base, name: "openai", model: "gpt-5.5", effort: "xhigh" }).effort).toBe("none");
    expect(compactionProviderForRequest({ ...base, name: "openai", model: "gpt-5", effort: "high" }).effort).toBe("minimal");
    expect(compactionProviderForRequest({ ...base, name: "anthropic", model: "claude-sonnet-4", effort: "xhigh" }).effort).toBe("low");
  });

  test("accumulates streamed compaction summaries", () => {
    const chunks = { buffer: "" };
    const state: SummaryStreamState = { content: "", model: null, usage: null, error: null };
    const events = [
      ...parseSseDataEvents(chunks, 'data: {"model":"gpt-5.5","choices":[{"delta":{"content":"hello "}}]}\n\n'),
      ...parseSseDataEvents(chunks, 'data: {"choices":[{"delta":{"content":"world"}}],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n'),
      ...parseSseDataEvents(chunks, 'data: [DONE]\n\n'),
    ];
    for (const event of events) {
      if (event !== "[DONE]") accumulateSummaryStreamEvent(state, JSON.parse(event), false);
    }
    expect(state.content).toBe("hello world");
    expect(state.model).toBe("gpt-5.5");
    expect(state.usage?.prompt_tokens).toBe(12);
  });

  test("accumulates responses API streamed compaction summaries", () => {
    const chunks = { buffer: "" };
    const state: SummaryStreamState = { content: "", model: null, usage: null, error: null };
    for (const event of parseSseDataEvents(chunks, 'data: {"type":"response.output_text.delta","delta":"compact "}\n\ndata: {"type":"response.output_text.delta","delta":"summary"}\n\n')) {
      accumulateSummaryStreamEvent(state, JSON.parse(event), true);
    }
    expect(state.content).toBe("compact summary");
  });
});
