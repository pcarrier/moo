import * as host from "../host_ops";
import { moo } from "../moo";
import type { RetryPolicy } from "../core/retry";
import { DEFAULT_LLM_RETRY_POLICY } from "../core/retry";
import type { Input } from "./_shared";
import { PROVIDER_METADATA, normalizeProvider, type ProviderName } from "../llm_models";

const SETTINGS_REF = "settings";
const OAUTH_STATE_REF_PREFIX = "llm/auth/oauth/openai/";
const OAUTH_DEVICE_REF_PREFIX = "llm/auth/oauth/openai-device/";
const CODEX_OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OPENAI_SCOPES = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const OPENAI_ISSUER = "https://auth.openai.com";
const OPENAI_AUTHORIZE_URL = OPENAI_ISSUER + "/oauth/authorize";
const OPENAI_TOKEN_URL = OPENAI_ISSUER + "/oauth/token";


export type LlmAuthProviderId = ProviderName;
export type LlmAuthMode = "env" | "apiKey" | "oauth";

export type LlmAuthProviderSettings = {
  authMode: LlmAuthMode;
  apiKey?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  oauthSubject?: string | null;
  oauthAccountId?: string | null;
  baseUrl?: string | null;
};

export type LlmCompactionSettings = {
  thresholdPercent: number;
};

export type LlmAuthSettings = {
  providers: Record<LlmAuthProviderId, LlmAuthProviderSettings>;
  compaction: LlmCompactionSettings;
  retries: RetryPolicy;
  updatedAt?: number;
};

const PROVIDERS = PROVIDER_METADATA;

function providerId(value: unknown): LlmAuthProviderId | null {
  return normalizeProvider(value);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function normalizeRetryPolicy(input: Partial<RetryPolicy> | null | undefined): RetryPolicy {
  return {
    maxAttempts: clampInt(input?.maxAttempts, DEFAULT_LLM_RETRY_POLICY.maxAttempts, 1, 20),
    baseDelayMs: clampInt(input?.baseDelayMs, DEFAULT_LLM_RETRY_POLICY.baseDelayMs, 0, 60_000),
    maxDelayMs: clampInt(input?.maxDelayMs, DEFAULT_LLM_RETRY_POLICY.maxDelayMs, 0, 10 * 60_000),
    jitterMs: clampInt(input?.jitterMs, DEFAULT_LLM_RETRY_POLICY.jitterMs ?? 0, 0, 60_000),
    maxRetryAfterMs: clampInt(input?.maxRetryAfterMs, DEFAULT_LLM_RETRY_POLICY.maxRetryAfterMs ?? DEFAULT_LLM_RETRY_POLICY.maxDelayMs, 0, 60 * 60_000),
  };
}

export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 50;

export function normalizeCompactionSettings(input: Partial<LlmCompactionSettings> | null | undefined): LlmCompactionSettings {
  return {
    thresholdPercent: clampInt(input?.thresholdPercent, DEFAULT_COMPACTION_THRESHOLD_PERCENT, 1, 100),
  };
}

function defaultProviderSettings(): LlmAuthProviderSettings {
  return { authMode: "env" };
}

function defaultSettings(): LlmAuthSettings {
  return {
    providers: {
      openai: defaultProviderSettings(),
      anthropic: defaultProviderSettings(),
      qwen: defaultProviderSettings(),
      xai: defaultProviderSettings(),
    },
    compaction: normalizeCompactionSettings(null),
    retries: normalizeRetryPolicy(DEFAULT_LLM_RETRY_POLICY),
  };
}

function normalizeProviderSettings(raw: unknown, id: LlmAuthProviderId): LlmAuthProviderSettings {
  const r = raw && typeof raw === "object" ? raw as LlmAuthProviderSettings : {} as LlmAuthProviderSettings;
  const requestedMode = r.authMode === "apiKey" || r.authMode === "oauth" ? r.authMode : "env";
  const authMode: LlmAuthMode =
    id === "openai" ? requestedMode :
    requestedMode === "apiKey" ? "apiKey" : "env";
  return {
    authMode,
    apiKey: typeof r.apiKey === "string" && r.apiKey ? r.apiKey : null,
    accessToken: id === "openai" && typeof r.accessToken === "string" && r.accessToken ? r.accessToken : null,
    refreshToken: id === "openai" && typeof r.refreshToken === "string" && r.refreshToken ? r.refreshToken : null,
    expiresAt: id === "openai" && Number.isFinite(r.expiresAt) ? Number(r.expiresAt) : null,
    oauthSubject: id === "openai" && typeof r.oauthSubject === "string" && r.oauthSubject ? r.oauthSubject : null,
    oauthAccountId: id === "openai" && typeof r.oauthAccountId === "string" && r.oauthAccountId ? r.oauthAccountId : null,
    baseUrl: typeof r.baseUrl === "string" && r.baseUrl.trim() ? r.baseUrl.trim() : null,
  };
}

export async function readLlmAuthSettings(): Promise<LlmAuthSettings> {
  const hash = await moo.pointers.get(SETTINGS_REF);
  if (!hash) return defaultSettings();
  const obj = await moo.objects.getJSON<Partial<LlmAuthSettings>>({ hash });
  const raw = obj?.value ?? {};
  return {
    providers: {
      openai: normalizeProviderSettings(raw.providers?.openai, "openai"),
      anthropic: normalizeProviderSettings(raw.providers?.anthropic, "anthropic"),
      qwen: normalizeProviderSettings(raw.providers?.qwen, "qwen"),
      xai: normalizeProviderSettings(raw.providers?.xai, "xai"),
    },
    compaction: normalizeCompactionSettings(raw.compaction),
    retries: normalizeRetryPolicy(raw.retries),
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : undefined,
  };
}

async function writeLlmAuthSettings(settings: LlmAuthSettings): Promise<LlmAuthSettings> {
  const next = { ...settings, updatedAt: await moo.time.nowMs() };
  const hash = await moo.objects.putJSON({ kind: "llm:AuthSettings", value: next });
  await moo.pointers.set(SETTINGS_REF, hash);
  return next;
}

export async function currentCompactionThresholdPercent(): Promise<number> {
  return (await readLlmAuthSettings()).compaction.thresholdPercent;
}

export async function currentLlmRetryPolicy(): Promise<RetryPolicy> {
  return (await readLlmAuthSettings()).retries;
}

async function envKeyForProvider(id: LlmAuthProviderId): Promise<string | null> {
  const meta = PROVIDERS[id];
  const primary = await moo.env.get(meta.envKey);
  if (primary) return primary;
  for (const alt of meta.envAltKeys ?? []) {
    const value = await moo.env.get(alt);
    if (value) return value;
  }
  return null;
}

async function fallbackModelForProvider(id: LlmAuthProviderId, authMode?: LlmAuthMode): Promise<string> {
  const providerFallback = PROVIDERS[id].fallbackModel;
  const generic = await moo.env.get("MOO_LLM_MODEL");
  if (generic) {
    const trimmed = generic.trim();
    const prefix = id + ":";
    if (trimmed.toLowerCase().startsWith(prefix)) return trimmed.slice(prefix.length).trim() || providerFallback;
  }
  const envName = id === "openai" ? "OPENAI_MODEL" : id === "anthropic" ? "ANTHROPIC_MODEL" : id === "qwen" ? "QWEN_MODEL" : "XAI_MODEL";
  return (await moo.env.get(envName)) || providerFallback;
}


export async function providerConfiguredCredential(id: LlmAuthProviderId): Promise<{ apiKey: string | null; authMode: LlmAuthMode; keyEnvHint: string; baseUrl: string; model: string; oauthAccountId?: string | null }> {
  const settings = await readLlmAuthSettings();
  const provider = settings.providers[id];
  const meta = PROVIDERS[id];
  const baseUrl = provider.baseUrl || (await moo.env.get(meta.baseUrlEnv)) || meta.defaultBaseUrl;
  const requestedAuthMode = provider.authMode;
  const model = await fallbackModelForProvider(id, requestedAuthMode);
  if (id === "openai" && provider.authMode === "oauth") {
    const oauthBaseUrl = provider.baseUrl || "https://chatgpt.com/backend-api/codex";
    return { apiKey: provider.accessToken || null, authMode: "oauth", keyEnvHint: "OpenAI OAuth", baseUrl: oauthBaseUrl, model, oauthAccountId: provider.oauthAccountId };
  }
  if (provider.authMode === "apiKey") {
    return { apiKey: provider.apiKey || null, authMode: "apiKey", keyEnvHint: "stored " + meta.envKey, baseUrl, model };
  }
  return { apiKey: await envKeyForProvider(id), authMode: "env", keyEnvHint: meta.envKey, baseUrl, model };
}

export async function openaiConfiguredCredential() {
  return providerConfiguredCredential("openai");
}

function redactProvider(provider: LlmAuthProviderSettings) {
  return {
    ...provider,
    apiKey: provider.apiKey ? "••••" + provider.apiKey.slice(-4) : null,
    accessToken: provider.accessToken ? "present" : null,
    refreshToken: provider.refreshToken ? "present" : null,
    hasApiKey: !!provider.apiKey,
    hasAccessToken: !!provider.accessToken,
    hasRefreshToken: !!provider.refreshToken,
  };
}

function redact(settings: LlmAuthSettings) {
  return {
    ...settings,
    providers: {
      openai: redactProvider(settings.providers.openai),
      anthropic: redactProvider(settings.providers.anthropic),
      qwen: redactProvider(settings.providers.qwen),
      xai: redactProvider(settings.providers.xai),
    },
  };
}

export async function llmAuthGetCommand() {
  return { ok: true, value: { settings: redact(await readLlmAuthSettings()) } };
}

function applyProviderInput(current: LlmAuthProviderSettings, id: LlmAuthProviderId, input: unknown, now: number): LlmAuthProviderSettings {
  if (!input || typeof input !== "object") return current;
  const providerInput = input as Record<string, unknown>;
  const modeRaw = String(providerInput.authMode ?? current.authMode ?? "env");
  const authMode: LlmAuthMode =
    modeRaw === "apiKey" || (id === "openai" && modeRaw === "oauth")
      ? modeRaw as LlmAuthMode
      : "env";
  const apiKeyInput = providerInput.apiKey;
  const next: LlmAuthProviderSettings = {
    ...current,
    authMode,
    apiKey: typeof apiKeyInput === "string" && !apiKeyInput.startsWith("••••") ? apiKeyInput.trim() || null : current.apiKey ?? null,
    baseUrl: typeof providerInput.baseUrl === "string" ? providerInput.baseUrl.trim() || null : current.baseUrl ?? null,
  };
  if (id !== "openai" || providerInput.clearOAuth === true || authMode !== "oauth") {
    next.accessToken = null;
    next.refreshToken = null;
    next.expiresAt = null;
    next.oauthSubject = null;
  }
  return next;
}

export async function llmAuthSaveCommand(input: Input) {
  const current = await readLlmAuthSettings();
  const now = await moo.time.nowMs();
  const providers = { ...current.providers };
  for (const id of Object.keys(PROVIDERS) as LlmAuthProviderId[]) {
    providers[id] = applyProviderInput(current.providers[id], id, input[id], now);
  }
  const retries = input.retries && typeof input.retries === "object" ? normalizeRetryPolicy(input.retries as Partial<RetryPolicy>) : current.retries;
  const compaction = input.compaction && typeof input.compaction === "object" ? normalizeCompactionSettings(input.compaction as Partial<LlmCompactionSettings>) : current.compaction;
  const saved = await writeLlmAuthSettings({ providers, compaction, retries });
  return { ok: true, value: { settings: redact(saved) } };
}

function randomState(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function originFromInput(input: Input): string {
  const raw = String(input.origin ?? "").trim();
  if (raw) return raw.replace(/\/$/, "");
  return "http://localhost:3000";
}

function decodeBase64(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let bits = 0;
  let bitLength = 0;
  let out = "";
  for (const ch of value.replace(/=+$/, "")) {
    const n = alphabet.indexOf(ch);
    if (n < 0) continue;
    bits = (bits << 6) | n;
    bitLength += 6;
    if (bitLength >= 8) {
      bitLength -= 8;
      out += String.fromCharCode((bits >> bitLength) & 0xff);
    }
  }
  return out;
}

function decodeJwtPayload(jwt: string): Record<string, any> | null {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
    return JSON.parse(decodeBase64(padded));
  } catch { return null; }
}

function formEncode(values: Record<string, string | undefined>): string {
  return Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value))
    .join("&");
}

function addQuery(url: string, values: Record<string, string | undefined>): string {
  const qs = formEncode(values);
  if (!qs) return url;
  const hash = url.indexOf("#");
  const base = hash >= 0 ? url.slice(0, hash) : url;
  const frag = hash >= 0 ? url.slice(hash) : "";
  return base + (base.includes("?") ? "&" : "?") + qs + frag;
}

async function exchangeOpenAiOAuthTokens(saved: { clientId: string; redirectUri: string; verifier: string }, code: string): Promise<{ ok: true; settings: LlmAuthSettings } | { ok: false; error: { message: string; detail?: string } }> {
  const body = formEncode({ grant_type: "authorization_code", code, redirect_uri: saved.redirectUri, client_id: saved.clientId, code_verifier: saved.verifier });
  const resp = await moo.http.fetch({ method: "POST", url: OPENAI_TOKEN_URL, headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body, timeoutMs: 30_000 });
  if (resp.status >= 400) return { ok: false, error: { message: "OAuth token exchange failed (" + resp.status + ")", detail: resp.body } };
  let token: any;
  try { token = JSON.parse(resp.body); } catch { return { ok: false, error: { message: "OAuth token response was not JSON" } }; }
  const idToken = typeof token.id_token === "string" ? token.id_token : "";
  const loginAccessToken = typeof token.access_token === "string" ? token.access_token : "";
  const accessToken = loginAccessToken;
  if (!accessToken) return { ok: false, error: { message: "OpenAI OAuth did not produce a usable access token" } };
  const jwt = decodeJwtPayload(loginAccessToken) || (idToken ? decodeJwtPayload(idToken) : null);
  const accountId = jwt?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? null;
  const current = await readLlmAuthSettings();
  const expiresIn = Number(token.expires_in);
  const openai: LlmAuthProviderSettings = {
    ...current.providers.openai,
    authMode: "oauth",
    accessToken,
    refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : current.providers.openai.refreshToken ?? null,
    expiresAt: Number.isFinite(expiresIn) ? (await moo.time.nowMs()) + expiresIn * 1000 : null,
    oauthSubject: loginAccessToken ? loginAccessToken.slice(0, 32) : current.providers.openai.oauthSubject ?? null,
    oauthAccountId: typeof accountId === "string" && accountId ? accountId : current.providers.openai.oauthAccountId ?? null,
  };
  return { ok: true, settings: await writeLlmAuthSettings({ ...current, providers: { ...current.providers, openai } }) };
}

export async function llmAuthOAuthStartCommand(input: Input) {
  const provider = providerId(input.provider) ?? "openai";
  if (provider !== "openai") return { ok: false, error: { message: "OAuth is currently supported for OpenAI only" } };
  const state = randomState();
  const redirectUri = String(input.redirectUri ?? originFromInput(input) + "/llm-auth/oauth/callback").trim();
  const verifier = randomState() + randomState();
  const codeChallenge = host.sha256Base64Url(verifier);
  const expiresAt = (await moo.time.nowMs()) + 10 * 60_000;
  const clientId = CODEX_OPENAI_CLIENT_ID;
  await moo.pointers.set(OAUTH_STATE_REF_PREFIX + state, await moo.objects.putJSON({ kind: "llm:OAuthState", value: { state, provider: "openai", clientId, redirectUri, verifier, tokenUrl: OPENAI_TOKEN_URL, expiresAt } }));
  return { ok: true, value: { login: { provider: "openai", authorizeUrl: addQuery(OPENAI_AUTHORIZE_URL, { response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: CODEX_OPENAI_SCOPES, code_challenge: codeChallenge, code_challenge_method: "S256", id_token_add_organizations: "true", codex_cli_simplified_flow: "true", state, originator: "codex_cli_rs" }), state, redirectUri, expiresAt } } };
}

export async function llmAuthOAuthCompleteCommand(input: Input) {
  const state = String(input.state ?? "").trim();
  const code = String(input.code ?? "").trim();
  if (!state || !code) return { ok: false, error: { message: "OAuth callback requires state and code" } };
  const ref = OAUTH_STATE_REF_PREFIX + state;
  const hash = await moo.pointers.get(ref);
  if (!hash) return { ok: false, error: { message: "Unknown or expired OAuth state" } };
  const obj = await moo.objects.getJSON<any>({ hash });
  const saved = obj?.value ?? {};
  await moo.pointers.delete(ref);
  if (Number(saved.expiresAt ?? 0) < await moo.time.nowMs()) return { ok: false, error: { message: "OAuth state expired" } };
  const exchanged = await exchangeOpenAiOAuthTokens({ clientId: String(saved.clientId), redirectUri: String(saved.redirectUri), verifier: String(saved.verifier) }, code);
  if (!exchanged.ok) return exchanged;
  return { ok: true, value: { settings: redact(exchanged.settings) } };
}

export async function llmAuthOAuthDeviceStartCommand(input: Input) {
  const provider = providerId(input.provider) ?? "openai";
  if (provider !== "openai") return { ok: false, error: { message: "OAuth is currently supported for OpenAI only" } };
  const resp = await moo.http.fetch({ method: "POST", url: OPENAI_ISSUER + "/api/accounts/deviceauth/usercode", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ client_id: CODEX_OPENAI_CLIENT_ID }), timeoutMs: 30_000 });
  if (resp.status >= 400) return { ok: false, error: { message: "OpenAI device login failed (" + resp.status + ")", detail: resp.body } };
  let body: any;
  try { body = JSON.parse(resp.body); } catch { return { ok: false, error: { message: "OpenAI device login response was not JSON" } }; }
  const deviceAuthId = String(body.device_auth_id ?? "").trim();
  const userCode = String(body.user_code ?? body.usercode ?? "").trim();
  const interval = Math.max(1, Math.min(30, Number.parseInt(String(body.interval ?? "5"), 10) || 5));
  if (!deviceAuthId || !userCode) return { ok: false, error: { message: "OpenAI device login response was missing a code" } };
  const state = randomState();
  const expiresAt = (await moo.time.nowMs()) + 15 * 60_000;
  await moo.pointers.set(OAUTH_DEVICE_REF_PREFIX + state, await moo.objects.putJSON({ kind: "llm:OAuthDeviceState", value: { state, provider: "openai", deviceAuthId, userCode, interval, expiresAt } }));
  return { ok: true, value: { device: { provider: "openai", state, verificationUrl: OPENAI_ISSUER + "/codex/device", userCode, interval, expiresAt } } };
}

export async function llmAuthOAuthDevicePollCommand(input: Input) {
  const state = String(input.state ?? "").trim();
  if (!state) return { ok: false, error: { message: "Device login poll requires state" } };
  const ref = OAUTH_DEVICE_REF_PREFIX + state;
  const hash = await moo.pointers.get(ref);
  if (!hash) return { ok: false, error: { message: "Unknown or expired device login" } };
  const obj = await moo.objects.getJSON<any>({ hash });
  const saved = obj?.value ?? {};
  if (Number(saved.expiresAt ?? 0) < await moo.time.nowMs()) {
    await moo.pointers.delete(ref);
    return { ok: false, error: { message: "Device login expired" } };
  }
  const resp = await moo.http.fetch({ method: "POST", url: OPENAI_ISSUER + "/api/accounts/deviceauth/token", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ device_auth_id: String(saved.deviceAuthId), user_code: String(saved.userCode) }), timeoutMs: 30_000 });
  if (resp.status === 403 || resp.status === 404) return { ok: true, value: { pending: true, interval: Number(saved.interval ?? 5), expiresAt: Number(saved.expiresAt) } };
  if (resp.status >= 400) {
    await moo.pointers.delete(ref);
    return { ok: false, error: { message: "OpenAI device login polling failed (" + resp.status + ")", detail: resp.body } };
  }
  let body: any;
  try { body = JSON.parse(resp.body); } catch { return { ok: false, error: { message: "OpenAI device login poll response was not JSON" } }; }
  const code = String(body.authorization_code ?? "").trim();
  const verifier = String(body.code_verifier ?? "").trim();
  if (!code || !verifier) return { ok: false, error: { message: "OpenAI device login completed without an authorization code" } };
  await moo.pointers.delete(ref);
  const exchanged = await exchangeOpenAiOAuthTokens({ clientId: CODEX_OPENAI_CLIENT_ID, redirectUri: OPENAI_ISSUER + "/deviceauth/callback", verifier }, code);
  if (!exchanged.ok) return exchanged;
  return { ok: true, value: { pending: false, settings: redact(exchanged.settings) } };
}

export async function llmAuthOAuthLogoutCommand(input: Input = {}) {
  const provider = providerId(input.provider) ?? "openai";
  if (provider !== "openai") return { ok: false, error: { message: "OAuth is currently supported for OpenAI only" } };
  const current = await readLlmAuthSettings();
  const openai = { ...current.providers.openai, authMode: current.providers.openai.authMode === "oauth" ? "env" as const : current.providers.openai.authMode, accessToken: null, refreshToken: null, expiresAt: null, oauthSubject: null };
  const saved = await writeLlmAuthSettings({ ...current, providers: { ...current.providers, openai } });
  return { ok: true, value: { settings: redact(saved) } };
}
