export type RetryDecision = {
  retry: boolean;
  reason: string;
  delayMs: number;
};

export type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs?: number;
  maxRetryAfterMs?: number;
};

type RetryableLlmResult = {
  ok?: boolean;
  status?: number;
  errorBody?: unknown;
  headers?: Record<string, unknown> | null;
};

export const DEFAULT_LLM_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 750,
  maxDelayMs: 8_000,
  jitterMs: 250,
  // Providers can ask for longer backoff windows (e.g. Anthropic overloads or
  // rate limits). Cap Retry-After so a malformed header cannot park a run for
  // days, but allow the long delays providers commonly use while recovering.
  maxRetryAfterMs: 30 * 60_000,
};

const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export function retryDelayMs(attempt: number, policy: RetryPolicy = DEFAULT_LLM_RETRY_POLICY): number {
  const index = Math.max(0, attempt - 1);
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** index);
  const jitter = Math.max(0, policy.jitterMs ?? 0);
  return Math.round(exponential + (jitter ? Math.random() * jitter : 0));
}

export function llmRetryDecision(
  result: RetryableLlmResult | null | undefined,
  attempt: number,
  policy: RetryPolicy = DEFAULT_LLM_RETRY_POLICY,
): RetryDecision {
  if (result?.ok) return { retry: false, reason: "ok", delayMs: 0 };
  if (attempt >= policy.maxAttempts) return { retry: false, reason: "attempts-exhausted", delayMs: 0 };

  const status = Number(result?.status ?? 0) || 0;
  const delayMs = llmRetryDelayMs(result, attempt, policy);
  if (status === 0) return { retry: true, reason: "transport", delayMs };
  if (RETRYABLE_HTTP_STATUSES.has(status)) return { retry: true, reason: `http-${status}`, delayMs };

  // Some streaming APIs surface provider errors inside an otherwise-successful
  // SSE response. Retry known transient provider errors such as Anthropic
  // overloaded_error, and retry transport stream failures reported after a 2xx.
  const bodyReason = retryableErrorBodyReason(result?.errorBody);
  const bodyRetryAllowed = (status >= 200 && status < 300) || status >= 500;
  if (bodyReason && bodyRetryAllowed) return { retry: true, reason: bodyReason, delayMs };
  if (status >= 200 && status < 300 && transportErrorBodyReason(result?.errorBody)) {
    return { retry: true, reason: "stream", delayMs };
  }

  return { retry: false, reason: status >= 200 && status < 300 ? "stream-error" : `http-${status}`, delayMs: 0 };
}

export function llmAttempt(input: { attempt?: unknown } | null | undefined): number {
  const n = Number(input?.attempt ?? 1);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function llmRetryDelayMs(result: RetryableLlmResult | null | undefined, attempt: number, policy: RetryPolicy): number {
  const backoff = retryDelayMs(attempt, policy);
  const retryAfter = retryAfterDelayMs(result, policy);
  return retryAfter == null ? backoff : Math.max(backoff, retryAfter);
}

export function retryAfterDelayMs(
  result: RetryableLlmResult | null | undefined,
  policy: RetryPolicy = DEFAULT_LLM_RETRY_POLICY,
): number | null {
  const values = [headerValue(result?.headers, "retry-after"), retryAfterFromBody(result?.errorBody)].filter((v): v is string => !!v);
  for (const value of values) {
    const parsed = parseRetryAfterMs(value);
    if (parsed == null) continue;
    const max = Math.max(0, policy.maxRetryAfterMs ?? policy.maxDelayMs);
    return max > 0 ? Math.min(parsed, max) : parsed;
  }
  return null;
}

function headerValue(headers: Record<string, unknown> | null | undefined, name: string): string | null {
  if (!headers || typeof headers !== "object") return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
    if (value != null) return String(value);
  }
  return null;
}

function parseRetryAfterMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(trimmed);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return null;
}

function retryAfterFromBody(body: unknown): string | null {
  const parsed = parseBody(body);
  const found = findRetryAfterValue(parsed);
  if (found != null) return String(found);

  const text = bodyText(body);
  if (!text) return null;
  const match = /(?:retry|try again)\s+(?:after|in)\s+([0-9]+(?:\.[0-9]+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?)?/i.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = (match[2] || "s").toLowerCase();
  if (unit.startsWith("ms") || unit.startsWith("millisecond")) return String(amount / 1000);
  if (unit === "m" || unit.startsWith("min")) return String(amount * 60);
  return String(amount);
}

function findRetryAfterValue(value: unknown, depth = 0): unknown {
  if (value == null || depth > 6) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRetryAfterValue(item, depth + 1);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[-_]/g, "");
    if (normalized === "retryafter" || normalized === "retryafterseconds") return child;
    if (normalized === "retryafterms" || normalized === "retryaftermilliseconds") {
      const ms = Number(child);
      return Number.isFinite(ms) ? String(ms / 1000) : child;
    }
    const found = findRetryAfterValue(child, depth + 1);
    if (found != null) return found;
  }
  return null;
}

function retryableErrorBodyReason(body: unknown): string | null {
  const text = collectedBodyText(body);
  if (!text) return null;
  if (/overloaded|overload|over capacity|capacity exceeded/.test(text)) return "overloaded";
  if (/rate[_\s-]?limit|too many requests|retry after|try again in/.test(text)) return "rate-limit";
  if (/temporar(?:y|ily)|try again later|please retry|service unavailable|unavailable/.test(text)) return "temporary";
  if (/timed?\s*out|\btimeout\b/.test(text)) return "timeout";
  if (/internal[_\s-]?error|server[_\s-]?error/.test(text)) return "server-error";
  return null;
}

function transportErrorBodyReason(body: unknown): boolean {
  const text = bodyText(body).toLowerCase();
  return /^(send|stream|transport):/.test(text) || /connection|reset|broken pipe|unexpected eof|\beof\b|network|body error/.test(text);
}

function collectedBodyText(body: unknown): string {
  const parsed = parseBody(body);
  const out: string[] = [];
  collectStrings(parsed, out);
  if (out.length === 0 && typeof body === "string") out.push(body);
  return out.join("\n").toLowerCase();
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body == null) return "";
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function collectStrings(value: unknown, out: string[], depth = 0) {
  if (value == null || depth > 6 || out.length > 200) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      collectStrings(child, out, depth + 1);
    }
  }
}
