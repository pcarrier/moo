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
