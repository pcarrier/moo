import { moo } from "../moo";
import { chatRefs } from "../lib";
import {
  compactionThresholdForBudget,
  contextBudget,
  estimateTokens,
  formatStep,
  loadPayloadJSON,
  loadResultJSON,
  readCompactionChain,
  readLastContextTokens,
} from "../agent";
import type { Input } from "./_shared";
import { chatModelInfo } from "./models";


const DEFAULT_TIMELINE_LIMIT = 160;
// The trail sidebar is an index, not the transcript itself. Keep initial loads
// bounded so old diffs/subagent payloads do not dominate chat switching time.
const TRAIL_INDEX_LIMIT = 400;
const TRAIL_STEP_INDEX_LIMIT = 240;


type TimelineRef =
  | { type: "step"; id: string; at: number }
  | { type: "input"; id: string; at: number }
  | { type: "input-response"; id: string; reqId: string; at: number }
  | { type: "log"; id: string; at: number }
  | { type: "trail"; id: string; at: number }
  | { type: "compaction"; id: string; at: number; layer: any };

function timelineTypeOrder(type: string): number {
  switch (type) {
    case "input": return 10;
    case "input-response": return 20;
    case "step": return 30;
    case "log": return 40;
    case "trail": return 50;
    case "file-diff":
    case "blob-add":
    case "memory-diff": return 60;
    case "compaction": return 70;
    default: return 100;
  }
}

function factTimestamp(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const direct = Number(raw);
  if (Number.isFinite(direct)) return direct;
  const literal = /^"((?:\\.|[^"\\])*)"(?:\^\^.+|@[a-zA-Z-]+)?$/.exec(raw);
  if (!literal) return 0;
  const unescaped = literal[1]!
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
  const numeric = Number(unescaped);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(unescaped);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareTimelineItems(a: any, b: any): number {
  return (a.at ?? 0) - (b.at ?? 0) || timelineTypeOrder(a.type) - timelineTypeOrder(b.type);
}

function newestByAt<T>(rows: T[], limit: number, at: (row: T) => number): T[] {
  if (!Number.isFinite(limit) || limit <= 0 || rows.length <= limit) return rows;
  return rows.slice().sort((a, b) => at(b) - at(a)).slice(0, limit);
}

async function loadObjectsByHash(hashes: Iterable<string>, into = new Map<string, { kind: string; value: any } | null>()) {
  const queue = [...new Set(hashes)].filter((hash) => !into.has(hash));
  let next = 0;
  const workerCount = Math.min(16, queue.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < queue.length) {
      const hash = queue[next++]!;
      into.set(hash, await moo.objects.getJSON({ hash }));
    }
  }));
  return into;
}

async function selectRows(c: ReturnType<typeof chatRefs>, where: string, vars: string, limit = 0) {
  const query = `select ${vars} where { ${where} } order by desc(?at)${limit > 0 ? ` limit ${limit}` : ""}`;
  const rows = await moo.sparql.select({ store: c.facts, graph: c.graph, query });
  return rows.map((row: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) out[key.startsWith("?") ? key : `?${key}`] = value;
    return out;
  });
}

async function loadStepRows(c: ReturnType<typeof chatRefs>, limit = 0) {
  return selectRows(c, "?step rdf:type agent:Step . ?step agent:kind ?kind . ?step agent:status ?status . ?step agent:createdAt ?at .", "?step ?kind ?status ?at", limit);
}

async function loadStepRowsByKind(c: ReturnType<typeof chatRefs>, kind: string, limit = 0) {
  const rows = await selectRows(c, `?step rdf:type agent:Step . ?step agent:kind ${kind} . ?step agent:status ?status . ?step agent:createdAt ?at .`, "?step ?status ?at", limit);
  return rows.map((row) => ({ ...row, "?kind": kind }));
}

async function loadInputResponseRows(c: ReturnType<typeof chatRefs>, limit = 0) {
  return selectRows(c, "?resp rdf:type ui:InputResponse . ?resp ui:respondsTo ?req . ?resp ui:createdAt ?at .", "?resp ?req ?at", limit);
}

async function loadLogRows(c: ReturnType<typeof chatRefs>, limit = 0) {
  return selectRows(c, "?log rdf:type agent:Log . ?log agent:createdAt ?at . ?log agent:message ?message .", "?log ?at ?message", limit);
}

async function loadTrailEntryRows(c: ReturnType<typeof chatRefs>, limit = 0) {
  return selectRows(c, "?entry rdf:type agent:TrailEntry . ?entry agent:kind ?kind . ?entry agent:createdAt ?at .", "?entry ?kind ?at", limit);
}

async function loadStepCount(c: ReturnType<typeof chatRefs>, kind: string | null = null) {
  const rows = await moo.facts.match({
    store: c.facts,
    graph: c.graph,
    predicate: kind ? "agent:kind" : "rdf:type",
    object: kind || "agent:Step",
  });
  return rows.length;
}

async function loadTypeCount(c: ReturnType<typeof chatRefs>, type: string) {
  const rows = await moo.facts.match({ store: c.facts, graph: c.graph, predicate: "rdf:type", object: type });
  return rows.length;
}

async function loadInputRows(c: ReturnType<typeof chatRefs>, responseRows: Array<Record<string, string>>, limit = 0) {
  const rows = await selectRows(c, "?req rdf:type ui:InputRequest . ?req ui:kind ?kind . ?req ui:status ?status . ?req ui:createdAt ?at .", "?req ?kind ?status ?at", limit);
  const visibleIds = new Set(rows.map((row) => row["?req"]).filter(Boolean));
  const missingIds = responseRows
    .map((row) => row["?req"])
    .filter((id): id is string => !!id && !visibleIds.has(id))
    .slice(0, Math.max(limit, responseRows.length));
  if (!missingIds.length) return rows;
  const extra = await Promise.all(missingIds.map(async (reqId) => {
    const [kind, status, at] = await Promise.all([
      moo.facts.match({ store: c.facts, graph: c.graph, subject: reqId, predicate: "ui:kind", limit: 1 }),
      moo.facts.match({ store: c.facts, graph: c.graph, subject: reqId, predicate: "ui:status", limit: 1 }),
      moo.facts.match({ store: c.facts, graph: c.graph, subject: reqId, predicate: "ui:createdAt", limit: 1 }),
    ]);
    return { "?req": reqId, "?kind": kind[0]?.[3] || "ui:Form", "?status": status[0]?.[3] || "ui:Done", "?at": at[0]?.[3] || "0" };
  }));
  return rows.concat(extra);
}

async function loadTrailItems(c: ReturnType<typeof chatRefs>, rows: any[], limit = 0) {
  const selectedRows = newestByAt(rows, limit, (row) => factTimestamp((row as any)["?at"]));
  const entryIds = new Set<string>(selectedRows.map((row) => row["?entry"]).filter(Boolean));
  const payloadHashByEntry = new Map<string, string>();
  await Promise.all(
    [...entryIds].map(async (entryId) => {
      const payload = await moo.facts.match({ store: c.facts, ...{
        graph: c.graph,
        subject: entryId,
        predicate: "agent:payload",
        limit: 1,
      } });
      const hash = payload[0]?.[3];
      if (hash) payloadHashByEntry.set(entryId, hash);
    }),
  );
  const objectByHash = await loadObjectsByHash(payloadHashByEntry.values());
  return selectedRows.map((row) => {
    const entryId = row["?entry"]!;
    const hash = payloadHashByEntry.get(entryId);
    return trailRowToTimelineItem(row, hash ? objectByHash.get(hash) ?? null : null);
  });
}

function trailRowToTimelineItem(row: any, payload: { kind?: string; value?: any } | null) {
  const value = payload?.value || {};
  return {
    type: "trail",
    id: row["?entry"],
    kind: row["?kind"] || payload?.kind || "agent:Summary",
    at: factTimestamp(row["?at"]) || factTimestamp(value.at),
    title: value.title ?? null,
    previousTitle: value.previousTitle ?? null,
    body: value.body ?? value.summary ?? null,
    summary: value.summary ?? null,
  };
}

async function loadTrailStepItems(c: ReturnType<typeof chatRefs>, chatId: string, rows: any[], limit = 0) {
  // The main timeline can be limited to the newest N rows for responsiveness,
  // but the Trails sidebar is just a navigation index. Load only the newest
  // historical step kinds it renders instead of resolving every old diff and
  // subagent payload/result on every chat switch.
  const trailStepRows = newestByAt(
    rows.filter((row) =>
      row["?kind"] === "agent:FileDiff" || row["?kind"] === "agent:Subagent"
    ),
    limit,
    (row) => factTimestamp(row["?at"]),
  );
  const stepMetaRows = await Promise.all(
    trailStepRows.map(async (row) => {
      const stepId = row["?step"];
      if (!stepId) return { row, stepId, payload: [], result: [] };
      const [payload, result] = await Promise.all([
        moo.facts.match({ store: c.facts, ...{ graph: c.graph, subject: stepId, predicate: "agent:payload", limit: 1 } }),
        row["?kind"] === "agent:Subagent"
          ? moo.facts.match({ store: c.facts, ...{ graph: c.graph, subject: stepId, predicate: "agent:result", limit: 1 } })
          : Promise.resolve([]),
      ]);
      return { row, stepId, payload, result };
    }),
  );

  const wantedHashes = new Set<string>();
  for (const meta of stepMetaRows) {
    const payload = meta.payload[0]?.[3];
    if (payload) wantedHashes.add(payload);
    const result = meta.result[0]?.[3];
    if (result) wantedHashes.add(result);
  }
  const objectByHash = await loadObjectsByHash(wantedHashes);
  const lookupObject = (hash?: string) => hash ? objectByHash.get(hash) ?? null : null;

  const items: any[] = [];
  for (const meta of stepMetaRows) {
    const row = meta.row;
    const stepId = meta.stepId;
    if (!stepId) continue;
    const payload = lookupObject(meta.payload[0]?.[3]);
    const result = lookupObject(meta.result[0]?.[3]);
    const at = factTimestamp(row["?at"]);
    if (row["?kind"] === "agent:FileDiff" && payload?.value) {
      items.push({
        type: "file-diff",
        id: payload.value.hash || stepId,
        step: stepId,
        chatId,
        path: payload.value.path || "(unknown)",
        diff: payload.value.diff || "",
        stats: payload.value.stats,
        before: payload.value.before,
        after: payload.value.after,
        hash: payload.value.hash,
        at,
      });
      continue;
    }
    if (row["?kind"] === "agent:Subagent") {
      const item: any = {
        type: "step",
        step: stepId,
        kind: row["?kind"],
        status: row["?status"],
        at,
      };
      const value = payload?.value || {};
      item.subagent = {
        label: value.label ?? null,
        task: value.task ?? null,
        childChatId: value.childChatId ?? null,
        parentRunJsStepId: value.parentRunJsStepId ?? null,
        result: result?.value ?? null,
      };
      item.text = formatStep(item, payload, result);
      if (!item.text) item.text = [item.subagent.label, item.subagent.task].filter(Boolean).join("\n");
      items.push(item);
    }
  }
  return items;
}

export async function describeCommand(input: Input) {
  const chatId = input.chatId || "demo";
  const c = chatRefs(chatId);
  const [head, title, path, createdAt, lastAt, hiddenRaw, parentChatId] = await Promise.all([
    moo.pointers.get(c.head),
    moo.pointers.get(`chat/${chatId}/title`),
    moo.pointers.get(`chat/${chatId}/path`),
    moo.pointers.get(`chat/${chatId}/created-at`),
    moo.pointers.get(`chat/${chatId}/last-at`),
    moo.pointers.get(`chat/${chatId}/hidden`),
    moo.pointers.get(`chat/${chatId}/parent`),
  ]);
  const normalizedPath = String(path || ".").replace(/\/+$/, "") || ".";
  const worktreePath = normalizedPath + "/.moo/" + chatId;
  const totalFacts = await moo.facts.count({ store: c.facts });

  // Loading a long chat should not require formatting every historical step
  // and resolving every historical object payload. When the UI passes a
  // positive limit, return only the newest N timeline entries while still
  // reporting the full counters above. The older entries can be requested by
  // raising/removing the limit.
  const rawLimit = Number(input.limit ?? input.timelineLimit ?? 0);
  const timelineLimit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.max(1, Math.floor(rawLimit))
      : 0;
  const effectiveTimelineLimit = timelineLimit > 0 ? timelineLimit : DEFAULT_TIMELINE_LIMIT;
  const boundedScanLimit = timelineLimit > 0 ? Math.max(effectiveTimelineLimit * 4, 512) : 0;
  const [steps, totalSteps, totalTurns, totalCodeCalls, totalInputs, totalInputResponses, totalLogs, totalTrailEntries, compactionSteps, fileDiffTrailRows, subagentTrailRows, inputResponses, logs, trailEntries] = await Promise.all([
    loadStepRows(c, boundedScanLimit),
    loadStepCount(c),
    loadStepCount(c, "agent:UserInput"),
    loadStepCount(c, "agent:RunJS"),
    loadTypeCount(c, "ui:InputRequest"),
    loadTypeCount(c, "ui:InputResponse"),
    loadTypeCount(c, "agent:Log"),
    loadTypeCount(c, "agent:TrailEntry"),
    loadStepRowsByKind(c, "agent:Compaction"),
    loadStepRowsByKind(c, "agent:FileDiff", Math.max(TRAIL_STEP_INDEX_LIMIT, effectiveTimelineLimit)),
    loadStepRowsByKind(c, "agent:Subagent", Math.max(TRAIL_STEP_INDEX_LIMIT, effectiveTimelineLimit)),
    loadInputResponseRows(c, boundedScanLimit),
    loadLogRows(c, boundedScanLimit),
    loadTrailEntryRows(c, Math.max(TRAIL_INDEX_LIMIT, boundedScanLimit)),
  ]);
  const inputs = await loadInputRows(c, inputResponses, boundedScanLimit);
  const trailStepRows = newestByAt(
    [...fileDiffTrailRows, ...subagentTrailRows],
    Math.max(TRAIL_STEP_INDEX_LIMIT, effectiveTimelineLimit),
    (row) => factTimestamp(row["?at"]),
  );

  // Older compaction implementations only advanced chat/<id>/compaction
  // and did not append an agent:Compaction step, which made automatic
  // compactions invisible in the timeline. Include those compaction-chain
  // layers as synthetic timeline rows, but do not duplicate layers that
  // already have a real step payload.
  const compactionLayers = await readCompactionChain(chatId);
  const compactionStepPayloadHashes = new Set<string>();
  await Promise.all(
    compactionSteps
      .filter((row) => row["?kind"] === "agent:Compaction")
      .map(async (row) => {
        const stepId = row["?step"];
        if (!stepId) return;
        const payload = await moo.facts.match({ store: c.facts, ...{
          graph: c.graph,
          subject: stepId,
          predicate: "agent:payload",
          limit: 1,
        } });
        const hash = payload[0]?.[3];
        if (hash) compactionStepPayloadHashes.add(hash);
      }),
  );
  const syntheticCompactions = compactionLayers
    .filter((layer) => !compactionStepPayloadHashes.has(layer.hash))
    .map((layer) => ({
      type: "compaction" as const,
      id: layer.hash,
      at: factTimestamp(layer.at || layer.throughAt),
      layer,
    }));

  const inputByRequest = new Map(inputs.map((row) => [row["?req"]!, row]));
  const responderByRequest = new Map<string, string>();
  const responseRequestById = new Map<string, string>();
  for (const row of inputResponses) {
    const respId = row["?resp"]!;
    const reqId = row["?req"]!;
    if (!respId || !reqId) continue;
    if (!responderByRequest.has(reqId)) responderByRequest.set(reqId, respId);
    responseRequestById.set(respId, reqId);
  }

  const timelineRefs: TimelineRef[] = [
    ...steps.map((row) => ({ type: "step" as const, id: row["?step"]!, at: factTimestamp(row["?at"]) })),
    ...inputs.map((row) => ({ type: "input" as const, id: row["?req"]!, at: factTimestamp(row["?at"]) })),
    ...inputResponses.map((row) => ({
      type: "input-response" as const,
      id: row["?resp"]!,
      reqId: row["?req"]!,
      at: factTimestamp(row["?at"]),
    })),
    ...logs.map((row) => ({ type: "log" as const, id: row["?log"]!, at: factTimestamp(row["?at"]) })),
    ...trailEntries.map((row) => ({ type: "trail" as const, id: row["?entry"]!, at: factTimestamp(row["?at"]) })),
    ...syntheticCompactions,
  ].sort((a, b) => a.at - b.at || timelineTypeOrder(a.type) - timelineTypeOrder(b.type));
  const totalTimelineItems = totalSteps + totalInputs + totalInputResponses + totalLogs + totalTrailEntries + syntheticCompactions.length;
  const visibleRefs = (() => {
    if (timelineLimit <= 0 || totalTimelineItems <= timelineLimit) return timelineRefs;
    // timelineRefs is already a bounded scan of recent rows, not the complete
    // history. Slice from the scanned tail so old entries (including synthetic
    // compactions) stay hidden until the user loads enough older messages for
    // their chronological position to enter the window.
    return timelineRefs.slice(-timelineLimit);
  })();
  const hiddenTimelineItems = totalTimelineItems - visibleRefs.length;
  const visibleStepIds = new Set(
    visibleRefs.filter((r) => r.type === "step").map((r) => r.id),
  );
  const visibleInputIds = new Set(
    visibleRefs.filter((r) => r.type === "input").map((r) => r.id),
  );
  const visibleResponseIds = new Set(
    visibleRefs.filter((r) => r.type === "input-response").map((r) => r.id),
  );
  const visibleResponseRequestIds = new Set(
    visibleRefs
      .filter((r) => r.type === "input-response")
      .map((r) => r.reqId)
      .filter((reqId): reqId is string => !!reqId),
  );
  const visibleLogIds = new Set(
    visibleRefs.filter((r) => r.type === "log").map((r) => r.id),
  );
  const visibleTrailIds = new Set(
    visibleRefs.filter((r) => r.type === "trail").map((r) => r.id),
  );
  const visibleCompactions = visibleRefs
    .filter((r) => r.type === "compaction")
    .map((r) => r.layer);
  const visibleSteps = steps.filter((s) => visibleStepIds.has(s["?step"]!));
  const visibleInputs = inputs.filter((r) => visibleInputIds.has(r["?req"]!));
  const visibleResponses = inputResponses.filter((r) => visibleResponseIds.has(r["?resp"]!));
  const visibleLogs = logs.filter((r) => visibleLogIds.has(r["?log"]!));
  const visibleTrailEntries = trailEntries.filter((r) => visibleTrailIds.has(r["?entry"]!));
  const trailIndexEntryRows = newestByAt(trailEntries, Math.max(TRAIL_INDEX_LIMIT, effectiveTimelineLimit), (row) => factTimestamp(row["?at"]));
  const trailItems = await loadTrailItems(c, trailIndexEntryRows);
  const trailTimelineItems = [
    ...trailItems,
    ...await loadTrailStepItems(c, chatId, trailStepRows),
  ].sort(compareTimelineItems);

  // Fetch per-step metadata with one scan per predicate, then filter to the
  // visible window. Hundreds of subject-specific host calls are much slower
  // than a few predicate scans once a chat has accumulated many steps.
  const [payloadRows, resultRows, modelRows, effortRows, deletedAtRows] = await Promise.all([
    moo.facts.match({ store: c.facts, graph: c.graph, predicate: "agent:payload" }),
    moo.facts.match({ store: c.facts, graph: c.graph, predicate: "agent:result" }),
    moo.facts.match({ store: c.facts, graph: c.graph, predicate: "agent:model" }),
    moo.facts.match({ store: c.facts, graph: c.graph, predicate: "agent:effort" }),
    moo.facts.match({ store: c.facts, graph: c.graph, predicate: "agent:deletedAt" }),
  ]);
  const payloadHashByStep = new Map<string, string>();
  const resultHashByStep = new Map<string, string>();
  const modelByStep = new Map<string, string>();
  const effortByStep = new Map<string, string>();
  const deletedAtByStep = new Map<string, string>();
  const keepVisibleStepFact = (row: string[]) => visibleStepIds.has(row[1]);
  for (const row of payloadRows) {
    if (keepVisibleStepFact(row)) payloadHashByStep.set(row[1], row[3]);
  }
  for (const row of resultRows) {
    if (keepVisibleStepFact(row)) resultHashByStep.set(row[1], row[3]);
  }
  for (const row of modelRows) {
    if (keepVisibleStepFact(row)) modelByStep.set(row[1], row[3]);
  }
  for (const row of effortRows) {
    if (keepVisibleStepFact(row)) effortByStep.set(row[1], row[3]);
  }
  for (const row of deletedAtRows) {
    if (keepVisibleStepFact(row)) deletedAtByStep.set(row[1], row[3]);
  }

  // Dedupe object hashes — same payload referenced twice (rare) costs one
  // lookup. Keep object reads bounded so large visible RunJS histories do not
  // create hundreds of host calls in one burst.
  const runJsVisibleStepIds = new Set<string>(
    visibleSteps
      .filter((row) => row["?kind"] === "agent:RunJS")
      .map((row) => row["?step"]!)
      .filter(Boolean),
  );
  const wantedHashes = new Set<string>();
  for (const h of payloadHashByStep.values()) wantedHashes.add(h);
  for (const [stepId, h] of resultHashByStep) {
    // RunJS results are often the largest visible objects and are hidden in a
    // collapsed row. Return their hashes and hydrate only when the user opens
    // the row; keep non-RunJS results eager for existing renderers.
    if (!runJsVisibleStepIds.has(stepId)) wantedHashes.add(h);
  }
  const objectByHash = await loadObjectsByHash(wantedHashes);

  const lookupPayload = (stepId: string) => {
    const h = payloadHashByStep.get(stepId);
    return h ? objectByHash.get(h) ?? null : null;
  };
  const lookupResult = (stepId: string) => {
    const h = resultHashByStep.get(stepId);
    return h ? objectByHash.get(h) ?? null : null;
  };

  const timeline: any[] = [];
  const renderStep = (s: any) => {
    const stepId = s["?step"]!;
    const item: any = {
      type: "step",
      step: stepId,
      kind: s["?kind"],
      status: s["?status"],
      at: factTimestamp(s["?at"]),
    };
    const deletedAt = deletedAtByStep.get(stepId);
    if (deletedAt) item.deletedAt = Number(deletedAt) || deletedAt;
    const payload = lookupPayload(stepId);
    const result = lookupResult(stepId);
    if (s["?kind"] === "agent:Subagent" && payload?.value) {
      item.subagent = {
        label: payload.value.label ?? null,
        task: payload.value.task ?? null,
        childChatId: payload.value.childChatId ?? null,
        parentRunJsStepId: payload.value.parentRunJsStepId ?? null,
        result: result?.value ?? null,
      };
    }
    if (s["?kind"] === "agent:RunJS" && payload?.value) {
      item.runjs = {
        label: payload.value.label ?? null,
        description: payload.value.description ?? null,
        ...(Object.prototype.hasOwnProperty.call(payload.value, "args") ? { args: payload.value.args } : {}),
        code: payload.value.code ?? null,
        result: typeof result?.value?.value === "string" ? result.value.value : null,
        error: typeof result?.value?.error === "string" ? result.value.error : null,
        durationMs: typeof result?.value?.durationMs === "number" ? result.value.durationMs : undefined,
      };
      const resultHash = resultHashByStep.get(stepId);
      if (resultHash && !result) {
        item.lazyRunjsResult = true;
        item.resultHash = resultHash;
      }
    }
    if (s["?kind"] === "agent:BlobAdd" && payload?.value) {
      return {
        type: "blob-add",
        id: stepId,
        step: stepId,
        chatId,
        objectKind: payload.value.kind || "object",
        hash: payload.value.hash,
        size: payload.value.size,
        chars: payload.value.chars,
        encoding: payload.value.encoding,
        at: factTimestamp(s["?at"]),
      };
    }
    if ((s["?kind"] === "agent:FileDiff" || s["?kind"] === "agent:MemoryDiff") && payload?.value) {
      return {
        type: s["?kind"] === "agent:MemoryDiff" ? "memory-diff" : "file-diff",
        id: payload.value.hash || stepId,
        step: stepId,
        chatId,
        path: payload.value.path || "(unknown)",
        diff: payload.value.diff || "",
        stats: payload.value.stats,
        before: payload.value.before,
        after: payload.value.after,
        hash: payload.value.hash,
        store: payload.value.store,
        graph: payload.value.graph,
        action: payload.value.action,
        count: payload.value.count,
        changes: payload.value.changes,
        at: factTimestamp(s["?at"]),
      };
    }
    item.text = formatStep(item, payload, result);
    if (s["?kind"] === "agent:Error" && payload?.value) {
      item.error = payload.value;
    }
    if (
      s["?kind"] === "agent:UserInput" &&
      Array.isArray(payload?.value?.attachments) &&
      payload.value.attachments.length
    ) {
      item.attachments = payload.value.attachments;
    }
    const model = modelByStep.get(stepId);
    if (model) item.model = model;
    const effort = effortByStep.get(stepId);
    if (effort) item.effort = effort;
    if (s["?kind"] === "agent:Reply") {
      const thoughtDurationMs = Number(payload?.value?.thoughtDurationMs);
      if (Number.isFinite(thoughtDurationMs) && thoughtDurationMs >= 0) {
        item.thoughtDurationMs = thoughtDurationMs;
      }
      const draftId = payload?.value?.draftId;
      if (typeof draftId === "string" && draftId) {
        item.draftId = draftId;
      }
    }
    return item;
  };
  const stepById = new Map(visibleSteps.map((s) => [s["?step"]!, s]));

  // Same bounded lookup pattern for UI requests/responses: resolve payloads
  // only for visible request rows, visible response rows, and request specs
  // needed to render those response rows. Responses are separate timeline rows
  // keyed by their own ui:createdAt so answers appear where the user submitted
  // them instead of back at the original form request time.
  const visibleInputPayloadIds = new Set<string>([
    ...visibleInputIds,
    ...visibleResponseRequestIds,
  ]);
  const responseIdsForVisibleInputs = [...visibleInputIds]
    .map((reqId) => responderByRequest.get(reqId))
    .filter((respId): respId is string => !!respId);
  const visibleResponsePayloadIds = new Set<string>([
    ...visibleResponseIds,
    ...responseIdsForVisibleInputs,
  ]);
  const uiPayloadHashBySubject = new Map<string, string>();
  await Promise.all(
    [...visibleInputPayloadIds, ...visibleResponsePayloadIds].map(async (subject) => {
      const payload = await moo.facts.match({ store: c.facts, ...{
        graph: c.graph,
        subject,
        predicate: "ui:payload",
        limit: 1,
      } });
      const hash = payload[0]?.[3];
      if (hash) uiPayloadHashBySubject.set(subject, hash);
    }),
  );
  const uiHashes = new Set<string>(uiPayloadHashBySubject.values());
  await loadObjectsByHash(uiHashes, objectByHash);
  const lookupUiPayload = (subject: string) => {
    const h = uiPayloadHashBySubject.get(subject);
    return h ? objectByHash.get(h) ?? null : null;
  };
  const uiResponseValue = (respId: string | undefined, fallbackAt = 0) => {
    if (!respId) return null;
    const payload = lookupUiPayload(respId);
    const value = payload?.value || {};
    return {
      values: value.values || {},
      at: Number(value.at) || fallbackAt,
      ...(value.cancelled ? { cancelled: true } : {}),
    };
  };
  const renderLog = (r: any) => ({
    type: "log",
    id: r["?log"],
    at: factTimestamp(r["?at"]),
    message: r["?message"] || "",
  });
  const logById = new Map(visibleLogs.map((r) => [r["?log"]!, r]));

  const visibleTrailItems = await loadTrailItems(c, visibleTrailEntries);
  const trailById = new Map(visibleTrailItems.map((item) => [item.id, item]));


  const renderCompaction = (layer: any) => {
    const trigger =
      layer.trigger === "automatic"
        ? "automatic "
        : layer.trigger === "manual"
          ? "manual "
          : "";
    return {
      type: "step",
      step: `compaction:${layer.hash}`,
      kind: "agent:Compaction",
      status: "agent:Done",
      at: factTimestamp(layer.at || layer.throughAt),
      text: `${trigger}compaction\n${layer.summary || ""}`,
    };
  };
  const compactionByHash = new Map(visibleCompactions.map((layer) => [layer.hash, layer]));

  const renderInput = (r: any) => {
    const reqId = r["?req"]!;
    const spec = lookupUiPayload(reqId);
    let response: { values: Record<string, unknown>; at: number; cancelled?: boolean } | null = null;
    if (r["?status"] === "ui:Done" || r["?status"] === "ui:Cancelled") {
      response = uiResponseValue(responderByRequest.get(reqId));
    }
    return {
      type: "input",
      requestId: reqId,
      kind: r["?kind"],
      status: r["?status"],
      at: factTimestamp(r["?at"]),
      spec: spec?.value || null,
      response,
    };
  };
  const inputById = new Map(visibleInputs.map((r) => [r["?req"]!, r]));

  const renderInputResponse = (r: any) => {
    const respId = r["?resp"]!;
    const reqId = r["?req"]! || responseRequestById.get(respId) || "";
    const request = inputByRequest.get(reqId);
    const at = factTimestamp(r["?at"]);
    const response = uiResponseValue(respId, at) || { values: {}, at };
    const spec = reqId ? lookupUiPayload(reqId) : null;
    return {
      type: "input-response",
      responseId: respId,
      requestId: reqId,
      kind: request?.["?kind"] || spec?.kind || "ui:Form",
      at: response.at || at,
      spec: spec?.value || null,
      response,
    };
  };
  const responseById = new Map(visibleResponses.map((r) => [r["?resp"]!, r]));

  for (const ref of visibleRefs) {
    if (ref.type === "step") {
      const row = stepById.get(ref.id);
      if (row) timeline.push(renderStep(row));
    } else if (ref.type === "input") {
      const row = inputById.get(ref.id);
      if (row) timeline.push(renderInput(row));
    } else if (ref.type === "input-response") {
      const row = responseById.get(ref.id);
      if (row) timeline.push(renderInputResponse(row));
    } else if (ref.type === "log") {
      const row = logById.get(ref.id);
      if (row) timeline.push(renderLog(row));
    } else if (ref.type === "trail") {
      const item = trailById.get(ref.id);
      if (item) timeline.push(item);
    } else if (ref.type === "compaction") {
      const layer = compactionByHash.get(ref.id);
      if (layer) timeline.push(renderCompaction(layer));
    }
  }

  // Token pressure surfaced for the UI bar. Use the provider's real
  // prompt + completion tokens from the most recent call so the final count
  // matches the streaming estimate instead of snapping backward when the
  // completion finishes.
  const modelInfo = await chatModelInfo(chatId);
  const lastContextTokens = await readLastContextTokens(chatId);
  const budget = await contextBudget({ name: modelInfo.provider, model: modelInfo.effectiveModel });
  const threshold = await compactionThresholdForBudget(budget);
  const used = lastContextTokens ?? 0;
  const tokens = {
    used,
    budget,
    threshold,
    fraction: budget > 0 ? used / budget : 0,
  };

  return {
    ok: true,
    value: {
      chatId,
      title: title || null,
      path,
      worktreePath,
      createdAt: createdAt ? Number(createdAt) : null,
      lastAt: lastAt ? Number(lastAt) : null,
      hidden: hiddenRaw === "true",
      parentChatId,
      head,
      totalFacts,
      totalTurns,
      totalSteps,
      totalCodeCalls,
      timeline,
      trail: trailTimelineItems,
      tokens,
      totalTimelineItems,
      hiddenTimelineItems,
      timelineLimit,
    },
  };
}

export type ModelPrice = { input: number; cachedInput: number; output: number; cacheWriteInput?: number };

// USD per million tokens. Cache lookups are subset matched (substring):
// `gpt-5.5` matches both `gpt-5.5` and `gpt-5.5-2026-01`. Override or extend
// via MOO_LLM_PRICING (JSON: {"<model-substring>": {input,cachedInput,cacheWriteInput,output}}).
const DEFAULT_MODEL_PRICING: Record<string, ModelPrice> = {
  "gpt-5.5": { input: 2.5, cachedInput: 0.25, output: 10 },
  "gpt-5": { input: 2.5, cachedInput: 0.25, output: 10 },
  "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },
  "qwen3.6": { input: 0.4, cachedInput: 0.04, output: 1.2 },
  "qwen": { input: 0.4, cachedInput: 0.04, output: 1.2 },
  // Anthropic Claude. cachedInput is prompt-cache read pricing; cacheWriteInput
  // is prompt-cache write pricing where Anthropic bills writes separately.
  // Substring match is longest-key-wins, so e.g. "claude-opus-4" covers
  // claude-opus-4, -4-1, -4-5, -4-6, -4-7. Override via MOO_LLM_PRICING if a
  // provider adjusts rates for a specific minor version.
  "claude-opus-4": { input: 15, cachedInput: 1.5, cacheWriteInput: 18.75, output: 75 },
  "claude-sonnet-4": { input: 3, cachedInput: 0.3, cacheWriteInput: 3.75, output: 15 },
  "claude-haiku-4": { input: 1, cachedInput: 0.1, cacheWriteInput: 1.25, output: 5 },
  "claude-3-7-sonnet": { input: 3, cachedInput: 0.3, cacheWriteInput: 3.75, output: 15 },
  "claude-3-5-sonnet": { input: 3, cachedInput: 0.3, cacheWriteInput: 3.75, output: 15 },
  "claude-3-5-haiku": { input: 0.8, cachedInput: 0.08, cacheWriteInput: 1, output: 4 },
  "claude-3-opus": { input: 15, cachedInput: 1.5, cacheWriteInput: 18.75, output: 75 },
  "claude-3-haiku": { input: 0.25, cachedInput: 0.03, cacheWriteInput: 0.3, output: 1.25 },
};

export function validPrice(v: unknown): v is ModelPrice {
  const r = v as Partial<ModelPrice> | null;
  return !!r &&
    Number.isFinite(r.input) && r.input >= 0 &&
    Number.isFinite(r.cachedInput) && r.cachedInput >= 0 &&
    Number.isFinite(r.output) && r.output >= 0 &&
    (r.cacheWriteInput == null || (Number.isFinite(r.cacheWriteInput) && r.cacheWriteInput >= 0));
}

export async function loadPricing(): Promise<Record<string, ModelPrice>> {
  const raw = await moo.env.get("MOO_LLM_PRICING");
  if (!raw) return DEFAULT_MODEL_PRICING;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const clean: Record<string, ModelPrice> = { ...DEFAULT_MODEL_PRICING };
      for (const [key, rate] of Object.entries(parsed)) {
        if (typeof key === "string" && key.trim() && validPrice(rate)) {
          clean[key] = rate;
        }
      }
      return clean;
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_MODEL_PRICING;
}

export function priceFor(
  model: string,
  table: Record<string, ModelPrice>,
): ModelPrice | null {
  if (table[model]) return table[model]!;
  const lower = model.toLowerCase();
  let best: { key: string; rate: ModelPrice } | null = null;
  for (const [key, rate] of Object.entries(table)) {
    if (lower.includes(key.toLowerCase()) && (!best || key.length > best.key.length)) {
      best = { key, rate };
    }
  }
  return best?.rate ?? null;
}

export function estimateCostUsd(
  usage: { models: Record<string, { input: number; cachedInput: number; cacheWriteInput?: number; output: number }> } | null,
  table: Record<string, ModelPrice>,
): { costUsd: number; unpricedModels: string[] } {
  if (!usage) return { costUsd: 0, unpricedModels: [] };
  let total = 0;
  const unpricedModels: string[] = [];
  for (const [model, counts] of Object.entries(usage.models)) {
    const rate = priceFor(model, table);
    if (!rate) {
      unpricedModels.push(model);
      continue;
    }
    total +=
      (counts.input * rate.input +
        counts.cachedInput * rate.cachedInput +
        (counts.cacheWriteInput ?? 0) * (rate.cacheWriteInput ?? rate.input) +
        counts.output * rate.output) /
      1_000_000;
  }
  return { costUsd: total, unpricedModels };
}

