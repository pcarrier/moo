import { describe, expect, test } from "bun:test";
import { mergeTokenProgress, type TokenProgressValue } from "./tokenProgress";

const tokens = (used: number): TokenProgressValue => ({
  used,
  budget: 100_000,
  threshold: 80_000,
  fraction: used / 100_000,
});

describe("mergeTokenProgress", () => {
  test("keeps active streaming progress when describe returns stale usage", () => {
    const live = tokens(70_000);
    expect(mergeTokenProgress(live, tokens(40_000), true)).toBe(live);
  });

  test("accepts lower counts when the chat is inactive so persisted final usage applies", () => {
    expect(mergeTokenProgress(tokens(70_000), tokens(40_000), false)).toEqual(tokens(40_000));
  });

  test("accepts higher counts while active", () => {
    expect(mergeTokenProgress(tokens(40_000), tokens(70_000), true)).toEqual(tokens(70_000));
  });

  test("accepts explicit resets while active", () => {
    expect(mergeTokenProgress(tokens(70_000), tokens(40_000), true, { reset: true })).toEqual(tokens(40_000));
  });
});
