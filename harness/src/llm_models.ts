export type ProviderName = "openai" | "qwen" | "glm" | "anthropic" | "xai" | "deepseek" | "kimi";

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

/**
 * An alternate endpoint for a provider that shares the same API key plumbing
 * but targets a different base URL and default model — e.g. Kimi's "Kimi Code"
 * subscription (api.kimi.com/coding) vs the Moonshot dev platform
 * (api.moonshot.ai). Selected explicitly by the user, mirroring how OpenAI
 * routes on authMode rather than sniffing the key string (both use `sk-`).
 */
export type ProviderVariant = {
  id: string;
  title: string;
  baseUrl: string;
  fallbackModel: string;
};

export type ProviderMetadata = {
  id: ProviderName;
  title: string;
  envKey: string;
  envAltKeys?: string[];
  baseUrlEnv: string;
  baseUrlAltEnvs?: string[];
  defaultBaseUrl: string;
  fallbackModel: string;
  inferPrefixes: string[];
  /** Optional alternate endpoints; the first entry is the default. */
  variants?: readonly ProviderVariant[];
  models: readonly ModelMetadata[];
};

export const DEFAULT_CONTEXT_TOKENS = 128_000;
export const OPENAI_FAST_MODEL_SUFFIX = "#fast";
export const OPENAI_FAST_SERVICE_TIER = "priority";

export const PROVIDERS: readonly ProviderName[] = ["openai", "anthropic", "qwen", "glm", "xai", "deepseek", "kimi"];

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
      { id: "gpt-5.4", defaultOption: true },
      { id: "gpt-5.4-mini", defaultOption: true },
      { id: "gpt-5.4-nano", defaultOption: true },
      { id: "gpt-5", match: "^gpt-5(?:[.-]|$)", contextWindow: 400_000, pricing: { input: 2.5, cachedInput: 0.25, output: 10 }, capabilities: { toolCalls: true }, defaultOption: true },
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
      { id: "claude-fable-5", match: "^claude-fable-5(?:[.-]|$)", contextWindow: 1_000_000, maxOutputTokens: 128_000, pricing: { input: 10, cachedInput: 1, cacheWriteInput: 12.5, output: 50 }, capabilities: { toolCalls: true }, defaultOption: true },
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
    ],
  },
  qwen: {
    id: "qwen",
    title: "Qwen",
    envKey: "QWEN_API_KEY",
    envAltKeys: ["DASHSCOPE_API_KEY"],
    baseUrlEnv: "QWEN_BASE_URL",
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    fallbackModel: "qwen3-max",
    inferPrefixes: ["qwen"],
    models: [
      { id: "qwen3", match: "^qwen3(?:[.-]|$)", contextWindow: 262_144, pricing: { input: 0.4, cachedInput: 0.04, output: 1.2 }, capabilities: { toolCalls: true } },
      { id: "qwen-plus", match: "^qwen-(?:plus|max|turbo|flash)(?:[-.]|$)", contextWindow: 131_072, pricing: { input: 0.4, cachedInput: 0.04, output: 1.2 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "qwen3-max", defaultOption: true },
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
  glm: {
    id: "glm",
    title: "GLM",
    envKey: "ZAI_API_KEY",
    envAltKeys: ["GLM_API_KEY", "ZHIPUAI_API_KEY", "ZHIPU_API_KEY", "BIGMODEL_API_KEY"],
    baseUrlEnv: "ZAI_BASE_URL",
    baseUrlAltEnvs: ["GLM_BASE_URL", "ZHIPUAI_BASE_URL", "ZHIPU_BASE_URL", "BIGMODEL_BASE_URL"],
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    fallbackModel: "glm-5.2",
    inferPrefixes: ["glm-"],
    models: [
      { id: "glm-5.2", match: "^glm-5\\.2(?:[-.]|$)", contextWindow: 1_000_000, maxOutputTokens: 128_000, pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true }, defaultOption: true },
      { id: "glm-5.1", match: "^glm-5\\.1(?:[-.]|$)", contextWindow: 200_000, maxOutputTokens: 128_000, pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-5-turbo", match: "^glm-5-turbo(?:[-.]|$)", contextWindow: 200_000, maxOutputTokens: 128_000, pricing: { input: 1.2, cachedInput: 0.24, output: 4 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-5", match: "^glm-5(?:[-.]|$)", contextWindow: 200_000, maxOutputTokens: 128_000, pricing: { input: 1, cachedInput: 0.2, output: 3.2 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.7-flashx", match: "^glm-4\\.7-flashx(?:[-.]|$)", contextWindow: 200_000, maxOutputTokens: 128_000, pricing: { input: 0.07, cachedInput: 0.01, output: 0.4 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.7-flash", match: "^glm-4\\.7-flash(?:[-.]|$)", contextWindow: 200_000, maxOutputTokens: 128_000, pricing: { input: 0, cachedInput: 0, output: 0 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.7", match: "^glm-4\\.7(?:[-.]|$)", contextWindow: 200_000, maxOutputTokens: 128_000, pricing: { input: 0.6, cachedInput: 0.11, output: 2.2 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.6", match: "^glm-4\\.6(?:[-.]|$)", contextWindow: 200_000, maxOutputTokens: 128_000, pricing: { input: 0.6, cachedInput: 0.11, output: 2.2 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.5-x", match: "^glm-4\\.5-x(?:[-.]|$)", contextWindow: 128_000, maxOutputTokens: 96_000, pricing: { input: 2.2, cachedInput: 0.45, output: 8.9 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.5-airx", match: "^glm-4\\.5-airx(?:[-.]|$)", contextWindow: 128_000, maxOutputTokens: 96_000, pricing: { input: 1.1, cachedInput: 0.22, output: 4.5 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.5-air", match: "^glm-4\\.5-air(?:[-.]|$)", contextWindow: 128_000, maxOutputTokens: 96_000, pricing: { input: 0.2, cachedInput: 0.03, output: 1.1 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.5-flash", match: "^glm-4\\.5-flash(?:[-.]|$)", contextWindow: 128_000, maxOutputTokens: 96_000, pricing: { input: 0, cachedInput: 0, output: 0 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.5", match: "^glm-4\\.5(?:[-.]|$)", contextWindow: 128_000, maxOutputTokens: 96_000, pricing: { input: 0.6, cachedInput: 0.11, output: 2.2 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
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
  kimi: {
    id: "kimi",
    title: "Kimi",
    envKey: "MOONSHOT_API_KEY",
    envAltKeys: ["KIMI_API_KEY"],
    baseUrlEnv: "MOONSHOT_BASE_URL",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    fallbackModel: "kimi-k3",
    inferPrefixes: ["kimi-", "moonshot-"],
    variants: [
      // Moonshot dev platform (platform.kimi.ai → api.moonshot.ai).
      { id: "platform", title: "Moonshot Platform", baseUrl: "https://api.moonshot.ai/v1", fallbackModel: "kimi-k3" },
      // Kimi Code subscription (kimi.com/code/console). Keys are NOT
      // interchangeable with the platform, and the OpenAI-compatible endpoint
      // requires the `kimi-for-coding` model id.
      { id: "code", title: "Kimi Code", baseUrl: "https://api.kimi.com/coding/v1", fallbackModel: "kimi-for-coding" },
    ],
    models: [
      {
        id: "kimi-k3",
        match: "^kimi-k3(?:[-.]|$)",
        contextWindow: 1_048_576,
        maxOutputTokens: 1_048_576,
        pricing: { input: 3, cachedInput: 0.3, output: 15 },
        capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true },
        defaultOption: true,
      },
      { id: "kimi-for-coding", match: "^kimi-for-coding(?:[-.]|$)", contextWindow: 262_144, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true } },
      {
        id: "kimi-k2.7-code-highspeed",
        match: "^kimi-k2\\.7-code-highspeed(?:[-.]|$)",
        contextWindow: 262_144,
        pricing: { input: 1.9, cachedInput: 0.38, output: 8 },
        capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true },
        defaultOption: true,
      },
      {
        id: "kimi-k2.7-code",
        aliases: ["kimi-k2.7"],
        match: "^kimi-k2\\.7(?:-code)?(?:[-.]|$)",
        contextWindow: 262_144,
        pricing: { input: 0.95, cachedInput: 0.19, output: 4 },
        capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true },
        defaultOption: true,
      },
      {
        id: "kimi-k2.6",
        match: "^kimi-k2\\.6(?:[-.]|$)",
        contextWindow: 262_144,
        pricing: { input: 0.95, cachedInput: 0.16, output: 4 },
        capabilities: { toolCalls: true, reasoning: true, vision: true },
        defaultOption: true,
      },
      {
        id: "kimi-k2.5",
        match: "^kimi-k2\\.5(?:[-.]|$)",
        contextWindow: 262_144,
        pricing: { input: 0.6, cachedInput: 0.1, output: 3 },
        capabilities: { toolCalls: true, reasoning: true, vision: true },
        defaultOption: true,
      },
      { id: "moonshot-v1-128k", match: "^moonshot-v1-128k(?:[-.]|$)", contextWindow: 131_072, pricing: { input: 2, cachedInput: 2, output: 5 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "moonshot-v1-32k", match: "^moonshot-v1-32k(?:[-.]|$)", contextWindow: 32_768, pricing: { input: 1, cachedInput: 1, output: 3 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "moonshot-v1-8k", match: "^moonshot-v1-8k(?:[-.]|$)", contextWindow: 8_192, pricing: { input: 0.2, cachedInput: 0.2, output: 2 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "moonshot-v1-128k-vision-preview", contextWindow: 131_072, pricing: { input: 2, cachedInput: 2, output: 5 }, capabilities: { vision: true }, defaultOption: true },
      { id: "moonshot-v1-32k-vision-preview", contextWindow: 32_768, pricing: { input: 1, cachedInput: 1, output: 3 }, capabilities: { vision: true }, defaultOption: true },
      { id: "moonshot-v1-8k-vision-preview", contextWindow: 8_192, pricing: { input: 0.2, cachedInput: 0.2, output: 2 }, capabilities: { vision: true }, defaultOption: true },
    ],
  },
};

/**
 * Resolve a provider's selected variant. Returns the matching variant, or the
 * first (default) variant when the id is unset/unknown, or null when the
 * provider declares no variants.
 */
export function resolveProviderVariant(meta: ProviderMetadata, variantId: string | null | undefined): ProviderVariant | null {
  const variants = meta.variants;
  if (!variants?.length) return null;
  const id = lower(variantId);
  return variants.find((v) => v.id === id) ?? variants[0];
}

function lower(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function isOpenAIGptModelId(model: string | null | undefined): boolean {
  return lower(model).startsWith("gpt-");
}

export function openAIBaseModelForRequest(model: string | null | undefined): string {
  const trimmed = String(model ?? "").trim();
  const suffix = OPENAI_FAST_MODEL_SUFFIX;
  if (!trimmed.toLowerCase().endsWith(suffix)) return trimmed;
  const base = trimmed.slice(0, -suffix.length).trim();
  return isOpenAIGptModelId(base) ? base : trimmed;
}

export function openAIServiceTierForModel(model: string | null | undefined): typeof OPENAI_FAST_SERVICE_TIER | null {
  const trimmed = String(model ?? "").trim();
  if (!trimmed.toLowerCase().endsWith(OPENAI_FAST_MODEL_SUFFIX)) return null;
  const base = openAIBaseModelForRequest(trimmed);
  return base !== trimmed && isOpenAIGptModelId(base) ? OPENAI_FAST_SERVICE_TIER : null;
}

export function openAIFastModelId(model: string | null | undefined): string {
  return openAIBaseModelForRequest(model) + OPENAI_FAST_MODEL_SUFFIX;
}

export function modelSupportsOpenAIFastMode(provider: ProviderName | null | undefined, model: string | null | undefined): boolean {
  if (provider && provider !== "openai") return false;
  return isOpenAIGptModelId(openAIBaseModelForRequest(model));
}

export function normalizeProvider(value: unknown): ProviderName | null {
  const id = lower(String(value ?? ""));
  return (PROVIDERS as readonly string[]).includes(id) ? id as ProviderName : null;
}

export function inferProviderForModelId(model: string | null | undefined): ProviderName | null {
  const id = lower(openAIBaseModelForRequest(model));
  if (!id) return null;
  for (const provider of PROVIDERS) {
    if (PROVIDER_METADATA[provider].inferPrefixes.some((prefix) => id.startsWith(prefix))) return provider;
  }
  return null;
}

export function modelMatches(metadata: ModelMetadata, model: string): boolean {
  const id = lower(openAIBaseModelForRequest(model));
  if (!id) return false;
  if (id === lower(metadata.id)) return true;
  if (metadata.aliases?.some((alias) => id === lower(alias))) return true;
  return metadata.match ? new RegExp(metadata.match).test(id) : false;
}

export function modelMetadataFor(provider: ProviderName | null | undefined, model: string | null | undefined): ModelMetadata | null {
  const id = lower(openAIBaseModelForRequest(model));
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
  const id = lower(openAIBaseModelForRequest(model));
  if (!id) return false;
  if (id.startsWith("claude-")) return true;
  if (id.startsWith("qwen")) {
    if (/(?:omni|vl|audio|image|asr|tts|embedding|rerank|long)/.test(id)) return false;
    return /^qwen3(?:[.-]|$)/.test(id) || /^qwen-(?:plus|max|turbo|flash)(?:[-.]|$)/.test(id);
  }
  if (id.startsWith("glm-")) {
    if (/^glm-\d+(?:\.\d+)?v(?:[-.]|$)/.test(id) || /(?:^|[-.])(?:audio|image|asr|tts|embedding|rerank|vision|vl)(?:[-.]|$)/.test(id)) return false;
    return true;
  }
  if (id.startsWith("grok")) return metadata?.capabilities?.toolCalls === true;
  if (id.startsWith("deepseek")) return metadata?.capabilities?.toolCalls === true;
  if (/(?:^|[-.])(?:audio|realtime|image|transcribe|tts|search|embedding|moderation|whisper|dall-e|deep-research)(?:[-.]|$)/.test(id)) return false;
  return /^gpt-5(?:[.-]|$)/.test(id) || /^gpt-4(?:\.1|o)?(?:[.-]|$)/.test(id) || /^o(?:3|4)(?:[.-]|$)/.test(id) || /^chatgpt-/.test(id);
}

export function modelSupportsVision(provider: ProviderName | null | undefined, model: string | null | undefined): boolean {
  const metadata = modelMetadataFor(provider, model);
  if (metadata?.capabilities?.vision != null) return metadata.capabilities.vision;
  const id = lower(openAIBaseModelForRequest(model));
  if (!id) return false;
  if (id.startsWith("deepseek")) return false;
  if (id.startsWith("grok")) return metadata?.capabilities?.vision === true;
  if (id.startsWith("glm-")) return /^glm-\d+(?:\.\d+)?v(?:[-.]|$)/.test(id) || /(?:^|[-.])(?:vision|vl)(?:[-.]|$)/.test(id);
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
