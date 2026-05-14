import { describe, expect, test } from "bun:test";
import { finishRunTSTraceRoot, startRunTSTraceRoot, traceJsonValue } from "../src/moo";

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
    const previousCurrent = (globalThis as any).__op_trace_current;
    const previousEnter = (globalThis as any).__op_trace_enter;
    const ensured: any[] = [];
    const ensuredSpans: any[] = [];
    (globalThis as any).__op_trace_ensure_root = (raw: string) => {
      ensured.push(JSON.parse(raw));
    };
    (globalThis as any).__op_trace_ensure_span = (raw: string) => {
      ensuredSpans.push(JSON.parse(raw));
    };
    (globalThis as any).__op_trace_current = () => JSON.stringify({ id: "traceevt:tool", traceId: "chattrace:chat:test", rootId: "chattrace:chat:test", parentId: "traceevt:tool" });
    (globalThis as any).__op_trace_enter = (raw: string) => JSON.stringify({ traceId: JSON.parse(raw).rootId, rootId: JSON.parse(raw).rootId, id: JSON.parse(raw).id, parentId: JSON.parse(raw).id });
    try {
      await startRunTSTraceRoot("step:test", { chatId: "chat:test", label: "Run TS", title: "Trace Chat" });

      expect(ensured).toHaveLength(1);
      expect(ensured[0]).toMatchObject({ id: "chattrace:chat:test", chatId: "chat:test", kind: "chat", name: "Trace Chat", data: { source: "chat" } });
      expect(ensuredSpans).toHaveLength(1);
      expect(ensuredSpans[0]).toMatchObject({ id: "step:test", parentId: "traceevt:tool", chatId: "chat:test", kind: "step", name: "Run TS" });
    } finally {
      if (previousCurrent) (globalThis as any).__op_trace_current = previousCurrent;
      else delete (globalThis as any).__op_trace_current;
      if (previousEnsure) (globalThis as any).__op_trace_ensure_root = previousEnsure;
      else delete (globalThis as any).__op_trace_ensure_root;
      if (previousEnsureSpan) (globalThis as any).__op_trace_ensure_span = previousEnsureSpan;
      else delete (globalThis as any).__op_trace_ensure_span;
      if (previousEnter) (globalThis as any).__op_trace_enter = previousEnter;
      else delete (globalThis as any).__op_trace_enter;
    }
  });

  test("finishes only the active step span when runTS completes", async () => {
    const previousCurrent = (globalThis as any).__op_trace_current;
    const previousGet = (globalThis as any).__op_trace_get;
    const previousFinish = (globalThis as any).__op_trace_finish;
    const previousLeave = (globalThis as any).__op_trace_leave;
    const finished: any[] = [];
    (globalThis as any).__op_trace_current = () => JSON.stringify({ id: "step:test", traceId: "chattrace:chat:test", rootId: "chattrace:chat:test", parentId: "step:test" });
    (globalThis as any).__op_trace_get = (raw: string) => {
      const args = JSON.parse(raw || "{}");
      const id = args.id || args.traceId;
      if (id !== "step:test") return null;
      return JSON.stringify({ id, parentId: "chattrace:chat:test", rootId: "chattrace:chat:test", rootKind: "chat", data: { label: "Run TS" } });
    };
    (globalThis as any).__op_trace_finish = (id: string, status: string, dataJson: string) => {
      finished.push({ id, status, data: JSON.parse(dataJson || "{}") });
      return "true";
    };
    (globalThis as any).__op_trace_leave = () => {};
    try {
      const ok = await finishRunTSTraceRoot({ id: "step:test", resultHash: "sha256:result", status: "ok" });

      expect(ok).toBe(true);
      expect(finished.map((row) => row.id)).toEqual(["step:test"]);
      expect(finished.every((row) => row.status === "ok")).toBe(true);
      expect(finished[0].data).toMatchObject({ label: "Run TS", resultHash: "sha256:result" });
    } finally {
      if (previousCurrent) (globalThis as any).__op_trace_current = previousCurrent;
      else delete (globalThis as any).__op_trace_current;
      if (previousGet) (globalThis as any).__op_trace_get = previousGet;
      else delete (globalThis as any).__op_trace_get;
      if (previousFinish) (globalThis as any).__op_trace_finish = previousFinish;
      else delete (globalThis as any).__op_trace_finish;
      if (previousLeave) (globalThis as any).__op_trace_leave = previousLeave;
      else delete (globalThis as any).__op_trace_leave;
    }
  });

  test("falls back to a missing-parent root when a step lacks chat context", async () => {
    const previousEnsure = (globalThis as any).__op_trace_ensure_root;
    const previousEnsureSpan = (globalThis as any).__op_trace_ensure_span;
    const previousCurrent = (globalThis as any).__op_trace_current;
    const previousEnter = (globalThis as any).__op_trace_enter;
    const ensured: any[] = [];
    const ensuredSpans: any[] = [];
    (globalThis as any).__op_trace_ensure_root = (raw: string) => {
      ensured.push(JSON.parse(raw));
    };
    (globalThis as any).__op_trace_ensure_span = (raw: string) => {
      ensuredSpans.push(JSON.parse(raw));
    };
    (globalThis as any).__op_trace_current = () => null;
    (globalThis as any).__op_trace_enter = (raw: string) => JSON.stringify({ traceId: JSON.parse(raw).rootId, rootId: JSON.parse(raw).rootId, id: JSON.parse(raw).id });
    try {
      await startRunTSTraceRoot("step:test", { label: "Run TS" });

      expect(ensured).toHaveLength(1);
      expect(ensured[0]).toMatchObject({ id: "step:test", kind: "system", name: "Run TS", data: { label: "Run TS" } });
      expect(ensuredSpans).toEqual([]);
    } finally {
      if (previousEnsure) (globalThis as any).__op_trace_ensure_root = previousEnsure;
      else delete (globalThis as any).__op_trace_ensure_root;
      if (previousEnsureSpan) (globalThis as any).__op_trace_ensure_span = previousEnsureSpan;
      else delete (globalThis as any).__op_trace_ensure_span;
      if (previousCurrent) (globalThis as any).__op_trace_current = previousCurrent;
      else delete (globalThis as any).__op_trace_current;
      if (previousEnter) (globalThis as any).__op_trace_enter = previousEnter;
      else delete (globalThis as any).__op_trace_enter;
    }
  });
});
