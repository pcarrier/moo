import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");

describe("timeline thinking status", () => {
  test("hides standalone Thinking row during running tool calls", () => {
    expect(timeline).toContain("const hasRunningToolRow = createMemo(() =>");
    expect(timeline).toContain("visibleTimeline().some(isRunningToolTimelineItem)");
    expect(timeline).toContain("const showStandaloneThinking = () =>");
    expect(timeline).toContain("!hasRunningToolRow()");
    expect(timeline).toContain("when={showStandaloneThinking()}");
  });

  test("labels manual compaction failures distinctly", () => {
    expect(timeline).toContain('function compactionTrigger(detail: Record<string, any>): "manual" | "automatic" {');
    expect(timeline).toContain('<strong>{compactionTriggerTitle(props.detail)} compaction failed</strong>');
    expect(timeline).toContain('The model provider rejected the ${trigger} compaction request.');
    expect(timeline).toContain('Try switching to a larger-context model, lowering reasoning effort, or reducing retained history.');
    expect(timeline).toContain('requestPromptTokens');
    expect(timeline).toContain('request cap');
  });


  test("marks manual compact command step-starts as compacting", () => {
    const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
    const step = readFileSync(
      new URL("../../harness/src/commands/step.ts", import.meta.url),
      "utf8",
    );
    const registry = readFileSync(
      new URL("../../harness/src/commands/registry.ts", import.meta.url),
      "utf8",
    );

    expect(registry).toContain("compact: compactCommand");
    expect(step).toContain('stepLifecycleEvents(chatId, mode === "compact")');
    expect(step).toContain('{ kind: "step-start", chatId, compacting: true }');
    expect(state).toContain('if (ev.compacting === true)');
    expect(state).toContain('addToSet(setCompactingChats, compactingChats, ev.chatId);');
  });

  test("labels active compaction as Compacting", () => {
    expect(timeline).toContain('const activeWaitLabel = () => (bag.compacting() ? "Compacting…" : "Thinking…");');
    expect(timeline).toContain('{activeWaitLabel()} {thinkingElapsed()}');
    expect(timeline).toContain('label={bag.compacting() ? "compacting" : "thinking"}');
  });

  test("labels streaming replies as Streaming", () => {
    expect(timeline).toContain(
      "function activeReplyStatusLabel(item: StepItem, compacting: boolean): string {",
    );
    expect(timeline).toContain('if (item.text.trim()) return "Streaming…";');
    expect(timeline).toContain(
      "stepMetaLabel(props.item, props.bag.compacting())",
    );
    expect(timeline).toContain("return activeReplyStatusLabel(item, compacting);");
  });

  test("clears stale compaction when streamed replies arrive", () => {
    expect(state).toContain("A draft event can only come from the real answer stream");
    expect(state).toContain("deleteFromSet(setCompactingChats, compactingChats, cid);");
  });
});
