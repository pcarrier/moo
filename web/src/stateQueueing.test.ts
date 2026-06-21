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

  test("queued messages persist through server queue commands", () => {
    expect(stateSource).toContain('async function savePendingMessages');
    expect(stateSource).toContain('api("chat-queue-save", { messages: pending() })');
    expect(stepSource).toContain('export async function chatQueueSaveCommand');
    expect(stepSource).toContain('value: { messages: await writePendingMessages(raw, knownIds) }');
  });

  test("editing a queued message dequeues it into the composer", () => {
    const edit = stateSource.slice(
      stateSource.indexOf("async function editPending("),
      stateSource.indexOf("function addPendingAttachments"),
    );
    expect(edit).toContain("setPending(pending().filter((p) => p.id !== id))");
    expect(edit).toContain("setWipText(item.text)");
    expect(edit).toContain("await savePendingMessages()");
    expect(edit).toContain("requestChatComposerFocus()");
    expect(timelineSource).toContain("editQueuedMessage");
    expect(timelineSource).toContain('aria-label="edit queued message"');
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
    expect(steer).toContain("await savePendingMessages()");
    expect(steer).toContain("drainSoon()");
  });

  test("drain dispatches the selected front item deterministically", () => {
    const drain = stateSource.slice(
      stateSource.indexOf("async function drain()"),
      stateSource.indexOf("function touchModelMru"),
    );
    expect(drain).toContain("const idx = pen.findIndex(");
    expect(drain).toContain("await dispatchQueuedMessage(head)");
    expect(drain).not.toContain("editingPendingIds");
  });

  test("queue rows expose run-next edit and remove controls", () => {
    expect(timelineSource).toContain("pending-steer-btn");
    expect(timelineSource).toContain("edit queued message");
    expect(timelineSource).toContain("remove queued message");
    expect(timelineSource).toContain("props.bag.steerPending(props.item().id)");
    expect(timelineSource).toContain("props.bag.removePending(props.item().id)");
  });
});
