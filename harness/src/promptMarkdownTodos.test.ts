import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const prompt = readFileSync(new URL("./prompt.ts", import.meta.url), "utf8");

describe("TODO Markdown prompt", () => {
  test("tells agents to use Markdown in TODO text and notes", () => {
    expect(prompt).toContain("TODO text/notes render as Markdown");
    expect(prompt).toContain("use MD for code, links, lists, and emphasis when helpful");
  });
});
