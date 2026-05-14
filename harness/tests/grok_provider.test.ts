import { afterEach, describe, expect, test } from "bun:test";

import { DEEPSEEK_THINK_MAX_SYSTEM_PROMPT, buildStreamingLLMRequest, inferProviderForModel, modelContextBudget, normalizeUsage, recordUsage, resolveProvider } from "../src/agent";
import { llmAuthGetCommand, llmAuthSaveCommand } from "../src/commands/llm_auth";
import { applyDefaultChatSettings, chatModelInfo, modelOptionsFor, modelSupportsAttachments, splitModelId, modelSupportsToolCalls } from "../src/commands/models";
import { estimateCostUsd, loadPricing, priceFor } from "../src/commands/describe";
import { modelLongContextUsageKey, modelMetadataFor } from "../src/llm_models";
import { stepCommand } from "../src/commands/step";

const refs = new Map<string, string>();
const objects = new Map<string, { kind: string; content: string }>();
let objectId = 0;
let envValues = new Map<string, string>();

(globalThis as any).__op_now = () => 1_000;
(globalThis as any).__op_env_get = (name: string) => envValues.get(name) ?? null;
(globalThis as any).__op_ref_get = (name: string) => refs.get(name) ?? null;
(globalThis as any).__op_ref_set = (name: string, target: string) => { refs.set(name, target); return true; };
(globalThis as any).__op_ref_delete = (name: string) => refs.delete(name);
(globalThis as any).__op_facts_match = () => [];
(globalThis as any).__op_facts_swap = () => ({ store: "test", added: 0, removed: 0 });
(globalThis as any).__op_object_put = (kind: string, content: string) => {
  const hash = "sha256:" + String(++objectId).padStart(64, "0");
  objects.set(hash, { kind, content });
  return hash;
};
(globalThis as any).__op_object_get = (hash: string) => objects.get(hash) ?? null;

afterEach(() => {
  refs.clear();
  objects.clear();
  envValues.clear();
});

describe("OpenAI-compatible provider support", () => {
  test("infers and parses xAI-prefixed Grok models", () => {
    expect(inferProviderForModel("grok-4-fast")).toBe("xai");
    expect(splitModelId("xai:grok-4-fast")).toEqual({ provider: "xai", model: "grok-4-fast" });
  });

  test("infers and parses DeepSeek-prefixed models", () => {
    expect(inferProviderForModel("deepseek-v4-flash")).toBe("deepseek");
    expect(splitModelId("deepseek:deepseek-v4-pro")).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
  });

  test("includes Grok defaults in model options", async () => {
    const options = await modelOptionsFor("xai", "grok-4-fast");
    expect(options.map((option) => option.id)).toContain("xai:grok-4-fast");
    expect(options.map((option) => option.id)).not.toContain("xai:grok-code-fast-1");
  });

  test("includes DeepSeek defaults in model options", async () => {
    const options = await modelOptionsFor("deepseek", "deepseek-v4-flash");
    expect(options.map((option) => option.id)).toContain("deepseek:deepseek-v4-flash");
    expect(options.map((option) => option.id)).toContain("deepseek:deepseek-v4-pro");
    expect(modelSupportsToolCalls("deepseek-chat")).toBe(true);
    expect(modelSupportsAttachments("deepseek", "deepseek-v4-flash")).toBe(false);
    expect(options.find((option) => option.id === "deepseek:deepseek-v4-flash")?.supportsAttachments).toBe(false);
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

  test("defaults DeepSeek credentials to DeepSeek API and V4 Flash", async () => {
    const provider = await resolveProvider(null, null, "deepseek");
    expect(provider).toMatchObject({ name: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", effort: null });
  });

  test("redacted auth settings include xAI provider", async () => {
    const result = await llmAuthGetCommand();
    expect(result.value.settings.providers.xai).toMatchObject({ authMode: "env" });
    expect(result.value.settings.providers.deepseek).toMatchObject({ authMode: "env" });
  });

  test("preserves OpenAI OAuth credentials across auth mode changes", async () => {
    refs.set("settings", "sha256:oauth");
    objects.set("sha256:oauth", {
      kind: "llm:AuthSettings",
      content: JSON.stringify({
        providers: {
          openai: {
            authMode: "oauth",
            accessToken: "access-token",
            refreshToken: "refresh-token",
            expiresAt: 123456,
            oauthSubject: "subject",
            oauthAccountId: "account",
          },
        },
      }),
    });

    const saved = await llmAuthSaveCommand({ openai: { authMode: "env" } });
    expect(saved.value.settings.providers.openai).toMatchObject({
      authMode: "env",
      hasAccessToken: true,
      hasRefreshToken: true,
      expiresAt: 123456,
      oauthSubject: "subject",
      oauthAccountId: "account",
    });

    const storedHash = refs.get("settings")!;
    const storedOpenAI = JSON.parse(objects.get(storedHash)!.content).providers.openai;
    expect(storedOpenAI.accessToken).toBe("access-token");
    expect(storedOpenAI.refreshToken).toBe("refresh-token");
  });

  test("uses Grok-specific context windows", () => {
    expect(modelContextBudget({ name: "xai", model: "grok-4-fast" })).toBe(2_000_000);
    expect(modelMetadataFor("xai", "grok-4-fast")?.rateLimits).toMatchObject({ requestsPerMinute: 600, tokensPerMinute: 4_000_000 });
  });

  test("uses DeepSeek-specific context windows and request options", async () => {
    expect(modelContextBudget({ name: "deepseek", model: "deepseek-v4-flash" })).toBe(1_000_000);
    const provider = await resolveProvider("deepseek-v4-pro", "max", "deepseek");
    const request = buildStreamingLLMRequest(provider, [{ role: "user", content: "hello" }], null);
    expect(request.url).toBe("https://api.deepseek.com/chat/completions");
    expect(request.requestEffort).toBe("max");
    expect(request.body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "max" });
    expect((request.body as any).messages).toEqual([
      { role: "system", content: DEEPSEEK_THINK_MAX_SYSTEM_PROMPT },
      { role: "user", content: "hello" },
    ]);

    const noThinking = buildStreamingLLMRequest({ ...provider, effort: "none" }, [{ role: "user", content: "hello" }], null);
    expect(noThinking.requestEffort).toBe("none");
    expect(noThinking.body).toMatchObject({ thinking: { type: "disabled" } });
    expect((noThinking.body as any).reasoning_effort).toBeUndefined();

    const highThinking = buildStreamingLLMRequest({ ...provider, effort: "high" }, [{ role: "user", content: "hello" }], null);
    expect(highThinking.requestEffort).toBe("high");
    expect(highThinking.body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high" });

    const defaultThinking = buildStreamingLLMRequest({ ...provider, effort: null }, [{ role: "user", content: "hello" }], null);
    expect(defaultThinking.requestEffort).toBe("high");
    expect(defaultThinking.body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high" });

    const attachmentRequest = buildStreamingLLMRequest(provider, [
      {
        role: "user",
        content: [
          { type: "text", text: "see attached" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ], null);
    expect(JSON.stringify((attachmentRequest.body as any).messages)).not.toContain("image_url");
    expect((attachmentRequest.body as any).messages[1].content).toEqual([
      { type: "text", text: "see attached" },
    ]);

    const options = await modelOptionsFor("deepseek", "deepseek-v4-pro");
    expect(options.map((option) => option.id)).toContain("deepseek:deepseek-v4-pro");
  });

  test("reports attachment support in chat model info", async () => {
    refs.set("chat/deepseek-attachments/provider", "deepseek");
    refs.set("chat/deepseek-attachments/model", "deepseek-v4-flash");

    const info = await chatModelInfo("deepseek-attachments");

    expect(info.supportsAttachments).toBe(false);
    expect(info.modelOptions.find((option) => option.id === "deepseek:deepseek-v4-flash")?.supportsAttachments).toBe(false);
    expect(info.modelOptions.find((option) => option.id === "xai:grok-4-fast")?.supportsAttachments).toBe(true);
  });

  test("rejects DeepSeek image attachments before starting a step", async () => {
    refs.set("chat/deepseek-step/provider", "deepseek");
    refs.set("chat/deepseek-step/model", "deepseek-v4-flash");

    const result = await stepCommand({
      chatId: "deepseek-step",
      message: "see attached",
      attachments: [{ type: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ source: "unsupported_attachments", provider: "deepseek", model: "deepseek-v4-flash" });
    expect(JSON.stringify(result.error)).toContain("does not support image attachments");
  });

  test("tracks Grok pricing and capabilities", async () => {
    const pricing = await loadPricing();
    expect(priceFor("grok-4-fast", pricing)).toEqual({ input: 0.2, cachedInput: 0.05, output: 0.5 });
    expect(priceFor("grok-4-fast#long-context", pricing)).toEqual({ input: 0.4, cachedInput: 0, output: 1 });
    expect(modelLongContextUsageKey("grok-4-fast", 128_001)).toBe("grok-4-fast#long-context");
    expect(modelSupportsToolCalls("grok-4-fast")).toBe(true);
    expect(estimateCostUsd({ models: { "grok-4-fast": { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 } } }, pricing).costUsd).toBe(0.75);
  });

  test("tracks DeepSeek pricing, aliases, and cache usage", async () => {
    const pricing = await loadPricing();
    expect(priceFor("deepseek-v4-flash", pricing)).toEqual({ input: 0.14, cachedInput: 0.0028, output: 0.28 });
    expect(priceFor("deepseek-chat", pricing)).toEqual({ input: 0.14, cachedInput: 0.0028, output: 0.28 });
    expect(priceFor("deepseek-v4-pro", pricing)).toEqual({ input: 0.435, cachedInput: 0.003625, output: 0.87 });
    const normalizedCacheUsage = normalizeUsage({ prompt_tokens: 20, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6, completion_tokens: 2 });
    expect(normalizedCacheUsage?.prompt_tokens).toBe(10);
    expect(normalizedCacheUsage?.prompt_tokens_details?.cached_tokens).toBe(4);
    await recordUsage("deepseek-cache-test", "deepseek-v4-flash", normalizedCacheUsage);
    const stored = JSON.parse(refs.get("chat/deepseek-cache-test/usage")!.slice("json:".length));
    expect(stored.models["deepseek-v4-flash"]).toEqual({ input: 6, cachedInput: 4, cacheWriteInput: 0, output: 2 });
    expect(estimateCostUsd({ models: { "deepseek-v4-flash": { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 } } }, pricing).costUsd).toBe(0.4228);
  });
});
