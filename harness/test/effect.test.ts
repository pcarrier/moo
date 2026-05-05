import { describe, expect, test } from "bun:test";
import { Effect, Schedule, Scope, TaggedError } from "../src/core/effect";

test("Effect.gen happy path", async () => {
  const value = await Effect.gen(function* () {
    const a = yield* Effect.succeed(1);
    const b = yield* Effect.tryPromise(() => Promise.resolve(a + 1));
    return a + b;
  }).runPromise();
  expect(value).toBe(3);
});

test("Effect.gen short-circuits failed effects", async () => {
  const result = await Effect.gen(function* () {
    yield* Effect.fail({ message: "nope" });
    return 1;
  }).runResult();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toBe("nope");
});

test("Effect.gen converts thrown generator errors to failure", async () => {
  const result = await Effect.gen(function* () {
    throw new Error("boom");
  }).runResult();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toBe("boom");
});

test("acquireRelease finalizer runs on scoped success and failure", async () => {
  const events: string[] = [];
  const success = await Effect.scoped(
    Effect.acquireRelease(Effect.succeed("resource"), (r) => events.push(`release:${r}`)).map(() => "ok"),
  ).runPromise();
  expect(success).toBe("ok");
  expect(events).toEqual(["release:resource"]);

  const failed = await Effect.scoped(
    Effect.acquireRelease(Effect.succeed("bad"), (r) => events.push(`release:${r}`)).andThen(Effect.fail({ message: "fail" })),
  ).runResult();
  expect(failed.ok).toBe(false);
  expect(events).toEqual(["release:resource", "release:bad"]);
});

test("acquireUseRelease releases on use failure and swallows release errors on success", async () => {
  let released = 0;
  const failed = await Effect.acquireUseRelease(
    Effect.succeed("r"),
    () => Effect.fail({ message: "use failed" }),
    () => {
      released += 1;
    },
  ).runResult();
  expect(failed.ok).toBe(false);
  expect(released).toBe(1);

  const success = await Effect.acquireUseRelease(
    Effect.succeed("r"),
    () => Effect.succeed(42),
    () => {
      released += 1;
      throw new Error("ignored");
    },
  ).runPromise();
  expect(success).toBe(42);
  expect(released).toBe(2);
});

test("Effect.race faster success wins and aborts loser", async () => {
  let aborted = false;
  const slow = new Effect<string, never>(async (_scope, signal) => {
    signal.addEventListener("abort", () => {
      aborted = true;
    });
    return await Effect.sleep(1_000).as("slow").runResult({ signal });
  });
  const value = await Effect.race(Effect.sleep(5).as("fast"), slow).runPromise();
  expect(value).toBe("fast");
  expect(aborted).toBe(true);
});

test("Effect.timeout aborts inner effect", async () => {
  let aborted = false;
  const inner = new Effect<string, never>(async (_scope, signal) => {
    signal.addEventListener("abort", () => {
      aborted = true;
    });
    return await Effect.sleep(1_000).as("late").runResult({ signal });
  });
  const result = await inner.timeout(5).runResult();
  expect(result.ok).toBe(false);
  expect(aborted).toBe(true);
});

test("runPromise external AbortSignal cancels a long sleep", async () => {
  const controller = new AbortController();
  const promise = Effect.sleep(1_000).runPromise({ signal: controller.signal });
  controller.abort();
  await expect(promise).rejects.toThrow("interrupted");
});

test("TaggedError and catchTag handle only matching tags", async () => {
  const handled = await Effect.fail(new TaggedError("Expected", "expected"))
    .catchTag("Expected", () => Effect.succeed("handled"))
    .runPromise();
  expect(handled).toBe("handled");

  const unhandled = await Effect.fail(new TaggedError("Other", "other"))
    .catchTag("Expected", () => Effect.succeed("handled"))
    .runResult();
  expect(unhandled.ok).toBe(false);
  if (!unhandled.ok) expect((unhandled.error as any)._tag).toBe("Other");
});

test("Schedule.recurWhile and tapOutput are invoked", async () => {
  const seen: number[] = [];
  const decisions: string[] = [];
  let current = 0;
  const effect = Effect.sync(() => ++current).retryWhile(
    (value) => value < 3,
    Schedule.tapOutput(
      Schedule.recurWhile(({ value }) => (value ?? 0) < 3),
      (decision, input) => {
        seen.push(input.value ?? -1);
        decisions.push(decision.reason);
      },
    ),
  );
  const value = await effect.runPromise();
  expect(value).toBe(3);
  expect(seen).toEqual([1, 2]);
  expect(decisions).toEqual(["recur-while", "recur-while"]);
});
