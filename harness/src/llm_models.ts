export type ProviderName = "openai" | "qwen" | "glm" | "anthropic" | "xai" | "deepseek" | "kimi";

export type ModelPrice = {
  /** USD per million regular input tokens. */
  input: number;
  /** USD per million prompt-cache read tokens; omitted when unpublished. */
  cachedInput?: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million prompt-cache write tokens; defaults to `input` when omitted. */
  cacheWriteInput?: number;
  /** Output rate when thinking is enabled, if different from regular output. */
  thinkingOutput?: number;
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
  /** Ascending prompt-size tiers. Thresholds are exclusive unless marked inclusive. */
  contextPricing?: readonly { threshold: number; inclusive?: boolean; pricing: ModelPrice; fastPricing?: ModelPrice }[];
  /** DeepSeek's weekday peak schedule; all other times use these rates. */
  offPeakPricing?: ModelPrice;
  /** Published Fast mode token rates; absent when unavailable. */
  fastPricing?: ModelPrice;
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

// Reviewed 2026-09-16. Sources and pricing scope: docs/model-catalog.md.
export const PROVIDER_METADATA: Record<ProviderName, ProviderMetadata> = {
  openai: {
    id: "openai",
    title: "OpenAI",
    envKey: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.openai.com/v1",
    fallbackModel: "gpt-5.6-sol",
    inferPrefixes: ["gpt-", "o1", "o3", "o4", "chatgpt-", "chat-"],
    models: [
      { id: "gpt-6-astra", match: "^gpt-6-astra(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1050000, pricing: { input: 10, cachedInput: 1, output: 50, cacheWriteInput: 12.5 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000, interfaceContextWindows: { codex: 400000 }, contextPricing: [{ threshold: 272000, pricing: { input: 20, cachedInput: 2, output: 75, cacheWriteInput: 25 }, fastPricing: { input: 40, cachedInput: 4, cacheWriteInput: 50, output: 150 } }], fastPricing: { input: 20, cachedInput: 2, cacheWriteInput: 25, output: 100 } },
      { id: "gpt-5.6-sol", match: "^gpt-5\\.6(?:-sol)?(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?)?$", contextWindow: 1050000, pricing: { input: 4, cachedInput: 0.4, output: 20, cacheWriteInput: 5 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000, interfaceContextWindows: { codex: 400000 }, contextPricing: [{ threshold: 272000, pricing: { input: 8, cachedInput: 0.8, output: 30, cacheWriteInput: 10 }, fastPricing: { input: 16, cachedInput: 1.6, cacheWriteInput: 20, output: 60 } }], aliases: ["gpt-5.6", "gpt-daybreak-blue-latest"], availability: "API and Codex; promotional rates through at least 2026-11-21", fastPricing: { input: 8, cachedInput: 0.8, cacheWriteInput: 10, output: 40 } },
      { id: "gpt-5.6-terra", match: "^gpt-5\\.6-terra(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1050000, pricing: { input: 2, cachedInput: 0.2, output: 12, cacheWriteInput: 2.5 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000, interfaceContextWindows: { codex: 400000 }, contextPricing: [{ threshold: 272000, pricing: { input: 4, cachedInput: 0.4, output: 18, cacheWriteInput: 5 }, fastPricing: { input: 8, cachedInput: 0.8, cacheWriteInput: 10, output: 36 } }], fastPricing: { input: 4, cachedInput: 0.4, cacheWriteInput: 5, output: 24 } },
      { id: "gpt-5.6-luna", match: "^gpt-5\\.6-luna(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1050000, pricing: { input: 0.2, cachedInput: 0.02, output: 1.2, cacheWriteInput: 0.25 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000, interfaceContextWindows: { codex: 400000 }, contextPricing: [{ threshold: 272000, pricing: { input: 0.4, cachedInput: 0.04, output: 1.8, cacheWriteInput: 0.5 }, fastPricing: { input: 0.8, cachedInput: 0.08, cacheWriteInput: 1, output: 3.6 } }], fastPricing: { input: 0.4, cachedInput: 0.04, cacheWriteInput: 0.5, output: 2.4 } },
      { id: "gpt-5.6-cyber", match: "^gpt-5\\.6-cyber(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 400000, pricing: { input: 12.5, cachedInput: 1.25, output: 75, cacheWriteInput: 15.625 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: false, maxOutputTokens: 128000, aliases: ["gpt-daybreak-red-latest"], availability: "Daybreak authorized organizations" },
      { id: "gpt-5.5", match: "^gpt-5\\.5(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1050000, pricing: { input: 5, cachedInput: 0.5, output: 30 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000, interfaceContextWindows: { codex: 400000 }, contextPricing: [{ threshold: 272000, pricing: { input: 10, cachedInput: 1, output: 45 } }], fastPricing: { input: 12.5, cachedInput: 1.25, output: 75 } },
      { id: "gpt-5.5-pro", match: "^gpt-5\\.5-pro(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1050000, pricing: { input: 30, output: 180 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000, interfaceContextWindows: { codex: 400000 }, contextPricing: [{ threshold: 272000, pricing: { input: 60, output: 270 } }] },
      { id: "gpt-5.4", match: "^gpt-5\\.4(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1050000, pricing: { input: 2.5, cachedInput: 0.25, output: 15 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000, interfaceContextWindows: { codex: 400000 }, contextPricing: [{ threshold: 272000, pricing: { input: 5, cachedInput: 0.5, output: 22.5 } }], fastPricing: { input: 5, cachedInput: 0.5, output: 30 } },
      { id: "gpt-5.4-mini", match: "^gpt-5\\.4-mini(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 400000, pricing: { input: 0.75, cachedInput: 0.075, output: 4.5 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000, interfaceContextWindows: { codex: 400000 }, fastPricing: { input: 1.5, cachedInput: 0.15, output: 9 } },
      { id: "gpt-5.4-nano", match: "^gpt-5\\.4-nano(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 400000, pricing: { input: 0.2, cachedInput: 0.02, output: 1.25 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000, interfaceContextWindows: { codex: 400000 } },
      { id: "gpt-5.4-pro", match: "^gpt-5\\.4-pro(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1050000, pricing: { input: 30, output: 180 }, capabilities: { toolCalls: true, structuredOutputs: false, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000, interfaceContextWindows: { codex: 400000 }, contextPricing: [{ threshold: 272000, pricing: { input: 60, output: 270 } }] },
      { id: "gpt-5.3-codex", match: "^gpt-5\\.3-codex(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 400000, pricing: { input: 1.75, cachedInput: 0.175, output: 14 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000 },
      { id: "gpt-5.2", match: "^gpt-5\\.2(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 400000, pricing: { input: 1.75, cachedInput: 0.175, output: 14 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000, fastPricing: { input: 3.5, cachedInput: 0.35, output: 28 } },
      { id: "gpt-5.2-codex", match: "^gpt-5\\.2-codex(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 400000, pricing: { input: 1.75, cachedInput: 0.175, output: 14 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000 },
      { id: "gpt-5.2-pro", match: "^gpt-5\\.2-pro(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 400000, pricing: { input: 21, output: 168 }, capabilities: { toolCalls: true, structuredOutputs: false, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000 },
      { id: "gpt-5.1", match: "^gpt-5\\.1(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 400000, pricing: { input: 1.25, cachedInput: 0.125, output: 10 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000, fastPricing: { input: 2.5, cachedInput: 0.25, output: 20 } },
      { id: "gpt-5.1-codex", match: "^gpt-5\\.1-codex(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 400000, pricing: { input: 1.25, cachedInput: 0.125, output: 10 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000 },
      { id: "gpt-5.1-codex-max", match: "^gpt-5\\.1-codex-max(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 400000, pricing: { input: 1.25, cachedInput: 0.125, output: 10 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000 },
      { id: "gpt-5.1-codex-mini", match: "^gpt-5\\.1-codex-mini(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 400000, pricing: { input: 0.25, cachedInput: 0.025, output: 2 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000 },
      { id: "gpt-5", match: "^gpt-5(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 400000, pricing: { input: 1.25, cachedInput: 0.125, output: 10 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000, fastPricing: { input: 2.5, cachedInput: 0.25, output: 20 } },
      { id: "gpt-5-mini", match: "^gpt-5-mini(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 400000, pricing: { input: 0.25, cachedInput: 0.025, output: 2 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000, fastPricing: { input: 0.45, cachedInput: 0.045, output: 3.6 } },
      { id: "gpt-5-nano", match: "^gpt-5-nano(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 400000, pricing: { input: 0.05, cachedInput: 0.005, output: 0.4 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000 },
      { id: "gpt-5-codex", match: "^gpt-5-codex(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 400000, pricing: { input: 1.25, cachedInput: 0.125, output: 10 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000 },
      { id: "gpt-5-pro", match: "^gpt-5-pro(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 400000, pricing: { input: 15, output: 120 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 272000 },
      { id: "gpt-4.1", match: "^gpt-4\\.1(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1047576, pricing: { input: 2, cachedInput: 0.5, output: 8 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: false, vision: true }, defaultOption: true, maxOutputTokens: 32768, fastPricing: { input: 3.5, cachedInput: 0.875, output: 14 } },
      { id: "gpt-4.1-mini", match: "^gpt-4\\.1-mini(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1047576, pricing: { input: 0.4, cachedInput: 0.1, output: 1.6 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: false, vision: true }, defaultOption: true, maxOutputTokens: 32768, fastPricing: { input: 0.7, cachedInput: 0.175, output: 2.8 } },
      { id: "gpt-4.1-nano", match: "^gpt-4\\.1-nano(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1047576, pricing: { input: 0.1, cachedInput: 0.025, output: 0.4 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: false, vision: true }, defaultOption: true, maxOutputTokens: 32768, fastPricing: { input: 0.2, cachedInput: 0.05, output: 0.8 } },
      { id: "gpt-4o", match: "^gpt-4o(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 128000, pricing: { input: 2.5, cachedInput: 1.25, output: 10 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: false, vision: true }, defaultOption: true, maxOutputTokens: 16384, fastPricing: { input: 4.25, cachedInput: 2.125, output: 17 } },
      { id: "gpt-4o-mini", match: "^gpt-4o-mini(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 128000, pricing: { input: 0.15, cachedInput: 0.075, output: 0.6 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: false, vision: true }, defaultOption: true, maxOutputTokens: 16384, fastPricing: { input: 0.25, cachedInput: 0.125, output: 1 } },
      { id: "o3", match: "^o3(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 200000, pricing: { input: 2, cachedInput: 0.5, output: 8 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 100000, fastPricing: { input: 3.5, cachedInput: 0.875, output: 14 } },
      { id: "o3-mini", match: "^o3-mini(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 200000, pricing: { input: 1.1, cachedInput: 0.55, output: 4.4 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: false }, defaultOption: true, maxOutputTokens: 100000 },
      { id: "o3-pro", match: "^o3-pro(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 200000, pricing: { input: 20, output: 80 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 100000 },
      { id: "o4-mini", match: "^o4-mini(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 200000, pricing: { input: 1.1, cachedInput: 0.275, output: 4.4 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 100000, fastPricing: { input: 2, cachedInput: 0.5, output: 8 } },
      { id: "chat-latest", match: "^chat-latest(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 400000, pricing: { input: 5, cachedInput: 0.5, output: 30 }, capabilities: { toolCalls: false, vision: true }, defaultOption: false, maxOutputTokens: 128000 },
      { id: "gpt-4o-2024-05-13", contextWindow: 128000, pricing: { input: 5, output: 15 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: false, vision: true }, defaultOption: false, maxOutputTokens: 4096, fastPricing: { input: 8.75, output: 26.25 } },
    ],
  },
  anthropic: {
    id: "anthropic",
    title: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    fallbackModel: "claude-opus-5",
    inferPrefixes: ["claude"],
    models: [
      { id: "claude-fable-5-1", match: "^claude-fable-5[.-]1(?:-\\d{8})?$", contextWindow: 1000000, pricing: { input: 10, cachedInput: 0.25, output: 50, cacheWriteInput: 12.5 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000 },
      { id: "claude-sonnet-5", match: "^claude-sonnet-5(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 2, cachedInput: 0.2, output: 10, cacheWriteInput: 2.5 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000 },
      { id: "claude-mythos-5-1", match: "^claude-mythos-5[.-]1(?:-\\d{8})?$", contextWindow: 1000000, pricing: { input: 10, cachedInput: 0.25, output: 50, cacheWriteInput: 12.5 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: false, maxOutputTokens: 128000, availability: "Project Glasswing invitation only" },
      { id: "claude-mythos-5", match: "^claude-mythos-5(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 10, cachedInput: 1, output: 50, cacheWriteInput: 12.5 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: false, maxOutputTokens: 128000, availability: "Project Glasswing invitation only" },
      { id: "claude-fable-5", match: "^claude-fable-5(?:-\\d{8})?$", contextWindow: 1000000, maxOutputTokens: 128000, pricing: { input: 10, cachedInput: 1, cacheWriteInput: 12.5, output: 50 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "claude-opus-5", match: "^claude-opus-5(?:-\\d{8})?$", contextWindow: 1000000, maxOutputTokens: 128000, pricing: { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 25 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "claude-opus-4", match: "^claude-opus-4(?:-\\d{8})?$", contextWindow: 200000, maxOutputTokens: 32000, pricing: { input: 15, cachedInput: 1.5, cacheWriteInput: 18.75, output: 75 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: false, availability: "Retired on the direct Claude API" },
      { id: "claude-sonnet-4", match: "^claude-sonnet-4(?:-\\d{8})?$", contextWindow: 200000, maxOutputTokens: 64000, pricing: { input: 3, cachedInput: 0.3, cacheWriteInput: 3.75, output: 15 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: false, availability: "Retired on the direct Claude API" },
      { id: "claude-opus-4-8", match: "^claude-opus-4[.-]8(?:-\\d{8})?$", contextWindow: 1000000, maxOutputTokens: 128000, pricing: { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 25 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "claude-opus-4-7", match: "^claude-opus-4[.-]7(?:-\\d{8})?$", contextWindow: 1000000, maxOutputTokens: 128000, pricing: { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 25 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "claude-opus-4-6", match: "^claude-opus-4[.-]6(?:-\\d{8})?$", contextWindow: 1000000, maxOutputTokens: 128000, pricing: { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 25 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "claude-sonnet-4-6", match: "^claude-sonnet-4[.-]6(?:-\\d{8})?$", contextWindow: 1000000, maxOutputTokens: 64000, pricing: { input: 3, cachedInput: 0.3, cacheWriteInput: 3.75, output: 15 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "claude-opus-4-5", match: "^claude-opus-4[.-]5(?:-\\d{8})?$", contextWindow: 200000, maxOutputTokens: 64000, pricing: { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 25 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "claude-sonnet-4-5", match: "^claude-sonnet-4[.-]5(?:-\\d{8})?$", contextWindow: 200000, maxOutputTokens: 64000, pricing: { input: 3, cachedInput: 0.3, cacheWriteInput: 3.75, output: 15 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "claude-haiku-4-5", match: "^claude-haiku-4[.-]5(?:-\\d{8})?$", contextWindow: 200000, maxOutputTokens: 64000, pricing: { input: 1, cachedInput: 0.1, cacheWriteInput: 1.25, output: 5 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "claude-opus-4-1", match: "^claude-opus-4[.-]1(?:-\\d{8})?$", contextWindow: 200000, maxOutputTokens: 32000, pricing: { input: 15, cachedInput: 1.5, cacheWriteInput: 18.75, output: 75 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: false, availability: "Retired on the direct Claude API" },
    ],
  },
  qwen: {
    id: "qwen",
    title: "Qwen",
    envKey: "QWEN_API_KEY",
    envAltKeys: ["DASHSCOPE_API_KEY"],
    baseUrlEnv: "QWEN_BASE_URL",
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    fallbackModel: "qwen3.8-max",
    inferPrefixes: ["qwen"],
    models: [
      { id: "qwen3.8-max", match: "^qwen3\\.8-max(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 2, output: 6, cachedInput: 0.25, cacheWriteInput: 2.5 }, capabilities: { toolCalls: true, reasoning: true, structuredOutputs: true, vision: true }, maxOutputTokens: 131072, defaultOption: true, aliases: ["qwen3.8-max-0902", "qwen3.8-max-2026-09-02"] },
      { id: "qwen3.8-flash", match: "^qwen3\\.8-flash(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 0.15, output: 0.47, cachedInput: 0.016, cacheWriteInput: 0.2 }, capabilities: { toolCalls: true, reasoning: true, structuredOutputs: true, vision: true }, maxOutputTokens: 131072, defaultOption: true },
      { id: "qwen3.8-2.4t-a95b", match: "^qwen3\\.8-2\\.4t-a95b(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 2, output: 6, cachedInput: 0.25, cacheWriteInput: 2.5 }, capabilities: { toolCalls: true, reasoning: true, structuredOutputs: true, vision: true }, maxOutputTokens: 131072, defaultOption: true },
      { id: "qwen3.8-27b", match: "^qwen3\\.8-27b(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 0.5, output: 3, cachedInput: 0.1, cacheWriteInput: 0.625 }, capabilities: { toolCalls: true, reasoning: true, structuredOutputs: true, vision: true }, maxOutputTokens: 131072, defaultOption: true },
      { id: "qwen3.7-max", match: "^qwen3\\.7-max(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 2.5, cachedInput: 0.5, output: 7.5 }, capabilities: { toolCalls: true, reasoning: true, vision: false }, defaultOption: true },
      { id: "qwen3.7-plus", match: "^qwen3\\.7-plus(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 0.4, cachedInput: 0.08, output: 1.6 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true, contextPricing: [{ threshold: 256000, pricing: { input: 1.2, cachedInput: 0.24, output: 4.8 } }], availability: "International/Singapore list price; temporary discounts may apply" },
      { id: "qwen3.7-flash", match: "^qwen3\\.7-flash(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 0.03, cachedInput: 0.006, output: 0.13 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true, contextPricing: [{ threshold: 32000, pricing: { input: 0.1, cachedInput: 0.02, output: 0.4 } }, { threshold: 256000, pricing: { input: 0.2, cachedInput: 0.04, output: 0.8 } }] },
      { id: "qwen3.6-max-preview", match: "^qwen3\\.6-max-preview(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 262144, pricing: { input: 1.3, cachedInput: 0.26, output: 7.8 }, capabilities: { toolCalls: true, reasoning: true, vision: false }, defaultOption: true, contextPricing: [{ threshold: 128000, pricing: { input: 2, cachedInput: 0.4, output: 12 } }] },
      { id: "qwen3.6-plus", match: "^qwen3\\.6-plus(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 0.5, cachedInput: 0.1, output: 3 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true, contextPricing: [{ threshold: 256000, pricing: { input: 2, cachedInput: 0.4, output: 6 } }] },
      { id: "qwen3.6-flash", match: "^qwen3\\.6-flash(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 0.25, cachedInput: 0.05, output: 1.5 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true, contextPricing: [{ threshold: 256000, pricing: { input: 1, cachedInput: 0.2, output: 4 } }] },
      { id: "qwen3.5-plus", match: "^qwen3\\.5-plus(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 0.4, cachedInput: 0.08, output: 2.4 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true, contextPricing: [{ threshold: 256000, pricing: { input: 0.5, cachedInput: 0.1, output: 3 } }] },
      { id: "qwen3.5-flash", match: "^qwen3\\.5-flash(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 0.1, cachedInput: 0.02, output: 0.4 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "qwen3-max", match: "^qwen3-max(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 262144, pricing: { input: 1.2, cachedInput: 0.24, output: 6 }, capabilities: { toolCalls: true, reasoning: true, vision: false }, defaultOption: true, contextPricing: [{ threshold: 32000, pricing: { input: 2.4, cachedInput: 0.48, output: 12 } }, { threshold: 128000, pricing: { input: 3, cachedInput: 0.6, output: 15 } }] },
      { id: "qwen3-coder-plus", match: "^qwen3-coder-plus(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 1, cachedInput: 0.2, output: 5 }, capabilities: { toolCalls: true, reasoning: false, vision: false }, defaultOption: true, contextPricing: [{ threshold: 32000, pricing: { input: 1.8, cachedInput: 0.36, output: 9 } }, { threshold: 128000, pricing: { input: 3, cachedInput: 0.6, output: 15 } }, { threshold: 256000, pricing: { input: 6, cachedInput: 1.2, output: 60 } }] },
      { id: "qwen3-coder-flash", match: "^qwen3-coder-flash(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 0.3, cachedInput: 0.06, output: 1.5 }, capabilities: { toolCalls: true, reasoning: false, vision: false }, defaultOption: true, contextPricing: [{ threshold: 32000, pricing: { input: 0.5, cachedInput: 0.1, output: 2.5 } }, { threshold: 128000, pricing: { input: 0.8, cachedInput: 0.16, output: 4 } }, { threshold: 256000, pricing: { input: 1.6, cachedInput: 0.32, output: 9.6 } }] },
      { id: "qwen3-coder-next", match: "^qwen3-coder-next(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 262144, pricing: { input: 0.3, output: 1.5 }, capabilities: { toolCalls: true, reasoning: false, vision: false }, defaultOption: true, contextPricing: [{ threshold: 32000, pricing: { input: 0.5, output: 2.5 } }, { threshold: 128000, pricing: { input: 0.8, output: 4 } }] },
      { id: "qwen3-coder-480b-a35b-instruct", match: "^qwen3-coder-480b-a35b-instruct(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 262144, pricing: { input: 1.5, output: 7.5 }, capabilities: { toolCalls: true, reasoning: false, vision: false }, defaultOption: true, contextPricing: [{ threshold: 32000, pricing: { input: 2.7, output: 13.5 } }, { threshold: 128000, pricing: { input: 4.5, output: 22.5 } }] },
      { id: "qwen3-coder-30b-a3b-instruct", match: "^qwen3-coder-30b-a3b-instruct(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 262144, pricing: { input: 0.45, output: 2.25 }, capabilities: { toolCalls: true, reasoning: false, vision: false }, defaultOption: true, contextPricing: [{ threshold: 32000, pricing: { input: 0.75, output: 3.75 } }, { threshold: 128000, pricing: { input: 1.2, output: 6 } }] },
      { id: "qwen3.6-35b-a3b", match: "^qwen3\\.6-35b-a3b(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 262144, pricing: { input: 0.375, output: 2.25 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "qwen3.6-27b", match: "^qwen3\\.6-27b(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 262144, pricing: { input: 0.6, output: 3.6 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "qwen3.5-397b-a17b", match: "^qwen3\\.5-397b-a17b(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 262144, pricing: { input: 0.6, output: 3.6 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "qwen3.5-122b-a10b", match: "^qwen3\\.5-122b-a10b(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 262144, pricing: { input: 0.4, output: 3.2 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "qwen3.5-27b", match: "^qwen3\\.5-27b(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 262144, pricing: { input: 0.3, output: 2.4 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "qwen3.5-35b-a3b", match: "^qwen3\\.5-35b-a3b(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 262144, pricing: { input: 0.25, output: 2 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "qwen3-next-80b-a3b-thinking", match: "^qwen3-next-80b-a3b-thinking(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 262144, pricing: { input: 0.15, output: 1.2 }, capabilities: { toolCalls: true, reasoning: true, vision: false }, defaultOption: true },
      { id: "qwen3-next-80b-a3b-instruct", match: "^qwen3-next-80b-a3b-instruct(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 262144, pricing: { input: 0.15, output: 1.2 }, capabilities: { toolCalls: true, reasoning: false, vision: false }, defaultOption: true },
      { id: "qwen3-235b-a22b-thinking-2507", match: "^qwen3-235b-a22b-thinking-2507(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 262144, pricing: { input: 0.23, output: 2.3 }, capabilities: { toolCalls: true, reasoning: true, vision: false }, defaultOption: true },
      { id: "qwen3-235b-a22b-instruct-2507", match: "^qwen3-235b-a22b-instruct-2507(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 262144, pricing: { input: 0.23, output: 0.92 }, capabilities: { toolCalls: true, reasoning: false, vision: false }, defaultOption: true },
      { id: "qwen3-30b-a3b-thinking-2507", match: "^qwen3-30b-a3b-thinking-2507(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 262144, pricing: { input: 0.2, output: 2.4 }, capabilities: { toolCalls: true, reasoning: true, vision: false }, defaultOption: true },
      { id: "qwen3-30b-a3b-instruct-2507", match: "^qwen3-30b-a3b-instruct-2507(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 262144, pricing: { input: 0.2, output: 0.8 }, capabilities: { toolCalls: true, reasoning: false, vision: false }, defaultOption: true },
      { id: "qwen-plus", match: "^qwen-plus(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 0.4, cachedInput: 0.08, output: 1.2, thinkingOutput: 4 }, capabilities: { toolCalls: true, reasoning: true, vision: false }, defaultOption: true, contextPricing: [{ threshold: 256000, pricing: { input: 1.2, cachedInput: 0.24, output: 3.6, thinkingOutput: 12 } }], aliases: ["qwen-plus-latest"] },
      { id: "qwen-max", match: "^qwen-max(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 32768, pricing: { input: 1.6, output: 6.4 }, capabilities: { toolCalls: true }, defaultOption: true, aliases: ["qwen-max-latest"] },
      { id: "qwen-turbo", match: "^qwen-turbo(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 0.05, output: 0.2, thinkingOutput: 0.5 }, capabilities: { toolCalls: true, reasoning: true, vision: false }, defaultOption: true, aliases: ["qwen-turbo-latest"] },
      { id: "qwen-flash", match: "^qwen-flash(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 0.05, cachedInput: 0.01, output: 0.4 }, capabilities: { toolCalls: true, reasoning: true, vision: false }, defaultOption: true, contextPricing: [{ threshold: 256000, pricing: { input: 0.25, cachedInput: 0.05, output: 2 } }] },
      { id: "qwen3-vl-plus", match: "^qwen3-vl-plus(?:-\\d{4}-\\d{2}-\\d{2})?$", contextWindow: 262144, maxOutputTokens: 32768, pricing: { input: 0.2, cachedInput: 0.04, output: 1.6 }, contextPricing: [{ threshold: 32000, pricing: { input: 0.3, cachedInput: 0.06, output: 2.4 } }, { threshold: 128000, pricing: { input: 0.6, cachedInput: 0.12, output: 4.8 } }], capabilities: { toolCalls: false, reasoning: true, vision: true, structuredOutputs: true }, defaultOption: false, availability: "Function calling unavailable on the International/Singapore endpoint" },
      { id: "qwen3-vl-flash", match: "^qwen3-vl-flash(?:-\\d{4}-\\d{2}-\\d{2})?$", contextWindow: 262144, maxOutputTokens: 32768, pricing: { input: 0.05, cachedInput: 0.01, output: 0.4 }, contextPricing: [{ threshold: 32000, pricing: { input: 0.075, cachedInput: 0.015, output: 0.6 } }, { threshold: 128000, pricing: { input: 0.12, cachedInput: 0.024, output: 0.96 } }], capabilities: { toolCalls: false, reasoning: true, vision: true, structuredOutputs: true }, defaultOption: false, availability: "Function calling unavailable on the International/Singapore endpoint" },
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
    fallbackModel: "glm-5.3",
    inferPrefixes: ["glm-"],
    variants: [
      { id: "platform", title: "Z.ai API Platform", baseUrl: "https://api.z.ai/api/paas/v4", fallbackModel: "glm-5.3" },
      { id: "coding", title: "Z.ai Coding Plan", baseUrl: "https://api.z.ai/api/coding/paas/v4", fallbackModel: "glm-5.3" },
    ],
    models: [
      { id: "glm-5.3", match: "^glm-5\\.3(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true }, defaultOption: true, maxOutputTokens: 128000 },
      { id: "glm-5.3-flash", match: "^glm-5\\.3-flash(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 0.15, cachedInput: 0.03, output: 0.5 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, maxOutputTokens: 128000 },
      { id: "glm-5.2", match: "^glm-5\\.2(?:[-.]|$)", contextWindow: 1000000, maxOutputTokens: 128000, pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true }, defaultOption: true },
      { id: "glm-5.1", match: "^glm-5\\.1(?:[-.]|$)", contextWindow: 200000, maxOutputTokens: 128000, pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-5-turbo", match: "^glm-5-turbo(?:[-.]|$)", contextWindow: 200000, maxOutputTokens: 128000, pricing: { input: 1.2, cachedInput: 0.24, output: 4 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-5", match: "^glm-5(?:[-.]|$)", contextWindow: 200000, maxOutputTokens: 128000, pricing: { input: 1, cachedInput: 0.2, output: 3.2 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.7-flashx", match: "^glm-4\\.7-flashx(?:[-.]|$)", contextWindow: 200000, maxOutputTokens: 128000, pricing: { input: 0.07, cachedInput: 0.01, output: 0.4 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.7-flash", match: "^glm-4\\.7-flash(?:[-.]|$)", contextWindow: 200000, maxOutputTokens: 128000, pricing: { input: 0, cachedInput: 0, output: 0 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.7", match: "^glm-4\\.7(?:[-.]|$)", contextWindow: 200000, maxOutputTokens: 128000, pricing: { input: 0.6, cachedInput: 0.11, output: 2.2 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.6", match: "^glm-4\\.6(?:[-.]|$)", contextWindow: 200000, maxOutputTokens: 128000, pricing: { input: 0.6, cachedInput: 0.11, output: 2.2 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.5-x", match: "^glm-4\\.5-x(?:[-.]|$)", contextWindow: 128000, maxOutputTokens: 96000, pricing: { input: 2.2, cachedInput: 0.45, output: 8.9 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.5-airx", match: "^glm-4\\.5-airx(?:[-.]|$)", contextWindow: 128000, maxOutputTokens: 96000, pricing: { input: 1.1, cachedInput: 0.22, output: 4.5 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.5-air", match: "^glm-4\\.5-air(?:[-.]|$)", contextWindow: 128000, maxOutputTokens: 96000, pricing: { input: 0.2, cachedInput: 0.03, output: 1.1 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.5-flash", match: "^glm-4\\.5-flash(?:[-.]|$)", contextWindow: 128000, maxOutputTokens: 96000, pricing: { input: 0, cachedInput: 0, output: 0 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.5", match: "^glm-4\\.5(?:[-.]|$)", contextWindow: 128000, maxOutputTokens: 96000, pricing: { input: 0.6, cachedInput: 0.11, output: 2.2 }, capabilities: { toolCalls: true, reasoning: true }, defaultOption: true },
      { id: "glm-4.6v", match: "^glm-4\\.6v(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 128000, pricing: { input: 0.3, cachedInput: 0.05, output: 0.9 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "glm-4.6v-flashx", match: "^glm-4\\.6v-flashx(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 128000, pricing: { input: 0.04, cachedInput: 0.004, output: 0.4 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "glm-4.6v-flash", match: "^glm-4\\.6v-flash(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 128000, pricing: { input: 0, cachedInput: 0, output: 0 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
    ],
  },
  xai: {
    id: "xai",
    title: "xAI",
    envKey: "XAI_API_KEY",
    envAltKeys: ["GROK_API_KEY"],
    baseUrlEnv: "XAI_BASE_URL",
    defaultBaseUrl: "https://api.x.ai/v1",
    fallbackModel: "grok-4.6",
    inferPrefixes: ["grok"],
    models: [
      { id: "grok-4.6", match: "^grok-4\\.6(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 500000, pricing: { input: 2, cachedInput: 0.5, output: 6 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, contextPricing: [{ threshold: 200000, pricing: { input: 4, cachedInput: 1, output: 12 }, inclusive: true }] },
      { id: "grok-build-0.1", match: "^grok-build-0\\.1(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 256000, pricing: { input: 1, cachedInput: 0.2, output: 2 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, contextPricing: [{ threshold: 200000, pricing: { input: 2, cachedInput: 0.4, output: 4 }, inclusive: true }], aliases: ["grok-code-fast-1"] },
      { id: "grok-4.5", match: "^grok-4\\.5(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 500000, pricing: { input: 2, cachedInput: 0.3, output: 6 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, contextPricing: [{ threshold: 200000, pricing: { input: 4, cachedInput: 0.6, output: 12 }, inclusive: true }] },
      { id: "grok-4.3", match: "^grok-4\\.3(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 1.25, cachedInput: 0.2, output: 2.5 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, contextPricing: [{ threshold: 200000, pricing: { input: 2.5, cachedInput: 0.4, output: 5 }, inclusive: true }], aliases: ["grok-4-fast", "grok-4-fast-reasoning", "grok-4-fast-reasoning-latest", "grok-4-fast-non-reasoning", "grok-4-1-fast-reasoning", "grok-4-1-fast-non-reasoning", "grok-4-0709", "grok-3"] },
      { id: "grok-4.20-0309-reasoning", match: "^grok-4\\.20-0309-reasoning(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 1.25, cachedInput: 0.2, output: 2.5 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, contextPricing: [{ threshold: 200000, pricing: { input: 2.5, cachedInput: 0.4, output: 5 }, inclusive: true }] },
      { id: "grok-4.20-0309-non-reasoning", match: "^grok-4\\.20-0309-non-reasoning(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 1.25, cachedInput: 0.2, output: 2.5 }, capabilities: { toolCalls: true, structuredOutputs: true, vision: true }, defaultOption: true, contextPricing: [{ threshold: 200000, pricing: { input: 2.5, cachedInput: 0.4, output: 5 }, inclusive: true }] },
      { id: "grok-4.20-multi-agent-0309", match: "^grok-4\\.20-multi-agent-0309(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 1.25, cachedInput: 0.2, output: 2.5 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: false, contextPricing: [{ threshold: 200000, pricing: { input: 2.5, cachedInput: 0.4, output: 5 }, inclusive: true }], availability: "Requires the xAI server-side multi-agent API" },
    ],
  },
  deepseek: {
    id: "deepseek",
    title: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    defaultBaseUrl: "https://api.deepseek.com",
    fallbackModel: "deepseek-flash",
    inferPrefixes: ["deepseek"],
    models: [
      { id: "deepseek-flash", match: "^deepseek-flash(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 0.3, cachedInput: 0.006, output: 1.2 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, aliases: ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4.1-flash"], maxOutputTokens: 384000, offPeakPricing: { input: 0.15, cachedInput: 0.003, output: 0.6 } },
      { id: "deepseek-v4-pro", match: "^deepseek-v4-pro(?:-\\d{4}(?:-\\d{2}(?:-\\d{2})?)?|-latest)?$", contextWindow: 1000000, pricing: { input: 1.32, cachedInput: 0.044, output: 3.96 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true }, defaultOption: true, maxOutputTokens: 384000, offPeakPricing: { input: 0.66, cachedInput: 0.022, output: 1.98 } },
      { id: "deepseek-chat", aliases: ["deepseek-reasoner"], availability: "Retired compatibility names; use deepseek-flash", capabilities: { toolCalls: true, reasoning: true } },
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
    variants: [{id: "platform", title: "Moonshot Platform", baseUrl: "https://api.moonshot.ai/v1", fallbackModel: "kimi-k3"}, {id: "code", title: "Kimi Code", baseUrl: "https://api.kimi.com/coding/v1", fallbackModel: "kimi-for-coding"}],
    models: [
      { id: "kimi-k3", match: "^kimi-k3(?:[-.]|$)", contextWindow: 1048576, maxOutputTokens: 1048576, pricing: { input: 3, cachedInput: 0.3, output: 15 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true, availability: "API access after top-up; low,   high,   and max reasoning" },
      { id: "kimi-for-coding", match: "^kimi-for-coding(?:[-.]|$)", contextWindow: 262144, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, availability: "Kimi Code subscription; no per-token API price" },
      { id: "kimi-k2.7-code-highspeed", match: "^kimi-k2\\.7-code-highspeed(?:[-.]|$)", contextWindow: 262144, pricing: { input: 1.9, cachedInput: 0.38, output: 8 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "kimi-k2.7-code", aliases: ["kimi-k2.7"], match: "^kimi-k2\\.7(?:-code)?(?:[-.]|$)", contextWindow: 262144, pricing: { input: 0.95, cachedInput: 0.19, output: 4 }, capabilities: { toolCalls: true, structuredOutputs: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "kimi-k2.6", match: "^kimi-k2\\.6(?:[-.]|$)", contextWindow: 262144, pricing: { input: 0.95, cachedInput: 0.16, output: 4 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "kimi-k2.5", match: "^kimi-k2\\.5(?:[-.]|$)", contextWindow: 262144, pricing: { input: 0.6, cachedInput: 0.1, output: 3 }, capabilities: { toolCalls: true, reasoning: true, vision: true }, defaultOption: true },
      { id: "moonshot-v1-128k", match: "^moonshot-v1-128k(?:[-.]|$)", contextWindow: 131072, pricing: { input: 2, cachedInput: 2, output: 5 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "moonshot-v1-32k", match: "^moonshot-v1-32k(?:[-.]|$)", contextWindow: 32768, pricing: { input: 1, cachedInput: 1, output: 3 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "moonshot-v1-8k", match: "^moonshot-v1-8k(?:[-.]|$)", contextWindow: 8192, pricing: { input: 0.2, cachedInput: 0.2, output: 2 }, capabilities: { toolCalls: true }, defaultOption: true },
      { id: "moonshot-v1-128k-vision-preview", contextWindow: 131072, pricing: { input: 2, cachedInput: 2, output: 5 }, capabilities: { vision: true }, defaultOption: true },
      { id: "moonshot-v1-32k-vision-preview", contextWindow: 32768, pricing: { input: 1, cachedInput: 1, output: 3 }, capabilities: { vision: true }, defaultOption: true },
      { id: "moonshot-v1-8k-vision-preview", contextWindow: 8192, pricing: { input: 0.2, cachedInput: 0.2, output: 2 }, capabilities: { vision: true }, defaultOption: true },
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

function isOpenAITextModelId(model: string | null | undefined): boolean {
  return /^(?:gpt-|o[134](?:-|$))/.test(lower(model));
}

export function openAIBaseModelForRequest(model: string | null | undefined): string {
  const trimmed = String(model ?? "").trim();
  const suffix = OPENAI_FAST_MODEL_SUFFIX;
  if (!trimmed.toLowerCase().endsWith(suffix)) return trimmed;
  const base = trimmed.slice(0, -suffix.length).trim();
  return isOpenAITextModelId(base) ? base : trimmed;
}

export function openAIServiceTierForModel(model: string | null | undefined): typeof OPENAI_FAST_SERVICE_TIER | null {
  const trimmed = String(model ?? "").trim();
  if (!trimmed.toLowerCase().endsWith(OPENAI_FAST_MODEL_SUFFIX)) return null;
  const base = openAIBaseModelForRequest(trimmed);
  return base !== trimmed && isOpenAITextModelId(base) ? OPENAI_FAST_SERVICE_TIER : null;
}

export function openAIFastModelId(model: string | null | undefined): string {
  return openAIBaseModelForRequest(model) + OPENAI_FAST_MODEL_SUFFIX;
}

export function modelSupportsOpenAIFastMode(provider: ProviderName | null | undefined, model: string | null | undefined): boolean {
  if (provider && provider !== "openai") return false;
  return modelMetadataFor("openai", model)?.fastPricing != null;
}

export function normalizeProvider(value: unknown): ProviderName | null {
  const id = lower(String(value ?? ""));
  return (PROVIDERS as readonly string[]).includes(id) ? id as ProviderName : null;
}

// Normalize only the known GLM namespace for local capability/effort lookups.
// The original slug must still be sent unchanged to the gateway.
export function glmModelBaseId(model: string | null | undefined): string {
  const id = lower(String(model ?? ""));
  return id.replace(/^z-ai\/(?=glm-)/, "");
}

export function inferProviderForModelId(model: string | null | undefined): ProviderName | null {
  const id = glmModelBaseId(openAIBaseModelForRequest(model));
  if (!id) return null;
  for (const provider of PROVIDERS) {
    if (PROVIDER_METADATA[provider].inferPrefixes.some((prefix) => id.startsWith(prefix))) return provider;
  }
  return null;
}

export function modelMatches(metadata: ModelMetadata, model: string): boolean {
  const id = glmModelBaseId(openAIBaseModelForRequest(model));
  if (!id) return false;
  if (id === lower(metadata.id)) return true;
  if (metadata.aliases?.some((alias) => id === lower(alias))) return true;
  return metadata.match ? new RegExp(metadata.match).test(id) : false;
}

export function modelMetadataFor(provider: ProviderName | null | undefined, model: string | null | undefined): ModelMetadata | null {
  const id = glmModelBaseId(openAIBaseModelForRequest(model));
  if (!id) return null;
  const providers = provider ? [provider] : PROVIDERS;
  // Exact IDs and aliases must beat a longer, overlapping version pattern.
  for (const providerId of providers) {
    const exact = PROVIDER_METADATA[providerId].models.find((metadata) =>
      lower(metadata.id) === id || metadata.aliases?.some((alias) => lower(alias) === id));
    if (exact) return exact;
  }
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
  if (!metadata?.contextPricing) return null;
  let key: string | null = null;
  metadata.contextPricing.forEach((tier, index) => {
    if (tier.inclusive ? promptTokens >= tier.threshold : promptTokens > tier.threshold)
      key = metadata.id + contextPriceSuffix(tier.threshold, index);
  });
  return key;
}

function contextPriceSuffix(threshold: number, index: number): string {
  return index === 0 ? "#long-context" : "#long-context-" + threshold;
}

export function modelUsagePricingKey(
  model: string,
  promptTokens: number,
  options: { at: number; thinking?: boolean; serviceTier?: string | null },
): string {
  const base = openAIBaseModelForRequest(model);
  const metadata = modelMetadataFor(null, base);
  let key = modelLongContextUsageKey(base, promptTokens) || base;
  if (metadata?.offPeakPricing) {
    const date = new Date(options.at);
    const day = date.getUTCDay();
    const hour = date.getUTCHours();
    const peak = day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
    key = metadata.id + (peak ? "" : "#off-peak");
  }
  if (options.thinking && (metadata?.pricing?.thinkingOutput != null || metadata?.contextPricing?.some((tier) => tier.pricing.thinkingOutput != null)))
    key += "#thinking";
  if (openAIServiceTierForModel(model) || options.serviceTier === "priority" || options.serviceTier === "fast") key += "#fast";
  return key;
}

export function defaultModelPricing(): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {};
  for (const provider of PROVIDERS) {
    for (const model of PROVIDER_METADATA[provider].models) {
      const add = (suffix: string, price: ModelPrice, fastPricing?: ModelPrice) => {
        const { thinkingOutput, ...regular } = price;
        for (const id of [model.id, ...(model.aliases ?? [])]) {
          const variants = [[suffix, regular]] as [string, ModelPrice][];
          if (thinkingOutput != null) variants.push([suffix + "#thinking", { ...regular, output: thinkingOutput }]);
          for (const [variant, rate] of variants) {
            out[id + variant] = rate;
            if (fastPricing) out[id + variant + "#fast"] = fastPricing;
          }
        }
      };
      if (model.pricing) add("", model.pricing, model.fastPricing);
      model.contextPricing?.forEach((tier, index) => add(contextPriceSuffix(tier.threshold, index), tier.pricing, tier.fastPricing));
      if (model.offPeakPricing) add("#off-peak", model.offPeakPricing);
    }
  }
  return out;
}
