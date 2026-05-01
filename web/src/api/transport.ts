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

export function bindWS(c: WSConnection) {
  conn = c;
}

export async function call<T = unknown>(
  payload: Record<string, unknown>,
): Promise<ApiResult<T>> {
  if (!conn) return { ok: false, error: { message: "ws not bound" } };
  return await conn.run<ApiResult<T>>(payload);
}
