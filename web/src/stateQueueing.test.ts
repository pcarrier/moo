import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const stateSource = readFileSync(
  new URL("./state.ts", import.meta.url),
  "utf8",
);

describe("chat message queueing", () => {
  test("sends idle messages directly instead of visibly queueing them first", () => {
    expect(stateSource).toContain(
      "function shouldSendImmediately(chat: string)",
    );
    expect(stateSource).toContain(
      "pendingLoaded || locallyCreatedChats.has(chat)",
    );
    expect(stateSource).toContain("if (shouldSendImmediately(cid))");
    expect(stateSource).toContain(
      "dispatchQueuedMessage({ id, text, chatId: cid, attachments })",
    );
  });

  test("holds follow-up messages while the selected timeline has a running row", () => {
    expect(stateSource).toContain("const hasRunningTimelineRowForChat");
    expect(stateSource).toContain("chatId() === id &&");
    expect(stateSource).toContain("timeline().some(");
    expect(stateSource).toContain("!isTerminalStepStatus(item.status)");
    expect(stateSource).toContain(
      "!(item.runts && isRunTSBackgrounded(item.step, id))",
    );
  });

  test("holds follow-up messages while a streamed draft is active", () => {
    const draftBusy = stateSource.slice(
      stateSource.indexOf("const chatHasUnendedDraft = (id: string)"),
      stateSource.indexOf("const chatHasServerRun = (id: string)"),
    );
    const inFlight = stateSource.slice(
      stateSource.indexOf("const chatHasInFlightTurn = (id: string)"),
      stateSource.indexOf("const chatBusy = (id: string)"),
    );
    const draftEnd = stateSource.slice(
      stateSource.indexOf('if (ev.kind === "draft-end")'),
      stateSource.indexOf('if (ev.kind === "llm-auth-required")'),
    );

    expect(draftBusy).toContain("const draft = draftReply();");
    expect(draftBusy).toContain("draft.chatId === id");
    expect(draftBusy).toContain("!endedDraftReplyIds.has(draft.draftId)");
    expect(inFlight).toContain("chatHasUnendedDraft(id)");
    expect(draftEnd).toContain(
      "endedDraftReplyIds.set(ev.draftId, Date.now());",
    );
    expect(draftEnd).toContain(
      "pending().some((p) => p.chatId === cur.chatId)",
    );
    expect(draftEnd).toContain("drainSoon();");
  });

  test("settles queued visible rows on step-end before draining follow-ups", () => {
    const settleRows = stateSource.slice(
      stateSource.indexOf("function settleRunningTimelineRows(id: string)"),
      stateSource.indexOf("function settleTimelineStep"),
    );
    const stepEnd = stateSource.slice(
      stateSource.indexOf('if (ev.kind === "step-end")'),
      stateSource.indexOf('if (ev.kind === "driver-error")'),
    );

    expect(settleRows).toContain("isTerminalStepStatus(item.status)");
    expect(settleRows).toContain(
      'return { ...item, status: "agent:Done" } as TimelineItem;',
    );
    expect(
      stepEnd.indexOf("settleRunningTimelineRows(ev.chatId);"),
    ).toBeLessThan(stepEnd.indexOf("drainSoon();"));
  });

  test("does not release active turns while streamed tool rows are open", () => {
    const helper = stateSource.slice(
      stateSource.indexOf("function timelineHasOpenForegroundStepSince("),
      stateSource.indexOf("function isManualCompactionStep"),
    );
    const settleActiveTurn = stateSource.slice(
      stateSource.indexOf("function timelineRowsSettleActiveTurn("),
      stateSource.indexOf("function settleRunningTimelineRows"),
    );
    const applyRows = stateSource.slice(
      stateSource.indexOf("function applyTimelineRows("),
      stateSource.indexOf("function applyOverviewValue"),
    );

    expect(helper).toContain("items.some(");
    expect(helper).toContain("Number(item.at) >= since");
    expect(helper).toContain("!isTerminalStepStatus(item.status)");
    expect(helper).toContain('item.kind !== "agent:UserInput"');
    expect(helper).toContain("!isBackgroundedRunTSTimelineItem(item, id)");
    expect(settleActiveTurn).toContain(
      "if (timelineHasOpenForegroundStepSince(id, items, startedAt)) return false;",
    );
    expect(settleActiveTurn).toContain("return false;");
    expect(applyRows).toContain(
      "const hasOpenForegroundStep = timelineHasOpenForegroundStepSince(",
    );
    expect(applyRows).toContain("currentDraft.at");
    expect(applyRows).toContain(
      'currentDraft.kind !== "compaction" && !hasOpenForegroundStep',
    );
  });

  test("wakes queued messages when refresh proves the active turn is settled", () => {
    const applyRows = stateSource.slice(
      stateSource.indexOf("function applyTimelineRows("),
      stateSource.indexOf("function applyOverviewValue"),
    );
    const release = stateSource.slice(
      stateSource.indexOf("function releaseSettledChatRuntime(id: string)"),
      stateSource.indexOf("function mergeTimelineUpdateRows"),
    );
    const refreshChats = stateSource.slice(
      stateSource.indexOf("async function refreshChats()"),
      stateSource.indexOf("async function refreshTimeline"),
    );

    expect(applyRows).toContain(
      "timelineRowsSettleActiveTurn(id, displayedTimeline)",
    );
    expect(applyRows).toContain("releaseSettledChatRuntime(id);");
    expect(release).toContain("clearActiveChatRuntime(id);");
    expect(release).toContain("settleRunningTimelineRows(id);");
    expect(release).toContain("unblockRunTSQueue(id);");
    expect(release).toContain("pending().some((p) => p.chatId === id)");
    expect(release).toContain("drainSoon();");
    expect(refreshChats).toContain("const currentChatId = chatId();");
    expect(refreshChats).toContain("await refreshBackgroundRunTS();");
    expect(refreshChats).toContain("releaseSettledChatRuntime(currentChatId);");
  });

  test("does not settle backgrounded RunTS rows while unblocking queued chat sends", () => {
    const settleRows = stateSource.slice(
      stateSource.indexOf("function settleRunningTimelineRows(id: string)"),
      stateSource.indexOf("function settleTimelineStep"),
    );
    expect(stateSource).toContain("function isBackgroundedRunTSTimelineItem(");
    expect(stateSource).toContain("isRunTSBackgrounded(item.step, id)");
    expect(settleRows).toContain("isBackgroundedRunTSTimelineItem(item, id)");
  });

  test("wakes queued messages when refresh proves the active turn is settled", () => {
    const applyRows = stateSource.slice(
      stateSource.indexOf("function applyTimelineRows("),
      stateSource.indexOf("function applyOverviewValue"),
    );
    const release = stateSource.slice(
      stateSource.indexOf("function releaseSettledChatRuntime(id: string)"),
      stateSource.indexOf("function mergeTimelineUpdateRows"),
    );
    const refreshChats = stateSource.slice(
      stateSource.indexOf("async function refreshChats()"),
      stateSource.indexOf("async function refreshTimeline"),
    );

    expect(applyRows).toContain(
      "timelineRowsSettleActiveTurn(id, displayedTimeline)",
    );
    expect(applyRows).toContain("releaseSettledChatRuntime(id);");
    expect(release).toContain("clearActiveChatRuntime(id);");
    expect(release).toContain("settleRunningTimelineRows(id);");
    expect(release).toContain("unblockRunTSQueue(id);");
    expect(release).toContain("pending().some((p) => p.chatId === id)");
    expect(release).toContain("drainSoon();");
    expect(refreshChats).toContain("const currentChatId = chatId();");
    expect(refreshChats).toContain("await refreshBackgroundRunTS();");
    expect(refreshChats).toContain("releaseSettledChatRuntime(currentChatId);");
  });

  test("does not settle backgrounded RunTS rows while unblocking queued chat sends", () => {
    const settleRows = stateSource.slice(
      stateSource.indexOf("function settleRunningTimelineRows(id: string)"),
      stateSource.indexOf("function settleTimelineStep"),
    );
    expect(stateSource).toContain("function isBackgroundedRunTSTimelineItem(");
    expect(stateSource).toContain("isRunTSBackgrounded(item.step, id)");
    expect(settleRows).toContain("isBackgroundedRunTSTimelineItem(item, id)");
  });

  test("does not treat optimistic chat creation as an active agent run", () => {
    expect(stateSource).toContain(
      "const locallyCreatedChats = new Set<string>()",
    );
    expect(stateSource).toContain("locallyCreatedChats.add(requestedChatId)");
    expect(stateSource).toContain("const chatHasServerRun = (id: string) =>");
    expect(stateSource).toContain('chat.status === "agent:Running"');
    expect(stateSource).toContain(
      "const chatHasInFlightTurn = (id: string) =>",
    );
    expect(stateSource).toContain("chatHasServerRun(id) ||");
    expect(stateSource).toContain("hasRunningTimelineRowForChat(id) ||");
    expect(stateSource).toContain("chatHasUnendedDraft(id)");
    expect(stateSource).not.toContain(
      'currentChat()?.status === "agent:Queued"',
    );
  });

  test("merges queued sends typed before pending-message storage loads", () => {
    expect(stateSource).toContain("const local = pending()");
    expect(stateSource).toContain(
      "const localIds = new Set(local.map((message) => message.id))",
    );
    expect(stateSource).toContain(
      "...r.value.messages.filter((message) => !localIds.has(message.id))",
    );
    expect(stateSource).toContain("...local,");
    expect(stateSource).toContain("if (local.length > 0) {");
    expect(stateSource).toContain(
      'api("pending-messages-save", { messages: pending() })',
    );
  });

  test("keeps dispatch locks as queue-only state, not visible thinking", () => {
    expect(stateSource).toContain(
      "chatHasInFlightTurn(id) && !setHas(runTSQueueUnblockedChats(), id)",
    );
    expect(stateSource).toContain("setHas(dispatchingChats(), id)");
    expect(stateSource).toContain("setHas(interruptingChats(), id)");
    // the visible "thinking" UI.");
    expect(stateSource).toContain("Only this server-confirmed state drives");
    expect(stateSource).toContain('the visible "thinking" UI.');
  });
});
