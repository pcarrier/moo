import { Effect, Schedule, type Schedule as RetrySchedule, type ScheduleDecision } from "./effect";
import { jsonValueSchema, parseJson } from "./json";

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

export type RetryableLlmResult = {
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

export type LlmRetryInput = {
  readonly result: RetryableLlmResult | null | undefined;
};

export type LlmRetrySchedule = Schedule<unknown, LlmRetryInput>;

function toRetryDecision(decision: ScheduleDecision): RetryDecision {
  return { retry: decision.continue, reason: decision.reason, delayMs: decision.delayMs };
}

function fromRetryDecision(decision: RetryDecision): ScheduleDecision {
  return { continue: decision.retry, reason: decision.reason, delayMs: decision.delayMs };
}

export function llmRetrySchedule(policy: RetryPolicy = DEFAULT_LLM_RETRY_POLICY): LlmRetrySchedule {
  return Schedule.whileInput(({ attempt, error }) => fromRetryDecision(llmRetryDecision(error?.result, attempt, policy)));
}

export function llmRetryDecisionFromSchedule(
  result: RetryableLlmResult | null | undefined,
  attempt: number,
  policy: RetryPolicy = DEFAULT_LLM_RETRY_POLICY,
): RetryDecision {
  return toRetryDecision(llmRetrySchedule(policy)({ attempt, error: { result } }));
}

export async function withLlmRetry<T extends RetryableLlmResult>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_LLM_RETRY_POLICY,
): Promise<T> {
  return Effect.gen(function* () {
    let attempt = 0;
    const op = Effect.tryPromise(() => operation(++attempt), "llm operation failed");
    const schedule: RetrySchedule<T> = Schedule.whileInput<T, unknown>(({ attempt: scheduleAttempt, value }) =>
      fromRetryDecision(llmRetryDecision(value ?? {}, scheduleAttempt, policy)),
    );
    return yield* op.retryWhile(
      (result) => !result.ok && llmRetryDecision(result, attempt, policy).retry,
      schedule,
    );
  }).runPromise();
}

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

// Providers signal backoff windows through several headers. `retry-after` is the
// canonical, authoritative one, but rate-limit resets (OpenAI `x-ratelimit-reset*`,
// Anthropic `anthropic-ratelimit-*-reset`) carry the real window and are surfaced
// in the error display. Honor them here too: otherwise a mid-stream HTTP 200
// failure that carried only a rate-limit reset retries on plain exponential
// backoff, hammers the still-closed window, burns its attempts, and fails
// permanently — even though we printed exactly when to retry.
const RATELIMIT_RESET_HEADER_NAMES = [
  "x-ratelimit-reset",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-reset",
];

export function retryAfterDelayMs(
  result: RetryableLlmResult | null | undefined,
  policy: RetryPolicy = DEFAULT_LLM_RETRY_POLICY,
): number | null {
  const max = Math.max(0, policy.maxRetryAfterMs ?? policy.maxDelayMs);
  const clamp = (ms: number): number => (max > 0 ? Math.min(ms, max) : ms);

  // Explicit Retry-After (header or error body) is the provider's instruction; honor it first.
  for (const value of [headerValue(result?.headers, "retry-after"), retryAfterFromBody(result?.errorBody)]) {
    if (!value) continue;
    const parsed = parseRetryAfterMs(value);
    if (parsed != null) return clamp(parsed);
  }

  // Otherwise wait for the longest rate-limit reset window so the binding limit
  // has actually cleared before we retry.
  const resets = RATELIMIT_RESET_HEADER_NAMES
    .map((name) => parseRetryAfterMs(headerValue(result?.headers, name) ?? ""))
    .filter((v): v is number => v != null);
  if (resets.length) return clamp(Math.max(...resets));

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
  if (Number.isFinite(seconds)) {
    // Large bare numbers are Unix epoch reset timestamps (seconds), not relative
    // delays. Anything beyond ~116 days as a "delay" is really an absolute time.
    if (seconds > 1e7) return Math.max(0, Math.round(seconds * 1000) - Date.now());
    return Math.max(0, Math.round(seconds * 1000));
  }
  const duration = parseDurationMs(trimmed);
  if (duration != null) return duration;
  const at = Date.parse(trimmed);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return null;
}

// Go-style duration strings used by OpenAI rate-limit reset headers, e.g.
// "1s", "6m0s", "1m30s", "13ms", "1h2m3s". Longer unit tokens are matched before
// their single-letter prefixes so "ms" is not mistaken for "m".
function parseDurationMs(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (!/^(?:\d+(?:\.\d+)?(?:h|ms|ns|us|µs|m|s))+$/.test(text)) return null;
  let total = 0;
  const re = /(\d+(?:\.\d+)?)(h|ms|ns|us|µs|m|s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const n = Number(m[1]);
    switch (m[2]) {
      case "h": total += n * 3_600_000; break;
      case "m": total += n * 60_000; break;
      case "s": total += n * 1_000; break;
      case "ms": total += n; break;
      case "us": case "µs": total += n / 1_000; break;
      case "ns": total += n / 1_000_000; break;
    }
  }
  return Math.max(0, Math.round(total));
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
  return /^(send|stream|transport):/.test(text)
    || /^websocket\s+(connect|send|stream|idle timeout|connection|upgrade)/.test(text)
    || /connection|reset|broken pipe|unexpected eof|\beof\b|network|body error/.test(text);
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
    return parseJson(body, "retry.parseBody", jsonValueSchema);
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
