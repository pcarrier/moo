export type ProviderName = "openai" | "qwen" | "anthropic" | "xai" | "deepseek";

export type ModelPrice = {
  /** USD per million regular input tokens. */
  input: number;
  /** USD per million prompt-cache read tokens. */
  cachedInput: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million prompt-cache write tokens; defaults to `input` when omitted. */
  cacheWriteInput?: number;
};

export type ModelCapabilities = {
  toolCalls?: boolean;
  structuredOutputs?: boolean;
  reasoning?: boolean;
  vision?: boolean;
};

export type ModelRateLimits = {
  requestsPerSecond?: number;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
};

export type ModelMetadata = {
  id: string;
  /** Optional additional ids that route to the same model metadata. */
  aliases?: string[];
  /** A JS regex source matched against lower-case model ids for versioned models. */
  match?: string;
  contextWindow?: number;
  /** Context limits for provider-specific interfaces layered over the API. */
  interfaceContextWindows?: Partial<Record<"api" | "codex", number>>;
  /** Max generated tokens, when the provider documents a separate output cap. */
  maxOutputTokens?: number;
  pricing?: ModelPrice;
  /** Pricing used when the request crosses the provider's long-context threshold. */
  longContext?: { threshold: number; pricing: ModelPrice };
  capabilities?: ModelCapabilities;
  /** Human-readable availability notes for UI/API model metadata. */
  availability?: string;
  rateLimits?: ModelRateLimits;
  /** Show in the model picker by default. */
  defaultOption?: boolean;
};

export type ProviderMetadata = {
  id: ProviderName;
  title: string;
  envKey: string;
  envAltKeys?: string[];
  baseUrlEnv: string;
  defaultBaseUrl: string;
  fallbackModel: string;
  inferPrefixes: string[];
  models: readonly ModelMetadata[];
};

export const DEFAULT_CONTEXT_TOKENS = 128_000;

export const PROVIDERS: readonly ProviderName[] = ["openai", "anthropic", "qwen", "xai", "deepseek"];

export const PROVIDER_METADATA: Record<ProviderName, ProviderMetadata> = {
  openai: {
    id: "openai",
    title: "OpenAI",
    envKey: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.openai.com/v1",
    fallbackModel: "gpt-5.5",
    inferPrefixes: ["gpt-", "o1", "o3", "o4", "chatgpt-"],
    models: [
      { id: "gpt-5.5", match: "^gpt-5\\.5(?!-pro)(?:[.-]|$)", contextWindow: 1_000_000, interfaceContextWindows: { codex: 400_000 }, pricing: { input: 5, cachedInput: 0.5, output: 30 }, capabilities: { toolCalls: true, reasoning: true }, availability: "Plus, Pro, Business, Enterprise, API, and Codex", defaultOption: true },
      { id: "gpt-5.5-pro", match: "^gpt-5\\.5-pro(?:[.-]|$)", contextWindow: 1_000_000, pricing: { input: 30, cachedInput: 3, output: 180 }, capabilities: { toolCalls: true, reasoning: true }, availability: "ChatGPT Pro, Business, Enterprise, Edu, and API", defaultOption: true },
      { id: "gpt-5.4", defaultOption: true },
      { id: "gpt-5.4-mini", defaultOption: true },
      { id: "gpt-5.4-nano", defaultOption: true },
      { id: "gpt-5.4-pro", defaultOption: true },
      { id: "gpt-5.3-chat-latest", defaultOption: true },
      { id: "gpt-5.3-codex", defaultOption: true },
      { id: "gpt-5.2", defaultOption: true },
      { id: "gpt-5.2-chat-latest", defaultOption: true },
      { id: "gpt-5.2-codex", defaultOption: true },
      { id: "gpt-5.2-pro", defaultOption: true },
      { id: "gpt-5.1", defaultOption: true },
      { id: "gpt-5.1-chat-latest", defaultOption: true },
      { id: "gpt-5.1-codex", defaultOption: true },
      { id: "gpt-5.1-codex-max", defaultOption: true },
      { id: "gpt-5.1-codex-mini", defaultOption: true },
      { id: "gpt-5", match: "^gpt-5(?:[.-]|$)", contextWindow: 400_000, pricing: { input: 2.5, cachedInput: 0.25, output: 10 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "gpt-5-chat-latest", defaultOption: true },
      { id: "gpt-5-codex", defaultOption: true },
      { id: "gpt-5-mini", defaultOption: true },
      { id: "gpt-5-nano", defaultOption: true },
      { id: "gpt-5-pro", defaultOption: true },
      { id: "o4-mini", match: "^o4(?:[.-]|$)", contextWindow: 200_000, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "o3", match: "^o3(?:[.-]|$)", contextWindow: 200_000, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "o3-pro", defaultOption: true },
      { id: "o3-mini", defaultOption: true },
      { id: "gpt-4.1", match: "^gpt-4\\.1(?:[.-]|$)", contextWindow: 1_000_000, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "gpt-4.1-mini", defaultOption: true },
      { id: "gpt-4.1-nano", defaultOption: true },
      { id: "gpt-4o", match: "^gpt-4o(?:[.-]|$)", contextWindow: 128_000, pricing: { input: 2.5, cachedInput: 1.25, output: 10 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "gpt-4o-mini", pricing: { input: 0.15, cachedInput: 0.075, output: 0.6 }, defaultOption: true },
      { id: "chatgpt-", match: "^chatgpt-", contextWindow: 128_000, capabilities: { toolCalls: true } },
    ],
  },
  anthropic: {
    id: "anthropic",
    title: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    fallbackModel: "claude-opus-4-8",
    inferPrefixes: ["claude"],
    models: [
      // Keep Claude 4.x context/output caps aligned with Anthropic's Models overview.
      { id: "claude-opus-4", match: "^claude-opus-4(?:[.-]|$)", contextWindow: 200_000, maxOutputTokens: 32_000, pricing: { input: 15, cachedInput: 1.5, cacheWriteInput: 18.75, output: 75 }, capabilities: { toolCalls: true } },
      { id: "claude-sonnet-4", match: "^claude-sonnet-4(?:[.-]|$)", contextWindow: 200_000, maxOutputTokens: 64_000, pricing: { input: 3, cachedInput: 0.3, cacheWriteInput: 3.75, output: 15 }, capabilities: { toolCalls: true } },
      { id: "claude-haiku-4", match: "^claude-haiku-4(?:[.-]|$)", contextWindow: 200_000, maxOutputTokens: 64_000, pricing: { input: 1, cachedInput: 0.1, cacheWriteInput: 1.25, output: 5 }, capabilities: { toolCalls: true } },
      { id: "claude-opus-4-8", match: "^claude-opus-4[.-]8(?:[.-]|$)", contextWindow: 1_000_000, maxOutputTokens: 128_000, pricing: { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 25 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "claude-opus-4-7", match: "^claude-opus-4[.-]7(?:[.-]|$)", contextWindow: 1_000_000, maxOutputTokens: 128_000, pricing: { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 25 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "claude-opus-4-6", match: "^claude-opus-4[.-]6(?:[.-]|$)", contextWindow: 1_000_000, maxOutputTokens: 128_000, pricing: { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 25 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "claude-sonnet-4-6", match: "^claude-sonnet-4[.-]6(?:[.-]|$)", contextWindow: 1_000_000, maxOutputTokens: 64_000, pricing: { input: 3, cachedInput: 0.3, cacheWriteInput: 3.75, output: 15 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "claude-opus-4-5", match: "^claude-opus-4[.-]5(?:[.-]|$)", contextWindow: 200_000, maxOutputTokens: 64_000, pricing: { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 25 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "claude-sonnet-4-5", match: "^claude-sonnet-4[.-]5(?:[.-]|$)", contextWindow: 200_000, maxOutputTokens: 64_000, pricing: { input: 3, cachedInput: 0.3, cacheWriteInput: 3.75, output: 15 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "claude-haiku-4-5", match: "^claude-haiku-4[.-]5(?:[.-]|$)", contextWindow: 200_000, maxOutputTokens: 64_000, pricing: { input: 1, cachedInput: 0.1, cacheWriteInput: 1.25, output: 5 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "claude-opus-4-1", match: "^claude-opus-4[.-]1(?:[.-]|$)", contextWindow: 200_000, maxOutputTokens: 32_000, pricing: { input: 15, cachedInput: 1.5, cacheWriteInput: 18.75, output: 75 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "claude-sonnet-4", defaultOption: true },
      { id: "claude-opus-4", defaultOption: true },
      { id: "claude-3-7-sonnet", match: "^claude-3-7-sonnet", contextWindow: 200_000, pricing: { input: 3, cachedInput: 0.3, cacheWriteInput: 3.75, output: 15 }, capabilities: { toolCalls: true } },
      { id: "claude-3-7-sonnet-latest", defaultOption: true },
      { id: "claude-3-5-sonnet", pricing: { input: 3, cachedInput: 0.3, cacheWriteInput: 3.75, output: 15 }, capabilities: { toolCalls: true } },
      { id: "claude-3-5-haiku", pricing: { input: 0.8, cachedInput: 0.08, cacheWriteInput: 1, output: 4 }, capabilities: { toolCalls: true } },
      { id: "claude-3-opus", pricing: { input: 15, cachedInput: 1.5, cacheWriteInput: 18.75, output: 75 }, capabilities: { toolCalls: true } },
      { id: "claude-3-haiku", pricing: { input: 0.25, cachedInput: 0.03, cacheWriteInput: 0.3, output: 1.25 }, capabilities: { toolCalls: true } },
    ],
  },
  qwen: {
    id: "qwen",
    title: "Qwen",
    envKey: "QWEN_API_KEY",
    envAltKeys: ["DASHSCOPE_API_KEY"],
    baseUrlEnv: "QWEN_BASE_URL",
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    fallbackModel: "qwen3.6",
    inferPrefixes: ["qwen"],
    models: [
      { id: "qwen3.6", match: "^qwen3\\.6(?:[.-]|$)", contextWindow: 262_144, pricing: { input: 0.4, cachedInput: 0.04, output: 1.2 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "qwen3", match: "^qwen3(?:[.-]|$)", contextWindow: 262_144, pricing: { input: 0.4, cachedInput: 0.04, output: 1.2 }, capabilities: { toolCalls: true } },
      { id: "qwen-plus", match: "^qwen-(?:plus|max|turbo|flash)(?:[-.]|$)", contextWindow: 131_072, pricing: { input: 0.4, cachedInput: 0.04, output: 1.2 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "qwen3-max", defaultOption: true },
      { id: "qwen3-plus", defaultOption: true },
      { id: "qwen3-turbo", defaultOption: true },
      { id: "qwen3-flash", defaultOption: true },
      { id: "qwen3-coder-plus", defaultOption: true },
      { id: "qwen3-coder-flash", defaultOption: true },
      { id: "qwen3-coder-next", defaultOption: true },
      { id: "qwen-plus-latest", defaultOption: true },
      { id: "qwen-max", defaultOption: true },
      { id: "qwen-max-latest", defaultOption: true },
      { id: "qwen-turbo", defaultOption: true },
      { id: "qwen-turbo-latest", defaultOption: true },
      { id: "qwen-flash", defaultOption: true },
      { id: "qwen", pricing: { input: 0.4, cachedInput: 0.04, output: 1.2 } },
    ],
  },
  xai: {
    id: "xai",
    title: "xAI",
    envKey: "XAI_API_KEY",
    envAltKeys: ["GROK_API_KEY"],
    baseUrlEnv: "XAI_BASE_URL",
    defaultBaseUrl: "https://api.x.ai/v1",
    fallbackModel: "grok-4-fast",
    inferPrefixes: ["grok"],
    models: [
      {
        id: "grok-4-fast",
        aliases: ["grok-4-fast-reasoning", "grok-4-fast-reasoning-latest"],
        match: "^grok-4-fast(?:[-.]|$)",
        contextWindow: 2_000_000,
        pricing: { input: 0.2, cachedInput: 0.05, output: 0.5 },
        longContext: { threshold: 128_000, pricing: { input: 0.4, cachedInput: 0, output: 1 } },
        capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true },
        rateLimits: { requestsPerSecond: 10, requestsPerMinute: 600, tokensPerMinute: 4_000_000 },
        defaultOption: true,
      },
    ],
  },
  deepseek: {
    id: "deepseek",
    title: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    defaultBaseUrl: "https://api.deepseek.com",
    fallbackModel: "deepseek-v4-flash",
    inferPrefixes: ["deepseek"],
    models: [
      {
        id: "deepseek-v4-flash",
        aliases: ["deepseek-chat", "deepseek-reasoner"],
        match: "^deepseek-(?:v4-flash|chat|reasoner)(?:[-.]|$)",
        contextWindow: 1_000_000,
        maxOutputTokens: 384_000,
        pricing: { input: 0.14, cachedInput: 0.0028, output: 0.28 },
        capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true },
        defaultOption: true,
      },
      {
        id: "deepseek-v4-pro",
        match: "^deepseek-v4-pro(?:[-.]|$)",
        contextWindow: 1_000_000,
        maxOutputTokens: 384_000,
        pricing: { input: 0.435, cachedInput: 0.003625, output: 0.87 },
        capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true },
        defaultOption: true,
      },
    ],
  },
};

function lower(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeProvider(value: unknown): ProviderName | null {
  const id = lower(String(value ?? ""));
  return (PROVIDERS as readonly string[]).includes(id) ? id as ProviderName : null;
}

export function inferProviderForModelId(model: string | null | undefined): ProviderName | null {
  const id = lower(model);
  if (!id) return null;
  for (const provider of PROVIDERS) {
    if (PROVIDER_METADATA[provider].inferPrefixes.some((prefix) => id.startsWith(prefix))) return provider;
  }
  return null;
}

export function modelMatches(metadata: ModelMetadata, model: string): boolean {
  const id = lower(model);
  if (!id) return false;
  if (id === lower(metadata.id)) return true;
  if (metadata.aliases?.some((alias) => id === lower(alias))) return true;
  return metadata.match ? new RegExp(metadata.match).test(id) : false;
}

export function modelMetadataFor(provider: ProviderName | null | undefined, model: string | null | undefined): ModelMetadata | null {
  const id = lower(model);
  if (!id) return null;
  const providers = provider ? [provider] : PROVIDERS;
  let best: ModelMetadata | null = null;
  let bestLen = -1;
  for (const providerId of providers) {
    for (const metadata of PROVIDER_METADATA[providerId].models) {
      if (!modelMatches(metadata, id)) continue;
      const len = Math.max(metadata.id.length, ...(metadata.aliases ?? []).map((alias) => alias.length));
      if (len > bestLen) {
        best = metadata;
        bestLen = len;
      }
    }
  }
  return best;
}

export function defaultModelIds(provider: ProviderName): string[] {
  return PROVIDER_METADATA[provider].models.filter((model) => model.defaultOption).map((model) => model.id);
}

export function modelContextWindow(provider: ProviderName | null | undefined, model: string | null | undefined, iface: "api" | "codex" = "api"): number {
  const metadata = modelMetadataFor(provider, model);
  return metadata?.interfaceContextWindows?.[iface] ?? metadata?.contextWindow ?? DEFAULT_CONTEXT_TOKENS;
}

export function modelSupportsTools(provider: ProviderName | null | undefined, model: string | null | undefined): boolean {
  const metadata = modelMetadataFor(provider, model);
  if (metadata?.capabilities?.toolCalls != null) return metadata.capabilities.toolCalls;
  const id = lower(model);
  if (!id) return false;
  if (id.startsWith("claude-")) return true;
  if (id.startsWith("qwen")) {
    if (/(?:omni|vl|audio|image|asr|tts|embedding|rerank|long)/.test(id)) return false;
    return /^qwen3(?:[.-]|$)/.test(id) || /^qwen-(?:plus|max|turbo|flash)(?:[-.]|$)/.test(id);
  }
  if (id.startsWith("grok")) return metadata?.capabilities?.toolCalls === true;
  if (id.startsWith("deepseek")) return metadata?.capabilities?.toolCalls === true;
  if (/(?:^|[-.])(?:audio|realtime|image|transcribe|tts|search|embedding|moderation|whisper|dall-e|deep-research)(?:[-.]|$)/.test(id)) return false;
  return /^gpt-5(?:[.-]|$)/.test(id) || /^gpt-4(?:\.1|o)?(?:[.-]|$)/.test(id) || /^o(?:3|4)(?:[.-]|$)/.test(id) || /^chatgpt-/.test(id);
}

export function modelSupportsVision(provider: ProviderName | null | undefined, model: string | null | undefined): boolean {
  const metadata = modelMetadataFor(provider, model);
  if (metadata?.capabilities?.vision != null) return metadata.capabilities.vision;
  const id = lower(model);
  if (!id) return false;
  if (id.startsWith("deepseek")) return false;
  if (id.startsWith("grok")) return metadata?.capabilities?.vision === true;
  if (id.startsWith("claude-")) return true;
  if (id.startsWith("qwen")) return /(?:omni|vl)/.test(id);
  if (/(?:^|[-.])(?:audio|realtime|image|transcribe|tts|search|embedding|moderation|whisper|dall-e|deep-research)(?:[-.]|$)/.test(id)) return false;
  return /^gpt-5(?:[.-]|$)/.test(id) || /^gpt-4(?:\.1|o)?(?:[.-]|$)/.test(id) || /^o(?:3|4)(?:[.-]|$)/.test(id) || /^chatgpt-/.test(id);
}

export function modelLongContextUsageKey(model: string | null | undefined, promptTokens: number): string | null {
  const metadata = modelMetadataFor(null, model);
  if (!metadata?.longContext) return null;
  return promptTokens > metadata.longContext.threshold ? metadata.id + "#long-context" : null;
}

export function defaultModelPricing(): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {};
  for (const provider of PROVIDERS) {
    for (const model of PROVIDER_METADATA[provider].models) {
      if (model.pricing) {
        out[model.id] = model.pricing;
        for (const alias of model.aliases ?? []) out[alias] = model.pricing;
      }
      if (model.longContext) {
        out[model.id + "#long-context"] = model.longContext.pricing;
        for (const alias of model.aliases ?? []) out[alias + "#long-context"] = model.longContext.pricing;
      }
    }
  }
  return out;
}
