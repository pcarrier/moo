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

function encodeTag(chatId: string, label: string) {
  return `${TAG_PREFIX}${encodeURIComponent(chatId)}:${encodeURIComponent(label)}`;
}

function decodeTag(tag: string): { chatId: string; label: string } | null {
  if (!tag.startsWith(TAG_PREFIX)) return null;
  const rest = tag.slice(TAG_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep < 0) return null;
  try {
    return {
      chatId: decodeURIComponent(rest.slice(0, sep)),
      label: decodeURIComponent(rest.slice(sep + 1)) || "shell",
    };
  } catch {
    return null;
  }
}

function sessionLabel(session: BlitSession, fallbackIndex: number) {
  const tagged = decodeTag(session.tag);
  return (
    session.title ||
    tagged?.label ||
    session.command ||
    `shell ${fallbackIndex + 1}`
  );
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
  const nextLabel = () => `shell ${chatSessions().length + 1}`;

  const selectSession = (sessionId: SessionId | null) => {
    setSelectedSessionId(sessionId);
    workspace().focusSession(sessionId);
    if (sessionId) setOpen(true);
  };

  const createShell = async (label?: string) => {
    const chatId = props.chatId;
    if (!chatId || creating()) return;
    const trimmed = (
      label ??
      window.prompt("Terminal label", nextLabel()) ??
      ""
    ).trim();
    if (!trimmed) return;
    setCreating(true);
    setError(null);
    setOpen(true);
    try {
      const session = await workspace().createSession({
        connectionId: CONNECTION_ID,
        rows: 24,
        cols: 120,
        tag: encodeTag(chatId, trimmed),
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

  onMount(() => {
    const conn = workspace().getConnection(CONNECTION_ID);
    conn?.connect();
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
          onClick={() => {
            if (chatSessions().length === 0) void createShell(nextLabel());
            else setOpen((value) => !value);
          }}
          disabled={
            !props.chatId || (creating() && chatSessions().length === 0)
          }
          title={open() ? "hide terminal" : "show terminal"}
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
          disabled={!props.chatId || creating()}
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
              {connectionStatus() === "connected"
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
