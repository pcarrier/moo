// Toast notification system for surfacing API/WS failures to the user.
// Each entry self-dismisses after a few seconds; the UI can also dismiss by id.
//
// Extracted from state.ts to keep the createState factory focused.

import { createSignal } from "solid-js";

export type Toast = {
  id: number;
  source: string;
  message: string;
  details?: string;
  at: number;
};

export function wsErrorMessage(err: unknown): string {
  return err && typeof err === "object" && "message" in (err as any)
    ? String((err as any).message)
    : String(err);
}

function wsErrorDetails(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["stack", "backtrace", "trace", "details", "detail"]) {
    const value = e[key];
    if (typeof value === "string" && value.trim()) parts.push(value);
  }
  if (parts.length === 0 && "data" in e) {
    parts.push(formatErrorData(e.data));
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function formatErrorData(data: unknown): string {
  if (typeof data === "string")
    return data.length > 4000 ? data.slice(0, 4000) + "…" : data;
  try {
    const text = JSON.stringify(data, null, 2);
    return text.length > 4000 ? text.slice(0, 4000) + "…" : text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return "Unable to format error details: " + message;
  }
}

function isTransientWsError(err: unknown): boolean {
  return /^ws (disconnected|closed|not bound|request timed out)/i.test(
    wsErrorMessage(err),
  );
}

export function createToastSystem() {
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  let toastSeq = 0;

  function dismissToast(id: number) {
    setToasts(toasts().filter((t) => t.id !== id));
  }

  function notify(source: string, message: string, details?: string) {
    const id = ++toastSeq;
    setToasts([...toasts(), { id, source, message, details, at: Date.now() }]);
    window.setTimeout(() => dismissToast(id), 6000);
  }

  function reportError(source: string, err: unknown) {
    const message = wsErrorMessage(err);
    // Don't toast in-flight requests that fail because the WS dropped or a
    // background RPC got stuck behind a busy worker. The ws-status indicator
    // shows disconnects, and reconnect/ref handlers resync data once the
    // backend catches up. Without this filter, transient stalls flood the
    // screen with one toast per pending call (models/apps/describe/etc.).
    if (isTransientWsError(err)) return;
    notify(
      source,
      message,
      wsErrorDetails(err) ?? "No additional details were provided.",
    );
  }

  return { toasts, dismissToast, notify, reportError };
}
