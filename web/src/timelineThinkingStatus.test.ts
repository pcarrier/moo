import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";

const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
const css = readStylesheetForTest();

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
    expect(timeline).toContain('if (item.reasoningContent?.trim()) return "Streaming…";');
    expect(timeline).toContain(
      "stepMetaLabel(props.item, props.bag.compacting())",
    );
    expect(timeline).toContain("return activeReplyStatusLabel(item, compacting);");
  });

  test("aligns thought and dismissed timeline boxes", () => {
    expect(css).toContain(`.conversation-main > .timeline {
  --timeline-padding: 0.45rem 0.65rem;
  --timeline-gap: 0.32rem;
  flex: 1 1 0;`);
    expect(css).toContain(`  padding: var(--timeline-padding, 0.2em 0.5em);
  display: flex;
  flex-direction: column;
  gap: var(--timeline-gap, 0.08em);`);
    expect(css).toContain(`.reply-thinking {
  align-self: stretch;
  inline-size: 100%;
  min-inline-size: 0;
  margin: 0;
  padding: 0.32rem 0.5rem;`);
    expect(css).toContain(`.reply-thinking > summary {
  display: flex;
  align-items: center;
  gap: 0.45em;
  inline-size: 100%;
  min-inline-size: 0;`);
    expect(css).toContain(`.dismissed-block > summary {
  box-sizing: border-box;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.45em;`);
    expect(css).toContain(`.dismissed-body {
  display: flex;
  flex-direction: column;
  gap: 0.32rem;
  padding: 0 0.5rem 0.5rem 1.7rem;
}

.dismissed-body .step {
  align-self: stretch;`);
  });

  test("renders streamed model thinking as separate thought boxes", () => {
    const utils = readFileSync(new URL("./timeline/utils.ts", import.meta.url), "utf8");

    expect(utils).toContain('| { kind: "thought"; item: StepItem }');
    expect(utils).toContain("export function timelineThoughtKey(item: StepItem): string {");
    expect(utils).toContain('previousThought?.kind === "thought"');
    expect(utils).toContain("if (hasReplyReasoning(item)) keys.push(timelineThoughtKey(item));");
    expect(timeline).toContain('entry.kind === "thought" ? (');
    expect(timeline).toContain('<ThoughtBox item={entry.item} />');
    expect(timeline).toContain('class="step reply-thinking"');
    expect(timeline).toContain('data-timeline-key={props.timelineKey}');
    expect(timeline).toContain("const html = () => renderMarkdown(text());");
    expect(timeline).toContain('class="body markdown reply-thinking-body"');
    expect(timeline).toContain('label="streaming thinking"');
    expect(timeline).toContain('props.item.kind !== "agent:Reply" ||');
    expect(timeline).toContain("draft.reasoningContent");
    expect(timeline).toContain("bag.draftReply()?.reasoningContent");
    expect(state).toContain('if (ev.kind === "reasoning-draft")');
    expect(state).toContain("reasoningContent: ev.reasoningContent");
  });

  test("keeps reasoning-only partial replies visible until persisted reply rows land", () => {
    expect(timeline).toContain("reply.content.trim() || reply.reasoningContent?.trim()");
    expect(state).toContain("const replyDraftIds = new Set(");
    expect(state).toContain("if (replyDraftIds.has(item.draftId)) return false;");
  });

  test("clears stale compaction when streamed replies arrive", () => {
    expect(state).toContain("A draft event can only come from the real answer stream");
    expect(state).toContain("deleteFromSet(setCompactingChats, compactingChats, cid);");
  });
});
