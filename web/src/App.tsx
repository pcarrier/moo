import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";

const COMPACT_NAV_BREAKPOINT_REM = 48;
const COMPACT_NAV_QUERY = `(max-width: ${COMPACT_NAV_BREAKPOINT_REM}rem)`;

function compactNavBreakpointPx() {
  if (typeof window === "undefined") return COMPACT_NAV_BREAKPOINT_REM * 16;
  const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return COMPACT_NAV_BREAKPOINT_REM * (Number.isFinite(rootFontSize) ? rootFontSize : 16);
}

import { RightSidebar, Sidebar } from "./Sidebar";
import { Timeline } from "./Timeline";
import { MemoryView } from "./MemoryView";
import { AppsView } from "./AppsView";
import { McpView } from "./McpView";
import { type Bag } from "./state";

export function App(props: { bag: Bag }) {
  const { bag } = props;
  let appRoot: HTMLDivElement | undefined;
  const [mobileNavOpen, setMobileNavOpen] = createSignal(false);
  const [mobileNavMode, setMobileNavMode] = createSignal(false);
  const isMobileNav = () => {
    if (typeof window === "undefined") return mobileNavMode();
    return window.matchMedia?.(COMPACT_NAV_QUERY).matches ?? window.innerWidth <= compactNavBreakpointPx();
  };
  createEffect(() => {
    const title = bag.currentChatTitle();
    document.title = title ? `${title} · Moo` : "Moo";
  });

  const openSidebar = () => {
    if (isMobileNav()) {
      setMobileNavMode(true);
      setMobileNavOpen(true);
      return;
    }
    setMobileNavOpen(false);
    bag.setCollapsed(false);
  };
  const toggleSidebar = () => {
    if (isMobileNav()) {
      setMobileNavMode(true);
      setMobileNavOpen((open) => !open);
      return;
    }
    setMobileNavOpen(false);
    bag.setCollapsed(!bag.collapsed());
  };

  onMount(() => {
    bag.start();
    const mobileQuery = window.matchMedia(COMPACT_NAV_QUERY);
    const syncMobileMode = () => {
      const mobile = mobileQuery.matches;
      setMobileNavMode(mobile);
      if (!mobile) setMobileNavOpen(false);
    };
    syncMobileMode();
    const legacyMobileQuery = mobileQuery as MediaQueryList & {
      addListener?: (listener: (this: MediaQueryList, ev: MediaQueryListEvent) => void) => void;
      removeListener?: (listener: (this: MediaQueryList, ev: MediaQueryListEvent) => void) => void;
    };
    mobileQuery.addEventListener?.("change", syncMobileMode) ??
      legacyMobileQuery.addListener?.(syncMobileMode as (this: MediaQueryList, ev: MediaQueryListEvent) => void);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      mobileQuery.removeEventListener?.("change", syncMobileMode) ??
        legacyMobileQuery.removeListener?.(syncMobileMode as (this: MediaQueryList, ev: MediaQueryListEvent) => void);
      window.removeEventListener("keydown", onKeyDown);
    });
  });

  const installLeftResizer = (handle: HTMLDivElement) => {
    let dragging = false;
    let startX = 0;
    let startW = bag.sidebarW();
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const next = Math.max(0, Math.min(560, startW + (e.clientX - startX)));
      bag.setSidebarW(next);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startW = bag.sidebarW();
      bag.setCollapsed(false);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      e.preventDefault();
    };
    const onDoubleClick = () => bag.setCollapsed(!bag.collapsed());
    handle.addEventListener("mousedown", onDown);
    handle.addEventListener("dblclick", onDoubleClick);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    onCleanup(() => {
      handle.removeEventListener("mousedown", onDown);
      handle.removeEventListener("dblclick", onDoubleClick);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    });
  };

  return (
    <div
      id="app"
      ref={appRoot}
      classList={{
        collapsed: bag.collapsed(),
        "mobile-nav": mobileNavMode(),
        "mobile-nav-open": mobileNavOpen(),
        "repo-file-open": bag.rightSidebarTabs().length > 0 && !bag.rightSidebarCollapsed(),
        "right-sidebar-collapsed": bag.rightSidebarCollapsed(),
      }}
      data-mobile-nav={mobileNavMode() ? "true" : "false"}
      data-mobile-nav-open={mobileNavOpen() ? "true" : "false"}
      style={{ "--sidebar-w": `${bag.sidebarW()}px`, "--right-sidebar-w": `${bag.rightSidebarW()}px` }}
    >
      <Sidebar bag={bag} onNavigate={() => isMobileNav() && setMobileNavOpen(false)} />
      <button
        type="button"
        class="mobile-scrim"
        aria-label="close navigation"
        onClick={() => setMobileNavOpen(false)}
      />
      <div class="resizer" ref={(e) => installLeftResizer(e)} />
      <Show
        when={bag.view() === "memory"}
        fallback={
          <Show
            when={bag.view() === "apps"}
            fallback={
              <Show
                when={bag.view() === "mcp"}
                fallback={
                  <Timeline
                    bag={bag}
                    onToggleSidebar={toggleSidebar}
                    onOpenSidebar={openSidebar}
                  />
                }
              >
                <McpView bag={bag} onToggleSidebar={openSidebar} />
              </Show>
            }
          >
            <AppsView bag={bag} onToggleSidebar={openSidebar} />
          </Show>
        }
      >
        <MemoryView bag={bag} onToggleSidebar={openSidebar} />
      </Show>
      <Show when={bag.rightSidebarTabs().length > 0}>
        <RightSidebar bag={bag} />
      </Show>
      <Show when={bag.startupLoading()}>
        <StartupLoading message={bag.startupLoadingMessage()} />
      </Show>
      <Toasts bag={bag} />
    </div>
  );
}

function StartupLoading(props: { message: string }) {
  return (
    <div class="startup-loading" role="status" aria-live="polite" aria-busy="true">
      <div class="startup-loading-card">
        <div class="startup-loading-cow" aria-hidden="true">🐮</div>
        <div class="startup-loading-brand">Moo</div>
        <div class="startup-loading-message">{props.message}</div>
      </div>
    </div>
  );
}

function Toasts(props: { bag: Bag }) {
  const { bag } = props;
  return (
    <Show when={bag.toasts().length > 0}>
      <div class="toasts" role="status" aria-live="polite">
        <For each={bag.toasts()}>
          {(t) => (
            <div class="toast">
              <div class="toast-source">{t.source}</div>
              <div class="toast-message">{t.message}</div>
              <button
                class="toast-dismiss"
                title="dismiss"
                onClick={() => bag.dismissToast(t.id)}
              >
                ×
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
