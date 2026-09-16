import type { LlmProviderId } from "./api";

export type ProviderVariantMeta = { id: string; title: string; baseUrl: string; hint?: string };

export type ProviderMeta = {
  id: LlmProviderId;
  title: string;
  envLabel: string;
  defaultBaseUrl: string;
  supportsOAuth?: boolean;
  variants?: ProviderVariantMeta[];
  variantLabel?: string;
  /** Explicit plan selection pins the URL, ahead of stored and environment overrides. */
  selectsBaseUrl?: boolean;
  endpointHint?: string;
};

export const PROVIDERS: ProviderMeta[] = [
  { id: "openai", title: "OpenAI", envLabel: "OPENAI_API_KEY", defaultBaseUrl: "https://api.openai.com/v1", supportsOAuth: true },
  { id: "anthropic", title: "Anthropic", envLabel: "ANTHROPIC_API_KEY", defaultBaseUrl: "https://api.anthropic.com/v1" },
  { id: "qwen", title: "Qwen", envLabel: "QWEN_API_KEY or DASHSCOPE_API_KEY", defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
  { id: "glm", title: "GLM", envLabel: "ZAI_API_KEY or GLM_API_KEY", defaultBaseUrl: "https://api.z.ai/api/paas/v4", variantLabel: "Plan", selectsBaseUrl: true, variants: [
    { id: "platform", title: "API Platform (pay-as-you-go)", baseUrl: "https://api.z.ai/api/paas/v4" },
    { id: "coding", title: "Coding Plan (subscription)", baseUrl: "https://api.z.ai/api/coding/paas/v4", hint: "Uses subscription quota, separate from API balance. Z.ai restricts subscriptions to supported tools; Moo is not currently listed, so confirm eligibility with Z.ai." },
  ], endpointHint: "Selecting a plan sets its URL automatically, replacing any override. Your API key stays unchanged. Save to apply." },
  { id: "xai", title: "xAI", envLabel: "XAI_API_KEY or GROK_API_KEY", defaultBaseUrl: "https://api.x.ai/v1" },
  { id: "deepseek", title: "DeepSeek", envLabel: "DEEPSEEK_API_KEY", defaultBaseUrl: "https://api.deepseek.com" },
  { id: "kimi", title: "Kimi", envLabel: "MOONSHOT_API_KEY or KIMI_API_KEY", defaultBaseUrl: "https://api.moonshot.ai/v1", variants: [
    { id: "platform", title: "Moonshot Platform", baseUrl: "https://api.moonshot.ai/v1" },
    { id: "code", title: "Kimi Code (kimi.com/code)", baseUrl: "https://api.kimi.com/coding/v1" },
  ] },
];

export function providerVariantPatch(meta: ProviderMeta, id: string): { variant?: string; baseUrl?: string } {
  const variant = meta.variants?.find((v) => v.id === id);
  if (!variant) return {};
  return meta.selectsBaseUrl ? { variant: variant.id, baseUrl: variant.baseUrl } : { variant: variant.id };
}

export function providerVariantValue(meta: ProviderMeta, draft: { variant?: string | null; baseUrl?: string | null }): string {
  const baseUrl = draft.baseUrl?.trim().replace(/\/+$/, "");
  // Reflect existing URL overrides, including the workaround used before a plan selector existed.
  if (meta.selectsBaseUrl && baseUrl) {
    return meta.variants?.find((v) => v.baseUrl === baseUrl)?.id ?? "custom";
  }
  return meta.variants?.find((v) => v.id === draft.variant)?.id ?? meta.variants?.[0]?.id ?? "";
}
