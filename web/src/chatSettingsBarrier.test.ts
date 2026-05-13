import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { createChatSettingsWriteBarrier } from "./chatSettingsBarrier";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function countOccurrences(source: string, needle: string) {
  return source.split(needle).length - 1;
}

const stateSource = readFileSync(
  new URL("./state.ts", import.meta.url),
  "utf8",
);

describe("chat settings write barrier", () => {
  test("waits for in-flight writes for the same chat only", async () => {
    const barrier = createChatSettingsWriteBarrier();
    const write = deferred();
    let waited = false;

    barrier.run("chat-a", () => write.promise);
    const wait = barrier.wait("chat-a").then(() => {
      waited = true;
    });

    await barrier.wait("chat-b");
    await flushMicrotasks();
    expect(waited).toBe(false);
    expect(barrier.pendingCount("chat-a")).toBe(1);

    write.resolve();
    await wait;
    expect(waited).toBe(true);
    expect(barrier.pendingCount("chat-a")).toBe(0);
  });

  test("continues waiting for writes tracked while a wait is pending", async () => {
    const barrier = createChatSettingsWriteBarrier();
    const first = deferred();
    const second = deferred();
    let waited = false;

    barrier.run("chat-a", () => first.promise);
    const wait = barrier.wait("chat-a").then(() => {
      waited = true;
    });
    barrier.run("chat-a", () => second.promise);

    first.resolve();
    await flushMicrotasks();
    expect(waited).toBe(false);
    expect(barrier.pendingCount("chat-a")).toBeGreaterThanOrEqual(1);

    second.resolve();
    await wait;
    expect(waited).toBe(true);
    expect(barrier.pendingCount("chat-a")).toBe(0);
  });
  test("serializes writes for the same chat", async () => {
    const barrier = createChatSettingsWriteBarrier();
    const first = deferred();
    const second = deferred();
    const events: string[] = [];

    const firstRun = barrier.run("chat-a", async () => {
      events.push("first:start");
      await first.promise;
      events.push("first:end");
    });
    const secondRun = barrier.run("chat-a", async () => {
      events.push("second:start");
      await second.promise;
      events.push("second:end");
    });

    await flushMicrotasks();
    expect(events).toEqual(["first:start"]);

    first.resolve();
    await firstRun;
    await flushMicrotasks();
    expect(events).toEqual(["first:start", "first:end", "second:start"]);

    second.resolve();
    await secondRun;
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });
});

describe("chat settings write integration", () => {
  test("tracks model and effort writes before later chat RPCs", () => {
    expect(
      countOccurrences(
        stateSource,
        "return chatSettingsWrites.run(id, async () => {",
      ),
    ).toBe(2);
    expect(stateSource).toContain(
      "async function waitForChatSettingsWrites(id: string)",
    );
  });

  test("waits for settings writes before sending or resuming", () => {
    const directStepWait = stateSource.indexOf(
      "await waitForChatSettingsWrites(chat);",
    );
    const directStepRpc = stateSource.indexOf(
      `const r = await api("step", { chatId: chat, message: text,`,
    );
    expect(directStepWait).toBeGreaterThanOrEqual(0);
    expect(directStepRpc).toBeGreaterThan(directStepWait);

    const queuedStepWait = stateSource.indexOf(
      "await waitForChatSettingsWrites(head.chatId);",
    );
    const queuedStepRpc = stateSource.indexOf(
      `const r = await api("step", {\n          chatId: head.chatId,`,
    );
    expect(queuedStepWait).toBeGreaterThanOrEqual(0);
    expect(queuedStepRpc).toBeGreaterThan(queuedStepWait);

    const resumeWait = stateSource.indexOf(
      `await waitForChatSettingsWrites(id);\n    const r = await api("resume", { chatId: id });`,
    );
    expect(resumeWait).toBeGreaterThanOrEqual(0);
  });
});


describe("chat stop queue integration", () => {
  test("keeps queued follow-ups paused until interrupt completes", () => {
    expect(stateSource).toContain("const [interruptingChats, setInterruptingChats]");
    expect(stateSource).toContain("setHas(interruptingChats(), id)");

    const addInterrupting = stateSource.indexOf(
      "addToSet(setInterruptingChats, interruptingChats, id);",
    );
    const interruptRpc = stateSource.indexOf(
      `const r = await api("interrupt", { chatId: id });`,
    );
    const clearInterrupting = stateSource.indexOf(
      "deleteFromSet(setInterruptingChats, interruptingChats, id);",
      interruptRpc,
    );
    const resumeQueuedDrain = stateSource.indexOf(
      "if (options.resumeQueued) queueMicrotask(drain);",
    );

    expect(addInterrupting).toBeGreaterThanOrEqual(0);
    expect(interruptRpc).toBeGreaterThan(addInterrupting);
    expect(clearInterrupting).toBeGreaterThan(interruptRpc);
    expect(resumeQueuedDrain).toBeGreaterThan(clearInterrupting);
  });
});
