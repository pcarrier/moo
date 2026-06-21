// Single WebSocket carrying both broadcast events (server → client) and
// request/response RPC commands (client → server with a
// reply). Auto-reconnects with exponential backoff. Pending RPCs are
// rejected on disconnect; queued RPCs (issued before the socket is open)
// flush on connect.

import { getPsk } from "./auth";
import { parseJson, recordUnknownSchema } from "./schema";
import type {
  AgentTask,
  MemoryFactChange,
  TaskDiffChange,
  V8Event,
} from "./api";

type DiffStats = { added: number; removed: number; lines: number };

type StreamDraftEvent = {
  chatId: string;
  draftId: string;
  content: string;
  reasoningContent?: string;
  delta?: string;
  model?: string;
  effort?: string;
  at?: number;
};

export type Event =
  | { kind: "pointer"; pointer: string }
  | { kind: "facts"; store: string }
  | {
      kind: "ui-open";
      chatId: string;
      uiId: string;
      instanceId: string;
      stateRef?: string;
      stateTarget?: string | null;
      at?: number;
    }
  | {
      kind: "file-diff";
      chatId: string;
      path: string;
      diff: string;
      stats?: DiffStats;
      before?: string | null;
      after?: string | null;
      hash?: string;
      stepId?: string;
      at: number;
    }
  | {
      kind: "task-diff";
      chatId: string;
      changes?: TaskDiffChange[];
      hash?: string;
      stepId?: string;
      at: number;
      tasks?: AgentTask[];
    }
  | {
      kind: "memory-diff";
      chatId: string;
      store: string;
      graph: string;
      action?: "assert" | "retract";
      path: string;
      diff: string;
      stats?: DiffStats;
      before?: string;
      after?: string;
      hash?: string;
      stepId?: string;
      at: number;
      count?: number;
      changes?: MemoryFactChange[];
    }
  | {
      kind: "blob-add";
      chatId: string;
      objectKind: string;
      hash: string;
      size?: number;
      chars?: number;
      encoding?: string;
      stepId?: string;
      at: number;
    }
  | {
      kind: "tokens";
      chatId: string;
      used?: number;
      budget?: number;
      threshold?: number;
      availableTokens?: number;
      compactionsInARow?: number;
      fraction?: number;
      usage?: unknown;
      source?: string;
      estimated?: boolean;
      reset?: boolean;
    }
  | { kind: "compaction-start"; chatId: string; at?: number }
  | { kind: "compaction-end"; chatId: string; at?: number }
  | { kind: "step-start"; chatId: string; compacting?: boolean; at?: number }
  | { kind: "step-end"; chatId: string; at?: number }
  | ({ kind: "draft" } & StreamDraftEvent)
  | ({ kind: "reasoning-draft" } & StreamDraftEvent)
  | ({ kind: "compaction-draft" } & StreamDraftEvent)
  | { kind: "draft-end"; chatId?: string; draftId: string; at?: number }
  | { kind: "llm-auth-required"; chatId?: string; at?: number }
  | {
      kind: "runts-step-finished";
      chatId: string;
      stepId: string;
      status?: string;
      resultHash?: string;
      error?: string;
      durationNs?: number;
      at?: number;
    }
  | {
      kind: "tool-call-draft";
      chatId: string;
      stepId: string;
      toolCallId?: string;
      toolName?: string;
      model?: string;
      effort?: string;
      label?: string;
      description?: string;
      code?: string;
      args?: unknown;
      hasArgs?: boolean;
      backgroundAfterNs?: number;
      at?: number;
    }
  | {
      kind: "runts-background-start" | "runts-background-end";
      chatId: string;
      stepId: string;
      label?: string;
      requestedBy?: string;
      at?: number;
    }
  | { kind: "driver-error"; chatId: string; error: unknown; at?: number }
  | { kind: "v8"; event: V8Event }
  | { kind: "trace-write-error"; message: string; rows?: number; at?: number }
  | {
      kind: "otel-export-error";
      message: string;
      endpoint?: string;
      rows?: number;
      at?: number;
    }
  | { kind: "ping" }
  | { kind: "online" }
  | { kind: "offline" }
  | { kind: "reconnect" };

type RpcResultFrame = { kind: "run-result"; id: string; result: unknown };

type ParsedWsFrame = Event | RpcResultFrame;

type EventKind = Event["kind"];
type EventForKind<K extends EventKind> = Extract<Event, { kind: K }>;

const EVENT_KINDS = new Set<string>([
  "pointer",
  "facts",
  "ui-open",
  "file-diff",
  "task-diff",
  "memory-diff",
  "blob-add",
  "tokens",
  "compaction-start",
  "compaction-end",
  "step-start",
  "step-end",
  "draft",
  "reasoning-draft",
  "compaction-draft",
  "draft-end",
  "llm-auth-required",
  "runts-step-finished",
  "tool-call-draft",
  "runts-background-start",
  "runts-background-end",
  "driver-error",
  "v8",
  "trace-write-error",
  "otel-export-error",
  "ping",
  "online",
  "offline",
  "reconnect",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEventKind(kind: string): kind is EventKind {
  return EVENT_KINDS.has(kind);
}

function stringField(
  frame: Record<string, unknown>,
  name: string,
): string | null {
  const value = frame[name];
  return typeof value === "string" ? value : null;
}

function optionalString(
  frame: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = frame[name];
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(
  frame: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = frame[name];
  return typeof value === "number" ? value : undefined;
}

function optionalBoolean(
  frame: Record<string, unknown>,
  name: string,
): boolean | undefined {
  const value = frame[name];
  return typeof value === "boolean" ? value : undefined;
}

function optionalDiffStats(
  frame: Record<string, unknown>,
): DiffStats | undefined {
  const stats = frame.stats;
  if (!isRecord(stats)) return undefined;
  const added = stats.added;
  const removed = stats.removed;
  const lines = stats.lines;
  if (
    typeof added !== "number" ||
    typeof removed !== "number" ||
    typeof lines !== "number"
  )
    return undefined;
  return { added, removed, lines };
}

function optionalStringOrNull(
  frame: Record<string, unknown>,
  name: string,
): string | null | undefined {
  const value = frame[name];
  return value === null || typeof value === "string" ? value : undefined;
}

function optionalAction(
  frame: Record<string, unknown>,
): "assert" | "retract" | undefined {
  return frame.action === "assert" || frame.action === "retract"
    ? frame.action
    : undefined;
}

function arrayField<T>(
  frame: Record<string, unknown>,
  name: string,
  isItem: (value: unknown) => value is T,
): T[] | undefined {
  const value = frame[name];
  if (!Array.isArray(value)) return undefined;
  const items: T[] = [];
  for (const item of value) {
    if (!isItem(item)) return undefined;
    items.push(item);
  }
  return items;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isTaskStatus(value: unknown): value is AgentTask["status"] {
  return (
    value === "todo" ||
    value === "doing" ||
    value === "done" ||
    value === "blocked" ||
    value === "dropped"
  );
}

function isAgentTask(value: unknown): value is AgentTask {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    isTaskStatus(value.status)
  );
}

function isTaskDiffChange(value: unknown): value is TaskDiffChange {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "added":
      return isAgentTask(value.after);
    case "removed":
      return isAgentTask(value.before);
    case "updated":
      return (
        isAgentTask(value.before) &&
        isAgentTask(value.after) &&
        (value.fields === undefined || isStringArray(value.fields))
      );
    default:
      return false;
  }
}

function isMemoryFactChange(value: unknown): value is MemoryFactChange {
  return (
    isRecord(value) &&
    typeof value.subject === "string" &&
    typeof value.predicate === "string" &&
    typeof value.object === "string"
  );
}

function parseV8Event(value: unknown): V8Event | null {
  if (!isRecord(value)) return null;
  const at = value.at;
  const worker = value.worker;
  const lane = value.lane;
  const workerId = value.workerId;
  const generation = value.generation;
  const kind = value.kind;
  if (
    typeof at !== "number" ||
    typeof worker !== "string" ||
    typeof lane !== "string" ||
    typeof workerId !== "number" ||
    typeof generation !== "number" ||
    typeof kind !== "string"
  )
    return null;
  return {
    at,
    worker,
    lane,
    workerId,
    generation,
    kind,
    reason:
      value.reason === null || typeof value.reason === "string"
        ? value.reason
        : undefined,
    command:
      value.command === null || typeof value.command === "string"
        ? value.command
        : undefined,
    detail:
      value.detail === null || typeof value.detail === "string"
        ? value.detail
        : undefined,
  };
}

function withOptionalAt<T extends Event>(
  event: T,
  frame: Record<string, unknown>,
): T {
  const at = optionalNumber(frame, "at");
  return at === undefined ? event : { ...event, at };
}

function parseEventFrame(frame: Record<string, unknown>): Event | null {
  const rawKind = frame.kind;
  if (typeof rawKind !== "string" || !isEventKind(rawKind)) return null;
  switch (rawKind) {
    case "pointer": {
      const pointer = stringField(frame, "pointer");
      return pointer ? { kind: "pointer", pointer } : null;
    }
    case "facts": {
      const store = stringField(frame, "store");
      return store ? { kind: "facts", store } : null;
    }
    case "ui-open": {
      const chatId = stringField(frame, "chatId");
      const uiId = stringField(frame, "uiId");
      const instanceId = stringField(frame, "instanceId");
      if (!chatId || !uiId || !instanceId) return null;
      return withOptionalAt<EventForKind<"ui-open">>(
        {
          kind: "ui-open",
          chatId,
          uiId,
          instanceId,
          stateRef: optionalString(frame, "stateRef"),
          stateTarget: optionalStringOrNull(frame, "stateTarget"),
        },
        frame,
      );
    }
    case "file-diff": {
      const chatId = stringField(frame, "chatId");
      const path = stringField(frame, "path");
      const diff = stringField(frame, "diff");
      const at = optionalNumber(frame, "at");
      if (!chatId || !path || diff == null || at == null) return null;
      return {
        kind: "file-diff",
        chatId,
        path,
        diff,
        stats: optionalDiffStats(frame),
        before: optionalStringOrNull(frame, "before"),
        after: optionalStringOrNull(frame, "after"),
        hash: optionalString(frame, "hash"),
        stepId: optionalString(frame, "stepId"),
        at,
      };
    }
    case "task-diff": {
      const chatId = stringField(frame, "chatId");
      const at = optionalNumber(frame, "at");
      if (!chatId || at == null) return null;
      return {
        kind: "task-diff",
        chatId,
        changes: arrayField(frame, "changes", isTaskDiffChange),
        hash: optionalString(frame, "hash"),
        stepId: optionalString(frame, "stepId"),
        at,
        tasks: arrayField(frame, "tasks", isAgentTask),
      };
    }
    case "memory-diff": {
      const chatId = stringField(frame, "chatId");
      const store = stringField(frame, "store");
      const graph = stringField(frame, "graph");
      const path = stringField(frame, "path");
      const diff = stringField(frame, "diff");
      const at = optionalNumber(frame, "at");
      if (!chatId || !store || !graph || !path || diff == null || at == null)
        return null;
      return {
        kind: "memory-diff",
        chatId,
        store,
        graph,
        action: optionalAction(frame),
        path,
        diff,
        stats: optionalDiffStats(frame),
        before: optionalString(frame, "before"),
        after: optionalString(frame, "after"),
        hash: optionalString(frame, "hash"),
        stepId: optionalString(frame, "stepId"),
        at,
        count: optionalNumber(frame, "count"),
        changes: arrayField(frame, "changes", isMemoryFactChange),
      };
    }
    case "blob-add": {
      const chatId = stringField(frame, "chatId");
      const objectKind = stringField(frame, "objectKind");
      const hash = stringField(frame, "hash");
      const at = optionalNumber(frame, "at");
      if (!chatId || !objectKind || !hash || at == null) return null;
      return {
        kind: "blob-add",
        chatId,
        objectKind,
        hash,
        size: optionalNumber(frame, "size"),
        chars: optionalNumber(frame, "chars"),
        encoding: optionalString(frame, "encoding"),
        stepId: optionalString(frame, "stepId"),
        at,
      };
    }
    case "tokens": {
      const chatId = stringField(frame, "chatId");
      if (!chatId) return null;
      return {
        kind: "tokens",
        chatId,
        used: optionalNumber(frame, "used"),
        budget: optionalNumber(frame, "budget"),
        threshold: optionalNumber(frame, "threshold"),
        availableTokens: optionalNumber(frame, "availableTokens"),
        compactionsInARow: optionalNumber(frame, "compactionsInARow"),
        fraction: optionalNumber(frame, "fraction"),
        usage: frame.usage,
        source: optionalString(frame, "source"),
        estimated: optionalBoolean(frame, "estimated"),
        reset: optionalBoolean(frame, "reset"),
      };
    }
    case "compaction-start":
    case "compaction-end":
    case "step-end": {
      const chatId = stringField(frame, "chatId");
      return chatId ? withOptionalAt({ kind: rawKind, chatId }, frame) : null;
    }
    case "step-start": {
      const chatId = stringField(frame, "chatId");
      return chatId
        ? withOptionalAt(
            {
              kind: "step-start",
              chatId,
              compacting: optionalBoolean(frame, "compacting"),
            },
            frame,
          )
        : null;
    }
    case "draft":
    case "reasoning-draft":
    case "compaction-draft": {
      const chatId = stringField(frame, "chatId");
      const draftId = stringField(frame, "draftId");
      const content = stringField(frame, "content");
      if (!chatId || !draftId || content == null) return null;
      return withOptionalAt(
        {
          kind: rawKind,
          chatId,
          draftId,
          content,
          reasoningContent: optionalString(frame, "reasoningContent"),
          delta: optionalString(frame, "delta"),
          model: optionalString(frame, "model"),
          effort: optionalString(frame, "effort"),
        },
        frame,
      );
    }
    case "draft-end": {
      const draftId = stringField(frame, "draftId");
      return draftId
        ? withOptionalAt(
            {
              kind: "draft-end",
              chatId: optionalString(frame, "chatId"),
              draftId,
            },
            frame,
          )
        : null;
    }
    case "llm-auth-required":
      return withOptionalAt(
        { kind: "llm-auth-required", chatId: optionalString(frame, "chatId") },
        frame,
      );
    case "runts-background-start":
    case "runts-background-end": {
      const chatId = stringField(frame, "chatId");
      const stepId = stringField(frame, "stepId");
      if (!chatId || !stepId) return null;
      return withOptionalAt(
        {
          kind: frame.kind as "runts-background-start" | "runts-background-end",
          chatId,
          stepId,
          label: optionalString(frame, "label"),
          requestedBy: optionalString(frame, "requestedBy"),
        },
        frame,
      );
    }
    case "runts-step-finished": {
      const chatId = stringField(frame, "chatId");
      const stepId = stringField(frame, "stepId");
      if (!chatId || !stepId) return null;
      return withOptionalAt(
        {
          kind: "runts-step-finished",
          chatId,
          stepId,
          status: optionalString(frame, "status"),
          resultHash: optionalString(frame, "resultHash"),
          error: optionalString(frame, "error"),
          durationNs: optionalNumber(frame, "durationNs"),
        },
        frame,
      );
    }
    case "tool-call-draft": {
      const chatId = stringField(frame, "chatId");
      const stepId = stringField(frame, "stepId");
      if (!chatId || !stepId) return null;
      return withOptionalAt(
        {
          kind: "tool-call-draft",
          chatId,
          stepId,
          toolCallId: optionalString(frame, "toolCallId"),
          toolName: optionalString(frame, "toolName"),
          model: optionalString(frame, "model"),
          effort: optionalString(frame, "effort"),
          label: optionalString(frame, "label"),
          description: optionalString(frame, "description"),
          code: optionalString(frame, "code"),
          args: frame.args,
          hasArgs: optionalBoolean(frame, "hasArgs"),
          backgroundAfterNs: optionalNumber(frame, "backgroundAfterNs"),
        },
        frame,
      );
    }
    case "driver-error": {
      const chatId = stringField(frame, "chatId");
      return chatId
        ? withOptionalAt(
            { kind: "driver-error", chatId, error: frame.error },
            frame,
          )
        : null;
    }
    case "v8": {
      const event = parseV8Event(frame.event);
      return event ? { kind: "v8", event } : null;
    }
    case "trace-write-error": {
      const message = stringField(frame, "message");
      return message
        ? withOptionalAt(
            {
              kind: "trace-write-error",
              message,
              rows: optionalNumber(frame, "rows"),
            },
            frame,
          )
        : null;
    }
    case "otel-export-error": {
      const message = stringField(frame, "message");
      return message
        ? withOptionalAt(
            {
              kind: "otel-export-error",
              message,
              endpoint: optionalString(frame, "endpoint"),
              rows: optionalNumber(frame, "rows"),
            },
            frame,
          )
        : null;
    }
    case "ping":
      return { kind: "ping" };
    case "online":
      return { kind: "online" };
    case "offline":
      return { kind: "offline" };
    case "reconnect":
      return { kind: "reconnect" };
  }
}

export function parseWsFrame(raw: unknown): ParsedWsFrame | null {
  if (!isRecord(raw)) return null;
  if (
    raw.kind === "run-result" &&
    typeof raw.id === "string" &&
    "result" in raw
  ) {
    return { kind: "run-result", id: raw.id, result: raw.result };
  }
  if (
    typeof raw.kind !== "string" &&
    typeof raw.id === "string" &&
    "result" in raw
  ) {
    return { kind: "run-result", id: raw.id, result: raw.result };
  }
  return parseEventFrame(raw);
}

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
  private subscribeV8Events = false;
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

  subscribeV8(enabled: boolean) {
    if (this.subscribeV8Events === enabled) return;
    this.subscribeV8Events = enabled;
    this.sendV8Subscription();
  }

  private sendV8Subscription() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ subscribeV8: this.subscribeV8Events }));
    }
  }

  // Single-channel RPC. Returns whatever the server sends back as `result`.
  // Pending requests are rejected on disconnect or timeout so callers can retry.
  run<T = unknown>(payload: Record<string, unknown>): Promise<T> {
    const id = `r${this.nextId++}`;
    return new Promise<T>((resolve) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        timer: null,
      });
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
      if (this.subscribeV8Events) this.sendV8Subscription();
      // Flush queued frames. RPC timers start here, after the frame reaches
      // the socket, not when the caller queued the request.
      const queued = this.outbox;
      this.outbox = [];
      for (const { frame, pendingId } of queued) {
        if (pendingId && !this.pending.has(pendingId)) continue;
        socket.send(frame);
        if (pendingId) this.startRpcTimer(pendingId);
      }
      this.emit({ kind: "online" });
      this.emit({ kind: "reconnect" });
    });
    socket.addEventListener("message", (e) => {
      if (this.socket !== socket || this.closed) return;
      let raw: unknown;
      try {
        raw = parseJson(e.data, "ws message", recordUnknownSchema);
      } catch (_) {
        return;
      }
      const frame = parseWsFrame(raw);
      if (!frame) return;
      if (frame.kind === "run-result") {
        const p = this.pending.get(frame.id);
        if (p) {
          this.pending.delete(frame.id);
          if (p.timer != null) clearTimeout(p.timer);
          p.resolve(frame.result);
        }
        return;
      }
      this.emit(frame);
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
      this.emit({ kind: "offline" });
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
