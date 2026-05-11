import type {
  Moo,
  WorkflowDefinitionSummary,
  WorkflowForkArgs,
  WorkflowInspection,
  WorkflowIr,
  WorkflowNode,
  WorkflowRef,
  WorkflowRunFilter,
  WorkflowRunInspection,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowSaveArgs,
  WorkflowStartArgs,
  WorkflowStepEffect,
  WorkflowStepRun,
} from "./types";
import { decodeJsonPointer, encodeJsonPointer } from "./lib";

const WORKFLOW_STORE = "workflow/facts";
const WAITING_GRAPH = "workflow:waiting";
const DEFAULT_LOOP_MAX = 100;

type WorkflowDeps = Pick<Moo, "objects" | "pointers" | "facts" | "proc" | "mcp" | "agent" | "time" | "id">;
type JsonRecord = Record<string, unknown>;
type StepCall = { __workflowNode: WorkflowNode; out(ref: WorkflowRef): WorkflowNode };
type ExecSignal =
  | { kind: "wait"; stepPath: string }
  | { kind: "done"; output: unknown }
  | { kind: "break" }
  | { kind: "goto"; target: string }
  | { kind: "stop"; reason: string };

type ExecCtx = {
  deps: WorkflowDeps;
  runId: string;
  definition: WorkflowIr;
  input: unknown;
  state: JsonRecord;
  loopStack: Array<{ id: string; iteration: number }>;
};

type RunMeta = WorkflowRunSummary & { createdAt: string; updatedAt: string };

function safePart(value: string): string {
  return encodeURIComponent(String(value));
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function nowIsoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function currentPointer(id: string): string {
  return `workflow/${safePart(id)}/current`;
}

function sourcePointer(id: string): string {
  return `workflow/${safePart(id)}/source`;
}

function runPrefix(runId: string): string {
  return `workflow/run/${safePart(runId)}`;
}

function runPointer(runId: string, name: string): string {
  return `${runPrefix(runId)}/${name}`;
}

function stepPointer(runId: string, stepPath: string, name: string): string {
  return `${runPrefix(runId)}/step/${safePart(stepPath)}/${name}`;
}

function workflowSubject(id: string): string {
  return `workflow:${safePart(id)}`;
}

function runSubject(runId: string): string {
  return `workflow-run:${safePart(runId)}`;
}

function stepSubject(runId: string, stepPath: string): string {
  return `workflow-step-run:${safePart(runId)}/${safePart(stepPath)}`;
}

function workflowGraph(id: string): string {
  return `workflow:${safePart(id)}`;
}

function runGraph(runId: string): string {
  return `workflow-run:${safePart(runId)}`;
}

function isObject(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRef(value: unknown): value is WorkflowRef {
  return isObject(value) && typeof value.ref === "string";
}

function makeRefProxy(prefix: string): any {
  const make = (path: string): any => new Proxy({ ref: path }, {
    get(target, prop) {
      if (prop === "ref") return target.ref;
      if (prop === "toJSON") return () => ({ ref: target.ref });
      if (prop === Symbol.toPrimitive) return () => target.ref;
      if (typeof prop === "symbol") return undefined;
      return make(`${target.ref}.${String(prop)}`);
    },
  });
  return make(prefix);
}

function nodeFrom(value: unknown): WorkflowNode {
  if (isObject(value) && value.__workflowNode) return value.__workflowNode as WorkflowNode;
  return value as WorkflowNode;
}

function compact<T>(values: T[]): T[] {
  return values.filter((value) => value != null) as T[];
}

function stepCall(node: WorkflowNode): StepCall {
  const call: StepCall = {
    __workflowNode: node,
    out(ref: WorkflowRef) {
      (node as any).out = ref;
      return node;
    },
  };
  Object.defineProperty(call, "__workflowNode", { enumerable: false, value: node });
  return call;
}

function createStepBuilder(id: string): any {
  const makeStep = (value: WorkflowStepEffect) => stepCall({ kind: "step", id, effect: value });
  const mcpToolProxy = (server: string) => new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      return (args?: unknown) => makeStep({ kind: "mcp.call", server, tool: String(prop), args });
    },
  });
  return {
    proc: { run: (args?: unknown) => makeStep({ kind: "proc.run", args }) },
    agent: { run: (args?: unknown) => makeStep({ kind: "agent.run", args }) },
    ui: { ask: (args?: unknown) => makeStep({ kind: "ui.ask", args }) },
    mcp: new Proxy({}, {
      get(_target, prop) {
        if (typeof prop === "symbol") return undefined;
        return mcpToolProxy(String(prop));
      },
    }),
  };
}

function normalizeBody(values: unknown[]): WorkflowNode[] {
  return compact(values).flatMap((value) => {
    const node = nodeFrom(value);
    if (!node) return [];
    return [node];
  });
}

export function createWorkflowDsl(id: string, build: ((w: any) => unknown) | WorkflowIr | WorkflowNode[] | WorkflowNode): WorkflowIr {
  if (!id || /\s/.test(id)) throw new Error("workflow id must be non-empty and contain no whitespace");
  if (isObject(build) && (build as any).kind === "workflow") return normalizeWorkflowIr(build as WorkflowIr, id);
  if (Array.isArray(build) || (isObject(build) && typeof (build as any).kind === "string")) {
    return normalizeWorkflowIr({ kind: "workflow", id, body: normalizeBody(Array.isArray(build) ? build : [build]) });
  }
  if (typeof build !== "function") throw new Error("moo.workflow requires a builder function or workflow IR");
  const w: any = {
    input: makeRefProxy("input"),
    state: makeRefProxy("state"),
    chatId: { ref: "chatId" },
    flow: (...nodes: unknown[]) => ({ kind: "flow", body: normalizeBody(nodes) }),
    step: (stepId: string) => createStepBuilder(stepId),
    loop: (loopId: string, optsOrFirst?: unknown, ...rest: unknown[]) => {
      const hasOpts = isObject(optsOrFirst) && !Array.isArray(optsOrFirst) && !("kind" in optsOrFirst) && !("__workflowNode" in optsOrFirst);
      const opts = hasOpts ? optsOrFirst as { max?: number } : {};
      const nodes = hasOpts ? rest : [optsOrFirst, ...rest];
      return { kind: "loop", id: loopId, opts, body: normalizeBody(nodes) };
    },
    when: (test: unknown, ...nodes: unknown[]) => ({ kind: "when", test, body: normalizeBody(nodes) }),
    break: (test?: unknown) => ({ kind: "break", ...(test === undefined ? {} : { test }) }),
    goto: (target: string) => ({ kind: "goto", target }),
    set: (ref: WorkflowRef, value: unknown, idValue?: string) => ({ kind: "set", ...(idValue ? { id: idValue } : {}), ref, value }),
    stopUnless: (test: unknown, reason?: string) => ({ kind: "stopUnless", test, reason }),
    done: (value?: unknown) => ({ kind: "done", value }),
    eq: (a: unknown, b: unknown) => ({ op: "eq", args: [a, b] }),
    not: (value: unknown) => ({ op: "not", args: [value] }),
    concat: (...args: unknown[]) => ({ op: "concat", args }),
    trim: (value: unknown) => ({ op: "trim", args: [value] }),
  };
  const built = build(w);
  const node = nodeFrom(built);
  const body = node && (node as any).kind === "flow" ? ((node as any).body ?? []) : normalizeBody([node]);
  return normalizeWorkflowIr({ kind: "workflow", id, body });
}

function normalizeWorkflowIr(input: WorkflowIr, fallbackId?: string): WorkflowIr {
  const id = String(input.id || fallbackId || "").trim();
  if (!id || /\s/.test(id)) throw new Error("workflow definition requires id without whitespace");
  const body = normalizeBody(input.body ?? []);
  return {
    ...input,
    kind: "workflow",
    id,
    body,
    ...(input.title ? { title: String(input.title) } : {}),
    ...(input.version ? { version: String(input.version) } : {}),
  };
}

function refPath(ref: WorkflowRef): string {
  if (!isRef(ref)) throw new Error("workflow ref expected");
  return ref.ref;
}

function getPath(root: unknown, path: string): unknown {
  if (!path) return root;
  let cur: any = root;
  for (const part of path.split(".")) {
    if (!part) continue;
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(root: JsonRecord, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  if (!parts.length) throw new Error("cannot assign empty ref");
  let cur: any = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]!;
    if (!isObject(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]!] = value;
}

function truthy(value: unknown): boolean {
  return !!value;
}

function evalValue(value: unknown, ctx: Pick<ExecCtx, "input" | "state"> & { chatId?: string | null }): unknown {
  if (isRef(value)) {
    if (value.ref === "chatId") return ctx.chatId ?? null;
    if (value.ref === "input") return ctx.input;
    if (value.ref.startsWith("input.")) return getPath(ctx.input, value.ref.slice("input.".length));
    if (value.ref === "state") return ctx.state;
    if (value.ref.startsWith("state.")) return getPath(ctx.state, value.ref.slice("state.".length));
    return undefined;
  }
  if (Array.isArray(value)) return value.map((item) => evalValue(item, ctx));
  if (isObject(value)) {
    const op = typeof value.op === "string" ? value.op : null;
    if (op) {
      const args = Array.isArray(value.args) ? value.args.map((arg) => evalValue(arg, ctx)) : [];
      if (op === "eq") return args[0] === args[1];
      if (op === "not") return !truthy(args[0]);
      if (op === "concat") return args.map((arg) => arg == null ? "" : String(arg)).join("");
      if (op === "trim") return String(args[0] ?? "").trim();
      if (op === "value") return value.value;
      throw new Error(`unknown workflow expression op: ${op}`);
    }
    const out: JsonRecord = {};
    for (const [key, child] of Object.entries(value)) out[key] = evalValue(child, ctx);
    return out;
  }
  return value;
}

function readPointerJson<T>(target: string | null, fallback: T): T {
  if (!target) return fallback;
  const decoded = decodeJsonPointer<T>(target);
  if (decoded === null && target !== "json:null") return fallback;
  return decoded as T;
}

async function objectJson<T>(deps: WorkflowDeps, hash: string | null, fallback: T): Promise<T> {
  if (!hash) return fallback;
  const row = await deps.objects.getJSON<T>({ hash });
  return row ? row.value : fallback;
}

async function getRunMeta(deps: WorkflowDeps, runId: string): Promise<RunMeta | null> {
  return readPointerJson<RunMeta | null>(await deps.pointers.get(runPointer(runId, "meta")), null);
}

async function setRunMeta(deps: WorkflowDeps, meta: RunMeta): Promise<void> {
  meta.updatedAt = nowIsoFromMs(await deps.time.nowMs());
  await deps.pointers.set(runPointer(meta.runId, "meta"), encodeJsonPointer(meta));
}

async function getRunState(deps: WorkflowDeps, runId: string): Promise<JsonRecord> {
  const state = readPointerJson<unknown>(await deps.pointers.get(runPointer(runId, "state")), {});
  return isObject(state) ? state : {};
}

async function setRunState(deps: WorkflowDeps, runId: string, state: JsonRecord): Promise<void> {
  await deps.pointers.set(runPointer(runId, "state"), encodeJsonPointer(state));
}

async function getRunSteps(deps: WorkflowDeps, runId: string): Promise<WorkflowStepRun[]> {
  const steps = readPointerJson<unknown>(await deps.pointers.get(runPointer(runId, "steps")), []);
  return Array.isArray(steps) ? steps as WorkflowStepRun[] : [];
}

async function setRunSteps(deps: WorkflowDeps, runId: string, steps: WorkflowStepRun[]): Promise<void> {
  await deps.pointers.set(runPointer(runId, "steps"), encodeJsonPointer(steps));
}

async function getRunInput(deps: WorkflowDeps, runId: string): Promise<unknown> {
  return objectJson(deps, await deps.pointers.get(runPointer(runId, "input")), {});
}

async function getRunEvents(deps: WorkflowDeps, runId: string): Promise<unknown[]> {
  return objectJson(deps, await deps.pointers.get(runPointer(runId, "events")), []);
}

async function appendEvent(deps: WorkflowDeps, runId: string, event: JsonRecord): Promise<void> {
  const events = await getRunEvents(deps, runId);
  events.push({ ...event, at: nowIsoFromMs(await deps.time.nowMs()) });
  const hash = await deps.objects.putJSON({ kind: "workflow:Events", value: events });
  await deps.pointers.set(runPointer(runId, "events"), hash);
}

async function replaceSubjectFacts(deps: WorkflowDeps, graph: string, subject: string, adds: Array<[string, string, unknown]>): Promise<void> {
  const existing = await deps.facts.match({ store: WORKFLOW_STORE, graph, subject });
  await deps.facts.swap({
    store: WORKFLOW_STORE,
    removes: existing.map(([g, s, p, o]) => [g, s, p, o]),
    adds: adds.map(([predicate, objectSubject, object]) => [graph, subject, predicate, object ?? objectSubject] as any),
  });
}

async function removeSubjectFacts(deps: WorkflowDeps, graph: string, subject: string): Promise<void> {
  const existing = await deps.facts.match({ store: WORKFLOW_STORE, graph, subject });
  if (!existing.length) return;
  await deps.facts.swap({ store: WORKFLOW_STORE, removes: existing.map(([g, s, p, o]) => [g, s, p, o]), adds: [] });
}

async function removeWaitingFacts(deps: WorkflowDeps, runId: string): Promise<void> {
  const subject = runSubject(runId);
  const rows = await deps.facts.match({ store: WORKFLOW_STORE, graph: WAITING_GRAPH, subject });
  if (!rows.length) return;
  await deps.facts.swap({ store: WORKFLOW_STORE, removes: rows.map(([g, s, p, o]) => [g, s, p, o]), adds: [] });
}

async function indexDefinition(deps: WorkflowDeps, definition: WorkflowIr, hash: string, source?: unknown): Promise<WorkflowInspection> {
  const summary = summarizeDefinition(definition, hash);
  const graph = workflowGraph(definition.id);
  await deps.facts.deleteGraph({ store: WORKFLOW_STORE, graph, dryRun: false });
  const subject = workflowSubject(definition.id);
  const now = nowIsoFromMs(await deps.time.nowMs());
  const adds: any[] = [
    [graph, subject, "rdf:type", "workflow:Definition"],
    [graph, subject, "workflow:id", definition.id],
    [graph, subject, "workflow:currentIr", currentPointer(definition.id)],
    [graph, subject, "workflow:irHash", hash],
    [graph, subject, "workflow:updatedAt", now],
  ];
  if (definition.title) adds.push([graph, subject, "workflow:title", definition.title]);
  if (definition.version) adds.push([graph, subject, "workflow:version", definition.version]);
  for (const use of summary.uses.mcp) adds.push([graph, subject, "workflow:usesMcpTool", use]);
  for (const use of summary.uses.proc) adds.push([graph, subject, "workflow:usesProcCommand", use]);
  for (const use of summary.uses.agent) adds.push([graph, subject, "workflow:usesAgentRole", use]);
  for (const use of summary.uses.ui) adds.push([graph, subject, "workflow:usesUi", use]);
  for (const step of flattenDefinitionSteps(definition)) {
    const stepSubj = `workflow-step:${safePart(definition.id)}/${safePart(step.id)}`;
    adds.push([graph, subject, "workflow:hasStep", stepSubj]);
    adds.push([graph, stepSubj, "rdf:type", "workflow:Step"]);
    adds.push([graph, stepSubj, "workflow:stepId", step.id]);
    adds.push([graph, stepSubj, "workflow:kind", step.kind]);
  }
  await deps.facts.addAll({ store: WORKFLOW_STORE, quads: adds });
  if (source !== undefined) {
    const sourceHash = await deps.objects.putJSON({ kind: "workflow:Source", value: source });
    await deps.pointers.set(sourcePointer(definition.id), sourceHash);
  }
  return { ...summary, definition, mermaid: renderDefinitionMermaid(definition), updatedAt: now };
}

function flattenDefinitionSteps(definition: WorkflowIr): Array<{ id: string; kind: string }> {
  const out: Array<{ id: string; kind: string }> = [];
  const visit = (nodes: WorkflowNode[]) => {
    for (const node of nodes) {
      if (!node) continue;
      if (node.kind === "step") out.push({ id: node.id, kind: node.effect.kind === "mcp.call" ? `mcp.${node.effect.server}.${node.effect.tool}` : node.effect.kind });
      else if (node.kind === "flow" || node.kind === "loop" || node.kind === "when") visit((node as any).body ?? []);
    }
  };
  visit(definition.body);
  return out;
}

function summarizeDefinition(definition: WorkflowIr, hash: string): WorkflowDefinitionSummary {
  const uses = { mcp: [] as string[], proc: [] as string[], agent: [] as string[], ui: [] as string[] };
  const seen = { mcp: new Set<string>(), proc: new Set<string>(), agent: new Set<string>(), ui: new Set<string>() };
  let steps = 0;
  const visit = (nodes: WorkflowNode[]) => {
    for (const node of nodes) {
      if (!node) continue;
      if (node.kind === "step") {
        steps += 1;
        const effect = node.effect;
        if (effect.kind === "mcp.call") {
          const value = `${effect.server}.${effect.tool}`;
          if (!seen.mcp.has(value)) { seen.mcp.add(value); uses.mcp.push(value); }
        } else if (effect.kind === "proc.run") {
          const cmd = isObject(effect.args) && typeof effect.args.cmd === "string" ? effect.args.cmd : "proc.run";
          if (!seen.proc.has(cmd)) { seen.proc.add(cmd); uses.proc.push(cmd); }
        } else if (effect.kind === "agent.run") {
          const role = isObject(effect.args) && typeof effect.args.role === "string" ? effect.args.role : isObject(effect.args) && typeof effect.args.label === "string" ? effect.args.label : "agent.run";
          if (!seen.agent.has(role)) { seen.agent.add(role); uses.agent.push(role); }
        } else if (effect.kind === "ui.ask") {
          if (!seen.ui.has("ask")) { seen.ui.add("ask"); uses.ui.push("ask"); }
        }
      } else if (node.kind === "flow" || node.kind === "loop" || node.kind === "when") visit((node as any).body ?? []);
    }
  };
  visit(definition.body);
  for (const key of Object.keys(uses) as Array<keyof typeof uses>) uses[key].sort(compareStrings);
  return { id: definition.id, title: definition.title, version: definition.version, hash, currentPointer: currentPointer(definition.id), steps, uses };
}

async function loadDefinitionByHash(deps: WorkflowDeps, hash: string): Promise<WorkflowIr | null> {
  const row = await deps.objects.getJSON<WorkflowIr>({ hash });
  if (!row) return null;
  return normalizeWorkflowIr(row.value);
}

async function loadCurrentDefinition(deps: WorkflowDeps, id: string): Promise<{ hash: string; definition: WorkflowIr } | null> {
  const hash = await deps.pointers.get(currentPointer(id));
  if (!hash) return null;
  const definition = await loadDefinitionByHash(deps, hash);
  return definition ? { hash, definition } : null;
}

function materializedStepPath(ctx: ExecCtx, node: { id: string }): string {
  if (!ctx.loopStack.length) return node.id;
  const prefix = ctx.loopStack.map((entry) => entry.id).join("/");
  const suffix = ctx.loopStack[ctx.loopStack.length - 1]!.iteration;
  return `${prefix}/${node.id}#${suffix}`;
}

async function getStep(deps: WorkflowDeps, runId: string, path: string): Promise<WorkflowStepRun | null> {
  return (await getRunSteps(deps, runId)).find((step) => step.path === path) ?? null;
}

async function upsertStep(deps: WorkflowDeps, runId: string, step: WorkflowStepRun): Promise<void> {
  const steps = await getRunSteps(deps, runId);
  const idx = steps.findIndex((cur) => cur.path === step.path);
  if (idx >= 0) steps[idx] = { ...steps[idx], ...step };
  else steps.push(step);
  await setRunSteps(deps, runId, steps);
  const graph = runGraph(runId);
  const subject = stepSubject(runId, step.path);
  const adds: Array<[string, string, unknown]> = [
    ["rdf:type", "workflow:StepRun", undefined],
    ["workflow:run", runSubject(runId), undefined],
    ["workflow:stepId", step.id, undefined],
    ["workflow:path", step.path, undefined],
    ["workflow:kind", step.kind, undefined],
    ["workflow:status", step.status, undefined],
  ];
  if (step.argsHash) adds.push(["workflow:args", stepPointer(runId, step.path, "args"), undefined], ["workflow:argsHash", step.argsHash, undefined]);
  if (step.outputHash) adds.push(["workflow:output", stepPointer(runId, step.path, "output"), undefined], ["workflow:outputHash", step.outputHash, undefined]);
  if (step.errorHash) adds.push(["workflow:error", stepPointer(runId, step.path, "error"), undefined], ["workflow:errorHash", step.errorHash, undefined]);
  if (step.startedAt) adds.push(["workflow:startedAt", step.startedAt, undefined]);
  if (step.endedAt) adds.push(["workflow:endedAt", step.endedAt, undefined]);
  await replaceSubjectFacts(deps, graph, subject, adds);
}

async function setRunStatus(deps: WorkflowDeps, runId: string, status: WorkflowRunStatus, currentStep?: string | null): Promise<RunMeta> {
  const meta = await getRunMeta(deps, runId);
  if (!meta) throw new Error(`workflow run not found: ${runId}`);
  meta.status = status;
  meta.currentStep = currentStep ?? null;
  await setRunMeta(deps, meta);
  const graph = runGraph(runId);
  const subject = runSubject(runId);
  const adds: Array<[string, string, unknown]> = [
    ["rdf:type", "workflow:Run", undefined],
    ["workflow:runId", meta.runId, undefined],
    ["workflow:workflowId", meta.workflowId, undefined],
    ["workflow:definitionHash", meta.definitionHash, undefined],
    ["workflow:status", meta.status, undefined],
    ["workflow:createdAt", meta.createdAt, undefined],
    ["workflow:updatedAt", meta.updatedAt, undefined],
  ];
  if (meta.currentStep) adds.push(["workflow:currentStep", meta.currentStep, undefined]);
  for (const chatId of meta.chatIds ?? []) adds.push(["workflow:linkedChat", `chat:${safePart(chatId)}`, undefined]);
  await replaceSubjectFacts(deps, graph, subject, adds);
  await removeWaitingFacts(deps, runId);
  if (status === "waiting") {
    await deps.facts.addAll({ store: WORKFLOW_STORE, quads: [
      [WAITING_GRAPH, subject, "rdf:type", "workflow:WaitingRun"],
      [WAITING_GRAPH, subject, "workflow:run", subject],
      [WAITING_GRAPH, subject, "workflow:workflowId", meta.workflowId],
      ...(meta.currentStep ? [[WAITING_GRAPH, subject, "workflow:currentStep", meta.currentStep] as any] : []),
    ] });
  }
  return meta;
}

async function runStep(ctx: ExecCtx, node: Extract<WorkflowNode, { kind: "step" }>): Promise<void> {
  const deps = ctx.deps;
  const path = materializedStepPath(ctx, node);
  const existing = await getStep(deps, ctx.runId, path);
  if (existing?.status === "done") {
    const output = await objectJson(deps, existing.outputHash ?? null, undefined);
    if (node.out) {
      setPath(ctx.state, refPath(node.out).replace(/^state\.?/, ""), output);
      await setRunState(deps, ctx.runId, ctx.state);
    }
    return;
  }
  if (existing?.status === "waiting" && node.effect.kind === "ui.ask") throw { kind: "wait", stepPath: path } as ExecSignal;
  const startedAt = nowIsoFromMs(await deps.time.nowMs());
  const resolvedArgs = evalValue(node.effect.args, { input: ctx.input, state: ctx.state });
  const argsHash = await deps.objects.putJSON({ kind: "workflow:StepArgs", value: resolvedArgs ?? null });
  await deps.pointers.set(stepPointer(ctx.runId, path, "args"), argsHash);
  await upsertStep(deps, ctx.runId, {
    id: node.id,
    path,
    kind: node.effect.kind === "mcp.call" ? `mcp.${node.effect.server}.${node.effect.tool}` : node.effect.kind,
    status: "running",
    argsHash,
    startedAt,
  });
  await setRunStatus(deps, ctx.runId, "running", path);
  await appendEvent(deps, ctx.runId, { type: "step.started", path, id: node.id, kind: node.effect.kind });

  if (node.effect.kind === "ui.ask") {
    await upsertStep(deps, ctx.runId, {
      id: node.id,
      path,
      kind: "ui.ask",
      status: "waiting",
      argsHash,
      startedAt,
    });
    await setRunStatus(deps, ctx.runId, "waiting", path);
    await appendEvent(deps, ctx.runId, { type: "run.waiting", path });
    throw { kind: "wait", stepPath: path } as ExecSignal;
  }

  try {
    let output: unknown;
    if (node.effect.kind === "proc.run") {
      output = await deps.proc.run((resolvedArgs ?? {}) as any);
    } else if (node.effect.kind === "mcp.call") {
      output = await deps.mcp.callTool(node.effect.server, node.effect.tool, resolvedArgs ?? {});
    } else if (node.effect.kind === "agent.run") {
      const spec = normalizeAgentArgs(resolvedArgs);
      output = await deps.agent.run(spec as any);
    } else {
      throw new Error(`unsupported workflow effect: ${(node.effect as any).kind}`);
    }
    const endedAt = nowIsoFromMs(await deps.time.nowMs());
    const outputHash = await deps.objects.putJSON({ kind: "workflow:StepOutput", value: output ?? null });
    await deps.pointers.set(stepPointer(ctx.runId, path, "output"), outputHash);
    if (node.out) {
      setPath(ctx.state, refPath(node.out).replace(/^state\.?/, ""), output);
      await setRunState(deps, ctx.runId, ctx.state);
    }
    await upsertStep(deps, ctx.runId, {
      id: node.id,
      path,
      kind: node.effect.kind === "mcp.call" ? `mcp.${node.effect.server}.${node.effect.tool}` : node.effect.kind,
      status: "done",
      argsHash,
      outputHash,
      startedAt: existing?.startedAt ?? startedAt,
      endedAt,
    });
    await appendEvent(deps, ctx.runId, { type: "step.completed", path, outputHash });
  } catch (error) {
    const endedAt = nowIsoFromMs(await deps.time.nowMs());
    const payload = { message: error instanceof Error ? error.message : String(error), error: String(error) };
    const errorHash = await deps.objects.putJSON({ kind: "workflow:StepError", value: payload });
    await deps.pointers.set(stepPointer(ctx.runId, path, "error"), errorHash);
    await upsertStep(deps, ctx.runId, {
      id: node.id,
      path,
      kind: node.effect.kind === "mcp.call" ? `mcp.${node.effect.server}.${node.effect.tool}` : node.effect.kind,
      status: "failed",
      argsHash,
      errorHash,
      startedAt: existing?.startedAt ?? startedAt,
      endedAt,
    });
    await setRunStatus(deps, ctx.runId, "failed", path);
    await appendEvent(deps, ctx.runId, { type: "step.failed", path, errorHash, message: payload.message });
    throw error;
  }
}

function normalizeAgentArgs(args: unknown): JsonRecord {
  const spec: JsonRecord = isObject(args) ? { ...args } : { task: String(args ?? "") };
  if (isObject(spec.context)) spec.context = JSON.stringify(spec.context, null, 2);
  if (isObject(spec.expectedOutput) || Array.isArray(spec.expectedOutput)) spec.expectedOutput = JSON.stringify(spec.expectedOutput, null, 2);
  return spec;
}

async function executeBody(ctx: ExecCtx, nodes: WorkflowNode[]): Promise<void> {
  let index = 0;
  while (index < nodes.length) {
    const node = nodes[index]!;
    try {
      await executeNode(ctx, node);
      index += 1;
    } catch (signal) {
      if (isSignal(signal, "goto")) {
        const targetIndex = nodes.findIndex((candidate) => (candidate as any).id === signal.target);
        if (targetIndex >= 0) {
          index = targetIndex;
          continue;
        }
      }
      throw signal;
    }
  }
}

async function executeNode(ctx: ExecCtx, node: WorkflowNode): Promise<void> {
  if (!node) return;
  if (node.kind === "flow") return executeBody(ctx, node.body ?? []);
  if (node.kind === "step") return runStep(ctx, node);
  if (node.kind === "set") {
    setPath(ctx.state, refPath(node.ref).replace(/^state\.?/, ""), evalValue(node.value, { input: ctx.input, state: ctx.state }));
    await setRunState(ctx.deps, ctx.runId, ctx.state);
    await appendEvent(ctx.deps, ctx.runId, { type: "state.set", id: node.id ?? null, ref: node.ref.ref });
    return;
  }
  if (node.kind === "when") {
    if (truthy(evalValue(node.test, { input: ctx.input, state: ctx.state }))) await executeBody(ctx, node.body ?? []);
    return;
  }
  if (node.kind === "break") {
    if (node.test === undefined || truthy(evalValue(node.test, { input: ctx.input, state: ctx.state }))) throw { kind: "break" } as ExecSignal;
    return;
  }
  if (node.kind === "goto") throw { kind: "goto", target: node.target } as ExecSignal;
  if (node.kind === "stopUnless") {
    if (!truthy(evalValue(node.test, { input: ctx.input, state: ctx.state }))) throw { kind: "stop", reason: node.reason || "workflow stopped" } as ExecSignal;
    return;
  }
  if (node.kind === "done") throw { kind: "done", output: evalValue(node.value, { input: ctx.input, state: ctx.state }) } as ExecSignal;
  if (node.kind === "loop") {
    const max = Math.max(1, Math.floor(Number(node.opts?.max ?? DEFAULT_LOOP_MAX) || DEFAULT_LOOP_MAX));
    for (let iteration = 1; iteration <= max; iteration += 1) {
      ctx.loopStack.push({ id: node.id, iteration });
      try {
        await executeBody(ctx, node.body ?? []);
      } catch (signal) {
        ctx.loopStack.pop();
        if (isSignal(signal, "break")) return;
        throw signal;
      }
      ctx.loopStack.pop();
    }
    throw new Error(`workflow loop exceeded max iterations: ${node.id}`);
  }
  throw new Error(`unknown workflow node kind: ${(node as any).kind}`);
}

function isSignal<K extends ExecSignal["kind"]>(value: unknown, kind: K): value is Extract<ExecSignal, { kind: K }> {
  return isObject(value) && value.kind === kind;
}

async function inspectStepOutputs(deps: WorkflowDeps, steps: WorkflowStepRun[]): Promise<WorkflowStepRun[]> {
  const out: WorkflowStepRun[] = [];
  for (const step of steps) {
    out.push({
      ...step,
      ...(step.argsHash ? { args: await objectJson(deps, step.argsHash, null) } : {}),
      ...(step.outputHash ? { output: await objectJson(deps, step.outputHash, null) } : {}),
      ...(step.errorHash ? { error: await objectJson(deps, step.errorHash, null) } : {}),
    });
  }
  return out;
}

async function inspectRun(deps: WorkflowDeps, runId: string): Promise<WorkflowRunInspection | null> {
  const meta = await getRunMeta(deps, runId);
  if (!meta) return null;
  const definition = await loadDefinitionByHash(deps, meta.definitionHash);
  const outputHash = await deps.pointers.get(runPointer(runId, "output"));
  const input = await getRunInput(deps, runId);
  const state = await getRunState(deps, runId);
  const events = await getRunEvents(deps, runId);
  const steps = await inspectStepOutputs(deps, await getRunSteps(deps, runId));
  return {
    ...meta,
    input,
    state,
    ...(outputHash ? { output: await objectJson(deps, outputHash, null) } : {}),
    events,
    steps,
    definition,
    mermaid: renderRunMermaid(definition, steps),
  };
}

async function resumeRun(deps: WorkflowDeps, runId: string): Promise<WorkflowRunInspection> {
  const meta = await getRunMeta(deps, runId);
  if (!meta) throw new Error(`workflow run not found: ${runId}`);
  if (meta.status === "done" || meta.status === "cancelled") return (await inspectRun(deps, runId))!;
  const definition = await loadDefinitionByHash(deps, meta.definitionHash);
  if (!definition) throw new Error(`workflow definition blob not found: ${meta.definitionHash}`);
  const ctx: ExecCtx = {
    deps,
    runId,
    definition,
    input: await getRunInput(deps, runId),
    state: await getRunState(deps, runId),
    loopStack: [],
  };
  await setRunStatus(deps, runId, "running", meta.currentStep ?? null);
  try {
    await executeBody(ctx, definition.body);
    const output = ctx.state;
    const outputHash = await deps.objects.putJSON({ kind: "workflow:Output", value: output });
    await deps.pointers.set(runPointer(runId, "output"), outputHash);
    await setRunStatus(deps, runId, "done", null);
    await appendEvent(deps, runId, { type: "run.completed", outputHash });
  } catch (signal) {
    if (isSignal(signal, "wait")) {
      await setRunStatus(deps, runId, "waiting", signal.stepPath);
    } else if (isSignal(signal, "done")) {
      const outputHash = await deps.objects.putJSON({ kind: "workflow:Output", value: signal.output ?? null });
      await deps.pointers.set(runPointer(runId, "output"), outputHash);
      await setRunStatus(deps, runId, "done", null);
      await appendEvent(deps, runId, { type: "run.completed", outputHash });
    } else if (isSignal(signal, "stop")) {
      await setRunStatus(deps, runId, "cancelled", null);
      await appendEvent(deps, runId, { type: "run.cancelled", reason: signal.reason });
    } else {
      const cur = (await getRunMeta(deps, runId))?.currentStep ?? null;
      await setRunStatus(deps, runId, "failed", cur);
      await appendEvent(deps, runId, { type: "run.failed", currentStep: cur, message: signal instanceof Error ? signal.message : String(signal) });
    }
  }
  return (await inspectRun(deps, runId))!;
}

async function setStepSubmitted(deps: WorkflowDeps, runId: string, stepPath: string, value: unknown): Promise<void> {
  const step = await getStep(deps, runId, stepPath);
  if (!step) throw new Error(`workflow step not found: ${stepPath}`);
  if (step.status !== "waiting") throw new Error(`workflow step is not waiting: ${stepPath}`);
  const outputHash = await deps.objects.putJSON({ kind: "workflow:StepOutput", value });
  await deps.pointers.set(stepPointer(runId, stepPath, "output"), outputHash);
  const meta = await getRunMeta(deps, runId);
  const state = await getRunState(deps, runId);
  const definition = meta ? await loadDefinitionByHash(deps, meta.definitionHash) : null;
  const node = definition ? findDefinitionStepByMaterializedPath(definition, stepPath) : null;
  if (node?.out) {
    setPath(state, refPath(node.out).replace(/^state\.?/, ""), value);
    await setRunState(deps, runId, state);
  }
  await upsertStep(deps, runId, { ...step, status: "done", outputHash, endedAt: nowIsoFromMs(await deps.time.nowMs()) });
  await appendEvent(deps, runId, { type: "human.submitted", path: stepPath, outputHash });
}

function findDefinitionStepByMaterializedPath(definition: WorkflowIr, stepPath: string): Extract<WorkflowNode, { kind: "step" }> | null {
  const logical = stepPath.split("/").pop()?.replace(/#\d+$/, "") ?? stepPath;
  let found: Extract<WorkflowNode, { kind: "step" }> | null = null;
  const visit = (nodes: WorkflowNode[]) => {
    for (const node of nodes) {
      if (found) return;
      if (node.kind === "step" && node.id === logical) found = node;
      else if (node.kind === "flow" || node.kind === "loop" || node.kind === "when") visit((node as any).body ?? []);
    }
  };
  visit(definition.body);
  return found;
}

async function invalidateFrom(deps: WorkflowDeps, runId: string, from: string | null | undefined): Promise<void> {
  const steps = await getRunSteps(deps, runId);
  const idx = from ? steps.findIndex((step) => step.path === from || step.id === from) : steps.findIndex((step) => step.status === "failed" || step.status === "waiting");
  if (idx < 0) return;
  const removed = steps.slice(idx);
  for (const step of removed) {
    await deps.pointers.delete(stepPointer(runId, step.path, "args"));
    await deps.pointers.delete(stepPointer(runId, step.path, "output"));
    await deps.pointers.delete(stepPointer(runId, step.path, "error"));
    await removeSubjectFacts(deps, runGraph(runId), stepSubject(runId, step.path));
  }
  await setRunSteps(deps, runId, steps.slice(0, idx));
  await appendEvent(deps, runId, { type: "run.invalidated", from: removed[0]?.path ?? from ?? null, removed: removed.map((step) => step.path) });
}

function renderDefinitionMermaid(definition: WorkflowIr): string {
  const steps = flattenDefinitionSteps(definition);
  const lines = ["flowchart TD"];
  steps.forEach((step, i) => {
    lines.push(`  n${i}["${escapeMermaid(`${step.id}\n${step.kind}`)}"]`);
    if (i > 0) lines.push(`  n${i - 1} --> n${i}`);
  });
  if (!steps.length) lines.push(`  empty["${escapeMermaid("empty workflow")}"]`);
  lines.push(...mermaidClassDefs());
  return lines.join("\n");
}

function renderRunMermaid(definition: WorkflowIr | null, steps: WorkflowStepRun[]): string {
  const lines = ["flowchart TD"];
  const rendered = steps.length ? steps : (definition ? flattenDefinitionSteps(definition).map((step) => ({ id: step.id, path: step.id, kind: step.kind, status: "todo" as const })) : []);
  rendered.forEach((step, i) => {
    const label = `${step.path}\n${step.kind}\n${step.status}`;
    lines.push(`  n${i}["${escapeMermaid(label)}"]`);
    lines.push(`  class n${i} ${step.status}`);
    if (i > 0) lines.push(`  n${i - 1} --> n${i}`);
  });
  if (!rendered.length) lines.push(`  empty["${escapeMermaid("no steps")}"]`);
  lines.push(...mermaidClassDefs());
  return lines.join("\n");
}

function escapeMermaid(value: string): string {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "'").replace(/\n/g, "<br/>");
}

function mermaidClassDefs(): string[] {
  return [
    "  classDef todo fill:#f5f5f5,stroke:#888,color:#222",
    "  classDef running fill:#fff4cc,stroke:#a66b00,color:#222",
    "  classDef waiting fill:#dbeafe,stroke:#1d4ed8,color:#111",
    "  classDef done fill:#dcfce7,stroke:#15803d,color:#111",
    "  classDef failed fill:#fee2e2,stroke:#b91c1c,color:#111",
    "  classDef skipped fill:#eeeeee,stroke:#aaa,color:#555",
  ];
}

export function createWorkflowsApi(deps: WorkflowDeps): Moo["workflows"] {
  return {
    async save(args: WorkflowSaveArgs) {
      const definition = normalizeWorkflowIr(args.definition);
      const hash = await deps.objects.putJSON({ kind: "workflow:IR", value: definition });
      if (args.current !== false) await deps.pointers.set(currentPointer(definition.id), hash);
      await deps.pointers.set(`workflow/${safePart(definition.id)}/version/${safePart(definition.version ?? hash)}`, hash);
      return indexDefinition(deps, definition, hash, args.source);
    },
    async list() {
      const pointers = await deps.pointers.entries("workflow/");
      const out: WorkflowDefinitionSummary[] = [];
      for (const [name, hash] of pointers) {
        const match = /^workflow\/([^/]+)\/current$/.exec(name);
        if (!match) continue;
        const definition = await loadDefinitionByHash(deps, hash);
        if (!definition) continue;
        out.push(summarizeDefinition(definition, hash));
      }
      return out.sort((a, b) => compareStrings(a.id, b.id));
    },
    async inspect(id: string) {
      const loaded = await loadCurrentDefinition(deps, id);
      if (!loaded) return null;
      const summary = summarizeDefinition(loaded.definition, loaded.hash);
      return { ...summary, definition: loaded.definition, mermaid: renderDefinitionMermaid(loaded.definition) };
    },
    async runs(filter: WorkflowRunFilter = {}) {
      const entries = await deps.pointers.entries("workflow/run/");
      const out: WorkflowRunSummary[] = [];
      for (const [name, target] of entries) {
        if (!name.endsWith("/meta")) continue;
        const meta = readPointerJson<RunMeta | null>(target, null);
        if (!meta) continue;
        if (filter.status && meta.status !== filter.status) continue;
        if (filter.workflowId && meta.workflowId !== filter.workflowId) continue;
        if (filter.chatId && !(meta.chatIds ?? []).includes(filter.chatId)) continue;
        out.push(meta);
      }
      return out.sort((a, b) => compareStrings(b.updatedAt ?? "", a.updatedAt ?? ""));
    },
    async waiting(args = {}) {
      return this.runs({ status: "waiting", ...(args.chatId ? { chatId: args.chatId } : {}) });
    },
    async inspectRun(runId: string) {
      return inspectRun(deps, runId);
    },
    async start(id: string, args: WorkflowStartArgs = {}) {
      const loaded = await loadCurrentDefinition(deps, id);
      if (!loaded) throw new Error(`workflow not found: ${id}`);
      const runId = await deps.id.new("wfr");
      const now = nowIsoFromMs(await deps.time.nowMs());
      const inputHash = await deps.objects.putJSON({ kind: "workflow:Input", value: args.input ?? {} });
      const eventsHash = await deps.objects.putJSON({ kind: "workflow:Events", value: [{ type: "run.started", at: now }] });
      const meta: RunMeta = {
        runId,
        workflowId: loaded.definition.id,
        definitionHash: loaded.hash,
        status: "queued",
        currentStep: null,
        chatIds: args.chatId ? [args.chatId] : [],
        createdAt: now,
        updatedAt: now,
      };
      await deps.pointers.set(runPointer(runId, "meta"), encodeJsonPointer(meta));
      await deps.pointers.set(runPointer(runId, "input"), inputHash);
      await deps.pointers.set(runPointer(runId, "state"), encodeJsonPointer(isObject(args.state) ? args.state : {}));
      await deps.pointers.set(runPointer(runId, "events"), eventsHash);
      await deps.pointers.set(runPointer(runId, "steps"), encodeJsonPointer([]));
      await setRunStatus(deps, runId, "queued", null);
      if (args.chatId) await this.linkChat(runId, args.chatId);
      if (args.autoResume === false) return (await inspectRun(deps, runId))!;
      return resumeRun(deps, runId);
    },
    async resume(runId: string) {
      return resumeRun(deps, runId);
    },
    async submit(runId: string, stepPath: string, value: unknown) {
      await setStepSubmitted(deps, runId, stepPath, value);
      return resumeRun(deps, runId);
    },
    async cancel(runId: string, reason = "cancelled") {
      await setRunStatus(deps, runId, "cancelled", null);
      await appendEvent(deps, runId, { type: "run.cancelled", reason });
      return (await inspectRun(deps, runId))!;
    },
    async retry(runId: string, args = {}) {
      await invalidateFrom(deps, runId, args.from ?? null);
      await setRunStatus(deps, runId, "queued", null);
      return args.resume === false ? (await inspectRun(deps, runId))! : resumeRun(deps, runId);
    },
    async fork(runId: string, args = {}) {
      const run = await inspectRun(deps, runId);
      if (!run) throw new Error(`workflow run not found: ${runId}`);
      const forked = await this.start(run.workflowId, { input: args.input ?? run.input, state: isObject(args.state) ? args.state : run.state, autoResume: args.autoResume ?? false });
      await appendEvent(deps, forked.runId, { type: "run.forkedFrom", runId, from: args.from ?? null });
      return forked;
    },
    async linkChat(runId: string, chatId: string) {
      const meta = await getRunMeta(deps, runId);
      if (!meta) throw new Error(`workflow run not found: ${runId}`);
      if (!meta.chatIds.includes(chatId)) meta.chatIds.push(chatId);
      await setRunMeta(deps, meta);
      await deps.facts.addAll({ store: WORKFLOW_STORE, quads: [
        [runGraph(runId), runSubject(runId), "workflow:linkedChat", `chat:${safePart(chatId)}`],
        [`chat:${safePart(chatId)}`, `chat:${safePart(chatId)}`, "workflow:involves", runSubject(runId)],
      ] });
      return (await inspectRun(deps, runId))!;
    },
    async unlinkChat(runId: string, chatId: string) {
      const meta = await getRunMeta(deps, runId);
      if (!meta) throw new Error(`workflow run not found: ${runId}`);
      meta.chatIds = meta.chatIds.filter((id) => id !== chatId);
      await setRunMeta(deps, meta);
      const encodedChat = `chat:${safePart(chatId)}`;
      const rows = await deps.facts.match({ store: WORKFLOW_STORE, subject: runSubject(runId), predicate: "workflow:linkedChat" });
      const removes = rows.filter(([, , , object]) => object === encodedChat).map(([g, s, p, o]) => [g, s, p, o] as [string, string, string, string]);
      if (removes.length) await deps.facts.swap({ store: WORKFLOW_STORE, removes, adds: [] });
      return (await inspectRun(deps, runId))!;
    },
    async renderMermaid(runId: string) {
      const run = await inspectRun(deps, runId);
      if (!run) throw new Error(`workflow run not found: ${runId}`);
      return run.mermaid;
    },
  };
}
