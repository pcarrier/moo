import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { reduceStepDriverState } from "../src/driver/step";

describe("step driver compaction", () => {
  test("manual compaction success resumes the agent loop", () => {
    const next = reduceStepDriverState(
      { chatId: "chat-1", mode: "compact", phase: "startLoop" },
      { type: "Started", started: { kind: "loop", provider: { name: "openai" }, mode: "resume" } },
    );

    expect(next.phase).toBe("prepare");
    expect(next.mode).toBe("resume");
    expect(next.provider).toEqual({ name: "openai" });
  });

  test("manual compaction success does not persist a status reply", () => {
    const source = readFileSync(new URL("../src/commands/step.ts", import.meta.url), "utf8");

    expect(source).toContain('if (result === "compacted")');
    expect(source).toContain('return { ok: true, value: { kind: "loop", provider, mode: "resume" } };');
    expect(source).not.toContain("compacted older turns into a summary");
  });
});
