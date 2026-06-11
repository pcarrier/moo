import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const stateSource = readFileSync(new URL("./state.ts", import.meta.url), "utf8");

describe("chat timeline LRU cache", () => {
  test("caches snapshot describe results even after switching away", () => {
    const snapshotBlockStart = stateSource.indexOf(`const r = await retryChatLoad(
        () => api("describe", { chatId: id, mode: "snapshot", limit })`);
    expect(snapshotBlockStart).toBeGreaterThanOrEqual(0);
    const snapshotBlockEnd = stateSource.indexOf("} else {", snapshotBlockStart);
    const snapshotBlock = stateSource.slice(snapshotBlockStart, snapshotBlockEnd);

    expect(snapshotBlock).toContain("cacheDescribeSnapshot(id, r.value, limit);");
    expect(snapshotBlock.indexOf("cacheDescribeSnapshot(id, r.value, limit);")).toBeLessThan(
      snapshotBlock.indexOf("if (chatId() !== id) return;"),
    );
  });

  test("caches incremental describe results even after switching away", () => {
    const incrementalBlockStart = stateSource.indexOf(`const r = await retryChatLoad(
          () =>
            api("describe", {
              chatId: id,
              mode: "update",`);
    expect(incrementalBlockStart).toBeGreaterThanOrEqual(0);
    const incrementalBlockEnd = stateSource.indexOf(`const r = await retryChatLoad(
        () => api("describe", { chatId: id, mode: "snapshot"`, incrementalBlockStart);
    const incrementalBlock = stateSource.slice(incrementalBlockStart, incrementalBlockEnd);

    expect(incrementalBlock).toContain("if (r.ok) cacheDescribeUpdate(id, r.value);");
    expect(incrementalBlock.indexOf("if (r.ok) cacheDescribeUpdate(id, r.value);")).toBeLessThan(
      incrementalBlock.indexOf("if (chatId() !== id) return;"),
    );
  });
  test("keeps cached pages available after chat facts change", () => {
    const invalidateStart = stateSource.indexOf("function invalidateChatCache(");
    expect(invalidateStart).toBeGreaterThanOrEqual(0);
    const invalidateEnd = stateSource.indexOf("function compact", invalidateStart);
    const invalidateBlock = stateSource.slice(invalidateStart, invalidateEnd);

    expect(invalidateBlock).toContain("delete next.checkpoint;");
    expect(invalidateBlock).toContain("Keep cached");
    expect(invalidateBlock).not.toContain("delete next.overview;");
    expect(invalidateBlock).not.toContain("delete next.timelinePages;");
    expect(invalidateBlock).not.toContain("delete next.trailPages;");
    expect(invalidateBlock).not.toContain("delete next.activeTimelineKey;");
    expect(invalidateBlock).not.toContain("delete next.activeTrailKey;");
  });

  test("restores stale cached timelines during chat switches", () => {
    const selectStart = stateSource.indexOf("async function selectChat(");
    expect(selectStart).toBeGreaterThanOrEqual(0);
    const selectEnd = stateSource.indexOf("function olderTimelineLoadCount", selectStart);
    const selectBlock = stateSource.slice(selectStart, selectEnd);

    expect(selectBlock).toContain(
      "const restored = restoreCachedChat(id, summary, { allowStale: true });",
    );

    const routeStart = stateSource.indexOf("async function openUiInstanceFromRoute");
    expect(routeStart).toBeGreaterThanOrEqual(0);
    const routeEnd = stateSource.indexOf("// -- chat lifecycle", routeStart);
    const routeBlock = stateSource.slice(routeStart, routeEnd);

    expect(routeBlock).toContain("const restored = restoreCachedChat(resolved.chatId, summary, {");
    expect(routeBlock).toContain("allowStale: true,");
  });
  test("restores current chat-list metadata over stale cached overviews", () => {
    const restoreStart = stateSource.indexOf("function cachedSnapshotForLimit(");
    expect(restoreStart).toBeGreaterThanOrEqual(0);
    const restoreEnd = stateSource.indexOf("function cachedDescribeNeedsRefresh", restoreStart);
    const restoreBlock = stateSource.slice(restoreStart, restoreEnd);

    expect(restoreBlock).toContain(
      "overview: mergeCachedOverviewWithSummary(cached.overview, summary)",
    );
    expect(restoreBlock).toContain("applyOverviewValue(");
    expect(restoreBlock).toContain(
      "mergeCachedOverviewWithSummary(cached.overview, summary)",
    );
  });

  test("scopes live token progress per chat", () => {
    expect(stateSource).toContain("const tokensByChat = new Map<string, TokenProgressValue>();");
    expect(stateSource).toContain("function showTokensForChat(id: string | null)");
    expect(stateSource).toContain("function forgetTokensForChat(id: string)");
    expect(stateSource).toContain("applyTokensForChat(id, value.tokens, {");

    const tokenEventStart = stateSource.indexOf('if (ev.kind === "tokens")');
    expect(tokenEventStart).toBeGreaterThanOrEqual(0);
    const tokenEventEnd = stateSource.indexOf('if (ev.kind === "reasoning-draft")', tokenEventStart);
    const tokenEventBlock = stateSource.slice(tokenEventStart, tokenEventEnd);
    expect(tokenEventBlock).toContain("const cur = currentTokensForChat(ev.chatId);");
    expect(tokenEventBlock).toContain("applyTokensForChat(ev.chatId, next, {");
    expect(tokenEventBlock).toContain("active: activeChats().has(ev.chatId)");
    expect(tokenEventBlock).not.toContain("setTokens((cur)");
  });

  test("new chats start with empty token and sidebar state", () => {
    const createStart = stateSource.indexOf("async function createChat(");
    expect(createStart).toBeGreaterThanOrEqual(0);
    const createEnd = stateSource.indexOf("async function removeChat", createStart);
    const createBlock = stateSource.slice(createStart, createEnd);
    expect(createBlock).toContain("forgetChatCache(requestedChatId);");
    expect(createBlock).toContain("forgetTokensForChat(requestedChatId);");
    expect(createBlock).toContain("forgetTasksForChat(requestedChatId);");
    expect(createBlock).toContain("forgetRightSidebarForChat(requestedChatId);");
    expect(createBlock).toContain("showTokensForChat(requestedChatId);");
    expect(createBlock).toContain("showTasksForChat(requestedChatId);");
    expect(createBlock).toContain("setChatUiApps([]);");
    expect(createBlock).toContain("setUiInstances([]);");
  });

});
