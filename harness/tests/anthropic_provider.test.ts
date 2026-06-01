import { describe, expect, test } from "bun:test";

import { buildStreamingLLMRequest, modelContextBudget, resolveProvider } from "../src/agent";
import { modelOptionsFor } from "../src/commands/models";
import { estimateCostUsd, loadPricing, priceFor } from "../src/commands/describe";
import { modelMetadataFor, openAIServiceTierForModel } from "../src/llm_models";

const refs = new Map<string, string>();
const objects = new Map<string, { kind: string; content: string }>();
let objectId = 0;

const env = new Map<string, string>();
(globalThis as any).__op_env_get = (name: string) => env.get(name) ?? null;
(globalThis as any).__op_ref_get = (name: string) => refs.get(name) ?? null;
(globalThis as any).__op_ref_set = (name: string, target: string) => { refs.set(name, target); return true; };
(globalThis as any).__op_object_put = (kind: string, content: string) => {
  const hash = "sha256:" + String(++objectId).padStart(64, "0");
  objects.set(hash, { kind, content });
  return hash;
};
(globalThis as any).__op_object_get = (hash: string) => objects.get(hash) ?? null;

const anthropicProvider = (model: string, effort: string | null = "high") => ({
  name: "anthropic" as const,
  apiKey: "test-key",
  baseUrl: "https://api.anthropic.com/v1",
  model,
  effort,
  keyEnvHint: "ANTHROPIC_API_KEY",
});

describe("Anthropic provider support", () => {
  test("uses documented Claude 4.x context and output caps", () => {
    const cases: Array<[string, number, number]> = [
      ["claude-opus-4-8", 1_000_000, 128_000],
      ["claude-opus-4-8-20260201", 1_000_000, 128_000],
      ["claude-opus-4-7", 1_000_000, 128_000],
      ["claude-opus-4-7-20260101", 1_000_000, 128_000],
      ["claude-opus-4-6", 1_000_000, 128_000],
      ["claude-sonnet-4-6", 1_000_000, 64_000],
      ["claude-opus-4-5", 200_000, 64_000],
      ["claude-sonnet-4-5", 200_000, 64_000],
      ["claude-haiku-4-5", 200_000, 64_000],
      ["claude-opus-4-1", 200_000, 32_000],
      ["claude-sonnet-4", 200_000, 64_000],
      ["claude-opus-4", 200_000, 32_000],
    ];

    for (const [model, contextWindow, maxOutputTokens] of cases) {
      expect(modelContextBudget({ name: "anthropic", model })).toBe(contextWindow);
      expect(modelMetadataFor("anthropic", model)?.maxOutputTokens).toBe(maxOutputTokens);
    }
  });

  test("uses Claude Opus 4.8 defaults and pricing", async () => {
    const metadata = modelMetadataFor("anthropic", "claude-opus-4-8-20260201");
    expect(metadata?.id).toBe("claude-opus-4-8");
    expect(metadata?.pricing).toEqual({ input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 25 });

    const options = await modelOptionsFor("anthropic", "claude-opus-4-8");
    expect(options.map((option) => option.id)).toContain("anthropic:claude-opus-4-8");
  });

  test("uses model output caps for Anthropic max_tokens", () => {
    const opus48 = buildStreamingLLMRequest(
      anthropicProvider("claude-opus-4-8-20260201", "high"),
      [{ role: "user", content: "hello" }],
      null,
    );
    expect(opus48.body).toMatchObject({
      max_tokens: 128_000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });

    const opus47 = buildStreamingLLMRequest(
      anthropicProvider("claude-opus-4-7", "xhigh"),
      [{ role: "user", content: "hello" }],
      null,
    );
    expect(opus47.body).toMatchObject({
      max_tokens: 128_000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh" },
    });

    const sonnet46 = buildStreamingLLMRequest(
      anthropicProvider("claude-sonnet-4-6", "max"),
      [{ role: "user", content: "hello" }],
      null,
    );
    expect(sonnet46.body).toMatchObject({
      max_tokens: 64_000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" },
    });
  });

  test("tracks Claude Opus 4.8 pricing", async () => {
    const pricing = await loadPricing();
    expect(priceFor("claude-opus-4-8", pricing)).toEqual({ input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 25 });
    expect(priceFor("claude-opus-4-8-20260201", pricing)).toEqual({ input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 25 });
    expect(estimateCostUsd({ models: { "claude-opus-4-8": { input: 1_000_000, cachedInput: 1_000_000, cacheWriteInput: 1_000_000, output: 1_000_000 } } }, pricing).costUsd).toBe(36.75);
  });
});


describe("OpenAI fast mode", () => {
  test("shows GPT fast variants as separate model options", async () => {
    const options = await modelOptionsFor("openai", "gpt-5");
    const ids = options.map((option) => option.id);

    expect(ids).toContain("openai:gpt-5");
    expect(ids).toContain("openai:gpt-5#fast");
    expect(options.find((option) => option.id === "openai:gpt-5#fast")?.label).toBe("openai / gpt-5 (fast)");
    expect(options.find((option) => option.id === "openai:o3#fast")).toBeUndefined();
  });

  test("sends priority service tier while preserving the base model slug", () => {
    const request = buildStreamingLLMRequest({
      name: "openai",
      apiKey: "key",
      baseUrl: "https://llm.test/v1",
      model: "gpt-5.5#fast",
      effort: "xhigh",
      keyEnvHint: "KEY",
    }, [{ role: "user", content: "hello" }], null);

    expect(openAIServiceTierForModel("gpt-5.5#fast")).toBe("priority");
    expect(request.requestModel).toBe("gpt-5.5");
    expect((request.body as any).model).toBe("gpt-5.5");
    expect((request.body as any).service_tier).toBe("priority");
    expect((request.body as any).reasoning).toEqual({ effort: "xhigh", summary: "auto" });
  });

  test("resolves fast model ids from OpenAI env defaults", async () => {
    env.set("OPENAI_MODEL", "gpt-5#fast");
    try {
      const provider = await resolveProvider(null, null, "openai");
      expect(provider.model).toBe("gpt-5");
      expect(provider.serviceTier).toBe("priority");
    } finally {
      env.delete("OPENAI_MODEL");
    }
  });
});
