import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";

const sidebar = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
const css = readStylesheetForTest();

describe("chat list auto loading", () => {
  test("loads more chats from scroll position instead of buttons", () => {
    expect(sidebar).toContain("const queueLoadMoreChats = () =>");
    expect(sidebar).toContain("onScroll={queueLoadMoreChats}");
    expect(sidebar).toContain("listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 96");
    expect(sidebar).toContain("setRenderedActiveLimit((n) => n + RENDERED_CHATS_PAGE)");
    expect(sidebar).toContain("setRenderedArchivedLimit((n) => n + RENDERED_CHATS_PAGE)");
    expect(sidebar).not.toContain("show {Math.min(RENDERED_CHATS_PAGE, hiddenActiveChats())}");
    expect(sidebar).not.toContain("show {Math.min(RENDERED_CHATS_PAGE, hiddenArchivedChats())}");
    expect(sidebar).not.toContain('class="chat-list-more"');
  });

  test("shows animated loading dots at the bottom while loading more", () => {
    expect(sidebar).toContain('class="chat-list-loading"');
    expect(sidebar).toContain('class="chat-list-loading-dots"');
    expect(sidebar).toContain('label="loading more chats"');
    expect(sidebar).toContain('label="loading more archived chats"');
    expect(css).toContain(".chat-list-loading {");
    expect(css).toContain(".chat-list-loading-dots {");
  });

  test("shows chat project paths without hiding them as actions", () => {
    expect(sidebar).toContain('class="chat-directory"');
    expect(css).toContain(".chat-directory {");
    expect(css).not.toContain(".chat-cost,\n.chat-directory,\n.chat-actions {");
  });

  test("shows base branches next to chat project paths", () => {
    expect(sidebar).toContain('class="chat-repo-line"');
    expect(sidebar).toContain('class="chat-base-branch"');
    expect(sidebar).toContain('class="chat-repo-separator"');
    expect(sidebar).toContain('title={"base branch: " + baseBranch()}');
    expect(css).toContain(".chat-repo-line {");
    expect(css).toContain(".chat-repo-separator {");
    expect(css).toContain(".chat-base-branch {");
    const branchRuleStart = css.indexOf(".chat-base-branch {");
    const branchRule = css.slice(branchRuleStart, css.indexOf("}", branchRuleStart));
    expect(branchRule).not.toContain("border");
  });
});
