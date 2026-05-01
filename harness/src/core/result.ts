export type Result<T, E = ErrorInfo> = Ok<T> | Err<E>;

export type Ok<T> = { ok: true; value: T };
export type Err<E = ErrorInfo> = { ok: false; error: E };

export type ErrorInfo = {
  message: string;
  stack?: string;
  cause?: unknown;
  [key: string]: unknown;
};

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E extends ErrorInfo | string>(error: E): Err<E extends string ? ErrorInfo : E> => ({
  ok: false,
  error: (typeof error === "string" ? { message: error } : error) as E extends string ? ErrorInfo : E,
});

export function errorInfo(error: unknown, fallback = "operation failed"): ErrorInfo {
  if (error && typeof error === "object") {
    const anyError = error as any;
    return {
      message: typeof anyError.message === "string" && anyError.message ? anyError.message : fallback,
      ...(typeof anyError.stack === "string" ? { stack: anyError.stack } : {}),
      ...(anyError.cause !== undefined ? { cause: anyError.cause } : {}),
    };
  }
  if (typeof error === "string" && error) return { message: error };
  return { message: fallback };
}

export function fromThrowable<T>(fn: () => T): Result<T> {
  try {
    return ok(fn());
  } catch (e) {
    return err(errorInfo(e));
  }
}

export async function fromPromise<T>(promise: Promise<T>, fallback?: string): Promise<Result<T>> {
  try {
    return ok(await promise);
  } catch (e) {
    return err(errorInfo(e, fallback));
  }
}

export function unwrap<T, E extends ErrorInfo>(result: Result<T, E>): T {
  if (result.ok === true) return result.value;
  throw new Error(result.error.message);
}
