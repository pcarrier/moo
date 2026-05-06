import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  BlitWorkspace,
  nullLogger,
  type BlitSession,
  type BlitWorkspaceSnapshot,
  type SessionId,
} from "@blit-sh/core";
import { WebSocketTransport } from "@blit-sh/core/transports";
import { BlitTerminal, BlitWorkspaceProvider } from "@blit-sh/solid";
import { getPsk } from "./auth";
import initBlitWasm from "./blitWasm";

const CONNECTION_ID = "local";
const PASSPHRASE = "moo-blit-local";
const TAG_PREFIX = "moo:";

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
    queueMicrotask(() => setSnapshot(workspace.getSnapshot())),
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

function sessionLabel(session: BlitSession, fallbackIndex: number) {
  return session.title || session.command || `terminal ${fallbackIndex + 1}`;
}

export function ChatTerminals(props: { chatId: string | null }) {
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
  const [open, setOpen] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal(false);

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
        decodeTag(session.tag)?.chatId === chatId && session.state !== "closed",
    );
  });
  const selectedSession = createMemo(() => {
    const id = selectedSessionId();
    return id
      ? (chatSessions().find((session) => session.id === id) ?? null)
      : null;
  });

  const selectSession = (sessionId: SessionId | null) => {
    setSelectedSessionId(sessionId);
    workspace().focusSession(sessionId);
    if (sessionId) setOpen(true);
  };

  const createShell = async () => {
    const chatId = props.chatId;
    if (!chatId || creating()) return;
    setOpen(true);
    if (!terminalReady()) {
      workspace().getConnection(CONNECTION_ID)?.connect();
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const session = await workspace().createSession({
        connectionId: CONNECTION_ID,
        rows: 24,
        cols: 120,
        tag: encodeTag(chatId),
      });
      selectSession(session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const closeSession = async (sessionId: SessionId) => {
    setError(null);
    try {
      await workspace().closeSession(sessionId);
      if (selectedSessionId() === sessionId) {
        const next =
          chatSessions().find((session) => session.id !== sessionId) ?? null;
        selectSession(next?.id ?? null);
        if (!next) setOpen(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  createEffect(() => {
    const sessions = chatSessions();
    const selected = selectedSessionId();
    if (selected && sessions.some((session) => session.id === selected)) return;
    const next = sessions[0] ?? null;
    setSelectedSessionId(next?.id ?? null);
    workspace().focusSession(next?.id ?? null);
  });

  createEffect(() => {
    const selected = selectedSessionId();
    workspace().setVisibleSessions(open() && selected ? [selected] : []);
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

  const toggleTerminal = () => {
    if (chatSessions().length === 0 && !open()) void createShell();
    else setOpen((value) => !value);
  };

  onMount(() => {
    const conn = workspace().getConnection(CONNECTION_ID);
    conn?.connect();
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
        return;
      }
      if (event.key === "`") {
        event.preventDefault();
        toggleTerminal();
      } else if (event.key === "[") {
        event.preventDefault();
        cycleSession(-1);
      } else if (event.key === "]") {
        event.preventDefault();
        cycleSession(1);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));
  });

  onCleanup(() => workspace().dispose());

  return (
    <section class="quake-terminal" classList={{ open: open() }}>
      <div
        class="quake-terminal-tabs"
        role="tablist"
        aria-label="chat terminals"
      >
        <button
          type="button"
          class="quake-terminal-toggle"
          onClick={toggleTerminal}
          disabled={
            !props.chatId || (creating() && chatSessions().length === 0)
          }
          title={open() ? "hide terminal (Ctrl-`)" : "show terminal (Ctrl-`)"}
        >
          ▾ terminal
        </button>
        <For each={chatSessions()}>
          {(session, index) => (
            <button
              type="button"
              role="tab"
              class="quake-terminal-tab"
              classList={{
                active: selectedSessionId() === session.id,
                exited: session.state === "exited",
              }}
              aria-selected={
                selectedSessionId() === session.id ? "true" : "false"
              }
              onClick={() => selectSession(session.id)}
              title={session.title || session.command || session.tag}
            >
              <span>{sessionLabel(session, index())}</span>
              <span class="quake-terminal-tab-state">
                {session.state === "active" ? "" : session.state}
              </span>
              <span
                role="button"
                tabindex="0"
                class="quake-terminal-tab-close"
                aria-label="close terminal"
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
          class="quake-terminal-action"
          onClick={() => void createShell()}
          disabled={!props.chatId || creating() || !terminalReady()}
          title={
            terminalReady() ? "new terminal" : "waiting for Blit connection"
          }
        >
          {creating() ? "starting…" : "+"}
        </button>
        <span
          class="quake-terminal-status"
          classList={{
            connected: connectionStatus() === "connected",
            error: connectionStatus() === "error",
          }}
        >
          {connectionStatus()}
        </span>
      </div>
      <Show when={open()}>
        <div class="quake-terminal-panel">
          {error() ? <div class="terminal-error">{error()}</div> : null}
          {!selectedSession() && !error() ? (
            <div class="terminal-empty">
              {terminalReady()
                ? "Create a terminal for this chat."
                : "Connecting to Blit…"}
            </div>
          ) : null}
          <BlitWorkspaceProvider
            workspace={workspace()}
            fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
            fontSize={14}
          >
            <BlitTerminal
              sessionId={selectedSessionId()}
              class="moo-blit-terminal"
            />
          </BlitWorkspaceProvider>
        </div>
      </Show>
    </section>
  );
}
