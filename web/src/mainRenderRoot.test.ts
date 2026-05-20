import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");

describe("app render root", () => {
  test("keeps the Solid app under a dedicated root so body portals cannot recurse", () => {
    expect(main).toContain('const root = document.createElement("div");');
    expect(main).toContain("mount.replaceWith(root);");
    expect(main).toContain("render(() => <Root />, root);");
    expect(main).not.toContain("render(() => <Root />, document.body);");
    expect(timeline).toContain("<Portal mount={document.body}>");
  });
});
