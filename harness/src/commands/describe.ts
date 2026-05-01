import { moo } from "../moo";
import { chatRefs } from "../lib";
import {
  COMPACT_FRACTION,
  contextBudget,
  estimateTokens,
  formatStep,
  loadPayloadJSON,
  loadResultJSON,
  readCompactionChain,
  readLastPromptTokens,
} from "../agent";
import type { Input } from "./_shared";
import { chatModelInfo } from "./models";


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

async function loadTrailItems(c: ReturnType<typeof chatRefs>, rows: any[]) {
  const entryIds = new Set<string>(rows.map((row) => row["?entry"]).filter(Boolean));
  const payloadHashByEntry = new Map<string, string>();
  await Promise.all(
    [...entryIds].map(async (entryId) => {
      const payload = await moo.facts.match({ ref: c.facts, ...{
        graph: c.graph,
        subject: entryId,
        predicate: "agent:payload",
        limit: 1,
      } });
      const hash = payload[0]?.[3];
      if (hash) payloadHashByEntry.set(entryId, hash);
    }),
  );
  const objectByHash = new Map<string, { kind: string; value: any } | null>();
  for (const h of new Set(payloadHashByEntry.values())) {
    objectByHash.set(h, await moo.objects.getJSON({ hash: h }));
  }
  return rows.map((row) => {
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

async function loadTrailStepItems(c: ReturnType<typeof chatRefs>, chatId: string, rows: any[]) {
  // The main timeline can be limited to the newest N rows for responsiveness,
  // but the Trails sidebar is a chat-wide index. Load only the historical step
  // kinds it renders instead of resolving every old step payload/result.
  const trailStepRows = rows.filter((row) =>
    row["?kind"] === "agent:FileDiff" || row["?kind"] === "agent:Subagent"
  );
  const stepMetaRows = await Promise.all(
    trailStepRows.map(async (row) => {
      const stepId = row["?step"];
      if (!stepId) return { row, stepId, payload: [], result: [] };
      const [payload, result] = await Promise.all([
        moo.facts.match({ ref: c.facts, ...{ graph: c.graph, subject: stepId, predicate: "agent:payload", limit: 1 } }),
        row["?kind"] === "agent:Subagent"
          ? moo.facts.match({ ref: c.facts, ...{ graph: c.graph, subject: stepId, predicate: "agent:result", limit: 1 } })
          : Promise.resolve([]),
      ]);
      return { row, stepId, payload, result };
    }),
  );

  const objectByHash = new Map<string, { kind: string; value: any } | null>();
  const wantedHashes = new Set<string>();
  for (const meta of stepMetaRows) {
    const payload = meta.payload[0]?.[3];
    if (payload) wantedHashes.add(payload);
    const result = meta.result[0]?.[3];
    if (result) wantedHashes.add(result);
  }
  for (const h of wantedHashes) objectByHash.set(h, await moo.objects.getJSON({ hash: h }));
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
    moo.refs.get(c.head),
    moo.refs.get(`chat/${chatId}/title`),
    moo.refs.get(`chat/${chatId}/path`),
    moo.refs.get(`chat/${chatId}/created-at`),
    moo.refs.get(`chat/${chatId}/last-at`),
    moo.refs.get(`chat/${chatId}/hidden`),
    moo.refs.get(`chat/${chatId}/parent`),
  ]);
  const normalizedPath = path ? String(path).replace(/\/+$/, "") || "." : null;
  const expectedWorktreePath = normalizedPath ? normalizedPath + "/.moo/" + chatId : null;
  const worktreePath = expectedWorktreePath && await moo.fs.exists(expectedWorktreePath) ? expectedWorktreePath : null;
  const totalFacts = await moo.facts.count({ ref: c.facts });

  const steps = await moo.facts.matchAll({ patterns: [
      ["?step", "rdf:type", "agent:Step"],
      ["?step", "agent:kind", "?kind"],
      ["?step", "agent:status", "?status"],
      ["?step", "agent:createdAt", "?at"],
    ], ...{ ref: c.facts, graph: c.graph } });
  const totalTurns = steps.filter((s) => s["?kind"] === "agent:UserInput").length;
  const totalSteps = steps.length;
  const totalCodeCalls = steps.filter((s) => s["?kind"] === "agent:RunJS").length;

  const inputs = await moo.facts.matchAll({ patterns: [
      ["?req", "rdf:type", "ui:InputRequest"],
      ["?req", "ui:kind", "?kind"],
      ["?req", "ui:status", "?status"],
      ["?req", "ui:createdAt", "?at"],
    ], ...{ ref: c.facts, graph: c.graph } });

  const inputResponses = await moo.facts.matchAll({ patterns: [
      ["?resp", "rdf:type", "ui:InputResponse"],
      ["?resp", "ui:respondsTo", "?req"],
      ["?resp", "ui:createdAt", "?at"],
    ], ...{ ref: c.facts, graph: c.graph } });

  const logs = await moo.facts.matchAll({ patterns: [
      ["?log", "rdf:type", "agent:Log"],
      ["?log", "agent:createdAt", "?at"],
      ["?log", "agent:message", "?message"],
    ], ...{ ref: c.facts, graph: c.graph } });

  const trailEntries = await moo.facts.matchAll({ patterns: [
      ["?entry", "rdf:type", "agent:TrailEntry"],
      ["?entry", "agent:kind", "?kind"],
      ["?entry", "agent:createdAt", "?at"],
    ], ...{ ref: c.facts, graph: c.graph } });

  // Loading a long chat should not require formatting every historical step
  // and resolving every historical object payload. When the UI passes a
  // positive limit, return only the newest N timeline entries while still
  // reporting the full counters above. The older entries can be requested by
  // raising/removing the limit.
  const rawLimit = Number(input.limit ?? input.timelineLimit ?? 0);
  const timelineLimit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.max(1, Math.min(10_000, Math.floor(rawLimit)))
      : 0;
  // Older compaction implementations only advanced chat/<id>/compaction
  // and did not append an agent:Compaction step, which made automatic
  // compactions invisible in the timeline. Include those compaction-chain
  // layers as synthetic timeline rows, but do not duplicate layers that
  // already have a real step payload.
  const compactionLayers = await readCompactionChain(chatId);
  const compactionStepPayloadHashes = new Set<string>();
  await Promise.all(
    steps
      .filter((row) => row["?kind"] === "agent:Compaction")
      .map(async (row) => {
        const stepId = row["?step"];
        if (!stepId) return;
        const payload = await moo.facts.match({ ref: c.facts, ...{
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
  const totalTimelineItems = timelineRefs.length;
  const visibleRefs =
    timelineLimit > 0 && totalTimelineItems > timelineLimit
      ? timelineRefs.slice(totalTimelineItems - timelineLimit)
      : timelineRefs;
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
  const allTrailItems = await loadTrailItems(c, trailEntries);
  const allTrailTimelineItems = [...allTrailItems, ...await loadTrailStepItems(c, chatId, steps)].sort(compareTimelineItems);

  // Fetch per-step metadata only for the visible window. Predicate-only
  // scans still walk every historical payload/result row in very long chats;
  // during agent thinking, each fact write can request another describe. Bound
  // the work to the requested timeline page so one refresh cannot monopolize a
  // worker and leave the UI stuck on "agent thinking…" while loading.
  const stepMetaRows = await Promise.all(
    [...visibleStepIds].map(async (stepId) => {
      const [payload, result, model, effort, deletedAt] = await Promise.all([
        moo.facts.match({ ref: c.facts, ...{ graph: c.graph, subject: stepId, predicate: "agent:payload", limit: 1 } }),
        moo.facts.match({ ref: c.facts, ...{ graph: c.graph, subject: stepId, predicate: "agent:result", limit: 1 } }),
        moo.facts.match({ ref: c.facts, ...{ graph: c.graph, subject: stepId, predicate: "agent:model", limit: 1 } }),
        moo.facts.match({ ref: c.facts, ...{ graph: c.graph, subject: stepId, predicate: "agent:effort", limit: 1 } }),
        moo.facts.match({ ref: c.facts, ...{ graph: c.graph, subject: stepId, predicate: "agent:deletedAt", limit: 1 } }),
      ]);
      return { stepId, payload, result, model, effort, deletedAt };
    }),
  );
  const payloadHashByStep = new Map<string, string>();
  const resultHashByStep = new Map<string, string>();
  const modelByStep = new Map<string, string>();
  const effortByStep = new Map<string, string>();
  const deletedAtByStep = new Map<string, string>();
  for (const row of stepMetaRows) {
    const payload = row.payload[0]?.[3];
    if (payload) payloadHashByStep.set(row.stepId, payload);
    const result = row.result[0]?.[3];
    if (result) resultHashByStep.set(row.stepId, result);
    const model = row.model[0]?.[3];
    if (model) modelByStep.set(row.stepId, model);
    const effort = row.effort[0]?.[3];
    if (effort) effortByStep.set(row.stepId, effort);
    const deletedAt = row.deletedAt[0]?.[3];
    if (deletedAt) deletedAtByStep.set(row.stepId, deletedAt);
  }

  // Dedupe object hashes — same payload referenced twice (rare) costs one
  // lookup. Resolution still goes through __op_object_get one at a time
  // since it's a sync host op.
  const wantedHashes = new Set<string>();
  for (const h of payloadHashByStep.values()) wantedHashes.add(h);
  for (const h of resultHashByStep.values()) wantedHashes.add(h);
  const objectByHash = new Map<string, { kind: string; value: any } | null>();
  for (const h of wantedHashes) objectByHash.set(h, await moo.objects.getJSON({ hash: h }));

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
        refName: payload.value.refName,
        graph: payload.value.graph,
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
      const payload = await moo.facts.match({ ref: c.facts, ...{
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
  for (const h of uiHashes) {
    if (!objectByHash.has(h)) objectByHash.set(h, await moo.objects.getJSON({ hash: h }));
  }
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
  // prompt_tokens from the most recent call — accurate (counts tool schemas,
  // images, attachments) and cheap (single ref read) compared to rebuilding
  // and re-estimating the whole prompt on every describe.
  const modelInfo = await chatModelInfo(chatId);
  const lastPromptTokens = await readLastPromptTokens(chatId);
  const budget = await contextBudget({ name: modelInfo.provider, model: modelInfo.effectiveModel });
  const threshold = Math.floor(budget * COMPACT_FRACTION);
  const used = lastPromptTokens ?? 0;
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
      trail: allTrailTimelineItems,
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

