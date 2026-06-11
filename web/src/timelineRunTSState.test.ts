import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
const timelineCss = readFileSync(new URL("./styles/timeline.css", import.meta.url), "utf8");
const timelineRows = readFileSync(new URL("./state/timelineRows.ts", import.meta.url), "utf8");

describe("timeline runTS state merging", () => {
  test("replaces rows when lazy result metadata changes", () => {
    // The structural deepEqual compares every key; verify it is wired in and
    // that the legacy field-by-field comparator was retired. Future schema
    // changes (e.g. new step fields) are automatically covered without test
    // churn.
    expect(timelineRows).toContain("function deepEqual(a: unknown, b: unknown): boolean");
    expect(timelineRows).toContain("function timelineItemEqual(a: TimelineItem, b: TimelineItem): boolean");
    expect(timelineRows).toContain("return deepEqual(a, b);");
    expect(state).not.toContain("a.lazyRuntsResult === right.lazyRuntsResult");
    expect(timelineRows).not.toContain("a.lazyRuntsResult === right.lazyRuntsResult");
  });

  test("uses update-aware timeline watermarks", () => {
    expect(timelineRows).toContain("function newestTimelineWatermark(items: TimelineItem[]): number");
    expect(timelineRows).toContain('item.type === "step" ? Number(item.updatedAt ?? 0) : 0');
    expect(state).not.toContain('} else if (hasRunningTimelineStep(timeline())) {');
  });

  test("handles explicit runTS completion events without changing expansion", () => {
    expect(state).toContain('ev.kind === "runts-step-finished"');
    expect(state).toContain('item.step !== ev.stepId');
    expect(state).toContain('status: ev.status || (ev.error ? "agent:Failed" : "agent:Done")');
    expect(state).toContain('refreshTimelineIncrementalSoon();');
    expect(state).not.toContain('expansionStore.setOpen(`step:${ev.stepId}`, false);');
    expect(state).not.toContain('function collapseRunTSRowsFinishedBetween(');
    expect(state).not.toContain('expansionStore.setOpen(`step:${item.step}`, false);');
  });


  test("keeps streamed tool calls collapsed unless manually expanded", () => {
    const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
    expect(state).not.toContain('expansionStore.setOpen(`step:${stepId}`, true);');
    expect(timeline).not.toContain("const [wasLive, setWasLive]");
    expect(timeline).not.toContain("props.expansion.setOpen(key(), false);");
    expect(timeline).toContain("const open = () => props.expansion.isOpen(key());");
  });

  test("keeps streaming runTS rows mounted across draft updates", () => {
    const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
    expect(timeline).toContain("const liveRunTSStepProxies = new Map<string, StepItem>();");
    expect(timeline).toContain("const liveRunTSProxyFor = (item: StepItem): StepItem => {");
    expect(timeline).toContain("proxy = createMutable<StepItem>({ ...item });");
    expect(timeline).toContain("syncStepItem(proxy, item);");
    expect(timeline).toContain("if (!existing && isTerminalStepStatus(item.status)) return item;");
    expect(timeline).toContain("return liveRunTSProxyFor(item);");
  });

  test("keeps streamed runTS model and effort in expanded footer only", () => {
    expect(state).toContain('typeof ev.model === "string"');
    expect(state).toContain('typeof ev.effort === "string"');
    const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
    expect(timeline).toContain('<StepFooter\n        item={props.item}');
    expect(timeline).toContain('<Show when={step()?.model}>');
    expect(timeline).not.toContain("const showStreamingModelMeta = () =>");
    expect(timeline).not.toContain('class="runts-model-group step-model-group"');
    const css = readFileSync(new URL("./styles/timeline.css", import.meta.url), "utf8");
    expect(css).not.toContain(".runts-model-group");
  });
});


test("cancelled runTS/runJS rows stay visible and styled", () => {
  const utils = readFileSync(new URL("./timeline/utils.ts", import.meta.url), "utf8");
  expect(utils).toContain('item.kind !== "agent:RunTS"');
  expect(utils).toContain('item.kind !== "agent:RunJS"');
  const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
  expect(timeline).toContain('runts-status-cancelled');
  const css = readFileSync(new URL("./styles/timeline.css", import.meta.url), "utf8");
  expect(css).toContain('.step.run-ts.cancelled');
  expect(css).toContain('.step.run-js.cancelled');
  expect(css).toContain('darkorange');
  expect(css).toContain('background: color-mix(in srgb, var(--fg) 3%, transparent);');
  expect(css).not.toContain('background: var(--bubble-runts);');
});


test("compaction drafts clear on compaction-end", () => {
  expect(state).toContain('if (ev.kind === "compaction-end")');
  expect(state).toContain('cur?.kind === "compaction" && cur.chatId === ev.chatId');
  expect(state).toContain('setDraftReply(null);');
});

test("background runTS labels render as bounded markdown", () => {
  const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
  expect(timeline).toContain('<RunTSMarkdown');
  expect(timeline).toContain('class="background-runts-label"');
  expect(timeline).toContain("<HighlightedPre");
  expect(timeline).toContain("class={props.klass}");
  expect(timeline).toContain("language={language()}");
  const css = readFileSync(new URL("./styles/timeline.css", import.meta.url), "utf8");
  expect(css).toContain('.background-runts-label > *');
  expect(css).toContain('flex: 1 1 auto;');
  expect(css).toContain('flex: 0 0 auto;');
  expect(css).toContain('color: var(--fg);');
  expect(css).toContain('border: 1px solid var(--line);');
  expect(css).toContain(':root:not([data-theme="light"]) .runts-body .runts-code');
});

test("background runTS jobs stay compact below the timeline", () => {
  const css = readFileSync(new URL("./styles/timeline.css", import.meta.url), "utf8");
  const backgroundToolsBlock = css.slice(
    css.indexOf(".background-runts-panel {"),
    css.indexOf(".background-runts-title {"),
  );
  expect(backgroundToolsBlock).toContain('border: 0;');
  expect(backgroundToolsBlock).toContain('background: transparent;');
  expect(backgroundToolsBlock).toContain('color: var(--muted);');
  expect(backgroundToolsBlock).toContain('padding: 0.18em 0.42em 0.12em;');
  expect(css).toContain('flex-wrap: wrap;');
  expect(backgroundToolsBlock).toContain('font-size: 0.65rem;');
  expect(backgroundToolsBlock).toContain('line-height: 1.1;');
  expect(backgroundToolsBlock).toContain('letter-spacing: 0.03em;');
  expect(backgroundToolsBlock).toContain('text-transform: uppercase;');
  expect(css).toContain('.background-runts-panel:hover {');
  expect(css).toContain('background: var(--button-hover-bg);');
  expect(css).toContain('.background-runts-cancel {');
  expect(css).toContain('inline-size: 1rem;');
  expect(css).toContain('block-size: 1rem;');
  expect(css).toContain('color: inherit;');
});

test("backgrounded runTS rows keep animated loading dots", () => {
  const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
  expect(timeline).toContain(
    'props.item.status === "agent:Running" || backgrounded()',
  );
  expect(timeline).toContain('<LoadingDots class="runts-loading" label="running" />');
});

test("backgrounded runTS rows do not offer background again", () => {
  const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
  const controls = timeline.slice(
    timeline.indexOf("const backgrounded = ()"),
    timeline.indexOf("<button\n                type=\"button\"\n                class=\"runts-control runts-cancel\"")
  );

  expect(controls).toContain("props.bag.isRunTSBackgrounded?.(props.item.step) === true");
  expect(controls).toContain("<Show when={!backgrounded()}");
  expect(controls).toContain('aria-label="run in background"');
});

test("backgrounded runTS timeline rows remain cancellable", () => {
  const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
  const summaryStart = timeline.indexOf("const backgrounded = ()");
  const firstGuard = timeline.indexOf(
    'props.item.status === "agent:Running" || backgrounded()',
    summaryStart,
  );
  const controlsStart = timeline.indexOf('class="runts-controls"', firstGuard + 1);
  const controls = timeline.slice(
    controlsStart,
    timeline.indexOf("</summary>", controlsStart),
  );

  expect(firstGuard).toBeGreaterThanOrEqual(0);
  expect(controlsStart).toBeGreaterThanOrEqual(0);
  expect(controls).toContain('class="runts-control runts-cancel"');
  expect(controls).toContain("props.bag.cancelRunTSStep(props.item.step);");
  expect(controls).toContain('props.item.status !== "agent:Cancelled"');
});

test("tool cancellation receipts are explicit for the LLM", () => {
  const mooSource = readFileSync(new URL("../../harness/src/moo.ts", import.meta.url), "utf8");
  const types = readFileSync(new URL("../../harness/src/types.ts", import.meta.url), "utf8");

  expect(types).toContain('status: "cancelled" | "not-found";');
  expect(types).toContain("message: string;");
  expect(mooSource).toContain('status: cancelled > 0 ? "cancelled" : "not-found"');
  expect(mooSource).toContain("no cancellable runTS step found");
});

test("background runTS queue state unblocks follow-up draining", () => {
  expect(state).toContain("const [backgroundRequestedRunTS, setBackgroundRequestedRunTS]");
  expect(state).toContain("function isRunTSBackgrounded(");
  expect(state).toContain("if (targetStep && isRunTSBackgrounded(targetStep, id)) return;");
  expect(state).toContain("requestRunTSBackground(id, targetStep);");
  expect(state).toContain("unblockRunTSQueue(ev.chatId);");
  expect(state).toContain("clearRunTSQueueUnblock(ev.chatId);");
  expect(state).toContain("clearRunTSBackgroundRequest(ev.chatId, ev.stepId);");
  expect(state).toContain("drainSoon();");
});

test("background runTS start clears foreground thinking state", () => {
  const handler = state.slice(
    state.indexOf('if (ev.kind === "runts-background-start")'),
    state.indexOf('if (ev.kind === "runts-background-end")'),
  );

  expect(handler).toContain("clearActiveChatRuntime(ev.chatId);");
  expect(handler).toContain("unblockRunTSQueue(ev.chatId);");
  expect(handler).toContain('status: "agent:Done"');
});


test("runTS block previews render highlighted HTML imperatively", () => {
  const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
  expect(timeline).toContain("<HighlightedPre");
  expect(timeline).toContain("class={props.klass}");
  expect(timeline).toContain("content={props.content}");
  expect(timeline).toContain("language={language()}");
  expect(timeline).toContain('content={block().content()}');
  expect(timeline).toContain('language={block().language?.()}');
  expect(timeline).toContain('el.innerHTML = html();');
  expect(timeline).toContain('el.textContent = props.content;');
  expect(timeline).not.toContain('<pre class={props.klass}>{props.content}</pre>');
});


test("runTS preview height uses computed CSS variable", () => {
  const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("./styles/timeline.css", import.meta.url), "utf8");
  expect(timeline).toContain('"--runts-preview-max-height": `${previewLineLimit() * 1.3}em`');
  expect(css).toContain('--runts-preview-max-height: 13em;');
  expect(css).toContain('max-block-size: var(--runts-preview-max-height);');
  expect(css).not.toContain('calc(var(--runts-preview-lines) * 1.3em)');
});
test("timeline rows do not shrink when the scrollback overflows", () => {
  const css = readFileSync(new URL("./styles/timeline.css", import.meta.url), "utf8");
  const runtsBlock = css.slice(
    css.indexOf(".step.run-ts,"),
    css.indexOf(".step.run-ts.cancelled"),
  );
  expect(css).toContain(".timeline > * {");
  expect(css).toContain("flex-shrink: 0;");
  expect(runtsBlock).toContain("overflow: visible;");
  expect(runtsBlock).not.toContain("overflow: hidden;");
});


  test("backgrounded runTS panel jobs jump to their timeline rows", () => {
    expect(timeline).toContain('class="background-runts-jump"');
    expect(timeline).toContain('props.bag.jumpToTimeline({ key: `step:${job.stepId}` })');
    expect(timelineCss).toContain(".background-runts-jump:hover .background-runts-label");
    expect(timelineCss).toContain("cursor: pointer;");
  });
