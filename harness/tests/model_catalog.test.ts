import { describe, expect, test } from "bun:test";
import { buildStreamingLLMRequest, effortLevelsForProvider, type LLMProvider } from "../src/agent";
import { estimateCostUsd, priceFor, validPrice } from "../src/commands/describe";
import { planStepDriverEffects, reduceStepDriverState } from "../src/driver/step";
import {
  defaultModelPricing,
  modelMetadataFor,
  modelSupportsOpenAIFastMode,
  modelUsagePricingKey,
  PROVIDER_METADATA,
  type ProviderName,
} from "../src/llm_models";

const pricing = defaultModelPricing();
const weekday = Date.parse("2026-09-16T02:00:00Z");
const key = (model: string, tokens: number, extra = {}) =>
  modelUsagePricingKey(model, tokens, { at: weekday, ...extra });
const price = (model: string, tokens: number, extra = {}) => priceFor(key(model, tokens, extra), pricing);

function request(name: ProviderName, model: string, effort: string | null = null) {
  return buildStreamingLLMRequest({ name, model, effort, apiKey: "test", baseUrl: PROVIDER_METADATA[name].defaultBaseUrl } as LLMProvider,
    [{ role: "user", content: "Test" }], null);
}

describe("model catalog pricing", () => {
  test("catalog aliases are unambiguous and picker models have prices or availability notes", () => {
    for (const provider of Object.values(PROVIDER_METADATA)) {
      expect(modelMetadataFor(provider.id, provider.fallbackModel)).not.toBeNull();
      const ids = new Set<string>();
      for (const model of provider.models) {
        for (const id of [model.id, ...(model.aliases ?? [])]) {
          expect(ids.has(id)).toBe(false);
          ids.add(id);
          expect(modelMetadataFor(provider.id, id)?.id).toBe(model.id);
        }
        if (model.defaultOption && model.capabilities?.toolCalls) {
          expect(model.contextWindow).toBeGreaterThan(0);
          if (model.pricing) expect(validPrice(model.pricing)).toBe(true);
          else expect(model.availability).toBeTruthy();
        }
      }
    }
  });

  test("variant and redirected alias rates take precedence over family names", () => {
    expect(priceFor("openai:gpt-5.4-mini-2026-03-17", pricing)).toEqual({ input: .75, cachedInput: .075, output: 4.5 });
    expect(priceFor("gpt-5.6", pricing)).toEqual(pricing["gpt-5.6-sol"]);
    expect(priceFor("grok-4-fast-reasoning", pricing)).toEqual(pricing["grok-4.3"]);
    expect(priceFor("grok-code-fast-1", pricing)).toEqual(pricing["grok-build-0.1"]);
    expect(priceFor("gpt-4o-2024-05-13", pricing)).toEqual({ input: 5, output: 15 });
  });

  test("unknown models do not inherit substring prices but explicit overrides still work", () => {
    for (const id of ["gpt-5.99", "gpt-5-image", "qwen3-future", "claude-opus-6"])
      expect(priceFor(id, pricing)).toBeNull();
    const custom = { input: 1, cachedInput: .1, output: 2 };
    expect(priceFor("vendor:private-reasoner-v2", { ...pricing, "private-reasoner": custom })).toEqual(custom);
    expect(priceFor("gpt-5-2030-01-01", { ...pricing, "gpt-5": custom })).toEqual(custom);
  });

  test("OpenAI and xAI use their different long-context boundaries", () => {
    expect(price("gpt-6-astra", 272_000)?.input).toBe(10);
    expect(price("gpt-6-astra", 272_001)?.input).toBe(20);
    expect(price("gpt-5.5-pro", 272_001)?.output).toBe(270);
    expect(price("grok-4.6", 199_999)?.input).toBe(2);
    expect(price("grok-4.6", 200_000)?.input).toBe(4);
  });

  test("Qwen applies every prompt-size tier to the whole request", () => {
    const expected = [[32_000, 1], [32_001, 1.8], [128_000, 1.8], [128_001, 3], [256_000, 3], [256_001, 6]];
    for (const [tokens, input] of expected) expect(price("qwen3-coder-plus", tokens!)?.input).toBe(input);
    expect(price("qwen3-coder-plus", 256_001)?.output).toBe(60);
    expect(price("qwen3.7-flash", 256_001)?.input).toBe(.2);
  });

  test("Fast rates are explicit, including long context, and only supported models advertise Fast", () => {
    expect(price("gpt-6-astra#fast", 272_001)).toEqual({ input: 40, cachedInput: 4, cacheWriteInput: 50, output: 150 });
    expect(price("gpt-5.6-sol", 10, { serviceTier: "priority" })).toEqual(pricing["gpt-5.6-sol#fast"]);
    expect(price("gpt-5.5", 10, { serviceTier: "fast" })?.input).toBe(12.5);
    expect(price("gpt-5.5#fast", 272_001)).toBeNull();
    expect(price("gpt-5-mini#fast", 100)?.input).toBe(.45);
    expect(modelSupportsOpenAIFastMode("openai", "gpt-6-astra")).toBe(true);
    expect(modelSupportsOpenAIFastMode("openai", "o3")).toBe(true);
    expect(price("o3#fast", 100)?.input).toBe(3.5);
    expect(modelSupportsOpenAIFastMode("openai", "gpt-5.5-pro")).toBe(false);
    expect(modelSupportsOpenAIFastMode("openai", "gpt-5.4-nano")).toBe(false);
  });

  test("DeepSeek rates follow the published UTC weekday schedule", () => {
    for (const [at, expected] of [
      ["2026-09-16T00:59:59Z", .15], ["2026-09-16T01:00:00Z", .3],
      ["2026-09-16T03:59:59Z", .3], ["2026-09-16T04:00:00Z", .15],
      ["2026-09-16T06:00:00Z", .3], ["2026-09-16T09:59:59Z", .3],
      ["2026-09-16T10:00:00Z", .15], ["2026-09-19T02:00:00Z", .15],
    ] as const) expect(price("deepseek-v4-flash", 100, { at: Date.parse(at) })?.input).toBe(expected);
    expect(price("deepseek-v4-pro", 100, { at: Date.parse("2026-09-19T02:00:00Z") })?.output).toBe(1.98);
  });

  test("thinking output prices and cached/write tokens remain additive", () => {
    const model = key("qwen-plus", 300_000, { thinking: true });
    expect(priceFor(model, pricing)?.output).toBe(12);
    expect(price("qwen-plus", 300_000, { thinking: false })?.output).toBe(3.6);
    const result = estimateCostUsd({ models: {
      [model]: { input: 200_000, cachedInput: 100_000, output: 10_000 },
      "gpt-6-astra#fast": { input: 100_000, cachedInput: 50_000, cacheWriteInput: 20_000, output: 10_000 },
    } }, pricing);
    expect(result.unpricedModels).toEqual([]);
    expect(result.costUsd).toBeCloseTo(.24 + .024 + .12 + 2 + .1 + .5 + 1);
  });

  test("missing cache rates report an incomplete estimate without discarding known costs", () => {
    expect(estimateCostUsd({ models: {
      "gpt-5.5-pro": { input: 1_000_000, cachedInput: 1, output: 1_000_000 },
    } }, pricing)).toEqual({ costUsd: 210, unpricedModels: ["gpt-5.5-pro"] });
    expect(estimateCostUsd({ models: {
      "gpt-5.5-pro": { input: 1_000_000, cachedInput: 0, output: 1_000_000 },
    } }, pricing)).toEqual({ costUsd: 210, unpricedModels: [] });
  });
});

describe("refreshed model request compatibility", () => {
  test("OpenAI supports current effort levels with Fast mode", () => {
    expect(request("openai", "gpt-6-astra#fast", "max").body).toMatchObject({ model: "gpt-6-astra", reasoning: { effort: "max" }, service_tier: "priority" });
    expect(effortLevelsForProvider({ name: "openai", model: "gpt-5.4-mini" })).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(effortLevelsForProvider({ name: "openai", model: "gpt-5.5-pro" })).toEqual(["medium", "high", "xhigh"]);
  });

  test("current Claude uses adaptive thinking", () => {
    expect(request("anthropic", "claude-fable-5-1", "max").body).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "max" } });
    expect(request("anthropic", "claude-sonnet-5", "xhigh").body).toMatchObject({ output_config: { effort: "xhigh" } });
  });

  test("GLM and Kimi enforce always-on reasoning where required", () => {
    expect(request("glm", "glm-5.3", "low").body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "low" });
    expect(request("glm", "glm-5.3-flash", "none").body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "max" });
    expect(request("kimi", "kimi-k3", "low").body).toMatchObject({ reasoning_effort: "low" });
    expect(request("kimi", "kimi-k3", "low").body).not.toHaveProperty("thinking");
    expect(request("kimi", "kimi-k2.7-code", "none").body).toMatchObject({ thinking: { type: "enabled" } });
  });

  test("Grok supports current effort settings and Qwen Coder omits unsupported thinking controls", () => {
    expect(request("xai", "grok-4.6", "xhigh").body).toMatchObject({ reasoning_effort: "xhigh" });
    expect(request("qwen", "qwen3-coder-plus", "high").body).not.toHaveProperty("enable_thinking");
  });

  test("driver preserves the billed service tier when the response echoes a base model", () => {
    const prepared = reduceStepDriverState({ chatId: "fast", phase: "prepare" }, {
      type: "Prepared", prepared: { kind: "llm", ...request("openai", "gpt-6-astra#fast", "max") },
    });
    const received = reduceStepDriverState(prepared, {
      type: "LlmResultReceived", llmResult: { model: "gpt-6-astra", ok: true },
    });
    const effects = planStepDriverEffects(received);
    expect(effects[0]).toMatchObject({ type: "HandleLlm", input: { requestModel: "gpt-6-astra", requestEffort: "max", requestServiceTier: "priority" } });
  });
});
