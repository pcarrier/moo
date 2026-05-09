import type { WSConnection } from "../events";

export type ApiError = {
  message: string;
  code?: string;
  stack?: string;
  /** Legacy aliases still accepted from the harness until the wire shape is normalized. */
  details?: string;
  detail?: unknown;
  data?: unknown;
};

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ApiError };

// state.ts wires the singleton WS up at boot via `bindWS`. All API calls
// route through it — there's no fallback to fetch. Pending requests are
// rejected on disconnect; callers see `{ok:false, error:{message:"ws ..."}}`.
let conn: WSConnection | null = null;

const FRONTEND_TRACE_COMMAND = "trace-frontend";
const FRONTEND_TRACE_IGNORED = new Set([
  FRONTEND_TRACE_COMMAND,
  "v8-stats",
  "trace-chats",
  "trace-roots",
  "trace-node",
  "trace-subtree",
  "trace-search",
  "trace-failed",
  "trace-chat-tree",
]);

export function bindWS(c: WSConnection) {
  conn = c;
}

function commandName(payload: Record<string, unknown>): string | null {
  return typeof payload.command === "string" ? payload.command : null;
}

function currentRoute(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return `${location.pathname}${location.search || ""}`;
}

function resultStatus(result: unknown): "ok" | "error" {
  if (result && typeof result === "object" && "ok" in result) {
    return (result as { ok?: unknown }).ok === false ? "error" : "ok";
  }
  return "ok";
}

function resultError(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || !("error" in result)) return undefined;
  const error = (result as { error?: unknown }).error;
  if (!error) return undefined;
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

function recordFrontendTrace(name: string, startedMs: number, endedMs: number, result: unknown, rpcDurationMs: number) {
  if (!conn || FRONTEND_TRACE_IGNORED.has(name)) return;
  void conn.run({
    command: FRONTEND_TRACE_COMMAND,
    name,
    startedNs: startedMs * 1_000_000,
    endedNs: endedMs * 1_000_000,
    status: resultStatus(result),
    route: currentRoute(),
    error: resultError(result),
    rpcDurationMs,
  });
}

export async function call<T = unknown>(
  payload: Record<string, unknown>,
): Promise<ApiResult<T>> {
  if (!conn) return { ok: false, error: { message: "ws not bound" } };
  const name = commandName(payload);
  const rpcStartedMs = Date.now();
  const result = await conn.run<ApiResult<T>>(payload);
  const receivedMs = Date.now();
  if (name) recordFrontendTrace(name, receivedMs, receivedMs, result, receivedMs - rpcStartedMs);
  return result;
}
