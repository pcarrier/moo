import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const sidebar = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
const memoryView = readFileSync(new URL("./MemoryView.tsx", import.meta.url), "utf8");
const pool = readFileSync(new URL("../../src/pool.rs", import.meta.url), "utf8");
const ws = readFileSync(new URL("../../src/ws.rs", import.meta.url), "utf8");

describe("left sidebar memory counts", () => {
  test("facts count shows loading until graph summaries have loaded", () => {
    expect(sidebar).toContain("const factsCountLabel = createMemo");
    expect(sidebar).toContain('if (!bag.graphSummariesLoaded()) return "loading"');
    expect(sidebar).toContain('<span class="sidebar-tab-count">{factsCountLabel()}</span>');
  });

  test("facts and pointers pages show loading stat pills before data loads", () => {
    expect(memoryView).toContain("when={bag.graphSummariesLoaded()}");
    expect(memoryView).toContain('<StatPill value="loading" label="facts" />');
    expect(memoryView).toContain("when={bag.pointersLoaded()}");
    expect(memoryView).toContain('fallback={<StatPill value="loading" label={isSearching() ? "matches" : "pointers"} />}');
  });

  test("direct chat startup still refreshes fact summaries for the sidebar", () => {
    const directChatStart = state.indexOf("if (directChatId) {");
    expect(directChatStart).toBeGreaterThan(0);
    const directChatBranch = state.slice(
      directChatStart,
      state.indexOf("await refreshChats();", directChatStart),
    );
    expect(directChatBranch).toContain("refreshGraphSummaries();");
  });

  test("facts and pointers bypass the V8 write lane", () => {
    expect(pool).toContain('"pointers",');
    expect(pool).toContain('"graph-summaries", "memory-query"');
    expect(ws).toContain('"pointers" => pointers_command(db, payload)');
    expect(ws).toContain('"graph-summaries" => graph_summaries_command(db, payload)');
  });

  test("pointer refresh cannot leave the sidebar loading forever after failure", () => {
    const refreshStart = state.indexOf("async function refreshPointers");
    expect(refreshStart).toBeGreaterThan(0);
    const refresh = state.slice(refreshStart, state.indexOf("async function removePointer", refreshStart));
    expect(refresh).toContain("try {");
    expect(refresh).toContain("catch (err)");
    expect(refresh).toContain("finally {");
    expect(refresh).toContain("setPointersLoaded(true);");
  });
  test("chat metadata shows zero price when cost is unavailable", () => {
    expect(sidebar).toContain('Number.isFinite(chat.costUsd) ? chat.costUsd! : 0');
    expect(sidebar).not.toContain('hasDisplayableCost');
    expect(sidebar).toContain('{" · "}');
    expect(sidebar).toContain('class="chat-cost-value"');
    expect(sidebar).not.toContain('class="chat-cost"');
  });
});
