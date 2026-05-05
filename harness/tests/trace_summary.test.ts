import { describe, expect, test } from "bun:test";
import { summarizeTraceValue } from "../src/moo";

describe("trace value summaries", () => {
  test("include function source instead of a placeholder", () => {
    function sample(value: string) {
      return value.toUpperCase();
    }

    const summary = summarizeTraceValue({ fn: sample }) as any;

    expect(summary.fn).toMatchObject({
      type: "function",
      name: "sample",
      async: false,
    });
    expect(summary.fn.source).toContain("function sample");
    expect(summary.fn.source).toContain("toUpperCase");
  });

  test("include async function metadata", () => {
    const summary = summarizeTraceValue(async function loadThing() {
      return 1;
    }) as any;

    expect(summary.type).toBe("function");
    expect(summary.name).toBe("loadThing");
    expect(summary.async).toBe(true);
    expect(summary.source).toContain("async function loadThing");
  });

  test("do not truncate large function sources", () => {
    const fn = new Function("return '" + "x".repeat(2_000) + "';");
    const summary = summarizeTraceValue(fn) as any;

    expect(summary.source.length).toBeGreaterThan(2_000);
    expect(summary.source).toContain("x".repeat(2_000));
  });

  test("never redact object keys", () => {
    const summary = summarizeTraceValue({ authorization: "Bearer visible", token: "abc123" }) as any;

    expect(summary.authorization).toBe("Bearer visible");
    expect(summary.token).toBe("abc123");
  });

  test("trace input summaries do not mark themselves redacted", () => {
    const data = { input: summarizeTraceValue([{ token: "abc123" }]) } as any;

    expect(data.redacted).toBeUndefined();
    expect(data.input[0].token).toBe("abc123");
  });

  test("indirects large strings when object storage is available", () => {
    const previous = (globalThis as any).__op_object_put;
    const writes: Array<{ kind: string; content: string }> = [];
    (globalThis as any).__op_object_put = (kind: string, content: string) => {
      writes.push({ kind, content });
      return "sha256:" + "a".repeat(64);
    };
    try {
      const large = "x".repeat(9_000);
      const summary = summarizeTraceValue({ large }) as any;

      expect(summary.large).toEqual({
        type: "string",
        chars: 9_000,
        bytes: 9_000,
        hash: "sha256:" + "a".repeat(64),
        objectKind: "trace:String",
      });
      expect(writes).toEqual([{ kind: "trace:String", content: large }]);
    } finally {
      if (previous) (globalThis as any).__op_object_put = previous;
      else delete (globalThis as any).__op_object_put;
    }
  });

  test("keeps large strings inline when object storage is unavailable", () => {
    const previous = (globalThis as any).__op_object_put;
    delete (globalThis as any).__op_object_put;
    try {
      const large = "x".repeat(9_000);
      expect(summarizeTraceValue(large)).toBe(large);
    } finally {
      if (previous) (globalThis as any).__op_object_put = previous;
    }
  });
});
