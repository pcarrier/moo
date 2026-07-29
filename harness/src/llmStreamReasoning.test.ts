import { describe, expect, test } from "bun:test";
import { reasoningPartPrefix } from "./llm_stream";

describe("LLM stream reasoning parts", () => {
  test("separates adjacent reasoning summary parts", () => {
    expect(reasoningPartPrefix("**Formulating PR comment**", "**Preparing review**"))
      .toBe("\n\n");
  });

  test("does not add a separator when either side already supplies one", () => {
    expect(reasoningPartPrefix("first\n", "second")).toBe("");
    expect(reasoningPartPrefix("first", "\nsecond")).toBe("");
    expect(reasoningPartPrefix("", "first")).toBe("");
  });
});
