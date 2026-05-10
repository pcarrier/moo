import { describe, expect, test } from "bun:test";
import { startRunJSTraceRoot, traceJsonValue } from "../src/moo";

describe("trace value serialization", () => {
  test("include function source instead of a placeholder", () => {
    function sample(value: string) {
      return value.toUpperCase();
    }

    const summary = traceJsonValue({ fn: sample }) as any;

    expect(summary.fn).toMatchObject({
      type: "function",
      name: "sample",
      async: false,
    });
    expect(summary.fn.source).toContain("function sample");
    expect(summary.fn.source).toContain("toUpperCase");
  });

  test("include async function metadata", () => {
    const summary = traceJsonValue(async function loadThing() {
      return 1;
    }) as any;

    expect(summary.type).toBe("function");
    expect(summary.name).toBe("loadThing");
    expect(summary.async).toBe(true);
    expect(summary.source).toContain("async function loadThing");
  });

  test("do not truncate large function sources", () => {
    const fn = new Function("return '" + "x".repeat(2_000) + "';");
    const summary = traceJsonValue(fn) as any;

    expect(summary.source.length).toBeGreaterThan(2_000);
    expect(summary.source).toContain("x".repeat(2_000));
  });

  test("never redact object keys", () => {
    const summary = traceJsonValue({ authorization: "Bearer visible", token: "abc123" }) as any;

    expect(summary.authorization).toBe("Bearer visible");
    expect(summary.token).toBe("abc123");
  });

  test("trace input serialization does not mark itself redacted", () => {
    const data = { input: traceJsonValue([{ token: "abc123" }]) } as any;

    expect(data.redacted).toBeUndefined();
    expect(data.input[0].token).toBe("abc123");
  });

  test("keeps large strings inline when object storage is available", () => {
    const previous = (globalThis as any).__op_object_put;
    const writes: Array<{ kind: string; content: string }> = [];
    (globalThis as any).__op_object_put = (kind: string, content: string) => {
      writes.push({ kind, content });
      return "sha256:" + "a".repeat(64);
    };
    try {
      const large = "x".repeat(9_000);
      const summary = traceJsonValue({ large }) as any;

      expect(summary.large).toBe(large);
      expect(writes).toEqual([]);
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
      expect(traceJsonValue(large)).toBe(large);
    } finally {
      if (previous) (globalThis as any).__op_object_put = previous;
    }
  });

  test("serializes binary bytes as base64 without redaction", () => {
    expect(traceJsonValue(new Uint8Array([1, 2, 255]))).toEqual({ type: "Uint8Array", encoding: "base64", data: "AQL/" });
    expect(traceJsonValue(new Uint8Array([1, 2]))).toEqual({ type: "Uint8Array", encoding: "base64", data: "AQI=" });
    expect(traceJsonValue(new Uint8Array([1]))).toEqual({ type: "Uint8Array", encoding: "base64", data: "AQ==" });
    expect(traceJsonValue(new ArrayBuffer(0))).toEqual({ type: "ArrayBuffer", encoding: "base64", data: "" });
  });

  test("serializes cycles without redaction markers", () => {
    const value: any = { token: "abc123" };
    value.self = value;
    expect(traceJsonValue(value)).toEqual({ token: "abc123", self: "[Circular]" });
  });
});


describe("trace root inference", () => {
  test("ensures chat root and step span for chat step attachment points", async () => {
    const previousEnsure = (globalThis as any).__op_trace_ensure_root;
    const previousEnsureSpan = (globalThis as any).__op_trace_ensure_span;
    const previousStart = (globalThis as any).__op_trace_start_root;
    const ensured: any[] = [];
    const ensuredSpans: any[] = [];
    (globalThis as any).__op_trace_ensure_root = (raw: string) => {
      ensured.push(JSON.parse(raw));
    };
    (globalThis as any).__op_trace_ensure_span = (raw: string) => {
      ensuredSpans.push(JSON.parse(raw));
    };
    (globalThis as any).__op_trace_start_root = (parentId: string | null) => JSON.stringify({ traceId: "trace:test", id: "trace:test", parentId });
    try {
      await startRunJSTraceRoot("step:test", { chatId: "chat:test", label: "Run JS", title: "Trace Chat" });

      expect(ensured).toHaveLength(1);
      expect(ensured[0]).toMatchObject({ id: "chat:chat:test", chatId: "chat:test", kind: "chat", name: "Trace Chat", data: { rootChoice: "chat-for-step-parent" } });
      expect(ensuredSpans).toHaveLength(1);
      expect(ensuredSpans[0]).toMatchObject({ id: "step:test", parentId: "chat:chat:test", chatId: "chat:test", kind: "step", name: "Run JS", data: { rootChoice: "chat-step-parent" } });
    } finally {
      if (previousEnsure) (globalThis as any).__op_trace_ensure_root = previousEnsure;
      else delete (globalThis as any).__op_trace_ensure_root;
      if (previousEnsureSpan) (globalThis as any).__op_trace_ensure_span = previousEnsureSpan;
      else delete (globalThis as any).__op_trace_ensure_span;
      if (previousStart) (globalThis as any).__op_trace_start_root = previousStart;
      else delete (globalThis as any).__op_trace_start_root;
    }
  });

  test("falls back to a missing-parent root when a step lacks chat context", async () => {
    const previousEnsure = (globalThis as any).__op_trace_ensure_root;
    const previousEnsureSpan = (globalThis as any).__op_trace_ensure_span;
    const previousStart = (globalThis as any).__op_trace_start_root;
    const ensured: any[] = [];
    const ensuredSpans: any[] = [];
    (globalThis as any).__op_trace_ensure_root = (raw: string) => {
      ensured.push(JSON.parse(raw));
    };
    (globalThis as any).__op_trace_ensure_span = (raw: string) => {
      ensuredSpans.push(JSON.parse(raw));
    };
    (globalThis as any).__op_trace_start_root = () => JSON.stringify({ traceId: "trace:test", id: "trace:test" });
    try {
      await startRunJSTraceRoot("step:test", { label: "Run JS" });

      expect(ensured).toHaveLength(1);
      expect(ensured[0]).toMatchObject({ id: "step:test", kind: "missing-parent", name: "Run JS", data: { rootChoice: "fallback-missing-step-parent" } });
      expect(ensuredSpans).toEqual([]);
    } finally {
      if (previousEnsure) (globalThis as any).__op_trace_ensure_root = previousEnsure;
      else delete (globalThis as any).__op_trace_ensure_root;
      if (previousEnsureSpan) (globalThis as any).__op_trace_ensure_span = previousEnsureSpan;
      else delete (globalThis as any).__op_trace_ensure_span;
      if (previousStart) (globalThis as any).__op_trace_start_root = previousStart;
      else delete (globalThis as any).__op_trace_start_root;
    }
  });
});
