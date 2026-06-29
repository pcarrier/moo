import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const prompt = readFileSync(new URL("./prompt.ts", import.meta.url), "utf8");

describe("task prompt", () => {
  test("keeps task tracking optional and lightweight", () => {
    expect(prompt).toContain("tasks: optional");
    expect(prompt).toContain("use `moo.tasks` only for substantial multi-step work");
    expect(prompt).toContain("Cut big problems into small orthogonal pieces and delegate them to subagents with tasks");
    expect(prompt).toContain("moo.tasks{list,add,update,done,drop,setValidation,validate,patch,clear}");
    expect(prompt).not.toContain("immediately mark meaningful completions/blockers before reporting");
    expect(prompt).not.toContain("the current task list is shown to you separately");
  });
});

describe("filesystem editing prompt", () => {
  test("documents partialRead and patch guidance", () => {
    expect(prompt).toContain("partialRead({path:string,lineRanges:[number,number][],numbered?:boolean})");
    expect(prompt).toContain("1-based inclusive line ranges; sorted/collapsed overlaps");
    expect(prompt).toContain("patch({path:string,diff:string})→Promise<{status:string,output?:string|null}>");
    expect(prompt).toContain("delete({path:string,recursive?:boolean})→Promise<{status:string,output?:string|null}>");
    expect(prompt).toContain("recursive:true is required for non-empty dirs");
    expect(prompt).toContain("applies unified/context patch to existing file and throws on failure");
    expect(prompt).toContain("delete failures return status=\'failed\' plus output");
    expect(prompt).toContain("patch failures throw, so retry only after inspecting context");
    expect(prompt).toContain("prefer moo.fs.patch for patch operations on existing files");
  });
});

describe("steering prompt", () => {
  test("keeps AGENTS.md steering before the API reference", () => {
    const steering = prompt.indexOf("User/project steering (AGENTS.md)");
    const apiReference = prompt.indexOf("API types: ObjectInput");
    expect(steering).toBeGreaterThan(-1);
    expect(apiReference).toBeGreaterThan(-1);
    expect(steering).toBeLessThan(apiReference);
  });
});
