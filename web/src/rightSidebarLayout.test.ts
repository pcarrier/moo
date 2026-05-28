import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";

const css = readStylesheetForTest();
const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");

function cssBlockAfter(selector: string) {
  const start = css.indexOf(selector);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf("{", start) + 1;
  expect(bodyStart).toBeGreaterThan(0);
  const end = css.indexOf("}\n", bodyStart);
  expect(end).toBeGreaterThan(bodyStart);
  return css.slice(bodyStart, end);
}

describe("right sidebar layout", () => {
  test("maximized right sidebar collapses the hidden timeline column", () => {
    const collapsedOpenRule = css.indexOf("#app.collapsed.repo-file-open {");
    const maximizedCollapsedOpenRule = css.indexOf(
      "#app.collapsed.repo-file-open.right-sidebar-maximized",
    );

    expect(collapsedOpenRule).toBeGreaterThanOrEqual(0);
    expect(maximizedCollapsedOpenRule).toBeGreaterThan(collapsedOpenRule);
    expect(
      cssBlockAfter("#app.collapsed.repo-file-open.right-sidebar-maximized"),
    ).toContain("grid-template-columns: 0 0 minmax(0, 1fr);");
  });

  test("does not carry chat sidebar tabs into new chats", () => {
    expect(state).toContain("function forgetRightSidebarForChat(id: string)");
    expect(state).toContain("forgetRightSidebarForChat(requestedChatId);");
    expect(state).toContain("function resetSelectedChatViewState(");
    expect(state).toContain("opts: {");
    expect(state).toContain("setOpenUiId(null);");
    expect(state).toContain("setOpenUiInstanceId(null);");
  });

  test("refreshes file tabs in the event chat scope", () => {
    expect(state).toContain(
      "async function refreshMatchingRepoFiles(path: string, targetChatId = chatId())",
    );
    expect(state).toContain("rightSidebarFileTabsForScope(scopeId)");
    expect(state).toContain("readRepoFileIntoSidebarScope(");
    const fileDiffBlock = state.slice(
      state.indexOf('if (ev.kind === "file-diff")'),
      state.indexOf('if (ev.kind === "todo-diff")'),
    );
    expect(fileDiffBlock).toContain("refreshMatchingRepoFilesSoon(ev.path, ev.chatId);");
    expect(
      fileDiffBlock.indexOf("refreshMatchingRepoFilesSoon(ev.path, ev.chatId);"),
    ).toBeGreaterThan(fileDiffBlock.indexOf("if (cid && ev.chatId === cid)"));
    expect(state).toContain(
      'pendingRepoFileRefreshPaths.add(`${targetChatId ?? ""}\\n${path}`);',
    );
  });
});
