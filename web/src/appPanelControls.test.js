import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";

const chatApps = readFileSync(new URL("./ChatApps.tsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
const headerControls = readFileSync(new URL("./HeaderControls.tsx", import.meta.url), "utf8");
const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
const icons = readFileSync(new URL("./icons.tsx", import.meta.url), "utf8");
const css = readStylesheetForTest();

describe("header control icons", () => {
  test("uses fixed-size SVG icons for sidebar and app-panel controls", () => {
    expect(headerControls).toContain("<MenuIcon />");
    expect(sidebar).toContain("<PlusIcon />");
    expect(headerControls).toContain("<PanelIcon />");
    expect(sidebar).toContain("? <RestoreIcon /> : <MaximizeIcon />");
    expect(chatApps).toContain("? <RestoreIcon /> : <MaximizeIcon />");
    expect(chatApps).toContain("<CloseIcon />");
    expect(timeline).toContain("<CompactIcon class=\"token-compact-icon\" />");

    expect(sidebar).not.toContain("new-chat-plus");
    expect(chatApps).not.toContain("right-sidebar-size-icon");
    expect(sidebar).not.toContain("right-sidebar-size-icon");
    expect([headerControls, sidebar, chatApps, timeline].join("\n")).not.toContain("☰");
    expect([headerControls, sidebar, chatApps].join("\n")).not.toContain("◨");
  });

  test("shared icon CSS fixes every toolbar glyph to the same size", () => {
    expect(icons).toContain('viewBox="0 0 16 16"');
    const iconRule = css.slice(css.indexOf(".ui-icon"), css.indexOf(".token-compact-icon"));
    expect(iconRule).toContain("inline-size: 1rem;");
    expect(iconRule).toContain("block-size: 1rem;");
    expect(iconRule).toContain("stroke-width: 1.8;");
    expect(css).not.toContain(".new-chat-plus");
    expect(css).not.toContain(".right-sidebar-size-icon");
  });

  test("app bridge listens before posting requests", () => {
    const requestStart = chatApps.indexOf("request(method, payload) {");
    const requestEnd = chatApps.indexOf("state: { get:", requestStart);
    const requestBlock = chatApps.slice(requestStart, requestEnd);

    expect(requestBlock.indexOf("window.addEventListener('message', onMessage);")).toBeGreaterThan(-1);
    expect(requestBlock.indexOf("parent.postMessage({ source: 'moo-ui'")).toBeGreaterThan(-1);
    expect(requestBlock.indexOf("window.addEventListener('message', onMessage);")).toBeLessThan(
      requestBlock.indexOf("parent.postMessage({ source: 'moo-ui'"),
    );
  });

  test("app bridge accepts messages from any live frame in the stack", () => {
    expect(chatApps).toContain("let frameStack: HTMLDivElement | undefined;");
    expect(chatApps).toContain("const isUiFrameSource = (source: MessageEventSource | null) => {");
    expect(chatApps).toContain('frameStack?.querySelectorAll("iframe")');
    expect(chatApps).toContain('ref={frameStack}');
    expect(chatApps).not.toContain("frame = pendingFrame;");
  });

  test("chat burger menu button has no hairline frame", () => {
    const menuRule = css.slice(css.indexOf(".chat-menu {"), css.indexOf(".chat-action-menu"));
    expect(menuRule).toContain("border: 0;");
    expect(menuRule).not.toContain("border: 1px solid var(--line);");
  });

  test("mobile chat actions are visible and tappable", () => {
    const responsiveRule = css.slice(css.indexOf("@media (max-width: 48rem)"));
    expect(sidebar).toContain("const toggleChatMenu = (chatId: string) => {");
    expect(sidebar).toContain(
      "const handleChatMenuPointerDown = (e: PointerEvent, chatId: string) => {",
    );
    expect(sidebar).toContain("onPointerDown={(e) => handleChatMenuPointerDown(e, chat.chatId)}");
    expect(sidebar).toContain("onClick={(e) => handleChatMenuClick(e, chat.chatId)}");
    expect(responsiveRule).toContain(".chat-row .chat-actions {");
    expect(responsiveRule).toContain("opacity: 0.75;");
    expect(responsiveRule).toContain("pointer-events: auto;");
    expect(responsiveRule).toContain(".chat-action-menu {");
    expect(responsiveRule).toContain("min-width: 11rem;");
    expect(responsiveRule).not.toContain(".chat-menu-popover");
  });

  test("agent-opened apps materialize as right-sidebar app tabs", () => {
    const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");

    expect(state).toContain('if (ev.kind === "ui-open")');
    expect(state).toContain("openAppRightSidebarTab(uiId, instanceId);");
    expect(state).toContain("openAppRightSidebarTab(primaryUiId, instanceId, !hasTab);");
    expect(state).toContain("function hasAppRightSidebarTab");
    expect(state).toContain('kind: "app",');
    expect(state).toContain("collapsed: activate ? false : state.collapsed");
  });

  test("plus and maximize controls use the smaller header button frame", () => {
    expect(chatApps).toContain('class="header-icon-button right-sidebar-size-toggle"');
    expect(chatApps).toContain('class="header-icon-button" title="close app"');
    const sharedRule = css.slice(css.indexOf(".collapse-btn,"), css.indexOf(".mobile-scrim"));
    expect(sharedRule).toContain(".header-icon-button,");
    expect(sharedRule).toContain("inline-size: var(--top-bar-button-size);");
    expect(sharedRule).toContain("block-size: var(--top-bar-button-size);");

    const smallControlRule = css.slice(css.indexOf(".new-chat-trigger,\n.right-sidebar-size-toggle"), css.indexOf(".new-chat-trigger {"));
    expect(css).toContain("--compact-header-button-size: 1.5rem;");
    expect(smallControlRule).toContain("inline-size: var(--compact-header-button-size);");
    expect(smallControlRule).toContain("block-size: var(--compact-header-button-size);");
    expect(smallControlRule).toContain("flex-basis: var(--compact-header-button-size);");

    const rightActionsStart = css.indexOf(".right-sidebar-actions {");
    const rightActionsRule = css.slice(rightActionsStart, css.indexOf(".right-tabs", rightActionsStart));
    expect(rightActionsRule).toContain("calc((var(--top-bar-h) - var(--compact-header-button-size)) / 2)");
  });
  test("compact icon is a simple legible compression glyph", () => {
    expect(icons).toContain('d="M3.5 5h9M3.5 11h9"');
    expect(icons).toContain('d="M8 2.75v4.5M8 13.25v-4.5"');
    expect(icons).toContain('d="M5.75 5.25 8 7.5l2.25-2.25M5.75 10.75 8 8.5l2.25 2.25"');
    expect(icons).not.toContain('M4 5h8M4 8h8M4 11h8');
  });
});
