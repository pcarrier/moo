import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compileRunTS } from "./runts";

describe("compileRunTS", () => {
  test("emits JavaScript for TypeScript using Moo ambient types", () => {
    const compiled = compileRunTS("const now: string = await moo.time.nowISO({});\nreturn now;");

    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.js).toContain("async function __runTS__()");
  });

  test("types injected args as any", () => {
    const compiled = compileRunTS("return args.some.deeply.nested.value;");

    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.js).toContain("args.some.deeply.nested.value");
  });

  test("reports TypeScript diagnostics before V8 compilation", () => {
    const compiled = compileRunTS("const bad: number = await moo.time.nowISO({});\nreturn bad;");

    expect(compiled.js).toBe("");
    expect(compiled.diagnostics.join("\n")).toContain("TS2322");
    expect(compiled.diagnostics.join("\n")).toContain("Type 'string' is not assignable to type 'number'");
  });

  test("reports diagnostics using user body line numbers", () => {
    const oneLine = compileRunTS("const bad: string = 1;");
    expect(oneLine.diagnostics[0]).toContain("code:1:7 TS2322");

    const twoLines = compileRunTS("const ok = 1;\nconst bad: string = 1;");
    expect(twoLines.diagnostics[0]).toContain("code:2:7 TS2322");
  });
});


describe("toolRunTS step completion", () => {
  test("finishes the RunTS step even when setup before user code fails", () => {
    const source = readFileSync(new URL("./agent.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("async function toolRunTS("), source.indexOf("async function subagentDepth("));

    expect(body).toContain("const runTsStep = await startRunTSStep(");
    expect(body.indexOf("try {")).toBeLessThan(body.indexOf("startRunTSTraceRoot"));
    expect(body.indexOf("startRunTSTraceRoot")).toBeLessThan(body.indexOf("finishRunTSStep"));
    expect(body.indexOf("finishRunTSStep")).toBeGreaterThan(body.indexOf("} catch"));
    expect(body).toContain('if (missingCode) return { toolText: "error: runTS requires `code`" }');
  });
});


describe("background runTS cancellation wiring", () => {
  test("ambient types expose moo.tools.cancel", () => {
    const compiled = compileRunTS('return await moo.tools.cancel({ id: "step:test" });');

    expect(compiled.diagnostics).toEqual([]);
  });

  test("step command preassigns a runTS step id and reuses it", () => {
    const source = readFileSync(new URL("./commands/step.ts", import.meta.url), "utf8");

    expect(source).toContain('const runTsStepId = host.newId("step")');
    expect(source).toContain("runTsStepId,");
    expect(source).toContain('typeof input.runTsStepId === "string" ? input.runTsStepId : null');
  });

  test("runTS step creation accepts the preassigned id", () => {
    const source = readFileSync(new URL("./agent.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("async function startRunTSStep("), source.indexOf("async function finishRunTSStep("));

    expect(body).toContain("runTsStepId?: string | null");
    expect(body).toContain("stepId: runTsStepId || undefined");
  });

  test("prompt documents cancellation for detached runTS ids", () => {
    const prompt = readFileSync(new URL("./prompt.ts", import.meta.url), "utf8");

    expect(prompt).toContain("moo.tools{cancel}");
    expect(prompt).toContain("await moo.tools.cancel({id})");
  });

  test("Rust driver queues chat runs while foreground tools background", () => {
    const source = readFileSync(new URL("../../src/driver.rs", import.meta.url), "utf8");

    expect(source).toContain("struct QueuedChatRun");
    expect(source).toContain("static QUEUED");
    expect(source).toContain("push_back(QueuedChatRun { pool, bundle, state })");
    expect(source).toContain("finish_current_and_start_next(&task_chat_id, run_id);");
    expect(source).toContain("requested_by: String");
    expect(source).toContain('"requestedBy": requested_by');
  });

  test("Rust runTS completions avoid empty tool call ids", () => {
    const driver = readFileSync(new URL("../../src/driver.rs", import.meta.url), "utf8");
    const ws = readFileSync(new URL("../../src/ws.rs", import.meta.url), "utf8");

    expect(driver).toContain("fn runts_tool_call_id(value: &Value) -> String");
    expect(driver).toContain("unwrap_or_else(|| runts_tool_step_id(value))");
    expect(driver).toContain('"toolCallId": runts_tool_call_id(&value)');
    expect(ws).toContain("if tool_call_id.is_empty()");
    expect(ws).toContain("tool_call_id = step_id.clone();");
  });
});
