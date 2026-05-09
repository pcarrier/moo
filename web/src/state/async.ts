import type { ApiResult } from "../api";

const CHAT_LOAD_RETRY_DELAYS_MS = [200, 600, 1200];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function retryChatLoad<T>(
  fn: () => Promise<ApiResult<T>>,
  keepGoing: () => boolean,
): Promise<ApiResult<T>> {
  let result = await fn();
  for (const delayMs of CHAT_LOAD_RETRY_DELAYS_MS) {
    if (result.ok || !keepGoing()) return result;
    await sleep(delayMs);
    if (!keepGoing()) return result;
    result = await fn();
  }
  return result;
}


export type SingleFlight<TArgs extends unknown[], TValue> = ((
  ...args: TArgs
) => Promise<ApiResult<TValue>>) & {
  forget: (...args: TArgs) => void;
  clear: () => void;
};

export function createSingleFlight<TArgs extends unknown[], TValue>(
  fn: (...args: TArgs) => Promise<ApiResult<TValue>>,
  keyOf: (...args: TArgs) => string,
): SingleFlight<TArgs, TValue> {
  const inFlight = new Map<string, Promise<ApiResult<TValue>>>();
  const run = ((...args: TArgs) => {
    const key = keyOf(...args);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const p = fn(...args).finally(() => {
      if (inFlight.get(key) === p) inFlight.delete(key);
    });
    inFlight.set(key, p);
    return p;
  }) as SingleFlight<TArgs, TValue>;
  run.forget = (...args: TArgs) => {
    inFlight.delete(keyOf(...args));
  };
  run.clear = () => inFlight.clear();
  return run;
}
