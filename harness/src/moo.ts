import * as host from "./host_ops";
import type { Moo, Quad, Bindings, Triple, ObjectInput, MemoryScope, UiAskSpec, UiChooseSpec, UiBundle, UiManifest, FactQuadInput, McpServerConfig, McpTool, McpOAuthStartOptions, McpOAuthStatus, McpOAuthStart, SubagentSpec, SubagentResult, FactMutationReceipt, ProcRunArgs, ProcResult, TermBindings, BindingTerm, QuadObject, TraceRow, TraceTreeNode, TraceSummary, TraceDiagnostic, ApplyPatchInput, ApplyPatchResult } from "./types";
import { err, ok, errorInfo } from "./core/result";
import { unifiedDiffWithStats } from "./core/diff";
import { ApplyPatchError, applyUnifiedDiff } from "./core/applyPatch";
import { encodeObject, stringBytes, term, validate } from "./core/terms";
import { Term, MooApiError } from "./types";
import { assertFactObject, assertFactObjects, chatRefs, decodeJsonPointer, encodeJsonPointer, unpackQuad, stringifyForLog } from "./lib";
import { appendStep } from "./steps";
import { addTodo, clearTodos, getTodos, patchTodos, updateTodo, withTodoDiffBatch } from "./todos";
import { setSkillRootProvider, skills } from "./skills";
import { applyDefaultChatSettings } from "./commands/models";

const time: Moo["time"] = {
  async nowMs() {
    return host.now();
  },
  async nowISO() {
    return new Date(host.now()).toISOString();
  },
  async datetime(d) {
    const value = d == null ? new Date(host.now()) : typeof d === "number" ? new Date(d) : d;
    return term.datetime(value);
  },
  async nowPlus(ms) {
    return host.now() + Number(ms);
  },
};

const id: Moo["id"] = {
  async new(prefix = "id") {
    return host.newId(prefix);
  },
};

const log: Moo["log"] = (...args) => {
  const message = args.map(stringifyForLog).join(" ");
  const chatId = activeChatId;
  if (!chatId) return;
  const c = chatRefs(chatId);
  const logId = host.newId("log");
  const at = String(host.now());
  host.swapFacts(
    c.facts,
    EMPTY_JSON_ARRAY,
    JSON.stringify([
      [c.graph, logId, "rdf:type", "agent:Log"],
      [c.graph, logId, "agent:createdBy", "agent:moo"],
      [c.graph, logId, "agent:createdAt", at],
      [c.graph, logId, "agent:message", message],
    ]),
  );
};

let activeChatId: string | null = null;
let activeServerBaseUrl: string | null = null;
let activeRunJSContext: { chatId: string; runJsStepId: string; depth: number; outstanding: Set<string>; traceId?: string | null } | null = null;

function normalizeServerBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed || !/^https?:\/\//i.test(trimmed) || /\s/.test(trimmed)) return null;
  return trimmed;
}

export async function withMooServerBaseUrlContext<T>(serverBaseUrl: unknown, fn: () => Promise<T>): Promise<T> {
  const previous = activeServerBaseUrl;
  const next = normalizeServerBaseUrl(serverBaseUrl) || previous;
  activeServerBaseUrl = next;
  try {
    return await fn();
  } finally {
    activeServerBaseUrl = previous;
  }
}

export async function withMooChatContext<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const previous = activeChatId;
  activeChatId = chatId;
  try {
    return await fn();
  } finally {
    activeChatId = previous;
  }
}

export async function withMooRunJSContext<T>(
  chatId: string,
  runJsStepId: string,
  depth: number,
  fn: () => Promise<T>,
): Promise<T> {
  const previousChat = activeChatId;
  const previousRunJS = activeRunJSContext;
  activeChatId = chatId;
  activeRunJSContext = { chatId, runJsStepId, depth, outstanding: new Set(), traceId: null };
  try {
    return await withTodoDiffBatch(chatId, fn);
  } finally {
    const ctx = activeRunJSContext;
    activeRunJSContext = previousRunJS;
    activeChatId = previousChat;
    if (ctx) {
      for (const childChatId of ctx.outstanding) {
        try {
          await markOutstandingSubagentCancelled(ctx.chatId, childChatId, "runJS finished before awaiting this subagent");
        } catch {
          // best effort only
        }
      }
    }
  }
}


type TraceRootInfo = { traceId?: string | null; resultHash?: string | null; error?: string | null; status?: string };

type TraceRootPlan = {
  root: Record<string, unknown>;
  span?: Record<string, unknown>;
  parentId: string;
};

function inferTraceRoot(id: string, data: Record<string, unknown>): TraceRootPlan {
  const chatId = typeof data.chatId === "string" && data.chatId ? data.chatId : null;
  const runId = typeof data.runId === "string" && data.runId ? data.runId : null;
  const label = typeof data.label === "string" && data.label ? data.label : id;
  const command = typeof data.command === "string" && data.command ? data.command : null;
  const startedNs = Date.now() * 1_000_000;
  if (id.startsWith("command:")) {
    const traceParentId = typeof data.traceParentId === "string" && data.traceParentId ? data.traceParentId : null;
    if (traceParentId) {
      const route = typeof data.traceRoute === "string" && data.traceRoute ? data.traceRoute : null;
      const name = command ? `command ${command}` : label;
      return {
        parentId: id,
        root: {
          id: traceParentId,
          chatId,
          runId,
          kind: "frontend",
          name: command || "frontend.action",
          startedNs,
          data: { label: command || label, command, chatId, route, source: "frontend", rootChoice: "frontend-action-parent" },
        },
        span: {
          id,
          parentId: traceParentId,
          chatId,
          runId,
          kind: "command",
          name,
          startedNs,
          data: { label, command, chatId, route, rootChoice: "frontend-command-parent" },
        },
      };
    }
    return {
      parentId: id,
      root: {
        id,
        chatId,
        runId,
        kind: "command",
        name: command ? `command ${command}` : label,
        startedNs,
        data: { label, command, chatId },
      },
    };
  }
  if (id.startsWith("step:")) {
    if (chatId) {
      const chatTitle = typeof data.title === "string" && data.title ? data.title : chatId;
      return {
        parentId: id,
        root: {
          id: `chat:${chatId}`,
          chatId,
          runId,
          kind: "chat",
          name: chatTitle,
          startedNs,
          data: { chatId, runId, rootChoice: "chat-for-step-parent" },
        },
        span: {
          id,
          parentId: `chat:${chatId}`,
          chatId,
          runId,
          kind: "step",
          name: label,
          startedNs,
          data: { label, chatId, runId, rootChoice: "chat-step-parent" },
        },
      };
    }
    // A step id is an attachment point supplied by the chat driver, not a trace root.
    // If the driver-created span is missing, make the fallback explicit and easy to spot.
    return {
      parentId: id,
      root: {
        id,
        chatId,
        runId,
        kind: "missing-parent",
        name: label,
        startedNs,
        data: { label, chatId, runId, rootChoice: "fallback-missing-step-parent" },
      },
    };
  }
  return { parentId: id, root: { id, chatId, runId, kind: "system", name: label, startedNs, data: { label, chatId, runId } } };
}

export async function startRunJSTraceRoot(stepId: string | null, data: Record<string, unknown> = {}) {
  let parentId = stepId;
  if (stepId) {
    const plan = inferTraceRoot(stepId, data);
    await host.ensureTraceRoot(JSON.stringify(plan.root));
    if (plan.span) await host.ensureTraceSpan(JSON.stringify(plan.span));
    parentId = plan.parentId;
  }
  const raw = await host.startTraceRoot(parentId, JSON.stringify(traceJsonValue(data)));
  const cur = raw ? JSON.parse(raw) : null;
  if (activeRunJSContext && (cur?.traceId || cur?.rootId)) activeRunJSContext.traceId = cur.traceId || cur.rootId;
  return cur;
}
export const startTraceRoot = startRunJSTraceRoot;

export async function finishRunJSTraceRoot(info: TraceRootInfo) {
  let shouldLeave = false;
  try {
    const current = await host.currentTrace();
    const cur = current ? JSON.parse(current) : null;
    const traceId = info.traceId || cur?.traceId;
    if (!traceId) return false;
    shouldLeave = true;
    const root = await host.getTrace(JSON.stringify({ traceId }));
    const row = root ? JSON.parse(root) : null;
    const data = {
      ...(row?.data && typeof row.data === "object" ? row.data : {}),
      ...(info.resultHash ? { resultHash: info.resultHash } : {}),
      ...(info.error ? { error: info.error } : {}),
    };
    const status = info.status || (info.error ? "error" : "ok");
    const dataJson = JSON.stringify(traceJsonValue(data));
    const finished = (await host.finishTrace(traceId, status, dataJson)) === "true";
    const rootId = typeof row?.rootId === "string" && row.rootId ? row.rootId : null;
    const rootKind = typeof row?.rootKind === "string" && row.rootKind ? row.rootKind : null;
    const parentId = typeof row?.parentId === "string" && row.parentId ? row.parentId : null;
    if (finished && rootKind === "command" && rootId && rootId !== traceId) {
      await host.finishTrace(rootId, status, dataJson);
    }
    if (finished && parentId?.startsWith("step:")) {
      await host.finishTrace(parentId, status, dataJson);
    }
    return finished;
  } finally {
    if (shouldLeave) {
      try {
        host.leaveTrace();
      } catch {
        // best effort cleanup only
      }
    }
  }
}
export const finishTraceRoot = finishRunJSTraceRoot;

function parseTraceRow(raw: string | null): TraceRow | null {
  return raw ? JSON.parse(raw) as TraceRow : null;
}

function parseTraceRows(raw: string): TraceRow[] {
  const rows = JSON.parse(raw || "[]") as TraceRow[];
  return Array.isArray(rows) ? rows : [];
}

function buildTraceTree(rows: TraceRow[]): TraceTreeNode | null {
  const nodes = new Map<string, TraceTreeNode>();
  for (const row of rows) nodes.set(row.id, { ...(row as TraceRow), children: [] });
  let root: TraceTreeNode | null = null;
  for (const node of nodes.values()) {
    const parentId = node.parentId || (typeof node.data?.parentId === "string" ? node.data.parentId : null);
    if (!parentId || !nodes.has(parentId)) {
      if ((node.rootId && node.id === node.rootId) || node.kind === "trace" || !root) root = node;
      continue;
    }
    nodes.get(parentId)!.children.push(node);
  }
  for (const node of nodes.values()) node.children.sort((a, b) => a.seq - b.seq);
  return root;
}

type TraceRecentRow = TraceRow & {
  chat?: { id: string; title: string | null };
  events?: TraceRow[];
  errorSummary?: string;
  category?: "runjs_compile" | "patch_mismatch" | "missing_file" | "missing_tool" | "proc_nonzero" | "undefined_variable" | "no_change" | "timeout" | "api_error" | "unknown";
};

type TraceErrorInfoLocal = NonNullable<Awaited<ReturnType<Moo["traces"]["summary"]>>>["errors"][number];

async function chatForTraceStep(stepId: string | null): Promise<{ id: string; title: string | null } | null> {
  if (!stepId) return null;
  for (const entry of await chat.list()) {
    const refs = chatRefs(entry.chatId);
    const rows = await facts.match({ store: refs.facts, graph: refs.graph, subject: stepId, predicate: "rdf:type", limit: 1 });
    if (rows.length) return { id: entry.chatId, title: entry.title };
  }
  return null;
}

function traceText(value: unknown, depth = 0): string | null {
  if (value == null || depth > 4) return null;
  if (typeof value === "string") return value.length ? value : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((v) => traceText(v, depth + 1)).filter(Boolean) as string[];
    return parts.length ? parts.join("; ") : null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["error", "message", "stderr", "stdout", "output", "details", "cause"]) {
      const text = traceText(obj[key], depth + 1);
      if (text) return text;
    }
  }
  return null;
}

function traceErrorOfRow(row: TraceRow): string | null {
  const text = traceText(row.data);
  if (row.status === "error") return text || row.name || row.status;
  if (text && /\b(error|exception|failed|timed out|timeout)\b/i.test(text)) return text;
  return null;
}

function traceCategory(message: string | null, row?: TraceRow): TraceRecentRow["category"] {
  const text = [message ?? "", row?.name ?? "", row?.status ?? ""].join("\n");
  if (/v8\.compile|Unexpected identifier|missing \) after argument list|SyntaxError/i.test(text)) return "runjs_compile";
  if (/patch hunk did not match|hunk.*failed|No valid patches|malformed patch/i.test(text)) return "patch_mismatch";
  if (/command not found|No such file or directory.*python|python3:|which: no/i.test(text)) return "missing_tool";
  if (/No such file or directory|not found|missing file/i.test(text)) return "missing_file";
  if (/exited [1-9]|process_failed|nonzero|non-zero/i.test(text)) return "proc_nonzero";
  if (/\b[A-Za-z_$][\w$]* is not defined\b|ReferenceError/i.test(text)) return "undefined_variable";
  if (/no changes|missing pattern|expectedCount|expected count|missing effects|missing actions/i.test(text)) return "no_change";
  if (/timed out|timeout/i.test(text)) return "timeout";
  if (/MooApiError|invalid_argument|path_escape|bad_sparql|conflict/i.test(text)) return "api_error";
  return "unknown";
}

function rowContainsText(row: TraceRow, needle: string): boolean {
  if (!needle) return true;
  const haystack = [row.id, row.traceId, row.stepId ?? "", row.kind, row.name, row.status, traceText(row.data) ?? ""].join("\n").toLowerCase();
  return haystack.includes(needle.toLowerCase());
}

function traceDurationNs(row: TraceRow): number | undefined {
  if (typeof row.t0Ns !== "number" || typeof row.t1Ns !== "number") return undefined;
  return Math.max(0, row.t1Ns - row.t0Ns);
}

function countBy(rows: TraceRow[], key: (row: TraceRow) => string): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const name = key(row);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function traceParentId(row: TraceRow): string | null {
  return typeof row.data?.parentId === "string" ? row.data.parentId : null;
}

function inclusiveNs(row: TraceRow): number {
  return traceDurationNs(row) ?? 0;
}

function buildTraceCriticalPath(rows: TraceRow[]): TraceRow[] {
  const byParent = new Map<string, TraceRow[]>();
  for (const row of rows) {
    const parentId = traceParentId(row);
    if (!parentId) continue;
    const list = byParent.get(parentId) ?? [];
    list.push(row);
    byParent.set(parentId, list);
  }
  const root = rows.find((row) => row.kind === "trace") ?? rows[0] ?? null;
  const path: TraceRow[] = [];
  let current = root;
  while (current) {
    path.push(current);
    const children = (byParent.get(current.id) ?? []).filter((row) => traceDurationNs(row) != null);
    current = children.sort((a, b) => inclusiveNs(b) - inclusiveNs(a))[0] ?? null;
  }
  return path;
}

function buildTraceWaterfall(rows: TraceRow[]): Array<Record<string, unknown>> {
  const root = rows.find((row) => row.kind === "trace") ?? rows[0] ?? null;
  const base = root?.t0Ns ?? rows[0]?.t0Ns ?? 0;
  return rows
    .filter((row) => typeof row.t0Ns === "number")
    .map((row) => ({
      id: row.id,
      parentId: traceParentId(row),
      name: row.name,
      kind: row.kind,
      status: row.status,
      startMs: (row.t0Ns - base) / 1_000_000,
      durationNs: traceDurationNs(row) ?? null,
    }))
    .sort((a, b) => (a.startMs as number) - (b.startMs as number));
}

function buildTraceSideEffects(rows: TraceRow[]): TraceRow[] {
  return rows.filter((row) => /^(moo.(fs.(write|patch|record_diff|ensureDir)|proc.run|http.|facts.(add|addAll|remove|swap|update|clearStore|deleteStore|deleteGraph|deleteGraphEverywhere)|pointers.(set|cas|delete)|objects.put|memory.(assert|retract|patch)|chat.|ui.|mcp.|agent.run)|timeline.|usage.|command.)/.test(row.name));
}

function buildTraceCausalLinks(rows: TraceRow[]): Array<Record<string, unknown>> {
  const links: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const data = row.data ?? {};
    const parentId = traceParentId(row);
    if (parentId) links.push({ type: "parent", from: parentId, to: row.id });
    for (const key of ["traceId", "childTraceId", "childChatId", "chatId", "toolCallId", "instanceId", "statePointer", "runId", "requestId", "responseId"]) {
      if (data[key] != null) links.push({ type: key, from: row.id, to: data[key] });
    }
  }
  return links;
}

function buildTraceSummary(root: TraceRow | null, events: TraceRow[], includeEvents: boolean): TraceSummary | null {
  if (!root) return null;
  const errors = events.map((row) => {
    const message = traceErrorOfRow(row);
    return message ? { message, category: traceCategory(message, row)!, row } : null;
  }).filter(Boolean) as TraceErrorInfoLocal[];
  const spans = events.filter((row) => row.kind === "span" || row.kind === "trace");
  const slowestSpans = spans
    .filter((row) => traceDurationNs(row) != null)
    .sort((a, b) => inclusiveNs(b) - inclusiveNs(a))
    .slice(0, 20)
    .map((row) => ({ row, durationNs: inclusiveNs(row) }));
  const summary: any = {
    traceId: root.traceId,
    status: root.status,
    root,
    ...(traceDurationNs(root) !== undefined ? { durationNs: traceDurationNs(root) } : {}),
    ...(errors[0] ? { error: errors[0] } : {}),
    errors,
    counts: {
      total: events.length,
      byKind: countBy(events, (row) => row.kind),
      byStatus: countBy(events, (row) => row.status),
      byName: countBy(events, (row) => row.name),
    },
    slowestSpans,
    criticalPath: buildTraceCriticalPath(events).map((row) => ({ row, durationNs: traceDurationNs(row) ?? null })),
    waterfall: buildTraceWaterfall(events),
    sideEffects: buildTraceSideEffects(events),
    causalLinks: buildTraceCausalLinks(events),
  };
  if (includeEvents) summary.events = events;
  return summary as TraceSummary;
}

const traces: Moo["traces"] = {
  async current() {
    const raw = await host.currentTrace();
    return raw ? JSON.parse(raw) : null;
  },
  async get(args = {}) {
    return parseTraceRow(await host.getTrace(JSON.stringify(args ?? {})));
  },
  async events(args = {}) {
    return parseTraceRows(await host.traceEvents(JSON.stringify(args ?? {})));
  },
  async tree(args = {}) {
    return buildTraceTree(await traces.events(args));
  },
  async recent(args = {}) {
    const requestedLimit = Math.max(1, Math.min(1000, Math.floor(args.limit ?? 50)));
    const needsOverscan = Boolean(args.chatId || args.status || args.kind || args.name || args.text || args.hasError);
    const rows = parseTraceRows(await host.recentTraces(needsOverscan ? 1000 : requestedLimit));
    const out: TraceRecentRow[] = [];
    for (const row of rows) {
      if (args.status && row.status !== args.status) continue;
      if (args.kind && row.kind !== args.kind) continue;
      if (args.name && row.name !== args.name) continue;
      if (args.text && !rowContainsText(row, args.text)) continue;
      let c: { id: string; title: string | null } | null = null;
      if (args.chatId || args.includeChat) c = await chatForTraceStep(row.stepId);
      if (args.chatId && c?.id !== args.chatId) continue;
      let errorSummary = traceErrorOfRow(row);
      let category = errorSummary ? traceCategory(errorSummary, row) : undefined;
      if (args.hasError && !errorSummary) {
        const errors = await traces.errors({ traceId: row.traceId });
        if (!errors.length) continue;
        errorSummary = errors[0].message;
        category = errors[0].category;
      }
      out.push({ ...row, ...(args.includeChat && c ? { chat: c } : {}), ...(errorSummary ? { errorSummary, category } : {}) });
      if (out.length >= requestedLimit) break;
    }
    return out;
  },
  async search(args = {}) {
    const rows = await traces.recent(args);
    if (!args.includeEvents) return rows;
    const out: TraceRecentRow[] = [];
    for (const row of rows) out.push({ ...row, events: await traces.events({ traceId: row.traceId }) });
    return out;
  },
  errorOf(row) {
    return traceErrorOfRow(row);
  },
  async errors(args = {}) {
    const events = await traces.events(args);
    return events.map((row) => {
      const message = traceErrorOfRow(row);
      return message ? { message, category: traceCategory(message, row)!, row } : null;
    }).filter(Boolean) as TraceErrorInfoLocal[];
  },
  async failed(args = {}) {
    const limit = Math.max(1, Math.min(1000, Math.floor(args.limit ?? 20)));
    const rows = await traces.recent({ limit: args.chatId ? 1000 : limit, includeChat: args.includeChat, chatId: args.chatId });
    const failedRows = rows.filter((row) => row.status && row.status !== "ok" && row.status !== "running").slice(0, limit);
    if (!args.includeEvents) return failedRows;
    const out: TraceSummary[] = [];
    for (const row of failedRows) out.push(await traces.summary({ traceId: row.traceId, includeEvents: true }));
    return out as any;
  },
  async summary(args = {}) {
    const root = await traces.get(args);
    if (!root) return null;
    const events = await traces.events({ traceId: root.traceId });
    const summary = buildTraceSummary(root, events, args.includeEvents === true) as any;
    const c = await chatForTraceStep(root.stepId);
    if (c) summary.chat = c;
    return summary;
  },
  async diagnose(args = {}) {
    const limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? 20)));
    const failures = await traces.failed({ limit, chatId: args.chatId, includeEvents: true }) as unknown as TraceSummary[];
    const recent = await traces.recent({ limit: args.chatId ? 1000 : limit, chatId: args.chatId });
    const summaries: TraceSummary[] = [];
    for (const row of recent.slice(0, limit)) summaries.push(await traces.summary({ traceId: row.traceId }));
    const slowRecent = summaries
      .filter((summary) => summary.durationNs != null)
      .sort((a, b) => (b.durationNs ?? 0) - (a.durationNs ?? 0))
      .slice(0, limit);
    const slowestSpans = slowRecent.flatMap((summary: any) => (summary.slowestSpans ?? []).map((span: any) => ({ traceId: summary.traceId, ...span }))).sort((a: any, b: any) => (b.durationNs ?? 0) - (a.durationNs ?? 0)).slice(0, limit);
    const sideEffects = summaries.flatMap((summary: any) => (summary.sideEffects ?? []).map((row: TraceRow) => ({ traceId: summary.traceId, row }))).slice(0, limit * 5);
    const failuresByCategory = new Map<string, number>();
    for (const failure of failures as any[]) {
      const category = failure.error?.category ?? failure.category ?? "unknown";
      failuresByCategory.set(category, (failuresByCategory.get(category) ?? 0) + 1);
    }
    return {
      recentFailures: failures,
      slowRecent,
      slowestSpans,
      sideEffects,
      failureGroups: Array.from(failuresByCategory.entries()).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    } as any;
  },
  async mark(message, data = {}) {
    const id = await host.insertTrace(JSON.stringify({ kind: "mark", name: "user.mark", status: "ok", data: traceJsonValue({ ...data, message }) }));
    return id === "null" ? null : id;
  },
  async span(name: string, dataOrFn: any, maybeFn?: any) {
    const hasData = typeof dataOrFn !== "function";
    const fn = hasData ? maybeFn : dataOrFn;
    if (typeof fn !== "function") throw new Error("moo.traces.span requires a callback");
    const data = hasData ? dataOrFn : {};
    const rawSpanId = await host.insertTrace(JSON.stringify({ kind: "span", name, status: "running", data: traceJsonValue(data ?? {}) }));
    const spanId = rawSpanId === "null" ? null : rawSpanId;
    const previousParent = spanId ? host.setTraceParent(spanId) : null;
    try {
      const value = await fn();
      if (spanId) await host.finishTrace(spanId, "ok", traceDataJson({}));
      return value;
    } catch (e: any) {
      if (spanId) await host.finishTrace(spanId, "error", traceErrorJson(name, e));
      throw e;
    } finally {
      if (spanId) host.setTraceParent(previousParent);
    }
  },
};

async function traceObserved<T>(
  name: string,
  data: Record<string, unknown>,
  fn: () => T | Promise<T>,
  summarize?: (value: Awaited<T>) => Record<string, unknown>,
): Promise<Awaited<T>> {
  let spanId: string | null = null;
  let previousParent: string | null = null;
  try {
    { const rawSpanId = await host.insertTrace(JSON.stringify({ kind: "span", name, status: "running", data: traceJsonValue(data) })); spanId = rawSpanId === "null" ? null : rawSpanId; }
    if (spanId) previousParent = host.setTraceParent(spanId);
  } catch {
    spanId = null;
  }
  try {
    const value = await fn();
    if (spanId) {
      await host.finishTrace(spanId, "ok", traceDataJson(summarize ? summarize(value as Awaited<T>) : { output: value }));
    }
    return value as Awaited<T>;
  } catch (e: any) {
    if (spanId) {
      await host.finishTrace(spanId, "error", traceErrorJson(name, e));
    }
    throw e;
  } finally {
    if (spanId) host.setTraceParent(previousParent);
  }
}

const EMPTY_JSON_ARRAY = "[]";
async function displayPathForChat(chatId: string, path: string): Promise<string> {
  const normalizedPath = String(path).replace(/\\/g, "/");
  const scratch = (await chat.scratch(chatId)).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!scratch) return normalizedPath;
  if (normalizedPath === scratch) return ".";
  if (normalizedPath.startsWith(scratch + "/")) return normalizedPath.slice(scratch.length + 1) || ".";
  return normalizedPath;
}

async function recordFileWriteDiff(path: string, before: string | null, after: string | null): Promise<void> {
  const chatId = activeChatId;
  if (!chatId) return;
  const displayPath = await displayPathForChat(chatId, path);
  const { diff, stats } = unifiedDiffWithStats(displayPath, before, after);
  const at = await time.nowMs();
  const hash = await objects.putJSON({ kind: "agent:FileDiff", value: { chatId, path: displayPath, beforeExists: before != null, before, after, diff, stats, at } });
  const { stepId } = await appendStep(chatId, {
    kind: "agent:FileDiff",
    status: "agent:Done",
    payloadHash: hash,
    extras: [["agent:path", displayPath]],
  });
  events.publish({ kind: "file-diff", chatId, path: displayPath, before, after, diff, stats, hash, stepId, at });
}



function turtleTriple(subject: string, predicate: string, object: string): string {
  const pred = predicate === "rdf:type" ? "a" : predicate;
  return `${subject} ${pred} ${object} .`;
}

type MemoryChange = { subject: string; predicate: string; object: string };

function memorySnapshot(changes: MemoryChange[]): string {
  if (!changes.length) return "";
  const groups = new Map<string, MemoryChange[]>();
  for (const change of changes) {
    const group = groups.get(change.subject);
    if (group) group.push(change);
    else groups.set(change.subject, [change]);
  }
  const blocks: string[] = [];
  for (const [subject, group] of groups) {
    if (group.length === 1) {
      const [change] = group;
      blocks.push(turtleTriple(subject, change!.predicate, change!.object));
      continue;
    }
    blocks.push([
      subject,
      ...group.map((change, index) => {
        const pred = change.predicate === "rdf:type" ? "a" : change.predicate;
        const sep = index + 1 === group.length ? " ." : " ;";
        return "    " + pred + " " + change.object + sep;
      }),
    ].join("\n"));
  }
  return blocks.join("\n") + "\n";
}

async function recordMemoryDiff(
  store: string,
  graph: string,
  action: "assert" | "retract",
  changes: MemoryChange[],
): Promise<void> {
  const chatId = activeChatId;
  if (!chatId || changes.length === 0) return;
  const path = `${store}.ttl`;
  const snapshot = memorySnapshot(changes);
  const before = action === "assert" ? "" : snapshot;
  const after = action === "assert" ? snapshot : "";
  const { diff, stats } = unifiedDiffWithStats(path, before, after);
  const at = await time.nowMs();
  const first = changes[0]!;
  const payload: Record<string, unknown> = {
    chatId,
    store,
    graph,
    action,
    path,
    diff,
    stats,
    at,
    changes,
    count: changes.length,
    subject: first.subject,
    predicate: first.predicate,
    object: first.object,
  };
  const hash = await objects.putJSON({ kind: "agent:MemoryDiff", value: payload });
  const { stepId } = await appendStep(chatId, {
    kind: "agent:MemoryDiff",
    status: "agent:Done",
    payloadHash: hash,
    extras: [["agent:path", path], ["agent:graph", graph]],
  });
  events.publish({ kind: "memory-diff", chatId, store, graph, action, path, diff, stats, hash, stepId, at, count: changes.length, changes });
}

const TIMELINE_OBJECT_KINDS = new Set([
  "agent:FileDiff",
  "agent:MemoryDiff",
  "agent:RunJS",
  "agent:ToolResult",
  "agent:Subagent",
  "agent:SubagentSpec",
  "agent:UserInput",
  "agent:Reply",
  "agent:Compaction",
  "ui:Choice",
  "ui:Form",
  "ui:Response",
]);

function shouldRecordBlobAddition(kind: string): boolean {
  if (!activeChatId) return false;
  return !TIMELINE_OBJECT_KINDS.has(kind);
}

async function recordBlobAddition(kind: string, hash: string, content: string, encoding: "text" | "json"): Promise<void> {
  const chatId = activeChatId;
  if (!chatId) return;
  const at = await time.nowMs();
  const payload = {
    chatId,
    kind,
    hash,
    size: stringBytes(content),
    chars: content.length,
    encoding,
    at,
  };
  const payloadHash = host.putObject("agent:BlobAdd", JSON.stringify(payload));
  const { stepId } = await appendStep(chatId, {
    kind: "agent:BlobAdd",
    status: "agent:Done",
    payloadHash,
    extras: [
      ["agent:hash", hash],
      ["agent:objectKind", kind],
    ],
  });
  events.publish({ kind: "blob-add", chatId, objectKind: kind, hash, size: payload.size, chars: payload.chars, encoding, stepId, at });
}

const objects: Moo["objects"] = {
  async putText({ kind, text }) {
    const normalizedKind = String(kind);
    const content = String(text);
    const hash = host.putObject(normalizedKind, content);
    if (shouldRecordBlobAddition(normalizedKind)) await recordBlobAddition(normalizedKind, hash, content, "text");
    return hash;
  },
  async putJSON({ kind, value }) {
    const normalizedKind = String(kind);
    const content = JSON.stringify(value);
    const hash = host.putObject(normalizedKind, content);
    if (shouldRecordBlobAddition(normalizedKind)) await recordBlobAddition(normalizedKind, hash, content, "json");
    return hash;
  },
  async getText({ hash }) {
    const row = host.getObject(hash);
    return row ? { kind: row.kind, text: row.content } : null;
  },
  async getJSON({ hash }) {
    const row = host.getObject(hash);
    if (!row) return null;
    return { kind: row.kind, value: JSON.parse(row.content) };
  },
};

function requireActiveTodoChat(): string {
  const chatId = activeChatId;
  if (!chatId) throw new Error("moo.todos requires an active chat context");
  return chatId;
}

const todos: Moo["todos"] = {
  async list() {
    return await getTodos(requireActiveTodoChat());
  },
  async add(args) {
    return await addTodo(requireActiveTodoChat(), args);
  },
  async update(args) {
    return await updateTodo(requireActiveTodoChat(), args);
  },
  async done(args) {
    return await updateTodo(requireActiveTodoChat(), { id: args.id, status: "done", note: args.note });
  },
  async drop(args) {
    return await updateTodo(requireActiveTodoChat(), { id: args.id, status: "dropped", note: args.note });
  },
  async patch(args) {
    return await patchTodos(requireActiveTodoChat(), args);
  },
  async clear(args) {
    return await clearTodos(requireActiveTodoChat(), args);
  },
};

const pointers: Moo["pointers"] = {
  async get(name) {
    if (!validate.pointerName(name)) throw new MooApiError("invalid_pointer_name", "invalid pointer name", { name });
    return host.getRef(name);
  },
  async set(name, target) {
    if (!validate.pointerName(name)) throw new MooApiError("invalid_pointer_name", "invalid pointer name", { name });
    const previous = host.getRef(name);
    host.setRef(name, target);
    return { name, target, previous, changed: previous !== target };
  },
  async cas(name, expected, next) {
    if (!validate.pointerName(name)) throw new MooApiError("invalid_pointer_name", "invalid pointer name", { name });
    return host.compareAndSetRef(name, expected ?? null, next);
  },
  async list(prefix = "") {
    return host.listRefs(prefix);
  },
  async entries(prefix = "") {
    return JSON.parse(host.refEntries(prefix));
  },
  async delete(name) {
    if (!validate.pointerName(name)) throw new MooApiError("invalid_pointer_name", "invalid pointer name", { name });
    return host.deleteRef(name);
  },
};


function unpackMemoryFact(fact: unknown): [string, string, ObjectInput] {
  if (Array.isArray(fact) && fact.length >= 3) {
    return [String(fact[0]), String(fact[1]), fact[2] as ObjectInput];
  }
  if (fact && typeof fact === "object") {
    const row = fact as { subject?: unknown; predicate?: unknown; object?: unknown };
    if (row.subject != null && row.predicate != null && row.object != null) {
      return [String(row.subject), String(row.predicate), row.object as ObjectInput];
    }
  }
  throw new Error("memory fact must be [subject, predicate, object] or {subject,predicate,object}");
}

function unpackMemoryFacts(input: unknown): Array<[string, string, ObjectInput]> {
  if (!Array.isArray(input)) throw new Error("bulk memory write requires an array of facts");
  return input.map(unpackMemoryFact);
}
function unpackMemoryWriteArgs(input: unknown): Array<[string, string, ObjectInput]> {
  if (input && typeof input === "object" && !Array.isArray(input) && "facts" in input) {
    const factsInput = (input as { facts?: unknown }).facts;
    return unpackMemoryFacts(factsInput);
  }
  return [unpackMemoryFact(input)];
}

function parseBindingTerm(value: string): BindingTerm {
  const raw = String(value);
  if (raw.startsWith("<") && raw.endsWith(">")) return { value: raw.slice(1, -1), termType: "iri" };
  if (/^[A-Za-z][A-Za-z0-9_-]*:[^\s]+$/.test(raw)) return { value: raw, termType: "iri" };
  if (raw.startsWith("?")) return { value: raw.slice(1), termType: "variable" };
  if (raw.startsWith("_:")) return { value: raw, termType: "blank" };
  const dt = raw.match(/^"([\s\S]*)"\^\^(.+)$/);
  if (dt) return { value: dt[1]!.replace(/\\"/g, '"').replace(/\\n/g, "\n"), termType: "literal", datatype: dt[2] };
  const lang = raw.match(/^"([\s\S]*)"@([A-Za-z0-9-]+)$/);
  if (lang) return { value: lang[1]!.replace(/\\"/g, '"').replace(/\\n/g, "\n"), termType: "literal", language: lang[2] };
  const lit = raw.match(/^"([\s\S]*)"$/);
  if (lit) return { value: lit[1]!.replace(/\\"/g, '"').replace(/\\n/g, "\n"), termType: "literal" };
  return { value: raw };
}

function formatBindings(rows: Bindings[], format?: string): Bindings[] | TermBindings[] {
  if (format !== "term") return rows;
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, parseBindingTerm(v)])) as TermBindings);
}

function quadObjects(rows: Quad[]): QuadObject[] {
  return rows.map(([graph, subject, predicate, object]) => ({ graph, subject, predicate, object }));
}

function factStore(args: { store?: string | null } | null | undefined, op: string): string {
  const store = args?.store ?? null;
  if (!store) throw new MooApiError("invalid_argument", op + " requires store", args ?? {});
  return store;
}

function factReceipt(store: string, added: number, removed: number): FactMutationReceipt {
  return { store, added, removed };
}

function factClearReceipt(store: string | undefined, graph: string | undefined, removed: number, dryRun?: boolean): import("./types").FactClearReceipt {
  return { ...(store ? { store } : {}), ...(graph ? { graph } : {}), removed, ...(dryRun ? { dryRun: true } : {}) };
}

type SparqlDecodedResult =
  | { type: "select"; result: Bindings[] }
  | { type: "ask"; result: boolean }
  | { type: "construct"; result: Quad[] };

async function nativeSparqlQuery(
  caller: "query" | "select" | "ask" | "construct",
  query: string,
  store: string,
  graph: string | null,
  limit: number | null,
): Promise<SparqlDecodedResult> {
  return host.sparqlQuery(query, store, graph, limit) as SparqlDecodedResult;
}

const sparql: Moo["sparql"] = {
  async query(args) {
    const { query, graph = null, limit = null, format = "string" } = args || ({} as any);
    const store = factStore(args as any, "sparql.query");
    const decoded = await nativeSparqlQuery("query", query, store, graph, limit ?? null);
    if (decoded.type === "select") return formatBindings(decoded.result as Bindings[], format) as any;
    return decoded.result as any;
  },
  async select(args) {
    const { query, graph = null, limit = null, format = "string" } = args as any;
    const store = factStore(args as any, "sparql.select");
    const decoded = await nativeSparqlQuery("select", query, store, graph, limit ?? null);
    if (decoded.type !== "select") throw new MooApiError("bad_sparql", "SPARQL query returned " + decoded.type + ", not select");
    return formatBindings(decoded.result as Bindings[], format) as any;
  },
  async ask(args) {
    const { query, graph = null, limit = null } = args as any;
    const store = factStore(args as any, "sparql.ask");
    const decoded = await nativeSparqlQuery("ask", query, store, graph, limit ?? null);
    if (decoded.type !== "ask") throw new MooApiError("bad_sparql", "SPARQL query returned " + decoded.type + ", not ask");
    return decoded.result;
  },
  async construct(args) {
    const { query, graph = null, limit = null } = args as any;
    const store = factStore(args as any, "sparql.construct");
    const decoded = await nativeSparqlQuery("construct", query, store, graph, limit ?? null);
    if (decoded.type !== "construct") throw new MooApiError("bad_sparql", "SPARQL query returned " + decoded.type + ", not construct");
    return decoded.result;
  },
};

function encodeFactQuad(q: FactQuadInput): Quad {
  const raw = unpackQuad(q);
  return [String(raw[0]), String(raw[1]), String(raw[2]), encodeObject(raw[3] as ObjectInput)];
}

function removeFactQuadCandidates(q: FactQuadInput): Quad[] {
  const raw = unpackQuad(q);
  const graph = String(raw[0]);
  const subject = String(raw[1]);
  const predicate = String(raw[2]);
  const object = String(raw[3]);
  const encoded = encodeObject(raw[3] as ObjectInput);
  // Put the exact object string first. Query APIs return objects exactly as
  // stored in quads, and callers commonly feed those rows back into remove/swap.
  // Re-encoding first breaks deletion for stored IRIs that encodeObject would
  // treat as literals (for example uppercase prefixed names like v8:HeapSnapshot).
  const candidates: Quad[] = [[graph, subject, predicate, object]];
  if (encoded !== object) candidates.push([graph, subject, predicate, encoded]);
  if (object.startsWith('/')) candidates.push([graph, subject, predicate, '<' + object + '>']);
  return candidates;
}

const facts: Moo["facts"] = {
  async add(args) {
    const { graph, subject, predicate, object } = args;
    const store = factStore(args, "facts.add");
    const encoded = encodeObject(object);
    assertFactObject(encoded);
    host.addFact(store, graph, subject, predicate, encoded);
    invalidateChatFactsSummary(store);
    return factReceipt(store, 1, 0);
  },
  async addAll(args) {
    const { quads } = args;
    const store = factStore(args, "facts.addAll");
    const adds = quads.map((q) => encodeFactQuad(q));
    if (!adds.length) return factReceipt(store, 0, 0);
    assertFactObjects(adds);
    host.swapFacts(store, EMPTY_JSON_ARRAY, JSON.stringify(adds));
    invalidateChatFactsSummary(store);
    return factReceipt(store, adds.length, 0);
  },
  async remove(args) {
    const { graph, subject, predicate, object } = args;
    const store = factStore(args, "facts.remove");
    const removes = removeFactQuadCandidates({ graph, subject, predicate, object });
    host.swapFacts(store, JSON.stringify(removes), EMPTY_JSON_ARRAY);
    invalidateChatFactsSummary(store);
    return factReceipt(store, 0, 1);
  },
  async match(args) {
    const { graph = null, subject = null, predicate = null, object = null, limit = undefined, format = "tuple" } = args;
    const store = factStore(args, "facts.match");
    const encodedObject = object == null ? null : encodeObject(object);
    const rows = host.matchFacts(store, graph, subject, predicate, encodedObject, limit ?? null) as Quad[];
    return (format === "object" ? quadObjects(rows) : rows) as any;
  },
  async history(args) {
    const { graph = null, subject = null, predicate = null, object = null, limit = undefined } = args;
    const store = factStore(args, "facts.history");
    const encodedObject = object == null ? null : encodeObject(object);
    const rows = host.factHistory(store, graph, subject, predicate, encodedObject, limit ?? null);
    return rows as import("./types").FactHistoryRow[];
  },
  async matchAll(args) {
    const { patterns, graph = undefined, limit = undefined } = args;
    const store = factStore(args, "facts.matchAll");
    return host.matchFactPatterns(
      store,
      JSON.stringify(patterns.map(([s, p, o]) => [s, p, encodeObject(o as ObjectInput)])),
      graph ?? null,
      limit ?? null,
    ) as Bindings[];
  },
  async stores(args = {}) {
    return host.factStores(args.prefix ?? null);
  },
  async count(args) {
    return host.countFacts(factStore(args, "facts.count"));
  },
  async swap(args) {
    const { removes, adds } = args;
    const store = factStore(args, "facts.swap");
    const encodedRemoves = removes.flatMap((q) => removeFactQuadCandidates(q));
    const encodedAdds = adds.map((q) => encodeFactQuad(q));
    assertFactObjects(encodedAdds);
    host.swapFacts(store, JSON.stringify(encodedRemoves), JSON.stringify(encodedAdds));
    invalidateChatFactsSummary(store);
    return factReceipt(store, encodedAdds.length, encodedRemoves.length);
  },
  async update(args) {
    const { fn } = args;
    const store = factStore(args, "facts.update");
    const removes: Quad[] = [];
    const adds: Quad[] = [];
    await fn({
      add({ graph, subject, predicate, object }) {
        adds.push([graph, subject, predicate, encodeObject(object)]);
      },
      remove({ graph, subject, predicate, object }) {
        removes.push(...removeFactQuadCandidates({ graph, subject, predicate, object }));
      },
    });
    if (!removes.length && !adds.length) return factReceipt(store, 0, 0);
    assertFactObjects(adds);
    host.swapFacts(store, JSON.stringify(removes), JSON.stringify(adds));
    invalidateChatFactsSummary(store);
    return factReceipt(store, adds.length, removes.length);
  },
  async clearStore(args) {
    const store = factStore(args, "facts.clearStore");
    const dryRun = !!args.dryRun;
    if (dryRun) return factClearReceipt(store, undefined, host.countFacts(store), true);
    const removed = host.clearFacts(store);
    invalidateChatFactsSummary(store);
    return factClearReceipt(store, undefined, removed);
  },
  async deleteStore(args) {
    const store = factStore(args, "facts.deleteStore");
    const dryRun = !!args.dryRun;
    if (dryRun) return factClearReceipt(store, undefined, host.countFacts(store), true);
    const removed = host.purgeFacts(store);
    invalidateChatFactsSummary(store);
    return factClearReceipt(store, undefined, removed);
  },
  async deleteGraph(args) {
    const { graph } = args;
    const store = factStore(args, "facts.deleteGraph");
    const dryRun = !!args.dryRun;
    const matches = host.matchFacts(store, graph, null, null, null, null) as Quad[];
    if (dryRun) return factClearReceipt(store, graph, matches.length, true);
    if (!matches.length) return factClearReceipt(store, graph, 0);
    host.swapFacts(store, JSON.stringify(matches), EMPTY_JSON_ARRAY);
    invalidateChatFactsSummary(store);
    return factClearReceipt(store, graph, matches.length);
  },
  async deleteGraphEverywhere({ graph, dryRun = false }) {
    if (dryRun) {
      let removed = 0;
      for (const store of host.factStores(null)) {
        removed += (host.matchFacts(store, graph, null, null, null, null) as Quad[]).length;
      }
      return factClearReceipt(undefined, graph, removed, true);
    }
    const removed = host.purgeFactsGraph(graph);
    chatFactsSummaryCache.clear();
    return factClearReceipt(undefined, graph, removed);
  },
};

async function activeScratchRoot(): Promise<string | null> {
  return activeChatId ? await chat.scratch(activeChatId) : null;
}

setSkillRootProvider(activeScratchRoot);

function resolveWorkspacePath(root: string, path: string = "."): string {
  const raw = String(path || ".");
  if (raw.startsWith("/")) return raw;
  if (!validate.relativePath(raw) && raw !== ".") throw new MooApiError("path_escape", "workspace paths must be relative and may not contain ..", { root, path: raw });
  const parts = raw.split("/").filter((part) => part && part !== ".");
  return parts.length ? joinPath(root, parts.join("/")) : root;
}

async function resolveActivePath(path: string = "."): Promise<string> {
  const raw = String(path || ".");
  if (raw.startsWith("/")) return raw;
  const root = await activeScratchRoot();
  return root ? resolveWorkspacePath(root, raw) : raw;
}

type NormalizedLineRange = { from: number; to: number };

function splitReadableLines(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function normalizeLineRanges(ranges: [number, number][]): NormalizedLineRange[] {
  if (!Array.isArray(ranges)) throw new MooApiError("invalid_argument", "moo.fs.readLines ranges must be an array", { ranges });
  const sorted = ranges.map((range, index) => {
    if (!Array.isArray(range) || range.length !== 2) {
      throw new MooApiError("invalid_argument", "moo.fs.readLines range must be [from, to]", { index, range });
    }
    const from = Number(range[0]);
    const to = Number(range[1]);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || from > to) {
      throw new MooApiError("invalid_argument", "moo.fs.readLines ranges must use 1-based inclusive line numbers with from <= to", { index, range });
    }
    return { from, to };
  }).sort((a, b) => a.from - b.from || a.to - b.to);

  const normalized: NormalizedLineRange[] = [];
  for (const range of sorted) {
    const previous = normalized[normalized.length - 1];
    if (previous && range.from <= previous.to + 1) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      normalized.push({ ...range });
    }
  }
  return normalized;
}

function formatReadLines(text: string, ranges: [number, number][], opts: { numbered?: boolean } = {}): string[] {
  const normalizedRanges = normalizeLineRanges(ranges);
  if (!normalizedRanges.length) return [];
  const lines = splitReadableLines(text);
  if (!lines.length) return [];
  const maxLine = lines.length;
  const width = Math.max(4, String(maxLine).length);
  const out: string[] = [];
  let previousLineNo = 0;
  let wroteLine = false;
  for (const range of normalizedRanges) {
    const from = Math.max(1, range.from);
    const to = Math.min(range.to, maxLine);
    if (from > to) continue;
    if (previousLineNo + 1 < from) out.push("…");
    for (let lineNo = Math.max(from, previousLineNo + 1); lineNo <= to; lineNo++) {
      const line = lines[lineNo - 1] ?? "";
      out.push(opts.numbered ? String(lineNo).padStart(width) + ": " + line : line);
      wroteLine = true;
    }
    previousLineNo = Math.max(previousLineNo, to);
  }
  if (wroteLine && previousLineNo < maxLine) out.push("…");
  return out;
}

async function resolveActiveCwd(cwd?: string | null): Promise<string | null> {
  const raw = cwd == null ? null : String(cwd || ".");
  if (raw?.startsWith("/")) return raw;
  const root = await activeScratchRoot();
  if (!root) return raw;
  return raw ? resolveWorkspacePath(root, raw) : root;
}

function normalizeAbsolutePosixPath(candidate: string): string {
  const parts: string[] = [];
  for (const part of candidate.split("/")) {
    if (part === "" || part === ".") continue;
    parts.push(part);
  }
  return parts.length === 0 ? "/" : "/" + parts.join("/");
}

function resolveApplyPatchPaths(rawPath: string, workingDirectory: string | null): [string, string] {
  const candidate = String(rawPath ?? "").trim();
  if (!candidate) throw new ApplyPatchError("apply_patch paths must not be empty.");
  if (candidate.includes("\\")) throw new ApplyPatchError("apply_patch paths must use forward slashes.");
  if (candidate.startsWith("/")) {
    const normalized = normalizeAbsolutePosixPath(candidate);
    return [normalized, normalized];
  }
  const parts: string[] = [];
  for (const part of candidate.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new ApplyPatchError("apply_patch paths must stay within the workspace root.");
    parts.push(part);
  }
  if (parts.length === 0) throw new ApplyPatchError("apply_patch paths must point to a file inside the workspace root.");
  const display = parts.join("/");
  return [display, workingDirectory ? joinPath(workingDirectory, display) : display];
}

function applyPatchResult(status: string, output: string): ApplyPatchResult {
  return { tool_name: "apply_patch", status, output };
}

async function executeApplyPatch(input: ApplyPatchInput, workingDirectory: string | null): Promise<ApplyPatchResult> {
  let display: string;
  let absolute: string;
  try {
    [display, absolute] = resolveApplyPatchPaths(input.path, workingDirectory);
  } catch (e) {
    return applyPatchResult("failed", (e as Error).message);
  }

  const operation = String(input.operation_type || "");
  if (operation === "create_file") {
    if ((await fs.stat(absolute)) !== null) {
      return applyPatchResult("failed", "Cannot create '" + display + "' because it already exists.");
    }
    let content: string;
    try {
      content = applyUnifiedDiff("", input.diff ?? "");
    } catch (e) {
      return applyPatchResult("failed", "Could not build '" + display + "' from the patch: " + (e as Error).message);
    }
    try {
      await fs.write(absolute, content);
    } catch (e) {
      return applyPatchResult("failed", "Could not write '" + display + "': " + (e as Error).message);
    }
    return applyPatchResult("completed", "Applied patch to create '" + display + "'.");
  }

  if (operation === "update_file") {
    const stat = await fs.stat(absolute);
    if (stat === null) {
      return applyPatchResult("failed", "Could not read '" + display + "' before applying the patch: File not found");
    }
    if (stat.kind === "dir") {
      return applyPatchResult("failed", "Could not read '" + display + "' before applying the patch: " + absolute + " is a directory");
    }
    let original: string;
    try {
      original = await fs.read(absolute);
    } catch (e) {
      return applyPatchResult("failed", "Could not read '" + display + "' before applying the patch: " + (e as Error).message);
    }
    let content: string;
    try {
      content = applyUnifiedDiff(original, input.diff ?? "");
    } catch (e) {
      return applyPatchResult("failed", "Could not apply the patch to '" + display + "': " + (e as Error).message);
    }
    try {
      await fs.write(absolute, content);
    } catch (e) {
      return applyPatchResult("failed", "Could not write '" + display + "': " + (e as Error).message);
    }
    return applyPatchResult("completed", "Applied patch to update '" + display + "'.");
  }

  if (operation === "delete_file") {
    if ((await fs.stat(absolute)) === null) {
      return applyPatchResult("failed", "Cannot delete '" + display + "' because it does not exist.");
    }
    let before: string | null = null;
    try {
      before = await fs.read(absolute);
    } catch (_) {
      before = null;
    }
    try {
      await traceObserved("moo.fs.delete", { path: input.path, resolved: absolute }, () => host.deleteFile(absolute));
    } catch (e) {
      return applyPatchResult("failed", "Could not delete '" + display + "': " + (e as Error).message);
    }
    if (before !== null) {
      await traceObserved("moo.fs.record_diff", { path: input.path, resolved: absolute }, () => recordFileWriteDiff(absolute, before, null));
    }
    return applyPatchResult("completed", "Applied patch to delete '" + display + "'.");
  }

  return applyPatchResult("failed", "apply_patch received an unknown operation type: " + input.operation_type);
}

const fs: Moo["fs"] = {
  async read(path) {
    const resolved = await resolveActivePath(path);
    return await traceObserved("moo.fs.read", { path, resolved }, () => host.readFile(resolved), (value) => ({ chars: value.length, bytes: stringBytes(value) }));
  },
  async readLines(path, ranges, opts = {}) {
    const content = await fs.read(path);
    return await traceObserved("moo.fs.readLines", { path, ranges, numbered: !!opts.numbered }, () => formatReadLines(content, ranges, opts), (value) => ({ lines: value.length }));
  },
  async write(path, content) {
    const resolved = await resolveActivePath(path);
    const text = typeof content === "string" ? content : String(content);
    let before: string | null = null;
    try {
      before = await traceObserved("moo.fs.read_before_write", { path, resolved }, () => host.readFile(resolved), (value) => ({ chars: value.length }));
    } catch (_) {
      before = null;
    }
    await traceObserved("moo.fs.write", {
      path,
      resolved,
      chars: text.length,
      beforeExists: before != null,
    }, () => host.writeFile(resolved, text), () => ({ changed: before !== text }));
    await traceObserved("moo.fs.record_diff", { path, resolved }, () => recordFileWriteDiff(resolved, before, text));
  },
  async list(path) {
    const resolved = await resolveActivePath(path);
    return await traceObserved("moo.fs.list", { path, resolved }, () => host.listDir(resolved), (value) => ({ count: value.length }));
  },
  async glob(pattern) {
    const resolved = await resolveActivePath(pattern);
    return await traceObserved("moo.fs.glob", { pattern, resolved }, () => host.globFiles(resolved), (value) => ({ count: value.length }));
  },
  async stat(path) {
    const resolved = await resolveActivePath(path);
    return await traceObserved("moo.fs.stat", { path, resolved }, () => host.statFile(resolved), (value) => ({ exists: value != null, kind: (value as any)?.kind ?? null, size: (value as any)?.size ?? null, mtime: (value as any)?.mtime ?? null }));
  },
  async canonical(path) {
    const resolved = await resolveActivePath(path);
    return await traceObserved("moo.fs.canonical", { path, resolved }, () => host.canonicalPath(resolved), (value) => ({ path: value }));
  },
  async exists(path) {
    return await traceObserved("moo.fs.exists", { path }, async () => (await fs.stat(path)) != null, (value) => ({ exists: value }));
  },
  async ensureDir(path) {
    const resolved = await resolveActivePath(path);
    await traceObserved("moo.fs.ensureDir", { path, resolved }, () => host.makeDir(resolved), () => ({ path: resolved }));
  },
  async applyPatch(input) {
    const root = await activeScratchRoot();
    return await traceObserved("moo.fs.applyPatch", { path: input?.path, operation_type: input?.operation_type, root }, () => executeApplyPatch(input, root), (value) => ({ status: value.status, output: value.output ?? null }));
  },
};

function checkedProcResult(input: ProcRunArgs, result: ProcResult): ProcResult {
  if (input.check && result.code !== 0) {
    const code = result.timedOut ? "timeout" : "process_failed";
    const message = result.timedOut
      ? "process timed out: " + input.cmd
      : "process failed: " + input.cmd + " exited " + result.code;
    throw new MooApiError(code, message, {
      cmd: input.cmd,
      args: input.args ?? [],
      cwd: input.cwd ?? null,
      code: result.code,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated ?? false,
      stderrTruncated: result.stderrTruncated ?? false,
    });
  }
  return result;
}

const proc: Moo["proc"] = {
  async run(input) {
    const { cmd, args = [], stdin = null, timeoutMs = 60_000, env = undefined, maxOutputBytes = null } = input;
    const cwd = await resolveActiveCwd(input.cwd);
    return await traceObserved("moo.proc.run", {
      cmd,
      args,
      cwd,
      timeoutMs,
      hasStdin: stdin != null,
      stdinChars: typeof stdin === "string" ? stdin.length : 0,
      envKeys: env && typeof env === "object" ? Object.keys(env).sort() : [],
      maxOutputBytes: maxOutputBytes ?? null,
      check: input.check === true,
    }, () => {
      const result = host.runProcess(
        cmd,
        JSON.stringify(args),
        cwd,
        stdin,
        timeoutMs,
        env == null ? null : JSON.stringify(env),
        maxOutputBytes ?? null,
      );
      return checkedProcResult({ ...input, cwd }, result);
    }, (result) => ({
      code: result.code,
      timedOut: result.timedOut,
      stdoutChars: result.stdout?.length ?? 0,
      stderrChars: result.stderr?.length ?? 0,
      stdoutTruncated: result.stdoutTruncated ?? false,
      stderrTruncated: result.stderrTruncated ?? false,
    }));
  },
  async runChecked(input) {
    return proc.run({ ...input, check: true });
  },
};

const workspace: Moo["workspace"] = {
  async current(args = {}) {
    const root = args.root ? await fs.canonical(args.root) : await chat.scratch(args.chatId || activeChatId || "default");
    return {
      root,
      fs: {
        read: (path) => fs.read(resolveWorkspacePath(root, path)),
        readLines: (path, ranges, opts) => fs.readLines(resolveWorkspacePath(root, path), ranges, opts),
        write: (path, content) => fs.write(resolveWorkspacePath(root, path), content),
        list: (path = ".") => fs.list(resolveWorkspacePath(root, path)),
        glob: (pattern) => fs.glob(resolveWorkspacePath(root, pattern)),
        stat: (path = ".") => fs.stat(resolveWorkspacePath(root, path)),
        canonical: (path = ".") => fs.canonical(resolveWorkspacePath(root, path)),
        exists: (path = ".") => fs.exists(resolveWorkspacePath(root, path)),
        ensureDir: (path = ".") => fs.ensureDir(resolveWorkspacePath(root, path)),
        applyPatch: (input) => executeApplyPatch(input, root),
      },
      proc: {
        run: (input: Omit<ProcRunArgs, "cwd"> & { cwd?: string | null }) => proc.run({ ...input, cwd: input.cwd ? resolveWorkspacePath(root, input.cwd) : root }),
        runChecked: (input: Omit<ProcRunArgs, "cwd" | "check"> & { cwd?: string | null }) => proc.runChecked({ ...input, cwd: input.cwd ? resolveWorkspacePath(root, input.cwd) : root }),
      },
    };
  },
};

function buildBody(opts: any): { body: string | null; headers: Record<string, string> } {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  let body: string | null = null;
  if (opts.body != null) {
    if (typeof opts.body === "string") {
      body = opts.body;
    } else {
      body = JSON.stringify(opts.body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    }
  }
  return { body, headers };
}

function parseResponseHeaders(headersJson: string | undefined): Record<string, string | string[]> {
  if (!headersJson) return {};
  try {
    const parsed = JSON.parse(headersJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (typeof v === "string") out[key] = v;
      else if (Array.isArray(v)) out[key] = v.map((item) => String(item));
    }
    return out;
  } catch {
    return {};
  }
}

const http: Moo["http"] = {
  async fetch(opts) {
    const method = opts.method || "GET";
    if (!opts.url) throw new Error("http.fetch requires url");
    const { body, headers } = buildBody(opts);
    return await traceObserved("moo.http.fetch", {
      method,
      url: opts.url,
      headers,
      body,
      timeoutMs: opts.timeoutMs ?? 60_000,
    }, () => {
      const response = host.fetchHttp(method, opts.url, JSON.stringify(headers), body, opts.timeoutMs ?? 60_000);
      return { status: response.status, body: response.body, headers: parseResponseHeaders(response.headers) };
    });
  },
  async stream(opts) {
    const method = opts.method || "GET";
    if (!opts.url) throw new Error("http.stream requires url");
    const { body, headers } = buildBody(opts);
    const opened = await traceObserved("moo.http.stream.open", {
      method,
      url: opts.url,
      headers,
      body,
      timeoutMs: opts.timeoutMs ?? 120_000,
    }, () => host.openHttpStream(
        method,
        opts.url,
        JSON.stringify(headers),
        body,
        opts.timeoutMs ?? 120_000,
      ));
    return {
      status: opened.status,
      headers: parseResponseHeaders(opened.headers),
      async next() {
        return await traceObserved("moo.http.stream.next", { status: opened.status }, () => host.nextHttpStreamChunk(opened.handle), (chunk) => ({ chunkChars: chunk?.length ?? 0, done: chunk == null }));
      },
      async close() {
        await traceObserved("moo.http.stream.close", { status: opened.status }, () => host.closeHttpStream(opened.handle));
      },
    };
  },
};


// -- Model Context Protocol ---------------------------------------------

function cleanMcpId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const v = id.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(v) ? v : null;
}

function mcpRef(id: string): string {
  return `mcp/${id}/config`;
}

function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    const key = String(k).trim();
    if (!key) continue;
    if (v == null) continue;
    out[key] = String(v);
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeMcpOAuth(oauth: unknown): McpServerConfig["oauth"] | undefined {
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return undefined;
  const src = oauth as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of [
    "clientId",
    "clientSecret",
    "authorizationUrl",
    "tokenUrl",
    "scope",
    "redirectUri",
    "resourceMetadataUrl",
    "authorizationServerMetadataUrl",
    "registrationUrl",
  ]) {
    const value = src[key];
    if (value != null && String(value).trim()) out[key] = String(value).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeMcpServer(input: McpServerConfig): McpServerConfig {
  const id = cleanMcpId(input?.id);
  if (!id) throw new Error("MCP server id must match [a-zA-Z0-9_.-]+");
  const url = String(input.url || "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("MCP server url must be http(s)");
  const transport = input.transport === "sse" ? "sse" : "http";
  const timeoutMs = Number(input.timeoutMs ?? 60_000);
  return {
    id,
    title: String(input.title || id).trim() || id,
    url,
    transport,
    enabled: input.enabled !== false,
    headers: normalizeHeaders(input.headers),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 60_000,
    oauth: normalizeMcpOAuth(input.oauth),
  };
}

function parseMcpSseBody(body: string): any {
  const messages: any[] = [];
  let dataLines: string[] = [];
  let parseError: any = null;
  const flush = () => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") return;
    try {
      messages.push(JSON.parse(data));
    } catch (err: any) {
      parseError = err;
    }
  };

  for (const rawLine of body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (rawLine === "") {
      flush();
      continue;
    }
    if (rawLine.startsWith("data:")) {
      let data = rawLine.slice(5);
      if (data.startsWith(" ")) data = data.slice(1);
      dataLines.push(data);
    }
  }
  flush();

  if (messages.length) {
    return messages.find((message) => message?.error) || messages.find((message) => message?.result !== undefined) || messages[messages.length - 1];
  }
  if (parseError) throw parseError;
  throw new Error("no JSON data events found");
}

function parseMcpBody(body: string): any {
  try {
    return JSON.parse(body || "null");
  } catch (jsonErr: any) {
    try {
      return parseMcpSseBody(body || "");
    } catch (sseErr: any) {
      throw new Error(`MCP server returned non-JSON response: ${jsonErr?.message || jsonErr}; SSE parse failed: ${sseErr?.message || sseErr}`);
    }
  }
}

function mcpEndpoint(server: McpServerConfig): string {
  // Streamable HTTP MCP servers usually expose their JSON-RPC endpoint at the
  // configured URL. For SSE configs, the same request helper targets a sibling
  // /message endpoint unless the user already supplied one explicitly.
  if (server.transport !== "sse") return server.url;
  if (/\/message\/?$/i.test(server.url)) return server.url;
  return server.url.replace(/\/?$/, "/message");
}

type McpOAuthToken = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  expires_at?: number;
  refresh_token?: string;
  scope?: string;
};

type McpOAuthPending = {
  serverId: string;
  codeVerifier: string;
  redirectUri: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  expiresAt: number;
  returnChatId?: string;
};

type McpSession = {
  id?: string;
  initializedAt?: number;
};


type McpRequestOptions = {
  skipInitialize?: boolean;
  omitSession?: boolean;
  retryingSession?: boolean;
  timeoutMs?: number;
};

function mcpOAuthTokenRef(id: string): string {
  return `mcp/${id}/oauth/token`;
}

function mcpOAuthPendingRef(state: string): string {
  return `mcp/oauth/state/${state}`;
}

function mcpSessionRef(id: string): string {
  return `mcp/${id}/session`;
}

function parseHttpUrl(url: string): { origin: string; path: string } | null {
  const m = /^(https?:\/\/[^/?#]+)([^?#]*)/i.exec(url);
  if (!m) return null;
  return { origin: m[1]!, path: m[2] || "/" };
}

function formEncode(values: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (v == null) continue;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
  }
  return parts.join("&");
}

function addQuery(url: string, values: Record<string, string | undefined>): string {
  const qs = formEncode(values);
  if (!qs) return url;
  const hash = url.indexOf("#");
  const base = hash >= 0 ? url.slice(0, hash) : url;
  const frag = hash >= 0 ? url.slice(hash) : "";
  return base + (base.includes("?") ? "&" : "?") + qs + frag;
}

function oauthSecret(prefix: string): string {
  let out = "";
  while (out.length < 64) out += host.newId(prefix).replace(/[^A-Za-z0-9._~-]/g, "");
  return out.slice(0, 96);
}

async function getJsonMaybe(url: string, timeoutMs = 10_000): Promise<any | null> {
  try {
    const response = await http.fetch({ method: "GET", url, headers: { Accept: "application/json" }, timeoutMs });
    if (response.status < 200 || response.status >= 300) return null;
    return parseMcpBody(response.body);
  } catch {
    return null;
  }
}

async function discoverMcpOAuth(server: McpServerConfig): Promise<Required<Pick<NonNullable<McpServerConfig["oauth"]>, "authorizationUrl" | "tokenUrl">> & NonNullable<McpServerConfig["oauth"]> & { registrationUrl?: string }> {
  let oauth = { ...(server.oauth || {}) };
  if ((!oauth.authorizationUrl || !oauth.tokenUrl) && oauth.resourceMetadataUrl) {
    const meta = await getJsonMaybe(oauth.resourceMetadataUrl, server.timeoutMs);
    const issuer = meta?.authorization_servers?.[0] || meta?.authorization_server;
    if (issuer && !oauth.authorizationServerMetadataUrl) {
      oauth.authorizationServerMetadataUrl = String(issuer).replace(/\/$/, "") + "/.well-known/oauth-authorization-server";
    }
  }
  if ((!oauth.authorizationUrl || !oauth.tokenUrl) && !oauth.resourceMetadataUrl) {
    const parsed = parseHttpUrl(server.url);
    if (parsed) {
      const candidates = [
        parsed.origin + "/.well-known/oauth-protected-resource" + parsed.path.replace(/\/$/, ""),
        parsed.origin + "/.well-known/oauth-protected-resource",
      ];
      for (const candidate of candidates) {
        const meta = await getJsonMaybe(candidate, server.timeoutMs);
        const issuer = meta?.authorization_servers?.[0] || meta?.authorization_server;
        if (issuer) {
          oauth.resourceMetadataUrl = candidate;
          oauth.authorizationServerMetadataUrl = String(issuer).replace(/\/$/, "") + "/.well-known/oauth-authorization-server";
          break;
        }
      }
    }
  }
  if ((!oauth.authorizationUrl || !oauth.tokenUrl) && oauth.authorizationServerMetadataUrl) {
    const meta = await getJsonMaybe(oauth.authorizationServerMetadataUrl, server.timeoutMs);
    oauth.authorizationUrl ||= meta?.authorization_endpoint;
    oauth.tokenUrl ||= meta?.token_endpoint;
    oauth.registrationUrl ||= meta?.registration_endpoint;
  }
  if (!oauth.authorizationUrl || !oauth.tokenUrl) {
    throw new Error(`MCP server ${server.id} needs oauth.authorizationUrl and oauth.tokenUrl (or discoverable metadata)`);
  }
  return oauth as any;
}

async function loadMcpOAuthToken(serverId: string): Promise<McpOAuthToken | null> {
  const clean = cleanMcpId(serverId);
  if (!clean) return null;
  const hash = await pointers.get(mcpOAuthTokenRef(clean));
  if (!hash) return null;
  const row = await objects.getJSON<McpOAuthToken>({ hash: hash });
  return row?.value?.access_token ? row.value : null;
}

async function saveMcpOAuthToken(serverId: string, token: McpOAuthToken): Promise<McpOAuthToken> {
  const now = await time.nowMs();
  if (token.expires_in && !token.expires_at) token.expires_at = now + Number(token.expires_in) * 1000;
  const hash = await objects.putJSON({ kind: "mcp:OAuthToken", value: token });
  await pointers.set(mcpOAuthTokenRef(serverId), hash);
  return token;
}

function headerValue(headers: Record<string, string | string[]> | undefined, name: string): string | null {
  if (!headers) return null;
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.find((item) => item.trim())?.trim() || null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function loadMcpSession(serverId: string): Promise<McpSession | null> {
  const clean = cleanMcpId(serverId);
  if (!clean) return null;
  const target = await pointers.get(mcpSessionRef(clean));
  if (!target) return null;
  const value = decodeJsonPointer<McpSession>(target);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const session: McpSession = {};
  if (typeof value.id === "string" && value.id.trim()) session.id = value.id.trim();
  if (Number.isFinite(value.initializedAt)) session.initializedAt = Number(value.initializedAt);
  return session.id || session.initializedAt ? session : null;
}

function encodeMcpSessionPointerTarget(session: McpSession): string {
  const value: McpSession = {};
  if (session.id) value.id = session.id;
  if (Number.isFinite(session.initializedAt)) value.initializedAt = Number(session.initializedAt);
  return encodeJsonPointer(value);
}

async function saveMcpSession(serverId: string, session: McpSession): Promise<void> {
  const clean = cleanMcpId(serverId);
  if (!clean) return;
  const ref = mcpSessionRef(clean);
  const current = await loadMcpSession(clean);
  const next: McpSession = {
    ...(current || {}),
    ...session,
  };
  const nextTarget = encodeMcpSessionPointerTarget(next);
  if ((await pointers.get(ref)) !== nextTarget) await pointers.set(ref, nextTarget);
}

async function loadMcpSessionId(serverId: string): Promise<string | null> {
  return (await loadMcpSession(serverId))?.id || null;
}

async function saveMcpSessionId(serverId: string, sessionId: string): Promise<void> {
  const value = sessionId.trim();
  if (value) await saveMcpSession(serverId, { id: value });
}

async function markMcpInitialized(serverId: string, sessionId?: string | null): Promise<void> {
  const session: McpSession = { initializedAt: await time.nowMs() };
  if (sessionId?.trim()) session.id = sessionId.trim();
  await saveMcpSession(serverId, session);
}

async function clearMcpSessionId(serverId: string): Promise<void> {
  const clean = cleanMcpId(serverId);
  if (clean) await pointers.delete(mcpSessionRef(clean));
}

function mcpInitializeParams() {
  return {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "moo", version: "0.2.4" },
  };
}

function isMcpSessionError(status: number, body: string): boolean {
  return (status === 400 || status === 404) && /mcp-session-id|session/i.test(body || "");
}

type McpOAuthClientRegistration = {
  client_id: string;
  client_secret?: string;
  redirect_uris?: string[];
  token_endpoint_auth_method?: string;
};

function mcpOAuthRedirectUri(opts: McpOAuthStartOptions, oauth: NonNullable<McpServerConfig["oauth"]> & { redirectUri?: string }): string {
  const origin = normalizeServerBaseUrl(opts.origin) || activeServerBaseUrl || "http://127.0.0.1:7777";
  return normalizeServerBaseUrl(opts.redirectUri) || ((opts.origin || activeServerBaseUrl) ? origin + "/mcp/oauth/callback" : normalizeServerBaseUrl(oauth.redirectUri) || origin + "/mcp/oauth/callback");
}

async function registerMcpOAuthClient(server: McpServerConfig, oauth: Awaited<ReturnType<typeof discoverMcpOAuth>>, redirectUri: string): Promise<Awaited<ReturnType<typeof discoverMcpOAuth>>> {
  if (!oauth.registrationUrl) return oauth;
  if (oauth.clientId && oauth.clientId !== "moo" && normalizeServerBaseUrl(oauth.redirectUri) === redirectUri) return oauth;
  const response = await http.fetch({
    method: "POST",
    url: oauth.registrationUrl,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "moo " + (server.title || server.id),
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
    timeoutMs: server.timeoutMs ?? 60_000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`MCP OAuth client registration failed with HTTP ${response.status}: ${response.body}`);
  }
  const registered = parseMcpBody(response.body) as McpOAuthClientRegistration;
  if (!registered?.client_id) throw new Error("MCP OAuth client registration response missing client_id");
  const nextOauth = {
    ...oauth,
    clientId: registered.client_id,
    clientSecret: registered.client_secret || oauth.clientSecret,
    redirectUri,
  };
  await mcpCore.saveServer({ ...server, oauth: nextOauth });
  return nextOauth;
}

async function refreshMcpOAuthToken(server: McpServerConfig, token: McpOAuthToken): Promise<McpOAuthToken | null> {
  if (!token.refresh_token) return token;
  if (token.expires_at && token.expires_at - (await time.nowMs()) > 60_000) return token;
  const oauth = await discoverMcpOAuth(server);
  const response = await http.fetch({
    method: "POST",
    url: oauth.tokenUrl,
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: formEncode({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: oauth.clientId || "moo",
      client_secret: oauth.clientSecret,
    }),
    timeoutMs: server.timeoutMs ?? 60_000,
  });
  if (response.status < 200 || response.status >= 300) return token;
  const next = parseMcpBody(response.body) as McpOAuthToken;
  if (!next.refresh_token) next.refresh_token = token.refresh_token;
  return saveMcpOAuthToken(server.id, next);
}


function truncateDensePart(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function schemaTypeName(schema: unknown, depth = 0): string {
  if (!isRecord(schema)) return "unknown";
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.slice(0, 4).map((v: unknown) => JSON.stringify(v)).join("|") + (schema.enum.length > 4 ? "|…" : "");
  }
  const union = [schema.anyOf, schema.oneOf].find(Array.isArray) as unknown[] | undefined;
  if (union?.length) return union.slice(0, 4).map((s) => schemaTypeName(s, depth + 1)).join("|");
  if (Array.isArray(schema.type)) return schema.type.map((t: unknown) => String(t)).join("|");
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type === "array") return schema.items ? `${schemaTypeName(schema.items, depth + 1)}[]` : "unknown[]";
  if (type === "object" || schema.properties) {
    if (depth >= 1) return "object";
    return schemaShape(schema, depth + 1, 4);
  }
  if (type === "integer") return "integer";
  if (type) return type;
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  return "unknown";
}

function schemaShape(schema: unknown, depth = 0, maxProps = 8): string {
  if (!isRecord(schema)) return "{}";
  const props = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const entries = Object.entries(props).slice(0, maxProps).map(([key, prop]) => {
    const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
    const optional = required.has(key) ? "" : "?";
    return `${safeKey}${optional}:${schemaTypeName(prop, depth + 1)}`;
  });
  if (Object.keys(props).length > maxProps) entries.push("…");
  if (!entries.length && schema.additionalProperties) entries.push("[key:string]:" + schemaTypeName(schema.additionalProperties, depth + 1));
  return "{" + entries.join(",") + "}";
}

function denseMcpToolDescription(tool: any, inputSchema: unknown): string {
  const shape = schemaShape(inputSchema);
  const description = truncateDensePart(String(tool.description ?? tool.title ?? tool.annotations?.title ?? tool.name ?? ""));
  return description ? `${shape}: ${description}` : shape;
}

const mcpCore = {
  async listServers(): Promise<McpServerConfig[]> {
    const ids = new Set<string>();
    for (const pointer of await pointers.list("mcp/")) {
      const m = /^mcp\/([^/]+)\/config$/.exec(pointer);
      if (m) ids.add(m[1]!);
    }
    const out: McpServerConfig[] = [];
    for (const id of [...ids].sort()) {
      const server = await mcpCore.getServer(id);
      if (server) out.push(server);
    }
    return out;
  },
  async getServer(id: string): Promise<McpServerConfig | null> {
    const clean = cleanMcpId(id);
    if (!clean) return null;
    const hash = await pointers.get(mcpRef(clean));
    if (!hash) return null;
    const row = await objects.getJSON<McpServerConfig>({ hash: hash });
    return row?.value ? normalizeMcpServer(row.value) : null;
  },
  async saveServer(config: McpServerConfig): Promise<McpServerConfig> {
    const server = normalizeMcpServer(config);
    const hash = await objects.putJSON({ kind: "mcp:ServerConfig", value: server });
    await pointers.set(mcpRef(server.id), hash);
    await clearMcpSessionId(server.id);
    return server;
  },
  async removeServer(id: string): Promise<boolean> {
    const clean = cleanMcpId(id);
    if (!clean) return false;
    await pointers.delete(mcpOAuthTokenRef(clean));
    await clearMcpSessionId(clean);
    return pointers.delete(mcpRef(clean));
  },
  async login(serverId: string, opts: McpOAuthStartOptions = {}): Promise<McpOAuthStart> {
    const server = await mcpCore.getServer(serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}`);
    let oauth = await discoverMcpOAuth(server);
    const redirectUri = mcpOAuthRedirectUri(opts, oauth);
    oauth = await registerMcpOAuthClient(server, oauth, redirectUri);
    const clientId = oauth.clientId || "moo";
    const state = oauthSecret("mcpstate");
    const codeVerifier = oauthSecret("mcpverifier");
    const codeChallenge = host.sha256Base64Url(codeVerifier);
    const expiresAt = (await time.nowMs()) + 10 * 60_000;
    const returnChatId = String(opts.returnChatId || activeChatId || "").trim() || undefined;
    const pending: McpOAuthPending = {
      serverId: server.id,
      codeVerifier,
      redirectUri,
      tokenUrl: oauth.tokenUrl,
      clientId,
      clientSecret: oauth.clientSecret,
      scope: opts.scope || oauth.scope,
      expiresAt,
      returnChatId,
    };
    const hash = await objects.putJSON({ kind: "mcp:OAuthPending", value: pending });
    await pointers.set(mcpOAuthPendingRef(state), hash);
    return {
      serverId: server.id,
      state,
      redirectUri,
      expiresAt,
      ...(returnChatId ? { returnChatId } : {}),
      authorizeUrl: addQuery(oauth.authorizationUrl, {
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: opts.scope || oauth.scope,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }),
    };
  },
  async completeLogin(state: string, code: string): Promise<McpOAuthStatus> {
    const cleanState = String(state || "").trim();
    const hash = cleanState ? await pointers.get(mcpOAuthPendingRef(cleanState)) : null;
    if (!hash) throw new Error("unknown or expired MCP OAuth state");
    const row = await objects.getJSON<McpOAuthPending>({ hash: hash });
    const pending = row?.value;
    if (!pending) throw new Error("invalid MCP OAuth state");
    if (pending.expiresAt < await time.nowMs()) {
      await pointers.delete(mcpOAuthPendingRef(cleanState));
      throw new Error("expired MCP OAuth state");
    }
    const response = await http.fetch({
      method: "POST",
      url: pending.tokenUrl,
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: formEncode({
        grant_type: "authorization_code",
        code: String(code || ""),
        redirect_uri: pending.redirectUri,
        client_id: pending.clientId,
        client_secret: pending.clientSecret,
        code_verifier: pending.codeVerifier,
      }),
      timeoutMs: 60_000,
    });
    await pointers.delete(mcpOAuthPendingRef(cleanState));
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`MCP OAuth token exchange failed with HTTP ${response.status}: ${response.body}`);
    }
    const token = parseMcpBody(response.body) as McpOAuthToken;
    if (!token?.access_token) throw new Error("MCP OAuth token response missing access_token");
    await saveMcpOAuthToken(pending.serverId, token);
    await clearMcpSessionId(pending.serverId);
    const status = await mcpCore.authStatus(pending.serverId);
    return pending.returnChatId ? { ...status, returnChatId: pending.returnChatId } : status;
  },
  async logout(serverId: string): Promise<boolean> {
    const clean = cleanMcpId(serverId);
    if (!clean) return false;
    await clearMcpSessionId(clean);
    return pointers.delete(mcpOAuthTokenRef(clean));
  },
  async authStatus(serverId: string): Promise<McpOAuthStatus> {
    const clean = cleanMcpId(serverId);
    if (!clean) throw new Error("invalid MCP server id");
    const token = await loadMcpOAuthToken(clean);
    return { serverId: clean, authenticated: !!token, expiresAt: token?.expires_at ?? null, scope: token?.scope ?? null };
  },
  async request<T = unknown>(serverId: string, method: string, params: unknown = {}, opts: McpRequestOptions = {}): Promise<T> {
    const server = await mcpCore.getServer(serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}`);
    if (server.enabled === false) throw new Error(`MCP server disabled: ${serverId}`);
    if (!opts.skipInitialize && method !== "initialize") {
      const session = await loadMcpSession(server.id);
      if (!session?.initializedAt) {
        await traces.mark("mcp.initialize.required", { serverId: server.id, method });
        await mcpCore.request(server.id, "initialize", mcpInitializeParams(), { skipInitialize: true, omitSession: true, timeoutMs: opts.timeoutMs });
      }
    }
    let token = await loadMcpOAuthToken(server.id);
    if (token) token = await refreshMcpOAuthToken(server, token);
    const headers = {
      Accept: "application/json, text/event-stream",
      ...(server.headers || {}),
      ...(token?.access_token ? { Authorization: `Bearer ${token.access_token}` } : {}),
    };
    const existingSessionId = (opts.omitSession || method === "initialize") ? null : await loadMcpSessionId(server.id);
    if (existingSessionId && !Object.keys(headers).some((k) => k.toLowerCase() === "mcp-session-id")) {
      headers["Mcp-Session-Id"] = existingSessionId;
    }
    const response = await http.fetch({
      method: "POST",
      url: mcpEndpoint(server),
      headers,
      body: {
        jsonrpc: "2.0",
        id: await id.new("mcp"),
        method,
        params,
      },
      timeoutMs: opts.timeoutMs ?? server.timeoutMs ?? 60_000,
    });
    const responseSessionId = headerValue(response.headers, "mcp-session-id");
    await traces.mark("mcp.http.response", {
      serverId: server.id,
      method,
      response,
      responseSessionId: responseSessionId ?? null,
      retryingSession: !!opts.retryingSession,
    });
    if (responseSessionId && method !== "initialize") await saveMcpSessionId(server.id, responseSessionId);
    if (response.status === 401 && server.oauth && !token) {
      throw new Error(`MCP ${server.id} requires OAuth login; run moo.mcp.login("${server.id}") from the UI or use the MCP settings Login button`);
    }
    if (isMcpSessionError(response.status, response.body) && !opts.retryingSession && method !== "initialize") {
      await traces.mark("mcp.session.retry", { serverId: server.id, method, status: response.status });
      await clearMcpSessionId(server.id);
      await mcpCore.request(server.id, "initialize", mcpInitializeParams(), { skipInitialize: true, omitSession: true, timeoutMs: opts.timeoutMs });
      return mcpCore.request<T>(server.id, method, params, { ...opts, retryingSession: true });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`MCP ${method} failed with HTTP ${response.status}: ${response.body}`);
    }
    const payload = parseMcpBody(response.body);
    await traces.mark("mcp.payload", {
      serverId: server.id,
      method,
      payload,
    });
    if (payload?.error) {
      throw new Error(payload.error.message || JSON.stringify(payload.error));
    }
    if (method === "initialize") await markMcpInitialized(server.id, responseSessionId);
    return payload?.result as T;
  },
  async listTools(serverId?: string): Promise<McpTool[]> {
    const servers = (serverId ? [await mcpCore.getServer(serverId)] : await mcpCore.listServers())
      .filter((server): server is McpServerConfig => !!server && server.enabled !== false);
    const results = await Promise.allSettled(servers.map(async (server) => {
      const result: any = await mcpCore.request(server.id, "tools/list", {}, { timeoutMs: Math.min(server.timeoutMs ?? 10_000, 10_000) });
      const tools: McpTool[] = [];
      for (const tool of result?.tools || []) {
        const name = String(tool.name || "");
        if (!name) continue;
        const inputSchema = tool.inputSchema ?? tool.input_schema ?? undefined;
        tools.push({
          serverId: server.id,
          server: server.id,
          name,
          title: tool.title ?? tool.annotations?.title ?? null,
          description: tool.description ?? null,
          denseDescription: denseMcpToolDescription(tool, inputSchema),
          inputSchema,
        });
      }
      return tools;
    }));
    const out: McpTool[] = [];
    const errors: string[] = [];
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      if (result.status === "fulfilled") out.push(...result.value);
      else errors.push(`${servers[i].id}: ${result.reason?.message || String(result.reason)}`);
    }
    if (serverId && errors.length) throw new Error(errors[0]);
    if (!out.length && errors.length) throw new Error(errors.join("; "));
    return out;
  },
  async callTool<T = unknown>(serverId: string, name: string, arguments_: unknown = {}): Promise<T> {
    return mcpCore.request<T>(serverId, "tools/call", { name, arguments: arguments_ ?? {} });
  },
};

function createMcpProxy(): Moo["mcp"] {
  const serverProxies = new Map<string, Record<string, unknown>>();
  const target = {
    list: () => mcpCore.listServers(),
    tools: (server?: string) => mcpCore.listTools(server),
    listServers: () => mcpCore.listServers(),
    getServer: (id: string) => mcpCore.getServer(id),
    saveServer: (config: McpServerConfig) => mcpCore.saveServer(config),
    removeServer: (id: string) => mcpCore.removeServer(id),
    login: (serverId: string, opts?: McpOAuthStartOptions) => mcpCore.login(serverId, opts),
    completeLogin: (state: string, code: string) => mcpCore.completeLogin(state, code),
    logout: (serverId: string) => mcpCore.logout(serverId),
    authStatus: (serverId: string) => mcpCore.authStatus(serverId),
    listTools: (serverId?: string) => mcpCore.listTools(serverId),
    callTool: <T = unknown>(serverId: string, name: string, arguments_?: unknown) =>
      mcpCore.callTool<T>(serverId, name, arguments_),
    request: <T = unknown>(serverId: string, method: string, params?: unknown) =>
      mcpCore.request<T>(serverId, method, params),
  };
  const getServerProxy = (serverId: string) => {
    let proxy = serverProxies.get(serverId);
    if (!proxy) {
      proxy = new Proxy({}, {
        get(_toolTarget, tool) {
          if (typeof tool !== "string") return undefined;
          if (tool === "then") return undefined;
          return (args?: unknown) => mcpCore.callTool(serverId, tool, args ?? {});
        },
      });
      serverProxies.set(serverId, proxy);
    }
    return proxy;
  };
  return new Proxy(target, {
    get(t, server) {
      if (typeof server !== "string") return undefined;
      if (server === "then") return undefined;
      if (server in t) return t[server as keyof typeof t];
      return getServerProxy(server);
    },
  }) as Moo["mcp"];
}

const mcp: Moo["mcp"] = createMcpProxy();

const events: Moo["events"] = {
  publish(payload) {
    const text =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    host.broadcast(text);
  },
};

const env: Moo["env"] = {
  async get(name) {
    return host.getEnv(name);
  },
  async getMany(names) {
    const out: Record<string, string | null> = {};
    for (const n of names) out[n] = host.getEnv(n);
    return out;
  },
};


function addOptionalTrailFact(
  txn: { add(args: { graph: string; subject: string; predicate: string; object: unknown }): void },
  graph: string,
  entryId: string,
  predicate: string,
  value: unknown,
): void {
  if (value == null) return;
  const text = String(value);
  txn.add({ graph, subject: entryId, predicate, object: text });
}

async function recordChatTrailEntry(
  chatId: string,
  kind: string,
  payload: Record<string, unknown>,
  opts: { touch?: boolean } = {},
): Promise<string> {
  if (!chatId) throw new Error("trail entry requires chatId");
  const factsRef = `chat/${chatId}/facts`;
  const graph = `chat:${chatId}`;
  const now = await time.nowMs();
  if (opts.touch) await chat.touch(chatId);
  const entryId = await id.new("trail");
  await facts.update({ store: factsRef, fn: (txn) => {
    txn.add({ graph: graph, subject: entryId, predicate: "rdf:type", object: "agent:TrailEntry" });
    txn.add({ graph: graph, subject: entryId, predicate: "agent:kind", object: kind });
    txn.add({ graph: graph, subject: entryId, predicate: "agent:createdBy", object: "agent:moo" });
    txn.add({ graph: graph, subject: entryId, predicate: "agent:createdAt", object: now });
    addOptionalTrailFact(txn, graph, entryId, "agent:title", payload.title);
    addOptionalTrailFact(txn, graph, entryId, "agent:body", payload.body);
    addOptionalTrailFact(txn, graph, entryId, "agent:summary", payload.summary);
  } });
  return entryId;
}

async function recordInputRequest(chatId: string, kind: string, spec: unknown): Promise<string> {
  const factsRef = `chat/${chatId}/facts`;
  const graph = `chat:${chatId}`;
  const reqId = await id.new("uireq");
  const payload = await objects.putJSON({ kind: kind, value: spec || {} });
  const now = await time.nowMs();
  await facts.update({ store: factsRef, fn: (txn) => {
    txn.add({ graph: graph, subject: reqId, predicate: "rdf:type", object: "ui:InputRequest" });
    txn.add({ graph: graph, subject: reqId, predicate: "ui:kind", object: kind });
    txn.add({ graph: graph, subject: reqId, predicate: "ui:status", object: "ui:Pending" });
    txn.add({ graph: graph, subject: reqId, predicate: "ui:payload", object: payload });
    txn.add({ graph: graph, subject: reqId, predicate: "ui:createdAt", object: now });
  } });
  return reqId;
}


const UI_FIELD_TYPES = new Set(["text", "textarea", "url", "number", "boolean", "select", "secretRef"]);

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateUiOption(option: unknown, path: string): void {
  if (typeof option === "string") return;
  if (!isRecord(option)) throw new Error(path + " must be a string or {label?, value?}");
  if (option.label != null && typeof option.label !== "string") throw new Error(path + ".label must be a string");
  if (option.value != null && typeof option.value !== "string") throw new Error(path + ".value must be a string");
}

function validateAskSpec(spec: unknown): UiAskSpec {
  if (!isRecord(spec)) throw new Error("moo.ui.ask spec must be an object");
  if (spec.title != null && typeof spec.title !== "string") throw new Error("moo.ui.ask spec.title must be a string");
  if (!Array.isArray(spec.fields) || spec.fields.length === 0) {
    throw new Error("moo.ui.ask spec.fields must be a non-empty array");
  }
  for (let i = 0; i < spec.fields.length; i++) {
    const field = spec.fields[i];
    const path = "moo.ui.ask spec.fields[" + i + "]";
    if (!isRecord(field)) throw new Error(path + " must be an object");
    if (typeof field.name !== "string" || field.name.length === 0) throw new Error(path + ".name must be a non-empty string");
    if (field.label != null && typeof field.label !== "string") throw new Error(path + ".label must be a string");
    if (field.type != null && (typeof field.type !== "string" || !UI_FIELD_TYPES.has(field.type))) {
      throw new Error(path + ".type must be one of " + Array.from(UI_FIELD_TYPES).join(", "));
    }
    if (field.required != null && typeof field.required !== "boolean") throw new Error(path + ".required must be a boolean");
    if (field.options != null) {
      if (!Array.isArray(field.options)) throw new Error(path + ".options must be an array");
      field.options.forEach((option: unknown, j: number) => validateUiOption(option, path + ".options[" + j + "]"));
    }
  }
  if (spec.submitLabel != null && typeof spec.submitLabel !== "string") throw new Error("moo.ui.ask spec.submitLabel must be a string");
  return spec as UiAskSpec;
}

function validateChooseSpec(spec: unknown): UiChooseSpec {
  if (!isRecord(spec)) throw new Error("moo.ui.choose spec must be an object");
  if (spec.title != null && typeof spec.title !== "string") throw new Error("moo.ui.choose spec.title must be a string");
  if (!Array.isArray(spec.items) || spec.items.length === 0) {
    throw new Error("moo.ui.choose spec.items must be a non-empty array");
  }
  for (let i = 0; i < spec.items.length; i++) {
    const item = spec.items[i];
    const path = "moo.ui.choose spec.items[" + i + "]";
    if (!isRecord(item)) throw new Error(path + " must be an object");
    if (typeof item.id !== "string" || item.id.length === 0) throw new Error(path + ".id must be a non-empty string");
    if (item.label != null && typeof item.label !== "string") throw new Error(path + ".label must be a string");
    if (item.description != null && typeof item.description !== "string") throw new Error(path + ".description must be a string");
  }
  return spec as UiChooseSpec;
}

const UI_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;

function cleanUiIdOrThrow(id: unknown): string {
  if (typeof id !== "string") throw new Error("ui id must be a string");
  const v = id.trim();
  if (!UI_ID_RE.test(v)) throw new Error("ui id must match /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/");
  return v;
}

async function uiManifestExists(uiId: string): Promise<boolean> {
  return !!(await pointers.get(`ui/${uiId}/manifest`));
}

const ui: Moo["ui"] = {
  async ask({ chatId, spec }) {
    return recordInputRequest(chatId, "ui:Form", validateAskSpec(spec));
  },
  async choose({ chatId, spec }) {
    return recordInputRequest(chatId, "ui:Choice", validateChooseSpec(spec));
  },
  async say({ chatId, text }) {
    const payload = await objects.putJSON({ kind: "agent:Reply", value: { text, at: await time.nowMs() } });
    const { stepId } = await appendStep(chatId, {
      kind: "agent:Reply",
      status: "agent:Done",
      payloadHash: payload,
      extras: [["agent:via", "ui:say"]],
    });
    return { chatId, stepId, payloadHash: payload };
  },
  apps: {
    async register({ id: inputId, manifest: inputManifest, bundle, handler = null }) {
      const id = cleanUiIdOrThrow(inputId ?? inputManifest.id);
      const title = String(inputManifest.title ?? id).trim() || id;
      const manifest: UiManifest = {
        ...inputManifest,
        id,
        title,
        description: inputManifest.description ?? "",
        icon: inputManifest.icon ?? "▣",
        entry: inputManifest.entry ?? "index.html",
        api: inputManifest.api ?? [],
      };
      const manifestHash = await objects.putJSON({ kind: "ui:Manifest", value: manifest });
      const bundleHash = await objects.putJSON({ kind: "ui:Bundle", value: bundle });
      await pointers.set(`ui/${id}/manifest`, manifestHash);
      await pointers.set(`ui/${id}/bundle`, bundleHash);
      let handlerHash: string | null = null;
      if (handler != null) {
        handlerHash = await objects.putText({ kind: "ui:Handler", text: String(handler) });
        await pointers.set(`ui/${id}/handler`, handlerHash);
      }
      await memory.assert({ facts: [
        [`ui:${id}`, "rdf:type", "ui:App"],
        [`ui:${id}`, "ui:title", title],
        [`ui:${id}`, "ui:manifest", manifestHash],
        [`ui:${id}`, "ui:bundle", bundleHash],
        [`ui:${id}`, "ui:updatedAt", term.datetime(new Date(await time.nowMs()).toISOString())],
        ...(manifest.description ? [[`ui:${id}`, "ui:description", String(manifest.description)] as [string, string, ObjectInput]] : []),
        ...(handlerHash ? [[`ui:${id}`, "ui:handler", handlerHash] as [string, string, ObjectInput]] : []),
      ] });
      return { uiId: id, ui: manifest, manifestHash, bundleHash, handlerHash, refs: { manifest: `ui/${id}/manifest`, bundle: `ui/${id}/bundle`, ...(handlerHash ? { handler: `ui/${id}/handler` } : {}) } };
    },
    async open({ chatId, uiId: inputUiId, instanceId: inputInstanceId = null, state = {} }) {
      const uiId = cleanUiIdOrThrow(inputUiId);
      if (!(await uiManifestExists(uiId))) throw new Error(`ui not found: ${uiId}`);
      const c = chatRefs(chatId);
      let instanceId = typeof inputInstanceId === "string" && inputInstanceId.trim()
        ? inputInstanceId.trim().replace(/^uiinst:/, "")
        : null;
      if (!instanceId) {
        const existing = await facts.matchAll({
          patterns: [
            ["?inst", "rdf:type", "ui:Instance"],
            ["?inst", "ui:app", `ui:${uiId}`],
          ],
          store: c.facts,
          graph: c.graph,
          limit: 1,
        });
        instanceId = existing[0]?.["?inst"]?.replace(/^uiinst:/, "") ?? (await id.new("uiinst"));
      }
      const inst = `uiinst:${instanceId}`;
      const primaryRows = await facts.match({
        store: c.facts,
        graph: c.graph,
        subject: `chat:${chatId}`,
        predicate: "ui:primary",
      });
      const factReceipt = await facts.update({ store: c.facts, fn: (txn) => {
        for (const [graph, subject, predicate, object] of primaryRows) {
          txn.remove({ graph, subject, predicate, object });
        }
        txn.add({ graph: c.graph, subject: `chat:${chatId}`, predicate: "ui:involves", object: `ui:${uiId}` });
        txn.add({ graph: c.graph, subject: `chat:${chatId}`, predicate: "ui:primary", object: `ui:${uiId}` });
        txn.add({ graph: c.graph, subject: inst, predicate: "rdf:type", object: "ui:Instance" });
        txn.add({ graph: c.graph, subject: inst, predicate: "ui:app", object: `ui:${uiId}` });
        txn.add({ graph: c.graph, subject: inst, predicate: "ui:chat", object: `chat:${chatId}` });
        txn.add({ graph: c.graph, subject: inst, predicate: "ui:statePointer", object: `pointer:uiinst/${instanceId}/state` });
      } });
      const stateRef = `uiinst/${instanceId}/state`;
      let stateTarget = await pointers.get(stateRef);
      let createdState = false;
      if (!stateTarget) {
        stateTarget = encodeJsonPointer(state ?? {});
        await pointers.set(stateRef, stateTarget);
        createdState = true;
      }
      events.publish({ kind: "ui-open", chatId, uiId, instanceId, stateRef, stateTarget, at: await time.nowMs() });
      return { chatId, uiId, instanceId, stateTarget, stateRef, createdState, facts: factReceipt };
    },
  },
};

type ChatUsageSummary = {
  models: Record<string, { input: number; cachedInput: number; cacheWriteInput?: number; output: number }>;
  lastContextTokens?: number;
  lastCompactionPromptTokens?: number;
};

function normalizeChatUsageSummary(value: unknown): ChatUsageSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = value as Partial<ChatUsageSummary>;
  usage.models = usage.models && typeof usage.models === "object" && !Array.isArray(usage.models) ? usage.models : {};
  return usage as ChatUsageSummary;
}

async function readChatUsagePointerTarget(target: string | null | undefined): Promise<ChatUsageSummary | null> {
  if (!target) return null;
  return normalizeChatUsageSummary(decodeJsonPointer<ChatUsageSummary>(target));
}

type ChatFactsSummary = {
  totalFacts: number;
  totalTurns: number;
  totalSteps: number;
  status: string;
};

type CachedChatFactsSummary = ChatFactsSummary & {
  factsCount: number;
};

const chatFactsSummaryCache = new Map<string, CachedChatFactsSummary>();

function invalidateChatFactsSummary(store: string): void {
  const m = /^chat\/([^/]+)\/facts$/.exec(String(store || ""));
  if (m) chatFactsSummaryCache.delete(m[1]!);
}

async function summarizeAllChatFacts(): Promise<Map<string, ChatFactsSummary>> {
  const raw = JSON.parse(host.chatFactSummaries()) as Record<string, ChatFactsSummary | undefined>;
  const summaries = new Map<string, ChatFactsSummary>();
  for (const [chatId, summary] of Object.entries(raw)) {
    if (!summary) continue;
    const cached = {
      factsCount: Number(summary.totalFacts || 0),
      totalFacts: Number(summary.totalFacts || 0),
      totalTurns: Number(summary.totalTurns || 0),
      totalSteps: Number(summary.totalSteps || 0),
      status: String(summary.status || "agent:Done"),
    };
    chatFactsSummaryCache.set(chatId, cached);
    summaries.set(chatId, cached);
  }
  return summaries;
}

function emptyChatFactsSummary(): ChatFactsSummary {
  return {
    totalFacts: 0,
    totalTurns: 0,
    totalSteps: 0,
    status: "agent:Done",
  };
}

async function summarizeChatFacts(chatId: string): Promise<ChatFactsSummary> {
  const store = `chat/${chatId}/facts`;
  const graph = `chat:${chatId}`;
  const totalFacts = await facts.count({ store });
  const cached = chatFactsSummaryCache.get(chatId);
  if (cached && cached.factsCount === totalFacts) {
    return {
      totalFacts: cached.totalFacts,
      totalTurns: cached.totalTurns,
      totalSteps: cached.totalSteps,
      status: cached.status,
    };
  }

  const [turnRows, pendingInputs, stepRows] = await Promise.all([
    facts.match({ store, ...{
      graph,
      predicate: "agent:kind",
      object: "agent:UserInput",
    } }),
    facts.matchAll({ patterns: [
        ["?req", "rdf:type", "ui:InputRequest"],
        ["?req", "ui:status", "ui:Pending"],
      ], ...{ store, graph, limit: 1 } }),
    facts.matchAll({ patterns: [
        ["?step", "rdf:type", "agent:Step"],
        ["?step", "agent:status", "?status"],
        ["?step", "agent:createdAt", "?at"],
      ], ...{ store, graph } }),
  ]);

  let status = "agent:Done";
  if (pendingInputs.length > 0) {
    status = "ui:Pending";
  } else if (stepRows.some((s) => s["?status"] === "agent:Running")) {
    status = "agent:Running";
  } else if (stepRows.some((s) => s["?status"] === "agent:Queued")) {
    status = "agent:Queued";
  } else {
    const latest = stepRows
      .map((s) => ({ status: s["?status"] || "agent:Done", at: Number(s["?at"] || 0) }))
      .sort((a, b) => b.at - a.at)[0];
    status = latest?.status || "agent:Done";
  }

  const summary = {
    factsCount: totalFacts,
    totalFacts,
    totalTurns: turnRows.length,
    totalSteps: stepRows.length,
    status,
  };
  chatFactsSummaryCache.set(chatId, summary);
  return summary;
}
function joinPath(base: string, child: string): string {
  const b = String(base || ".").replace(/\/+$/, "") || ".";
  return b + "/" + child.replace(/^\/+/, "");
}

async function chatScratchRoot(chatId: string): Promise<string | null> {
  return await pointers.get(`chat/${chatId}/path`);
}

async function chatWorktreePath(chatId: string): Promise<string> {
  const home = ((await env.get("HOME")) || "").trim();
  const base = home ? joinPath(home, "moo") : "moo";
  return joinPath(base, chatId);
}

const canonicalDirCache = new Map<string, Promise<string>>();

async function canonicalDir(path: string): Promise<string> {
  let promise = canonicalDirCache.get(path);
  if (!promise) {
    promise = (async () => {
      try {
        return await fs.canonical(path);
      } catch (_) {
        return path;
      }
    })();
    canonicalDirCache.set(path, promise);
  }
  return await promise;
}

function forgetCanonicalDir(path: string) {
  canonicalDirCache.delete(path);
}

const chat: Moo["chat"] = {
  async refs({ chatId }) {
    const c = chatRefs(chatId);
    return {
      chatId,
      facts: c.facts,
      factsRef: c.facts,
      head: c.head,
      run: c.run,
      createdAt: c.createdAt,
      lastAt: c.lastAt,
      compaction: c.compaction,
      usage: c.usage,
      model: c.model,
      provider: (c as any).provider ?? `chat/${chatId}/provider`,
      effort: c.effort,
      graph: c.graph,
      chatIri: c.graph,
      stateRefPrefix: "uiinst/",
      headRef: c.head,
      runRef: c.run,
      createdAtRef: c.createdAt,
      lastAtRef: c.lastAt,
      compactionRef: c.compaction,
      usageRef: c.usage,
      modelRef: c.model,
      effortRef: c.effort,
      startBranch: (c as any).startBranch ?? `chat/${chatId}/start-branch`,
      startBranchRef: (c as any).startBranch ?? `chat/${chatId}/start-branch`,
    };
  },
  async scratch(chatId) {
    const root = await chatScratchRoot(chatId);
    const path = await chatWorktreePath(chatId);
    if (await fs.exists(path)) return await canonicalDir(path);
    const parentPath = path.split("/").slice(0, -1).join("/") || ".";
    await fs.ensureDir(parentPath);
    // Repo-less chats deliberately have no checkout root. Give them an empty
    // per-chat scratch directory instead of treating "." as an implicit repo.
    if (!root) {
      await fs.ensureDir(path);
      return await canonicalDir(path);
    }
    // If the cwd is a JJ repo, prefer a real `jj workspace add` so the agent
    // gets an isolated checkout/workspace. Fall back to Git worktrees or a
    // plain mkdir when repo-specific workspace creation fails.
    if (await fs.exists(joinPath(root, ".jj"))) {
      const startRevision = (await pointers.get(`chat/${chatId}/start-branch`))?.trim() || "@";
      let result = await proc.run({ cmd: "jj", args: ["workspace", "add", "--quiet", "--revision", startRevision, path], ...{ cwd: root, timeoutMs: 10_000 } });
      if (result.code !== 0 && startRevision !== "@") {
        result = await proc.run({ cmd: "jj", args: ["workspace", "add", "--quiet", "--revision", "@", path], ...{ cwd: root, timeoutMs: 10_000 } });
      }
      if (result.code === 0) return await canonicalDir(path);
    }
    // If the cwd is a git repo, prefer a real `git worktree add` from the
    // selected start branch (or HEAD) so the agent gets per-chat diffs and
    // clean state.
    if (await fs.exists(joinPath(root, ".git"))) {
      const startBranch = (await pointers.get(`chat/${chatId}/start-branch`))?.trim() || "HEAD";
      let result = await proc.run({ cmd: "git", args: ["worktree", "add", "--quiet", "--detach", path, startBranch], ...{ cwd: root, timeoutMs: 10_000 } });
      if (result.code !== 0 && startBranch !== "HEAD") {
        result = await proc.run({ cmd: "git", args: ["worktree", "add", "--quiet", "--detach", path, "HEAD"], ...{ cwd: root, timeoutMs: 10_000 } });
      }
      if (result.code === 0) return await canonicalDir(path);
    }
    await fs.ensureDir(path);
    return await canonicalDir(path);
  },
  async touch(chatId) {
    const createdRef = `chat/${chatId}/created-at`;
    const existing = await pointers.get(createdRef);
    if (!existing) {
      await pointers.set(createdRef, String(await time.nowMs()));
    }
    await pointers.set(`chat/${chatId}/last-at`, String(await time.nowMs()));
  },
  async list() {
    const all = await pointers.entries("chat/");
    const ids = new Set<string>();
    const byChat = new Map<string, Record<string, string>>();
    for (const [name, target] of all) {
      const parts = name.split("/");
      if (parts.length < 3) continue;
      const cid = parts[1]!;
      ids.add(cid);
      const key = parts.slice(2).join("/");
      let refsForChat = byChat.get(cid);
      if (!refsForChat) {
        refsForChat = {};
        byChat.set(cid, refsForChat);
      }
      refsForChat[key] = target;
    }
    const allSummaries = await summarizeAllChatFacts();
    const chats = await Promise.all(
      Array.from(ids, async (cid) => {
        const refsForChat = byChat.get(cid) || {};
        const created = refsForChat["created-at"] || null;
        const lastAt = refsForChat["last-at"] || null;
        const head = refsForChat["head"] || null;
        const title = refsForChat["title"] || null;
        const path = refsForChat["path"] || null;
        const archivedRaw = refsForChat["archived-at"] || null;
        const hiddenRaw = refsForChat["hidden"] || null;
        const parentChatId = refsForChat["parent"] || null;
        const usage = await readChatUsagePointerTarget(refsForChat["usage"] || null);
        // host.chatFactSummaries() already summarizes every existing
        // chat/<id>/facts store in one host-side pass. Pointer-only chats (for
        // example an empty chat that has been created but not messaged yet)
        // legitimately have no fact store, so avoid falling back to several
        // per-chat fact scans for every such sidebar entry on startup.
        const summary = allSummaries.get(cid) || emptyChatFactsSummary();
        const archivedAt = archivedRaw ? Number(archivedRaw) : null;
        // Keep chat listing metadata-only. Checking every possible worktree path
        // hits the filesystem for each chat and can dominate initial UI load in
        // repos with many chats. chat.scratch() still resolves/creates the path
        // lazily when code actually needs it, and chat-new returns it when a new
        // chat is explicitly materialized.
        const worktreePath = null;
        return {
          chatId: cid,
          title: title || null,
          createdAt: created ? Number(created) : 0,
          lastAt: lastAt ? Number(lastAt) : created ? Number(created) : 0,
          head: head || null,
          path,
          worktreePath,
          archived: archivedAt != null,
          archivedAt,
          hidden: hiddenRaw === "true",
          parentChatId,
          totalFacts: summary.totalFacts,
          totalTurns: summary.totalTurns,
          totalSteps: summary.totalSteps,
          status: summary.status,
          usage,
        };
      }),
    );

    const byId = new Map(chats.map((c) => [c.chatId, c]));
    function ensureUsage(chat: any) {
      if (!chat.usage) chat.usage = { models: {} };
      return chat.usage as { models: Record<string, { input: number; cachedInput: number; cacheWriteInput?: number; output: number }> };
    }
    function nearestVisibleAncestor(chat: any): any | null {
      const seen = new Set<string>();
      let current = chat;
      while (current?.parentChatId && !seen.has(current.parentChatId)) {
        seen.add(current.parentChatId);
        const parent = byId.get(current.parentChatId);
        if (!parent) return null;
        if (!parent.hidden) return parent;
        current = parent;
      }
      return null;
    }
    for (const child of chats) {
      if (!child.hidden || !child.usage?.models) continue;
      const parent = nearestVisibleAncestor(child);
      if (!parent) continue;
      const parentUsage = ensureUsage(parent);
      for (const [model, counts] of Object.entries(child.usage.models)) {
        const slot = parentUsage.models[model] ?? { input: 0, cachedInput: 0, cacheWriteInput: 0, output: 0 };
        if (slot.cacheWriteInput == null) slot.cacheWriteInput = 0;
        slot.input += Number(counts.input ?? 0);
        slot.cachedInput += Number(counts.cachedInput ?? 0);
        slot.cacheWriteInput += Number(counts.cacheWriteInput ?? 0);
        slot.output += Number(counts.output ?? 0);
        parentUsage.models[model] = slot;
      }
      parent.childUsageIncluded = (Number(parent.childUsageIncluded) || 0) + 1;
    }

    return chats.sort((a, b) => (b.lastAt || b.createdAt || 0) - (a.lastAt || a.createdAt || 0));
  },
  async create(chatId, path = null, opts = {}) {
    let cid = chatId;
    if (!cid) {
      const raw = await id.new("chat");
      // Host ids are `chat:<nanoid-ish payload>`; chat metadata stores just the payload.
      cid = raw.replace(/^chat:/, "");
    }
    if (path && String(path).trim()) {
      await pointers.set(`chat/${cid}/path`, String(path).trim());
    }
    if (opts.branch && String(opts.branch).trim()) {
      await pointers.set(`chat/${cid}/start-branch`, String(opts.branch).trim());
    }
    await chat.touch(cid);
    // Do not materialize the per-chat scratch/worktree during creation.
    // Creating a git worktree can be slow in large repositories, and the UI
    // only needs the chat metadata to navigate to an empty chat. The worktree
    // is still created lazily by chat.scratch() before any repo operation or
    // agent run that actually needs it.
    return cid;
  },
  async remove(chatId) {
    if (!chatId) throw new Error("remove requires chatId");
    const root = await chatScratchRoot(chatId);
    const path = await chatWorktreePath(chatId);
    forgetCanonicalDir(path);
    // If this scratch was set up as a git worktree, the directory contains a
    // .git *file* (not a dir) pointing back at the main repo. Clean it via
    // the git CLI so we don't leave dangling worktree metadata.
    const gitFile = await fs.stat(`${path}/.git`);
    if (gitFile && gitFile.kind === "file") {
      await proc.run({ cmd: "git", args: ["worktree", "remove", "--force", path], timeoutMs: 10_000 });
    } else if (await fs.exists(path)) {
      await proc.run({ cmd: "rm", args: ["-rf", path], timeoutMs: 10_000 });
    }
    const all = await pointers.list(`chat/${chatId}/`);
    let clearedQuads = 0;
    for (const name of all) {
      if (name.endsWith("/facts")) {
        clearedQuads += (await facts.deleteStore({ store: name })).removed;
      }
      await pointers.delete(name);
    }
    clearedQuads += (await facts.deleteStore({ store: `chat/${chatId}/facts` })).removed;
    return { chatId, refsDeleted: all.length, quadsCleared: clearedQuads };
  },
  async setTitle({ chatId, title, manual }: { chatId: string; title: string | null; manual?: boolean }) {
    const ref = `chat/${chatId}/title`;
    const manualRef = `chat/${chatId}/title-manual`;
    const previousTitle = await pointers.get(ref);
    const nextTitle = title == null || title.trim() === "" ? null : title.trim();
    const manualTitle = await pointers.get(manualRef);
    if (!manual && manualTitle && (previousTitle || null) === manualTitle && nextTitle !== manualTitle) {
      return { chatId, previousTitle: previousTitle || null, title: previousTitle || null, changed: false };
    }
    if (nextTitle == null) {
      await pointers.delete(ref);
      if (manual) await pointers.delete(manualRef);
    } else {
      await pointers.set(ref, nextTitle);
      if (manual) await pointers.set(manualRef, nextTitle);
    }
    const changed = (previousTitle || null) !== nextTitle;
    if (changed) {
      await recordChatTrailEntry(chatId, "agent:TitleUpdate", {
        title: nextTitle,
      });
    }
    return { chatId, previousTitle: previousTitle || null, title: nextTitle, changed };
  },
  async recordSummary({ chatId, summary, title }) {
    const targetChatId = String(chatId || activeChatId || "").trim();
    if (!targetChatId) throw new Error("recordSummary requires chatId outside a chat context");
    const body = String(summary ?? "").trim();
    if (!body) throw new Error("recordSummary requires a non-empty summary");
    const cleanTitle = String(title ?? "").trim();
    if (!cleanTitle) throw new Error("recordSummary requires a non-empty title");
    const entryId = await recordChatTrailEntry(targetChatId, "agent:Summary", {
      title: cleanTitle,
      body,
    }, { touch: true });
    return { chatId: targetChatId, entryId, title: cleanTitle };
  },
  async archive(chatId) {
    const at = String(await time.nowMs());
    await pointers.set(`chat/${chatId}/archived-at`, at);
    return Number(at);
  },
  async unarchive(chatId) {
    await pointers.delete(`chat/${chatId}/archived-at`);
    return null;
  },
};

const MAX_SUBAGENT_DEPTH = 1;
const MAX_OUTSTANDING_SUBAGENTS_PER_RUNJS = 4;
const DEFAULT_SUBAGENT_STEPS = 20;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60_000;
const MAX_SUBAGENT_TIMEOUT_MS = 30 * 60_000;

type NormalizedSubagentSpec = Required<Pick<SubagentSpec, "label" | "task" | "worktree">> & Omit<SubagentSpec, "label" | "task" | "worktree"> & {
  maxSteps: number;
  timeoutMs: number;
};

function normalizeSubagentSpec(spec: SubagentSpec): NormalizedSubagentSpec {
  if (!spec || typeof spec !== "object") throw new Error("moo.agent.run requires a spec object");
  const label = String(spec.label ?? "").trim();
  const task = String(spec.task ?? "").trim();
  if (!label) throw new Error("moo.agent.run requires spec.label");
  if (!task) throw new Error("moo.agent.run requires spec.task");
  const maxSteps = Math.max(1, Math.floor(Number(spec.maxSteps ?? DEFAULT_SUBAGENT_STEPS) || DEFAULT_SUBAGENT_STEPS));
  const timeoutMs = Math.max(1_000, Math.min(MAX_SUBAGENT_TIMEOUT_MS, Math.floor(Number(spec.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS) || DEFAULT_SUBAGENT_TIMEOUT_MS)));
  const worktree = spec.worktree === "inherit" ? "inherit" : "isolated";
  return {
    ...spec,
    label,
    task,
    maxSteps,
    timeoutMs,
    worktree,
    ...(typeof spec.context === "string" && spec.context.trim() ? { context: spec.context } : {}),
    ...(typeof spec.expectedOutput === "string" && spec.expectedOutput.trim() ? { expectedOutput: spec.expectedOutput } : {}),
    ...(typeof spec.model === "string" && spec.model.trim() ? { model: spec.model.trim() } : {}),
    ...(typeof spec.effort === "string" && spec.effort.trim() ? { effort: spec.effort.trim() } : {}),
  };
}

function statusForSubagentResult(status: string): "agent:Done" | "agent:Failed" | "agent:Cancelled" {
  if (status === "done") return "agent:Done";
  if (status === "cancelled") return "agent:Cancelled";
  return "agent:Failed";
}

type LegacySubagentResult = SubagentResult & { text?: unknown };

function normalizeSubagentResult(result: LegacySubagentResult): SubagentResult {
  const output = typeof result.output === "string"
    ? result.output
    : typeof result.text === "string"
      ? result.text
      : "";
  const normalized = { ...result, output } as SubagentResult & { text?: unknown };
  delete normalized.text;
  return normalized;
}

function truncateTitle(title: string): string {
  const t = String(title || "subagent").replace(/\s+/g, " ").trim() || "subagent";
  return t.length <= 60 ? t : t.slice(0, 57).trimEnd() + "…";
}

async function replaceStepStatus(chatId: string, stepId: string, status: string, extras: Array<[string, string]> = []) {
  const c = chatRefs(chatId);
  const cur = await facts.match({ store: c.facts, ...{ graph: c.graph, subject: stepId, predicate: "agent:status" } });
  await facts.update({ store: c.facts, fn: (txn) => {
    for (const [g, s, p, o] of cur) txn.remove({ graph: g, subject: s, predicate: p, object: o });
    txn.add({ graph: c.graph, subject: stepId, predicate: "agent:status", object: status });
    for (const [p, o] of extras) txn.add({ graph: c.graph, subject: stepId, predicate: p, object: o });
  } });
}

async function markOutstandingSubagentCancelled(parentChatId: string, childChatId: string, error: string) {
  const stepId = await pointers.get(`chat/${childChatId}/parent-step`);
  if (!stepId) return;
  const result: SubagentResult = {
    status: "cancelled",
    childChatId,
    output: "",
    error,
    durationNs: 0,
  };
  const resultHash = await objects.putJSON({ kind: "agent:ToolResult", value: result });
  await replaceStepStatus(parentChatId, stepId, "agent:Cancelled", [["agent:result", resultHash], ["agent:error", error]]);
}

async function createSubagentRunRequest(spec: NormalizedSubagentSpec) {
  const ctx = activeRunJSContext;
  if (!ctx) throw new Error("moo.agent.run is only available inside runJS");
  if (ctx.depth >= MAX_SUBAGENT_DEPTH) throw new Error("subagent depth limit reached");
  if (ctx.outstanding.size >= MAX_OUTSTANDING_SUBAGENTS_PER_RUNJS) {
    throw new Error(`too many outstanding subagents; max is ${MAX_OUTSTANDING_SUBAGENTS_PER_RUNJS}`);
  }

  const parentChatId = ctx.chatId;
  const parentRoot = await pointers.get(`chat/${parentChatId}/path`);
  const childChatId = await chat.create(undefined, parentRoot);
  await chat.setTitle({ chatId: childChatId, title: truncateTitle(spec.label) });
  await pointers.set(`chat/${childChatId}/hidden`, "true");
  await pointers.set(`chat/${childChatId}/parent`, parentChatId);
  await pointers.set(`chat/${childChatId}/subagent-depth`, String(ctx.depth + 1));
  await pointers.set(`chat/${childChatId}/subagent-parent-runjs`, ctx.runJsStepId);
  await applyDefaultChatSettings(childChatId);
  if (spec.model) await pointers.set(chatRefs(childChatId).model, spec.model);
  if (spec.effort) await pointers.set(chatRefs(childChatId).effort, spec.effort);

  const specHash = await objects.putJSON({ kind: "agent:SubagentSpec", value: spec });
  await pointers.set(`chat/${childChatId}/subagent-spec`, specHash);

  const payloadHash = await objects.putJSON({ kind: "agent:Subagent", value: {
    label: spec.label,
    task: spec.task,
    context: spec.context ?? null,
    expectedOutput: spec.expectedOutput ?? null,
    childChatId,
    parentRunJsStepId: ctx.runJsStepId,
  } });
  const appended = await appendStep(parentChatId, {
    kind: "agent:Subagent",
    status: "agent:Running",
    payloadHash,
    extras: [
      ["agent:childChat", childChatId],
      ["agent:parentRunJS", ctx.runJsStepId],
    ],
  });
  await pointers.set(`chat/${childChatId}/parent-step`, appended.stepId);
  ctx.outstanding.add(childChatId);

  if (spec.worktree === "inherit") {
    // Never share writable dirs. For now inherit only selects the same repo root;
    // the child still gets its own lazy git worktree from chat.scratch().
    await pointers.set(`chat/${childChatId}/worktree-mode`, "inherit");
  }

  return {
    requestId: await id.new("subagent"),
    parentChatId,
    parentRunJsStepId: ctx.runJsStepId,
    parentSubagentStepId: appended.stepId,
    childChatId,
    spec,
    limits: {
      maxSteps: spec.maxSteps,
      timeoutMs: spec.timeoutMs,
      depth: ctx.depth + 1,
    },
  };
}

async function finishSubagentRun(childChatId: string, result: SubagentResult) {
  result = normalizeSubagentResult(result as LegacySubagentResult);
  const ctx = activeRunJSContext;
  const parentChatId = ctx?.chatId || (await pointers.get(`chat/${childChatId}/parent`));
  const stepId = await pointers.get(`chat/${childChatId}/parent-step`);
  if (ctx) ctx.outstanding.delete(childChatId);
  if (!parentChatId || !stepId) return;
  const resultHash = await objects.putJSON({ kind: "agent:ToolResult", value: result });
  const extras: Array<[string, string]> = [["agent:result", resultHash]];
  if (result.error) extras.push(["agent:error", String(result.error)]);
  await replaceStepStatus(parentChatId, stepId, statusForSubagentResult(result.status), extras);
}

async function failSubagentRun(childChatId: string | null, err: unknown) {
  if (!childChatId) return;
  const message = (err as any)?.message || String(err);
  const result: SubagentResult = {
    status: "failed",
    childChatId,
    output: "",
    error: message,
    durationNs: 0,
  };
  await finishSubagentRun(childChatId, result);
}

const agent: Moo["agent"] = {
  async claim(store, graph, runId, leaseMs = 60_000) {
    const queued = await facts.match({ store, ...{
      graph,
      predicate: "agent:status",
      object: "agent:Queued",
    } });
    for (const [, stepId] of queued) {
      if (runId) {
        const runRows = await facts.match({ store, ...{
          graph,
          subject: stepId,
          predicate: "agent:run",
          limit: 1,
        } });
        if (runRows.length && runRows[0]![3] !== runId) continue;
      }
      const leaseId = await id.new("lease");
      const expiresAt = (await time.nowMs()) + leaseMs;
      await facts.update({ store, fn: (txn) => {
        txn.remove({ graph: graph, subject: stepId, predicate: "agent:status", object: "agent:Queued" });
        txn.add({ graph: graph, subject: stepId, predicate: "agent:status", object: "agent:Running" });
        txn.add({ graph: graph, subject: stepId, predicate: "agent:lease", object: leaseId });
        txn.add({ graph: graph, subject: leaseId, predicate: "agent:expiresAt", object: String(expiresAt) });
      } });
      return { stepId, leaseId, expiresAt };
    }
    return null;
  },
  async complete(store, graph, stepId, status = "agent:Done") {
    const cur = await facts.match({ store, ...{
      graph,
      subject: stepId,
      predicate: "agent:status",
    } });
    await facts.update({ store, fn: (txn) => {
      for (const [g, s, p, o] of cur) txn.remove({ graph: g, subject: s, predicate: p, object: o });
      txn.add({ graph: graph, subject: stepId, predicate: "agent:status", object: status });
    } });
  },
  async fork(chatId, fromStepId = null) {
    const c = {
      facts: `chat/${chatId}/facts`,
      run: `chat/${chatId}/run`,
      graph: `chat:${chatId}`,
      head: `chat/${chatId}/head`,
    };
    const runId = await id.new("run");
    const forkedFrom = fromStepId ?? (await pointers.get(c.head));
    await pointers.set(c.run, runId);
    await facts.update({ store: c.facts, fn: (txn) => {
      txn.add({ graph: c.graph, subject: runId, predicate: "rdf:type", object: "agent:Run" });
      txn.add({ graph: c.graph, subject: runId, predicate: "agent:chat", object: c.graph });
      txn.add({ graph: c.graph, subject: runId, predicate: "agent:createdBy", object: "agent:moo" });
      if (forkedFrom) txn.add({ graph: c.graph, subject: runId, predicate: "agent:forkedFrom", object: forkedFrom });
    } });
    return { chatId, runId, forkedFrom };
  },
  async run(spec: SubagentSpec): Promise<SubagentResult> {
    const normalized = normalizeSubagentSpec(spec);
    let request: Awaited<ReturnType<typeof createSubagentRunRequest>> | null = null;
    try {
      request = await createSubagentRunRequest(normalized);
      const raw = await host.runAgent(JSON.stringify(request));
      const result = normalizeSubagentResult(JSON.parse(raw) as LegacySubagentResult);
      await finishSubagentRun(request.childChatId, result);
      return result;
    } catch (err) {
      await failSubagentRun(request?.childChatId ?? null, err);
      throw err;
    }
  },
};

// -- cross-chat memory + vocabulary ---------------------------------------
//
// Memory is plain RDF: every fact is a (subject, predicate, object) triple
// stored in graph `memory:facts` under ref `memory/facts`. No envelope
// objects — the LLM writes triples directly.
//
// Vocabulary lives in graph `vocab:facts` under `vocab/facts`. Each declared
// predicate is a subject of type `vocab:Predicate` with rdfs:label,
// vocab:description, and vocab:example annotations. `vocab.list()` merges
// declared metadata with usage counts gathered from the memory graph, so the
// LLM can ask "which verbs exist?" before guessing one.

const MEMORY_REF = "memory/facts";
const MEMORY_GRAPH = "memory:facts";
const PROJECT_MEMORY_REF_PREFIX = "memory/project/";
const PROJECT_MEMORY_GRAPH_PREFIX = "memory:project/";
const ALLOWED_MEMORY_KINDS = new Set([
  "memory:Note",
  "memory:Preference",
  "memory:Decision",
  "memory:Summary",
  "memory:Observation",
]);
function validateMemoryKind(subject: string, predicate: string, object: ObjectInput) {
  const value = object instanceof Term ? object.turtle : String(object);
  if ((predicate === "rdf:type" || predicate === "a") && value.startsWith("memory:") && !ALLOWED_MEMORY_KINDS.has(value)) {
    throw new Error(`unknown memory kind ${value}; use one of ${[...ALLOWED_MEMORY_KINDS].join(", ")}`);
  }
  if (subject.startsWith("memory:") && !ALLOWED_MEMORY_KINDS.has(subject) && !subject.startsWith("memory:item/")) {
    throw new Error(`unknown memory subject template ${subject}`);
  }
}
function encodeProjectMemoryId(projectId: string): string {
  const trimmed = projectId.trim();
  if (!trimmed) throw new Error("project memory id cannot be empty");
  return encodeURIComponent(trimmed).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
async function currentProjectMemoryId(): Promise<string> {
  const git = await proc.run({ cmd: "git", args: ["rev-parse", "--show-toplevel"], ...{ timeoutMs: 2_000 } });
  if (git.code === 0 && git.stdout.trim()) return git.stdout.trim();
  const pwd = await env.get("PWD");
  if (pwd && pwd.trim()) return pwd.trim();
  return ".";
}
function memoryScope(store: string, graph: string): MemoryScope {
  function encodeMemoryFacts(factsInput: unknown, validate: boolean): Array<[string, string, string]> {
    const seen = new Set<string>();
    const encoded: Array<[string, string, string]> = [];
    for (const [subject, predicate, object] of Array.isArray(factsInput) ? unpackMemoryFacts(factsInput) : unpackMemoryWriteArgs(factsInput)) {
      if (validate) validateMemoryKind(subject, predicate, object);
      const value = encodeObject(object);
      const key = JSON.stringify([subject, predicate, value]);
      if (seen.has(key)) continue;
      seen.add(key);
      encoded.push([subject, predicate, value]);
    }
    return encoded;
  }

  async function applyAll(action: "assert" | "retract", factsInput: unknown): Promise<void> {
    const encoded = encodeMemoryFacts(factsInput, action === "assert");
    if (encoded.length === 0) return;
    const quads: Quad[] = encoded.map(([subject, predicate, object]) => [graph, subject, predicate, object]);
    assertFactObjects(quads);
    const present = host.factsPresent(store, JSON.stringify(quads));
    const changedQuads: Quad[] = [];
    const changes: MemoryChange[] = [];
    for (let i = 0; i < quads.length; i++) {
      const shouldChange = action === "assert" ? !present[i] : present[i];
      if (!shouldChange) continue;
      const quad = quads[i]!;
      changedQuads.push(quad);
      changes.push({ subject: quad[1], predicate: quad[2], object: quad[3] });
    }
    if (changedQuads.length === 0) return;
    if (action === "assert") {
      await facts.swap({ store, removes: [], adds: changedQuads });
    } else {
      await facts.swap({ store, removes: changedQuads, adds: [] });
    }
    await recordMemoryDiff(store, graph, action, changes);
  }


  return {
    async assert(args) {
      return applyAll("assert", args);
    },
    async retract(args) {
      return applyAll("retract", args);
    },
    async query(patterns, opts) {
      const encoded: Triple[] = patterns.map(([s, p, o]) => [
        s as string,
        p as string,
        typeof o === "string" && o.startsWith("?")
          ? o
          : encodeObject(o as ObjectInput),
      ]);
      return facts.matchAll({ patterns: encoded, ...{
        store,
        graph,
        ...(opts?.limit ? { limit: opts.limit } : {}),
      } });
    },
    async triples(opts) {
      return facts.match({ store, ...{
        graph,
        subject: opts?.subject ?? null,
        predicate: opts?.predicate ?? null,
        object: opts?.object == null ? null : encodeObject(opts.object as ObjectInput),
        ...(opts?.limit ? { limit: opts.limit } : {}),
      } });
    },
  };
}
const globalMemory = memoryScope(MEMORY_REF, MEMORY_GRAPH);
const memory: Moo["memory"] = Object.assign(globalMemory, {
  project(projectId?: string): MemoryScope {
    let cached: MemoryScope | null = null;
    let pending: Promise<MemoryScope> | null = null;
    async function resolve(): Promise<MemoryScope> {
      if (cached) return cached;
      if (!pending) {
        pending = (async () => {
          const raw = projectId == null ? await currentProjectMemoryId() : projectId;
          const id = encodeProjectMemoryId(raw);
          const store = `${PROJECT_MEMORY_REF_PREFIX}${id}/facts`;
          const graph = `${PROJECT_MEMORY_GRAPH_PREFIX}${id}`;
          await pointers.set(store, raw);
          cached = memoryScope(store, graph);
          return cached;
        })();
      }
      return pending;
    }
    return {
      async assert(args) {
        return (await resolve()).assert(args);
      },
      async retract(args) {
        return (await resolve()).retract(args);
      },
      async query(patterns, opts) {
        return (await resolve()).query(patterns, opts);
      },
      async triples(opts) {
        return (await resolve()).triples(opts);
      },
    };
  },
});

const VOCAB_REF = "vocab/facts";
const VOCAB_GRAPH = "vocab:facts";

const vocab: Moo["vocab"] = {
  async define(name, opts) {
    if (!name || !name.trim()) throw new Error("vocab.define requires name");
    // Subject is the literal predicate as used in triples — no auto-prefix.
    // That way `vocab.define('prefers',…)` annotates the same predicate the
    // agent uses in `moo.memory.assert({subject, predicate, object})`.
    const subject = name;
    await facts.update({ store: VOCAB_REF, fn: (txn) => {
      txn.add({ graph: VOCAB_GRAPH, subject: subject, predicate: "rdf:type", object: "vocab:Predicate" });
      txn.add({ graph: VOCAB_GRAPH, subject: subject, predicate: "rdfs:label", object: opts?.label || name });
      if (opts?.description) {
        txn.add({ graph: VOCAB_GRAPH, subject: subject, predicate: "vocab:description", object: opts.description });
      }
      if (opts?.example) {
        txn.add({ graph: VOCAB_GRAPH, subject: subject, predicate: "vocab:example", object: opts.example });
      }
    } });
  },
  async list() {
    // Declared predicates: read all subjects of type vocab:Predicate plus
    // their annotations.
    const declared = await facts.match({ store: VOCAB_REF, ...{
      graph: VOCAB_GRAPH,
    } });
    const byPredicate = new Map<
      string,
      { label: string | null; description: string | null; example: string | null }
    >();
    const isPredicate = new Set<string>();
    for (const [, s, p, o] of declared) {
      if (p === "rdf:type" && o === "vocab:Predicate") {
        isPredicate.add(s);
        if (!byPredicate.has(s)) {
          byPredicate.set(s, { label: null, description: null, example: null });
        }
      }
    }
    for (const [, s, p, o] of declared) {
      if (!isPredicate.has(s)) continue;
      const entry = byPredicate.get(s)!;
      if (p === "rdfs:label") entry.label = o;
      else if (p === "vocab:description") entry.description = o;
      else if (p === "vocab:example") entry.example = o;
    }

    // Observed predicates: count occurrences in memory, vocab, project, and chat fact graphs.
    const memoryStores = [
      MEMORY_REF,
      VOCAB_REF,
      ...(await pointers.list(PROJECT_MEMORY_REF_PREFIX)),
      ...(await pointers.list("chat/")).filter((name) =>
        name.startsWith("chat/") && name.endsWith("/facts"),
      ),
    ];
    const counts = new Map<string, number>();
    for (const store of memoryStores) {
      const observed = await facts.match({ store });
      for (const [, , p] of observed) {
        counts.set(p, (counts.get(p) || 0) + 1);
      }
    }

    const out: Awaited<ReturnType<Moo["vocab"]["list"]>> = [];
    const seen = new Set<string>();
    for (const [subject, meta] of byPredicate) {
      const name = subject;
      seen.add(name);
      out.push({
        name,
        declared: true,
        count: counts.get(name) || 0,
        ...meta,
      });
    }
    for (const [name, count] of counts) {
      if (seen.has(name)) continue;
      out.push({
        name,
        declared: false,
        count,
        label: null,
        description: null,
        example: null,
      });
    }
    out.sort((a, b) =>
      b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    return out;
  },
};

export const tryApi: Moo["try"] = async (fn) => {
  try {
    return ok(await fn());
  } catch (e) {
    return err(errorInfo(e));
  }
};

const rawMoo: Moo = {
  try: tryApi,
  time,
  validate,
  id,
  log,
  objects,
  todos,
  skills,
  pointers,
  sparql,
  facts,
  fs,
  proc,
  workspace,
  http,
  env,
  chat,
  ui,
  mcp,
  agent,
  memory,
  vocab,
  events,
  traces,
  term,
};

const TRACE_SKIP_ROOTS = new Set(["traces"]);

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return !!value && (typeof value === "object" || typeof value === "function") && typeof (value as any).then === "function";
}

type TraceJsonContext = "input" | "output" | "error" | "event";
type TraceRedactOpts = { context?: TraceJsonContext };

function utf8Bytes(value: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    let code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code <= 0x7f) out.push(code);
    else if (code <= 0x7ff) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code <= 0xffff) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return out;
}

function bytesOf(value: string | ArrayBufferView | ArrayBuffer): number[] {
  if (typeof value === "string") return utf8Bytes(value);
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}

function rightRotate(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export function sha256(value: string | ArrayBufferView | ArrayBuffer): string {
  const bytes = bytesOf(value);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  bytes.push((high >>> 24) & 255, (high >>> 16) & 255, (high >>> 8) & 255, high & 255, (low >>> 24) & 255, (low >>> 16) & 255, (low >>> 8) & 255, low & 255);
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64);
  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      const j = i + t * 4;
      w[t] = (((bytes[j] ?? 0) << 24) | ((bytes[j + 1] ?? 0) << 16) | ((bytes[j + 2] ?? 0) << 8) | (bytes[j + 3] ?? 0)) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = (rightRotate(w[t - 15]!, 7) ^ rightRotate(w[t - 15]!, 18) ^ (w[t - 15]! >>> 3)) >>> 0;
      const s1 = (rightRotate(w[t - 2]!, 17) ^ rightRotate(w[t - 2]!, 19) ^ (w[t - 2]! >>> 10)) >>> 0;
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const s1 = (rightRotate(e!, 6) ^ rightRotate(e!, 11) ^ rightRotate(e!, 25)) >>> 0;
      const ch = ((e! & f!) ^ (~e! & g!)) >>> 0;
      const temp1 = (hh! + s1 + ch + k[t]! + w[t]!) >>> 0;
      const s0 = (rightRotate(a!, 2) ^ rightRotate(a!, 13) ^ rightRotate(a!, 22)) >>> 0;
      const maj = ((a! & b!) ^ (a! & c!) ^ (b! & c!)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d! + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0]! + a!) >>> 0; h[1] = (h[1]! + b!) >>> 0; h[2] = (h[2]! + c!) >>> 0; h[3] = (h[3]! + d!) >>> 0;
    h[4] = (h[4]! + e!) >>> 0; h[5] = (h[5]! + f!) >>> 0; h[6] = (h[6]! + g!) >>> 0; h[7] = (h[7]! + hh!) >>> 0;
  }
  return h.map((n) => n!.toString(16).padStart(8, "0")).join("");
}

function stableJson(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : null;
  } catch {
    return null;
  }
}

function ctorName(value: unknown): string | null {
  const name = (value as any)?.constructor?.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

function functionTraceValue(fn: Function): Record<string, unknown> {
  const ctor = ctorName(fn);
  let source = "";
  try { source = Function.prototype.toString.call(fn); } catch {}
  return {
    type: "function",
    name: fn.name || null,
    async: ctor === "AsyncFunction" || source.startsWith("async "),
    source,
  };
}

const TRACE_BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    out += TRACE_BASE64_ALPHABET[bytes[i]! >> 2];
    out += TRACE_BASE64_ALPHABET[((bytes[i]! & 0x03) << 4) | (bytes[i + 1]! >> 4)];
    out += TRACE_BASE64_ALPHABET[((bytes[i + 1]! & 0x0f) << 2) | (bytes[i + 2]! >> 6)];
    out += TRACE_BASE64_ALPHABET[bytes[i + 2]! & 0x3f];
  }
  if (i < bytes.length) {
    out += TRACE_BASE64_ALPHABET[bytes[i]! >> 2];
    if (i + 1 < bytes.length) {
      out += TRACE_BASE64_ALPHABET[((bytes[i]! & 0x03) << 4) | (bytes[i + 1]! >> 4)];
      out += TRACE_BASE64_ALPHABET[(bytes[i + 1]! & 0x0f) << 2];
      out += "=";
    } else {
      out += TRACE_BASE64_ALPHABET[(bytes[i]! & 0x03) << 4];
      out += "==";
    }
  }
  return out;
}

function errorTraceValue(error: any, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: "error",
    name: typeof error?.name === "string" ? error.name : ctorName(error) ?? "Error",
    message: typeof error?.message === "string" ? error.message : String(error),
  };
  if (typeof error?.stack === "string") out.stack = error.stack;
  for (const key of Reflect.ownKeys(error ?? {})) {
    if (key === "name" || key === "message" || key === "stack") continue;
    out[String(key)] = traceJsonInner((error as any)[key as any], seen);
  }
  return out;
}

function traceJsonInner(value: unknown, seen: WeakSet<object>): unknown {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return { type: "symbol", description: value.description ?? null, source: String(value) };
  if (typeof value === "function") return functionTraceValue(value as Function);
  if (typeof value !== "object") return String(value);
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  try {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) return errorTraceValue(value, seen);
    if (value instanceof ArrayBuffer) return { type: "ArrayBuffer", encoding: "base64", data: bytesToBase64(new Uint8Array(value)) };
    if (ArrayBuffer.isView(value as any)) {
      const view = value as ArrayBufferView;
      return {
        type: ctorName(value) ?? "ArrayBufferView",
        encoding: "base64",
        data: bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
      };
    }
    if (Array.isArray(value)) return value.map((entry) => traceJsonInner(entry, seen));
    if (value instanceof Map) return { type: "Map", entries: Array.from(value.entries()).map(([k, v]) => [traceJsonInner(k, seen), traceJsonInner(v, seen)]) };
    if (value instanceof Set) return { type: "Set", values: Array.from(value.values()).map((entry) => traceJsonInner(entry, seen)) };
    const out: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value as object)) {
      const desc = Object.getOwnPropertyDescriptor(value as object, key);
      if (!desc || !("value" in desc)) continue;
      out[String(key)] = traceJsonInner(desc.value, seen);
    }
    return out;
  } finally {
    seen.delete(value as object);
  }
}

export function traceJsonValue(value: unknown): unknown {
  return traceJsonInner(value, new WeakSet<object>());
}

export function redactValue(value: unknown, _opts: TraceRedactOpts = {}): unknown {
  return traceJsonValue(value);
}

function traceDataJson(value: unknown): string {
  return JSON.stringify(traceJsonValue(value));
}

function traceErrorJson(_name: string, error: unknown): string {
  return JSON.stringify({ error: traceJsonValue(error) });
}

function traceArgsObject(args: unknown[]): Record<string, unknown> {
  if (args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) return args[0] as Record<string, unknown>;
  return { args };
}

function rowCount(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    const result = (value as any).result;
    if (Array.isArray(result)) return result.length;
    const rows = (value as any).rows;
    if (Array.isArray(rows)) return rows.length;
  }
  return null;
}

const TRACE_NATIVE_WRAPPED = Symbol.for("moo.trace.native.wrapped");
const TRACE_NATIVE_ORIGINAL = Symbol.for("moo.trace.native.original");

function traceNativeOp<T>(name: string, opArgs: unknown[], fn: () => T): T {
  let spanId: string | null = null;
  try {
    const raw = host.insertTrace(JSON.stringify({ kind: "span", name: `moo.native.${name}`, status: "running", data: traceJsonValue({ op: name, args: opArgs }) }));
    spanId = raw === "null" ? null : raw;
  } catch {}
  try {
    const value = fn();
    if (isThenable(value)) {
      return Promise.resolve(value).then((resolved) => {
        if (spanId) host.finishTrace(spanId, "ok", traceDataJson({ output: resolved }));
        return resolved;
      }, (e) => {
        if (spanId) host.finishTrace(spanId, "error", traceErrorJson(name, e));
        throw e;
      }) as T;
    }
    if (spanId) host.finishTrace(spanId, "ok", traceDataJson({ output: value }));
    return value;
  } catch (e: any) {
    if (spanId) host.finishTrace(spanId, "error", traceErrorJson(name, e));
    throw e;
  }
}
function installNativeOpTracing(): void {
  const g = globalThis as any;
  for (const op of host.TRACED_NATIVE_OPS) {
    const original = g[op.globalName];
    if (typeof original !== "function" || original[TRACE_NATIVE_WRAPPED]) continue;
    const wrapped = function(this: unknown, ...opArgs: unknown[]) {
      return traceNativeOp(op.traceName, opArgs, () => original.apply(this, opArgs));
    };
    Object.defineProperty(wrapped, TRACE_NATIVE_WRAPPED, { value: true });
    Object.defineProperty(wrapped, TRACE_NATIVE_ORIGINAL, { value: original });
    try {
      g[op.globalName] = wrapped;
    } catch {
      // Some embedders may expose native bindings as non-writable globals.
    }
  }
}

function createTracedObject<T extends object>(target: T, path: string[] = []): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof prop !== "string") return value;
      const nextPath = [...path, prop];
      if (typeof value === "function") {
        if (TRACE_SKIP_ROOTS.has(nextPath[0]!)) return value;
        return (...args: unknown[]) => {
          if (!host.canTraceSpans()) return value.apply(obj, args);
          const name = `moo.${nextPath.join(".")}`;
          let previousParent: string | null = null;
          const spanId = host.insertTrace(JSON.stringify({
            kind: "span",
            name,
            status: "running",
            data: traceJsonValue({ args }),
          }));
          if (spanId) previousParent = host.setTraceParent(spanId);
          const finishOk = (result: unknown) => {
            if (spanId) host.finishTrace(spanId, "ok", traceDataJson({ output: result }));
            return result;
          };
          const finishError = (e: any) => {
            if (spanId) host.finishTrace(spanId, "error", traceErrorJson(name, e));
          };
          let pending = false;
          try {
            const result = value.apply(obj, args);
            if (isThenable(result)) {
              pending = true;
              return Promise.resolve(result).then((resolved) => finishOk(resolved), (e) => {
                finishError(e);
                throw e;
              }).finally(() => {
                if (spanId) host.setTraceParent(previousParent);
              });
            }
            return finishOk(result);
          } catch (e: any) {
            finishError(e);
            throw e;
          } finally {
            if (!pending && spanId) host.setTraceParent(previousParent);
          }
        };
      }
      if (value && typeof value === "object" && !TRACE_SKIP_ROOTS.has(nextPath[0]!)) {
        return createTracedObject(value, nextPath);
      }
      return value;
    },
  }) as T;
}

installNativeOpTracing();

export const moo: Moo = createTracedObject(rawMoo);
