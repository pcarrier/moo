import { beforeEach, describe, expect, test } from "bun:test";

import { createWorkflowDsl, createWorkflowsApi } from "./workflows";
import type { Moo } from "./types";

type Quad = [string, string, string, string];

let now = Date.UTC(2026, 0, 1);
let ids = 0;
let hashes = 0;
let refs: Map<string, string>;
let objects: Map<string, { kind: string; value: unknown }>;
let quads: Quad[];
let procCalls: Array<{ cmd: string; args?: string[] }>;
let failNextProc = false;

function hash(): string {
  return "sha256:" + String(++hashes).padStart(64, "0");
}

function matchQuad(q: Quad, pattern: { graph?: string | null; subject?: string | null; predicate?: string | null; object?: string | null }): boolean {
  return (pattern.graph == null || q[0] === pattern.graph) &&
    (pattern.subject == null || q[1] === pattern.subject) &&
    (pattern.predicate == null || q[2] === pattern.predicate) &&
    (pattern.object == null || q[3] === pattern.object);
}

function deps(): Parameters<typeof createWorkflowsApi>[0] {
  return {
    objects: {
      async putText({ kind, text }) {
        const h = hash();
        objects.set(h, { kind, value: text });
        return h;
      },
      async putJSON({ kind, value }) {
        const h = hash();
        objects.set(h, { kind, value: JSON.parse(JSON.stringify(value ?? null)) });
        return h;
      },
      async getText({ hash }) {
        const row = objects.get(hash);
        return row ? { kind: row.kind, text: String(row.value) } : null;
      },
      async getJSON({ hash }) {
        const row = objects.get(hash);
        return row ? { kind: row.kind, value: row.value as any } : null;
      },
    },
    pointers: {
      async get(name) { return refs.get(name) ?? null; },
      async set(name, target) {
        const previous = refs.get(name) ?? null;
        refs.set(name, target);
        return { name, target, previous, changed: previous !== target };
      },
      async cas(name, expected, next) {
        const current = refs.get(name) ?? null;
        if (current !== expected) return false;
        refs.set(name, next);
        return true;
      },
      async list(prefix = "") { return [...refs.keys()].filter((name) => name.startsWith(prefix)); },
      async entries(prefix = "") { return [...refs.entries()].filter(([name]) => name.startsWith(prefix)); },
      async delete(name) { return refs.delete(name); },
    },
    facts: {
      async add(args) {
        quads.push([args.graph, args.subject, args.predicate, String(args.object)]);
        return { store: args.store, added: 1, removed: 0 };
      },
      async addAll(args) {
        for (const q of args.quads as any[]) quads.push(Array.isArray(q) ? q as Quad : [q.graph, q.subject, q.predicate, String(q.object)]);
        return { store: args.store, added: args.quads.length, removed: 0 };
      },
      async remove(args) {
        const before = quads.length;
        quads = quads.filter((q) => !matchQuad(q, args as any));
        return { store: args.store, added: 0, removed: before - quads.length };
      },
      async match(args) {
        return quads.filter((q) => matchQuad(q, args as any)).slice(0, args.limit ?? undefined) as any;
      },
      async history() { return [] as any; },
      async matchAll() { return [] as any; },
      async stores() { return ["workflow/facts"]; },
      async count() { return quads.length; },
      async swap(args) {
        for (const remove of args.removes as any[]) quads = quads.filter((q) => !(q[0] === remove[0] && q[1] === remove[1] && q[2] === remove[2] && q[3] === remove[3]));
        for (const add of args.adds as any[]) quads.push(add as Quad);
        return { store: args.store, added: args.adds.length, removed: args.removes.length };
      },
      async update(args) {
        const adds: any[] = [];
        const removes: any[] = [];
        await args.fn({ add: (q: any) => adds.push([q.graph, q.subject, q.predicate, String(q.object)]), remove: (q: any) => removes.push([q.graph, q.subject, q.predicate, String(q.object)]) });
        for (const remove of removes) quads = quads.filter((q) => !(q[0] === remove[0] && q[1] === remove[1] && q[2] === remove[2] && q[3] === remove[3]));
        for (const add of adds) quads.push(add as Quad);
        return { store: args.store, added: adds.length, removed: removes.length };
      },
      async clearStore() { const removed = quads.length; quads = []; return { removed }; },
      async deleteStore() { const removed = quads.length; quads = []; return { removed }; },
      async deleteGraph(args) {
        const before = quads.length;
        quads = quads.filter((q) => q[0] !== args.graph);
        return { store: args.store, graph: args.graph, removed: before - quads.length };
      },
      async deleteGraphEverywhere(args) {
        const before = quads.length;
        quads = quads.filter((q) => q[0] !== args.graph);
        return { graph: args.graph, removed: before - quads.length };
      },
    },
    proc: {
      async run(input: any) {
        procCalls.push({ cmd: input.cmd, args: input.args });
        if (failNextProc) {
          failNextProc = false;
          throw new Error("boom");
        }
        return { code: 0, stdout: `${(input.args ?? []).join(" ")}\n`, stderr: "", durationNs: 1, timedOut: false };
      },
      async runChecked(input: any) { return this.run({ ...input, check: true }); },
    },
    mcp: { async callTool(_server: string, name: string, input: unknown) { return { name, input }; } } as any,
    agent: { async run(spec: any) { return { status: "done", childChatId: "child", output: JSON.stringify(spec), durationNs: 1 }; } } as any,
    time: { async nowMs() { return now++; }, async nowISO() { return new Date(now++).toISOString(); }, async datetime() { throw new Error("unused"); }, async nowPlus(ms: number) { return now + ms; } } as any,
    id: { async new(prefix = "id") { return `${prefix}_${++ids}`; } },
  } as Pick<Moo, "objects" | "pointers" | "facts" | "proc" | "mcp" | "agent" | "time" | "id">;
}

beforeEach(() => {
  now = Date.UTC(2026, 0, 1);
  ids = 0;
  hashes = 0;
  refs = new Map();
  objects = new Map();
  quads = [];
  procCalls = [];
  failNextProc = false;
});

describe("workflows", () => {
  test("DSL emits JSON IR and runs proc/set/done end-to-end", async () => {
    const api = createWorkflowsApi(deps());
    const definition = createWorkflowDsl("hello", (w) => {
      const i = w.input;
      const s = w.state;
      return w.flow(
        w.step("echo").proc.run({ cmd: "echo", args: [i.name] }).out(s.echo),
        w.set(s.summary, w.trim(s.echo.stdout)),
        w.done({ summary: s.summary }),
      );
    });

    expect(definition.body[0].kind).toBe("step");
    const saved = await api.save({ definition });
    expect(saved.steps).toBe(1);
    expect((await api.list()).map((workflow) => workflow.id)).toEqual(["hello"]);

    const run = await api.start("hello", { input: { name: "Ada" } });
    expect(run.status).toBe("done");
    expect(run.output).toEqual({ summary: "Ada" });
    expect((run.state as any).echo.stdout).toBe("Ada\n");
    expect(run.steps.map((step) => [step.path, step.status])).toEqual([["echo", "done"]]);
    expect(procCalls).toEqual([{ cmd: "echo", args: ["Ada"] }]);
    expect(await api.renderMermaid(run.runId)).toContain("echo");
  });

  test("ui.ask waits, persists state on submit, and resumes", async () => {
    const api = createWorkflowsApi(deps());
    await api.save({ definition: createWorkflowDsl("approval", (w) => {
      const s = w.state;
      return w.flow(
        w.step("approve").ui.ask({ spec: { title: "Approve", fields: [{ name: "ok", type: "boolean" }] }, context: { plan: "ship" } }).out(s.approval),
        w.when(w.not(s.approval.ok), w.stop("rejected")),
        w.done({ ok: s.approval.ok }),
      );
    }) });

    const waiting = await api.start("approval");
    expect(waiting.status).toBe("waiting");
    expect(waiting.currentStep).toBe("approve");
    expect(waiting.steps[0]?.status).toBe("waiting");
    expect((await api.waiting()).map((run) => run.runId)).toEqual([waiting.runId]);

    const done = await api.submit(waiting.runId, "approve", { ok: true });
    expect(done.status).toBe("done");
    expect(done.output).toEqual({ ok: true });
    expect((done.state as any).approval).toEqual({ ok: true });
  });

  test("stop cancels run and generic op backs expression helpers", async () => {
    const api = createWorkflowsApi(deps());
    await api.save({ definition: createWorkflowDsl("stopper", (w) => w.flow(
      w.set(w.state.ok, w.op("eq", w.input.answer, "yes")),
      w.when(w.not(w.state.ok), w.stop("nope")),
      w.done({ ok: w.state.ok }),
    )) });

    const cancelled = await api.start("stopper", { input: { answer: "no" } });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.output).toBeUndefined();

    const done = await api.start("stopper", { input: { answer: "yes" } });
    expect(done.status).toBe("done");
    expect(done.output).toEqual({ ok: true });
  });

  test("failed step is inspectable and retry invalidates from failure", async () => {
    const api = createWorkflowsApi(deps());
    await api.save({ definition: createWorkflowDsl("retryable", (w) => w.flow(
      w.step("fragile").proc.run({ cmd: "fragile" }).out(w.state.result),
      w.done({ code: w.state.result.code }),
    )) });

    failNextProc = true;
    const failed = await api.start("retryable");
    expect(failed.status).toBe("failed");
    expect(failed.steps[0]?.status).toBe("failed");
    expect(failed.steps[0]?.error).toMatchObject({ message: "boom" });

    const retried = await api.retry(failed.runId);
    expect(retried.status).toBe("done");
    expect(retried.output).toEqual({ code: 0 });
    expect(retried.steps.map((step) => step.status)).toEqual(["done"]);
    expect(procCalls.length).toBe(2);
  });

  test("list exposes input schema for UI forms", async () => {
    const api = createWorkflowsApi(deps());
    const definition = {
      ...createWorkflowDsl("schema", (w) => w.flow(w.done({ ok: true }))),
      inputSchema: {
        type: "object",
        required: ["issue"],
        properties: {
          issue: { type: "string", title: "Issue" },
          dryRun: { type: "boolean", default: true },
        },
      },
    };
    await api.save({ definition });
    const [summary] = await api.list();
    expect(summary?.inputSchema).toEqual(definition.inputSchema);
    const inspection = await api.inspect("schema");
    expect(inspection?.inputSchema).toEqual(definition.inputSchema);
  });

  test("list infers input schema from input refs", async () => {
    const api = createWorkflowsApi(deps());
    await api.save({ definition: createWorkflowDsl("inferred", (w) => w.flow(
      w.step("echo").proc.run({ cmd: "echo", args: [w.input.issue, w.input.notes] }),
      w.done({ ok: true }),
    )) });
    const [summary] = await api.list();
    expect(summary?.inputSchema).toEqual({
      type: "object",
      properties: {
        issue: { type: "string", title: "issue" },
        notes: { type: "string", title: "notes" },
      },
    });
  });

});
