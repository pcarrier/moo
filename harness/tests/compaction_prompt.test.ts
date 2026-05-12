import { describe, expect, test } from "bun:test";
import { DEFAULT_COMPACTION_THRESHOLD_PERCENT } from "../src/commands/llm_auth";
import {
  buildCompactionSummaryPromptMessages,
  COMPACTION_CONTINUATION_INSTRUCTION,
  compactionContinuationSystemMessage,
} from "../src/prompt";
import { tokenPressureFromEstimates } from "../src/commands/step";
import {
  DYNAMIC_CONTEXT_MESSAGE_ROLE,
  buildStreamingLLMRequest,
  stripDynamicContextMessages,
  compactionProviderForRequest,
  compactionRequestTokenLimit,
  estimateTokens,
  fitCompactionSummaryMessages,
  parseSseDataEvents,
  accumulateSummaryStreamEvent,
  toAnthropicMessages,
} from "../src/agent";

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

    expect(messages.map((message: any) => message.role)).toEqual(["system", "user"]);
    expect(messages.map((message: any) => message.content).join("\n")).not.toContain("legacy tail todos");
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

  test("OpenAI Responses keeps post-compaction TODO reminders in instructions", () => {
    const provider = { name: "openai" as const, apiKey: "key", baseUrl: "https://llm.test/v1", model: "gpt-5", effort: null, keyEnvHint: "KEY" };
    const messages = [
      { role: "system", content: "stable system" },
      { role: "system", content: compactionContinuationSystemMessage("Summary text.", "- todo 1: fix tests") },
      { role: "user", content: "hello" },
    ];

    const request = buildStreamingLLMRequest(provider, messages, null);

    expect(request.responsesApi).toBe(true);
    expect((request.body as any).instructions).toContain("stable system");
    expect((request.body as any).instructions).toContain("Current TODO reminders:\n- todo 1: fix tests");
    expect(JSON.stringify((request.body as any).input)).not.toContain("todo 1: fix tests");
  });

  test("uses low/no reasoning for compaction summary requests", () => {
    const base = { apiKey: "key", baseUrl: "https://llm.test", keyEnvHint: "KEY" };

    expect(compactionProviderForRequest({ ...base, name: "openai", model: "gpt-5.5", effort: "xhigh" }).effort).toBe("none");
    expect(compactionProviderForRequest({ ...base, name: "openai", model: "gpt-5", effort: "high" }).effort).toBe("minimal");
    expect(compactionProviderForRequest({ ...base, name: "anthropic", model: "claude-sonnet-4", effort: "xhigh" }).effort).toBe("low");
  });

  test("accumulates streamed compaction summaries", () => {
    const chunks = { buffer: "" };
    const state = { content: "", model: null as string | null, usage: null as any, error: null as any };
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
    const state = { content: "", model: null as string | null, usage: null as any, error: null as any };
    for (const event of parseSseDataEvents(chunks, 'data: {"type":"response.output_text.delta","delta":"compact "}\n\ndata: {"type":"response.output_text.delta","delta":"summary"}\n\n')) {
      accumulateSummaryStreamEvent(state, JSON.parse(event), true);
    }
    expect(state.content).toBe("compact summary");
  });
});
