import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { TimelineItem } from "./api";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";
import { latestTerminalInteractiveStepSettlesActiveTurn, latestTerminalReplySettlesActiveTurn } from "./timeline/utils";

const timeline = readFileSync(
  new URL("./Timeline.tsx", import.meta.url),
  "utf8",
);
const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
const css = readStylesheetForTest();

describe("timeline thinking status", () => {
  test("hides standalone Thinking row during running timeline rows", () => {
    expect(timeline).toContain(
      "const hasRunningTimelineRow = createMemo(() =>",
    );
    expect(timeline).toContain("visibleTimeline().some(isRunningTimelineItem)");
    expect(timeline).toContain("const showStandaloneThinking = () =>");
    expect(timeline).toContain("!hasRunningTimelineRow()");
    expect(timeline).toContain("when={showStandaloneThinking()}");
  });

  test("hides standalone Thinking after the active interactive row lands", () => {
    const reply = (at: number): TimelineItem => ({
      type: "step",
      step: "step1",
      kind: "agent:Reply",
      status: "agent:Done",
      at,
      text: "done",
    });
    const tool = (at: number): TimelineItem => ({
      type: "step",
      step: "step2",
      kind: "agent:ToolCall",
      status: "agent:Done",
      at,
      text: "tool done",
    });
    const manualCompaction = (at: number): TimelineItem => ({
      type: "step",
      step: "step3",
      kind: "agent:Compaction",
      status: "agent:Done",
      at,
      text: "manual compaction\nsummary",
    });

    expect(latestTerminalReplySettlesActiveTurn([reply(2000)], 1000)).toBe(
      true,
    );
    expect(latestTerminalReplySettlesActiveTurn([reply(2000)], 3000)).toBe(
      false,
    );
    expect(
      latestTerminalReplySettlesActiveTurn([reply(2000), tool(2500)], 1000),
    ).toBe(false);
    expect(
      latestTerminalInteractiveStepSettlesActiveTurn(
        [manualCompaction(2000)],
        1000,
      ),
    ).toBe(true);
    expect(timeline).toContain(
      "const activeTurnSettled = createMemo(() =>",
    );
    expect(timeline).toContain("!activeTurnSettled()");
  });

  test("hides bottom refresh dots whenever active-turn UI is expected", () => {
    expect(timeline).toContain("const activeTurnIndicatorExpected = () =>");
    expect(timeline).toContain("bag.thinking() ||");
    expect(timeline).toContain("bag.compacting() ||");
    expect(timeline).toContain(
      'bag.currentChatSummary()?.status === "agent:Running" ||',
    );
    expect(timeline).toContain("hasStreamingReply() ||");
    expect(timeline).toContain("hasRunningTimelineRow();");
    expect(timeline).toContain("const showTimelineRefreshingIndicator = () =>");
    expect(timeline).toContain(
      "bag.timelineRefreshing() && !activeTurnIndicatorExpected();",
    );
    expect(timeline).toContain(
      '<Show when={showTimelineRefreshingIndicator()}>',
    );
    expect(timeline).not.toContain("timelineRefreshingIndicatorTimer");
    expect(timeline).not.toContain("setShowTimelineRefreshingIndicator");
    expect(timeline).not.toContain(
      "when={bag.timelineRefreshing() && !showStandaloneThinking()}",
    );
  });

  test("labels manual compaction failures distinctly", () => {
    expect(timeline).toContain("function compactionTrigger(");
    expect(timeline).toContain('): "manual" | "automatic" {');
    expect(timeline).toContain(
      "{compactionTriggerTitle(props.detail)} compaction failed",
    );
    expect(timeline).toContain(
      "The model provider rejected the ${trigger} compaction request.",
    );
    expect(timeline).toContain(
      "Try switching to a larger-context model, lowering reasoning effort, or reducing retained history.",
    );
    expect(timeline).toContain("requestPromptTokens");
    expect(timeline).toContain("request cap");
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
    expect(step).toContain('{ draftKind: "compaction-draft" }');
    expect(step).toContain('return { ok: true, value: { kind: "done" } };');
    expect(state).toContain("if (ev.compacting === true)");
    expect(state).toContain(
      "addToSet(setCompactingChats, compactingChats, ev.chatId);",
    );
  });

  test("keeps active compaction in the compaction row", () => {
    expect(timeline).toContain("const activeWaitLabel = () =>");
    expect(timeline).toContain("const runningModel = bag.runningModel();");
    expect(timeline).toContain("return activeThinkingLabel(runningModel?.model, runningModel?.effort);");
    expect(timeline).not.toContain("runningModel?.model ??");
    expect(timeline).not.toContain("runningModel?.effort ??");
    expect(state).toContain("const runningModel = () =>");
    expect(state).toContain("setActiveChatRuntimeModel(");
    expect(timeline).toContain("function activeThinkingLabel(");
    expect(timeline).toContain('return `${displayModel} ${displayEffort} thinking`;');
    expect(timeline).toContain('return "Thinking";');
    expect(timeline).toContain("bag.thinking() &&");
    expect(timeline).toContain("!bag.compacting() &&");
    expect(timeline).toContain("<span>{activeWaitLabel()}</span>");
    expect(timeline).not.toContain("thinkingElapsed()");
    expect(timeline).not.toContain('class="step thinking"');
    expect(timeline).toContain('class="step reply-thinking"');
    expect(timeline).toContain('class="reply-thinking-dots"');
    expect(timeline).toContain('label="thinking"');
    expect(timeline).not.toContain("const compactingTokenPrompt = () =>");
    expect(timeline).not.toContain("tokens before compaction");
    expect(timeline).toContain("compactionTokenDelta");
    expect(timeline).toContain("summaryTokens");
    expect(timeline).toContain('summary ${formatTokenCount(summaryTokens)}');
    expect(timeline).toContain('streak ${streak}');
    expect(timeline).not.toContain("next-compaction pressure");
    expect(timeline).not.toContain('${formatTokenCount(before)} summarized');
  });

  test("renders streamed compaction drafts", () => {
    expect(state).toContain('if (ev.kind === "compaction-draft")');
    expect(state).toContain('kind: "compaction"');
    expect(timeline).toContain("syncDraftStepItem(proxy, draft)");
    expect(timeline).toContain('? "compacting older turns"');
    expect(timeline).toContain('class="compaction-dots"');
  });

  test("labels streaming replies as Streaming", () => {
    expect(timeline).toContain(
      "function activeReplyStatusLabel(item: StepItem, compacting: boolean): string {",
    );
    expect(timeline).toContain('if (item.text.trim()) return "Streaming…";');
    expect(timeline).toContain(
      'if (item.reasoningContent?.trim()) return "Streaming…";',
    );
    expect(timeline).toContain(`stepMetaLabel(
              props.item,
              props.bag.compacting(),
              props.bag.thinking() || props.bag.compacting(),
            )`);
    expect(timeline).toContain(
      "return activeReplyStatusLabel(item, compacting);",
    );
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

  test("settles stale reply thinking UI after the active run ends", () => {
    expect(timeline).toContain("function stepMetaLabel(");
    expect(timeline).toContain("active: boolean,");
    expect(timeline).toContain('item.kind === "agent:Reply" &&');
    expect(timeline).toContain("!isTerminalStepStatus(item.status)");
    expect(timeline).toContain("(props.streaming ?? true) &&");
    expect(timeline).toContain(
      "props.item.reasoningStreaming ?? !isTerminalStepStatus(props.item.status)",
    );
    expect(timeline).toContain(
      "<ThoughtBox item={entry.item} streaming={false} />",
    );
    expect(state).toContain("function clearActiveChatRuntime(id: string)");
    expect(state).toContain("clearActiveChatRuntime(id);");
    expect(state).toContain("function settleRunningTimelineRows(id: string)");
    expect(state).toContain("isTerminalStepStatus(item.status)");
    expect(state).toContain(
      'return { ...item, status: "agent:Done" } as TimelineItem;',
    );
    expect(state).toContain("settleRunningTimelineRows(ev.chatId);");
  });

  test("renders streamed model thinking as separate thought boxes", () => {
    const utils = readFileSync(
      new URL("./timeline/utils.ts", import.meta.url),
      "utf8",
    );

    expect(utils).toContain('| { kind: "thought"; item: StepItem }');
    expect(utils).toContain(
      "export function timelineThoughtKey(item: StepItem): string {",
    );
    expect(utils).toContain('previousThought?.kind === "thought"');
    expect(utils).toContain(
      "if (hasReplyReasoning(item)) keys.push(timelineThoughtKey(item));",
    );
    expect(timeline).toContain('entry.kind === "thought" ? (');
    expect(timeline).toContain("<ThoughtBox");
    expect(timeline).toContain("streaming={bag.thinking()}");
    expect(timeline).toContain('class="step reply-thinking"');
    expect(timeline).toContain("data-timeline-key={props.timelineKey}");
    expect(timeline).toContain("const html = () => renderMarkdown(text());");
    expect(timeline).toContain('class="body markdown reply-thinking-body"');
    expect(timeline).toContain('label="streaming thinking"');
    expect(timeline).toContain("const thoughtStreaming = () =>");
    expect(timeline).toContain(
      "props.item.reasoningStreaming ?? !isTerminalStepStatus(props.item.status)",
    );
    expect(timeline).toContain('props.item.kind !== "agent:Reply" ||');
    expect(timeline).toContain("draft.reasoningContent");
    expect(timeline).toContain("bag.draftReply()?.reasoningContent");
    expect(state).toContain('if (ev.kind === "reasoning-draft")');
    expect(state).toContain("reasoningContent: ev.reasoningContent");
    expect(state).toContain(
      "reasoningStreaming: !toolClosedDraftReplyIds.has(ev.draftId)",
    );
    expect(state).toContain("reasoningStreaming: false");
    expect(state).toContain('typeof ev.model === "string" ? ev.model : previous?.model');
    expect(state).toContain('typeof ev.effort === "string" ? ev.effort : previous?.effort');
    expect(state).toContain(
      "setActiveDraftReply({ ...cur, reasoningStreaming: false });",
    );
  });

  test("closes streamed thinking when a tool call starts", () => {
    expect(state).toContain("const toolClosedDraftReplyIds = new Set<string>();");
    expect(state).toContain(
      "function closeDraftReplyThinkingForToolCall(id: string)",
    );
    expect(state).toContain("toolClosedDraftReplyIds.add(cur.draftId);");
    expect(state).toContain(
      "setActiveDraftReply({ ...cur, reasoningStreaming: false });",
    );
    expect(state).toContain('if (ev.kind === "tool-call-draft")');
    expect(state).toContain("closeDraftReplyThinkingForToolCall(cid);");
    expect(state).toContain(
      "reasoningStreaming: !toolClosedDraftReplyIds.has(ev.draftId)",
    );
  });

  test("keeps reasoning-only partial replies visible until persisted reply rows land", () => {
    expect(timeline).toContain(
      "reply.content.trim() || reply.reasoningContent?.trim()",
    );
    expect(state).toContain("const replyDraftIds = new Set(");
    expect(state).toContain(
      "if (replyDraftIds.has(item.draftId)) return false;",
    );
  });

  test("clears stale compaction when streamed replies arrive", () => {
    expect(state).toContain(
      "A reply draft can only come from the real answer stream",
    );
    expect(state).toContain(
      "deleteFromSet(setCompactingChats, compactingChats, cid);",
    );
  });
});


test("keeps streamed reasoning drafts cached across chat switches", () => {
  expect(state).toContain("const draftRepliesByChat = new Map<string, DraftReply>();");
  expect(state).toContain("function restoreDraftReplyForChat(id: string)");

  const selectStart = state.indexOf("async function selectChat(");
  expect(selectStart).toBeGreaterThanOrEqual(0);
  const selectEnd = state.indexOf("function olderTimelineLoadCount", selectStart);
  const selectBlock = state.slice(selectStart, selectEnd);
  expect(selectBlock).toContain("restoreDraftReplyForChat(id);");
  expect(selectBlock).not.toContain("setDraftReply(null);");

  const reasoningStart = state.indexOf('if (ev.kind === "reasoning-draft")');
  expect(reasoningStart).toBeGreaterThanOrEqual(0);
  const reasoningEnd = state.indexOf('if (ev.kind === "draft")', reasoningStart);
  const reasoningBlock = state.slice(reasoningStart, reasoningEnd);
  expect(reasoningBlock).toContain("const cid = ev.chatId;");
  expect(reasoningBlock).toContain("const previous = draftRepliesByChat.get(cid);");
  expect(reasoningBlock).toContain("setActiveDraftReply({");
});
