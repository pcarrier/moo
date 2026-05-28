import type { ApiCommand } from "./contract";

export type LlmProviderId = "openai" | "anthropic" | "qwen" | "xai" | "deepseek";
export type LlmAuthMode = "env" | "apiKey" | "oauth";

export type LlmRetrySettings = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs?: number;
  maxRetryAfterMs?: number;
};

export type LlmCompactionSettings = {
  thresholdPercent: number;
};

export type UiBehaviorSettings = {
  syntaxHighlightMaxBytes: number;
  attachmentImageMaxDimension: number;
};


export type LlmProviderAuthSettings = {
  authMode: LlmAuthMode;
  apiKey?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  oauthSubject?: string | null;
  baseUrl?: string | null;
  hasApiKey?: boolean;
  hasAccessToken?: boolean;
  hasRefreshToken?: boolean;
};

export type LlmProviderSaveSettings = {
  authMode?: LlmAuthMode;
  apiKey?: string | null;
  clearOAuth?: boolean;
  baseUrl?: string | null;
};

export type LlmAuthSettings = {
  providers: Record<LlmProviderId, LlmProviderAuthSettings>;
  serverBaseUrl?: string | null;
  compaction: LlmCompactionSettings;
  retries: LlmRetrySettings;
  ui: UiBehaviorSettings;
  updatedAt?: number;
};

export type LlmAuthSaveInput = Partial<Record<LlmProviderId, LlmProviderSaveSettings>> & { serverBaseUrl?: string | null; compaction?: Partial<LlmCompactionSettings>; retries?: Partial<LlmRetrySettings>; ui?: Partial<UiBehaviorSettings> };

export type LlmDeviceLogin = {
  provider: LlmProviderId;
  state: string;
  verificationUrl: string;
  userCode: string;
  interval: number;
  expiresAt: number;
};

export type LlmAuthCommands =
  | ApiCommand<"llm-auth-get", Record<string, never>, { settings: LlmAuthSettings }>
  | ApiCommand<"llm-auth-save", LlmAuthSaveInput, { settings: LlmAuthSettings }>
  | ApiCommand<"llm-auth-oauth-start", { provider?: LlmProviderId; origin?: string; redirectUri?: string; clientId?: string; scope?: string; authorizationUrl?: string; tokenUrl?: string }, { login: { provider: LlmProviderId; authorizeUrl: string; state: string; redirectUri: string; expiresAt: number } }>
  | ApiCommand<"llm-auth-oauth-complete", { state: string; code: string }, { settings: LlmAuthSettings }>
  | ApiCommand<"llm-auth-oauth-device-start", { provider?: LlmProviderId }, { device: LlmDeviceLogin }>
  | ApiCommand<"llm-auth-oauth-device-poll", { state: string }, { pending: true; interval: number; expiresAt: number } | { pending: false; settings: LlmAuthSettings }>
  | ApiCommand<"llm-auth-oauth-logout", { provider?: LlmProviderId }, { settings: LlmAuthSettings }>;
