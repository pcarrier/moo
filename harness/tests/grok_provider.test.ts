import { afterEach, describe, expect, test } from "bun:test";

import { DEEPSEEK_THINK_MAX_SYSTEM_PROMPT, buildStreamingLLMRequest, effortLevelsForProvider, inferProviderForModel, modelContextBudget, normalizeUsage, recordUsage, resolveProvider } from "../src/agent";
import { llmAuthGetCommand, llmAuthSaveCommand } from "../src/commands/llm_auth";
import { applyDefaultChatSettings, chatModelInfo, modelOptionsFor, modelSupportsAttachments, splitModelId, modelSupportsToolCalls } from "../src/commands/models";
import { estimateCostUsd, loadPricing, priceFor } from "../src/commands/describe";
import { modelLongContextUsageKey, modelMetadataFor, modelMatches } from "../src/llm_models";
import { stepCommand } from "../src/commands/step";

const refs = new Map<string, string>();
const objects = new Map<string, { kind: string; content: string }>();
let objectId = 0;
let envValues = new Map<string, string>();

(globalThis as any).__op_now = () => 1_000;
(globalThis as any).__op_env_get = (name: string) => envValues.get(name) ?? null;
(globalThis as any).__op_ref_get = (name: string) => refs.get(name) ?? null;
(globalThis as any).__op_ref_set = (name: string, target: string) => { refs.set(name, target); return true; };
(globalThis as any).__op_ref_cas = (name: string, expected: string | null, next: string) => { const __cur = refs.has(name) ? refs.get(name) : null; if (__cur !== (expected ?? null)) return false; refs.set(name, next); return true; };
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
  test("records pricing tiers per request and retains Fast mode with an echoed base model", async () => {
    for (const tokens of [32_000, 32_001]) {
      await recordUsage("tier-test", "qwen3-coder-plus", { prompt_tokens: tokens, completion_tokens: 100 });
    }
    await recordUsage("tier-test", "gpt-6-astra", { prompt_tokens: 272_001, completion_tokens: 100 }, { serviceTier: "priority" });
    const stored = JSON.parse(refs.get("chat/tier-test/usage")!.slice("json:".length));
    expect(stored.models["qwen3-coder-plus"].input).toBe(32_000);
    expect(stored.models["qwen3-coder-plus#long-context"].input).toBe(32_001);
    expect(stored.models["gpt-6-astra#long-context#fast"].input).toBe(272_001);
    expect(estimateCostUsd(stored, await loadPricing()).costUsd).toBeCloseTo(
      (32_000 + 100 * 5 + 32_001 * 1.8 + 100 * 9 + 272_001 * 40 + 100 * 150) / 1_000_000,
    );
  });

  test("infers and parses xAI-prefixed Grok models", () => {
    expect(inferProviderForModel("grok-4-fast")).toBe("xai");
    expect(splitModelId("xai:grok-4-fast")).toEqual({ provider: "xai", model: "grok-4-fast" });
  });

  test("infers and parses DeepSeek-prefixed models", () => {
    expect(inferProviderForModel("deepseek-v4-flash")).toBe("deepseek");
    expect(splitModelId("deepseek:deepseek-v4-pro")).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
  });

  test("infers and parses GLM-prefixed models", () => {
    expect(inferProviderForModel("glm-5.1")).toBe("glm");
    expect(splitModelId("glm:glm-5.1")).toEqual({ provider: "glm", model: "glm-5.1" });
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
    expect(modelSupportsAttachments("deepseek", "deepseek-v4-flash")).toBe(true);
    expect(options.find((option) => option.id === "deepseek:deepseek-v4-flash")?.supportsAttachments).toBe(true);
  });

  test("includes GLM defaults in model options", async () => {
    const options = await modelOptionsFor("glm", "glm-5.1");
    expect(options.map((option) => option.id)).toContain("glm:glm-5.1");
    expect(options.map((option) => option.id)).toContain("glm:glm-4.7-flashx");
    expect(modelSupportsToolCalls("glm-4.6")).toBe(true);
    expect(modelSupportsAttachments("glm", "glm-5.1")).toBe(false);
    expect(options.find((option) => option.id === "glm:glm-5.1")?.supportsAttachments).toBe(false);
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

  test("defaults xAI credentials to x.ai API and Grok 4.6", async () => {
    const provider = await resolveProvider(null, null, "xai");
    expect(provider).toMatchObject({ name: "xai", baseUrl: "https://api.x.ai/v1", model: "grok-4.6", effort: null });
  });

  test("defaults DeepSeek credentials to DeepSeek API and V4.1 Flash", async () => {
    const provider = await resolveProvider(null, null, "deepseek");
    expect(provider).toMatchObject({ name: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", effort: null });
  });

  test("defaults GLM credentials to Z.AI API and GLM 5.3", async () => {
    const provider = await resolveProvider(null, null, "glm");
    expect(provider).toMatchObject({ name: "glm", baseUrl: "https://api.z.ai/api/paas/v4", model: "glm-5.3", effort: null });
  });

  test("enables optional Qwen3 thinking", () => {
    expect(effortLevelsForProvider({ name: "qwen", model: "qwen3.8-max" })).toEqual(["none", "high"]);
    expect(effortLevelsForProvider({ name: "qwen", model: "qwen3-coder-plus" })).toEqual([]);
    const request = buildStreamingLLMRequest({
      name: "qwen",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      apiKey: "key",
      model: "qwen3.8-max",
      effort: "high",
    } as any, [{ role: "user", content: "Think" }], null);
    expect(request.requestEffort).toBe("high");
    expect(request.body).toMatchObject({ enable_thinking: true });

    const noThinking = buildStreamingLLMRequest({
      name: "qwen",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      apiKey: "key",
      model: "qwen3.8-max",
      effort: "none",
    } as any, [{ role: "user", content: "Answer" }], null);
    expect(noThinking.requestEffort).toBe("none");
    expect(noThinking.body).toMatchObject({ enable_thinking: false });
  });

  test("enables optional GLM thinking", () => {
    expect(effortLevelsForProvider({ name: "glm", model: "glm-5.2" })).toEqual(["none", "high"]);
    expect(effortLevelsForProvider({ name: "glm", model: "glm-4.6" })).toEqual(["none", "high"]);
    const request = buildStreamingLLMRequest({
      name: "glm",
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "key",
      model: "glm-5.2",
      effort: "high",
    } as any, [{ role: "user", content: "Think" }], null);
    expect(request.requestEffort).toBe("high");
    expect(request.body).toMatchObject({ thinking: { type: "enabled" } });

    const noThinking = buildStreamingLLMRequest({
      name: "glm",
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "key",
      model: "glm-5.2",
      effort: "none",
    } as any, [{ role: "user", content: "Answer" }], null);
    expect(noThinking.requestEffort).toBe("none");
    expect(noThinking.body).toMatchObject({ thinking: { type: "disabled" } });
  });

  test("sends OpenRouter reasoning for GLM via OpenRouter base URL", () => {
    expect(effortLevelsForProvider({ name: "glm", model: "z-ai/glm-5.3" })).toEqual(["low", "high", "max"]);
    const request = buildStreamingLLMRequest({
      name: "glm",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "key",
      model: "z-ai/glm-5.3",
      effort: "high",
    } as any, [{ role: "user", content: "Think" }], null);
    expect(request.requestEffort).toBe("high");
    expect(request.body).toMatchObject({ reasoning: { enabled: true, effort: "high" } });
    expect(request.body.thinking).toBeUndefined();

    const disabled = buildStreamingLLMRequest({
      name: "glm",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "key",
      model: "z-ai/glm-5.2",
      effort: "none",
    } as any, [{ role: "user", content: "Answer" }], null);
    expect(disabled.body).toMatchObject({ reasoning: { enabled: false } });
  });

  test("matches GLM gateway slugs without changing outbound model IDs", () => {
    for (const model of ["z-ai/glm-5.3", " Z-AI/GLM-5.3 "]) {
      expect(inferProviderForModel(model)).toBe("glm");
      expect(modelMetadataFor("glm", model)?.id).toBe("glm-5.3");
      expect(modelContextBudget({ name: "glm", model } as any)).toBe(
        modelContextBudget({ name: "glm", model: "glm-5.3" } as any),
      );
      expect(effortLevelsForProvider({ name: "glm", model })).toEqual(["low", "high", "max"]);
    }
    expect(modelMetadataFor("glm", "z-ai/glm-5.3-flash")?.id).toBe("glm-5.3-flash");
    expect(inferProviderForModel("other/glm-5.3")).toBeNull();
    expect(effortLevelsForProvider({ name: "glm", model: "other/glm-5.3" })).toEqual([]);
  });

  test("preserves GLM 5.3 effort defaults and native request fields", () => {
    for (const effort of [null, "none", "medium", "low", "high", "max"]) {
      const expected = ["low", "high", "max"].includes(effort ?? "") ? effort : "max";
      for (const model of ["glm-5.3", "z-ai/glm-5.3", "z-ai/glm-5.3-flash"]) {
        const request = buildStreamingLLMRequest({
          name: "glm", baseUrl: "https://openrouter.ai/api/v1", apiKey: "key", model, effort,
        } as any, [{ role: "user", content: "Think" }], null);
        expect(request.requestEffort).toBe(expected);
        expect(request.body.model).toBe(model);
        expect(request.body.reasoning).toEqual({ enabled: true, effort: expected });
        expect(request.body.thinking).toBeUndefined();
        expect(request.body.reasoning_effort).toBeUndefined();
      }
      const native = buildStreamingLLMRequest({
        name: "glm", baseUrl: "https://api.z.ai/api/paas/v4", apiKey: "key", model: "glm-5.3", effort,
      } as any, [{ role: "user", content: "Think" }], null);
      expect(native.body.thinking).toEqual({ type: "enabled" });
      expect(native.body.reasoning_effort).toBe(expected);
      expect(native.body.reasoning).toBeUndefined();
    }
  });

  test("recognizes OpenRouter authority, including explicit ports, without lookalikes", () => {
    for (const [baseUrl, openRouter] of [
      ["https://openrouter.ai:443/api/v1", true],
      ["https://OPENROUTER.AI/api/v1/", true],
      ["https://openrouter.ai.evil.test/api/v1", false],
      ["https://evil.test/openrouter.ai", false],
      ["https://openrouter.ai@evil.test/api/v1", false],
      ["https://evil.test@openrouter.ai/api/v1", false],
      ["ftp://openrouter.ai/api/v1", false],
    ] as const) {
      const request = buildStreamingLLMRequest({
        name: "glm", baseUrl, apiKey: "key", model: "glm-5.3", effort: "high",
      } as any, [{ role: "user", content: "Think" }], null);
      expect(request.body.reasoning !== undefined).toBe(openRouter);
      expect(request.body.thinking !== undefined).toBe(!openRouter);
    }
  });

  test("enables optional Kimi K2 thinking", () => {
    expect(effortLevelsForProvider({ name: "kimi", model: "kimi-k2.6-code" })).toEqual(["none", "high"]);
    expect(effortLevelsForProvider({ name: "kimi", model: "moonshot-v1-128k" })).toEqual([]);
    const request = buildStreamingLLMRequest({
      name: "kimi",
      baseUrl: "https://api.moonshot.ai/v1",
      apiKey: "key",
      model: "kimi-k2.6-code",
      effort: "high",
    } as any, [{ role: "user", content: "Think" }], null);
    expect(request.requestEffort).toBe("high");
    expect(request.body).toMatchObject({ thinking: { type: "enabled" } });
  });

  test("reads GLM key, model, and base URL aliases", async () => {
    envValues = new Map([
      ["GLM_API_KEY", "glm-key"],
      ["GLM_BASE_URL", "https://proxy.example/glm"],
      ["GLM_MODEL", "glm-4.6"],
    ]);

    const provider = await resolveProvider(null, null, "glm");

    expect(provider).toMatchObject({ name: "glm", apiKey: "glm-key", baseUrl: "https://proxy.example/glm", model: "glm-4.6", keyEnvHint: "ZAI_API_KEY" });
  });

  test("defaults Kimi credentials to the Moonshot platform endpoint", async () => {
    const provider = await resolveProvider(null, null, "kimi");
    expect(provider).toMatchObject({ name: "kimi", baseUrl: "https://api.moonshot.ai/v1", model: "kimi-k3" });
  });

  test("persists the GLM Coding Plan endpoint and routes the selected model there", async () => {
    // Legacy/API clients can still choose a variant without a URL override.
    await llmAuthSaveCommand({ glm: { authMode: "apiKey", apiKey: "coding-key", baseUrl: "", variant: "coding" } });
    const reloaded = await llmAuthGetCommand();
    expect(reloaded.value.settings.providers.glm).toMatchObject({ authMode: "apiKey", variant: "coding", baseUrl: null });

    const provider = await resolveProvider("glm-5.3-flash", null, "glm");
    expect(provider).toMatchObject({ name: "glm", apiKey: "coding-key", baseUrl: "https://api.z.ai/api/coding/paas/v4", model: "glm-5.3-flash" });
    const request = buildStreamingLLMRequest(provider, [{ role: "user", content: "hello" }], [
      { type: "function", function: { name: "lookup", description: "Lookup a value.", parameters: { type: "object", properties: {} } } },
    ]);
    expect(request.url).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
    expect(request.transport).toBe("sse");
    expect(request.body).toMatchObject({ model: "glm-5.3-flash", stream: true, tool_choice: "auto" });
    expect((request.body as any).tools?.[0]?.function?.name).toBe("lookup");
  });

  test("the UI plan selection replaces an old endpoint despite environment overrides", async () => {
    envValues.set("ZAI_BASE_URL", "https://api.z.ai/api/paas/v4");
    await llmAuthSaveCommand({ glm: { authMode: "apiKey", apiKey: "zai-key", baseUrl: "https://proxy.example/glm" } });
    // Match the UI's plan-selection payload; omit the already-stored API key.
    await llmAuthSaveCommand({ glm: { variant: "coding", baseUrl: "https://api.z.ai/api/coding/paas/v4" } });
    expect((await llmAuthGetCommand()).value.settings.providers.glm).toMatchObject({
      variant: "coding", baseUrl: "https://api.z.ai/api/coding/paas/v4", hasApiKey: true,
    });
    expect(await resolveProvider("glm-5.3-flash", null, "glm")).toMatchObject({
      apiKey: "zai-key", model: "glm-5.3-flash", baseUrl: "https://api.z.ai/api/coding/paas/v4",
    });

    envValues.set("ZAI_BASE_URL", "https://api.z.ai/api/coding/paas/v4");
    await llmAuthSaveCommand({ glm: { variant: "platform", baseUrl: "https://api.z.ai/api/paas/v4" } });
    expect(await resolveProvider(null, null, "glm")).toMatchObject({
      apiKey: "zai-key", baseUrl: "https://api.z.ai/api/paas/v4",
    });
  });

  test("supports environment keys with the GLM Coding Plan endpoint", async () => {
    envValues.set("ZAI_API_KEY", "coding-env-key");
    await llmAuthSaveCommand({ glm: { authMode: "env", variant: "coding" } });
    const provider = await resolveProvider(null, null, "glm");
    expect(provider).toMatchObject({ name: "glm", apiKey: "coding-env-key", baseUrl: "https://api.z.ai/api/coding/paas/v4", model: "glm-5.3" });
  });

  test("preserves the GLM endpoint when saving only authentication", async () => {
    await llmAuthSaveCommand({ glm: { authMode: "apiKey", apiKey: "coding-key", variant: "coding" } });
    await llmAuthSaveCommand({ glm: { apiKey: "new-coding-key" } });
    expect((await llmAuthGetCommand()).value.settings.providers.glm.variant).toBe("coding");
    expect(await resolveProvider(null, null, "glm")).toMatchObject({ apiKey: "new-coding-key", baseUrl: "https://api.z.ai/api/coding/paas/v4" });
  });

  test("keeps explicit GLM URL overrides ahead of the Coding Plan endpoint", async () => {
    envValues.set("ZAI_BASE_URL", "https://env.example/glm");
    await llmAuthSaveCommand({ glm: { variant: "coding", baseUrl: "https://proxy.example/glm" } });
    expect(await resolveProvider(null, null, "glm")).toMatchObject({ baseUrl: "https://proxy.example/glm" });

    await llmAuthSaveCommand({ glm: { baseUrl: "" } });
    expect(await resolveProvider(null, null, "glm")).toMatchObject({ baseUrl: "https://env.example/glm" });

    envValues.delete("ZAI_BASE_URL");
    envValues.set("GLM_BASE_URL", "https://alias.example/glm");
    expect(await resolveProvider(null, null, "glm")).toMatchObject({ baseUrl: "https://alias.example/glm" });

    envValues.delete("GLM_BASE_URL");
    expect(await resolveProvider(null, null, "glm")).toMatchObject({ baseUrl: "https://api.z.ai/api/coding/paas/v4" });
  });

  test("can switch GLM back to pay-as-you-go without replacing its API key", async () => {
    await llmAuthSaveCommand({ glm: { authMode: "apiKey", apiKey: "zai-key", variant: "coding" } });
    await llmAuthSaveCommand({ glm: { variant: "platform" } });
    expect(await resolveProvider(null, null, "glm")).toMatchObject({ apiKey: "zai-key", baseUrl: "https://api.z.ai/api/paas/v4" });
  });

  test("does not silently opt existing or invalid GLM settings into subscription billing", async () => {
    await llmAuthSaveCommand({ glm: { authMode: "apiKey", apiKey: "platform-key" } });
    expect(await resolveProvider(null, null, "glm")).toMatchObject({ baseUrl: "https://api.z.ai/api/paas/v4" });
    await llmAuthSaveCommand({ glm: { variant: "unknown" } });
    expect((await llmAuthGetCommand()).value.settings.providers.glm.variant).toBeNull();
    expect(await resolveProvider(null, null, "glm")).toMatchObject({ baseUrl: "https://api.z.ai/api/paas/v4" });
  });

  test("routes the Kimi Code variant to api.kimi.com/coding with kimi-for-coding", async () => {
    const saved = await llmAuthSaveCommand({ kimi: { authMode: "apiKey", apiKey: "code-key", variant: "code" } });
    expect(saved.value.settings.providers.kimi).toMatchObject({ authMode: "apiKey", variant: "code" });

    const provider = await resolveProvider(null, null, "kimi");
    expect(provider).toMatchObject({
      name: "kimi",
      apiKey: "code-key",
      baseUrl: "https://api.kimi.com/coding/v1",
      model: "kimi-for-coding",
    });
  });

  test("a reloaded llm-auth-get still reports the saved Kimi variant", async () => {
    // Mirror the exact kimi payload SettingsView sends (empty baseUrl + variant).
    await llmAuthSaveCommand({ kimi: { authMode: "apiKey", apiKey: "code-key", baseUrl: "", variant: "code" } });
    const reloaded = await llmAuthGetCommand();
    expect(reloaded.value.settings.providers.kimi).toMatchObject({ variant: "code" });
  });

  test("an explicit base URL override still wins over the Kimi Code variant", async () => {
    await llmAuthSaveCommand({ kimi: { authMode: "apiKey", apiKey: "code-key", variant: "code", baseUrl: "https://proxy.example/kimi" } });
    const provider = await resolveProvider(null, null, "kimi");
    expect(provider).toMatchObject({ name: "kimi", baseUrl: "https://proxy.example/kimi", model: "kimi-for-coding" });
  });

  test("redacted auth settings include xAI provider", async () => {
    const result = await llmAuthGetCommand();
    expect(result.value.settings.providers.xai).toMatchObject({ authMode: "env" });
    expect(result.value.settings.providers.deepseek).toMatchObject({ authMode: "env" });
    expect(result.value.settings.providers.glm).toMatchObject({ authMode: "env" });
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
    expect(modelContextBudget({ name: "xai", model: "grok-4-fast" })).toBe(1_000_000);
    expect(modelContextBudget({ name: "xai", model: "grok-4.6" })).toBe(500_000);
  });

  test("uses GPT-5.6 API and Codex context windows for dated model variants", () => {
    expect(modelContextBudget({ name: "openai", model: "gpt-5.6-sol" })).toBe(1_050_000);
    expect(modelContextBudget({ name: "openai", model: "gpt-5.6-terra-2026-01" })).toBe(1_050_000);
    expect(modelContextBudget({ name: "openai", model: "gpt-5.6-luna", authMode: "oauth" })).toBe(400_000);
    expect(modelContextBudget({ name: "openai", model: "gpt-5.6-2026-01", authMode: "oauth" })).toBe(400_000);
  });

  test("tracks GPT-5.6 availability tiers", async () => {
    const base = modelMetadataFor("openai", "gpt-5.6");
    expect(base?.id).toBe("gpt-5.6-sol");
    expect(base?.availability).toBe("API and Codex; promotional rates through at least 2026-11-21");
    expect(base?.capabilities?.reasoning).toBe(true);
    expect(base && modelMatches(base, "gpt-5.6-sol-2026-01")).toBe(true);
    expect(modelMetadataFor("openai", "gpt-5.6-terra")?.id).toBe("gpt-5.6-terra");
    expect(modelMetadataFor("openai", "gpt-5.6-luna")?.id).toBe("gpt-5.6-luna");
    const options = await modelOptionsFor("openai", "gpt-5.6");
    expect(options.find((option) => option.id === "openai:gpt-5.6-sol")?.availability).toBe(base?.availability);
    expect(options.map((option) => option.id)).toEqual(expect.arrayContaining(["openai:gpt-5.6-sol", "openai:gpt-5.6-terra", "openai:gpt-5.6-luna"]));
  });

  test("uses GLM-specific context windows and request options", async () => {
    expect(modelContextBudget({ name: "glm", model: "glm-5.1" })).toBe(200_000);
    expect(modelContextBudget({ name: "glm", model: "glm-4.5-air" })).toBe(128_000);
    const provider = await resolveProvider("glm-5.1", null, "glm");
    const request = buildStreamingLLMRequest(provider, [{ role: "user", content: "hello" }], [
      { type: "function", function: { name: "lookup", description: "Lookup a value.", parameters: { type: "object", properties: {} } } },
    ]);

    expect(request.url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
    expect(request.transport).toBe("sse");
    expect(request.body).toMatchObject({ model: "glm-5.1", stream: true, tool_choice: "auto" });
    expect((request.body as any).tools?.[0]?.function?.name).toBe("lookup");
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

    expect(info.supportsAttachments).toBe(true);
    expect(info.modelOptions.find((option) => option.id === "deepseek:deepseek-v4-flash")?.supportsAttachments).toBe(true);
    expect(info.modelOptions.find((option) => option.id === "xai:grok-4.6")?.supportsAttachments).toBe(true);
  });

  test("rejects DeepSeek Pro image attachments before starting a step", async () => {
    refs.set("chat/deepseek-step/provider", "deepseek");
    refs.set("chat/deepseek-step/model", "deepseek-v4-pro");

    const result = await stepCommand({
      chatId: "deepseek-step",
      message: "see attached",
      attachments: [{ type: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ source: "unsupported_attachments", provider: "deepseek", model: "deepseek-v4-pro" });
    expect(JSON.stringify(result.error)).toContain("does not support image attachments");
  });

  test("tracks GPT-5.6 pricing", async () => {
    const pricing = await loadPricing();
    expect(priceFor("gpt-5.6", pricing)).toEqual({ input: 4, cachedInput: 0.4, cacheWriteInput: 5, output: 20 });
    expect(priceFor("gpt-5.6-sol-2026-01", pricing)).toEqual({ input: 4, cachedInput: 0.4, cacheWriteInput: 5, output: 20 });
    expect(priceFor("gpt-5.6-terra", pricing)).toEqual({ input: 2, cachedInput: 0.2, cacheWriteInput: 2.5, output: 12 });
    expect(priceFor("gpt-5.6-luna", pricing)).toEqual({ input: 0.2, cachedInput: 0.02, cacheWriteInput: 0.25, output: 1.2 });
    expect(estimateCostUsd({ models: { "gpt-5.6": { input: 1_000_000, cachedInput: 1_000_000, cacheWriteInput: 1_000_000, output: 1_000_000 } } }, pricing).costUsd).toBe(29.4);
  });

  test("tracks Grok pricing and capabilities", async () => {
    const pricing = await loadPricing();
    expect(priceFor("grok-4-fast", pricing)).toEqual({ input: 1.25, cachedInput: 0.2, output: 2.5 });
    expect(priceFor("grok-4-fast#long-context", pricing)).toEqual({ input: 2.5, cachedInput: 0.4, output: 5 });
    expect(modelLongContextUsageKey("grok-4-fast", 200_000)).toBe("grok-4.3#long-context");
    expect(modelSupportsToolCalls("grok-4-fast")).toBe(true);
    expect(estimateCostUsd({ models: { "grok-4-fast": { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 } } }, pricing).costUsd).toBe(3.95);
  });

  test("tracks GLM pricing and capabilities", async () => {
    const pricing = await loadPricing();
    expect(priceFor("glm-5.1", pricing)).toEqual({ input: 1.4, cachedInput: 0.26, output: 4.4 });
    expect(priceFor("glm-4.7", pricing)).toEqual({ input: 0.6, cachedInput: 0.11, output: 2.2 });
    expect(priceFor("glm-4.7-flash", pricing)).toEqual({ input: 0, cachedInput: 0, output: 0 });
    expect(modelMetadataFor("glm", "glm-4.6")?.maxOutputTokens).toBe(128_000);
    expect(estimateCostUsd({ models: { "glm-5.1": { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 } } }, pricing).costUsd).toBe(6.06);
  });

  test("tracks DeepSeek pricing, aliases, and cache usage", async () => {
    const pricing = await loadPricing();
    expect(priceFor("deepseek-v4-flash", pricing)).toEqual({ input: 0.3, cachedInput: 0.006, output: 1.2 });
    expect(priceFor("deepseek-flash", pricing)).toEqual({ input: 0.3, cachedInput: 0.006, output: 1.2 });
    expect(priceFor("deepseek-v4-pro", pricing)).toEqual({ input: 1.32, cachedInput: 0.044, output: 3.96 });
    const normalizedCacheUsage = normalizeUsage({ prompt_tokens: 20, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6, completion_tokens: 2 });
    expect(normalizedCacheUsage?.prompt_tokens).toBe(10);
    expect(normalizedCacheUsage?.prompt_tokens_details?.cached_tokens).toBe(4);
    await recordUsage("deepseek-cache-test", "deepseek-v4-flash", normalizedCacheUsage);
    const stored = JSON.parse(refs.get("chat/deepseek-cache-test/usage")!.slice("json:".length));
    expect(stored.models["deepseek-flash#off-peak"]).toEqual({ input: 6, cachedInput: 4, cacheWriteInput: 0, output: 2 });
    expect(estimateCostUsd({ models: { "deepseek-v4-flash": { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 } } }, pricing).costUsd).toBe(1.506);
  });
});
