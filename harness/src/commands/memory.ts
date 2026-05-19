import * as host from "../host_ops";
import { moo } from "../moo";
import { Term } from "../types";
import { readCompactionChain } from "../agent";
import { allFactStores, memoryScopeFor, type Input } from "./_shared";

export async function compactionsCommand(input: Input) {
  if (!input.chatId) {
    return { ok: false, error: { message: "compactions requires chatId" } };
  }
  const chain = await readCompactionChain(input.chatId);
  return { ok: true, value: { chatId: input.chatId, layers: chain } };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// -- cross-chat facts ------------------------------------------------------

export async function objectGetCommand(input: Input) {
  const raw = typeof input.hash === "string" ? input.hash.trim() : "";
  const hash = raw.startsWith("sha256:") ? raw : (/^[a-f0-9]{64}$/i.test(raw) ? "sha256:" + raw : raw);
  if (!/^sha256:[a-f0-9]{64}$/i.test(hash)) {
    return { ok: false, error: { message: "object-get requires sha256:<64-hex> hash" } };
  }
  const normalized = hash.toLowerCase();
  const object = host.getObject(normalized) ?? host.getObject(normalized.slice("sha256:".length));
  return { ok: true, value: { hash: normalized, object } };
}

export async function pointersCommand(input: Input) {
  const prefix = typeof input.prefix === "string" ? input.prefix : "";
  const entries = (await moo.pointers.entries({ prefix: prefix }))
    .map(([name, target]) => [String(name), String(target)] as [string, string])
    .filter(([name]) => name.trim().length > 0 && !/\[object\s+Promise\]/i.test(name));
  entries.sort((a, b) => compareStrings(String(a[0]), String(b[0])));
  return { ok: true, value: { pointers: entries } };
}

export async function pointerRemoveCommand(input: Input) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: { message: "pointer-rm requires name" } };
  const recursive = input.recursive === true;
  if (!recursive) {
    const removed = await moo.pointers.delete({ name: name });
    return { ok: true, value: { name, removed, removedCount: removed ? 1 : 0, recursive: false } };
  }

  const names = new Set<string>([name]);
  const prefix = name.endsWith("/") ? name : name + "/";
  for (const child of await moo.pointers.list({ prefix: prefix })) names.add(String(child));

  let removedCount = 0;
  for (const pointerName of Array.from(names).sort(compareStrings)) {
    if (await moo.pointers.delete({ name: pointerName })) removedCount += 1;
  }
  return { ok: true, value: { name, removed: removedCount > 0, removedCount, recursive: true } };
}

export async function memoryQueryCommand(input: Input) {
  if (!Array.isArray(input.patterns)) {
    return { ok: false, error: { message: "memory-query requires patterns" } };
  }
  const patterns = input.patterns.map((row: any) => {
    if (!Array.isArray(row) || row.length !== 3) throw new Error("memory-query patterns must be [subject, predicate, object]");
    return [String(row[0]), String(row[1]), String(row[2])] as [string, string, string];
  });
  const bindings = await memoryScopeFor(input).query(patterns, {
    ...(input.limit ? { limit: Number(input.limit) } : {}),
  });
  return { ok: true, value: { bindings } };
}


export type GraphSummaryRow = [string, number, number]; // [graph, facts, subjects]

export async function graphSummariesCommand(input: Input) {
  const removedMode: "include" | "only" | "exclude" = input.removed === "include" || input.removed === "only" ? input.removed : "exclude";
  if (removedMode === "exclude") {
    if (input.project !== undefined) {
      const store = await projectMemoryStoreFor(input.project);
      const graph = await projectMemoryGraphFor(input.project);
      const graphs = JSON.parse(host.graphFactSummaries(store, graph)) as GraphSummaryRow[];
      return { ok: true, value: { graphs } };
    }
    const graphs = JSON.parse(host.graphFactSummaries(null, null)) as GraphSummaryRow[];
    return { ok: true, value: { graphs } };
  }
  const summaries = new Map<string, { facts: number; subjects: Set<string> }>();
  const add = (graph: string, subject: string) => {
    let summary = summaries.get(graph);
    if (!summary) {
      summary = { facts: 0, subjects: new Set<string>() };
      summaries.set(graph, summary);
    }
    summary.facts += 1;
    summary.subjects.add(subject);
  };

  if (input.project !== undefined) {
    const store = await projectMemoryStoreFor(input.project);
    const graph = await projectMemoryGraphFor(input.project);
    const current = await moo.facts.match({ store, ...{ graph } });
    const currentKeys = new Set((current as Array<[string, string, string, string]>).map((row) => row.join("\u0000")));
    const rows = await moo.facts.history({ store, ...{ graph } });
    if (input.removed === "include" || input.removed === "only") {
      for (const row of rows as Array<[string, string, string, string, string, string]>) {
        if (row[4] !== "remove") continue;
        if (currentKeys.has(row.slice(0, 4).join("\u0000"))) continue;
        add(row[0], row[1]);
      }
    }
    if (input.removed !== "only") {
      for (const row of current as Array<[string, string, string, string]>) add(row[0], row[1]);
    }
    const graphs: GraphSummaryRow[] = [...summaries.entries()]
      .map(([graph, summary]) => [graph, summary.facts, summary.subjects.size] as GraphSummaryRow)
      .sort((a, b) => compareStrings(a[0], b[0]));
    return { ok: true, value: { graphs } };
  }

  const stores = await allFactStores();
  const seenRemoved = new Set<string>();
  const seenCurrent = new Set<string>();
  for (const store of stores) {
    const current = await moo.facts.match({ store, ...{} });
    const currentKeys = new Set((current as Array<[string, string, string, string]>).map((row) => row.join("\u0000")));
    const rows = await moo.facts.history({ store, ...{} });
    if (input.removed === "include" || input.removed === "only") {
      for (const row of rows as Array<[string, string, string, string, string, string]>) {
        if (row[4] !== "remove") continue;
        if (currentKeys.has(row.slice(0, 4).join("\u0000"))) continue;
        const key = row.join("\u0000");
        if (seenRemoved.has(key)) continue;
        seenRemoved.add(key);
        add(row[0], row[1]);
      }
    }
    if (removedMode === "only") continue;
    for (const row of current as Array<[string, string, string, string]>) {
      const key = row.join("\u0000");
      if (seenCurrent.has(key)) continue;
      seenCurrent.add(key);
      add(row[0], row[1]);
    }
  }
  const graphs: GraphSummaryRow[] = [...summaries.entries()]
    .map(([graph, summary]) => [graph, summary.facts, summary.subjects.size] as GraphSummaryRow)
    .sort((a, b) => compareStrings(a[0], b[0]));
  return { ok: true, value: { graphs } };
}

function latestAddTimes(rows: Array<[string, string, string, string, string, string]>): Map<string, string> {
  const latestAddAt = new Map<string, string>();
  for (const row of rows) {
    if (row[4] !== "add") continue;
    latestAddAt.set(row.slice(0, 4).join("\u0000"), row[5] ?? "");
  }
  return latestAddAt;
}

export async function triplesCommand(input: Input) {
  const removedMode: "include" | "only" | "exclude" = input.removed === "include" || input.removed === "only" ? input.removed : "exclude";
  const rawLimit = Number(input.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100_000) : 100_000;
  const graph = typeof input.graph === "string" && input.graph.length > 0 ? input.graph : undefined;
  let total = 0;
  const pushTriple = (triples: Array<[string, string, string, string, string?, string?]>, row: [string, string, string, string, string?, string?]) => {
    if (graph && row[0] !== graph) return;
    total += 1;
    if (!limit || triples.length < limit) triples.push(row);
  };
  if (input.project !== undefined) {
    const store = await projectMemoryStoreFor(input.project);
    const graph = await projectMemoryGraphFor(input.project);
    if (removedMode === "exclude") {
      const current = await moo.facts.match({ store, ...{
        graph,
        subject: input.subject ?? null,
        predicate: input.predicate ?? null,
        object: input.object ?? null,
        limit,
      } });
      const rows = await moo.facts.history({ store, ...{
        graph,
        subject: input.subject ?? null,
        predicate: input.predicate ?? null,
        object: input.object ?? null,
      } });
      const latestAddAt = latestAddTimes(rows as Array<[string, string, string, string, string, string]>);
      const triples = (current as Array<[string, string, string, string]>).map((row) => {
        const rowKey = row.join("\u0000");
        return [row[0], row[1], row[2], row[3], "present", latestAddAt.get(rowKey) ?? ""] as [string, string, string, string, string, string];
      });
      const truncated = Boolean(limit && triples.length >= limit);
      return { ok: true, value: { triples, truncated, limit: limit || undefined, total: truncated ? undefined : triples.length } };
    }
    const current = await moo.facts.match({ store, ...{
      graph,
      subject: input.subject ?? null,
      predicate: input.predicate ?? null,
      object: input.object ?? null,
    } });
    const currentKeys = new Set(
      (current as Array<[string, string, string, string]>).map((row) => row.join("\u0000")),
    );
    const rows = await moo.facts.history({ store, ...{
      graph,
      subject: input.subject ?? null,
      predicate: input.predicate ?? null,
      object: input.object ?? null,
    } });
    const triples: Array<[string, string, string, string, string?, string?]> = [];
    if (input.removed === "include" || input.removed === "only") {
      for (const row of rows as Array<[string, string, string, string, string, string]>) {
        if (row[4] !== "remove") continue;
        if (currentKeys.has(row.slice(0, 4).join("\u0000"))) continue;
        pushTriple(triples, row);
      }
    }
    if (input.removed !== "only") {
      const latestAddAt = latestAddTimes(rows as Array<[string, string, string, string, string, string]>);
      for (const row of current as Array<[string, string, string, string]>) {
        const rowKey = row.join("\u0000");
        pushTriple(triples, [row[0], row[1], row[2], row[3], "present", latestAddAt.get(rowKey) ?? ""]);
      }
    }
    return { ok: true, value: { triples, truncated: Boolean(limit && total > triples.length), limit: limit || undefined, total } };
  }

  const stores = await allFactStores();
  const triples: Array<[string, string, string, string, string?, string?]> = [];
  const seen = new Set<string>();
  if (removedMode === "exclude") {
    for (const store of stores) {
      if (limit && triples.length >= limit) break;
      const current = await moo.facts.match({ store, ...{
        graph: graph ?? null,
        subject: input.subject ?? null,
        predicate: input.predicate ?? null,
        object: input.object ?? null,
        ...(limit ? { limit: limit - triples.length } : {}),
      } });
      const rows = await moo.facts.history({ store, ...{
        graph: graph ?? null,
        subject: input.subject ?? null,
        predicate: input.predicate ?? null,
        object: input.object ?? null,
      } });
      const latestAddAt = latestAddTimes(rows as Array<[string, string, string, string, string, string]>);
      for (const row of current as Array<[string, string, string, string]>) {
        const rowKey = row.join("\u0000");
        const key = rowKey + "\u0000present";
        if (seen.has(key)) continue;
        seen.add(key);
        pushTriple(triples, [row[0], row[1], row[2], row[3], "present", latestAddAt.get(rowKey) ?? ""]);
      }
    }
    const truncated = Boolean(limit && triples.length >= limit);
    return { ok: true, value: { triples, truncated, limit: limit || undefined, total: truncated ? undefined : triples.length } };
  }
  for (const store of stores) {
    const current = await moo.facts.match({ store, ...{
      graph: graph ?? null,
      subject: input.subject ?? null,
      predicate: input.predicate ?? null,
      object: input.object ?? null,
    } });
    const currentKeys = new Set(
      (current as Array<[string, string, string, string]>).map((row) => row.join("\u0000")),
    );
    const rows = await moo.facts.history({ store, ...{
      graph: graph ?? null,
      subject: input.subject ?? null,
      predicate: input.predicate ?? null,
      object: input.object ?? null,
    } });
    if (input.removed === "include" || input.removed === "only") {
      for (const row of rows as Array<[string, string, string, string, string, string]>) {
        if (row[4] !== "remove") continue;
        if (currentKeys.has(row.slice(0, 4).join("\u0000"))) continue;
        const key = row.join("\u0000");
        if (seen.has(key)) continue;
        seen.add(key);
        pushTriple(triples, row);
      }
    }
    if (removedMode === "only") continue;
    const latestAddAt = latestAddTimes(rows as Array<[string, string, string, string, string, string]>);
    for (const row of current as Array<[string, string, string, string]>) {
      const rowKey = row.join("\u0000");
      const event: [string, string, string, string, string, string] = [
        row[0],
        row[1],
        row[2],
        row[3],
        "present",
        latestAddAt.get(rowKey) ?? "",
      ];
      const key = rowKey + "\u0000present";
      if (seen.has(key)) continue;
      seen.add(key);
      pushTriple(triples, event);
    }
  }
  return { ok: true, value: { triples, truncated: Boolean(limit && total > triples.length), limit: limit || undefined, total } };
}

export async function projectMemoryStoreFor(project: unknown): Promise<string> {
  if (project === false || project === "") return "memory/facts";
  if (typeof project === "string" && project.length > 0) {
    return "memory/project/" + encodeURIComponent(project).replace(/[!'()*]/g, (ch) =>
      "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
    ) + "/facts";
  }
  const git = await moo.proc.run({ cmd: ["git", "rev-parse", "--show-toplevel"], ...{ timeoutMs: 2_000 } });
  const raw = git.code === 0 && git.stdout.trim() ? git.stdout.trim() : (await moo.env.get({ name: "PWD" })) || ".";
  return projectMemoryStoreFor(raw);
}

export async function projectMemoryGraphFor(project: unknown): Promise<string> {
  if (project === false || project === "") return "memory:facts";
  const store = await projectMemoryStoreFor(project);
  if (store === "memory/facts") return "memory:facts";
  return "memory:project/" + store.slice("memory/project/".length, -"/facts".length);
}

export async function assertCommand(input: Input) {
  if (!input.subject || !input.predicate || !input.object) {
    return {
      ok: false,
      error: { message: "assert requires subject, predicate, object" },
    };
  }
  const memory = memoryScopeFor(input);
  await memory.assert({ subject: input.subject, predicate: input.predicate, object: input.object });
  return {
    ok: true,
    value: {
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      project: input.project ?? null,
    },
  };
}

export async function tripleRemoveCommand(input: Input) {
  if (!input.graph || !input.subject || !input.predicate || !input.object) {
    return {
      ok: false,
      error: { message: "triple-rm requires graph, subject, predicate, object" },
    };
  }

  const graph = String(input.graph);
  const subject = String(input.subject);
  const predicate = String(input.predicate);
  const object = String(input.object);

  const stores = await allFactStores();
  let removed = 0;
  for (const store of stores) {
    const existing = await moo.facts.match({
      store,
      ...{ graph, subject, predicate, object: new Term(object) },
    }) as Array<[string, string, string, string]>;
    if (existing.length === 0) continue;
    await moo.facts.swap({
      store,
      removes: existing.map((row) => ({
        graph: row[0],
        subject: row[1],
        predicate: row[2],
        object: new Term(row[3]),
      })),
      adds: [],
    });
    removed += existing.length;
  }

  return {
    ok: true,
    value: { graph, subject, predicate, object, removed, project: null },
  };
}

export async function subjectRemoveCommand(input: Input) {
  if (!input.graph || !input.subject) {
    return {
      ok: false,
      error: { message: "subject-rm requires graph, subject" },
    };
  }

  const graph = String(input.graph);
  const subject = String(input.subject);

  const stores = await allFactStores();
  let removed = 0;
  for (const store of stores) {
    const existing = await moo.facts.match({ store, ...{ graph, subject } }) as Array<[string, string, string, string]>;
    if (existing.length === 0) continue;
    await moo.facts.swap({
      store,
      removes: existing.map((row) => ({
        graph: row[0],
        subject: row[1],
        predicate: row[2],
        object: new Term(row[3]),
      })),
      adds: [],
    });
    removed += existing.length;
  }

  return {
    ok: true,
    value: { graph, subject, removed, project: null },
  };
}

export async function tripleRestoreCommand(input: Input) {
  if (!input.graph || !input.subject || !input.predicate || !input.object) {
    return {
      ok: false,
      error: { message: "triple-restore requires graph, subject, predicate, object" },
    };
  }

  const graph = String(input.graph);
  const subject = String(input.subject);
  const predicate = String(input.predicate);
  const object = String(input.object);
  const objectTerm = new Term(object);

  const stores = await allFactStores();
  let restored = 0;
  for (const store of stores) {
    const history = await moo.facts.history({ store, ...{ graph, subject, predicate, object: objectTerm, limit: 1 } });
    if (!history.some((row: any[]) => row[4] === "remove")) continue;
    const existing = await moo.facts.match({ store, ...{ graph, subject, predicate, object: objectTerm, limit: 1 } });
    if (existing.length > 0) continue;
    await moo.facts.add({ store, graph, subject, predicate, object: objectTerm });
    restored++;
  }

  return {
    ok: true,
    value: { graph, subject, predicate, object, restored, project: null },
  };
}



export async function retractCommand(input: Input) {
  if (!input.subject || !input.predicate || !input.object) {
    return {
      ok: false,
      error: { message: "retract requires subject, predicate, object" },
    };
  }
  const memory = memoryScopeFor(input);
  await memory.retract({ subject: input.subject, predicate: input.predicate, object: input.object });
  return {
    ok: true,
    value: {
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      project: input.project ?? null,
    },
  };
}

