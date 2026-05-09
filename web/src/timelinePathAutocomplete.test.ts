import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const autocomplete = readFileSync(new URL("./timeline/autocomplete.ts", import.meta.url), "utf8");
const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");

describe("autocomplete path autocomplete", () => {
  test("detects absolute @path queries without requiring a worktree base", () => {
    expect(autocomplete).toContain('const absolute = rawBeforeCursor.startsWith("/");');
    expect(autocomplete).toContain('if (!absolute && !basePath) return null;');
    expect(autocomplete).not.toContain('if (!basePath) return null;\n  const safeCursor');
  });

  test("lists absolute directories from the filesystem root", () => {
    expect(autocomplete).toContain('const listDir = absolute');
    expect(autocomplete).toContain('? cleanDir ? "/" + cleanDir : "/"');
    expect(autocomplete).toContain('query: absolute ? rawBeforeCursor : rawBeforeCursor.replace(/^\\/+/, ""),');
  });

  test("keeps absolute suggestions absolute and disables worktree fuzzy search", () => {
    expect(autocomplete).toContain('context.absolute ? "absolute" : "relative"');
    expect(autocomplete).toContain('context.absolute,\n        entry,');
    expect(autocomplete).toContain('const displayPath = absolute');
    expect(autocomplete).toContain('? cleanPath.replace(/\\/+/g, "/")');
    expect(autocomplete).toContain('!context.absolute &&\n    context.query.length >= PATH_AUTOCOMPLETE_FUZZY_MIN_QUERY');
    expect(timeline).toContain('!context.absolute &&\n          !suppressFuzzy &&');
  });
});
