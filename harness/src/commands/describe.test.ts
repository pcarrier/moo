import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const describeSource = readFileSync(new URL("./describe.ts", import.meta.url), "utf8");

describe("describe trail entries", () => {
  test("selects canonical direct trail facts", () => {
    expect(describeSource).toContain("optional { ?entry agent:title ?title . }");
    expect(describeSource).not.toContain("agent:previousTitle");
    expect(describeSource).toContain("optional { ?entry agent:body ?body . }");
    expect(describeSource).toContain("optional { ?entry agent:summary ?summary . }");
  });

  test("does not load legacy trail payload objects", () => {
    const loadTrailItemsBody = describeSource.slice(
      describeSource.indexOf("async function loadTrailItems"),
      describeSource.indexOf("async function loadTrailStepItems"),
    );
    expect(loadTrailItemsBody).not.toContain("agent:payload");
    expect(loadTrailItemsBody).not.toContain("loadObjectsByHash");
    expect(loadTrailItemsBody).not.toContain("payload?.");
  });

  test("decodes Turtle string literals before returning TrailItem fields", () => {
    expect(describeSource).toContain("function factString(value: unknown): string | null");
    expect(describeSource).toContain("title: factString(row[\"?title\"])");
    expect(describeSource).not.toContain("previousTitle: factString");
    expect(describeSource).toContain("const body = firstPresent(row[\"?body\"], row[\"?summary\"])");
  });
});


describe("describe incremental timeline updates", () => {
  test("selects steps updated after the client's timeline watermark", () => {
    expect(describeSource).toContain("optional { ?step agent:updatedAt ?updatedAt . }");
    expect(describeSource).toContain('ref.at > sinceAt || (ref.type === "step" && (ref.updatedAt ?? 0) > sinceAt)');
    expect(describeSource).toContain('updatedAt: factTimestamp(s["?updatedAt"]) || undefined');
  });
});
