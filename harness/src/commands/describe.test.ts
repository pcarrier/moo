import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compactionDisplayMetadata, compactionLayerDedupeKey } from "./describe";

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

  test("loads complete trail history outside the loaded timeline", () => {
    expect(describeSource).not.toContain("ALL_TRAILS_LIMIT");
    expect(describeSource).toContain("loadTrailEntryRows(c, 0)");
    expect(describeSource).toContain("loadTrailItems(c, trailEntries, 0)");
    expect(describeSource).toContain("loadStepRowsByKind(\n      c,\n      \"agent:Subagent\",");
    expect(describeSource).toContain("trail: {\n      items: trailTimelineItems ?? [],\n      limit: 0,");
    expect(describeSource).not.toContain("SUBAGENT_TRAIL_INDEX_LIMIT");
  });
});


describe("describe incremental timeline updates", () => {
  test("selects steps updated after the client's timeline watermark", () => {
    expect(describeSource).toContain("optional { ?step agent:updatedAt ?updatedAt . }");
    expect(describeSource).toContain("ref.at > sinceAt ||");
    expect(describeSource).toContain(
      '(ref.type === "step" && (ref.updatedAt ?? 0) > sinceAt)',
    );
    expect(describeSource).toContain('updatedAt: factTimestamp(s["?updatedAt"]) || undefined');
  });
});


describe("describe reply reasoning", () => {
  test("returns persisted reasoning content on reply timeline items", () => {
    expect(describeSource).toContain("const reasoningContent = payload?.value?.reasoningContent");
    expect(describeSource).toContain("item.reasoningContent = reasoningContent");
  });
});


describe("describe compaction rows", () => {
  test("dedupes patched compaction layers despite changed post-token metadata", () => {
    const base = {
      summary: "Earlier work. Next action: run checks.",
      throughAt: 1_000,
      at: 2_000,
      parent: "sha256:parent",
      trigger: "automatic",
      draftId: "draft-compact",
      promptTokens: 239_000,
      tokenBudget: 400_000,
      tokenThreshold: 200_000,
    };

    expect(compactionLayerDedupeKey({ ...base })).toBe(
      compactionLayerDedupeKey({
        ...base,
        at: base.at + 201,
        postPromptTokens: 800,
      }),
    );
    expect(compactionLayerDedupeKey({ ...base })).not.toBe(
      compactionLayerDedupeKey({ ...base, summary: "Different summary" }),
    );
  });

  test("derives summary token metadata for legacy compaction layers", () => {
    expect(
      compactionDisplayMetadata({
        summary: "12345678",
        promptTokens: 100,
        postPromptTokens: 40,
      }),
    ).toEqual({
      promptTokens: 100,
      postPromptTokens: 40,
      summaryTokens: 2,
    });
  });

  test("preserves token deltas when a real step has the pre-patch payload", () => {
    expect(
      compactionDisplayMetadata(
        { promptTokens: 239_000, tokenBudget: 400_000, summary: "short" },
        {
          promptTokens: 239_000,
          postPromptTokens: 800,
          summaryTokens: 120,
          tokenBudget: 400_000,
          availableTokens: 0,
          compactionsInARow: 2,
        },
      ),
    ).toEqual({
      promptTokens: 239_000,
      postPromptTokens: 800,
      summaryTokens: 120,
      tokenBudget: 400_000,
      availableTokens: 0,
      compactionsInARow: 2,
    });
  });
});
