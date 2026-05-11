import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const stateSource = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
const chatApiSource = readFileSync(new URL("./api/chat.ts", import.meta.url), "utf8");

describe("timeline fork action", () => {
  test("navigates to a seeded fork before the backend copy finishes", () => {
    const forkStart = stateSource.indexOf("async function forkChatAtStep");
    expect(forkStart).toBeGreaterThanOrEqual(0);
    const forkEnd = stateSource.indexOf("async function setSelectedModel", forkStart);
    expect(forkEnd).toBeGreaterThan(forkStart);
    const forkBlock = stateSource.slice(forkStart, forkEnd);

    expect(forkBlock).toContain("const requestedChatId = optimisticChatId();");
    expect(forkBlock).toContain("seedForkChatCache(requestedChatId");
    expect(forkBlock).toContain("const creation = (async () => {");
    expect(forkBlock).toContain("pendingChatCreations.set(requestedChatId, creation);");
    expect(forkBlock).toContain("await selectChat(requestedChatId, false);");
    expect(forkBlock).toContain("api.chat.fork(id as ChatId, step as StepId, requestedChatId)");
    expect(forkBlock.indexOf("await selectChat(requestedChatId, false);")).toBeGreaterThan(
      forkBlock.indexOf("pendingChatCreations.set(requestedChatId, creation);"),
    );
    expect(forkBlock.indexOf("pendingChatCreations.set(requestedChatId, creation);")).toBeGreaterThan(
      forkBlock.indexOf("const creation = (async () => {"),
    );
  });

  test("waits for pending fork creation before hydration refreshes", () => {
    const selectStart = stateSource.indexOf("async function selectChat(");
    expect(selectStart).toBeGreaterThanOrEqual(0);
    const selectEnd = stateSource.indexOf("function olderTimelineLoadCount", selectStart);
    expect(selectEnd).toBeGreaterThan(selectStart);
    const selectBlock = stateSource.slice(selectStart, selectEnd);

    expect(selectBlock).toContain("const restored = restoreCachedChat(id, summary, { allowStale: true });");
    expect(selectBlock).toContain("if (!(await waitForChatCreation(id))) return;");
    expect(selectBlock.indexOf("if (!(await waitForChatCreation(id))) return;")).toBeLessThan(
      selectBlock.indexOf("await refreshTimeline();"),
    );
  });

  test("passes the optimistic fork id to chat-fork", () => {
    expect(chatApiSource).toContain("fork: (chatId: ChatId, step: StepId, forkChatId?: ChatId) =>");
    expect(chatApiSource).toContain("...(forkChatId ? { forkChatId } : {}),");
  });
});
