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
  effortLevelsForProvider,
  compactionRequestTokenLimit,
  estimateImageAttachmentTokens,
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

  test("autocompaction replaces stale compaction pressure with fresh estimates", () => {
    expect(
      tokenPressureForCompactionCheck(2_000, 3_000, {
        used: 210_000,
        source: "compaction",
      }),
    ).toEqual({ used: 3_000, source: "context" });
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

  test("estimates image attachments from dimensions without counting base64 bytes", () => {
    const messagesForImageSize = (base64Size: number, width = 1024, height = 768) => [
      {
        role: "user",
        content: [
          { type: "text", text: "Please inspect this image." },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64," + "A".repeat(base64Size) },
            width,
            height,
          },
        ],
      },
    ];

    const small = estimateTokens(messagesForImageSize(100));
    const large = estimateTokens(messagesForImageSize(500_000));

    expect(large).toBe(small);
    expect(estimateImageAttachmentTokens({ type: "image_url", width: 1024, height: 768 })).toBe(1_049);
    expect(estimateImageAttachmentTokens({ type: "image_url", width: 256, height: 256 })).toBe(255);
    expect(estimateImageAttachmentTokens({ type: "image_url", image_url: { detail: "low" }, width: 4096, height: 4096 })).toBe(85);
    expect(estimateTokens(messagesForImageSize(100, 256, 256))).toBeLessThan(small);
    expect(large).toBeLessThan(1_200);
  });

  test("continuation message can include current task reminders", () => {
    const message = compactionContinuationSystemMessage("Summary text.", "- doing 1: finish check");

    expect(message).toContain("Current task reminders:\n- doing 1: finish check");
  });

  test("strips legacy dynamic context instead of sending synthetic user turns", () => {
    const messages = stripDynamicContextMessages([
      { role: "system", content: "stable system" },
      { role: DYNAMIC_CONTEXT_MESSAGE_ROLE, content: "legacy tail tasks" },
      { role: "user", content: "hello" },
    ]);

    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(messages.map((message) => message.content).join("\n")).not.toContain("legacy tail tasks");
  });



  test("Anthropic Opus 4.8 enables summarized adaptive thinking with xhigh effort", () => {
    expect(effortLevelsForProvider({ name: "anthropic", model: "claude-opus-4-8" })).toEqual(["low", "medium", "high", "xhigh", "max"]);

    const defaultRequest = buildStreamingLLMRequest({
      name: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "key",
      model: "claude-opus-4-8",
      effort: null,
    } as any, [{ role: "user", content: "Think deeply" }], null);

    expect(defaultRequest.requestEffort).toBe("high");
    expect(defaultRequest.body).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });

    const xhighRequest = buildStreamingLLMRequest({
      name: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "key",
      model: "claude-opus-4-8",
      effort: "xhigh",
    } as any, [{ role: "user", content: "Think deeply" }], null);

    expect(xhighRequest.requestEffort).toBe("xhigh");
    expect(xhighRequest.body).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh" },
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

  test("Anthropic keeps post-compaction task reminders in the system prompt", () => {
    const messages = [
      { role: "system", content: "stable system" },
      { role: "system", content: compactionContinuationSystemMessage("Summary text.", "- task 1: fix tests") },
      { role: "user", content: "hello" },
    ];

    const anthropic = toAnthropicMessages(messages);

    expect(anthropic.system).toContain("stable system");
    expect(anthropic.system).toContain("Current task reminders:\n- task 1: fix tests");
    expect(JSON.stringify(anthropic.messages)).not.toContain("task 1: fix tests");
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

  test("OpenAI Responses keeps post-compaction task reminders in instructions", () => {
    const provider = { name: "openai" as const, apiKey: "key", baseUrl: "https://llm.test/v1", model: "gpt-5", effort: null, keyEnvHint: "KEY" };
    const messages = [
      { role: "system", content: "stable system" },
      { role: "system", content: compactionContinuationSystemMessage("Summary text.", "- task 1: fix tests") },
      { role: "user", content: "hello" },
    ];

    const request = buildStreamingLLMRequest(provider, messages, null);

    expect(request.responsesApi).toBe(true);
    expect(request.transport).toBe("websocket");
    expect(request.url).toBe("wss://llm.test/v1/responses");
    expect(request.headers["OpenAI-Beta"]).toBe("responses_websockets=2026-02-06");
    expect((request.body as any).type).toBe("response.create");
    const body = request.body as ResponsesRequestBody;
    expect(body.instructions).toContain("stable system");
    expect(body.instructions).toContain("Current task reminders:\n- task 1: fix tests");
    expect(JSON.stringify(body.input)).not.toContain("task 1: fix tests");
  });

  test("image dimensions stay out of provider request bodies", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64,abc" },
            width: 1024,
            height: 768,
          },
        ],
      },
    ];
    const provider = { name: "openai" as const, apiKey: "key", baseUrl: "https://llm.test/v1", model: "gpt-4.1", effort: null, keyEnvHint: "KEY" };

    const chatRequest = buildStreamingLLMRequest({ ...provider, name: "qwen" as const, model: "qwen-vl" }, messages, null);
    const responsesRequest = buildStreamingLLMRequest(provider, messages, null);

    expect(JSON.stringify((chatRequest.body as any).messages)).not.toContain("width");
    expect(JSON.stringify((chatRequest.body as any).messages)).not.toContain("height");
    expect(JSON.stringify((responsesRequest.body as any).input)).not.toContain("width");
    expect(JSON.stringify((responsesRequest.body as any).input)).not.toContain("height");
  });

  test("OpenAI Responses requests reasoning summaries for gpt-5.5", () => {
    const provider = {
      name: "openai" as const,
      apiKey: "key",
      baseUrl: "https://llm.test/v1",
      model: "gpt-5.5",
      effort: "xhigh",
      keyEnvHint: "KEY",
    };

    const request = buildStreamingLLMRequest(
      provider,
      [{ role: "user", content: "show your work" }],
      null,
    );

    expect(request.responsesApi).toBe(true);
    expect(request.transport).toBe("websocket");
    expect((request.body as any).reasoning).toEqual({
      effort: "xhigh",
      summary: "auto",
    });
  });

  test("OpenAI OAuth uses Codex Responses websocket endpoint", () => {
    const provider = {
      name: "openai" as const,
      apiKey: "oauth-token",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      model: "gpt-5.3-codex",
      effort: "low",
      keyEnvHint: "OpenAI OAuth",
      authMode: "oauth" as const,
      oauthAccountId: "acct_123",
    };

    const request = buildStreamingLLMRequest(
      provider,
      [{ role: "user", content: "summarize" }],
      null,
    );

    expect(request.transport).toBe("websocket");
    expect(request.responsesApi).toBe(true);
    expect(request.url).toBe("wss://chatgpt.com/backend-api/codex/responses");
    expect(request.headers.Authorization).toBe("Bearer oauth-token");
    expect(request.headers["ChatGPT-Account-ID"]).toBe("acct_123");
    expect(request.headers["OpenAI-Beta"]).toBe("responses_websockets=2026-02-06");
    // session-id / thread-id / x-client-request-id are stamped by the Rust
    // transport at WS connect time (stable per cached socket), not by the
    // harness, so they shouldn't appear here.
    expect(request.headers["session-id"]).toBeUndefined();
    expect(request.headers["thread-id"]).toBeUndefined();
    expect(request.headers["x-client-request-id"]).toBeUndefined();
    const body = request.body as ResponsesRequestBody & {
      tools?: unknown;
      tool_choice?: unknown;
      parallel_tool_calls?: unknown;
      include?: unknown;
      client_metadata?: { "x-codex-installation-id"?: unknown };
      type?: unknown;
    };
    expect(body.type).toBe("response.create");
    expect(body.input).toEqual([{ role: "user", content: "summarize" }]);
    expect(body.tools).toEqual([]);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(false);
    // Provider sets effort: "low" → reasoning enabled → include carries the
    // encrypted-reasoning replay key (mirrors codex's `build_responses_request`).
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.client_metadata?.["x-codex-installation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("uses low/no reasoning for compaction summary requests", () => {
    const base = { apiKey: "key", baseUrl: "https://llm.test", keyEnvHint: "KEY" };

    expect(compactionProviderForRequest({ ...base, name: "openai", model: "gpt-5.5", effort: "xhigh" }).effort).toBe("none");
    expect(compactionProviderForRequest({ ...base, name: "openai", model: "gpt-5", effort: "high" }).effort).toBe("minimal");
    expect(compactionProviderForRequest({ ...base, name: "anthropic", model: "claude-sonnet-4", effort: "xhigh" }).effort).toBe("low");
    expect(compactionProviderForRequest({ ...base, name: "anthropic", model: "claude-opus-4-8", effort: "xhigh" }).effort).toBe("low");
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
