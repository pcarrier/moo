import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";

const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
const css = readStylesheetForTest();
const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");

function cssRuleBody(selector: string) {
  const marker = `${selector} {`;
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`missing CSS rule: ${selector}`);
  const bodyStart = start + marker.length;
  const end = css.indexOf("}\n", bodyStart);
  if (end < 0) throw new Error(`unterminated CSS rule: ${selector}`);
  return css.slice(bodyStart, end);
}

describe("timeline message visibility", () => {
  test("hide and restore buttons show immediate pending feedback", () => {
    expect(timeline).toContain("const [visibilityPending, setVisibilityPending] = createSignal(false);");
    expect(timeline).toContain("setVisibilityPending(true);");
    expect(timeline).toContain("disabled={visibilityPending()}");
    expect(timeline).toContain("updating message visibility…");
    expect(timeline).toContain("onClick={() => void toggleMessageVisibility()}");
  });

  test("hide and restore update the timeline optimistically", () => {
    expect(state).toContain("const optimisticDeletedAt = Date.now();");
    expect(state).toContain("patchMessageVisibility(id, step, optimisticDeletedAt);");
    expect(state).toContain("patchMessageVisibility(id, step, null);");
    expect(state).toContain("void refreshTimeline();");
  });

  test("load older ignores cached timeline pages smaller than the requested limit", () => {
    expect(state).toContain("const cached = cachedSnapshotForLimit(");
    expect(state).toContain("nextLimit,");
    expect(state).toContain(
      "return !!page && (limit == null || (page.limit ?? 0) >= limit);",
    );
    expect(state).toContain("await refreshTimeline();");
  });

  test("automatically loads older timeline history near the top", () => {
    expect(timeline).toContain("const OLDER_HISTORY_SCROLL_THRESHOLD_EM = 8;");
    expect(timeline).toContain("const maybeLoadOlderTimeline = () => {");
    expect(timeline).toContain(
      "if (isNearTop() && bag.hiddenTimelineItems() > 0) void bag.loadOlderTimeline();",
    );
    expect(timeline).toContain("maybeLoadOlderTimeline();");
  });

  test("shows animated dots while older history is loading", () => {
    expect(state).toContain("const [olderTimelineLoading, setOlderTimelineLoading] = createSignal(false);");
    expect(state).toContain("if (olderTimelineLoading()) return;");
    expect(state).toContain("setOlderTimelineLoading(true);");
    expect(state).toContain("setOlderTimelineLoading(false);");
    expect(timeline).toContain("bag.olderTimelineLoading()");
    expect(timeline).toContain('<div class="history-loading">');
    expect(timeline).toContain('<LoadingDots\n                        class="history-loading-dots"\n                        label="loading older history"');
    expect(timeline).not.toContain("Load {bag.olderTimelineLoadCount()} older items");
    expect(timeline).not.toContain("onClick={() => bag.loadOlderTimeline()}");
  });

  test("does not box older-history loading dots", () => {
    const body = cssRuleBody(".history-loading");
    expect(body).toContain("align-self: center");
    expect(body).toContain("color: var(--muted)");
    expect(body).toContain("justify-content: center");
    expect(body).not.toContain("border:");
    expect(body).not.toContain("background:");
    expect(timeline).not.toContain('class="load-older load-older-loading"');
  });

  test("keeps chat switches with terminal layout changes pinned to the bottom", () => {
    expect(timeline).toContain("const LAYOUT_SCROLL_STICKY_GRACE_MS = 600;");
    expect(timeline).toContain("const USER_SCROLL_INTENT_GRACE_MS = 900;");
    expect(timeline).toContain("const resetScrollForChatChange = () => {");
    expect(timeline).toContain("stuck = true;");
    expect(timeline).toContain("scrollAnchor = null;");
    expect(timeline).toContain("const id = bag.chatId();");
    expect(timeline).toContain("if (id === lastChatId) return;");
    expect(timeline).toContain("resetScrollForChatChange();");
    expect(timeline).toContain("const notePotentialLayoutScroll = () => {");
    expect(timeline).toContain("stickyLayoutScrollUntil = Date.now() + LAYOUT_SCROLL_STICKY_GRACE_MS;");
    expect(timeline).toContain("const resizeObserver = new ResizeObserver(notePotentialLayoutScroll);");
    expect(timeline).toContain("!hasRecentUserScrollIntent()");
    expect(timeline).toContain('timelineEl?.addEventListener("wheel", markUserScrollIntent');
    expect(timeline).toContain('timelineEl?.addEventListener("touchstart", markUserScrollIntent');
    expect(timeline).toContain('timelineEl?.addEventListener("pointerdown", markUserScrollIntent');
    expect(timeline).toContain('timelineEl?.addEventListener("keydown", handleScrollIntentKey');
    expect(timeline).toContain("isLikelyLayoutScroll()");
  });
});
