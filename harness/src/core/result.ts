export type { Err, ErrorInfo, Ok, Result } from "./effect";
export { err, errorInfo, ok } from "./effect";
import { Effect, errorInfo } from "./effect";
import type { ErrorInfo, Result } from "./effect";

export function fromThrowable<T>(fn: () => T): Result<T> {
  let out!: Result<T>;
  // Keep this synchronous for existing callers while sharing Effect's error
  // normalization semantics.
  try {
    out = { ok: true, value: fn() };
  } catch (e) {
    out = { ok: false, error: errorInfo(e) };
  }
  return out;
}

export async function fromPromise<T>(promise: Promise<T>, fallback?: string): Promise<Result<T>> {
  return Effect.fromPromise(promise, fallback).runResult();
}

export function unwrap<T, E extends ErrorInfo>(result: Result<T, E>): T {
  if (result.ok === true) return result.value;
  throw new Error(result.error.message);
}
