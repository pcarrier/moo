import { moo } from "../moo";
import { readCompactionChain } from "../agent";
import { allFactRefs, memoryScopeFor, type Input } from "./_shared";

export async function compactionsCommand(input: Input) {
  if (!input.chatId) {
    return { ok: false, error: { message: "compactions requires chatId" } };
  }
  const chain = await readCompactionChain(input.chatId);
  return { ok: true, value: { chatId: input.chatId, layers: chain } };
}

// -- cross-chat facts ------------------------------------------------------

export async function objectGetCommand(input: Input) {
  const raw = typeof input.hash === "string" ? input.hash.trim() : "";
  const hash = raw.startsWith("sha256:") ? raw : (/^[a-f0-9]{64}$/i.test(raw) ? "sha256:" + raw : raw);
  if (!/^sha256:[a-f0-9]{64}$/i.test(hash)) {
    return { ok: false, error: { message: "object-get requires sha256:<64-hex> hash" } };
  }
  const object = await moo.objects.get(hash);
  return { ok: true, value: { hash, object } };
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

export async function triplesCommand(input: Input) {
  const removedMode = input.removed === "include" || input.removed === "only" ? input.removed : "exclude";
  if (input.project !== undefined) {
    const memory = memoryScopeFor(input);
    if (removedMode === "include" || removedMode === "only") {
      const refName = await projectMemoryRefFor(input.project);
      const graph = await projectMemoryGraphFor(input.project);
      const rows = await moo.facts.history(refName, {
        graph,
        subject: input.subject ?? null,
        predicate: input.predicate ?? null,
        object: input.object ?? null,
      });
      const triples = rows.filter((row) => row[4] === "remove");
      return { ok: true, value: { triples } };
    }
    const triples = await memory.triples({
      subject: input.subject ?? null,
      predicate: input.predicate ?? null,
      object: input.object ?? null,
    });
    return { ok: true, value: { triples } };
  }

  const refs = await allFactRefs();
  const triples: Array<[string, string, string, string, string?, string?]> = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const current = await moo.facts.match(ref, {
      subject: input.subject ?? null,
      predicate: input.predicate ?? null,
      object: input.object ?? null,
    });
    const currentKeys = new Set(
      (current as Array<[string, string, string, string]>).map((row) => row.join("\u0000")),
    );
    const rows = await moo.facts.history(ref, {
      subject: input.subject ?? null,
      predicate: input.predicate ?? null,
      object: input.object ?? null,
    });
    if (removedMode !== "exclude") {
      for (const row of rows as Array<[string, string, string, string, string, string]>) {
        if (row[4] !== "remove") continue;
        if (currentKeys.has(row.slice(0, 4).join("\u0000"))) continue;
        const key = row.join("\u0000");
        if (seen.has(key)) continue;
        seen.add(key);
        triples.push(row);
      }
    }
    if (removedMode === "only") continue;
    for (const row of current as Array<[string, string, string, string]>) {
      const event: [string, string, string, string, string, string] = [
        row[0],
        row[1],
        row[2],
        row[3],
        "present",
        "",
      ];
      const key = event.join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      triples.push(event);
    }
  }
  return { ok: true, value: { triples } };
}

export async function projectMemoryRefFor(project: unknown): Promise<string> {
  if (project === false || project === "") return "memory/facts";
  if (typeof project === "string" && project.length > 0) {
    return "memory/project/" + encodeURIComponent(project).replace(/[!'()*]/g, (ch) =>
      "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
    ) + "/facts";
  }
  const git = await moo.proc.run("git", ["rev-parse", "--show-toplevel"], { timeoutMs: 2_000 });
  const raw = git.code === 0 && git.stdout.trim() ? git.stdout.trim() : (await moo.env.get("PWD")) || ".";
  return projectMemoryRefFor(raw);
}

export async function projectMemoryGraphFor(project: unknown): Promise<string> {
  if (project === false || project === "") return "memory:facts";
  const refName = await projectMemoryRefFor(project);
  if (refName === "memory/facts") return "memory:facts";
  return "memory:project/" + refName.slice("memory/project/".length, -"/facts".length);
}

export async function assertCommand(input: Input) {
  if (!input.subject || !input.predicate || !input.object) {
    return {
      ok: false,
      error: { message: "assert requires subject, predicate, object" },
    };
  }
  const memory = memoryScopeFor(input);
  await memory.assert(input.subject, input.predicate, input.object);
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

  const refs = await allFactRefs();
  let removed = 0;
  for (const ref of refs) {
    const existing = await moo.facts.match(ref, { graph, subject, predicate, object, limit: 1 });
    if (existing.length === 0) continue;
    await moo.facts.remove(ref, graph, subject, predicate, object);
    removed++;
  }

  return {
    ok: true,
    value: { graph, subject, predicate, object, removed, project: null },
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

  const refs = await allFactRefs();
  let restored = 0;
  for (const ref of refs) {
    const history = await moo.facts.history(ref, { graph, subject, predicate, object, limit: 1 });
    if (!history.some((row: any[]) => row[4] === "remove")) continue;
    const existing = await moo.facts.match(ref, { graph, subject, predicate, object, limit: 1 });
    if (existing.length > 0) continue;
    await moo.facts.add(ref, graph, subject, predicate, object);
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
  await memory.retract(input.subject, input.predicate, input.object);
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

