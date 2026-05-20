import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import {
  BlitWorkspace,
  PALETTES,
  nullLogger,
  measureCell,
  type BlitSession,
  type BlitTerminalSurface,
  type BlitWorkspaceSnapshot,
  type SessionId,
  type TerminalPalette,
} from "@blit-sh/core";
import { WebSocketTransport } from "@blit-sh/core/transports";
import { BlitTerminal, BlitWorkspaceProvider } from "@blit-sh/solid";
import { getPsk } from "./auth";
import initBlitWasm from "./blitWasm";
import { hasOpenModalDialog } from "./modal";

const CONNECTION_ID = "local";
const PASSPHRASE = "moo-blit-local";
const TAG_PREFIX = "moo:";
const TERMINAL_HEIGHT_KEY = "moo.terminal.height.v1";
const TERMINAL_DEFAULT_HEIGHT = "36vh";
const TERMINAL_MAX_VH = 75;
const TERMINAL_FONT_FAMILY = "ui-monospace, monospace";
const TERMINAL_FONT_SIZE = 14;

const DARK_TERMINAL_PALETTE =
  PALETTES.find((palette) => palette.id === "vscode-dark") ??
  PALETTES.find((palette) => palette.dark) ??
  PALETTES[0];
const LIGHT_TERMINAL_PALETTE =
  PALETTES.find((palette) => palette.id === "vscode-light") ??
  PALETTES.find((palette) => !palette.dark) ??
  DARK_TERMINAL_PALETTE;

function blitWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams();
  const psk = getPsk();
  if (psk) params.set("psk", psk);
  const qs = params.toString();
  return `${proto}//${location.host}/api/blit/ws${qs ? `?${qs}` : ""}`;
}

function useWorkspaceSnapshot(workspace: BlitWorkspace) {
  const [snapshot, setSnapshot] = createSignal<BlitWorkspaceSnapshot>(
    workspace.getSnapshot(),
  );
  const unsubscribe = workspace.subscribe(() =>
    setSnapshot(workspace.getSnapshot()),
  );
  onCleanup(unsubscribe);
  return snapshot;
}

function encodeTag(chatId: string) {
  return `${TAG_PREFIX}${encodeURIComponent(chatId)}`;
}

function decodeTag(tag: string): { chatId: string } | null {
  if (!tag.startsWith(TAG_PREFIX)) return null;
  const rest = tag.slice(TAG_PREFIX.length);
  const sep = rest.indexOf(":");
  try {
    return {
      // Older chat terminals included a user-facing label after a second colon.
      chatId: decodeURIComponent(sep < 0 ? rest : rest.slice(0, sep)),
    };
  } catch {
    return null;
  }
}

function viewportHeightPx(): number {
  return (
    document.documentElement?.clientHeight ||
    window.visualViewport?.height ||
    window.innerHeight ||
    0
  );
}

function terminalCellHeightPx(): number {
  const cell = measureCell(TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE);
  return Number.isFinite(cell.h) && cell.h > 0 ? cell.h : TERMINAL_FONT_SIZE;
}

function terminalMaxPx(): number {
  const viewportH = viewportHeightPx();
  return viewportH > 0 ? (viewportH * TERMINAL_MAX_VH) / 100 : Infinity;
}

function minTerminalRows(): number {
  return 1;
}

function maxTerminalRows(cellH: number): number {
  if (!Number.isFinite(cellH) || cellH <= 0) return 1;
  const maxPx = terminalMaxPx();
  if (!Number.isFinite(maxPx) || maxPx <= 0) return Infinity;
  return Math.max(1, Math.floor(maxPx / cellH));
}

function clampTerminalRows(
  rows: number,
  cellH: number,
  _unused?: unknown,
  enforceMin = false,
): number {
  if (!Number.isFinite(rows)) return defaultTerminalRows(cellH);
  const min = enforceMin ? minTerminalRows() : 1;
  const max = Math.max(min, maxTerminalRows(cellH));
  return Math.min(max, Math.max(min, Math.round(rows)));
}

function terminalRowsFromPx(
  px: number,
  cellH: number,
  enforceMin = false,
): number | undefined {
  if (!Number.isFinite(px)) return undefined;
  if (!Number.isFinite(cellH) || cellH <= 0) return undefined;
  return clampTerminalRows(px / cellH, cellH, enforceMin);
}

function defaultTerminalRows(cellH: number): number {
  const viewportH = viewportHeightPx();
  const defaultVh = Number.parseFloat(TERMINAL_DEFAULT_HEIGHT);
  const defaultPx = viewportH > 0 ? (viewportH * defaultVh) / 100 : 24 * cellH;
  return terminalRowsFromPx(defaultPx, cellH, true) ?? 24;
}

function parseTerminalRows(
  height: unknown,
  cellH: number,
  numberUnit: "vh" | "px" = "px",
  enforceMin = false,
): number | undefined {
  if (typeof height === "number") {
    const px = numberUnit === "vh" ? (viewportHeightPx() * height) / 100 : height;
    return terminalRowsFromPx(px, cellH, enforceMin);
  }
  const raw = String(height ?? "").trim();
  if (!raw) return undefined;
  if (raw.endsWith("rows")) {
    const rows = Number.parseFloat(raw.slice(0, -4));
    return clampTerminalRows(rows, cellH, enforceMin);
  }
  if (raw.endsWith("row")) {
    const rows = Number.parseFloat(raw.slice(0, -3));
    return clampTerminalRows(rows, cellH, enforceMin);
  }
  if (raw.endsWith("vh")) {
    const vh = Number.parseFloat(raw.slice(0, -2));
    if (!Number.isFinite(vh)) return undefined;
    if (vh <= 0 && !enforceMin) return undefined;
    return parseTerminalRows(vh, cellH, "vh", enforceMin);
  }
  if (raw.endsWith("px")) {
    const px = Number.parseFloat(raw.slice(0, -2));
    if (!Number.isFinite(px)) return undefined;
    if (px <= 0 && !enforceMin) return undefined;
    return parseTerminalRows(px, cellH, "px", enforceMin);
  }
  return parseTerminalRows(Number.parseFloat(raw), cellH, numberUnit, enforceMin);
}

function sessionLabel(session: BlitSession) {
  return session.title || session.command || "";
}

function effectiveTerminalTheme(): "light" | "dark" {
  const mode = document.documentElement.dataset.theme;
  if (mode === "light" || mode === "dark") return mode;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function ChatTerminals(props: {
  chatId: string | null;
  worktreePath?: string | null;
  notify?: (source: string, message: string, details?: string) => void;
}) {
  const [workspace] = createSignal(
    new BlitWorkspace({
      wasm: initBlitWasm(),
      logger: nullLogger,
      connections: [
        {
          id: CONNECTION_ID,
          transport: new WebSocketTransport(blitWsUrl(), PASSPHRASE, {
            reconnect: true,
            connectTimeoutMs: 30_000,
          }),
        },
      ],
    }),
  );
  const snapshot = useWorkspaceSnapshot(workspace());
  const [selectedSessionId, setSelectedSessionId] =
    createSignal<SessionId | null>(null);
  const [terminalSurface, setTerminalSurface] =
    createSignal<BlitTerminalSurface | null>(null);
  const [open, setOpen] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [queuedCreateChatId, setQueuedCreateChatId] = createSignal<string | null>(null);
  const [terminalCellHeight, setTerminalCellHeight] = createSignal(
    terminalCellHeightPx(),
  );
  const [terminalRows, setTerminalRows_] = createSignal(
    parseTerminalRows(localStorage.getItem(TERMINAL_HEIGHT_KEY), terminalCellHeight()) ??
      defaultTerminalRows(terminalCellHeight()),
  );
  const terminalHeight = createMemo(() => `${terminalRows() * terminalCellHeight()}px`);
  let rootRef: HTMLElement | undefined;
  const [terminalTheme, setTerminalTheme] = createSignal<"light" | "dark">(
    effectiveTerminalTheme(),
  );
  const terminalPalette = createMemo<TerminalPalette>(() =>
    terminalTheme() === "light" ? LIGHT_TERMINAL_PALETTE : DARK_TERMINAL_PALETTE,
  );

  const connection = createMemo(
    () => snapshot().connections.find((c) => c.id === CONNECTION_ID) ?? null,
  );
  const connectionStatus = createMemo(
    () => connection()?.status ?? "connecting",
  );
  const terminalReady = createMemo(
    () => connectionStatus() === "connected" && connection()?.ready === true,
  );
  const chatSessions = createMemo(() => {
    const chatId = props.chatId;
    if (!chatId) return [];
    return snapshot().sessions.filter(
      (session) =>
        session.state !== "closed" && decodeTag(session.tag)?.chatId === chatId,
    );
  });
  const selectedSession = createMemo(() => {
    const id = selectedSessionId();
    return id && open()
      ? (chatSessions().find((session) => session.id === id) ?? null)
      : null;
  });

  const tryFocusTerminal = () => {
    if (!open() || !selectedSessionId()) return;
    if (!selectedSession()) return;
    const surface = terminalSurface();
    if (!surface) return;
    surface.focus();
  };

  const focusTerminalSoon = () => {
    queueMicrotask(tryFocusTerminal);
  };

  const preventPointerFocus = (event: MouseEvent) => {
    event.preventDefault();
  };

  const setTerminalSurfaceRef = (surface: BlitTerminalSurface | null) => {
    setTerminalSurface(surface);
    if (surface) focusTerminalSoon();
  };

  const selectSession = (sessionId: SessionId | null) => {
    setSelectedSessionId(sessionId);
    if (sessionId) {
      setOpen(true);
      focusTerminalSoon();
    }
  };

  const toggleSession = (sessionId: SessionId) => {
    if (selectedSessionId() === sessionId) {
      setOpen(!open());
      return;
    }
    selectSession(sessionId);
  };

  const setTerminalRows = (rows: number) => {
    const next = clampTerminalRows(rows, terminalCellHeight(), true);
    setTerminalRows_(next);
    try {
      localStorage.setItem(TERMINAL_HEIGHT_KEY, `${next}rows`);
    } catch {
      /* ignore storage failures */
    }
  };

  const setTerminalHeightPx = (heightPx: number) => {
    const next = terminalRowsFromPx(heightPx, terminalCellHeight(), true);
    if (next === undefined) return;
    setTerminalRows(next);
  };

  const reportTerminalError = (message: string) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    const newline = trimmed.indexOf("\n");
    const summary = newline >= 0 ? trimmed.slice(0, newline).trim() : trimmed;
    const details = newline >= 0 ? trimmed : undefined;
    if (props.notify) {
      props.notify("terminal", summary, details);
    } else {
      setError(trimmed);
    }
  };

  const createShellNow = async (chatId: string) => {
    setCreating(true);
    setError(null);
    try {
      const connection = workspace().getConnection(CONNECTION_ID);
      if (!connection) throw new Error("Blit connection is not available");
      const cwd = props.worktreePath?.trim() || undefined;
      const session = await connection.createSession({
        rows: 24,
        cols: 120,
        tag: encodeTag(chatId),
        cwd,
      });
      selectSession(session.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setOpen(false);
      reportTerminalError(message);
    } finally {
      setCreating(false);
    }
  };

  const createShell = async () => {
    const chatId = props.chatId;
    if (!chatId || creating()) return;
    setOpen(true);
    setError(null);
    if (!terminalReady()) {
      setCreating(true);
      setQueuedCreateChatId(chatId);
      workspace().getConnection(CONNECTION_ID)?.connect();
      return;
    }
    setQueuedCreateChatId(null);
    await createShellNow(chatId);
  };

  const nextSessionAfterClose = (sessionId: SessionId) => {
    const sessions = chatSessions();
    const index = sessions.findIndex((session) => session.id === sessionId);
    if (index < 0) {
      return sessions.find((session) => session.id !== sessionId) ?? null;
    }
    return sessions[index + 1] ?? sessions[index - 1] ?? null;
  };

  const restartOrCreate = () => {
    const session = selectedSession();
    if (!session) {
      void createShell();
      return;
    }
    if (session.state !== "exited") return;
    const conn = connection();
    if (conn?.supportsRestart) {
      workspace().restartSession(session.id);
    } else {
      void closeSession(session.id, { createIfLast: true });
    }
  };

  const restartOrCreateSelected = () => {
    const session = selectedSession();
    if (session?.state !== "exited") return false;
    void restartOrCreate();
    return true;
  };

  const closeSelectedExited = () => {
    const session = selectedSession();
    if (session?.state !== "exited") return false;
    void closeSession(session.id);
    return true;
  };

  const stopKeyboardEvent = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const closeSession = async (
    sessionId: SessionId,
    options?: { createIfLast?: boolean },
  ) => {
    const next = nextSessionAfterClose(sessionId);
    setError(null);
    try {
      await workspace().closeSession(sessionId);
      if (selectedSessionId() === sessionId) {
        selectSession(next?.id ?? null);
        if (!next) setOpen(false);
      }
      if (next) focusTerminalSoon();
      if (!next && options?.createIfLast) void createShell();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setOpen(false);
      reportTerminalError(message);
    }
  };

  createEffect(() => {
    const chatId = queuedCreateChatId();
    if (!chatId) return;
    if (props.chatId !== chatId) {
      setQueuedCreateChatId(null);
      setCreating(false);
      return;
    }
    if (!terminalReady()) return;
    setQueuedCreateChatId(null);
    void createShellNow(chatId);
  });

  createEffect(() => {
    if (!queuedCreateChatId()) return;
    const status = connectionStatus();
    if (status !== "error" && status !== "closed") return;
    setQueuedCreateChatId(null);
    setCreating(false);
    const message = connection()?.error || `terminal connection ${status}`;
    setOpen(false);
    setError(null);
    reportTerminalError(message);
  });

  createEffect(() => {
    const sessions = chatSessions();
    const selected = selectedSessionId();
    if (selected && sessions.some((session) => session.id === selected)) {
      return;
    }
    const next = sessions[0] ?? null;
    selectSession(next?.id ?? null);
    if (!next && terminalReady() && !creating() && !error()) setOpen(false);
  });

  createEffect(
    on(selectedSessionId, (id) => {
      workspace().focusSession(id);
    }),
  );

  createEffect(() => {
    const selected = selectedSessionId();
    const session = selectedSession();
    workspace().setVisibleSessions(
      open() && selected && session ? [selected] : [],
    );
  });

  createEffect(() => {
    if (open() && selectedSession()) focusTerminalSoon();
  });

  const cycleSession = (direction: -1 | 1) => {
    const sessions = chatSessions();
    if (sessions.length === 0) return;
    const selected = selectedSessionId();
    const currentIndex = sessions.findIndex(
      (session) => session.id === selected,
    );
    const nextIndex =
      currentIndex < 0
        ? direction > 0
          ? 0
          : sessions.length - 1
        : (currentIndex + direction + sessions.length) % sessions.length;
    selectSession(sessions[nextIndex].id);
  };

  const installTerminalResizer = (handle: HTMLDivElement) => {
    let dragging = false;
    let startY = 0;
    let startH = 0;
    let viewportH = 0;
    const onMove = (event: MouseEvent) => {
      if (!dragging || viewportH <= 0) return;
      setTerminalHeightPx(startH + (event.clientY - startY));
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    const onDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const panel = rootRef?.querySelector(
        ".chat-terminal-panel",
      ) as HTMLElement | null;
      setTerminalCellHeight(terminalCellHeightPx());
      dragging = true;
      startY = event.clientY;
      startH = panel?.getBoundingClientRect().height ?? 0;
      viewportH = viewportHeightPx();
      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";
      event.preventDefault();
    };
    handle.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    onCleanup(() => {
      handle.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    });
  };

  const focusedInsideTerminal = (target: EventTarget | null) =>
    open() && rootRef && target instanceof Node && rootRef.contains(target);

  const refreshTerminalCellSize = () => {
    const cellH = terminalCellHeightPx();
    setTerminalCellHeight(cellH);
    setTerminalRows_(clampTerminalRows(terminalRows(), cellH, true));
  };

  onMount(() => {
    const syncTerminalTheme = () => setTerminalTheme(effectiveTerminalTheme());
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener?.("change", syncTerminalTheme);
    const observer = new MutationObserver(syncTerminalTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    syncTerminalTheme();
    window.addEventListener("resize", refreshTerminalCellSize);
    document.fonts?.addEventListener("loadingdone", refreshTerminalCellSize);
    onCleanup(() => {
      media?.removeEventListener?.("change", syncTerminalTheme);
      observer.disconnect();
      window.removeEventListener("resize", refreshTerminalCellSize);
      document.fonts?.removeEventListener("loadingdone", refreshTerminalCellSize);
    });
  });

  onMount(() => {
    const conn = workspace().getConnection(CONNECTION_ID);
    conn?.connect();

    const onLocalKeyDown = (event: KeyboardEvent) => {
      if (!focusedInsideTerminal(event.target)) return;
      const session = selectedSession();
      if (
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        if (event.key === "Enter" && (!session || session.state === "exited")) {
          if (!session) return;
          stopKeyboardEvent(event);
          restartOrCreate();
          return;
        }
        if (event.key === "Escape" && session?.state === "exited") {
          stopKeyboardEvent(event);
          void closeSession(session.id);
          return;
        }
      }

      // Let BlitTerminal's target listener consume terminal input first, then
      // stop chat/app shortcuts from also seeing keys intended for the terminal.
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    rootRef?.addEventListener("keydown", onLocalKeyDown);

    const onGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || hasOpenModalDialog()) return;
      const focusedTerminal = focusedInsideTerminal(event.target);
      const session = selectedSession();
      if (
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        if (event.key === "Enter" && open() && !error()) {
          if (session?.state === "exited") {
            stopKeyboardEvent(event);
            restartOrCreate();
          }
          return;
        }
        if (event.key === "Escape" && open() && session?.state === "exited") {
          stopKeyboardEvent(event);
          void closeSession(session.id);
          return;
        }
      }
      if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
        return;
      }
      if (event.key === "`") {
        stopKeyboardEvent(event);
        window.dispatchEvent(new CustomEvent("moo:terminal-toggle"));
      } else if (event.key === "[") {
        if (focusedTerminal) return;
        stopKeyboardEvent(event);
        cycleSession(-1);
      } else if (event.key === "]") {
        if (focusedTerminal) return;
        stopKeyboardEvent(event);
        cycleSession(1);
      }
    };
    window.addEventListener("keydown", onGlobalKeyDown, true);
    onCleanup(() => {
      rootRef?.removeEventListener("keydown", onLocalKeyDown);
      window.removeEventListener("keydown", onGlobalKeyDown, true);
    });
  });

  onCleanup(() => workspace().dispose());

  return (
    <section
      ref={rootRef}
      class="chat-terminal"
      classList={{ open: open() }}
      style={{ "--chat-terminal-h": terminalHeight() }}
    >
      <div
        class="chat-terminal-tabs"
        role="tablist"
        aria-label="chat terminals"
      >
        <For each={chatSessions()}>
          {(session) => (
            <button
              type="button"
              role="tab"
              class="chat-terminal-tab"
              classList={{
                active: selectedSessionId() === session.id,
                exited: session.state === "exited",
              }}
              aria-selected={
                selectedSessionId() === session.id ? "true" : "false"
              }
              onClick={() => toggleSession(session.id)}
              onMouseDown={preventPointerFocus}
              title={session.title || session.command || undefined}
            >
              <span
                class="chat-terminal-tab-state"
                aria-label={session.state === "exited" ? "exited" : "active"}
                title={session.state === "exited" ? "Exited" : "Active"}
              />
              <span class="chat-terminal-tab-title">
                {sessionLabel(session)}
              </span>
              <span
                role="button"
                tabindex="0"
                class="chat-terminal-tab-close"
                aria-label="close terminal"
                onMouseDown={preventPointerFocus}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeSession(session.id);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  e.stopPropagation();
                  void closeSession(session.id);
                }}
              >
                ×
              </span>
            </button>
          )}
        </For>
        <button
          type="button"
          class="chat-terminal-action"
          onClick={() => void createShell()}
          onMouseDown={preventPointerFocus}
          disabled={!props.chatId || creating()}
          title={terminalReady() ? "new terminal" : "start terminal when connected"}
        >
          {creating() ? "starting…" : "+"}
        </button>
        <Show when={connectionStatus() !== "connected" || error()}>
          <span
            class="chat-terminal-status"
            classList={{
              error: connectionStatus() === "error" || !!error(),
            }}
          >
            {connectionStatus() === "connected" ? "error" : connectionStatus()}
          </span>
        </Show>
      </div>
      <Show when={open()}>
        <div class="chat-terminal-panel">
          {!selectedSession() && !error() && !terminalReady() ? (
            <div class="terminal-empty">
              Connecting…
            </div>
          ) : null}
          <Show when={selectedSession()}>
            {(session) => (
              <BlitWorkspaceProvider
                workspace={workspace()}
                fontFamily={TERMINAL_FONT_FAMILY}
                fontSize={TERMINAL_FONT_SIZE}
                palette={terminalPalette()}
              >
                <BlitTerminal
                  sessionId={session().id}
                  class="moo-blit-terminal"
                  surfaceRef={setTerminalSurfaceRef}
                />
                <Show when={session().state === "exited"}>
                  <div class="terminal-exited">
                    <mark>Exited</mark>
                    <Show when={connection()?.supportsRestart}>
                      <button
                        type="button"
                        onClick={() => restartOrCreateSelected()}
                        onMouseDown={preventPointerFocus}
                      >
                        Restart <kbd>Enter</kbd>
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="terminal-exited-close"
                      onClick={() => closeSelectedExited()}
                      onMouseDown={preventPointerFocus}
                    >
                      Close <kbd>Esc</kbd>
                    </button>
                  </div>
                </Show>
              </BlitWorkspaceProvider>
            )}
          </Show>
        </div>
        <div
          class="chat-terminal-resizer"
          ref={(e) => installTerminalResizer(e)}
          title="drag bottom edge to resize terminal"
        />
      </Show>
    </section>
  );
}
