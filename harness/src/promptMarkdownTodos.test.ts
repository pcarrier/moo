import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const prompt = readFileSync(new URL("./prompt.ts", import.meta.url), "utf8");

describe("TODO prompt", () => {
  test("keeps TODO tracking optional and lightweight", () => {
    expect(prompt).toContain("todos: optional");
    expect(prompt).toContain("use `moo.todos` only for substantial multi-step work");
    expect(prompt).not.toContain("immediately mark meaningful completions/blockers before reporting");
    expect(prompt).not.toContain("the current TODO list is shown to you separately");
  });
});

describe("filesystem editing prompt", () => {
  test("documents readLines and applyPatch guidance", () => {
    expect(prompt).toContain("readLines(path:string,ranges:[number,number][],opts?:{numbered?:boolean})");
    expect(prompt).toContain("1-based inclusive ranges; sorted/collapsed overlaps");
    expect(prompt).toContain("no `applyPatch` helper in runJS");
    expect(prompt).toContain("pass patch text via `args`");
    expect(prompt).toContain("git apply --check <file>");
    expect(prompt).toContain("git apply <file>");
  });
});
