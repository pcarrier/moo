import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const stateSource = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
const timelineSource = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
const stepSource = readFileSync(new URL("../../harness/src/commands/step.ts", import.meta.url), "utf8");
const registrySource = readFileSync(new URL("../../harness/src/commands/registry.ts", import.meta.url), "utf8");
const poolSource = readFileSync(new URL("../../src/pool.rs", import.meta.url), "utf8");

describe("chat message queueing", () => {
  test("hydrates queued messages through the explicit fast read command", () => {
    expect(stateSource).toContain('api("chat-queue-list", {})');
    expect(poolSource).toContain('"chat-queue-list"');
    expect(registrySource).toContain('"chat-queue-list": chatQueueListCommand');
  });

  test("loads queued messages during startup before the composer is interactive", () => {
    const startFn = stateSource.slice(
      stateSource.indexOf("async function start()"),
      stateSource.indexOf("// 1-second tick"),
    );
    expect(startFn).toContain("await loadPendingMessages()");
  });

  test("sends idle messages directly instead of visibly queueing them first", () => {
    expect(stateSource).toContain("function shouldSendImmediately(chat: string)");
    expect(stateSource).toContain("pendingLoaded || locallyCreatedChats.has(chat)");
    expect(stateSource).toContain("if (shouldSendImmediately(cid))");
    expect(stateSource).toContain("dispatchQueuedMessage(item, { optimisticUserInput: true })");
  });

  test("uses the pending message id to make step dispatches idempotent", () => {
    expect(stateSource).toContain("clientMessageId: head.id");
    expect(stateSource).toContain("clientMessageId: id");
    expect(stepSource).toContain("CLIENT_MESSAGE_STEP_REF_SEGMENT");
    expect(stepSource).toContain("if (existing)");
    expect(stepSource).toContain("driver: stepDriverAction");
    expect(stepSource).toContain("claimed,");
    expect(stateSource).toContain("settleAcceptedPendingMessage(id)");
    expect(stateSource).toContain("if (r.value.claimed)");
  });

  test("stale queue responses cannot resurrect accepted messages", () => {
    expect(stateSource).toContain("const acceptedPendingIds = new Set<string>()");
    expect(stateSource).toContain("rememberAcceptedPendingId(id)");
    expect(
      stateSource.match(/!acceptedPendingIds\.has\(message\.id\)/g)?.length,
    ).toBe(2);
  });

  test("queued messages persist through server queue commands", () => {
    expect(stateSource).toContain('async function savePendingMessages');
    expect(stateSource).toContain('let pendingSaveInFlight = false');
    expect(stateSource).toContain('let pendingSaveAgain = false');
    expect(stateSource).toContain('const r = await api("chat-queue-save", {');
    expect(stateSource).toContain("knownIds: Array.from(serverSeenPendingIds)");
    expect(stateSource).toContain('if (pendingSaveAgain) continue');
    expect(stepSource).toContain('export async function chatQueueSaveCommand');
    expect(stepSource).toContain('value: { messages: await writePendingMessages(raw, knownIds) }');
  });

  test("editing a queued message updates it in place", () => {
    const edit = stateSource.slice(
      stateSource.indexOf("async function editPending("),
      stateSource.indexOf("function addPendingAttachments"),
    );
    expect(edit).toContain("if (text === undefined) return");
    expect(edit).toContain("setPending(pending().map((p) => (p.id === id ? { ...p, text } : p)))");
    expect(edit).toContain("void savePendingMessages()");
    expect(edit).not.toContain("setWipText(item.text)");
    expect(edit).not.toContain("requestChatComposerFocus()");
    expect(timelineSource).toContain("beginQueuedEdit");
    expect(timelineSource).toContain("const [localText, setLocalText]");
    expect(timelineSource).toContain("value: localText");
    expect(timelineSource).toContain("onFocus={beginQueuedEdit}");
    expect(timelineSource).toContain("value={localText()}");
    expect(timelineSource).toContain("setLocalText(value)");
    expect(timelineSource).toContain("readOnly={dispatching()}");
  });

  test("queued message edits block draining until blur", () => {
    const stateSetup = stateSource.slice(
      stateSource.indexOf("const [dispatchingPendingIds"),
      stateSource.indexOf("// Maps a pending message ID"),
    );
    const editLifecycle = stateSource.slice(
      stateSource.indexOf("function beginPendingEdit"),
      stateSource.indexOf("function appendOptimisticUserInput"),
    );
    const drain = stateSource.slice(
      stateSource.indexOf("async function drain()"),
      stateSource.indexOf("function touchModelMru"),
    );
    expect(stateSetup).toContain("const [editingPendingIds");
    expect(editLifecycle).toContain("addEditingPendingId(id)");
    expect(editLifecycle).toContain("deleteEditingPendingId(id)");
    expect(editLifecycle).toContain("void savePendingMessages().then(drainSoon)");
    expect(drain).toContain("!editingPendingIds().has(p.id)");
  });

  test("editing queued attachments persists in place", () => {
    const addAttachments = stateSource.slice(
      stateSource.indexOf("function addPendingAttachments"),
      stateSource.indexOf("function removePendingAttachment"),
    );
    const removeAttachment = stateSource.slice(
      stateSource.indexOf("function removePendingAttachment"),
      stateSource.indexOf("async function removePending"),
    );
    expect(addAttachments).toContain("void savePendingMessages()");
    expect(removeAttachment).toContain("void savePendingMessages()");
    expect(timelineSource).toContain("props.bag.removePendingAttachment(props.item().id, i)");
  });

  test("removing a queued message deletes only that item and saves", () => {
    const remove = stateSource.slice(
      stateSource.indexOf("async function removePending("),
      stateSource.indexOf("async function steerPending("),
    );
    expect(remove).toContain("setPending(pending().filter((p) => p.id !== id))");
    expect(remove).toContain("pendingMessageStepIds.delete(id)");
    expect(remove).toContain("await savePendingMessages()");
  });

  test("landed queued messages persist their dequeue", () => {
    const removeLanded = stateSource.slice(
      stateSource.indexOf("function removeLandedDispatchingPendingMessages"),
      stateSource.indexOf("async function dispatchMessageNow"),
    );
    expect(removeLanded).toContain("let removed = false");
    expect(removeLanded).toContain("removed = true");
    expect(removeLanded).toContain("if (removed) void savePendingMessages().then(drainSoon)");
  });

  test("steering with a chosen queued message moves it to the front", () => {
    const steer = stateSource.slice(
      stateSource.indexOf("async function steerPending("),
      stateSource.indexOf("async function savePendingMessages"),
    );
    expect(steer).toContain("setPending([item, ...pen.slice(0, idx), ...pen.slice(idx + 1)])");
    expect(steer).toContain("addToSet(setInterruptedChats, interruptedChats, item.chatId)");
    expect(steer).toContain("await savePendingMessages()");
    expect(steer).toContain("await interruptQueuedChatForSteer(item.chatId)");
    expect(steer).toContain("deleteFromSet(setInterruptedChats, interruptedChats, item.chatId)");
    expect(steer).toContain("drainSoon()");
  });

  test("steering interrupts active queue blockers before draining", () => {
    const steerInterrupt = stateSource.slice(
      stateSource.indexOf("async function interruptQueuedChatForSteer"),
      stateSource.indexOf("async function steerPending"),
    );
    expect(steerInterrupt).toContain("chatHasInFlightTurn(id)");
    expect(steerInterrupt).toContain("setHas(dispatchingChats(), id)");
    expect(steerInterrupt).toContain("setHas(interruptingChats(), id)");
    expect(steerInterrupt).toContain("clearActiveChatRuntime(id)");
    expect(steerInterrupt).toContain("settleRunningTimelineRows(id)");
    expect(steerInterrupt).toContain("dismissCurrentDraftReply(id)");
    expect(steerInterrupt).toContain("clearDraftReply(id)");
    expect(steerInterrupt).toContain('const r = await api("interrupt", { chatId: id })');
  });

  test("drain dispatches the selected front item deterministically", () => {
    const drain = stateSource.slice(
      stateSource.indexOf("async function drain()"),
      stateSource.indexOf("function touchModelMru"),
    );
    expect(drain).toContain("const idx = pen.findIndex(");
    expect(drain).toContain("await dispatchQueuedMessage(head)");
    expect(drain).toContain("!editingPendingIds().has(p.id)");
  });

  test("settles dispatched messages from step-end events for any chat", () => {
    const eventsSource = readFileSync(new URL("./events.ts", import.meta.url), "utf8");
    expect(stateSource).toContain("function removeLandedPendingByStepId");
    expect(stateSource).toContain(
      "removeLandedPendingByStepId(ev.chatId, ev.userStepId)",
    );
    expect(eventsSource).toContain('userStepId: optionalString(frame, "userStepId")');
    expect(stepSource).toContain("userStepId?: string,");
  });

  test("returns dropped dispatches to the queue after an interrupt", () => {
    expect(stateSource).toContain("function resetDroppedDispatchesAfterInterrupt");
    const occurrences = stateSource.split("resetDroppedDispatchesAfterInterrupt(id)").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(stateSource).toContain("DROPPED_DISPATCH_INTERRUPT_RESET_GRACE_MS");
  });

  test("backs off failed dispatches instead of hot-looping", () => {
    expect(stateSource).toContain("function notePendingDispatchFailure");
    expect(stateSource).toContain(
      "(pendingDispatchFailures.get(p.id)?.nextAt ?? 0) <= now",
    );
    expect(stateSource).toContain("schedulePendingDispatchRetry(pen)");
    expect(stateSource).toContain("pendingDispatchFailures.delete(head.id)");
  });

  test("parks failed immediate sends as visible queued messages", () => {
    expect(stateSource).toContain("setPending([...pending(), head])");
  });

  test("keeps local unsaved messages when reloading the server queue", () => {
    expect(stateSource).toContain("const serverSeenPendingIds = new Set<string>()");
    expect(stateSource).toContain("!serverSeenPendingIds.has(p.id)");
  });

  test("queued edits commit against the id captured at focus", () => {
    expect(timelineSource).toContain("let editingId: string | null = null");
    expect(timelineSource).toContain("const commitQueuedEdit = () =>");
    expect(timelineSource).toContain("void props.bag.editPending(id, untrack(localText))");
  });

  test("steering flushes the in-flight edit instead of no-oping", () => {
    const steerButton = timelineSource.slice(
      timelineSource.indexOf("pending-steer-btn"),
      timelineSource.indexOf("pending-remove-btn"),
    );
    expect(steerButton).toContain("commitQueuedEdit();");
    expect(steerButton).toContain("void props.bag.steerPending(props.item().id);");
  });

  test("queue rows expose run-next edit and remove controls", () => {
    expect(timelineSource).toContain("pending-steer-btn");
    expect(timelineSource).toContain("onFocus={beginQueuedEdit}");
    expect(timelineSource).toContain("setLocalText(value)");
    expect(timelineSource).toContain("remove queued message");
    expect(timelineSource).toContain("props.bag.steerPending(props.item().id)");
    expect(timelineSource).toContain("props.bag.removePending(props.item().id)");
  });
});
