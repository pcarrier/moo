// Single WebSocket carrying both broadcast events (server → client) and
// request/response RPC commands (client → server with a
// reply). Auto-reconnects with exponential backoff. Pending RPCs are
// rejected on disconnect; queued RPCs (issued before the socket is open)
// flush on connect.

import { getPsk } from "./auth";
import type { V8Event } from "./api/types";

type DiffStats = { added: number; removed: number; lines: number };

export type Event =
  | { kind: "pointer"; pointer: string }
  | { kind: "facts"; store: string }
  | { kind: "ui-open"; chatId: string; uiId: string; instanceId: string; stateRef?: string; stateTarget?: string | null; at?: number }
  | { kind: "file-diff"; chatId: string; path: string; diff: string; stats?: DiffStats; before?: string | null; after?: string | null; hash?: string; stepId?: string; at: number }
  | { kind: "todo-diff"; chatId: string; changes?: import("./api").TodoDiffChange[]; hash?: string; stepId?: string; at: number; todos?: import("./api").AgentTodo[] }
  | { kind: "memory-diff"; chatId: string; store: string; graph: string; action?: "assert" | "retract"; path: string; diff: string; stats?: DiffStats; before?: string; after?: string; hash?: string; stepId?: string; at: number; count?: number }
  | { kind: "blob-add"; chatId: string; objectKind: string; hash: string; size?: number; chars?: number; encoding?: string; stepId?: string; at: number }
  | { kind: "tokens"; chatId: string; used: number; budget?: number; threshold?: number; fraction?: number; usage?: unknown; source?: string; estimated?: boolean; reset?: boolean }
  | { kind: "compaction-start"; chatId: string; at?: number }
  | { kind: "compaction-end"; chatId: string; at?: number }
  | { kind: "v8"; event: V8Event }
  | { kind: "trace-write-error"; message: string; rows?: number; at?: number }
  | { kind: "ping" };

export type EventHandler = (event: Event) => void;

const RPC_TIMEOUT_MS = 120_000;

type Pending = {
  resolve: (value: unknown) => void;
  timer: number | null;
};

type OutboxFrame = {
  frame: string;
  pendingId?: string;
};

export class WSConnection {
  private socket: WebSocket | null = null;
  private handlers = new Set<EventHandler>();
  private retryDelay = 500;
  private closed = false;
  private subscribeChatId: string | null = null;
  private pending = new Map<string, Pending>();
  private outbox: OutboxFrame[] = []; // frames queued before open
  private nextId = 1;
  private reconnectTimer: number | null = null;

  start() {
    this.connect();
  }

  stop() {
    this.closed = true;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    for (const p of this.pending.values()) {
      if (p.timer != null) clearTimeout(p.timer);
      p.resolve({ ok: false, error: { message: "ws closed" } });
    }
    this.pending.clear();
    this.outbox = [];
  }

  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  subscribe(chatId: string) {
    this.subscribeChatId = chatId;
    this.send({ subscribe: chatId });
  }

  // Single-channel RPC. Returns whatever the server sends back as `result`.
  // Pending requests are rejected on disconnect or timeout so callers can retry.
  run<T = unknown>(payload: Record<string, unknown>): Promise<T> {
    const id = `r${this.nextId++}`;
    return new Promise<T>((resolve) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, timer: null });
      // Start the timeout when the caller queues the RPC, not only once the
      // socket opens. Otherwise a user action made while the websocket is stuck
      // connecting can leave UI like /settings permanently in "Saving…".
      this.startRpcTimer(id);
      this.send({ run: payload, id }, id);
    });
  }

  private send(obj: unknown, pendingId?: string) {
    const frame = JSON.stringify(obj);
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(frame);
      if (pendingId) this.startRpcTimer(pendingId);
    } else {
      this.outbox.push({ frame, pendingId });
    }
  }

  private startRpcTimer(id: string) {
    const p = this.pending.get(id);
    if (!p || p.timer != null) return;
    p.timer = window.setTimeout(() => {
      if (!this.pending.delete(id)) return;
      p.resolve({
        ok: false,
        error: { message: `ws request timed out after ${RPC_TIMEOUT_MS}ms` },
      });
    }, RPC_TIMEOUT_MS);
  }

  private connect() {
    if (this.closed) return;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const psk = getPsk();
    const query = psk ? `?psk=${encodeURIComponent(psk)}` : "";
    const url = `${proto}//${location.host}/api/ws${query}`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
      this.socket = socket;
    } catch (_) {
      this.scheduleReconnect();
      return;
    }
    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.closed) return;
      this.retryDelay = 500;
      // Re-subscribe across reconnects.
      if (this.subscribeChatId) {
        socket.send(JSON.stringify({ subscribe: this.subscribeChatId }));
      }
      // Flush queued frames. RPC timers start here, after the frame reaches
      // the socket, not when the caller queued the request.
      const queued = this.outbox;
      this.outbox = [];
      for (const { frame, pendingId } of queued) {
        if (pendingId && !this.pending.has(pendingId)) continue;
        socket.send(frame);
        if (pendingId) this.startRpcTimer(pendingId);
      }
      this.emit({ kind: "online" } as any);
      this.emit({ kind: "reconnect" } as any);
    });
    socket.addEventListener("message", (e) => {
      if (this.socket !== socket || this.closed) return;
      let data: any;
      try {
        data = JSON.parse(e.data);
      } catch (_) {
        return;
      }
      if (!data || typeof data.kind !== "string") {
        // Could be a run-result without kind=ping; check for run-result shape.
        if (data && typeof data.id === "string" && "result" in data) {
          const p = this.pending.get(data.id);
          if (p) {
            this.pending.delete(data.id);
            if (p.timer != null) clearTimeout(p.timer);
            p.resolve(data.result);
          }
        }
        return;
      }
      if (data.kind === "run-result" && typeof data.id === "string") {
        const p = this.pending.get(data.id);
        if (p) {
          this.pending.delete(data.id);
          if (p.timer != null) clearTimeout(p.timer);
          p.resolve(data.result);
        }
        return;
      }
      this.emit(data as Event);
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      // Reject in-flight requests; the caller can retry.
      for (const p of this.pending.values()) {
        if (p.timer != null) clearTimeout(p.timer);
        p.resolve({ ok: false, error: { message: "ws disconnected" } });
      }
      this.pending.clear();
      this.outbox = [];
      this.emit({ kind: "offline" } as any);
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      // close will follow; let scheduleReconnect handle it
    });
  }

  private emit(event: Event) {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        console.error("event handler threw", err);
      }
    }
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer != null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 8000);
  }
}

// Backwards-compat alias: state.ts and others import EventStream.
export const EventStream = WSConnection;
