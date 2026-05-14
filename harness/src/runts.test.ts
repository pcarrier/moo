import { describe, expect, test } from "bun:test";
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
