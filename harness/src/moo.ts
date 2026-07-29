import * as host from "./host_ops";
import type { Moo, Quad, Bindings, Triple, ObjectInput, MemoryScope, UiAskSpec, UiChooseSpec, UiBundle, UiManifest, FactQuadInput, McpServerConfig, McpTool, McpOAuthStartOptions, McpOAuthStatus, McpOAuthStart, SubagentSpec, SubagentResult, AgentStartSpec, FactMutationReceipt, ProcRunArgs, ProcResult, TermBindings, BindingTerm, QuadObject, TraceRow, TraceTreeNode, TraceSummary, TraceDiagnostic, PatchResult, SparqlSelectFormat, SparqlQueryResult, FactMatchFormat, FactPattern, TraceFailedArgs, TraceSearchRow } from "./types";
import { parseJson, z } from "./core/json";
import {
  httpHeaderRecordSchema,
  judgeResultSchema,
  mcpJsonRpcResponseSchema,
  type McpJsonRpcResponse,
  mcpOAuthPendingSchema,
  mcpOAuthTokenSchema,
  mcpServerConfigSchema,
  mcpSessionSchema,
} from "./core/schema";
import { err, ok, errorInfo } from "./core/result";
import { unifiedDiffWithStats } from "./core/diff";
import { PatchError, patchText, validatePatchEnvelopeTarget } from "./core/patch";
import { encodeObject, stringBytes, term, validate } from "./core/terms";
import { Term, MooApiError } from "./types";
import { assertFactObject, assertFactObjects, chatRefs, decodeJsonPointer, encodeJsonPointer, unpackQuad, stringifyForLog } from "./lib";
import { appendStep } from "./steps";
import { addTask, clearTasks, getTasks, patchTasks, setTaskValidation, updateTask, validateTask, withTaskDiffBatch, setTaskValidationRunner } from "./tasks";
import { setSkillRootProvider, skills } from "./skills";
import { compileRunTS } from "./runts";
import { applyDefaultChatSettings } from "./commands/models";

const time: Moo["time"] = {
  async nowMs(_args = {}) {
    return host.now();
  },
  async nowISO(_args = {}) {
    return new Date(host.now()).toISOString();
  },
  async datetime(args = {}) {
    const d = args.d;
    const value = d == null ? new Date(host.now()) : typeof d === "number" ? new Date(d) : d;
    return term.datetime({ d: value });
  },
  async nowPlus({ ms }) {
    return host.now() + Number(ms);
  },
};

const id: Moo["id"] = {
  async new(args = {}) {
    return host.newId(args.prefix ?? "id");
  },
};

const log: Moo["log"] = ({ args }) => {
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
let activeRunTSContext: { chatId: string; runTsStepId: string; depth: number; outstanding: Set<string>; traceId?: string | null } | null = null;

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

export async function withMooRunTSContext<T>(
  chatId: string,
  runTsStepId: string,
  depth: number,
  fn: () => Promise<T>,
): Promise<T> {
  const previousChat = activeChatId;
  const previousRunTS = activeRunTSContext;
  activeChatId = chatId;
  activeRunTSContext = { chatId, runTsStepId, depth, outstanding: new Set(), traceId: null };
  try {
    return await withTaskDiffBatch(chatId, fn);
  } finally {
    const ctx = activeRunTSContext;
    activeRunTSContext = previousRunTS;
    activeChatId = previousChat;
    if (ctx) {
      for (const childChatId of ctx.outstanding) {
        try {
          await markOutstandingSubagentCancelled(ctx.chatId, childChatId, "runTS finished before awaiting this subagent");
        } catch {
          // best effort only
        }
      }
    }
  }
}


type TraceRootInfo = { traceId?: string | null; id?: string | null; resultHash?: string | null; error?: string | null; status?: string };

type TraceAttachmentPlan = {
  root: Record<string, unknown>;
  active: Record<string, unknown>;
  rootId: string;
  activeId: string;
};

type TraceParentKind = "frontend" | "command" | "chat-step" | "system";

function stringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function safeTracePart(value: string | null): string {
  return (value || "unknown").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
}

function commandTraceId(command: string | null, parentKey?: string | null): string {
  const key = parentKey ? safeTracePart(parentKey) : host.newId("trace");
  return `command:${safeTracePart(command)}:${key}`;
}

function chatRootId(chatId: string): string {
  return `chattrace:${chatId}`;
}

function traceParentKind(id: string | null): TraceParentKind {
  if (id?.startsWith("fronttrace:")) return "frontend";
  if (id?.startsWith("command:")) return "command";
  if (id?.startsWith("step:") || id?.startsWith("traceevt:")) return "chat-step";
  return "system";
}

function traceAttachmentPlan(parentId: string | null, data: Record<string, unknown>, ambientParentId: string | null = null): TraceAttachmentPlan {
  const chatId = stringField(data, "chatId");
  const runId = stringField(data, "runId");
  const label = stringField(data, "label") || stringField(data, "description") || "trace";
  const command = stringField(data, "command");
  const explicitParentId = stringField(data, "traceParentId") || parentId;
  const route = stringField(data, "traceRoute");
  const startedNs = Date.now() * 1_000_000;
  const parentKind = traceParentKind(explicitParentId);

  if (parentKind === "frontend" && explicitParentId) {
    const rootId = explicitParentId;
    const activeId = commandTraceId(command, rootId);
    return {
      rootId,
      activeId,
      root: {
        id: rootId,
        chatId,
        runId,
        kind: "frontend",
        name: command || "frontend.action",
        status: "running",
        startedNs,
        data: { label: command || label, command, chatId, route, source: "frontend" },
      },
      active: {
        id: activeId,
        parentId: rootId,
        chatId,
        runId,
        kind: "command",
        name: command ? `command ${command}` : label,
        startedNs,
        data: { label, command, chatId, route },
      },
    };
  }

  if (parentKind === "command") {
    if (chatId) {
      const rootId = chatRootId(chatId);
      const activeId = commandTraceId(command);
      return {
        rootId,
        activeId,
        root: {
          id: rootId,
          chatId,
          runId,
          kind: "chat",
          name: stringField(data, "title") || `chat ${chatId}`,
          startedNs,
          data: { chatId, runId, label: stringField(data, "title") || `chat ${chatId}`, source: "chat" },
        },
        active: {
          id: activeId,
          parentId: rootId,
          chatId,
          runId,
          kind: "command",
          name: command ? `command ${command}` : label,
          startedNs,
          data: { label, command, chatId, route },
        },
      };
    }
    const rootId = commandTraceId(command);
    return {
      rootId,
      activeId: rootId,
      root: {
        id: rootId,
        chatId,
        runId,
        kind: "command",
        name: command ? `command ${command}` : label,
        startedNs,
        data: { label, command, chatId, route },
      },
      active: {
        id: rootId,
        parentId: null,
        chatId,
        runId,
        kind: "command",
        name: command ? `command ${command}` : label,
        startedNs,
        data: { label, command, chatId, route },
      },
    };
  }

  if (parentKind === "chat-step" && chatId && explicitParentId) {
    const rootId = chatRootId(chatId);
    return {
      rootId,
      activeId: explicitParentId,
      root: {
        id: rootId,
        chatId,
        runId,
        kind: "chat",
        name: stringField(data, "title") || `chat ${chatId}`,
        startedNs,
        data: { chatId, runId, label: stringField(data, "title") || `chat ${chatId}`, source: "chat" },
      },
      active: {
        id: explicitParentId,
        parentId: ambientParentId || rootId,
        chatId,
        runId,
        kind: explicitParentId.startsWith("step:") ? "step" : "tool",
        name: label,
        startedNs,
        data: { label, chatId, runId },
      },
    };
  }

  const rootId = explicitParentId || `system:${label.replace(/\s+/g, "-").toLowerCase()}`;
  return {
    rootId,
    activeId: rootId,
    root: { id: rootId, chatId, runId, kind: "system", name: label, startedNs, data: { label, chatId, runId } },
    active: { id: rootId, parentId: null, chatId, runId, kind: "system", name: label, startedNs, data: { label, chatId, runId } },
  };
}

export async function startRunTSTraceRoot(parentId: string | null, data: Record<string, unknown> = {}) {
  const current = await host.currentTrace();
  const cur = current ? (parseJson(current, "enterTrace current") as any) : null;
  const ambientParentId = typeof cur?.id === "string" && cur.id && cur.id !== parentId ? cur.id : null;
  const plan = traceAttachmentPlan(parentId, data, ambientParentId);
  await host.ensureTraceRoot(JSON.stringify(plan.root));
  if (plan.activeId !== plan.rootId) await host.ensureTraceSpan(JSON.stringify(plan.active));
  const raw = await host.enterTrace(JSON.stringify({ id: plan.activeId, rootId: plan.rootId }));
  const entered = raw ? (parseJson(raw, "enterTrace") as any) : null;
  if (!entered) return null;
  if (activeRunTSContext && (entered.id || entered.traceId || entered.rootId)) activeRunTSContext.traceId = entered.id || entered.traceId || entered.rootId;
  return entered as any;
}
export const startTraceRoot = startRunTSTraceRoot;

export async function finishRunTSTraceRoot(info: TraceRootInfo) {
  let shouldLeave = false;
  try {
    const current = await host.currentTrace();
    const cur = current ? (parseJson(current, "finishTraceRoot current") as any) : null;
    const traceId = info.id || info.traceId || cur?.id || cur?.parentId || cur?.traceId;
    if (!traceId) return false;
    shouldLeave = true;
    const root = await host.getTrace(JSON.stringify({ id: traceId }));
    const row = root ? (parseJson(root, "finishTraceRoot row") as any) : null;
    const data = {
      ...(row?.data && typeof row.data === "object" ? row.data : {}),
      ...(info.resultHash ? { resultHash: info.resultHash } : {}),
      ...(info.error ? { error: info.error } : {}),
    };
    const status = info.status || (info.error ? "error" : "ok");
    return (await host.finishTrace(traceId, status, JSON.stringify(traceJsonValue(data)))) === "true";
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
export const finishTraceRoot = finishRunTSTraceRoot;

function parseTraceRow(raw: string | null): TraceRow | null {
  return raw ? parseJson(raw, "parseTraceRow") as TraceRow : null;
}

function parseTraceRows(raw: string): TraceRow[] {
  const rows = parseJson(raw || "[]", "parseTraceRows") as TraceRow[];
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
  category?: "runts_compile" | "patch_mismatch" | "missing_file" | "missing_tool" | "proc_nonzero" | "undefined_variable" | "no_change" | "timeout" | "api_error" | "unknown";
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
  if (/v8\.compile|Unexpected identifier|missing \) after argument list|SyntaxError/i.test(text)) return "runts_compile";
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
  return rows.filter((row) => /^(moo.(fs.(write|patch|record_diff|ensureDir|delete)|proc.run|http.|facts.(add|addAll|remove|swap|update|clearStore|deleteStore|deleteGraph|deleteGraphEverywhere)|pointers.(set|cas|delete)|objects.put|memory.(assert|retract|patch)|chat.|ui.|mcp.|agent.run)|timeline.|usage.|command.)/.test(row.name));
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

async function failedTraces(args: TraceFailedArgs & { includeEvents: true }): Promise<TraceSummary[]>;
async function failedTraces(args?: TraceFailedArgs): Promise<TraceSearchRow[]>;
async function failedTraces(args: TraceFailedArgs = {}): Promise<TraceSearchRow[] | TraceSummary[]> {
  const limit = Math.max(1, Math.min(1000, Math.floor(args.limit ?? 20)));
  const rows = await traces.recent({ limit: args.chatId ? 1000 : limit, includeChat: args.includeChat, chatId: args.chatId });
  const failedRows = rows.filter((row) => row.status && row.status !== "ok" && row.status !== "running").slice(0, limit);
  if (!args.includeEvents) return failedRows;
  const out: TraceSummary[] = [];
  for (const row of failedRows) {
    const summary = await traces.summary({ traceId: row.traceId, includeEvents: true });
    if (summary) out.push(summary);
  }
  return out;
}

const traces: Moo["traces"] = {
  async current(_args = {}) {
    const raw = await host.currentTrace();
    return raw ? parseJson(raw, "traces.current") : null;
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
  errorOf({ row }) {
    return traceErrorOfRow(row);
  },
  async errors(args = {}) {
    const events = await traces.events(args);
    return events.map((row) => {
      const message = traceErrorOfRow(row);
      return message ? { message, category: traceCategory(message, row)!, row } : null;
    }).filter(Boolean) as TraceErrorInfoLocal[];
  },
  failed: failedTraces,
  async summary(args = {}) {
    const root = await traces.get(args);
    if (!root) return null;
    const events = await traces.events({ traceId: root.traceId });
    const summary = buildTraceSummary(root, events, args.includeEvents === true);
    if (!summary) return null;
    const c = await chatForTraceStep(root.stepId);
    if (c) summary.chat = c;
    return summary;
  },
  async diagnose(args = {}) {
    const limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? 20)));
    const failures = await traces.failed({ limit, chatId: args.chatId, includeEvents: true }) as unknown as TraceSummary[];
    const recent = await traces.recent({ limit: args.chatId ? 1000 : limit, chatId: args.chatId });
    const summaries: TraceSummary[] = [];
    for (const row of recent.slice(0, limit)) {
      const summary = await traces.summary({ traceId: row.traceId });
      if (summary) summaries.push(summary);
    }
    const slowRecent = summaries
      .filter((summary) => summary.durationNs != null)
      .sort((a, b) => (b.durationNs ?? 0) - (a.durationNs ?? 0))
      .slice(0, limit);
    const slowestSpans = slowRecent.flatMap((summary: any) => (summary.slowestSpans ?? []).map((span: any) => ({ traceId: summary.traceId, ...span }))).sort((a: any, b: any) => (b.durationNs ?? 0) - (a.durationNs ?? 0)).slice(0, limit);
    const sideEffects = summaries.flatMap((summary: any) => (summary.sideEffects ?? []).map((row: TraceRow) => ({ traceId: summary.traceId, row }))).slice(0, limit * 5);
    const failuresByCategory = new Map<string, number>();
    for (const failure of failures) {
      const category = failure.error?.category ?? "unknown";
      failuresByCategory.set(category, (failuresByCategory.get(category) ?? 0) + 1);
    }
    return {
      recentFailures: failures,
      slowRecent,
      slowestSpans,
      sideEffects,
      failureGroups: Array.from(failuresByCategory.entries()).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    };
  },
  async mark({ message, data = {} }) {
    const id = await host.insertTrace(JSON.stringify({ kind: "mark", name: "user.mark", status: "ok", data: traceJsonValue({ ...data, message }) }));
    return id === "null" ? null : id;
  },
  async span<T>({ name, data = {}, fn }: { name: string; data?: import("./types").TraceSpanOptions; fn: () => T | Promise<T> }): Promise<Awaited<T>> {
    if (typeof fn !== "function") throw new Error("moo.traces.span requires a callback");
    const rawSpanId = await host.insertTrace(JSON.stringify({ kind: "span", name, status: "running", data: traceJsonValue(data ?? {}) }));
    const spanId = rawSpanId === "null" ? null : rawSpanId;
    const previousParent = spanId ? host.setTraceParent(spanId) : null;
    try {
      const value = await fn();
      if (spanId) await host.finishTrace(spanId, "ok", traceDataJson({}));
      return value as Awaited<T>;
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
  const scratch = (await chat.scratch({ chatId: chatId })).replace(/\\/g, "/").replace(/\/+$/, "");
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
  const at = await time.nowMs({});
  const hash = await objects.putJSON({ kind: "agent:FileDiff", value: { chatId, path: displayPath, beforeExists: before != null, before, after, diff, stats, at } });
  const { stepId } = await appendStep(chatId, {
    kind: "agent:FileDiff",
    status: "agent:Done",
    payloadHash: hash,
    extras: [["agent:path", displayPath]],
  });
  events.publish({ payload: { kind: "file-diff", chatId, path: displayPath, before, after, diff, stats, hash, stepId, at } });
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
  const at = await time.nowMs({});
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
  events.publish({ payload: { kind: "memory-diff", chatId, store, graph, action, path, diff, stats, hash, stepId, at, count: changes.length, changes } });
}

const TIMELINE_OBJECT_KINDS = new Set([
  "agent:FileDiff",
  "agent:MemoryDiff",
  "agent:RunTS",
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
  const at = await time.nowMs({});
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
  events.publish({ payload: { kind: "blob-add", chatId, objectKind: kind, hash, size: payload.size, chars: payload.chars, encoding, stepId, at } });
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
  async getJSON<V = unknown>({ hash, schema }: { hash: string; schema?: z.ZodType<V> }): Promise<{ kind: string; value: V } | null> {
    const row = host.getObject(hash);
    if (!row) return null;
    return { kind: row.kind, value: parseJson(row.content, "objects.getJSON", schema) };
  },
};

function requireActiveTaskChat(): string {
  const chatId = activeChatId;
  if (!chatId) throw new Error("moo.tasks requires an active chat context");
  return chatId;
}

const tasks: Moo["tasks"] = {
  async list() {
    return await getTasks(requireActiveTaskChat());
  },
  async add(args) {
    return await addTask(requireActiveTaskChat(), args);
  },
  async update(args) {
    return await updateTask(requireActiveTaskChat(), args);
  },
  async done(args) {
    return await updateTask(requireActiveTaskChat(), { id: args.id, status: "done", note: args.note });
  },
  async drop(args) {
    return await updateTask(requireActiveTaskChat(), { id: args.id, status: "dropped", note: args.note });
  },
  async setValidation(args) {
    return await setTaskValidation(requireActiveTaskChat(), args);
  },
  async validate(args) {
    return await validateTask(requireActiveTaskChat(), args);
  },
  async patch(args) {
    return await patchTasks(requireActiveTaskChat(), args);
  },
  async clear(args) {
    return await clearTasks(requireActiveTaskChat(), args);
  },
};

function requireActiveScratchChat(): string {
  const chatId = activeChatId;
  if (!chatId) throw new Error("moo.scratches requires an active chat context");
  return chatId;
}

function scratchPointerName(chatId: string, name: string): string {
  const n = String(name || "").trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(n)) throw new Error("scratch name must be 1-80 chars of letters, digits, dot, underscore, or dash");
  return `chat/${chatId}/scratch/${n}`;
}

async function defaultScratchRoot(chatId: string): Promise<string> {
  return await chat.scratch({ chatId });
}

async function scratchNamedPath(chatId: string, name: string): Promise<string | null> {
  const ref = await pointers.get({ name: scratchPointerName(chatId, name) });
  return ref && ref.trim() ? ref.trim() : null;
}

function parentDir(path: string): string {
  const trimmed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0) return "/";
  return trimmed.slice(0, slash);
}

async function defaultNamedScratchRoot(chatId: string, name: string): Promise<string> {
  return joinPath(parentDir(await defaultScratchRoot(chatId)), name);
}

const scratches: Moo["scratches"] = {
  async current(_args = {}) {
    return await defaultScratchRoot(requireActiveScratchChat());
  },
  async list(_args = {}) {
    const chatId = requireActiveScratchChat();
    const entries = await pointers.entries({ prefix: `chat/${chatId}/scratch/` });
    const out: Array<{ name: string; path: string; exists: boolean }> = [];
    for (const [ref, target] of entries) {
      const name = ref.slice(`chat/${chatId}/scratch/`.length);
      out.push({ name, path: target, exists: await fs.exists({ path: target }) });
    }
    return out;
  },
  async create(args = {}) {
    const { name, path, fromCurrent = false } = args ?? {};
    const chatId = requireActiveScratchChat();
    const n = String(name || (await id.new({ prefix: "scratch" })).replace(/^scratch:/, "")).trim();
    const root = path && String(path).trim()
      ? String(path).trim()
      : await defaultNamedScratchRoot(chatId, n);
    await fs.ensureDir({ path: root });
    if (fromCurrent) {
      await proc.run({ cmd: ["sh", "-c", "cp -a \"$1\"/. \"$2\"/", "sh", await defaultScratchRoot(chatId), root], timeoutMs: 30_000 });
    }
    const canonical = await canonicalDir(root);
    await pointers.set({ name: scratchPointerName(chatId, n), target: canonical });
    return { name: n, path: canonical };
  },
  async get({ name }) {
    return await scratchNamedPath(requireActiveScratchChat(), name);
  },
  async delete({ name, recursive = false } = {} as any) {
    const chatId = requireActiveScratchChat();
    const ref = scratchPointerName(chatId, name);
    const path = await pointers.get({ name: ref });
    const deletedRef = await pointers.delete({ name: ref });
    let deletedPath = false;
    if (recursive && path && await fs.exists({ path })) {
      await proc.run({ cmd: ["rm", "-rf", path], timeoutMs: 10_000 });
      forgetCanonicalDir(path);
      deletedPath = true;
    }
    return { name: String(name), path: path || null, deletedRef, deletedPath };
  },
};

const judge: Moo["judge"] = {
  async check({ claim, evidence, criteria }) {
    const c = String(claim ?? "").trim();
    const ev = String(evidence ?? "").trim();
    const cr = String(criteria ?? "").trim();
    if (!c) return { ok: false, score: 0, reason: "missing claim" };
    const result = await runSubagent({
      label: "Judge claim",
      task: [
        "You are a strict review judge. Decide whether the claim is supported.",
        "Return only JSON with this exact shape: {\"ok\":boolean,\"score\":number,\"reason\":string}.",
        "Use score 1 for clearly supported, 0 for clearly unsupported or contradicted, and intermediate values for partial support.",
        "Pass only when score >= 0.5 and the claim is materially supported by the evidence and criteria.",
        "If evidence is absent, judge against criteria only; if neither evidence nor criteria are supplied, fail unless the claim is tautological.",
      ].join("\n"),
      context: JSON.stringify({ claim: c, evidence: ev || undefined, criteria: cr || undefined }, null, 2),
      expectedOutput: "A single JSON object: {ok:boolean, score:number in [0,1], reason:string}.",
      maxSteps: 1,
      timeoutMs: 120_000,
      worktree: "inherit",
    }, { allowNested: true });
    if (result.status !== "done") {
      return { ok: false, score: 0, reason: result.error || result.output || `judge subagent ${result.status}` };
    }
    const text = String(result.output || "").trim();
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) return { ok: false, score: 0, reason: text || "judge subagent returned no JSON" };
    try {
      const parsed = parseJson(match[0], "judge.check", judgeResultSchema);
      const score = Math.max(0, Math.min(1, parsed.score));
      const reason = String(parsed.reason ?? "").trim() || (score >= 0.5 ? "claim is supported" : "claim is not supported");
      return { ok: parsed.ok && score >= 0.5, score, reason };
    } catch (err: any) {
      return { ok: false, score: 0, reason: `judge subagent returned invalid JSON: ${err?.message || err}` };
    }
  },
  async assert(args) {
    const result = await judge.check(args);
    if (!result.ok) throw new Error(result.reason || "judge assertion failed");
    return result;
  },
};

const pointers: Moo["pointers"] = {
  async get({ name }) {
    if (!validate.pointerName({ name })) throw new MooApiError("invalid_pointer_name", "invalid pointer name", { name });
    return host.getRef(name);
  },
  async set({ name, target }) {
    if (!validate.pointerName({ name })) throw new MooApiError("invalid_pointer_name", "invalid pointer name", { name });
    const previous = host.getRef(name);
    host.setRef(name, target);
    return { name, target, previous, changed: previous !== target };
  },
  async cas({ name, expected, next }) {
    if (!validate.pointerName({ name })) throw new MooApiError("invalid_pointer_name", "invalid pointer name", { name });
    return host.compareAndSetRef(name, expected ?? null, next);
  },
  async list(args = {}) {
    return host.listRefs(args.prefix ?? "");
  },
  async entries(args = {}) {
    return parseJson(host.refEntries(args.prefix ?? ""), "pointers.entries");
  },
  async delete({ name }) {
    if (!validate.pointerName({ name })) throw new MooApiError("invalid_pointer_name", "invalid pointer name", { name });
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

function termBindings(rows: Bindings[]): TermBindings[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, parseBindingTerm(v)])) as TermBindings);
}

function formatBindings<F extends SparqlSelectFormat>(rows: Bindings[], format?: F): F extends "term" ? TermBindings[] : Bindings[] {
  return (format === "term" ? termBindings(rows) : rows) as F extends "term" ? TermBindings[] : Bindings[];
}

function sparqlQueryResult<F extends SparqlSelectFormat>(decoded: SparqlDecodedResult, format?: F): SparqlQueryResult<F> {
  return (decoded.type === "select" ? formatBindings(decoded.result, format) : decoded.result) as SparqlQueryResult<F>;
}

function factMatchResult<F extends FactMatchFormat>(rows: Quad[], format?: F): F extends "object" ? QuadObject[] : Quad[] {
  return (format === "object" ? quadObjects(rows) : rows) as F extends "object" ? QuadObject[] : Quad[];
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
  async query<F extends SparqlSelectFormat = "string">(args: { store: string; query: string; graph?: string | null; limit?: number; format?: F }): Promise<SparqlQueryResult<F>> {
    const { query, graph = null, limit = null, format } = args;
    const store = factStore(args, "sparql.query");
    const decoded = await nativeSparqlQuery("query", query, store, graph, limit ?? null);
    return sparqlQueryResult(decoded, format);
  },
  async select<F extends SparqlSelectFormat = "string">(args: { store: string; query: string; graph?: string | null; limit?: number; format?: F }): Promise<F extends "term" ? TermBindings[] : Bindings[]> {
    const { query, graph = null, limit = null, format } = args;
    const store = factStore(args, "sparql.select");
    const decoded = await nativeSparqlQuery("select", query, store, graph, limit ?? null);
    if (decoded.type !== "select") throw new MooApiError("bad_sparql", "SPARQL query returned " + decoded.type + ", not select");
    return formatBindings(decoded.result, format);
  },
  async ask(args) {
    const { query, graph = null, limit = null } = args;
    const store = factStore(args, "sparql.ask");
    const decoded = await nativeSparqlQuery("ask", query, store, graph, limit ?? null);
    if (decoded.type !== "ask") throw new MooApiError("bad_sparql", "SPARQL query returned " + decoded.type + ", not ask");
    return decoded.result;
  },
  async construct(args) {
    const { query, graph = null, limit = null } = args;
    const store = factStore(args, "sparql.construct");
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
  async match<F extends FactMatchFormat = "tuple">(args: FactPattern<F>): Promise<F extends "object" ? QuadObject[] : Quad[]> {
    const { graph = null, subject = null, predicate = null, object = null, limit = undefined, format } = args;
    const store = factStore(args, "facts.match");
    const encodedObject = object == null ? null : encodeObject(object);
    const rows = host.matchFacts(store, graph, subject, predicate, encodedObject, limit ?? null) as Quad[];
    return factMatchResult(rows, format);
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
    const { graph = null, subject = null, predicate = null, object = null } = args;
    const encodedObject = object == null ? null : encodeObject(object);
    return host.countFacts(factStore(args, "facts.count"), graph, subject, predicate, encodedObject);
  },
  async swap(args) {
    const { removes, adds } = args;
    const store = factStore(args, "facts.swap");
    const encodedRemoves = removes.flatMap((q) => removeFactQuadCandidates(q));
    const encodedAdds = adds.map((q) => encodeFactQuad(q));
    assertFactObjects(encodedAdds);
    host.swapFacts(store, JSON.stringify(encodedRemoves), JSON.stringify(encodedAdds));
    invalidateChatFactsSummary(store);
    // Report the logical requested count, not the candidate expansion
    // (removeFactQuadCandidates fans one quad out into 2-3 encodings).
    return factReceipt(store, encodedAdds.length, removes.length);
  },
  async update(args) {
    const { fn } = args;
    const store = factStore(args, "facts.update");
    const removes: Quad[] = [];
    const adds: Quad[] = [];
    // Track logical remove requests separately from the candidate expansion so
    // the receipt reports how many quads the caller asked to remove, not how
    // many encodings removeFactQuadCandidates produced.
    let removeCount = 0;
    await fn({
      add({ graph, subject, predicate, object }) {
        adds.push([graph, subject, predicate, encodeObject(object)]);
      },
      remove({ graph, subject, predicate, object }) {
        removeCount += 1;
        removes.push(...removeFactQuadCandidates({ graph, subject, predicate, object }));
      },
    });
    if (!removes.length && !adds.length) return factReceipt(store, 0, 0);
    assertFactObjects(adds);
    host.swapFacts(store, JSON.stringify(removes), JSON.stringify(adds));
    invalidateChatFactsSummary(store);
    return factReceipt(store, adds.length, removeCount);
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
  return activeChatId ? await chat.scratch({ chatId: activeChatId }) : null;
}

setSkillRootProvider(activeScratchRoot);

setTaskValidationRunner(async (chatId: string, source: string) => {
  const body = source.trim();
  if (!body) return false;
  const looksLikeFunction = /^(?:async\s+)?(?:function\b|\(?[\w\s,{}:[\]<>?=]*\)?\s*=>)/.test(body);
  const code = looksLikeFunction
    ? `const __taskValidation = ${body};\nreturn await __taskValidation();`
    : body;
  const compiled = compileRunTS(code);
  if (compiled.diagnostics.length) throw new Error("TypeScript compile failed:\n" + compiled.diagnostics.join("\n"));
  const fn = new Function("moo", "chatId", "repo", "scratch", "args", compiled.js + "\nreturn __runTS__();");
  const repo = (await pointers.get({ name: `chat/${chatId}/path` })) || ".";
  const scratchRoot = await chat.scratch({ chatId });
  const rawDepth = Number(await pointers.get({ name: `chat/${chatId}/subagent-depth` }) ?? 0);
  const depth = Number.isFinite(rawDepth) && rawDepth > 0 ? Math.floor(rawDepth) : 0;
  return await withMooRunTSContext(chatId, `task-validation:${chatId}`, depth, () =>
    withMooChatContext(chatId, () => fn(moo, chatId, repo, scratchRoot, {})),
  );
});

function resolveWorkspacePath(root: string, path: string = "."): string {
  const raw = String(path || ".");
  if (raw.startsWith("/")) return raw;
  if (!validate.relativePath({ path: raw }) && raw !== ".") throw new MooApiError("path_escape", "workspace paths must be relative and may not contain ..", { root, path: raw });
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

function normalizeLineRanges(lineRanges: [number, number][]): NormalizedLineRange[] {
  if (!Array.isArray(lineRanges)) throw new MooApiError("invalid_argument", "moo.fs.partialRead lineRanges must be an array", { lineRanges });
  const sorted = lineRanges.map((range, index) => {
    if (!Array.isArray(range) || range.length !== 2) {
      throw new MooApiError("invalid_argument", "moo.fs.partialRead range must be [from, to]", { index, range });
    }
    const from = Number(range[0]);
    const to = Number(range[1]);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || from > to) {
      throw new MooApiError("invalid_argument", "moo.fs.partialRead lineRanges must use 1-based inclusive line numbers with from <= to", { index, range });
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

function formatPartialRead(text: string, lineRanges: [number, number][], numbered = false): string {
  const normalizedRanges = normalizeLineRanges(lineRanges);
  if (!normalizedRanges.length) return "";
  const lines = splitReadableLines(text);
  if (!lines.length) return "";
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
      out.push(numbered ? String(lineNo).padStart(width) + ": " + line : line);
      wroteLine = true;
    }
    previousLineNo = Math.max(previousLineNo, to);
  }
  if (wroteLine && previousLineNo < maxLine) out.push("…");
  return out.join("\n");
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

function resolvePatchPaths(rawPath: string, workingDirectory: string | null): [string, string] {
  const candidate = String(rawPath ?? "").trim();
  if (!candidate) throw new PatchError("patch paths must not be empty.");
  if (candidate.includes("\\")) throw new PatchError("patch paths must use forward slashes.");
  if (candidate.startsWith("/")) {
    const normalized = normalizeAbsolutePosixPath(candidate);
    return [normalized, normalized];
  }
  const parts: string[] = [];
  for (const part of candidate.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new PatchError("patch paths must stay within the workspace root.");
    parts.push(part);
  }
  if (parts.length === 0) throw new PatchError("patch paths must point to a file inside the workspace root.");
  const display = parts.join("/");
  return [display, workingDirectory ? joinPath(workingDirectory, display) : display];
}

function patchResult(status: string, output: string): PatchResult {
  return { status, output };
}

async function executePatch(path: string, diff: string | null | undefined, workingDirectory: string | null): Promise<PatchResult> {
  const [display, absolute] = resolvePatchPaths(path, workingDirectory);
  const patch = diff ?? "";
  try {
    validatePatchEnvelopeTarget(patch, display);
  } catch (e) {
    throw new PatchError("Could not patch '" + display + "': " + (e as Error).message);
  }

  const stat = await fs.stat({ path: absolute });
  if (stat === null) {
    throw new PatchError("Could not read '" + display + "' before patching: File not found");
  }
  if (stat.kind === "dir") {
    throw new PatchError("Could not read '" + display + "' before patching: " + absolute + " is a directory");
  }
  let original: string;
  try {
    original = await fs.read({ path: absolute });
  } catch (e) {
    throw new PatchError("Could not read '" + display + "' before patching: " + (e as Error).message);
  }
  let content: string;
  try {
    content = patchText(original, patch);
  } catch (e) {
    throw new PatchError("Could not patch '" + display + "': " + (e as Error).message);
  }
  try {
    await fs.write({ path: absolute, content: content });
  } catch (e) {
    throw new PatchError("Could not write '" + display + "': " + (e as Error).message);
  }
  return patchResult("completed", "Patched '" + display + "'.");
}

async function executeDelete(path: string, recursive: boolean | undefined, workingDirectory: string | null): Promise<PatchResult> {
  let display: string;
  let absolute: string;
  try {
    [display, absolute] = resolvePatchPaths(path, workingDirectory);
  } catch (e) {
    return patchResult("failed", (e as Error).message);
  }

  const stat = await fs.stat({ path: absolute });
  if (stat === null) {
    return patchResult("failed", "Cannot delete '" + display + "' because it does not exist.");
  }
  const forceRecursive = !!recursive;
  if (stat.kind === "dir" && !forceRecursive) {
    try {
      const entries = await fs.list({ path: absolute });
      if (entries.length > 0) {
        return patchResult("failed", "Cannot delete non-empty directory '" + display + "' without recursive: true.");
      }
    } catch (e) {
      return patchResult("failed", "Could not inspect directory '" + display + "': " + (e as Error).message);
    }
  }
  let before: string | null = null;
  if (stat.kind !== "dir") try {
    before = await fs.read({ path: absolute });
  } catch (_) {
    before = null;
  }
  try {
    await traceObserved("moo.fs.delete", { path, resolved: absolute, recursive: forceRecursive }, () => host.deleteFile(absolute, forceRecursive));
  } catch (e) {
    return patchResult("failed", "Could not delete '" + display + "': " + (e as Error).message);
  }
  if (before !== null) {
    await traceObserved("moo.fs.record_diff", { path, resolved: absolute }, () => recordFileWriteDiff(absolute, before, null));
  }
  return patchResult("completed", "Deleted '" + display + "'.");
}

const fs: Moo["fs"] = {
  async read({ path }) {
    const resolved = await resolveActivePath(path);
    return await traceObserved("moo.fs.read", { path, resolved }, () => host.readFile(resolved), (value) => ({ chars: value.length, bytes: stringBytes(value) }));
  },
  async partialRead({ path, lineRanges, numbered = false }) {
    const content = await fs.read({ path });
    return await traceObserved("moo.fs.partialRead", { path, lineRanges, numbered: !!numbered }, () => formatPartialRead(content, lineRanges, !!numbered), (value) => ({ chars: value.length, bytes: stringBytes(value) }));
  },
  async write({ path, content }) {
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
  async list({ path }) {
    const resolved = await resolveActivePath(path);
    return await traceObserved("moo.fs.list", { path, resolved }, () => host.listDir(resolved), (value) => ({ count: value.length }));
  },
  async glob({ pattern }) {
    const resolved = await resolveActivePath(pattern);
    return await traceObserved("moo.fs.glob", { pattern, resolved }, () => host.globFiles(resolved), (value) => ({ count: value.length }));
  },
  async stat(args = {}) {
    const path = args.path ?? ".";
    const resolved = await resolveActivePath(path);
    return await traceObserved("moo.fs.stat", { path, resolved }, () => host.statFile(resolved), (value) => ({ exists: value != null, kind: value?.kind ?? null, size: value?.size ?? null, mtime: value?.mtime ?? null }));
  },
  async canonical({ path }) {
    const resolved = await resolveActivePath(path);
    return await traceObserved("moo.fs.canonical", { path, resolved }, () => host.canonicalPath(resolved), (value) => ({ path: value }));
  },
  async exists({ path }) {
    return await traceObserved("moo.fs.exists", { path }, async () => (await fs.stat({ path })) != null, (value) => ({ exists: value }));
  },
  async ensureDir({ path }) {
    const resolved = await resolveActivePath(path);
    await traceObserved("moo.fs.ensureDir", { path, resolved }, () => host.makeDir(resolved), () => ({ path: resolved }));
  },
  async patch({ path, diff }) {
    const root = await activeScratchRoot();
    return await traceObserved("moo.fs.patch", { path, root }, () => executePatch(path, diff, root), (value) => ({ status: value.status, output: value.output ?? null }));
  },
  async delete({ path, recursive = false }) {
    const root = await activeScratchRoot();
    return await traceObserved("moo.fs.delete", { path, root, recursive: !!recursive }, () => executeDelete(path, recursive, root), (value) => ({ status: value.status, output: value.output ?? null }));
  },
};

function formatProcCommand(cmd: readonly string[]): string {
  return cmd.map((part) => JSON.stringify(part)).join(" ");
}

function normalizeProcCommand(cmd: readonly string[]): string[] {
  if (!Array.isArray(cmd) || cmd.length === 0) {
    throw new MooApiError("invalid_request", "proc.run requires non-empty cmd array", { cmd });
  }
  return cmd.map((part, index) => {
    if (typeof part !== "string") {
      throw new MooApiError("invalid_request", "proc.run cmd entries must be strings", { cmd, index });
    }
    if (index === 0 && part.length === 0) {
      throw new MooApiError("invalid_request", "proc.run command name must not be empty", { cmd });
    }
    return part;
  });
}

function checkedProcResult(input: ProcRunArgs, result: ProcResult): ProcResult {
  if (input.check && result.code !== 0) {
    const code = result.timedOut ? "timeout" : "process_failed";
    const command = formatProcCommand(input.cmd);
    const message = result.timedOut
      ? "process timed out: " + command
      : "process failed: " + command + " exited " + result.code;
    throw new MooApiError(code, message, {
      cmd: input.cmd,
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
    const { stdin = null, timeoutMs = 60_000, env = undefined, maxOutputBytes = null } = input;
    const cmd = normalizeProcCommand(input.cmd);
    const cwd = await resolveActiveCwd(input.cwd);
    return await traceObserved("moo.proc.run", {
      cmd,
      cwd,
      timeoutMs,
      hasStdin: stdin != null,
      stdinChars: typeof stdin === "string" ? stdin.length : 0,
      envKeys: env && typeof env === "object" ? Object.keys(env).sort() : [],
      maxOutputBytes: maxOutputBytes ?? null,
      check: input.check === true,
    }, () => {
      const result = host.runProcess(
        JSON.stringify(cmd),
        cwd,
        stdin,
        timeoutMs,
        env == null ? null : JSON.stringify(env),
        maxOutputBytes ?? null,
      );
      return checkedProcResult({ ...input, cmd, cwd }, result);
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
    const root = args.root ? await fs.canonical({ path: args.root }) : await chat.scratch({ chatId: args.chatId || activeChatId || "default" });
    return {
      root,
      fs: {
        read: ({ path }) => fs.read({ path: resolveWorkspacePath(root, path) }),
        partialRead: ({ path, lineRanges, numbered }) => fs.partialRead({ path: resolveWorkspacePath(root, path), lineRanges, numbered }),
        write: ({ path, content }) => fs.write({ path: resolveWorkspacePath(root, path), content }),
        list: (args = {}) => fs.list({ path: resolveWorkspacePath(root, args.path ?? ".") }),
        glob: ({ pattern }) => fs.glob({ pattern: resolveWorkspacePath(root, pattern) }),
        stat: (args = {}) => fs.stat({ path: resolveWorkspacePath(root, args.path ?? ".") }),
        canonical: (args = {}) => fs.canonical({ path: resolveWorkspacePath(root, args.path ?? ".") }),
        exists: (args = {}) => fs.exists({ path: resolveWorkspacePath(root, args.path ?? ".") }),
        ensureDir: (args = {}) => fs.ensureDir({ path: resolveWorkspacePath(root, args.path ?? ".") }),
        patch: ({ path, diff }) => executePatch(path, diff, root),
        delete: ({ path, recursive = false }) => executeDelete(path, recursive, root),
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
    const parsed = parseJson(headersJson, "parseResponseHeaders", httpHeaderRecordSchema);
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
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
      return {
        status: response.status,
        body: response.body,
        headers: parseResponseHeaders(response.headers),
        bodyTruncated: response.bodyTruncated === true,
      };
    }, (response) => ({
      status: response.status,
      bodyChars: response.body.length,
      bodyTruncated: response.bodyTruncated,
    }));
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

function parseMcpSseBody(body: string): McpJsonRpcResponse | null {
  const messages: McpJsonRpcResponse[] = [];
  let dataLines: string[] = [];
  let parseError: any = null;
  const flush = () => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") return;
    try {
      messages.push(parseJson(data, "parseMcpSseBody", mcpJsonRpcResponseSchema));
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

function parseMcpBody(body: string): unknown {
  try {
    return parseJson(body || "null", "parseMcpBody", z.record(z.unknown()));
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

function oauthAuthorizationServerMetadataUrl(issuer: string): string {
  const parsed = parseHttpUrl(issuer);
  if (!parsed) {
    return String(issuer).replace(/\/+$/, "") + "/.well-known/oauth-authorization-server";
  }
  const path = parsed.path.replace(/\/+$/, "");
  if (path === "" || path === "/") {
    return parsed.origin + "/.well-known/oauth-authorization-server";
  }
  return parsed.origin + "/.well-known/oauth-authorization-server" + path;
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

type DiscoveredMcpOAuth = NonNullable<McpServerConfig["oauth"]> & { authorizationUrl: string; tokenUrl: string; registrationUrl?: string };

async function discoverMcpOAuth(server: McpServerConfig): Promise<DiscoveredMcpOAuth> {
  let oauth = { ...(server.oauth || {}) };
  if ((!oauth.authorizationUrl || !oauth.tokenUrl) && oauth.resourceMetadataUrl) {
    const meta = await getJsonMaybe(oauth.resourceMetadataUrl, server.timeoutMs);
    const issuer = meta?.authorization_servers?.[0] || meta?.authorization_server;
    if (issuer && !oauth.authorizationServerMetadataUrl) {
      oauth.authorizationServerMetadataUrl = oauthAuthorizationServerMetadataUrl(String(issuer));
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
          oauth.authorizationServerMetadataUrl = oauthAuthorizationServerMetadataUrl(String(issuer));
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
  return { ...oauth, authorizationUrl: oauth.authorizationUrl, tokenUrl: oauth.tokenUrl };
}

async function loadMcpOAuthToken(serverId: string): Promise<McpOAuthToken | null> {
  const clean = cleanMcpId(serverId);
  if (!clean) return null;
  const hash = await pointers.get({ name: mcpOAuthTokenRef(clean) });
  if (!hash) return null;
  const row = await objects.getJSON<McpOAuthToken>({ hash, schema: mcpOAuthTokenSchema });
  return row?.value?.access_token ? row.value : null;
}

async function saveMcpOAuthToken(serverId: string, token: McpOAuthToken): Promise<McpOAuthToken> {
  const now = await time.nowMs({});
  const stored: McpOAuthToken = { ...token };
  if (stored.expires_in && !stored.expires_at) stored.expires_at = now + Number(stored.expires_in) * 1000;
  const hash = await objects.putJSON({ kind: "mcp:OAuthToken", value: stored });
  await pointers.set({ name: mcpOAuthTokenRef(serverId), target: hash });
  return stored;
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
  const target = await pointers.get({ name: mcpSessionRef(clean) });
  if (!target) return null;
  const value = decodeJsonPointer<McpSession>(target, mcpSessionSchema);
  if (!value) return null;
  const session: McpSession = {};
  if (value.id?.trim()) session.id = value.id.trim();
  if (Number.isFinite(value.initializedAt)) session.initializedAt = value.initializedAt;
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
  if ((await pointers.get({ name: ref })) !== nextTarget) await pointers.set({ name: ref, target: nextTarget });
}

async function loadMcpSessionId(serverId: string): Promise<string | null> {
  return (await loadMcpSession(serverId))?.id || null;
}

async function saveMcpSessionId(serverId: string, sessionId: string): Promise<void> {
  const value = sessionId.trim();
  if (value) await saveMcpSession(serverId, { id: value });
}

async function markMcpInitialized(serverId: string, sessionId?: string | null): Promise<void> {
  const session: McpSession = { initializedAt: await time.nowMs({}) };
  if (sessionId?.trim()) session.id = sessionId.trim();
  await saveMcpSession(serverId, session);
}

async function clearMcpSessionId(serverId: string): Promise<void> {
  const clean = cleanMcpId(serverId);
  if (clean) await pointers.delete({ name: mcpSessionRef(clean) });
}

function mcpInitializeParams() {
  return {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "moo", version: "0.11.0" },
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
  if (token.expires_at && token.expires_at - (await time.nowMs({})) > 60_000) return token;
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
  const next = mcpOAuthTokenSchema.parse(parseMcpBody(response.body));
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
    for (const pointer of await pointers.list({ prefix: "mcp/" })) {
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
    const hash = await pointers.get({ name: mcpRef(clean) });
    if (!hash) return null;
    const row = await objects.getJSON<McpServerConfig>({ hash, schema: mcpServerConfigSchema });
    return row?.value ? normalizeMcpServer(row.value) : null;
  },
  async saveServer(config: McpServerConfig): Promise<McpServerConfig> {
    const server = normalizeMcpServer(config);
    const hash = await objects.putJSON({ kind: "mcp:ServerConfig", value: server });
    await pointers.set({ name: mcpRef(server.id), target: hash });
    await clearMcpSessionId(server.id);
    return server;
  },
  async removeServer(id: string): Promise<boolean> {
    const clean = cleanMcpId(id);
    if (!clean) return false;
    await pointers.delete({ name: mcpOAuthTokenRef(clean) });
    await clearMcpSessionId(clean);
    return pointers.delete({ name: mcpRef(clean) });
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
    const expiresAt = (await time.nowMs({})) + 10 * 60_000;
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
    await pointers.set({ name: mcpOAuthPendingRef(state), target: hash });
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
    const hash = cleanState ? await pointers.get({ name: mcpOAuthPendingRef(cleanState) }) : null;
    if (!hash) throw new Error("unknown or expired MCP OAuth state");
    const row = await objects.getJSON<McpOAuthPending>({ hash, schema: mcpOAuthPendingSchema });
    const pending = row?.value;
    if (!pending) throw new Error("invalid MCP OAuth state");
    if (pending.expiresAt < await time.nowMs({})) {
      await pointers.delete({ name: mcpOAuthPendingRef(cleanState) });
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
    await pointers.delete({ name: mcpOAuthPendingRef(cleanState) });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`MCP OAuth token exchange failed with HTTP ${response.status}: ${response.body}`);
    }
    const token = mcpOAuthTokenSchema.parse(parseMcpBody(response.body));
    if (!token.access_token) throw new Error("MCP OAuth token response missing access_token");
    await saveMcpOAuthToken(pending.serverId, token);
    await clearMcpSessionId(pending.serverId);
    const status = await mcpCore.authStatus(pending.serverId);
    return pending.returnChatId ? { ...status, returnChatId: pending.returnChatId } : status;
  },
  async logout(serverId: string): Promise<boolean> {
    const clean = cleanMcpId(serverId);
    if (!clean) return false;
    await clearMcpSessionId(clean);
    return pointers.delete({ name: mcpOAuthTokenRef(clean) });
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
        await traces.mark({ message: "mcp.initialize.required", data: { serverId: server.id, method } });
        await mcpCore.request(server.id, "initialize", mcpInitializeParams(), { skipInitialize: true, omitSession: true, timeoutMs: opts.timeoutMs });
      }
    }
    let token = await loadMcpOAuthToken(server.id);
    if (token) token = await refreshMcpOAuthToken(server, token);
    const headers: Record<string, string> = {
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
        id: await id.new({ prefix: "mcp" }),
        method,
        params,
      },
      timeoutMs: opts.timeoutMs ?? server.timeoutMs ?? 60_000,
    });
    const responseSessionId = headerValue(response.headers, "mcp-session-id");
    await traces.mark({ message: "mcp.http.response", data: {
      serverId: server.id,
      method,
      response,
      responseSessionId: responseSessionId ?? null,
      retryingSession: !!opts.retryingSession,
    } });
    if (responseSessionId && method !== "initialize") await saveMcpSessionId(server.id, responseSessionId);
    if (response.status === 401 && server.oauth && !token) {
      throw new Error(`MCP ${server.id} requires OAuth login; run moo.mcp.login("${server.id}") from the UI or use the MCP settings Login button`);
    }
    if (isMcpSessionError(response.status, response.body) && !opts.retryingSession && method !== "initialize") {
      await traces.mark({ message: "mcp.session.retry", data: { serverId: server.id, method, status: response.status } });
      await clearMcpSessionId(server.id);
      await mcpCore.request(server.id, "initialize", mcpInitializeParams(), { skipInitialize: true, omitSession: true, timeoutMs: opts.timeoutMs });
      return mcpCore.request<T>(server.id, method, params, { ...opts, retryingSession: true });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`MCP ${method} failed with HTTP ${response.status}: ${response.body}`);
    }
    const rawPayload = parseMcpBody(response.body);
    const payload = mcpJsonRpcResponseSchema.parse(rawPayload);
    await traces.mark({ message: "mcp.payload", data: {
      serverId: server.id,
      method,
      payload,
    } });
    if (payload.error) {
      throw new Error(payload.error.message || JSON.stringify(payload.error));
    }
    if (method === "initialize") await markMcpInitialized(server.id, responseSessionId);
    return payload.result as T;
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
  publish({ payload }) {
    const text =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    host.broadcast(text);
  },
};

const env: Moo["env"] = {
  async get({ name }) {
    return host.getEnv(name);
  },
  async getMany({ names }) {
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
  const now = await time.nowMs({});
  if (opts.touch) await chat.touch({ chatId });
  const entryId = await id.new({ prefix: "trail" });
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
  const reqId = await id.new({ prefix: "uireq" });
  const payload = await objects.putJSON({ kind: kind, value: spec || {} });
  const now = await time.nowMs({});
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
  return !!(await pointers.get({ name: `ui/${uiId}/manifest` }));
}

const ui: Moo["ui"] = {
  async ask({ chatId, spec }) {
    return recordInputRequest(chatId, "ui:Form", validateAskSpec(spec));
  },
  async choose({ chatId, spec }) {
    return recordInputRequest(chatId, "ui:Choice", validateChooseSpec(spec));
  },
  async say({ chatId, text }) {
    const payload = await objects.putJSON({ kind: "agent:Reply", value: { text, at: await time.nowMs({}) } });
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
      await pointers.set({ name: `ui/${id}/manifest`, target: manifestHash });
      await pointers.set({ name: `ui/${id}/bundle`, target: bundleHash });
      let handlerHash: string | null = null;
      if (handler != null) {
        handlerHash = await objects.putText({ kind: "ui:Handler", text: String(handler) });
        await pointers.set({ name: `ui/${id}/handler`, target: handlerHash });
      }
      await memory.assert({ facts: [
        [`ui:${id}`, "rdf:type", "ui:App"],
        [`ui:${id}`, "ui:title", title],
        [`ui:${id}`, "ui:manifest", manifestHash],
        [`ui:${id}`, "ui:bundle", bundleHash],
        [`ui:${id}`, "ui:updatedAt", new Date(await time.nowMs({})).toISOString()],
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
        instanceId = existing[0]?.["?inst"]?.replace(/^uiinst:/, "") ?? (await id.new({ prefix: "uiinst" }));
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
      let stateTarget = await pointers.get({ name: stateRef });
      let createdState = false;
      if (!stateTarget) {
        stateTarget = encodeJsonPointer(state ?? {});
        await pointers.set({ name: stateRef, target: stateTarget });
        createdState = true;
      }
      events.publish({ payload: { kind: "ui-open", chatId, uiId, instanceId, stateRef, stateTarget, at: await time.nowMs({}) } });
      return { chatId, uiId, instanceId, stateTarget, stateRef, createdState, facts: factReceipt };
    },
  },
};

type ChatUsageSummary = {
  models: Record<string, { input: number; cachedInput: number; cacheWriteInput?: number; output: number }>;
  lastContextTokens?: number;
  lastCompactionPromptTokens?: number;
  consecutiveCompactions?: number;
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

function driverRunningChatState(): {
  running: Set<string>;
  startedAt: Record<string, number>;
} {
  let running: Set<string>;
  let startedAt: Record<string, number>;
  try {
    running = new Set(parseJson(host.runningChatIds(), "driverRunningChatState running"));
  } catch {
    running = new Set();
  }
  try {
    startedAt = parseJson(host.runningChatStartedAt(), "driverRunningChatState startedAt");
  } catch {
    startedAt = {};
  }
  return { running, startedAt };
}

function invalidateChatFactsSummary(store: string): void {
  const m = /^chat\/([^/]+)\/facts$/.exec(String(store || ""));
  if (m) chatFactsSummaryCache.delete(m[1]!);
}

async function summarizeAllChatFacts(): Promise<Map<string, ChatFactsSummary>> {
  // The host op throws on a DB/serialization error; don't let one transient
  // failure abort the whole chat listing — degrade to no summaries instead.
  const raw = ((): Record<string, ChatFactsSummary | undefined> => {
    try {
      return parseJson(host.chatFactSummaries(), "summarizeAllChatFacts") as Record<
        string,
        ChatFactsSummary | undefined
      >;
    } catch {
      return {};
    }
  })();
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
  return await pointers.get({ name: `chat/${chatId}/path` });
}

async function chatWorktreePath(chatId: string): Promise<string> {
  const existing = await pointers.get({ name: `chat/${chatId}/worktree-path` });
  if (existing && existing.trim()) return existing.trim();
  const home = ((await env.get({ name: "HOME" })) || "").trim();
  const base = home ? joinPath(home, "moo") : "moo";
  return joinPath(base, chatId);
}

const canonicalDirCache = new Map<string, Promise<string>>();

async function canonicalDir(path: string): Promise<string> {
  let promise = canonicalDirCache.get(path);
  if (!promise) {
    promise = (async () => {
      try {
        return await fs.canonical({ path: path });
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
      provider: c.provider,
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
      startBranch: c.startBranch,
      startBranchRef: c.startBranch,
    };
  },
  async scratch({ chatId }) {
    const root = await chatScratchRoot(chatId);
    const path = await chatWorktreePath(chatId);
    if (await fs.exists({ path: path })) return await canonicalDir(path);
    const parentPath = path.split("/").slice(0, -1).join("/") || ".";
    await fs.ensureDir({ path: parentPath });
    // Repo-less chats deliberately have no checkout root. Give them an empty
    // per-chat scratch directory instead of treating "." as an implicit repo.
    if (!root) {
      await fs.ensureDir({ path: path });
      return await canonicalDir(path);
    }
    // If the cwd is a JJ repo, prefer a real `jj workspace add` so the agent
    // gets an isolated checkout/workspace. Fall back to Git worktrees or a
    // plain mkdir when repo-specific workspace creation fails.
    if (await fs.exists({ path: joinPath(root, ".jj") })) {
      const startRevision = (await pointers.get({ name: `chat/${chatId}/start-branch` }))?.trim() || "@";
      let result = await proc.run({ cmd: ["jj", "workspace", "add", "--quiet", "--revision", startRevision, path], ...{ cwd: root, timeoutMs: 10_000 } });
      if (result.code !== 0 && startRevision !== "@") {
        result = await proc.run({ cmd: ["jj", "workspace", "add", "--quiet", "--revision", "@", path], ...{ cwd: root, timeoutMs: 10_000 } });
      }
      if (result.code === 0) return await canonicalDir(path);
    }
    // If the cwd is a git repo, prefer a real `git worktree add` from the
    // selected start branch (or HEAD) so the agent gets per-chat diffs and
    // clean state.
    if (await fs.exists({ path: joinPath(root, ".git") })) {
      const startBranch = (await pointers.get({ name: `chat/${chatId}/start-branch` }))?.trim() || "HEAD";
      let result = await proc.run({ cmd: ["git", "worktree", "add", "--quiet", "--detach", path, startBranch], ...{ cwd: root, timeoutMs: 10_000 } });
      if (result.code !== 0 && startBranch !== "HEAD") {
        result = await proc.run({ cmd: ["git", "worktree", "add", "--quiet", "--detach", path, "HEAD"], ...{ cwd: root, timeoutMs: 10_000 } });
      }
      if (result.code === 0) return await canonicalDir(path);
    }
    await fs.ensureDir({ path: path });
    return await canonicalDir(path);
  },
  async touch({ chatId }) {
    const createdRef = `chat/${chatId}/created-at`;
    const existing = await pointers.get({ name: createdRef });
    if (!existing) {
      await pointers.set({ name: createdRef, target: String(await time.nowMs({})) });
    }
    await pointers.set({ name: `chat/${chatId}/last-at`, target: String(await time.nowMs({})) });
  },
  async list() {
    const all = await pointers.entries({ prefix: "chat/" });
    const ids = new Set<string>();
    const byChat = new Map<string, Record<string, string>>();
    // The Rust driver is the source of truth for active foreground turns.
    // Persisted step rows can legitimately stay agent:Running after a runTS tool
    // is detached to the background; those rows should keep their spinner/cancel
    // affordance, but they must not make the chat summary/sidebar look busy.
    const { running, startedAt: runningStartedAt } = driverRunningChatState();
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
        const baseBranch = refsForChat["start-branch"] || null;
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
        const worktreePath = refsForChat["worktree-path"] || null;
        const status = summary.status === "ui:Pending"
          ? "ui:Pending"
          : running.has(cid)
            ? "agent:Running"
            : summary.status === "agent:Running"
              ? "agent:Done"
              : summary.status;
        return {
          chatId: cid,
          title: title || null,
          createdAt: created ? Number(created) : 0,
          lastAt: lastAt ? Number(lastAt) : created ? Number(created) : 0,
          head: head || null,
          path,
          baseBranch,
          worktreePath,
          archived: archivedAt != null,
          archivedAt,
          hidden: hiddenRaw === "true",
          parentChatId,
          totalFacts: summary.totalFacts,
          totalTurns: summary.totalTurns,
          totalSteps: summary.totalSteps,
          status,
          runningStartedAt: status === "agent:Running" ? (runningStartedAt[cid] ?? null) : null,
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
  async create(args = {}) {
    const { chatId, path = null, branch = null, useExistingWorktree = false } = args;
    const opts = { branch };
    let cid = chatId;
    if (!cid) {
      const raw = await id.new({ prefix: "chat" });
      // Host ids are `chat:<nanoid-ish payload>`; chat metadata stores just the payload.
      cid = raw.replace(/^chat:/, "");
    }
    if (path && String(path).trim()) {
      await pointers.set({ name: `chat/${cid}/path`, target: String(path).trim() });
      if (useExistingWorktree) {
        await pointers.set({ name: `chat/${cid}/worktree-path`, target: await canonicalDir(String(path).trim()) });
      }
    }
    if (opts.branch && String(opts.branch).trim()) {
      await pointers.set({ name: `chat/${cid}/start-branch`, target: String(opts.branch).trim() });
    }
    await chat.touch({ chatId: cid });
    if (!useExistingWorktree || !path || !String(path).trim()) {
      await chat.scratch({ chatId: cid });
    }
    return cid;
  },
  async remove({ chatId }) {
    if (!chatId) throw new Error("remove requires chatId");
    const root = await chatScratchRoot(chatId);
    const path = await chatWorktreePath(chatId);
    const explicitWorktree = await pointers.get({ name: `chat/${chatId}/worktree-path` });
    forgetCanonicalDir(path);
    if (explicitWorktree) {
      const all = await pointers.list({ prefix: `chat/${chatId}/` });
      let clearedQuads = 0;
      for (const name of all) {
        if (name.endsWith("/facts")) {
          clearedQuads += (await facts.deleteStore({ store: name })).removed;
        }
        await pointers.delete({ name: name });
      }
      clearedQuads += (await facts.deleteStore({ store: `chat/${chatId}/facts` })).removed;
      return { chatId, refsDeleted: all.length, quadsCleared: clearedQuads };
    }
    // If this scratch was set up as a git worktree, the directory contains a
    // .git *file* (not a dir) pointing back at the main repo. Clean it via
    // the git CLI so we don't leave dangling worktree metadata.
    const gitFile = await fs.stat({ path: `${path}/.git` });
    if (gitFile && gitFile.kind === "file") {
      await proc.run({ cmd: ["git", "worktree", "remove", "--force", path], timeoutMs: 10_000 });
    } else if (await fs.exists({ path: path })) {
      await proc.run({ cmd: ["rm", "-rf", path], timeoutMs: 10_000 });
    }
    const all = await pointers.list({ prefix: `chat/${chatId}/` });
    let clearedQuads = 0;
    for (const name of all) {
      if (name.endsWith("/facts")) {
        clearedQuads += (await facts.deleteStore({ store: name })).removed;
      }
      await pointers.delete({ name: name });
    }
    clearedQuads += (await facts.deleteStore({ store: `chat/${chatId}/facts` })).removed;
    return { chatId, refsDeleted: all.length, quadsCleared: clearedQuads };
  },
  async setTitle({ chatId, title, manual }: { chatId: string; title: string | null; manual?: boolean }) {
    const ref = `chat/${chatId}/title`;
    const manualRef = `chat/${chatId}/title-manual`;
    const previousTitle = await pointers.get({ name: ref });
    const nextTitle = title == null || title.trim() === "" ? null : title.trim();
    const manualTitle = await pointers.get({ name: manualRef });
    if (!manual && manualTitle && (previousTitle || null) === manualTitle && nextTitle !== manualTitle) {
      return { chatId, previousTitle: previousTitle || null, title: previousTitle || null, changed: false };
    }
    if (nextTitle == null) {
      await pointers.delete({ name: ref });
      if (manual) await pointers.delete({ name: manualRef });
    } else {
      await pointers.set({ name: ref, target: nextTitle });
      if (manual) await pointers.set({ name: manualRef, target: nextTitle });
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
  async archive({ chatId }) {
    const at = String(await time.nowMs({}));
    await pointers.set({ name: `chat/${chatId}/archived-at`, target: at });
    return Number(at);
  },
  async unarchive({ chatId }) {
    await pointers.delete({ name: `chat/${chatId}/archived-at` });
    return null;
  },
};

const MAX_SUBAGENT_DEPTH = 1;
const MAX_OUTSTANDING_SUBAGENTS_PER_RUNTS = 4;
const DEFAULT_SUBAGENT_STEPS = 20;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60_000;
const MAX_SUBAGENT_TIMEOUT_MS = 30 * 60_000;

type NormalizedSubagentSpec = Required<Pick<SubagentSpec, "label" | "task" | "worktree">> & Omit<SubagentSpec, "label" | "task" | "worktree"> & {
  maxSteps: number;
  timeoutMs: number;
  scratchName?: string;
};

function normalizeSubagentSpec(spec: SubagentSpec): NormalizedSubagentSpec {
  if (!spec || typeof spec !== "object") throw new Error("moo.agent.run requires a spec object");
  const label = String(spec.label ?? "").trim();
  const task = String(spec.task ?? "").trim();
  if (!label) throw new Error("moo.agent.run requires spec.label");
  if (!task) throw new Error("moo.agent.run requires spec.task");
  const tasks = Array.isArray(spec.tasks) ? spec.tasks : undefined;
  const maxSteps = Math.max(1, Math.floor(Number(spec.maxSteps ?? DEFAULT_SUBAGENT_STEPS) || DEFAULT_SUBAGENT_STEPS));
  const timeoutMs = Math.max(1_000, Math.min(MAX_SUBAGENT_TIMEOUT_MS, Math.floor(Number(spec.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS) || DEFAULT_SUBAGENT_TIMEOUT_MS)));
  const worktree = spec.worktree === "inherit" ? "inherit" : "isolated";
  const scratchName = typeof spec.scratchName === "string" && spec.scratchName.trim()
    ? spec.scratchName.trim()
    : undefined;
  return {
    ...spec,
    label,
    task,
    maxSteps,
    timeoutMs,
    worktree,
    ...(tasks && tasks.length ? { tasks } : {}),
    ...(typeof spec.context === "string" && spec.context.trim() ? { context: spec.context } : {}),
    ...(typeof spec.expectedOutput === "string" && spec.expectedOutput.trim() ? { expectedOutput: spec.expectedOutput } : {}),
    ...(typeof spec.model === "string" && spec.model.trim() ? { model: spec.model.trim() } : {}),
    ...(typeof spec.effort === "string" && spec.effort.trim() ? { effort: spec.effort.trim() } : {}),
    ...(typeof spec.scratchName === "string" && spec.scratchName.trim() ? { scratchName: spec.scratchName.trim() } : {}),
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

function buildSubagentTask(spec: NormalizedSubagentSpec): string {
  const parts = [
    "You are a bounded subagent delegated by a parent agent.",
    "Complete only the assigned task. Do not ask the user questions. Return a concise final report with evidence and file links when relevant.",
    `Task label: ${spec.label}`,
    `Task:\n${spec.task}`,
  ];
  if (spec.context?.trim()) parts.push(`Context:\n${spec.context}`);
  if (spec.expectedOutput?.trim()) parts.push(`Expected output:\n${spec.expectedOutput}`);
  return parts.join("\n\n");
}

function subagentStepState(childChatId: string, message: string, artificial: boolean) {
  return {
    chatId: childChatId,
    mode: "step",
    message,
    artificial,
    lifecycleEvents: {
      start: { kind: "step-start", chatId: childChatId },
      end: { kind: "step-end", chatId: childChatId },
    },
  };
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
  const stepId = await pointers.get({ name: `chat/${childChatId}/parent-step` });
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

async function createSubagentRunRequest(spec: NormalizedSubagentSpec, opts: { allowNested?: boolean } = {}) {
  const ctx = activeRunTSContext;
  if (!ctx) throw new Error("moo.agent.run is only available inside runTS");
  if (!opts.allowNested && ctx.depth >= MAX_SUBAGENT_DEPTH) throw new Error("subagent depth limit reached");
  if (ctx.outstanding.size >= MAX_OUTSTANDING_SUBAGENTS_PER_RUNTS) {
    throw new Error(`too many outstanding subagents; max is ${MAX_OUTSTANDING_SUBAGENTS_PER_RUNTS}`);
  }

  const parentChatId = ctx.chatId;
  const parentRoot = await pointers.get({ name: `chat/${parentChatId}/path` });
  let selectedScratch: string;
  if (typeof spec.scratchName === "string" && spec.scratchName.trim()) {
    const scratchName = spec.scratchName.trim();
    const namedScratch = await scratchNamedPath(parentChatId, scratchName);
    if (!namedScratch) throw new Error(`unknown scratchName "${scratchName}"; create it with moo.scratches.create({ name: "${scratchName}" }) first`);
    selectedScratch = namedScratch;
  } else {
    selectedScratch = await chat.scratch({ chatId: parentChatId });
  }
  const rawChildChatId = await id.new({ prefix: "chat" });
  const childChatId = rawChildChatId.replace(/^chat:/, "");
  // chat.list() discovers a chat from its first pointer. Mark subagents hidden
  // before chat.create() writes path/created-at so a concurrent sidebar refresh
  // can never observe the child as a normal visible chat.
  await pointers.set({ name: `chat/${childChatId}/hidden`, target: "true" });
  await pointers.set({ name: `chat/${childChatId}/parent`, target: parentChatId });
  await chat.create({
    chatId: childChatId,
    path: parentRoot,
    useExistingWorktree: true,
  });
  await pointers.set({ name: `chat/${childChatId}/worktree-path`, target: await canonicalDir(selectedScratch) });
  await chat.setTitle({ chatId: childChatId, title: truncateTitle(spec.label) });
  await pointers.set({ name: `chat/${childChatId}/subagent-depth`, target: String(ctx.depth + 1) });
  await pointers.set({ name: `chat/${childChatId}/subagent-parent-runts`, target: ctx.runTsStepId });
  await applyDefaultChatSettings(childChatId);
  if (spec.model) await pointers.set({ name: chatRefs(childChatId).model, target: spec.model });
  if (spec.effort) await pointers.set({ name: chatRefs(childChatId).effort, target: spec.effort });
  if (Array.isArray(spec.tasks) && spec.tasks.length) {
    await patchTasks(childChatId, { add: spec.tasks });
  }

  const specHash = await objects.putJSON({ kind: "agent:SubagentSpec", value: spec });
  await pointers.set({ name: `chat/${childChatId}/subagent-spec`, target: specHash });

  const payloadHash = await objects.putJSON({ kind: "agent:Subagent", value: {
    label: spec.label,
    task: spec.task,
    context: spec.context ?? null,
    expectedOutput: spec.expectedOutput ?? null,
    scratchName: spec.scratchName ?? null,
    childChatId,
    parentRunTsStepId: ctx.runTsStepId,
  } });
  const appended = await appendStep(parentChatId, {
    kind: "agent:Subagent",
    status: "agent:Running",
    payloadHash,
    extras: [
      ["agent:childChat", childChatId],
      ["agent:parentRunTS", ctx.runTsStepId],
    ],
  });
  await pointers.set({ name: `chat/${childChatId}/parent-step`, target: appended.stepId });
  ctx.outstanding.add(childChatId);

  if (spec.worktree === "inherit") {
    // Never share writable dirs. For now inherit only selects the same repo root;
    // the child still gets its own lazy git worktree from chat.scratch().
    await pointers.set({ name: `chat/${childChatId}/worktree-mode`, target: "inherit" });
  }

  return {
    requestId: await id.new({ prefix: "subagent" }),
    parentChatId,
    parentRunTsStepId: ctx.runTsStepId,
    parentSubagentStepId: appended.stepId,
    childChatId,
    state: subagentStepState(childChatId, buildSubagentTask(spec), true),
    limits: {
      maxSteps: spec.maxSteps,
      timeoutMs: spec.timeoutMs,
      depth: ctx.depth + 1,
    },
  };
}

async function finishSubagentRun(childChatId: string, result: SubagentResult) {
  result = normalizeSubagentResult(result as LegacySubagentResult);
  const ctx = activeRunTSContext;
  const parentChatId = ctx?.chatId || (await pointers.get({ name: `chat/${childChatId}/parent` }));
  const stepId = await pointers.get({ name: `chat/${childChatId}/parent-step` });
  if (ctx) ctx.outstanding.delete(childChatId);
  if (!parentChatId || !stepId) return;
  const resultHash = await objects.putJSON({ kind: "agent:ToolResult", value: result });
  const extras: Array<[string, string]> = [["agent:result", resultHash]];
  if (result.error) extras.push(["agent:error", String(result.error)]);
  await replaceStepStatus(parentChatId, stepId, statusForSubagentResult(result.status), extras);
}

async function failSubagentRun(childChatId: string | null, err: unknown) {
  if (!childChatId) return;
  const message = err && typeof err === "object" && "message" in err ? String((err as { readonly message?: unknown }).message || String(err)) : String(err);
  const result: SubagentResult = {
    status: "failed",
    childChatId,
    output: "",
    error: message,
    durationNs: 0,
  };
  await finishSubagentRun(childChatId, result);
}

async function runSubagent(spec: SubagentSpec, opts: { allowNested?: boolean } = {}): Promise<SubagentResult> {
  const normalized = normalizeSubagentSpec(spec);
  let request: Awaited<ReturnType<typeof createSubagentRunRequest>> | null = null;
  try {
    request = await createSubagentRunRequest(normalized, opts);
    const raw = await host.runAgent(JSON.stringify(request));
    const result = normalizeSubagentResult(parseJson(raw, "runSubagent") as LegacySubagentResult);
    await finishSubagentRun(request.childChatId, result);
    return result;
  } catch (err) {
    try {
      await failSubagentRun(request?.childChatId ?? null, err);
    } catch {
      // best-effort cleanup; don't let it mask the original failure
    }
    throw err;
  }
}

const agent: Moo["agent"] = {
  async claim({ store, graph, runId, leaseMs = 60_000 }) {
    const queued = await facts.match({ store, ...{
      graph,
      predicate: "agent:status",
      object: "agent:Queued",
    } });
    const candidates: { stepId: string; createdAt: number }[] = [];
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
      const createdRows = await facts.match({ store, ...{
        graph,
        subject: stepId,
        predicate: "agent:createdAt",
        limit: 1,
      } });
      const createdAt = createdRows.length ? Number(createdRows[0]![3]) : NaN;
      candidates.push({
        stepId,
        createdAt: Number.isFinite(createdAt) ? createdAt : Number.MAX_SAFE_INTEGER,
      });
    }
    // Claim in enqueue order; facts.match row order is not FIFO.
    candidates.sort((a, b) => a.createdAt - b.createdAt);
    for (const { stepId } of candidates) {
      const leaseId = await id.new({ prefix: "lease" });
      const expiresAt = (await time.nowMs({})) + leaseMs;
      await facts.update({ store, fn: (txn) => {
        txn.remove({ graph: graph, subject: stepId, predicate: "agent:status", object: "agent:Queued" });
        txn.add({ graph: graph, subject: stepId, predicate: "agent:status", object: "agent:Running" });
        txn.add({ graph: graph, subject: stepId, predicate: "agent:lease", object: leaseId });
        txn.add({ graph: graph, subject: leaseId, predicate: "agent:expiresAt", object: String(expiresAt) });
      } });
      // swapFacts has no compare-and-swap, so two concurrent claims can both
      // lease the same step. Arbitrate deterministically on the lease rows
      // and roll back the loser so exactly one caller runs the step.
      const leases = await facts.match({ store, ...{
        graph,
        subject: stepId,
        predicate: "agent:lease",
      } });
      if (leases.length > 1) {
        const winner = leases.map((row) => row[3]).sort()[0];
        if (winner !== leaseId) {
          await facts.update({ store, fn: (txn) => {
            txn.remove({ graph: graph, subject: stepId, predicate: "agent:lease", object: leaseId });
            txn.remove({ graph: graph, subject: leaseId, predicate: "agent:expiresAt", object: String(expiresAt) });
          } });
          continue;
        }
      }
      return { stepId, leaseId, expiresAt };
    }
    return null;
  },
  async complete({ store, graph, stepId, status = "agent:Done" }) {
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
  async fork({ chatId, fromStepId = null }) {
    const c = {
      facts: `chat/${chatId}/facts`,
      run: `chat/${chatId}/run`,
      graph: `chat:${chatId}`,
      head: `chat/${chatId}/head`,
    };
    const runId = await id.new({ prefix: "run" });
    const forkedFrom = fromStepId ?? (await pointers.get({ name: c.head }));
    await pointers.set({ name: c.run, target: runId });
    await facts.update({ store: c.facts, fn: (txn) => {
      txn.add({ graph: c.graph, subject: runId, predicate: "rdf:type", object: "agent:Run" });
      txn.add({ graph: c.graph, subject: runId, predicate: "agent:chat", object: c.graph });
      txn.add({ graph: c.graph, subject: runId, predicate: "agent:createdBy", object: "agent:moo" });
      if (forkedFrom) txn.add({ graph: c.graph, subject: runId, predicate: "agent:forkedFrom", object: forkedFrom });
    } });
    return { chatId, runId, forkedFrom };
  },
  async start(spec: AgentStartSpec) {
    if (!activeRunTSContext) throw new Error("moo.agent.start is only available inside runTS");
    if (!spec || typeof spec !== "object") throw new Error("moo.agent.start requires a spec object");
    const task = String(spec.task ?? "").trim();
    if (!task) throw new Error("moo.agent.start requires spec.task");
    const parentChatId = activeRunTSContext.chatId;
    const inherit = spec.inherit !== false;
    const inheritedPath = inherit ? await pointers.get({ name: `chat/${parentChatId}/path` }) : null;
    const inheritedBranch = inherit ? await pointers.get({ name: `chat/${parentChatId}/start-branch` }) : null;
    const inheritedModel = inherit ? await pointers.get({ name: chatRefs(parentChatId).model }) : null;
    const inheritedEffort = inherit ? await pointers.get({ name: chatRefs(parentChatId).effort }) : null;
    const chatId = await chat.create({
      path: typeof spec.path === "string" && spec.path.trim() ? spec.path.trim() : inheritedPath,
      branch: typeof spec.branch === "string" && spec.branch.trim() ? spec.branch.trim() : inheritedBranch,
    });
    try {
      await applyDefaultChatSettings(chatId);
      const model = typeof spec.model === "string" && spec.model.trim() ? spec.model.trim() : inheritedModel;
      const effort = typeof spec.effort === "string" && spec.effort.trim() ? spec.effort.trim() : inheritedEffort;
      if (model) await pointers.set({ name: `chat/${chatId}/model`, target: model });
      if (effort) await pointers.set({ name: `chat/${chatId}/effort`, target: effort });
      if (typeof spec.title === "string" && spec.title.trim()) await chat.setTitle({ chatId, title: spec.title.trim(), manual: true });
      const response = parseJson(await host.runAgent(JSON.stringify({
        mode: "start",
        childChatId: chatId,
        state: subagentStepState(chatId, task, false),
        limits: {
          maxSteps: Math.max(1, Math.floor(Number(spec.maxSteps ?? DEFAULT_SUBAGENT_STEPS) || DEFAULT_SUBAGENT_STEPS)),
          timeoutMs: Math.max(1_000, Math.min(MAX_SUBAGENT_TIMEOUT_MS, Math.floor(Number(spec.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS) || DEFAULT_SUBAGENT_TIMEOUT_MS))),
        },
      })), "agent start result");
      if (!response || typeof response !== "object" || (response as any).chatId !== chatId) throw new Error("moo.agent.start received an invalid host response");
      return { chatId };
    } catch (error) {
      await chat.remove({ chatId }).catch(() => undefined);
      throw error;
    }
  },
  async run(spec: SubagentSpec): Promise<SubagentResult> {
    return await runSubagent(spec);
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
  const git = await proc.run({ cmd: ["git", "rev-parse", "--show-toplevel"], ...{ timeoutMs: 2_000 } });
  if (git.code === 0 && git.stdout.trim()) return git.stdout.trim();
  const pwd = await env.get({ name: "PWD" });
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
  project(args: { projectId?: string } = {}): MemoryScope {
    const projectId = args.projectId;
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
          await pointers.set({ name: store, target: raw });
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
  async define({ name, description, example, label }) {
    const opts = { description, example, label };
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
      ...(await pointers.list({ prefix: PROJECT_MEMORY_REF_PREFIX })),
      ...(await pointers.list({ prefix: "chat/" })).filter((name) =>
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

export const tryApi: Moo["try"] = async ({ fn }) => {
  try {
    return ok(await fn());
  } catch (e) {
    return err(errorInfo(e));
  }
};

const tools: Moo["tools"] = {
  async cancel({ id, stepId, chatId }) {
    const targetChatId = String(chatId ?? activeChatId ?? "").trim();
    if (!targetChatId) throw new Error("moo.tools.cancel requires chatId outside an active chat context");
    const rawStepId = stepId ?? id ?? null;
    const targetStepId = normalizeRunTSStepId(rawStepId);
    const raw = host.cancelRunTS(targetChatId, targetStepId || null);
    const parsed = parseJson(raw, "tools.cancel") as {
      chatId?: string;
      stepId?: string | null;
      cancelled?: number;
    };
    const cancelled = Number(parsed.cancelled ?? 0);
    const resolvedStepId = parsed.stepId ?? (targetStepId || null);
    return {
      chatId: parsed.chatId ?? targetChatId,
      stepId: resolvedStepId,
      cancelled,
      status: cancelled > 0 ? "cancelled" : "not-found",
      message:
        cancelled > 0
          ? `cancelled ${cancelled} runTS step${cancelled === 1 ? "" : "s"}${resolvedStepId ? ` (${resolvedStepId})` : ""}`
          : `no cancellable runTS step found${resolvedStepId ? ` (${resolvedStepId})` : ""}`,
    };
  },
};

function normalizeRunTSStepId(raw: unknown): string | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  return text.match(/step:[A-Za-z0-9_-]+/)?.[0] ?? text;
}

const rawMoo: Moo = {
  try: tryApi,
  time,
  validate,
  id,
  log,
  objects,
  tasks,
  skills,
  pointers,
  sparql,
  facts,
  fs,
  proc,
  workspace,
  scratch: scratches,
  scratches,
  http,
  env,
  chat,
  ui,
  mcp,
  tools,
  agent,
  judge,
  memory,
  vocab,
  events,
  traces,
  term,
};

const TRACE_SKIP_ROOTS = new Set(["traces"]);

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return !!value && (typeof value === "object" || typeof value === "function") && typeof (value as { readonly then?: unknown }).then === "function";
}

type TraceJsonContext = "input" | "output" | "error" | "event";
type TraceRedactOpts = { context?: TraceJsonContext };

function ctorName(value: unknown): string | null {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
  const name = (value as { readonly constructor?: { readonly name?: unknown } }).constructor?.name;
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

function errorTraceValue(error: Error, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: "error",
    name: typeof error.name === "string" ? error.name : ctorName(error) ?? "Error",
    message: typeof error.message === "string" ? error.message : String(error),
  };
  if (typeof error.stack === "string") out.stack = error.stack;
  for (const key of Reflect.ownKeys(error)) {
    if (key === "name" || key === "message" || key === "stack") continue;
    const desc = Object.getOwnPropertyDescriptor(error, key);
    if (!desc || !("value" in desc)) continue;
    out[String(key)] = traceJsonInner(desc.value, seen);
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
    if (ArrayBuffer.isView(value)) {
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
    const record = value as { readonly result?: unknown; readonly rows?: unknown };
    const result = record.result;
    if (Array.isArray(result)) return result.length;
    const rows = record.rows;
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
type TraceNativeGlobal = typeof globalThis & Record<string, unknown>;
type TraceNativeFunction = ((this: unknown, ...args: unknown[]) => unknown) & { readonly [key: symbol]: unknown };

function installNativeOpTracing(): void {
  const g = globalThis as TraceNativeGlobal;
  for (const op of host.TRACED_NATIVE_OPS) {
    const original = g[op.globalName];
    if (typeof original !== "function") continue;
    const originalFn = original as TraceNativeFunction;
    if (originalFn[TRACE_NATIVE_WRAPPED]) continue;
    const wrapped = function(this: unknown, ...opArgs: unknown[]) {
      return traceNativeOp(op.traceName, opArgs, () => originalFn.apply(this, opArgs));
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
