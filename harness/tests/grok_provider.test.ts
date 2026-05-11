import { afterEach, describe, expect, test } from "bun:test";

import { inferProviderForModel, modelContextBudget, resolveProvider } from "../src/agent";
import { llmAuthGetCommand } from "../src/commands/llm_auth";
import { applyDefaultChatSettings, modelOptionsFor, splitModelId, modelSupportsToolCalls } from "../src/commands/models";
import { estimateCostUsd, loadPricing, priceFor } from "../src/commands/describe";
import { modelLongContextUsageKey, modelMetadataFor } from "../src/llm_models";

const refs = new Map<string, string>();
const objects = new Map<string, any>();
let objectId = 0;
let envValues = new Map<string, string>();

(globalThis as any).__op_env_get = (name: string) => envValues.get(name) ?? null;
(globalThis as any).__op_ref_get = (name: string) => refs.get(name) ?? null;
(globalThis as any).__op_ref_set = (name: string, target: string) => { refs.set(name, target); return true; };
(globalThis as any).__op_ref_delete = (name: string) => refs.delete(name);
(globalThis as any).__op_facts_match = () => [];
(globalThis as any).__op_facts_swap = () => ({ store: "test", added: 0, removed: 0 });
(globalThis as any).__op_object_put = (kind: string, content: string) => {
  const hash = "sha256:" + String(++objectId).padStart(64, "0");
  objects.set(hash, { kind, value: JSON.parse(content) });
  return hash;
};
(globalThis as any).__op_object_get = (hash: string) => objects.get(hash) ?? null;

afterEach(() => {
  refs.clear();
  objects.clear();
  envValues.clear();
});

describe("Grok/xAI provider support", () => {
  test("infers and parses xAI-prefixed Grok models", () => {
    expect(inferProviderForModel("grok-4-fast")).toBe("xai");
    expect(splitModelId("xai:grok-4-fast")).toEqual({ provider: "xai", model: "grok-4-fast" });
  });

  test("includes Grok defaults in model options", async () => {
    const options = await modelOptionsFor("xai", "grok-4-fast");
    expect(options.map((option) => option.id)).toContain("xai:grok-4-fast");
    expect(options.map((option) => option.id)).not.toContain("xai:grok-code-fast-1");
  });


  test("applies configured defaults to fresh chats without last picker state", async () => {
    envValues = new Map([
      ["OPENAI_MODEL", "gpt-5.5"],
      ["OPENAI_REASONING_EFFORT", "high"],
    ]);

    await applyDefaultChatSettings("fresh");

    expect(refs.get("chat/fresh/provider")).toBe("openai");
    expect(refs.get("chat/fresh/model")).toBe("gpt-5.5");
    expect(refs.get("chat/fresh/effort")).toBe("high");
  });

  test("last picker state wins over configured fresh-chat defaults", async () => {
    envValues = new Map([
      ["OPENAI_MODEL", "gpt-5.5"],
      ["OPENAI_REASONING_EFFORT", "high"],
    ]);
    refs.set("ui/last-provider", "anthropic");
    refs.set("ui/last-model", "claude-sonnet-4-5");
    refs.set("ui/last-effort", "medium");

    await applyDefaultChatSettings("fresh");

    expect(refs.get("chat/fresh/provider")).toBe("anthropic");
    expect(refs.get("chat/fresh/model")).toBe("claude-sonnet-4-5");
    expect(refs.get("chat/fresh/effort")).toBe("medium");
  });

  test("defaults xAI credentials to x.ai API and Grok 4 Fast", async () => {
    const provider = await resolveProvider(null, null, "xai");
    expect(provider).toMatchObject({ name: "xai", baseUrl: "https://api.x.ai/v1", model: "grok-4-fast", effort: null });
  });

  test("redacted auth settings include xAI provider", async () => {
    const result = await llmAuthGetCommand();
    expect(result.value.settings.providers.xai).toMatchObject({ authMode: "env" });
  });

  test("uses Grok-specific context windows", () => {
    expect(modelContextBudget({ name: "xai", model: "grok-4-fast" })).toBe(2_000_000);
    expect(modelMetadataFor("xai", "grok-4-fast")?.rateLimits).toMatchObject({ requestsPerMinute: 600, tokensPerMinute: 4_000_000 });
  });

  test("tracks Grok pricing and capabilities", async () => {
    const pricing = await loadPricing();
    expect(priceFor("grok-4-fast", pricing)).toEqual({ input: 0.2, cachedInput: 0.05, output: 0.5 });
    expect(priceFor("grok-4-fast#long-context", pricing)).toEqual({ input: 0.4, cachedInput: 0, output: 1 });
    expect(modelLongContextUsageKey("grok-4-fast", 128_001)).toBe("grok-4-fast#long-context");
    expect(modelSupportsToolCalls("grok-4-fast")).toBe(true);
    expect(estimateCostUsd({ models: { "grok-4-fast": { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 } } }, pricing).costUsd).toBe(0.75);
  });
});
