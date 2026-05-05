import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";

const COMPACT_NAV_BREAKPOINT_REM = 48;
const COMPACT_NAV_QUERY = `(max-width: ${COMPACT_NAV_BREAKPOINT_REM}rem)`;

function compactNavBreakpointPx() {
  if (typeof window === "undefined") return COMPACT_NAV_BREAKPOINT_REM * 16;
  const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return COMPACT_NAV_BREAKPOINT_REM * (Number.isFinite(rootFontSize) ? rootFontSize : 16);
}

function compactNavMatches() {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.(COMPACT_NAV_QUERY).matches ?? window.innerWidth <= compactNavBreakpointPx();
}

import { NewChatView, RightSidebar, Sidebar } from "./Sidebar";
import { Timeline } from "./Timeline";
import { FactsView, PointersView } from "./MemoryView";
import { AppsView } from "./AppsView";
import { McpView } from "./McpView";
import { V8View } from "./V8View";
import { SettingsView } from "./SettingsView";
import { type Bag } from "./state";

export function App(props: { bag: Bag }) {
  const { bag } = props;
  let appRoot: HTMLDivElement | undefined;
  const [mobileNavOpen, setMobileNavOpen] = createSignal(false);
  const [mobileNavMode, setMobileNavMode] = createSignal(compactNavMatches());
  let mobileRightSidebarCollapsedForChat: string | null = null;
  const isMobileNav = () => {
    if (typeof window === "undefined") return mobileNavMode();
    return compactNavMatches();
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
  const mobileRightSidebarOpen = () => mobileNavMode() && bag.rightSidebarTabs().length > 0 && !bag.rightSidebarCollapsed();
  const closeMobileOverlays = () => {
    if (mobileNavOpen()) setMobileNavOpen(false);
    if (mobileRightSidebarOpen()) bag.setRightSidebarCollapsed(true);
  };

  createEffect(() => {
    const mobile = mobileNavMode();
    const id = bag.chatId();
    if (!mobile) {
      mobileRightSidebarCollapsedForChat = null;
      return;
    }
    if (!id || mobileRightSidebarCollapsedForChat === id) return;
    mobileRightSidebarCollapsedForChat = id;
    // The right pane is fixed on phones and otherwise covers the conversation.
    // Collapse it once per chat/mobile entry, but keep explicit user opens intact.
    if (!bag.rightSidebarCollapsed()) bag.setRightSidebarCollapsed(true, { persist: false });
  });

  onMount(() => {
    const mobileQuery = window.matchMedia(COMPACT_NAV_QUERY);
    let viewportRaf = 0;
    const syncViewportHeight = () => {
      if (viewportRaf) return;
      viewportRaf = window.requestAnimationFrame(() => {
        viewportRaf = 0;
        const visualViewport = window.visualViewport;
        const height = visualViewport?.height || window.innerHeight || document.documentElement.clientHeight;
        document.documentElement.style.setProperty("--app-viewport-h", `${Math.max(0, Math.round(height))}px`);
      });
    };
    const syncMobileMode = () => {
      const mobile = mobileQuery.matches;
      setMobileNavMode(mobile);
      if (!mobile) setMobileNavOpen(false);
      syncViewportHeight();
    };
    syncMobileMode();
    bag.start();
    const legacyMobileQuery = mobileQuery as MediaQueryList & {
      addListener?: (listener: (this: MediaQueryList, ev: MediaQueryListEvent) => void) => void;
      removeListener?: (listener: (this: MediaQueryList, ev: MediaQueryListEvent) => void) => void;
    };
    mobileQuery.addEventListener?.("change", syncMobileMode) ??
      legacyMobileQuery.addListener?.(syncMobileMode as (this: MediaQueryList, ev: MediaQueryListEvent) => void);
    syncViewportHeight();
    window.addEventListener("resize", syncViewportHeight);
    window.addEventListener("orientationchange", syncViewportHeight);
    window.visualViewport?.addEventListener("resize", syncViewportHeight);
    window.visualViewport?.addEventListener("scroll", syncViewportHeight);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      mobileQuery.removeEventListener?.("change", syncMobileMode) ??
        legacyMobileQuery.removeListener?.(syncMobileMode as (this: MediaQueryList, ev: MediaQueryListEvent) => void);
      if (viewportRaf) window.cancelAnimationFrame(viewportRaf);
      window.removeEventListener("resize", syncViewportHeight);
      window.removeEventListener("orientationchange", syncViewportHeight);
      window.visualViewport?.removeEventListener("resize", syncViewportHeight);
      window.visualViewport?.removeEventListener("scroll", syncViewportHeight);
      document.documentElement.style.removeProperty("--app-viewport-h");
      window.removeEventListener("keydown", onKeyDown);
    });
  });

  const installLeftResizer = (handle: HTMLDivElement) => {
    let dragging = false;
    let startX = 0;
    let startW = 0;
    let viewportW = 0;
    const onMove = (e: MouseEvent) => {
      if (!dragging || viewportW <= 0) return;
      bag.setSidebarW(((startW + (e.clientX - startX)) / viewportW) * 100);
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
      const sidebarEl = appRoot?.querySelector(".sidebar") as HTMLElement | null;
      startW = sidebarEl?.getBoundingClientRect().width ?? 0;
      viewportW = document.documentElement?.clientWidth || window.innerWidth || 0;
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
        "right-sidebar-maximized": bag.rightSidebarTabs().length > 0 && !bag.rightSidebarCollapsed() && bag.rightSidebarMaximized(),
      }}
      data-mobile-nav={mobileNavMode() ? "true" : "false"}
      data-mobile-nav-open={mobileNavOpen() ? "true" : "false"}
      style={{ "--sidebar-w": bag.sidebarW(), "--right-sidebar-w": bag.rightSidebarW() }}
    >
      <Sidebar bag={bag} onNavigate={() => isMobileNav() && setMobileNavOpen(false)} />
      <button
        type="button"
        class="mobile-scrim"
        aria-label={mobileNavOpen() ? "close navigation" : "close right sidebar"}
        onClick={closeMobileOverlays}
      />
      <div class="resizer" ref={(e) => installLeftResizer(e)} />
      <Show
        when={bag.view() === "facts"}
        fallback={
          <Show
            when={bag.view() === "pointers"}
            fallback={
              <Show
                when={bag.view() === "apps"}
            fallback={
              <Show
                when={bag.view() === "mcp"}
                fallback={
                  <Show
                    when={bag.view() === "settings"}
                    fallback={
                      <Show
                        when={bag.view() === "v8"}
                        fallback={
                          <Show
                            when={bag.view() === "new"}
                            fallback={
                              <Timeline
                                bag={bag}
                                onToggleSidebar={toggleSidebar}
                                onOpenSidebar={openSidebar}
                              />
                            }
                          >
                            <NewChatView bag={bag} onToggleSidebar={toggleSidebar} />
                          </Show>
                        }
                      >
                        <V8View bag={bag} onToggleSidebar={toggleSidebar} />
                      </Show>
                    }
                  >
                    <SettingsView bag={bag} onToggleSidebar={toggleSidebar} />
                  </Show>
                }
              >
                <McpView bag={bag} onToggleSidebar={toggleSidebar} />
              </Show>
            }
          >
                <AppsView bag={bag} onToggleSidebar={toggleSidebar} />
              </Show>
            }
          >
            <PointersView bag={bag} onToggleSidebar={toggleSidebar} />
          </Show>
        }
      >
        <FactsView bag={bag} onToggleSidebar={toggleSidebar} />
      </Show>
      <Show when={bag.rightSidebarTabs().length > 0}>
        <RightSidebar bag={bag} />
      </Show>
      <Show when={bag.startupLoading()}>
        <StartupLoading />
      </Show>
      <Toasts bag={bag} />
    </div>
  );
}

function StartupLoading() {
  return (
    <div class="startup-loading" role="status" aria-live="polite" aria-busy="true">
      <div>
        <div class="startup-loading-cow" aria-hidden="true">🐮</div>
      </div>
    </div>
  );
}

function Toasts(props: { bag: Bag }) {
  const { bag } = props;
  const [detailToast, setDetailToast] = createSignal<ReturnType<typeof bag.toasts>[number] | null>(null);
  const closeDetails = () => setDetailToast(null);
  const handleLightboxKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && detailToast()) closeDetails();
  };
  onMount(() => window.addEventListener("keydown", handleLightboxKeyDown));
  onCleanup(() => window.removeEventListener("keydown", handleLightboxKeyDown));
  return (
    <>
      <Show when={bag.toasts().length > 0}>
        <div class="toasts" role="status" aria-live="polite">
          <For each={bag.toasts()}>
            {(t) => (
              <div
                classList={{ toast: true, "toast-clickable": !!t.details }}
                role={t.details ? "button" : undefined}
                tabindex={t.details ? 0 : undefined}
                title={t.details ? "Show error details" : undefined}
                onClick={() => t.details && setDetailToast(t)}
                onKeyDown={(e) => {
                  if (!t.details || (e.key !== "Enter" && e.key !== " ")) return;
                  e.preventDefault();
                  setDetailToast(t);
                }}
              >
                <div class="toast-source">{t.source}</div>
                <div class="toast-message">{t.message}</div>
                <Show when={t.details}>
                  <div class="toast-hint">Click for details</div>
                </Show>
                <button
                  class="toast-dismiss"
                  title="dismiss"
                  onClick={(e) => {
                    e.stopPropagation();
                    bag.dismissToast(t.id);
                    if (detailToast()?.id === t.id) closeDetails();
                  }}
                >
                  ×
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={detailToast()}>
        {(t) => (
          <div class="lightbox-backdrop" role="presentation" onClick={closeDetails}>
            <div
              class="error-lightbox"
              role="dialog"
              aria-modal="true"
              aria-labelledby="error-lightbox-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div class="error-lightbox-header">
                <div>
                  <div id="error-lightbox-title" class="error-lightbox-title">{t().source}</div>
                  <div class="error-lightbox-message">{t().message}</div>
                </div>
                <button class="error-lightbox-close" title="close" onClick={closeDetails}>×</button>
              </div>
              <pre class="error-lightbox-details">{t().details}</pre>
            </div>
          </div>
        )}
      </Show>
    </>
  );
}
