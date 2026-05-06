import type { Moo, Quad, Bindings, Triple, ObjectInput, MemoryScope, UiAskSpec, UiChooseSpec, UiBundle, UiManifest, FactQuadInput, McpServerConfig, McpTool, McpOAuthStartOptions, McpOAuthStatus, McpOAuthStart, SubagentSpec, SubagentResult, FactMutationReceipt, ProcRunArgs, ProcResult, FsPatchArgs, FsPatchReceipt, TermBindings, BindingTerm, QuadObject, TraceRow, TraceTreeNode, TraceSummary, TraceDiagnostic } from "./types";
import { err, ok, errorInfo } from "./core/result";
import { Term, MooApiError } from "./types";
import { assertFactObject, assertFactObjects, chatRefs, unpackQuad, stringifyForLog } from "./lib";
import { appendStep } from "./steps";

// IRIs and prefixed names render bare. Anything else is encoded as a Turtle
// string literal with proper escaping. Numbers and booleans become bare
// numeric/boolean literals. Variables (`?x`) pass through.
function encodeObject(o: ObjectInput): string {
  if (o instanceof Term) return o.turtle;
  if (typeof o === "number") {
    if (!Number.isFinite(o)) return `"${String(o)}"`;
    return String(o);
  }
  if (typeof o === "boolean") return o ? "true" : "false";
  if (typeof o === "string") {
    if (o.startsWith("?")) return o; // variable
    if (/^[A-Za-z][A-Za-z0-9_-]*:[^\s]+$/.test(o)) return o; // prefixed IRI
    if (/^<[^>\s]+>$/.test(o)) return o; // full IRI
    return encodeStringLiteral(o);
  }
  return encodeStringLiteral(String(o));
}

function encodeStringLiteral(s: string): string {
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out + '"';
}

const HASH_RE = /^(sha256:)?[a-f0-9]{64}$/i;
const UI_APP_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const REF_NAME_RE = /^[^\s]+$/;
const POINTER_NAME_RE = /^(?!.*\[object\s+Promise\])[^\s]+$/;
const GRAPH_NAME_RE = /^[^\s]+$/;

const validate: Moo["validate"] = {
  pointerName(name) {
    return typeof name === "string" && name.length > 0 && POINTER_NAME_RE.test(name);
  },
  factStoreName(name) {
    return typeof name === "string" && name.length > 0 && REF_NAME_RE.test(name);
  },
  graphName(graph) {
    return typeof graph === "string" && graph.length > 0 && GRAPH_NAME_RE.test(graph);
  },
  uiAppId(id) {
    return typeof id === "string" && UI_APP_ID_RE.test(id);
  },
  hash(hash) {
    return typeof hash === "string" && HASH_RE.test(hash);
  },
  relativePath(path) {
    if (typeof path !== "string" || path.length === 0 || path.startsWith("/")) return false;
    return !path.split("/").some((seg) => seg === "..");
  },
};

const term: Moo["term"] = {
  iri(uri) {
    if (/^<[^>\s]+>$/.test(uri)) return new Term(uri);
    if (/^[A-Za-z][A-Za-z0-9_-]*:[^\s]+$/.test(uri)) return new Term(uri);
    return new Term(`<${uri}>`);
  },
  string(s, opts) {
    let t = encodeStringLiteral(s);
    if (opts?.lang) t += `@${opts.lang}`;
    else if (opts?.type) t += `^^${opts.type}`;
    return new Term(t);
  },
  int(n) {
    return new Term(String(Math.trunc(n)));
  },
  decimal(n) {
    const s = String(n);
    return new Term(s.includes(".") ? s : `${s}.0`);
  },
  bool(b) {
    return new Term(b ? "true" : "false");
  },
  datetime(d) {
    const iso = typeof d === "string" ? d : d.toISOString();
    return new Term(`"${iso}"^^xsd:dateTime`);
  },
};

const time: Moo["time"] = {
  async nowMs() {
    return __op_now();
  },
  async nowISO() {
    return new Date(__op_now()).toISOString();
  },
  async datetime(d) {
    const value = d == null ? new Date(__op_now()) : typeof d === "number" ? new Date(d) : d;
    return term.datetime(value);
  },
  async nowPlus(ms) {
    return __op_now() + Number(ms);
  },
};

const id: Moo["id"] = {
  async new(prefix = "id") {
    return __op_id(prefix);
  },
};

const log: Moo["log"] = (...args) => {
  const message = args.map(stringifyForLog).join(" ");
  const chatId = activeChatId;
  if (!chatId) return;
  const c = chatRefs(chatId);
  const logId = __op_id("log");
  const at = String(__op_now());
  __op_facts_swap(
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
let activeRunJSContext: { chatId: string; runJsStepId: string; depth: number; outstanding: Set<string>; traceId?: string | null } | null = null;

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
    return await fn();
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

export function startRunJSTraceRoot(stepId: string | null, data: Record<string, unknown> = {}) {
  const raw = __op_trace_start_root(stepId, JSON.stringify(redactedTraceValue("runjs.root", data, "input")));
  const cur = raw ? JSON.parse(raw) : null;
  if (activeRunJSContext && cur?.traceId) activeRunJSContext.traceId = cur.traceId;
  return cur;
}
export const startTraceRoot = startRunJSTraceRoot;

export function finishRunJSTraceRoot(info: TraceRootInfo) {
  let shouldLeave = false;
  try {
    const current = __op_trace_current();
    const cur = current ? JSON.parse(current) : null;
    const traceId = info.traceId || cur?.traceId;
    if (!traceId) return false;
    shouldLeave = true;
    const root = __op_trace_get(JSON.stringify({ traceId }));
    const row = root ? JSON.parse(root) : null;
    const data = {
      ...(row?.data && typeof row.data === "object" ? row.data : {}),
      ...(info.resultHash ? { resultHash: info.resultHash } : {}),
      ...(info.error ? { error: info.error } : {}),
    };
    return __op_trace_finish(traceId, info.status || (info.error ? "error" : "ok"), JSON.stringify(redactedTraceValue("runjs.root", data, "input")));
  } finally {
    if (shouldLeave) {
      try {
        __op_trace_leave();
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
    const parentId = typeof node.data?.parentId === "string" ? node.data.parentId : null;
    if (!parentId || !nodes.has(parentId)) {
      if (node.kind === "trace" || !root) root = node;
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

function traceDurationMs(row: TraceRow): number | undefined {
  if (typeof row.t0Ns !== "number" || typeof row.t1Ns !== "number") return undefined;
  return Math.max(0, (row.t1Ns - row.t0Ns) / 1_000_000);
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

function inclusiveMs(row: TraceRow): number {
  return traceDurationMs(row) ?? 0;
}

function traceDataBytes(row: TraceRow): number {
  try {
    return stringBytes(JSON.stringify(row.data ?? {}));
  } catch {
    return 0;
  }
}

function buildTracePayloadMetrics(rows: TraceRow[]): Record<string, unknown> {
  const byKind = new Map<string, { count: number; bytes: number }>();
  const largest = rows
    .map((row) => ({ id: row.id, name: row.name, kind: row.kind, status: row.status, bytes: traceDataBytes(row) }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 20);
  let totalBytes = 0;
  for (const row of rows) {
    const bytes = traceDataBytes(row);
    totalBytes += bytes;
    const cur = byKind.get(row.kind) ?? { count: 0, bytes: 0 };
    cur.count += 1;
    cur.bytes += bytes;
    byKind.set(row.kind, cur);
  }
  return {
    rows: rows.length,
    dataBytes: totalBytes,
    byKind: Array.from(byKind.entries()).map(([kind, value]) => ({ kind, ...value })).sort((a, b) => b.bytes - a.bytes || b.count - a.count),
    largest,
  };
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
    const children = (byParent.get(current.id) ?? []).filter((row) => traceDurationMs(row) != null);
    current = children.sort((a, b) => inclusiveMs(b) - inclusiveMs(a))[0] ?? null;
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
      durationMs: traceDurationMs(row) ?? null,
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
    .filter((row) => traceDurationMs(row) != null)
    .sort((a, b) => inclusiveMs(b) - inclusiveMs(a))
    .slice(0, 20)
    .map((row) => ({ row, durationMs: inclusiveMs(row) }));
  const summary: any = {
    traceId: root.traceId,
    status: root.status,
    root,
    ...(traceDurationMs(root) !== undefined ? { durationMs: traceDurationMs(root) } : {}),
    ...(errors[0] ? { error: errors[0] } : {}),
    errors,
    counts: {
      total: events.length,
      byKind: countBy(events, (row) => row.kind),
      byStatus: countBy(events, (row) => row.status),
      byName: countBy(events, (row) => row.name),
    },
    slowestSpans,
    criticalPath: buildTraceCriticalPath(events).map((row) => ({ row, durationMs: traceDurationMs(row) ?? null })),
    waterfall: buildTraceWaterfall(events),
    sideEffects: buildTraceSideEffects(events),
    causalLinks: buildTraceCausalLinks(events),
    payload: buildTracePayloadMetrics(events),
  };
  if (includeEvents) summary.events = events;
  return summary as TraceSummary;
}

const traces: Moo["traces"] = {
  async current() {
    const raw = __op_trace_current();
    return raw ? JSON.parse(raw) : null;
  },
  async get(args = {}) {
    return parseTraceRow(__op_trace_get(JSON.stringify(args ?? {})));
  },
  async events(args = {}) {
    return parseTraceRows(__op_trace_events(JSON.stringify(args ?? {})));
  },
  async tree(args = {}) {
    return buildTraceTree(await traces.events(args));
  },
  async recent(args = {}) {
    const requestedLimit = Math.max(1, Math.min(1000, Math.floor(args.limit ?? 50)));
    const needsOverscan = Boolean(args.chatId || args.status || args.kind || args.name || args.text || args.hasError);
    const rows = parseTraceRows(__op_trace_recent(needsOverscan ? 1000 : requestedLimit));
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
  async failed(args = {}) {
    return traces.search({ ...args, hasError: true });
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
    return out;
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
    const failures = await traces.failed({ limit, chatId: args.chatId, includeEvents: true }) as TraceSummary[];
    const recent = await traces.recent({ limit: args.chatId ? 1000 : limit, chatId: args.chatId });
    const summaries: TraceSummary[] = [];
    for (const row of recent.slice(0, limit)) summaries.push(await traces.summary({ traceId: row.traceId }));
    const slowRecent = summaries
      .filter((summary) => summary.durationMs != null)
      .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
      .slice(0, limit);
    const slowestSpans = slowRecent.flatMap((summary: any) => (summary.slowestSpans ?? []).map((span: any) => ({ traceId: summary.traceId, ...span }))).sort((a: any, b: any) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, limit);
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
    return __op_trace_insert(JSON.stringify({ kind: "mark", name: "user.mark", status: "ok", data: redactedTraceValue("user.mark", { ...data, message }, "event") }));
  },
  async span(name: string, dataOrFn: any, maybeFn?: any) {
    const hasData = typeof dataOrFn !== "function";
    const fn = hasData ? maybeFn : dataOrFn;
    if (typeof fn !== "function") throw new Error("moo.traces.span requires a callback");
    const data = hasData ? dataOrFn : {};
    const spanId = __op_trace_insert(JSON.stringify({ kind: "span", name, status: "running", data: redactedTraceValue(name, data ?? {}, "input") }));
    const previousParent = spanId ? __op_trace_set_parent(spanId) : null;
    try {
      const value = await fn();
      if (spanId) __op_trace_finish(spanId, "ok", traceDataJson(name, {}, "output"));
      return value;
    } catch (e: any) {
      if (spanId) __op_trace_finish(spanId, "error", traceErrorJson(name, e));
      throw e;
    } finally {
      if (spanId) __op_trace_set_parent(previousParent);
    }
  },
};

async function traceObserved<T>(
  name: string,
  data: Record<string, unknown>,
  fn: () => T | Promise<T>,
  finish?: (value: Awaited<T>) => Record<string, unknown>,
): Promise<Awaited<T>> {
  let spanId: string | null = null;
  let previousParent: string | null = null;
  try {
    spanId = __op_trace_insert(JSON.stringify({ kind: "span", name, status: "running", data: redactedTraceValue(name, data, "input") }));
    if (spanId) previousParent = __op_trace_set_parent(spanId);
  } catch {
    spanId = null;
  }
  try {
    const value = await fn();
    if (spanId) {
      let finishData: Record<string, unknown> = {};
      try { finishData = finish ? finish(value as Awaited<T>) : {}; } catch {}
      __op_trace_finish(spanId, "ok", JSON.stringify(redactedTraceValue(name, finishData, "output")));
    }
    return value as Awaited<T>;
  } catch (e: any) {
    if (spanId) {
      __op_trace_finish(spanId, "error", traceErrorJson(name, e));
    }
    throw e;
  } finally {
    if (spanId) __op_trace_set_parent(previousParent);
  }
}

function splitLinesForDiff(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type DiffStats = { added: number; removed: number; lines: number };

const DIFF_CONTEXT_LINES = 3;
const MAX_EXACT_DIFF_CELLS = 2_000_000;
const EMPTY_JSON_ARRAY = "[]";

type LineOp = { kind: "equal" | "insert" | "delete"; line: string };
type DiffAnchor = { oldIndex: number; newIndex: number };
type UniqueLineInfo = { oldCount: number; oldIndex: number; newCount: number; newIndex: number };
type UnifiedDiffBody = { lines: string[]; added: number; removed: number };

function unifiedDiffWithStats(path: string, before: string | null, after: string): { diff: string; stats: DiffStats } {
  const oldLines = splitLinesForDiff(before ?? "");
  const newLines = splitLinesForDiff(after);
  const ops = patienceLineDiff(oldLines, newLines);
  const from = before == null ? "/dev/null" : "a/" + path;
  const header = ["--- " + from, "+++ b/" + path];
  const body = unifiedDiffBody(ops, DIFF_CONTEXT_LINES);

  if (body.added === 0 && body.removed === 0) {
    const diff = [...header, "@@ -1,0 +1,0 @@", " (no textual changes)"].join("\n");
    return { diff, stats: { added: 0, removed: 0, lines: header.length + 2 } };
  }

  const diff = [...header, ...body.lines].join("\n");
  return { diff, stats: { added: body.added, removed: body.removed, lines: header.length + body.lines.length } };
}

function patienceLineDiff(oldLines: string[], newLines: string[]): LineOp[] {
  const ops: LineOp[] = [];
  appendPatienceDiff(oldLines, newLines, 0, oldLines.length, 0, newLines.length, ops);
  return ops;
}

function appendPatienceDiff(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
  out: LineOp[],
): void {
  while (oldStart < oldEnd && newStart < newEnd && oldLines[oldStart] === newLines[newStart]) {
    out.push({ kind: "equal", line: oldLines[oldStart]! });
    oldStart++;
    newStart++;
  }

  const commonSuffix: string[] = [];
  while (oldStart < oldEnd && newStart < newEnd && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    commonSuffix.push(oldLines[oldEnd - 1]!);
    oldEnd--;
    newEnd--;
  }

  if (oldStart === oldEnd) {
    for (let j = newStart; j < newEnd; j++) out.push({ kind: "insert", line: newLines[j]! });
    appendCommonSuffix(commonSuffix, out);
    return;
  }
  if (newStart === newEnd) {
    for (let i = oldStart; i < oldEnd; i++) out.push({ kind: "delete", line: oldLines[i]! });
    appendCommonSuffix(commonSuffix, out);
    return;
  }

  const anchors = patienceAnchors(oldLines, newLines, oldStart, oldEnd, newStart, newEnd);
  if (anchors.length === 0) {
    appendFallbackLineDiff(oldLines, newLines, oldStart, oldEnd, newStart, newEnd, out);
  } else {
    let oldCursor = oldStart;
    let newCursor = newStart;
    for (const anchor of anchors) {
      appendPatienceDiff(oldLines, newLines, oldCursor, anchor.oldIndex, newCursor, anchor.newIndex, out);
      out.push({ kind: "equal", line: oldLines[anchor.oldIndex]! });
      oldCursor = anchor.oldIndex + 1;
      newCursor = anchor.newIndex + 1;
    }
    appendPatienceDiff(oldLines, newLines, oldCursor, oldEnd, newCursor, newEnd, out);
  }

  appendCommonSuffix(commonSuffix, out);
}

function appendCommonSuffix(commonSuffix: string[], out: LineOp[]): void {
  for (let i = commonSuffix.length - 1; i >= 0; i--) out.push({ kind: "equal", line: commonSuffix[i]! });
}

function patienceAnchors(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): DiffAnchor[] {
  const counts = new Map<string, UniqueLineInfo>();

  for (let i = oldStart; i < oldEnd; i++) {
    const line = oldLines[i]!;
    let info = counts.get(line);
    if (!info) {
      info = { oldCount: 0, oldIndex: i, newCount: 0, newIndex: -1 };
      counts.set(line, info);
    }
    info.oldCount++;
    if (info.oldCount === 1) info.oldIndex = i;
  }

  for (let j = newStart; j < newEnd; j++) {
    const line = newLines[j]!;
    let info = counts.get(line);
    if (!info) {
      info = { oldCount: 0, oldIndex: -1, newCount: 0, newIndex: j };
      counts.set(line, info);
    }
    info.newCount++;
    if (info.newCount === 1) info.newIndex = j;
  }

  const candidates: DiffAnchor[] = [];
  for (const info of counts.values()) {
    if (info.oldCount === 1 && info.newCount === 1) candidates.push({ oldIndex: info.oldIndex, newIndex: info.newIndex });
  }
  candidates.sort((a, b) => a.oldIndex - b.oldIndex);
  return longestIncreasingNewIndexSubsequence(candidates);
}

function longestIncreasingNewIndexSubsequence(candidates: DiffAnchor[]): DiffAnchor[] {
  if (candidates.length <= 1) return candidates;

  const tails: number[] = [];
  const previous = new Array<number>(candidates.length).fill(-1);

  for (let i = 0; i < candidates.length; i++) {
    const value = candidates[i]!.newIndex;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candidates[tails[mid]!]!.newIndex < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tails[lo - 1]!;
    tails[lo] = i;
  }

  const result = new Array<DiffAnchor>(tails.length);
  let cursor = tails[tails.length - 1]!;
  for (let i = tails.length - 1; i >= 0; i--) {
    result[i] = candidates[cursor]!;
    cursor = previous[cursor]!;
  }
  return result;
}

function appendFallbackLineDiff(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
  out: LineOp[],
): void {
  const oldCount = oldEnd - oldStart;
  const newCount = newEnd - newStart;

  if (oldCount === 0) {
    for (let j = newStart; j < newEnd; j++) out.push({ kind: "insert", line: newLines[j]! });
    return;
  }
  if (newCount === 0) {
    for (let i = oldStart; i < oldEnd; i++) out.push({ kind: "delete", line: oldLines[i]! });
    return;
  }

  const cells = (oldCount + 1) * (newCount + 1);
  if (cells > MAX_EXACT_DIFF_CELLS) {
    for (let i = oldStart; i < oldEnd; i++) out.push({ kind: "delete", line: oldLines[i]! });
    for (let j = newStart; j < newEnd; j++) out.push({ kind: "insert", line: newLines[j]! });
    return;
  }

  const width = newCount + 1;
  const dp = new Uint32Array(cells);
  for (let i = oldCount - 1; i >= 0; i--) {
    for (let j = newCount - 1; j >= 0; j--) {
      dp[i * width + j] = oldLines[oldStart + i] === newLines[newStart + j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < oldCount && j < newCount) {
    if (oldLines[oldStart + i] === newLines[newStart + j]) {
      out.push({ kind: "equal", line: oldLines[oldStart + i]! });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      out.push({ kind: "delete", line: oldLines[oldStart + i]! });
      i++;
    } else {
      out.push({ kind: "insert", line: newLines[newStart + j]! });
      j++;
    }
  }
  while (i < oldCount) out.push({ kind: "delete", line: oldLines[oldStart + i++]! });
  while (j < newCount) out.push({ kind: "insert", line: newLines[newStart + j++]! });
}

function unifiedDiffBody(ops: LineOp[], contextLines: number): UnifiedDiffBody {
  const lines: LineOp[] = [];
  const oldPrefixCounts: number[] = [0];
  const newPrefixCounts: number[] = [0];
  const changeIndexes: number[] = [];
  let added = 0;
  let removed = 0;

  for (const op of ops) {
    const index = lines.length;
    lines.push(op);
    if (op.kind === "insert") added++;
    else if (op.kind === "delete") removed++;
    if (op.kind !== "equal") changeIndexes.push(index);

    oldPrefixCounts.push(oldPrefixCounts[oldPrefixCounts.length - 1]! + (op.kind === "insert" ? 0 : 1));
    newPrefixCounts.push(newPrefixCounts[newPrefixCounts.length - 1]! + (op.kind === "delete" ? 0 : 1));
  }

  if (changeIndexes.length === 0) return { lines: [], added, removed };

  const hunkLines: string[] = [];
  let hunkStart = Math.max(0, changeIndexes[0]! - contextLines);
  let hunkEnd = Math.min(lines.length, changeIndexes[0]! + contextLines + 1);

  const emitHunk = (start: number, end: number) => {
    const oldBefore = oldPrefixCounts[start]!;
    const newBefore = newPrefixCounts[start]!;
    const oldLength = oldPrefixCounts[end]! - oldBefore;
    const newLength = newPrefixCounts[end]! - newBefore;
    const oldStart = oldLength === 0 ? oldBefore : oldBefore + 1;
    const newStart = newLength === 0 ? newBefore : newBefore + 1;
    hunkLines.push("@@ -" + rangeHeader(oldStart, oldLength) + " +" + rangeHeader(newStart, newLength) + " @@");
    for (let i = start; i < end; i++) {
      const line = lines[i]!;
      const prefix = line.kind === "insert" ? "+" : line.kind === "delete" ? "-" : " ";
      hunkLines.push(prefix + line.line);
    }
  };

  for (let i = 1; i < changeIndexes.length; i++) {
    const changeIndex = changeIndexes[i]!;
    const nextStart = Math.max(0, changeIndex - contextLines);
    const nextEnd = Math.min(lines.length, changeIndex + contextLines + 1);
    if (nextStart <= hunkEnd) {
      hunkEnd = Math.max(hunkEnd, nextEnd);
    } else {
      emitHunk(hunkStart, hunkEnd);
      hunkStart = nextStart;
      hunkEnd = nextEnd;
    }
  }
  emitHunk(hunkStart, hunkEnd);

  return { lines: hunkLines, added, removed };
}

function rangeHeader(start: number, length: number): string {
  return length === 1 ? String(start) : String(start) + "," + String(length);
}

async function displayPathForChat(chatId: string, path: string): Promise<string> {
  const normalizedPath = String(path).replace(/\\/g, "/");
  const scratch = (await chat.scratch(chatId)).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!scratch) return normalizedPath;
  if (normalizedPath === scratch) return ".";
  if (normalizedPath.startsWith(scratch + "/")) return normalizedPath.slice(scratch.length + 1) || ".";
  return normalizedPath;
}

async function recordFileWriteDiff(path: string, before: string | null, after: string): Promise<void> {
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
  const diffId = await id.new("fsdiff");
  await pointers.set(`fs-diffs/${diffId}`, hash);
  events.publish({ kind: "file-diff", chatId, path: displayPath, before, after, diff, stats, hash, stepId, at });
}


type PatchLine = { kind: "context" | "add" | "del"; text: string; noNewline?: boolean };
type ParsedHunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: PatchLine[] };
type ParsedFilePatch = { oldPath: string | null; newPath: string | null; hunks: ParsedHunk[] };
type TextLines = { lines: string[]; trailingNewline: boolean };

function normalizePatchArgs(args: string | FsPatchArgs): FsPatchArgs {
  if (typeof args === "string") return { patch: args };
  if (!args || typeof args !== "object") throw new MooApiError("invalid_argument", "fs.patch requires a patch string or {patch,...}");
  return args;
}

function parsePatchPath(line: string): string | null {
  let raw = line.slice(4).trim();
  if (!raw || raw === "/dev/null") return null;
  if (raw.startsWith('"')) {
    const end = raw.lastIndexOf('"');
    if (end > 0) {
      try { raw = JSON.parse(raw.slice(0, end + 1)); }
      catch { raw = raw.slice(1, end); }
      return raw === "/dev/null" ? null : raw;
    }
  }
  const tab = raw.indexOf("\t");
  if (tab >= 0) raw = raw.slice(0, tab);
  return raw === "/dev/null" ? null : raw;
}

function stripPatchPath(path: string, strip?: number | null): string {
  let p = path.replace(/\\/g, "/");
  if (strip == null) {
    if (/^[ab]\//.test(p)) p = p.slice(2);
    return p;
  }
  const n = Math.max(0, Math.floor(Number(strip) || 0));
  for (let i = 0; i < n; i++) p = p.replace(/^[^/]+\/?/, "");
  return p;
}

function resolvePatchPath(path: string, cwd?: string | null, strip?: number | null): string {
  const p = stripPatchPath(path, strip);
  if (!p) throw new MooApiError("invalid_patch", "patch path became empty after stripping", { path, strip });
  if (p.startsWith("/")) return p;
  if (cwd) {
    if (!validate.relativePath(p)) throw new MooApiError("path_escape", "patch paths under cwd must be relative and may not contain ..", { cwd, path: p });
    return joinPath(cwd, p);
  }
  return p;
}

function parsePatchHunkHeader(line: string, lineNumber: number): ParsedHunk {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m) {
    return {
      oldStart: Number(m[1]),
      oldCount: m[2] == null ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] == null ? 1 : Number(m[4]),
      lines: [],
    };
  }
  if (/^@@(?:\s.*)?$/.test(line)) return { oldStart: 1, oldCount: 0, newStart: 1, newCount: 0, lines: [] };
  throw new MooApiError("invalid_patch", "bad unified hunk header", { line: lineNumber, header: line });
}

function parsePatchHunkLine(hunk: ParsedHunk, line: string, lineNumber: number): boolean {
  if (line.startsWith("\\ No newline at end of file")) {
    const previous = hunk.lines[hunk.lines.length - 1];
    if (!previous) throw new MooApiError("invalid_patch", "no-newline marker appears before a hunk line", { line: lineNumber });
    previous.noNewline = true;
    return true;
  }
  const prefix = line[0];
  if (prefix === " ") hunk.lines.push({ kind: "context", text: line.slice(1) });
  else if (prefix === "+") hunk.lines.push({ kind: "add", text: line.slice(1) });
  else if (prefix === "-") hunk.lines.push({ kind: "del", text: line.slice(1) });
  else if (line === "") return false;
  else throw new MooApiError("invalid_patch", "unexpected line in hunk", { line: lineNumber, text: line });
  return true;
}

function parseApplyPatch(patch: string): ParsedFilePatch[] {
  const lines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const files: ParsedFilePatch[] = [];
  let current: ParsedFilePatch | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("*** Update File:")) {
      const path = line.slice("*** Update File:".length).trim();
      if (!path) throw new MooApiError("invalid_patch", "apply_patch update header missing path", { line: i + 1 });
      current = { oldPath: path, newPath: path, hunks: [] };
      files.push(current);
      i++;
      continue;
    }
    if (line.startsWith("@@")) {
      if (!current) throw new MooApiError("invalid_patch", "hunk appears before file header", { line: i + 1 });
      const hunk = parsePatchHunkHeader(line, i + 1);
      i++;
      while (i < lines.length) {
        const h = lines[i]!;
        if (h.startsWith("*** ") || h.startsWith("@@")) break;
        if (h === "" && i === lines.length - 1) break;
        if (!parsePatchHunkLine(hunk, h, i + 1)) throw new MooApiError("invalid_patch", "empty line in hunk must be prefixed with space, +, or -", { line: i + 1 });
        i++;
      }
      current.hunks.push(hunk);
      continue;
    }
    i++;
  }
  return files.filter((f) => f.hunks.length > 0);
}

function parseUnifiedPatch(patch: string): ParsedFilePatch[] {
  const lines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const files: ParsedFilePatch[] = [];
  let current: ParsedFilePatch | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("--- ")) {
      const next = lines[i + 1];
      if (next == null || !next.startsWith("+++ ")) throw new MooApiError("invalid_patch", "unified patch file header missing +++ line", { line: i + 1 });
      current = { oldPath: parsePatchPath(line), newPath: parsePatchPath(next), hunks: [] };
      files.push(current);
      i += 2;
      continue;
    }
    if (line.startsWith("@@ ")) {
      if (!current) throw new MooApiError("invalid_patch", "hunk appears before file header", { line: i + 1 });
      const hunk = parsePatchHunkHeader(line, i + 1);
      i++;
      while (i < lines.length) {
        const h = lines[i]!;
        if (h.startsWith("diff --git ") || h.startsWith("--- ") || h.startsWith("@@ ")) break;
        if (!parsePatchHunkLine(hunk, h, i + 1)) {
          if (i === lines.length - 1) break;
          throw new MooApiError("invalid_patch", "empty line in hunk must be prefixed with space, +, or -", { line: i + 1 });
        }
        i++;
      }
      current.hunks.push(hunk);
      continue;
    }
    i++;
  }
  const withHunks = files.filter((f) => f.hunks.length > 0);
  if (!withHunks.length) {
    const applyPatchFiles = parseApplyPatch(patch);
    if (applyPatchFiles.length) return applyPatchFiles;
    throw new MooApiError("invalid_patch", "patch contains no unified hunks; use a unified diff (---/+++/@@ -a,b +c,d @@) or a simple *** Begin Patch / *** Update File: path patch");
  }
  return withHunks;
}

function splitTextLines(text: string): TextLines {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized === "") return { lines: [], trailingNewline: false };
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function joinTextLines(t: TextLines): string {
  return t.lines.join("\n") + (t.trailingNewline && t.lines.length ? "\n" : "");
}

function hunkOldLines(hunk: ParsedHunk): string[] {
  return hunk.lines.filter((l) => l.kind !== "add").map((l) => l.text);
}

function findHunkIndex(oldLines: string[], needle: string[], preferred: number, floor: number): number {
  const exact = matchesAt(oldLines, needle, preferred) ? preferred : -1;
  if (exact >= 0) return exact;
  if (needle.length === 0) return Math.max(floor, Math.min(preferred, oldLines.length));
  for (let i = Math.max(0, floor); i <= oldLines.length - needle.length; i++) {
    if (matchesAt(oldLines, needle, i)) return i;
  }
  return -1;
}

function matchesAt(lines: string[], needle: string[], index: number): boolean {
  if (index < 0 || index + needle.length > lines.length) return false;
  for (let j = 0; j < needle.length; j++) if (lines[index + j] !== needle[j]) return false;
  return true;
}

function applyParsedFilePatch(file: ParsedFilePatch, before: string | null): { after: string; added: number; removed: number } {
  const text = splitTextLines(before ?? "");
  const out: string[] = [];
  let cursor = 0;
  let added = 0;
  let removed = 0;
  let lastPatchOutputNoNewline = false;
  for (const hunk of file.hunks) {
    const oldSeq = hunkOldLines(hunk);
    const preferred = Math.max(0, hunk.oldStart - 1);
    const start = findHunkIndex(text.lines, oldSeq, preferred, cursor);
    if (start < 0) throw new MooApiError("patch_mismatch", "patch hunk did not match file", { path: file.newPath ?? file.oldPath, oldStart: hunk.oldStart });
    while (cursor < start) out.push(text.lines[cursor++]!);
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        out.push(line.text);
        lastPatchOutputNoNewline = !!line.noNewline;
        added++;
      } else {
        const got = text.lines[cursor];
        if (got !== line.text) throw new MooApiError("patch_mismatch", "patch line did not match file", { path: file.newPath ?? file.oldPath, expected: line.text, got });
        if (line.kind === "context") {
          out.push(got);
          lastPatchOutputNoNewline = !!line.noNewline;
        } else removed++;
        cursor++;
      }
    }
  }
  const copiedTail = cursor < text.lines.length;
  while (cursor < text.lines.length) out.push(text.lines[cursor++]!);
  const trailingNewline = out.length > 0 && (copiedTail ? text.trailingNewline : !lastPatchOutputNoNewline);
  return { after: joinTextLines({ lines: out, trailingNewline }), added, removed };
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
  const diffId = await id.new("memdiff");
  await pointers.set(`memory-diffs/${diffId}`, hash);
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
  const payloadHash = __op_object_put("agent:BlobAdd", JSON.stringify(payload));
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
    const hash = __op_object_put(normalizedKind, content);
    if (shouldRecordBlobAddition(normalizedKind)) await recordBlobAddition(normalizedKind, hash, content, "text");
    return hash;
  },
  async putJSON({ kind, value }) {
    const normalizedKind = String(kind);
    const content = JSON.stringify(value);
    const hash = __op_object_put(normalizedKind, content);
    if (shouldRecordBlobAddition(normalizedKind)) await recordBlobAddition(normalizedKind, hash, content, "json");
    return hash;
  },
  async getText({ hash }) {
    const row = __op_object_get(hash);
    return row ? { kind: row.kind, text: row.content } : null;
  },
  async getJSON({ hash }) {
    const row = __op_object_get(hash);
    if (!row) return null;
    return { kind: row.kind, value: JSON.parse(row.content) };
  },
};

const pointers: Moo["pointers"] = {
  async get(name) {
    if (!validate.pointerName(name)) throw new MooApiError("invalid_pointer_name", "invalid pointer name", { name });
    return __op_ref_get(name);
  },
  async set(name, target) {
    if (!validate.pointerName(name)) throw new MooApiError("invalid_pointer_name", "invalid pointer name", { name });
    const previous = __op_ref_get(name);
    __op_ref_set(name, target);
    return { name, target, previous, changed: previous !== target };
  },
  async cas(name, expected, next) {
    if (!validate.pointerName(name)) throw new MooApiError("invalid_pointer_name", "invalid pointer name", { name });
    return __op_ref_cas(name, expected ?? null, next);
  },
  async list(prefix = "") {
    return __op_refs_list(prefix);
  },
  async entries(prefix = "") {
    return JSON.parse(__op_refs_entries(prefix));
  },
  async delete(name) {
    if (!validate.pointerName(name)) throw new MooApiError("invalid_pointer_name", "invalid pointer name", { name });
    return __op_ref_delete(name);
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
function unpackMemoryPatchGroups(input: unknown): Array<{ asserts: Array<[string, string, ObjectInput]>; retracts: Array<[string, string, ObjectInput]> }> {
  const groupsInput = input && typeof input === "object" && !Array.isArray(input) && "groups" in input
    ? (input as { groups?: unknown }).groups
    : [input];
  if (!Array.isArray(groupsInput)) throw new Error("memory.patch groups must be an array");
  return groupsInput.map((group) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) throw new Error("memory.patch group must be {asserts?, retracts?}");
    const assertsInput = (group as { asserts?: unknown }).asserts ?? [];
    const retractsInput = (group as { retracts?: unknown }).retracts ?? [];
    return {
      asserts: unpackMemoryFacts(assertsInput),
      retracts: unpackMemoryFacts(retractsInput),
    };
  });
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

const sparql: Moo["sparql"] = {
  async query(args) {
    const { query, graph = null, limit = null, format = "string" } = args || ({} as any);
    const store = factStore(args as any, "sparql.query");
    const decoded = __op_sparql_query(query, store, graph, limit ?? null);
    if (decoded.type === "select") return formatBindings(decoded.result as Bindings[], format) as any;
    return decoded.result as any;
  },
  async select(args) {
    const { query, graph = null, limit = null, format = "string" } = args as any;
    const store = factStore(args as any, "sparql.select");
    const decoded = __op_sparql_query(query, store, graph, limit ?? null);
    if (decoded.type !== "select") throw new MooApiError("bad_sparql", "SPARQL query returned " + decoded.type + ", not select");
    return formatBindings(decoded.result as Bindings[], format) as any;
  },
  async ask(args) {
    const { query, graph = null, limit = null } = args as any;
    const store = factStore(args as any, "sparql.ask");
    const decoded = __op_sparql_query(query, store, graph, limit ?? null);
    if (decoded.type !== "ask") throw new MooApiError("bad_sparql", "SPARQL query returned " + decoded.type + ", not ask");
    return decoded.result;
  },
  async construct(args) {
    const { query, graph = null, limit = null } = args as any;
    const store = factStore(args as any, "sparql.construct");
    const decoded = __op_sparql_query(query, store, graph, limit ?? null);
    if (decoded.type !== "construct") throw new MooApiError("bad_sparql", "SPARQL query returned " + decoded.type + ", not construct");
    return decoded.result;
  },
};

function encodeFactQuad(q: FactQuadInput): Quad {
  const raw = unpackQuad(q);
  return [raw[0], raw[1], raw[2], encodeObject(raw[3])];
}

const facts: Moo["facts"] = {
  async add(args) {
    const { graph, subject, predicate, object } = args;
    const store = factStore(args, "facts.add");
    const encoded = encodeObject(object);
    assertFactObject(encoded);
    __op_facts_add(store, graph, subject, predicate, encoded);
    invalidateChatFactsSummary(store);
    return factReceipt(store, 1, 0);
  },
  async addAll(args) {
    const { quads } = args;
    const store = factStore(args, "facts.addAll");
    const adds = quads.map((q) => encodeFactQuad(q));
    if (!adds.length) return factReceipt(store, 0, 0);
    assertFactObjects(adds);
    __op_facts_swap(store, EMPTY_JSON_ARRAY, JSON.stringify(adds));
    invalidateChatFactsSummary(store);
    return factReceipt(store, adds.length, 0);
  },
  async remove(args) {
    const { graph, subject, predicate, object } = args;
    const store = factStore(args, "facts.remove");
    __op_facts_remove(store, graph, subject, predicate, encodeObject(object));
    invalidateChatFactsSummary(store);
    return factReceipt(store, 0, 1);
  },
  async match(args) {
    const { graph = null, subject = null, predicate = null, object = null, limit = undefined, format = "tuple" } = args;
    const store = factStore(args, "facts.match");
    const encodedObject = object == null ? null : encodeObject(object);
    const rows = __op_facts_match(store, graph, subject, predicate, encodedObject, limit ?? null) as Quad[];
    return (format === "object" ? quadObjects(rows) : rows) as any;
  },
  async history(args) {
    const { graph = null, subject = null, predicate = null, object = null, limit = undefined } = args;
    const store = factStore(args, "facts.history");
    const encodedObject = object == null ? null : encodeObject(object);
    const rows = __op_facts_history(store, graph, subject, predicate, encodedObject, limit ?? null);
    return rows as import("./types").FactHistoryRow[];
  },
  async matchAll(args) {
    const { patterns, graph = undefined, limit = undefined } = args;
    const store = factStore(args, "facts.matchAll");
    return __op_facts_match_all(
      store,
      JSON.stringify(patterns.map(([s, p, o]) => [s, p, encodeObject(o as ObjectInput)])),
      graph ?? null,
      limit ?? null,
    ) as Bindings[];
  },
  async stores(args = {}) {
    return __op_facts_refs(args.prefix ?? null);
  },
  async count(args) {
    return __op_facts_count(factStore(args, "facts.count"));
  },
  async swap(args) {
    const { removes, adds } = args;
    const store = factStore(args, "facts.swap");
    const encodedRemoves = removes.map((q) => encodeFactQuad(q));
    const encodedAdds = adds.map((q) => encodeFactQuad(q));
    assertFactObjects(encodedAdds);
    __op_facts_swap(store, JSON.stringify(encodedRemoves), JSON.stringify(encodedAdds));
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
        removes.push([graph, subject, predicate, encodeObject(object)]);
      },
    });
    if (!removes.length && !adds.length) return factReceipt(store, 0, 0);
    assertFactObjects(adds);
    __op_facts_swap(store, JSON.stringify(removes), JSON.stringify(adds));
    invalidateChatFactsSummary(store);
    return factReceipt(store, adds.length, removes.length);
  },
  async clearStore(args) {
    const store = factStore(args, "facts.clearStore");
    const dryRun = !!args.dryRun;
    if (dryRun) return factClearReceipt(store, undefined, __op_facts_count(store), true);
    const removed = __op_facts_clear(store);
    invalidateChatFactsSummary(store);
    return factClearReceipt(store, undefined, removed);
  },
  async deleteStore(args) {
    const store = factStore(args, "facts.deleteStore");
    const dryRun = !!args.dryRun;
    if (dryRun) return factClearReceipt(store, undefined, __op_facts_count(store), true);
    const removed = __op_facts_purge(store);
    invalidateChatFactsSummary(store);
    return factClearReceipt(store, undefined, removed);
  },
  async deleteGraph(args) {
    const { graph } = args;
    const store = factStore(args, "facts.deleteGraph");
    const dryRun = !!args.dryRun;
    const matches = __op_facts_match(store, graph, null, null, null, null) as Quad[];
    if (dryRun) return factClearReceipt(store, graph, matches.length, true);
    if (!matches.length) return factClearReceipt(store, graph, 0);
    __op_facts_swap(store, JSON.stringify(matches), EMPTY_JSON_ARRAY);
    invalidateChatFactsSummary(store);
    return factClearReceipt(store, graph, matches.length);
  },
  async deleteGraphEverywhere({ graph, dryRun = false }) {
    if (dryRun) {
      let removed = 0;
      for (const store of __op_facts_refs(null)) {
        removed += (__op_facts_match(store, graph, null, null, null, null) as Quad[]).length;
      }
      return factClearReceipt(undefined, graph, removed, true);
    }
    const removed = __op_facts_purge_graph(graph);
    chatFactsSummaryCache.clear();
    return factClearReceipt(undefined, graph, removed);
  },
};

const fs: Moo["fs"] = {
  async read(path) {
    return await traceObserved("moo.fs.read", { path }, () => __op_fs_read(path), (value) => ({ chars: value.length, bytes: stringBytes(value) }));
  },
  async write(path, content) {
    const text = typeof content === "string" ? content : String(content);
    let before: string | null = null;
    try {
      before = await traceObserved("moo.fs.read_before_write", { path }, () => __op_fs_read(path), (value) => ({ chars: value.length }));
    } catch (_) {
      before = null;
    }
    await traceObserved("moo.fs.write", {
      path,
      chars: text.length,
      beforeExists: before != null,
    }, () => __op_fs_write(path, text), () => ({ changed: before !== text }));
    await traceObserved("moo.fs.record_diff", { path }, () => recordFileWriteDiff(path, before, text));
  },
  async list(path) {
    return await traceObserved("moo.fs.list", { path }, () => __op_fs_list(path), (value) => ({ count: value.length }));
  },
  async glob(pattern) {
    return await traceObserved("moo.fs.glob", { pattern }, () => __op_fs_glob(pattern), (value) => ({ count: value.length }));
  },
  async stat(path) {
    return await traceObserved("moo.fs.stat", { path }, () => __op_fs_stat(path), (value) => ({ exists: value != null, kind: (value as any)?.kind ?? null, size: (value as any)?.size ?? null, mtime: (value as any)?.mtime ?? null }));
  },
  async canonical(path) {
    return await traceObserved("moo.fs.canonical", { path }, () => __op_fs_canonical(path), (value) => ({ path: value }));
  },
  async exists(path) {
    return await traceObserved("moo.fs.exists", { path }, async () => (await fs.stat(path)) != null, (value) => ({ exists: value }));
  },
  async ensureDir(path) {
    await traceObserved("moo.fs.ensureDir", { path }, () => __op_fs_mkdir(path), () => ({ path }));
  },
  async patch(input) {
    const args = normalizePatchArgs(input);
    const parsed = parseUnifiedPatch(String(args.patch));
    const dryRun = !!args.dryRun;
    return await traceObserved("moo.fs.patch", {
      files: parsed.length,
      dryRun,
      cwd: args.cwd ?? null,
      strip: args.strip ?? null,
    }, async () => {
    const files: FsPatchReceipt["files"] = [];
    for (const file of parsed) {
      const sourcePath = file.oldPath ?? file.newPath;
      const targetPath = file.newPath ?? file.oldPath;
      if (!sourcePath || !targetPath) throw new MooApiError("invalid_patch", "patch file header has no usable path", file);
      const readPath = resolvePatchPath(sourcePath, args.cwd, args.strip);
      const writePath = resolvePatchPath(targetPath, args.cwd, args.strip);
      let before: string | null = null;
      try {
        before = __op_fs_read(readPath);
      } catch (_) {
        before = null;
      }
      if (before == null && file.oldPath != null) throw new MooApiError("patch_mismatch", "patch target file does not exist", { path: readPath });
      const applied = applyParsedFilePatch(file, before);
      const deleting = file.newPath == null;
      if (!dryRun) {
        if (deleting) {
          __op_fs_remove(readPath);
          await recordFileWriteDiff(readPath, before, "");
        } else {
          __op_fs_write(writePath, applied.after);
          await recordFileWriteDiff(writePath, before, applied.after);
        }
      }
      files.push({ path: deleting ? readPath : writePath, beforeExists: before != null, afterExists: !deleting, added: applied.added, removed: applied.removed, hunks: file.hunks.length });
    }
    return { dryRun, files };
    }, (value) => ({ files: value.files.length, added: value.files.reduce((n, f) => n + f.added, 0), removed: value.files.reduce((n, f) => n + f.removed, 0) }));
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
    const { cmd, args = [], cwd = null, stdin = null, timeoutMs = 60_000, env = undefined, maxOutputBytes = null } = input;
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
      const result = __op_proc_run(
        cmd,
        JSON.stringify(args),
        cwd,
        stdin,
        timeoutMs,
        env == null ? null : JSON.stringify(env),
        maxOutputBytes ?? null,
      );
      return checkedProcResult(input, result);
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

function workspacePath(root: string, path: string = "."): string {
  const raw = String(path || ".");
  if (!validate.relativePath(raw) && raw !== ".") throw new MooApiError("path_escape", "workspace paths must be relative and may not contain ..", { root, path: raw });
  const parts = raw.split("/").filter(Boolean);
  return parts.length ? joinPath(root, parts.join("/")) : root;
}

const workspace: Moo["workspace"] = {
  async current(args = {}) {
    const root = args.root ? await fs.canonical(args.root) : await chat.scratch(args.chatId || activeChatId || "default");
    return {
      root,
      fs: {
        read: (path) => fs.read(workspacePath(root, path)),
        write: (path, content) => fs.write(workspacePath(root, path), content),
        list: (path = ".") => fs.list(workspacePath(root, path)),
        glob: (pattern) => fs.glob(workspacePath(root, pattern)),
        stat: (path = ".") => fs.stat(workspacePath(root, path)),
        canonical: (path = ".") => fs.canonical(workspacePath(root, path)),
        exists: (path = ".") => fs.exists(workspacePath(root, path)),
        ensureDir: (path = ".") => fs.ensureDir(workspacePath(root, path)),
        patch: (input) => fs.patch(typeof input === "string" ? { patch: input, cwd: root } : { ...input, cwd: root }),
      },
      proc: {
        run: (input: Omit<ProcRunArgs, "cwd"> & { cwd?: string | null }) => proc.run({ ...input, cwd: input.cwd ? workspacePath(root, input.cwd) : root }),
        runChecked: (input: Omit<ProcRunArgs, "cwd" | "check"> & { cwd?: string | null }) => proc.runChecked({ ...input, cwd: input.cwd ? workspacePath(root, input.cwd) : root }),
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
      headerKeys: Object.keys(headers).sort(),
      bodyChars: body?.length ?? 0,
      timeoutMs: opts.timeoutMs ?? 60_000,
    }, () => {
      const response = __op_http_fetch(method, opts.url, JSON.stringify(headers), body, opts.timeoutMs ?? 60_000);
      return { status: response.status, body: response.body, headers: parseResponseHeaders(response.headers) };
    }, (response) => ({ status: response.status, bodyChars: response.body.length, responseHeaderKeys: Object.keys(response.headers).sort() }));
  },
  async stream(opts) {
    const method = opts.method || "GET";
    if (!opts.url) throw new Error("http.stream requires url");
    const { body, headers } = buildBody(opts);
    const opened = await traceObserved("moo.http.stream.open", {
      method,
      url: opts.url,
      headerKeys: Object.keys(headers).sort(),
      bodyChars: body?.length ?? 0,
      timeoutMs: opts.timeoutMs ?? 120_000,
    }, () => __op_http_stream_open(
        method,
        opts.url,
        JSON.stringify(headers),
        body,
        opts.timeoutMs ?? 120_000,
      ), (response) => ({ status: response.status, responseHeaderKeys: Object.keys(parseResponseHeaders(response.headers)).sort() }));
    return {
      status: opened.status,
      headers: parseResponseHeaders(opened.headers),
      async next() {
        return await traceObserved("moo.http.stream.next", { status: opened.status }, () => __op_http_stream_next(opened.handle), (chunk) => ({ chunkChars: chunk?.length ?? 0, done: chunk == null }));
      },
      async close() {
        await traceObserved("moo.http.stream.close", { status: opened.status }, () => __op_http_stream_close(opened.handle));
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
  updatedAt?: number;
};

type McpRequestOptions = {
  skipInitialize?: boolean;
  omitSession?: boolean;
  retryingSession?: boolean;
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
  while (out.length < 64) out += __op_id(prefix).replace(/[^A-Za-z0-9._~-]/g, "");
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
  const hash = await pointers.get(mcpSessionRef(clean));
  if (!hash) return null;
  const row = await objects.getJSON<McpSession>({ hash: hash });
  const value = row?.value;
  if (!value || typeof value !== "object") return null;
  const session: McpSession = {};
  if (typeof value.id === "string" && value.id.trim()) session.id = value.id.trim();
  if (Number.isFinite(value.initializedAt)) session.initializedAt = Number(value.initializedAt);
  if (Number.isFinite(value.updatedAt)) session.updatedAt = Number(value.updatedAt);
  return session.id || session.initializedAt ? session : null;
}

async function saveMcpSession(serverId: string, session: McpSession): Promise<void> {
  const clean = cleanMcpId(serverId);
  if (!clean) return;
  const now = await time.nowMs();
  const current = await loadMcpSession(clean);
  const next: McpSession = {
    ...(current || {}),
    ...session,
    updatedAt: now,
  };
  if (!next.initializedAt && session.initializedAt !== undefined) next.initializedAt = now;
  const hash = await objects.putJSON({ kind: "mcp:Session", value: next });
  await pointers.set(mcpSessionRef(clean), hash);
}

async function loadMcpSessionId(serverId: string): Promise<string | null> {
  return (await loadMcpSession(serverId))?.id || null;
}

async function saveMcpSessionId(serverId: string, sessionId: string): Promise<void> {
  const value = sessionId.trim();
  if (value) await saveMcpSession(serverId, { id: value });
}

async function markMcpInitialized(serverId: string, sessionId?: string | null): Promise<void> {
  const now = await time.nowMs();
  const session: McpSession = { initializedAt: now };
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
    clientInfo: { name: "moo", version: "0.1.0" },
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

async function registerMcpOAuthClient(server: McpServerConfig, oauth: Awaited<ReturnType<typeof discoverMcpOAuth>>, redirectUri: string): Promise<Awaited<ReturnType<typeof discoverMcpOAuth>>> {
  if (!oauth.registrationUrl) return oauth;
  if (oauth.clientId && oauth.clientId !== "moo" && oauth.redirectUri === redirectUri) return oauth;
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
    const redirectUri = opts.redirectUri || oauth.redirectUri || ((opts.origin || "http://127.0.0.1:7777").replace(/\/$/, "") + "/mcp/oauth/callback");
    oauth = await registerMcpOAuthClient(server, oauth, redirectUri);
    const clientId = oauth.clientId || "moo";
    const state = oauthSecret("mcpstate");
    const codeVerifier = oauthSecret("mcpverifier");
    const codeChallenge = __op_sha256_base64url(codeVerifier);
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
        await mcpCore.request(server.id, "initialize", mcpInitializeParams(), { skipInitialize: true, omitSession: true });
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
      timeoutMs: server.timeoutMs ?? 60_000,
    });
    const responseSessionId = headerValue(response.headers, "mcp-session-id");
    await traces.mark("mcp.http.response", {
      serverId: server.id,
      method,
      status: response.status,
      bodyChars: response.body.length,
      responseSessionId: responseSessionId ?? null,
      retryingSession: !!opts.retryingSession,
    });
    if (responseSessionId) await saveMcpSessionId(server.id, responseSessionId);
    if (response.status === 401 && server.oauth && !token) {
      throw new Error(`MCP ${server.id} requires OAuth login; run moo.mcp.login("${server.id}") from the UI or use the MCP settings Login button`);
    }
    if (isMcpSessionError(response.status, response.body) && !opts.retryingSession && method !== "initialize") {
      await traces.mark("mcp.session.retry", { serverId: server.id, method, status: response.status });
      await clearMcpSessionId(server.id);
      await mcpCore.request(server.id, "initialize", mcpInitializeParams(), { skipInitialize: true, omitSession: true });
      return mcpCore.request<T>(server.id, method, params, { ...opts, retryingSession: true });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`MCP ${method} failed with HTTP ${response.status}: ${response.body}`);
    }
    const payload = parseMcpBody(response.body);
    await traces.mark("mcp.payload", {
      serverId: server.id,
      method,
      hasResult: payload?.result !== undefined,
      hasError: !!payload?.error,
      resultShape: resultShape(payload?.result),
    });
    if (payload?.error) {
      throw new Error(payload.error.message || JSON.stringify(payload.error));
    }
    if (method === "initialize") await markMcpInitialized(server.id, responseSessionId);
    return payload?.result as T;
  },
  async listTools(serverId?: string): Promise<McpTool[]> {
    const servers = serverId ? [await mcpCore.getServer(serverId)] : await mcpCore.listServers();
    const out: McpTool[] = [];
    for (const server of servers) {
      if (!server || server.enabled === false) continue;
      const result: any = await mcpCore.request(server.id, "tools/list", {});
      for (const tool of result?.tools || []) {
        const name = String(tool.name || "");
        if (!name) continue;
        const inputSchema = tool.inputSchema ?? tool.input_schema ?? undefined;
        out.push({
          serverId: server.id,
          server: server.id,
          name,
          title: tool.title ?? tool.annotations?.title ?? null,
          description: tool.description ?? null,
          denseDescription: denseMcpToolDescription(tool, inputSchema),
          inputSchema,
        });
      }
    }
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
    __op_broadcast(text);
  },
};

const env: Moo["env"] = {
  async get(name) {
    return __op_env_get(name);
  },
  async getMany(names) {
    const out: Record<string, string | null> = {};
    for (const n of names) out[n] = __op_env_get(n);
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
    addOptionalTrailFact(txn, graph, entryId, "agent:previousTitle", payload.previousTitle);
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
      const factReceipt = await facts.update({ store: c.facts, fn: (txn) => {
        txn.add({ graph: c.graph, subject: `chat:${chatId}`, predicate: "ui:involves", object: `ui:${uiId}` });
        txn.add({ graph: c.graph, subject: `chat:${chatId}`, predicate: "ui:primary", object: `ui:${uiId}` });
        txn.add({ graph: c.graph, subject: inst, predicate: "rdf:type", object: "ui:Instance" });
        txn.add({ graph: c.graph, subject: inst, predicate: "ui:app", object: `ui:${uiId}` });
        txn.add({ graph: c.graph, subject: inst, predicate: "ui:chat", object: `chat:${chatId}` });
        txn.add({ graph: c.graph, subject: inst, predicate: "ui:statePointer", object: `pointer:uiinst/${instanceId}/state` });
      } });
      const stateRef = `uiinst/${instanceId}/state`;
      let stateHash = await pointers.get(stateRef);
      let createdState = false;
      if (!stateHash) {
        stateHash = await objects.putJSON({ kind: "ui:State", value: state ?? {} });
        await pointers.set(stateRef, stateHash);
        createdState = true;
      }
      return { chatId, uiId, instanceId, stateHash, stateRef, createdState, facts: factReceipt };
    },
  },
};

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
  const raw = JSON.parse(__op_chat_fact_summaries()) as Record<string, ChatFactsSummary | undefined>;
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

async function chatScratchRoot(chatId: string): Promise<string> {
  return (await pointers.get(`chat/${chatId}/path`)) || ".";
}

function chatWorktreePath(chatId: string, root: string): string {
  return joinPath(root, `.moo/${chatId}`);
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
  refs({ chatId }) {
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
    };
  },
  async scratch(chatId) {
    const root = await chatScratchRoot(chatId);
    const path = chatWorktreePath(chatId, root);
    if (await fs.exists(path)) return await canonicalDir(path);
    // If the cwd is a git repo, prefer a real `git worktree add` from HEAD so
    // the agent gets per-chat branches, diffs, and clean state. Fall back to
    // a plain mkdir when not in a repo (or when worktree creation fails).
    if (await fs.exists(joinPath(root, ".git"))) {
      const result = await proc.run({ cmd: "git", args: ["worktree", "add", "--quiet", path, "HEAD"], ...{ cwd: root, timeoutMs: 10_000 } });
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
        const usageHash = refsForChat["usage"] || null;
        const usageObj = usageHash
          ? await objects.getJSON<{ models: Record<string, { input: number; cachedInput: number; cacheWriteInput?: number; output: number }> }>({ hash: usageHash })
          : null;
        // __op_chat_fact_summaries() already summarizes every existing
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
        const usage = usageObj?.value ?? null;
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
  async create(chatId, path = null) {
    let cid = chatId;
    if (!cid) {
      const raw = await id.new("chat");
      // Keep the whole generated payload, including the per-process counter.
      // The previous 12-char truncation kept only the high timestamp bits from
      // ids like `chat:<16 hex nanos><8 hex counter>`, so chats created within
      // the same ~65µs window could collide. Parallel subagents are commonly
      // created that close together, which made distinct prompts share one
      // hidden child chat.
      cid = raw.replace(/^chat:/, "");
    }
    if (path && String(path).trim()) {
      await pointers.set(`chat/${cid}/path`, String(path).trim());
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
    const path = chatWorktreePath(chatId, root);
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
  async setTitle({ chatId, title }) {
    const ref = `chat/${chatId}/title`;
    const previousTitle = await pointers.get(ref);
    const nextTitle = title == null || title.trim() === "" ? null : title.trim();
    if (nextTitle == null) {
      await pointers.delete(ref);
    } else {
      await pointers.set(ref, nextTitle);
    }
    const changed = (previousTitle || null) !== nextTitle;
    if (changed) {
      await recordChatTrailEntry(chatId, "agent:TitleUpdate", {
        title: nextTitle,
        previousTitle: previousTitle || null,
      });
    }
    return { chatId, previousTitle: previousTitle || null, title: nextTitle, changed };
  },
  async recordSummary({ chatId, summary, title = null }) {
    const body = String(summary ?? "").trim();
    if (!body) throw new Error("recordSummary requires a non-empty summary");
    const cleanTitle = title == null ? null : String(title).trim() || null;
    const entryId = await recordChatTrailEntry(chatId, "agent:Summary", {
      title: cleanTitle,
      body,
    }, { touch: true });
    return { chatId, entryId, title: cleanTitle };
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
const DEFAULT_SUBAGENT_TURNS = 6;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60_000;
const MAX_SUBAGENT_TIMEOUT_MS = 30 * 60_000;

type NormalizedSubagentSpec = Required<Pick<SubagentSpec, "label" | "task" | "worktree">> & Omit<SubagentSpec, "label" | "task" | "worktree"> & {
  maxTurns: number;
  timeoutMs: number;
};

function normalizeSubagentSpec(spec: SubagentSpec): NormalizedSubagentSpec {
  if (!spec || typeof spec !== "object") throw new Error("moo.agent.run requires a spec object");
  const label = String(spec.label ?? "").trim();
  const task = String(spec.task ?? "").trim();
  if (!label) throw new Error("moo.agent.run requires spec.label");
  if (!task) throw new Error("moo.agent.run requires spec.task");
  const maxTurns = Math.max(1, Math.floor(Number(spec.maxTurns ?? DEFAULT_SUBAGENT_TURNS) || DEFAULT_SUBAGENT_TURNS));
  const timeoutMs = Math.max(1_000, Math.min(MAX_SUBAGENT_TIMEOUT_MS, Math.floor(Number(spec.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS) || DEFAULT_SUBAGENT_TIMEOUT_MS)));
  const worktree = spec.worktree === "inherit" ? "inherit" : "isolated";
  return {
    ...spec,
    label,
    task,
    maxTurns,
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
    durationMs: 0,
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
  if (spec.model) await pointers.set(chatRefs(childChatId).model, spec.model);
  if (spec.effort) await memory.assert({ subject: `chat:${childChatId}`, predicate: "ui:effortLevel", object: spec.effort });

  const specHash = await objects.putJSON({ kind: "agent:SubagentSpec", value: spec });
  await pointers.set(`chat/${childChatId}/subagent-spec`, specHash);

  const payloadHash = await objects.putJSON({ kind: "agent:Subagent", value: {
    label: spec.label,
    task: spec.task,
    context: spec.context ?? null,
    expectedOutput: spec.expectedOutput ?? null,
    childChatId,
    parentRunJsStepId: ctx.runJsStepId,
    spec,
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
      maxTurns: spec.maxTurns,
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
    durationMs: 0,
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
      const raw = await __op_agent_run(JSON.stringify(request));
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
    const present = __op_facts_present(store, JSON.stringify(quads));
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

  async function applyPatch(input: unknown): Promise<void> {
    const groups = unpackMemoryPatchGroups(input);
    for (const group of groups) {
      const retracts = encodeMemoryFacts(group.retracts, false);
      const asserts = encodeMemoryFacts(group.asserts, true);
      if (retracts.length === 0 && asserts.length === 0) continue;
      const retractQuads: Quad[] = retracts.map(([subject, predicate, object]) => [graph, subject, predicate, object]);
      const assertQuads: Quad[] = asserts.map(([subject, predicate, object]) => [graph, subject, predicate, object]);
      assertFactObjects([...retractQuads, ...assertQuads]);
      const present = __op_facts_present(store, JSON.stringify([...retractQuads, ...assertQuads]));
      const addKeys = new Set(assertQuads.map((quad) => JSON.stringify(quad)));
      const removes: Quad[] = [];
      const adds: Quad[] = [];
      const removed: MemoryChange[] = [];
      const added: MemoryChange[] = [];
      for (let i = 0; i < retractQuads.length; i++) {
        const quad = retractQuads[i]!;
        if (!present[i] || addKeys.has(JSON.stringify(quad))) continue;
        removes.push(quad);
        removed.push({ subject: quad[1], predicate: quad[2], object: quad[3] });
      }
      const offset = retractQuads.length;
      for (let i = 0; i < assertQuads.length; i++) {
        const quad = assertQuads[i]!;
        if (present[offset + i]) continue;
        adds.push(quad);
        added.push({ subject: quad[1], predicate: quad[2], object: quad[3] });
      }
      if (removes.length === 0 && adds.length === 0) continue;
      await facts.swap({ store, removes, adds });
      if (removed.length > 0) await recordMemoryDiff(store, graph, "retract", removed);
      if (added.length > 0) await recordMemoryDiff(store, graph, "assert", added);
    }
  }

  return {
    async assert(args) {
      return applyAll("assert", args);
    },
    async retract(args) {
      return applyAll("retract", args);
    },
    async patch(args) {
      return applyPatch(args);
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
      async patch(args) {
        return (await resolve()).patch(args);
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

    // Backward-compat: older harness builds wrote vocab subjects as
    // "vocab:<name>". Treat those as describing the bare "<name>" predicate
    // so they line up with observed counts.
    const canonical = (s: string) =>
      s.startsWith("vocab:") ? s.slice("vocab:".length) : s;

    const out: Awaited<ReturnType<Moo["vocab"]["list"]>> = [];
    const seen = new Set<string>();
    for (const [subject, meta] of byPredicate) {
      const name = canonical(subject);
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

const TRACE_STRING_PREVIEW_CHARS = 256;
const TRACE_ARRAY_SAMPLE_LENGTH = 8;
const TRACE_OBJECT_SAMPLE_KEYS = 32;
const TRACE_HARD_CAP_BYTES = 4 * 1024;
const TRACE_HARD_CAP_PREVIEW_CHARS = 1024;
const TRACE_ERROR_STACK_LINES = 20;
const SENSITIVE_TRACE_KEY_RE = /password|token|secret|authorization|apiKey|api_key|cookie|bearer/i;
const LONG_BASE64_RE = /^[A-Za-z0-9+/=_-]+$/;

type TraceRedactContext = "input" | "output" | "error" | "event";
type TraceRedactOpts = { context?: TraceRedactContext };
type TraceShaper = (input: any) => any;

type TraceIndirectValue = { __redacted: string; bytes: number; sha256: string; preview?: string; objectHash?: string; objectKind?: string };

function canStoreTraceObject(): boolean {
  return typeof globalThis.__op_object_put === "function";
}

function traceObjectHash(kind: string, value: string): { objectHash?: string; objectKind?: string } {
  if (!canStoreTraceObject()) return {};
  try {
    return { objectHash: __op_object_put(kind, value), objectKind: kind };
  } catch {
    return {};
  }
}

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

function maybeHardCap<T>(value: T): T | TraceIndirectValue {
  const json = stableJson(value);
  if (json == null) return value;
  const bytes = stringBytes(json);
  if (bytes <= TRACE_HARD_CAP_BYTES) return value;
  return {
    __redacted: "oversize",
    bytes,
    sha256: sha256(json),
    preview: json.slice(0, TRACE_HARD_CAP_PREVIEW_CHARS),
    ...traceObjectHash("trace:Value", json),
  };
}

function redactString(value: string): string | Record<string, unknown> {
  const bytes = stringBytes(value);
  if (value.startsWith("data:") && value.length > TRACE_STRING_PREVIEW_CHARS) {
    const comma = value.indexOf(",");
    const header = comma >= 0 ? value.slice(5, comma) : value.slice(5, 128);
    const mediaType = (header.split(";")[0] || "text/plain");
    return { __redacted: "dataUrl", mediaType, bytes, sha256: sha256(value), ...traceObjectHash("trace:String", value) };
  }
  if (value.length > 1024 && LONG_BASE64_RE.test(value)) {
    return { __redacted: "base64", bytes, sha256: sha256(value), ...traceObjectHash("trace:String", value) };
  }
  if (value.length > TRACE_STRING_PREVIEW_CHARS) {
    return { __redacted: "string", bytes, sha256: sha256(value), preview: value.slice(0, TRACE_STRING_PREVIEW_CHARS), ...traceObjectHash("trace:String", value) };
  }
  return value;
}

function redactErrorObject(error: any): Record<string, unknown> {
  const stack = typeof error?.stack === "string" ? error.stack.split("\n").slice(0, TRACE_ERROR_STACK_LINES + 1).join("\n") : null;
  return {
    name: typeof error?.name === "string" ? error.name : "Error",
    message: typeof error?.message === "string" ? error.message : String(error),
    stack,
  };
}

function isBinaryValue(value: any): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value));
}

function redactInner(value: unknown, opts: TraceRedactOpts, seen: WeakSet<object>): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string") return maybeHardCap(redactString(value));
    return value;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "bigint") return String(value);
  if (value instanceof Error) return maybeHardCap(redactInner(redactErrorObject(value), { ...opts, context: "error" }, seen));
  if (isBinaryValue(value)) {
    const bytes = value instanceof ArrayBuffer ? value.byteLength : value.byteLength;
    const kind = value instanceof ArrayBuffer ? "ArrayBuffer" : ((value as any).constructor?.name ?? "TypedArray");
    return { __redacted: "binary", kind, bytes, sha256: sha256(value) };
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return { __redacted: "cycle" };
  seen.add(value);
  if (Array.isArray(value)) {
    const source = value.length > TRACE_ARRAY_SAMPLE_LENGTH ? value.slice(0, TRACE_ARRAY_SAMPLE_LENGTH) : value;
    const sample = source.map((item) => {
      const redacted = redactInner(item, opts, seen);
      return redacted === undefined ? null : redacted;
    });
    const shaped = value.length > TRACE_ARRAY_SAMPLE_LENGTH ? { __redacted: "array", length: value.length, sample } : sample;
    seen.delete(value);
    return maybeHardCap(shaped);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const selected = entries.length > TRACE_OBJECT_SAMPLE_KEYS ? entries.slice(0, TRACE_OBJECT_SAMPLE_KEYS) : entries;
  const out: Record<string, unknown> = {};
  for (const [key, child] of selected) {
    if (SENSITIVE_TRACE_KEY_RE.test(key)) {
      out[key] = "<redacted>";
      continue;
    }
    const redacted = redactInner(child, opts, seen);
    if (redacted !== undefined) out[key] = redacted;
  }
  const shaped = entries.length > TRACE_OBJECT_SAMPLE_KEYS ? { __redacted: "object", keys: entries.length, sample: out } : out;
  seen.delete(value);
  return maybeHardCap(shaped);
}

export function redactValue(value: unknown, opts: TraceRedactOpts = {}): unknown {
  return redactInner(value, opts, new WeakSet<object>());
}

function shapePointerState(input: any): Record<string, unknown> {
  const pointer = input?.pointer ?? input?.statePointer ?? input?.target ?? input?.name ?? null;
  const state = input?.state ?? input?.value ?? input?.message ?? input?.data ?? input;
  const json = stableJson(state) ?? String(state ?? "");
  return { pointer, bytes: stringBytes(json), sha256: sha256(json) };
}

const inputShapers: Record<string, TraceShaper> = {
  "fs.read": (i) => ({ path: i.path, bytes: i.bytes ?? null }),
  "fs.write": (i) => ({ path: i.path, bytes: i?.content?.length ?? null, hash: i?.hash ?? null }),
  "fs.patch": (i) => ({ files: (i.files ?? []).map((f: any) => ({ path: f.path, op: f.op })), bytes: i?.patch?.length ?? null }),
  "objects.putText": (i) => ({ kind: i.kind, bytes: i?.text?.length ?? null }),
  "objects.putJSON": (i) => ({ kind: i.kind, bytes: stableJson(i?.value ?? null)?.length ?? null }),
  "objects.getText": (i) => ({ hash: i.hash }),
  "objects.getJSON": (i) => ({ hash: i.hash }),
  "facts.match": (i) => ({ store: i.store, graph: i.graph, patterns: i.patterns?.length ?? null }),
  "facts.matchAll": (i) => ({ store: i.store, graph: i.graph, patternCount: (i.patterns ?? []).length, limit: i.limit }),
  "sparql.select": (i) => ({ store: i.store, graph: i.graph, queryBytes: i.query?.length ?? null }),
  "sparql.construct": (i) => ({ store: i.store, graph: i.graph, queryBytes: i.query?.length ?? null }),
  "sparql.query": (i) => ({ store: i.store, graph: i.graph, queryBytes: i.query?.length ?? null }),
  "ui.state.set": shapePointerState,
  "ui.state.get": shapePointerState,
  "chat.message.inflight": shapePointerState,
};

const outputShapers: Record<string, TraceShaper> = {
  "facts.match": (o) => ({ rowCount: (o?.bindings ?? o?.rows ?? []).length, sample: (o?.bindings ?? o?.rows ?? []).slice(0, 4) }),
  "facts.matchAll": (o) => ({ rowCount: (o?.bindings ?? o?.rows ?? []).length, sample: (o?.bindings ?? o?.rows ?? []).slice(0, 4) }),
  "sparql.select": (o) => ({ rowCount: (o?.results?.bindings ?? []).length, sample: (o?.results?.bindings ?? []).slice(0, 4) }),
  "sparql.construct": (o) => ({ rowCount: (o?.results?.bindings ?? o?.bindings ?? o?.rows ?? []).length, sample: (o?.results?.bindings ?? o?.bindings ?? o?.rows ?? []).slice(0, 4) }),
  "sparql.query": (o) => ({ rowCount: (o?.results?.bindings ?? o?.bindings ?? o?.rows ?? []).length, sample: (o?.results?.bindings ?? o?.bindings ?? o?.rows ?? []).slice(0, 4) }),
  "fs.read": (o) => (typeof o === "string" ? { bytes: stringBytes(o), preview: o.slice(0, TRACE_STRING_PREVIEW_CHARS) } : o),
  "objects.getText": (o) => (typeof o === "string" ? { bytes: stringBytes(o), preview: o.slice(0, TRACE_STRING_PREVIEW_CHARS) } : o),
  "objects.getJSON": (o) => ({ shape: resultShape(o) }),
  "ui.state.set": shapePointerState,
  "ui.state.get": shapePointerState,
  "chat.message.inflight": shapePointerState,
};

function normalizeTraceName(name: string): string {
  return name.startsWith("moo.") ? name.slice(4) : name;
}

function stateLikeTraceName(name: string): boolean {
  const n = normalizeTraceName(name);
  return /(^|\.)(ui\.state\.(set|get)|state\.(set|get)|chat\.message\.inflight|message\.inflight)(\.|$)/.test(n);
}

function applyTraceShaper(name: string, value: unknown, context: TraceRedactContext): unknown {
  const n = normalizeTraceName(name);
  const shaper = context === "output" ? outputShapers[n] : inputShapers[n];
  if (shaper) {
    try { return shaper(value as any); } catch (e: any) { return { shaperError: e?.message ?? String(e) }; }
  }
  if (stateLikeTraceName(n)) return shapePointerState(value as any);
  return value;
}

function redactedTraceValue(name: string, value: unknown, context: TraceRedactContext): unknown {
  const shaped = context === "error" ? redactErrorObject(value) : applyTraceShaper(name, value, context);
  return redactValue(shaped, { context });
}

function traceDataJson(name: string, value: unknown, context: TraceRedactContext): string {
  return JSON.stringify(redactedTraceValue(name, value, context));
}

function traceErrorJson(name: string, error: unknown): string {
  return JSON.stringify(redactedTraceValue(name, error, "error"));
}

function semanticTraceInputValue(name: string, path: string[], args: unknown[]): unknown {
  const raw = traceArgsObject(args);
  const shaped = applyTraceShaper(name, raw, "input");
  return shaped === raw ? traceSemanticInput(path, args) : shaped;
}

function semanticTraceOutputValue(name: string, path: string[], result: unknown): unknown {
  const shaped = applyTraceShaper(name, result, "output");
  return shaped === result ? traceSemanticOutput(path, result) : shaped;
}

export function summarizeTraceValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactValue(value);
  if (typeof value === "function") return undefined;
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((v) => summarizeTraceValue(v, depth + 1, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = summarizeTraceValue(v, depth + 1, seen);
    }
    return out;
  }
  return redactValue(String(value));
}

function stringBytes(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function resultShape(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { type: "string", chars: value.length, bytes: stringBytes(value) };
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (value && typeof value === "object") return { type: "object", keys: Object.keys(value as Record<string, unknown>) };
  return { type: value === null ? "null" : typeof value };
}

function outputSummary(value: unknown): unknown {
  if (typeof value === "string") return { type: "string", chars: value.length, bytes: stringBytes(value), value: redactValue(value) };
  if (Array.isArray(value)) return { type: "array", length: value.length, value: redactValue(summarizeTraceValue(value)) };
  if (value && typeof value === "object") return summarizeTraceValue(value);
  return value;
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

function traceSemanticInput(path: string[], args: unknown[]): Record<string, unknown> {
  const root = path[0] ?? "";
  const method = path[path.length - 1] ?? "";
  const first = args[0] as any;
  const obj = traceArgsObject(args);
  const data: Record<string, unknown> = { input: summarizeTraceValue(args) };
  if (root === "fs") {
    data.path = typeof first === "string" ? first : (obj as any).path ?? null;
    data.pattern = method === "glob" ? first ?? (obj as any).pattern ?? null : null;
    data.cwd = (obj as any).cwd ?? null;
    data.dryRun = (obj as any).dryRun ?? null;
    if (method === "write") data.content = typeof args[1] === "string" ? { chars: args[1].length, bytes: stringBytes(args[1]) } : resultShape(args[1]);
  } else if (root === "proc") {
    data.cmd = obj.cmd ?? null;
    data.argsCount = Array.isArray(obj.args) ? obj.args.length : 0;
    data.cwd = obj.cwd ?? null;
    data.timeoutMs = obj.timeoutMs ?? null;
    data.check = obj.check ?? null;
    data.maxOutputBytes = obj.maxOutputBytes ?? null;
    data.envKeys = obj.env && typeof obj.env === "object" ? Object.keys(obj.env).sort() : [];
    if (typeof obj.stdin === "string") data.stdin = { chars: obj.stdin.length, bytes: stringBytes(obj.stdin) };
  } else if (root === "http") {
    data.method = obj.method ?? (method === "fetch" || method === "stream" ? "GET" : null);
    data.url = obj.url ?? null;
    data.timeoutMs = obj.timeoutMs ?? null;
    data.headerKeys = obj.headers && typeof obj.headers === "object" ? Object.keys(obj.headers).sort() : [];
    data.bodyShape = resultShape(obj.body);
    if (typeof obj.body === "string") data.body = { chars: obj.body.length, bytes: stringBytes(obj.body) };
  } else if (root === "env") {
    data.name = typeof first === "string" ? first : null;
    data.names = Array.isArray(first) ? first : null;
    data.count = Array.isArray(first) ? first.length : null;
  } else if (root === "workspace") {
    data.chatId = obj.chatId ?? null;
    data.root = obj.root ?? null;
  } else if (root === "objects") {
    data.kind = first?.kind ?? null;
    data.hash = first?.hash ?? null;
    if (typeof first?.text === "string") data.textChars = first.text.length;
    if ("value" in (first ?? {})) data.valueShape = resultShape(first.value);
  } else if (root === "pointers") {
    data.name = typeof first === "string" ? first : first?.name ?? null;
    data.prefix = method === "list" || method === "entries" ? (args[0] ?? "") : null;
    if (method === "cas") {
      data.expected = args[1] ?? null;
      data.next = args[2] ?? null;
    } else if (method === "set") {
      data.target = args[1] ?? null;
    }
  } else if (root === "facts") {
    data.store = obj.store ?? null;
    data.graph = obj.graph ?? null;
    data.subject = obj.subject ?? null;
    data.predicate = obj.predicate ?? null;
    data.hasObject = obj.object != null;
    data.limit = obj.limit ?? null;
    data.format = obj.format ?? null;
    data.quadCount = Array.isArray(obj.quads) ? obj.quads.length : null;
    data.patternCount = Array.isArray(obj.patterns) ? obj.patterns.length : null;
    data.dryRun = obj.dryRun ?? null;
  } else if (root === "sparql") {
    data.store = obj.store ?? null;
    data.graph = obj.graph ?? null;
    data.limit = obj.limit ?? null;
    data.format = obj.format ?? null;
    data.queryChars = typeof obj.query === "string" ? obj.query.length : null;
  } else if (root === "memory") {
    data.method = method;
    data.projectId = method === "project" ? (typeof first === "string" ? first : null) : (obj as any).projectId ?? null;
    data.factCount = Array.isArray((obj as any).facts) ? (obj as any).facts.length : Array.isArray(first) ? first.length : null;
    data.patternCount = Array.isArray((obj as any).patterns) ? (obj as any).patterns.length : null;
    data.limit = (obj as any).limit ?? null;
    data.subject = (obj as any).subject ?? null;
    data.predicate = (obj as any).predicate ?? null;
    data.hasObject = (obj as any).object != null;
  } else if (root === "chat") {
    data.chatId = (obj as any).chatId ?? (typeof first === "string" ? first : null);
    data.title = (obj as any).title ?? null;
    data.path = (obj as any).path ?? null;
    data.summaryChars = typeof (obj as any).summary === "string" ? (obj as any).summary.length : null;
  } else if (root === "ui") {
    data.chatId = (obj as any).chatId ?? null;
    data.title = (obj as any).spec?.title ?? (obj as any).manifest?.title ?? null;
    data.fieldCount = Array.isArray((obj as any).spec?.fields) ? (obj as any).spec.fields.length : null;
    data.itemCount = Array.isArray((obj as any).spec?.items) ? (obj as any).spec.items.length : null;
    data.uiId = (obj as any).uiId ?? (obj as any).id ?? (obj as any).manifest?.id ?? null;
    data.instanceId = (obj as any).instanceId ?? null;
    data.apiCount = Array.isArray((obj as any).manifest?.api) ? (obj as any).manifest.api.length : null;
    const bundle = (obj as any).bundle;
    if (bundle && typeof bundle === "object") data.bundle = {
      htmlChars: typeof bundle.html === "string" ? bundle.html.length : null,
      cssChars: typeof bundle.css === "string" ? bundle.css.length : null,
      jsChars: typeof bundle.js === "string" ? bundle.js.length : null,
      fileCount: bundle.files && typeof bundle.files === "object" ? Object.keys(bundle.files).length : 0,
    };
    if (typeof (obj as any).handler === "string") data.handlerChars = (obj as any).handler.length;
    if ("state" in obj) data.stateShape = resultShape((obj as any).state);
  } else if (root === "mcp") {
    if (path.length >= 3 && !["list", "tools", "listServers", "getServer", "saveServer", "removeServer", "login", "completeLogin", "logout", "authStatus", "listTools", "callTool", "request"].includes(path[1]!)) {
      data.serverId = path[1];
      data.toolName = path[2];
      data.callStyle = "dynamic";
      data.argumentsShape = resultShape(first);
    } else {
      data.serverId = (obj as any).serverId ?? (method === "callTool" || method === "request" ? args[0] : typeof args[0] === "string" ? args[0] : null);
      data.toolName = (obj as any).name ?? (method === "callTool" ? args[1] : null);
      data.rpcMethod = method === "request" ? args[1] : null;
      data.transport = (obj as any).transport ?? null;
      data.enabled = (obj as any).enabled ?? null;
    }
  } else if (root === "agent") {
    data.label = (obj as any).label ?? null;
    data.taskChars = typeof (obj as any).task === "string" ? (obj as any).task.length : null;
    data.chatId = (obj as any).chatId ?? (method === "fork" ? args[0] : null);
    data.model = (obj as any).model ?? null;
    data.effort = (obj as any).effort ?? null;
    data.store = method === "claim" || method === "complete" ? args[0] : null;
    data.graph = method === "claim" || method === "complete" ? args[1] : null;
    data.runId = method === "claim" ? args[2] : null;
    data.stepId = method === "complete" ? args[2] : null;
  } else if (root === "vocab") {
    data.name = typeof first === "string" ? first : (obj as any).name ?? null;
    data.hasDescription = typeof (args[1] as any)?.description === "string";
  } else if (root === "time") {
    data.ms = method === "nowPlus" ? first ?? null : null;
  } else if (root === "id") {
    data.prefix = first ?? null;
  } else if (root === "validate") {
    data.value = first ?? null;
  } else if (root === "term") {
    data.value = first instanceof Date ? first.toISOString() : first ?? null;
  } else if (root === "events") {
    data.payloadShape = resultShape(first);
  } else if (root === "log") {
    data.argCount = args.length;
  }
  return data;
}

function traceSemanticOutput(path: string[], result: unknown): Record<string, unknown> {
  const root = path[0] ?? "";
  const method = path[path.length - 1] ?? "";
  const data: Record<string, unknown> = { output: outputSummary(result), outputShape: resultShape(result) };
  if (root === "facts" || root === "sparql" || root === "memory" || root === "vocab") data.rows = rowCount(result);
  if (root === "fs") {
    if (typeof result === "string") { data.chars = result.length; data.bytes = stringBytes(result); }
    if (Array.isArray(result)) data.count = result.length;
    if (result && typeof result === "object") { data.kind = (result as any).kind ?? null; data.size = (result as any).size ?? null; data.exists = true; }
    if (result == null || typeof result === "boolean") data.exists = !!result;
  }
  if (root === "proc") {
    data.code = (result as any)?.code ?? null;
    data.durationMs = (result as any)?.durationMs ?? null;
    data.timedOut = (result as any)?.timedOut ?? null;
    if (typeof (result as any)?.stdout === "string") data.stdout = { chars: (result as any).stdout.length, bytes: stringBytes((result as any).stdout) };
    if (typeof (result as any)?.stderr === "string") data.stderr = { chars: (result as any).stderr.length, bytes: stringBytes((result as any).stderr) };
  }
  if (root === "http") {
    data.status = (result as any)?.status ?? null;
    if (typeof (result as any)?.body === "string") data.body = { chars: (result as any).body.length, bytes: stringBytes((result as any).body) };
    data.headerKeys = (result as any)?.headers && typeof (result as any).headers === "object" ? Object.keys((result as any).headers).sort() : [];
    data.streaming = method === "stream";
  }
  if (root === "env") {
    data.found = typeof result === "string";
    if (result && typeof result === "object") data.count = Object.keys(result as Record<string, unknown>).length;
  }
  if (root === "workspace") data.root = (result as any)?.root ?? null;
  if (root === "facts" || root === "memory") {
    data.added = (result as any)?.added ?? null;
    data.removed = (result as any)?.removed ?? null;
    data.dryRun = (result as any)?.dryRun ?? null;
  }
  if (root === "pointers") {
    data.changed = (result as any)?.changed ?? null;
    data.matched = method === "cas" ? !!result : null;
    if (Array.isArray(result)) data.count = result.length;
  }
  if (root === "objects") {
    data.found = result != null;
    data.kind = (result as any)?.kind ?? null;
  }
  if (root === "chat") {
    data.chatId = (result as any)?.chatId ?? (typeof result === "string" ? result : null);
    data.stepId = (result as any)?.stepId ?? null;
    data.count = Array.isArray(result) ? result.length : null;
  }
  if (root === "ui") {
    data.stepId = (result as any)?.stepId ?? null;
    data.uiId = (result as any)?.uiId ?? null;
    data.instanceId = (result as any)?.instanceId ?? null;
    data.createdState = (result as any)?.createdState ?? null;
  }
  if (root === "mcp") {
    data.toolCount = Array.isArray(result) ? result.length : Array.isArray((result as any)?.tools) ? (result as any).tools.length : null;
    data.status = (result as any)?.status ?? null;
    data.serverId = (result as any)?.serverId ?? null;
    data.authenticated = (result as any)?.authenticated ?? null;
  }
  if (root === "agent") {
    data.status = (result as any)?.status ?? null;
    data.childChatId = (result as any)?.childChatId ?? (result as any)?.chatId ?? null;
    data.runId = (result as any)?.runId ?? null;
    data.stepId = (result as any)?.stepId ?? null;
  }
  if (root === "time") data.timestamp = result;
  if (root === "id") data.id = result;
  if (root === "validate") data.valid = result;
  if (root === "term") data.turtle = String(result);
  return data;
}

function currentTraceId(): string | null {
  return typeof globalThis.__op_trace_current === "function" ? globalThis.__op_trace_current() : null;
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
          if (!currentTraceId()) {
            return value.apply(obj, args);
          }
          const name = `moo.${nextPath.join(".")}`;
          let previousParent: string | null = null;
          const spanId = __op_trace_insert(JSON.stringify({
            kind: "span",
            name,
            status: "running",
            data: redactedTraceValue(name, semanticTraceInputValue(name, nextPath, args), "input"),
          }));
          if (spanId) previousParent = __op_trace_set_parent(spanId);
          const finishOk = (result: unknown) => {
            if (spanId) __op_trace_finish(spanId, "ok", JSON.stringify(redactedTraceValue(name, semanticTraceOutputValue(name, nextPath, result), "output")));
            return result;
          };
          const finishError = (e: any) => {
            if (spanId) __op_trace_finish(spanId, "error", traceErrorJson(name, e));
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
                if (spanId) __op_trace_set_parent(previousParent);
              });
            }
            return finishOk(result);
          } catch (e: any) {
            finishError(e);
            throw e;
          } finally {
            if (!pending && spanId) __op_trace_set_parent(previousParent);
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

export const moo: Moo = createTracedObject(rawMoo);
