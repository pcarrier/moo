import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const chatsSource = readFileSync(new URL("./chats.ts", import.meta.url), "utf8");
const mooSource = readFileSync(new URL("../moo.ts", import.meta.url), "utf8");

describe("chat list status", () => {
  test("pending UI input wins over stale running driver state", () => {
    expect(chatsSource).toContain('import { hasPendingInput } from "../agent";');
    expect(chatsSource).toContain('const pendingInput = c.status === "ui:Pending" || (await hasPendingInput(c.chatId));');
    expect(chatsSource).toContain('const status = pendingInput ? "ui:Pending" : c.status;');
    expect(chatsSource).toContain('runningStartedAt: status === "agent:Running" ? (c.runningStartedAt ?? null) : null');
  });

  test("moo.chat.list ignores stale running facts when the driver is idle", () => {
    expect(mooSource).toContain("function driverRunningChatState()");
    expect(mooSource).toContain("running = new Set(JSON.parse(host.runningChatIds()))");
    expect(mooSource).toContain('summary.status === "ui:Pending"');
    expect(mooSource).toContain('summary.status === "agent:Running"');
    expect(mooSource).toContain('? "agent:Done"');
    expect(mooSource).not.toContain('} else if (stepRows.some((s) => s["?status"] === "agent:Running"))');
    expect(mooSource).toContain('runningStartedAt: status === "agent:Running" ? (runningStartedAt[cid] ?? null) : null');
  });
  test("host fact summaries do not promote stale running step rows", () => {
    const factsSource = readFileSync(new URL("../../../src/ops/facts.rs", import.meta.url), "utf8");
    expect(factsSource).toContain("and object = 'agent:Queued'");
    expect(factsSource).not.toContain("object in ('agent:Running', 'agent:Queued')");
  });
});
