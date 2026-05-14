declare const setTimeout: (handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => any;
declare const clearTimeout: (handle?: any) => void;

// AbortController/AbortSignal: prefer host-provided globals; fall back to a tiny in-file shim.
// Keeps effect.ts dependency-free and host-agnostic (Bun/Node/browsers/sandboxes).
const AbortController: { new (): { readonly signal: AbortSignal; abort(reason?: unknown): void } } =
  (globalThis as any).AbortController ??
  (class {
    readonly signal: AbortSignal;
    constructor() {
      const listeners = new Set<() => void>();
      const sig: any = {
        aborted: false,
        reason: undefined,
        addEventListener(type: string, l: () => void) {
          if (type === "abort") listeners.add(l);
        },
        removeEventListener(type: string, l: () => void) {
          if (type === "abort") listeners.delete(l);
        },
        _fire(reason: unknown) {
          if (sig.aborted) return;
          sig.aborted = true;
          sig.reason = reason;
          for (const l of [...listeners]) {
            try { l(); } catch { /* swallow */ }
          }
          listeners.clear();
        },
      };
      this.signal = sig as AbortSignal;
      (this as any).abort = (reason?: unknown) => sig._fire(reason ?? new Error("aborted"));
    }
    abort(_reason?: unknown): void { /* replaced in constructor */ }
  } as any);

interface AbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: "abort", listener: () => void, options?: unknown): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export type Cause<E = ErrorInfo> = {
  readonly _tag: "Fail" | "Die" | "Interrupt";
  readonly error: E;
};

export type ErrorInfo = {
  readonly message: string;
  readonly stack?: string;
  readonly cause?: unknown;
  readonly [key: string]: unknown;
};

export type Result<A, E = ErrorInfo> = Ok<A> | Err<E>;
export type Ok<A> = { readonly ok: true; readonly value: A };
export type Err<E = ErrorInfo> = { readonly ok: false; readonly error: E };

export type MaybePromise<A> = A | Promise<A>;

export const ok = <A>(value: A): Ok<A> => ({ ok: true, value });
export const err = <E>(error: E): Err<E extends string ? ErrorInfo : E> => ({
  ok: false,
  error: (typeof error === "string" ? { message: error } : error) as E extends string ? ErrorInfo : E,
});

export function errorInfo(error: unknown, fallback = "operation failed"): ErrorInfo {
  if (error && typeof error === "object") {
    const anyError = error as Record<string, unknown>;
    return {
      message: typeof anyError.message === "string" && anyError.message ? anyError.message : fallback,
      ...(typeof anyError.stack === "string" ? { stack: anyError.stack } : {}),
      ...(anyError.cause !== undefined ? { cause: anyError.cause } : {}),
      ...(typeof anyError._tag === "string" ? { _tag: anyError._tag } : {}),
      ...(anyError.meta !== undefined ? { meta: anyError.meta } : {}),
    };
  }
  if (typeof error === "string" && error) return { message: error };
  return { message: fallback };
}

export class TaggedError<T extends string = string> {
  readonly _tag: T;
  readonly message: string;
  readonly meta?: Record<string, unknown>;

  constructor(tag: T, message: string, meta?: Record<string, unknown>) {
    this._tag = tag;
    this.message = message;
    this.meta = meta;
  }
}

const interruptError = (): ErrorInfo => ({ message: "interrupted", interrupted: true });

export const failCause = <E>(error: E): Cause<E> => ({ _tag: "Fail", error });
export const dieCause = (error: unknown, fallback?: string): Cause<ErrorInfo> => ({ _tag: "Die", error: errorInfo(error, fallback) });
export const interruptCause = (reason = "interrupted"): Cause<ErrorInfo> => ({ _tag: "Interrupt", error: { message: reason } });

export type Finalizer = () => void | Promise<void>;

export class Scope {
  private readonly finalizers: Finalizer[] = [];
  private readonly controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  abort(): void {
    if (!this.controller.signal.aborted) this.controller.abort();
  }

  add(finalizer: Finalizer): void {
    this.finalizers.push(finalizer);
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    try {
      for (let i = this.finalizers.length - 1; i >= 0; i--) {
        try {
          await this.finalizers[i]();
        } catch (e) {
          errors.push(e);
        }
      }
      this.finalizers.length = 0;
    } finally {
      this.abort();
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new Error(errors.map((e) => errorInfo(e).message).join("; "));
  }
}

export class Deferred<A, E = ErrorInfo> {
  private settled = false;
  private resolvePromise!: (result: Result<A, E>) => void;
  private readonly promise = new Promise<Result<A, E>>((resolve) => {
    this.resolvePromise = resolve;
  });

  await(): Effect<A, E> {
    return new Effect(async (_scope, signal) => {
      if (signal.aborted) return err(interruptError()) as any;
      const result = await this.promise;
      if (signal.aborted) return err(interruptError()) as any;
      return result;
    });
  }

  succeed(value: A): boolean {
    return this.complete(ok(value));
  }

  fail(error: E): boolean {
    return this.complete(err(error as any) as Err<E>);
  }

  complete(result: Result<A, E>): boolean {
    if (this.settled) return false;
    this.settled = true;
    this.resolvePromise(result);
    return true;
  }
}

type EffectThunk<A, E> = (scope: Scope, signal: AbortSignal) => Promise<Result<A, E>>;
type RunOptions = { readonly scope?: Scope; readonly signal?: AbortSignal };

export class Effect<A, E = ErrorInfo> {
  private readonly thunk: EffectThunk<A, E>;

  constructor(thunk: EffectThunk<A, E>) {
    this.thunk = thunk;
  }

  [Symbol.iterator](): Generator<Effect<A, E>, A, any> {
    const self = this;
    return (function* (): Generator<Effect<A, E>, A, any> {
      return (yield self) as A;
    })();
  }

  static sync<A>(fn: () => A): Effect<A> {
    return new Effect(async (_scope, signal) => {
      if (signal.aborted) return err(interruptError()) as any;
      try {
        return ok(fn());
      } catch (e) {
        return err(errorInfo(e));
      }
    });
  }

  static succeed<A>(value: A): Effect<A, never> {
    return new Effect(async () => ok(value));
  }

  static interrupted(): Effect<never, ErrorInfo> {
    return new Effect(async () => err(interruptError()) as any);
  }

  static unit(): Effect<void, never> {
    return Effect.succeed(undefined);
  }

  static fail<E>(error: E): Effect<never, E> {
    return new Effect<never, E>(async () => err(error) as any);
  }

  static try<A>(fn: () => A, fallback?: string): Effect<A> {
    return new Effect(async (_scope, signal) => {
      if (signal.aborted) return err(interruptError()) as any;
      try {
        return ok(fn());
      } catch (e) {
        return err(errorInfo(e, fallback));
      }
    });
  }

  static tryPromise<A>(fn: () => Promise<A>, fallback?: string): Effect<A, ErrorInfo> {
    return new Effect(async (_scope, signal) => {
      if (signal.aborted) return err(interruptError());
      try {
        const value = await fn();
        if (signal.aborted) return err(interruptError());
        return ok(value);
      } catch (e) {
        if (signal.aborted) return err(interruptError());
        return err(errorInfo(e, fallback));
      }
    });
  }

  static fromPromise<A>(promise: Promise<A>, fallback?: string): Effect<A, ErrorInfo> {
    return Effect.tryPromise(() => promise, fallback);
  }

  static sleep(ms: number): Effect<void, ErrorInfo> {
    return new Effect(async (_scope, signal) => {
      if (signal.aborted) return err(interruptError());
      return await new Promise<Result<void, ErrorInfo>>((resolve) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (result: Result<void, ErrorInfo>) => {
          if (done) return;
          done = true;
          if (timer != null) clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        };
        const onAbort = () => finish(err(interruptError()));
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => finish(ok(undefined)), Math.max(0, ms));
      });
    });
  }

  static fromResult<A, E>(result: Result<A, E>): Effect<A, E> {
    return new Effect(async () => result);
  }

  static fromNullable<A, E>(value: A | null | undefined, onNull: () => E): Effect<A, E | ErrorInfo> {
    return Effect.defer(() => (value == null ? Effect.fail(onNull()) : Effect.succeed(value))) as Effect<A, E | ErrorInfo>;
  }

  static suspend<A, E>(fn: () => Effect<A, E>): Effect<A, E | ErrorInfo> {
    return Effect.defer(fn);
  }

  static defer<A, E>(fn: () => Effect<A, E>): Effect<A, E | ErrorInfo> {
    return new Effect<A, E | ErrorInfo>(async (scope, signal) => {
      if (signal.aborted) return err(interruptError()) as any;
      try {
        return (await fn().thunk(scope, signal)) as any;
      } catch (e) {
        return err(errorInfo(e)) as any;
      }
    });
  }

  static gen<A>(f: () => Generator<unknown, A, any>): Effect<A, ErrorInfo> {
    return new Effect<A, ErrorInfo>(async (scope, signal) => {
      if (signal.aborted) return err(interruptError());
      let iterator: Generator<unknown, A, any>;
      try {
        iterator = f();
      } catch (e) {
        return err(errorInfo(e, "generator failed"));
      }
      let state: IteratorResult<unknown, A>;
      try {
        state = iterator.next();
      } catch (e) {
        return err(errorInfo(e, "generator failed"));
      }
      for (;;) {
        if (signal.aborted) return err(interruptError());
        if (state.done) return ok(state.value);
        const yielded = state.value;
        let nextValue: unknown = yielded;
        if (yielded instanceof Effect) {
          const result = await yielded.thunk(scope, signal);
          if (!result.ok) {
            try {
              state = iterator.throw ? iterator.throw((result as Err<unknown>).error) : ({ done: true, value: undefined as A } as IteratorResult<unknown, A>);
              continue;
            } catch (e) {
              return err(errorInfo(e, "generator failed"));
            }
          }
          nextValue = result.value;
        }
        try {
          state = iterator.next(nextValue);
        } catch (e) {
          return err(errorInfo(e, "generator failed"));
        }
      }
    });
  }

  static all<T extends readonly Effect<unknown, unknown>[]>(effects: T): Effect<{ [K in keyof T]: T[K] extends Effect<infer A, unknown> ? A : never }, T[number] extends Effect<any, infer E> ? E : never> {
    return new Effect<any, any>(async (scope, signal) => {
      const values: unknown[] = [];
      for (const effect of effects) {
        const result = await effect.thunk(scope, signal);
        if (!result.ok) return result as Err<unknown>;
        values.push(result.value);
      }
      return ok(values) as unknown as Ok<{ [K in keyof T]: T[K] extends Effect<infer A, unknown> ? A : never }>;
    });
  }

  static allPar<T extends readonly Effect<any, any>[]>(effects: T): Effect<{ [K in keyof T]: T[K] extends Effect<infer A, any> ? A : never }, T[number] extends Effect<any, infer E> ? E : never> {
    return new Effect<any, any>(async (scope, signal) => {
      const results = await Promise.all(effects.map((effect) => effect.thunk(scope, signal)));
      const failed = results.find((result) => !result.ok);
      if (failed) return failed as Err<unknown>;
      return ok(results.map((result) => (result as Ok<unknown>).value)) as unknown as Ok<{ [K in keyof T]: T[K] extends Effect<infer A, unknown> ? A : never }>;
    });
  }

  static forEach<A, B, E>(values: readonly A[], f: (value: A, index: number) => Effect<B, E>): Effect<B[], E | ErrorInfo> {
    return new Effect<B[], E | ErrorInfo>(async (scope, signal) => {
      const out: B[] = [];
      for (let i = 0; i < values.length; i++) {
        let effect: Effect<B, E>;
        try {
          effect = f(values[i], i);
        } catch (e) {
          return err(errorInfo(e));
        }
        const result = await effect.thunk(scope, signal);
        if (!result.ok) return result as any;
        out.push(result.value);
      }
      return ok(out);
    });
  }

  static forEachPar<A, B, E>(values: readonly A[], f: (value: A, index: number) => Effect<B, E>): Effect<B[], E | ErrorInfo> {
    return new Effect<B[], E | ErrorInfo>(async (scope, signal) => {
      let effects: Effect<B, E>[];
      try {
        effects = values.map((value, index) => f(value, index));
      } catch (e) {
        return err(errorInfo(e));
      }
      const results = await Promise.all(effects.map((effect) => effect.thunk(scope, signal)));
      const failed = results.find((result) => !result.ok);
      if (failed) return failed as any;
      return ok(results.map((result) => (result as Ok<B>).value));
    });
  }

  static promise<A>(fn: () => Promise<A>, fallback?: string): Effect<A, ErrorInfo> {
    return Effect.tryPromise(fn, fallback);
  }

  static deferred<A, E = ErrorInfo>(): Deferred<A, E> {
    return new Deferred<A, E>();
  }

  static acquireRelease<A, E = ErrorInfo>(acquire: Effect<A, E>, release: (resource: A) => void | Promise<void>): Effect<A, E> {
    return new Effect(async (scope, signal) => {
      const result = await acquire.thunk(scope, signal);
      if (result.ok) scope.add(() => release(result.value));
      return result;
    });
  }

  static acquireUseRelease<A, B, E>(acquire: Effect<A, E>, use: (a: A) => Effect<B, E>, release: (a: A) => MaybePromise<void>): Effect<B, E | ErrorInfo> {
    return new Effect<B, E | ErrorInfo>(async (scope, signal) => {
      const acquired = await acquire.thunk(scope, signal);
      if (!acquired.ok) return acquired as any;
      const resource = acquired.value;
      let used: Result<B, E | ErrorInfo>;
      try {
        used = (await use(resource).thunk(scope, signal)) as any;
      } catch (e) {
        used = err(errorInfo(e)) as any;
      }
      try {
        await release(resource);
      } catch (e) {
        if (used.ok) errorInfo(e, "release failed");
      }
      return used;
    });
  }

  static race<A, E>(left: Effect<A, E>, right: Effect<A, E>): Effect<A, E | ErrorInfo> {
    return Effect.raceAll([left, right]);
  }

  static raceAll<A, E>(effects: readonly Effect<A, E>[]): Effect<A, E | ErrorInfo> {
    return new Effect<A, E | ErrorInfo>(async (scope, signal) => {
      if (effects.length === 0) return err({ message: "raceAll requires at least one effect" });
      if (signal.aborted) return err(interruptError());
      const children = effects.map(() => deriveController(signal));
      let settled = false;
      let failures = 0;
      let lastError: E | ErrorInfo | undefined;
      return await new Promise<Result<A, E | ErrorInfo>>((resolve) => {
        const finish = (result: Result<A, E | ErrorInfo>, winner?: number) => {
          if (settled) return;
          settled = true;
          for (let i = 0; i < children.length; i++) {
            if (i !== winner) children[i].controller.abort();
            children[i].cleanup();
          }
          resolve(result);
        };
        for (let i = 0; i < effects.length; i++) {
          effects[i].thunk(scope, children[i].controller.signal).then((result) => {
            if (settled) return;
            if (result.ok) {
              finish(result as any, i);
              return;
            }
            failures += 1;
            lastError = (result as Err<E | ErrorInfo>).error;
            if (failures === effects.length) finish(err(lastError as E | ErrorInfo) as any);
          }, (e) => {
            if (settled) return;
            failures += 1;
            lastError = errorInfo(e);
            if (failures === effects.length) finish(err(lastError as E | ErrorInfo) as any);
          });
        }
      });
    });
  }

  pipe<B>(ab: (self: Effect<A, E>) => B): B {
    return ab(this);
  }

  as<B>(value: B): Effect<B, E | ErrorInfo> {
    return this.map(() => value);
  }

  asVoid(): Effect<void, E | ErrorInfo> {
    return this.as(undefined);
  }

  map<B>(f: (value: A) => B): Effect<B, E | ErrorInfo> {
    return new Effect<B, E | ErrorInfo>(async (scope, signal) => {
      const result = await this.thunk(scope, signal);
      if (!result.ok) return result as any;
      try {
        return ok(f(result.value));
      } catch (e) {
        return err(errorInfo(e)) as any;
      }
    });
  }

  flatMap<B, E2>(f: (value: A) => Effect<B, E2>): Effect<B, E | E2 | ErrorInfo> {
    return new Effect<B, E | E2 | ErrorInfo>(async (scope, signal) => {
      const result = await this.thunk(scope, signal);
      if (!result.ok) return result as any;
      try {
        return (await f(result.value).thunk(scope, signal)) as any;
      } catch (e) {
        return err(errorInfo(e)) as any;
      }
    });
  }

  andThen<B, E2>(that: Effect<B, E2>): Effect<B, E | E2 | ErrorInfo> {
    return this.flatMap(() => that);
  }

  zip<B, E2>(that: Effect<B, E2>): Effect<readonly [A, B], E | E2 | ErrorInfo> {
    return this.flatMap((a) => that.map((b) => [a, b] as const));
  }

  tap(f: (value: A) => void | Promise<void> | Effect<unknown, unknown>): Effect<A, E | ErrorInfo> {
    return this.flatMap((value) => toEffect(f(value)).map(() => value));
  }

  tapError(f: (error: E) => void | Promise<void> | Effect<unknown, unknown>): Effect<A, E | ErrorInfo> {
    return new Effect<A, E | ErrorInfo>(async (scope, signal) => {
      const result = await this.thunk(scope, signal);
      if (result.ok) return result;
      const side = await toEffect(f((result as Err<E>).error)).thunk(scope, signal);
      if (!side.ok) return side as any;
      return result as any;
    });
  }

  mapError<E2>(f: (error: E) => E2): Effect<A, E2 | ErrorInfo> {
    return new Effect<A, E2 | ErrorInfo>(async (scope, signal) => {
      const result = await this.thunk(scope, signal);
      if (result.ok) return result;
      try {
        return err(f((result as Err<E>).error) as any) as any;
      } catch (e) {
        return err(errorInfo(e)) as any;
      }
    });
  }

  orElse<B, E2>(that: () => Effect<B, E2>): Effect<A | B, E | E2 | ErrorInfo> {
    return this.catchAll(() => that()) as any;
  }

  timeout(ms: number, message = "operation timed out"): Effect<A, E | ErrorInfo> {
    return new Effect<A, E | ErrorInfo>(async (scope, signal) => {
      if (signal.aborted) return err(interruptError());
      const child = deriveController(signal);
      let timer: any = null;
      const timeout = new Promise<Result<A, E | ErrorInfo>>((resolve) => {
        timer = setTimeout(() => {
          child.controller.abort();
          resolve(err({ message, timeoutMs: ms }));
        }, Math.max(0, ms));
      });
      const result = await Promise.race([this.thunk(scope, child.controller.signal), timeout]);
      if (timer != null) clearTimeout(timer);
      child.cleanup();
      return result as any;
    });
  }

  either(): Effect<Result<A, E>, never> {
    return new Effect<Result<A, E>, never>(async (scope, signal) => ok(await this.thunk(scope, signal)));
  }

  option(): Effect<A | null, never> {
    return new Effect<A | null, never>(async (scope, signal) => {
      const result = await this.thunk(scope, signal);
      return ok(result.ok ? result.value : null);
    });
  }

  catchAll<B, E2>(f: (error: E) => Effect<B, E2>): Effect<A | B, E2 | ErrorInfo> {
    return new Effect<A | B, E2 | ErrorInfo>(async (scope, signal) => {
      const result = await this.thunk(scope, signal);
      if (result.ok) return result;
      try {
        return (await f((result as Err<E>).error).thunk(scope, signal)) as any;
      } catch (e) {
        return err(errorInfo(e)) as any;
      }
    });
  }

  catchTag<TT extends string, A2, E2>(tag: TT, f: (e: Extract<E, { _tag: TT }>) => Effect<A2, E2>): Effect<A | A2, Exclude<E, { _tag: TT }> | E2 | ErrorInfo> {
    return this.catchAll(((error: E) => {
      if (error && typeof error === "object" && (error as any)._tag === tag) return f(error as Extract<E, { _tag: TT }>);
      return Effect.fail(error as Exclude<E, { _tag: TT }>);
    }) as any) as any;
  }

  match<B>(handlers: { readonly onFailure: (error: E) => B; readonly onSuccess: (value: A) => B }): Effect<B, ErrorInfo> {
    return new Effect<B, ErrorInfo>(async (scope, signal) => {
      const result = await this.thunk(scope, signal);
      try {
        return ok(result.ok ? handlers.onSuccess(result.value) : handlers.onFailure((result as Err<E>).error));
      } catch (e) {
        return err(errorInfo(e));
      }
    });
  }

  matchEffect<B, E2, E3>(handlers: { readonly onFailure: (error: E) => Effect<B, E2>; readonly onSuccess: (value: A) => Effect<B, E3> }): Effect<B, E2 | E3 | ErrorInfo> {
    return new Effect<B, E2 | E3 | ErrorInfo>(async (scope, signal) => {
      const result = await this.thunk(scope, signal);
      try {
        const next = result.ok ? handlers.onSuccess(result.value) : handlers.onFailure((result as Err<E>).error);
        return (await next.thunk(scope, signal)) as any;
      } catch (e) {
        return err(errorInfo(e)) as any;
      }
    });
  }

  ensuring(finalizer: Finalizer): Effect<A, E | ErrorInfo> {
    return new Effect<A, E | ErrorInfo>(async (scope, signal) => {
      try {
        return (await this.thunk(scope, signal)) as any;
      } finally {
        try {
          await finalizer();
        } catch (e) {
          return err(errorInfo(e, "finalizer failed")) as any;
        }
      }
    });
  }

  retry(policy: Schedule<A, E>): Effect<A, E | ErrorInfo> {
    return retry(this, policy);
  }

  retryWhile<E2 = E>(predicate: (value: A) => boolean, schedule: Schedule<A, never>): Effect<A, E | ErrorInfo> {
    return new Effect<A, E | ErrorInfo>(async (scope, signal) => {
      let attempt = 1;
      for (;;) {
        if (signal.aborted) return err(interruptError());
        const result = await this.thunk(scope, signal);
        if (signal.aborted) return err(interruptError());
        if (result.ok) {
          let shouldRetry = false;
          try {
            shouldRetry = predicate(result.value);
          } catch (e) {
            return err(errorInfo(e)) as any;
          }
          if (!shouldRetry) return result as any;
          const decision = (schedule as any)({ attempt, value: result.value });
          if (!decision.continue) return result as any;
          if (decision.delayMs > 0) {
            const slept = await Effect.sleep(decision.delayMs).runResult({ scope, signal });
            if (!slept.ok) return slept as any;
          }
          attempt += 1;
          continue;
        }
        const decision = (schedule as any)({ attempt, error: (result as Err<E>).error });
        if (!decision.continue) return result as any;
        if (decision.delayMs > 0) {
          const slept = await Effect.sleep(decision.delayMs).runResult({ scope, signal });
          if (!slept.ok) return slept as any;
        }
        attempt += 1;
      }
    });
  }

  runResult(scope?: Scope): Promise<Result<A, E>>;
  runResult(opts?: RunOptions): Promise<Result<A, E>>;
  async runResult(arg?: Scope | RunOptions): Promise<Result<A, E>> {
    const run = normalizeRunOptions(arg);
    try {
      return await this.thunk(run.scope, run.signal);
    } finally {
      run.cleanup();
    }
  }

  runPromise(scope?: Scope): Promise<A>;
  runPromise(opts?: RunOptions): Promise<A>;
  async runPromise(arg?: Scope | RunOptions): Promise<A> {
    const run = normalizeRunOptions(arg);
    try {
      const result = await this.thunk(run.scope, run.signal);
      if (result.ok) return result.value;
      throw new Error(errorMessage((result as Err<E>).error));
    } finally {
      run.cleanup();
    }
  }

  runScopedPromise(scope?: Scope): Promise<A>;
  runScopedPromise(opts?: RunOptions): Promise<A>;
  runScopedPromise(arg?: Scope | RunOptions): Promise<A> {
    return Effect.scoped(this).runPromise(arg as any);
  }

  static scoped<A, E>(effect: Effect<A, E>): Effect<A, E | ErrorInfo> {
    return new Effect<A, E | ErrorInfo>(async (_outerScope, signal) => {
      const scope = new Scope();
      const cleanup = linkAbort(scope, signal);
      try {
        return (await effect.thunk(scope, scope.signal)) as any;
      } finally {
        cleanup();
        try {
          await scope.close();
        } catch (e) {
          return err(errorInfo(e, "scope finalizer failed")) as any;
        }
      }
    });
  }
}

export type ScheduleDecision = {
  readonly continue: boolean;
  readonly reason: string;
  readonly delayMs: number;
};

export type Schedule<A = unknown, E = unknown> = (input: { readonly attempt: number; readonly value?: A; readonly error?: E }) => ScheduleDecision;

export const Schedule = {
  stop: (reason = "stop"): Schedule => () => ({ continue: false, reason, delayMs: 0 }),
  recurs: (maxRetries: number): Schedule => ({ attempt }) => ({
    continue: attempt <= maxRetries,
    reason: attempt <= maxRetries ? "recurs" : "recurs-exhausted",
    delayMs: 0,
  }),
  recurWhile: <A, E>(predicate: (input: { readonly attempt: number; readonly value?: A; readonly error?: E }) => boolean): Schedule<A, E> => (input) => {
    const cont = predicate(input);
    return { continue: cont, reason: cont ? "recur-while" : "recur-while-done", delayMs: 0 };
  },
  recurUntil: <A, E>(predicate: (input: { readonly attempt: number; readonly value?: A; readonly error?: E }) => boolean): Schedule<A, E> => (input) => {
    const done = predicate(input);
    return { continue: !done, reason: done ? "recur-until-done" : "recur-until", delayMs: 0 };
  },
  exponential: (baseDelayMs: number, maxDelayMs: number): Schedule => ({ attempt }) => ({
    continue: true,
    reason: "exponential",
    delayMs: Math.min(maxDelayMs, Math.max(0, baseDelayMs) * 2 ** Math.max(0, attempt - 1)),
  }),
  jittered: <A, E>(schedule: Schedule<A, E>, jitterMs: number): Schedule<A, E> => (input) => {
    const decision = schedule(input);
    const jitter = Math.max(0, jitterMs);
    return { ...decision, delayMs: Math.round(decision.delayMs + (jitter ? Math.random() * jitter : 0)) };
  },
  tapOutput: <A, E>(schedule: Schedule<A, E>, f: (decision: ScheduleDecision, input: { readonly attempt: number; readonly value?: A; readonly error?: E }) => void): Schedule<A, E> => (input) => {
    const decision = schedule(input);
    f(decision, input);
    return decision;
  },
  whileInput: <A, E>(predicate: (input: { readonly attempt: number; readonly value?: A; readonly error?: E }) => ScheduleDecision): Schedule<A, E> => predicate,
  intersect: <A, E>(left: Schedule<A, E>, right: Schedule<A, E>): Schedule<A, E> => (input) => {
    const a = left(input);
    const b = right(input);
    return {
      continue: a.continue && b.continue,
      reason: !a.continue ? a.reason : b.reason,
      delayMs: Math.max(a.delayMs, b.delayMs),
    };
  },
  union: <A, E>(left: Schedule<A, E>, right: Schedule<A, E>): Schedule<A, E> => (input) => {
    const a = left(input);
    const b = right(input);
    const delayMs = a.continue && b.continue
      ? Math.min(a.delayMs, b.delayMs)
      : a.continue
        ? a.delayMs
        : b.delayMs;
    return {
      continue: a.continue || b.continue,
      reason: a.continue ? a.reason : b.reason,
      delayMs,
    };
  },
  addDelay: <A, E>(schedule: Schedule<A, E>, delayMs: number): Schedule<A, E> => (input) => {
    const decision = schedule(input);
    return { ...decision, delayMs: decision.delayMs + Math.max(0, delayMs) };
  },
};

function retry<A, E>(effect: Effect<A, E>, schedule: Schedule<A, E>): Effect<A, E | ErrorInfo> {
  return new Effect<A, E | ErrorInfo>(async (scope, signal) => {
    let attempt = 1;
    for (;;) {
      if (signal.aborted) return err(interruptError());
      const result = await effect.runResult({ scope, signal });
      if (signal.aborted) return err(interruptError());
      if (result.ok) return result;
      const decision = schedule({ attempt, error: (result as Err<E>).error });
      if (!decision.continue) return result as any;
      if (decision.delayMs > 0) {
        const slept = await Effect.sleep(decision.delayMs).runResult({ scope, signal });
        if (!slept.ok) return slept as any;
      }
      attempt += 1;
    }
  });
}

function toEffect(value: void | Promise<void> | Effect<unknown, unknown>): Effect<unknown, ErrorInfo> {
  if (value instanceof Effect) return value as Effect<unknown, ErrorInfo>;
  if (value && typeof (value as any).then === "function") return Effect.tryPromise(() => value as Promise<void>);
  return Effect.succeed(undefined);
}

function normalizeRunOptions(arg?: Scope | RunOptions): { scope: Scope; signal: AbortSignal; cleanup: () => void } {
  const scope = arg instanceof Scope ? arg : arg?.scope ?? new Scope();
  const external = arg instanceof Scope ? undefined : arg?.signal;
  const cleanup = external ? linkAbort(scope, external) : () => undefined;
  return { scope, signal: scope.signal, cleanup };
}

function linkAbort(scope: Scope, signal: AbortSignal): () => void {
  if (signal.aborted) {
    scope.abort();
    return () => undefined;
  }
  const onAbort = () => scope.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function deriveController(parent: AbortSignal): { controller: InstanceType<typeof AbortController>; cleanup: () => void } {
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort();
    return { controller, cleanup: () => undefined };
  }
  const onAbort = () => controller.abort();
  parent.addEventListener("abort", onAbort, { once: true });
  return { controller, cleanup: () => parent.removeEventListener("abort", onAbort) };
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as any).message === "string") return (error as any).message;
  return String(error ?? "operation failed");
}

export const pipe = <A>(value: A, ...fns: Array<(value: any) => any>): any => fns.reduce((current, fn) => fn(current), value);
