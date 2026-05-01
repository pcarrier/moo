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

export async function describeCommand(input: Input) {
  const chatId = input.chatId || "demo";
  const c = chatRefs(chatId);
  const head = await moo.refs.get(c.head);
  const totalFacts = await moo.facts.count(c.facts);

  const steps = await moo.facts.matchAll(
    [
      ["?step", "rdf:type", "agent:Step"],
      ["?step", "agent:kind", "?kind"],
      ["?step", "agent:status", "?status"],
      ["?step", "agent:createdAt", "?at"],
    ],
    { ref: c.facts, graph: c.graph },
  );
  const totalTurns = steps.filter((s) => s["?kind"] === "agent:UserInput").length;
  const totalSteps = steps.length;
  const totalCodeCalls = steps.filter((s) => s["?kind"] === "agent:RunJS").length;

  const inputs = await moo.facts.matchAll(
    [
      ["?req", "rdf:type", "ui:InputRequest"],
      ["?req", "ui:kind", "?kind"],
      ["?req", "ui:status", "?status"],
      ["?req", "ui:createdAt", "?at"],
    ],
    { ref: c.facts, graph: c.graph },
  );

  const logs = await moo.facts.matchAll(
    [
      ["?log", "rdf:type", "agent:Log"],
      ["?log", "agent:createdAt", "?at"],
      ["?log", "agent:message", "?message"],
    ],
    { ref: c.facts, graph: c.graph },
  );

  const trailEntries = await moo.facts.matchAll(
    [
      ["?entry", "rdf:type", "agent:TrailEntry"],
      ["?entry", "agent:kind", "?kind"],
      ["?entry", "agent:createdAt", "?at"],
    ],
    { ref: c.facts, graph: c.graph },
  );

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
        const payload = await moo.facts.match(c.facts, {
          graph: c.graph,
          subject: stepId,
          predicate: "agent:payload",
          limit: 1,
        });
        const hash = payload[0]?.[3];
        if (hash) compactionStepPayloadHashes.add(hash);
      }),
  );
  const syntheticCompactions = compactionLayers
    .filter((layer) => !compactionStepPayloadHashes.has(layer.hash))
    .map((layer) => ({
      type: "compaction" as const,
      id: layer.hash,
      at: Number(layer.at || layer.throughAt) || 0,
      layer,
    }));

  const timelineRefs = [
    ...steps.map((row) => ({ type: "step" as const, id: row["?step"]!, at: Number(row["?at"]) || 0 })),
    ...inputs.map((row) => ({ type: "input" as const, id: row["?req"]!, at: Number(row["?at"]) || 0 })),
    ...logs.map((row) => ({ type: "log" as const, id: row["?log"]!, at: Number(row["?at"]) || 0 })),
    ...trailEntries.map((row) => ({ type: "trail" as const, id: row["?entry"]!, at: Number(row["?at"]) || 0 })),
    ...syntheticCompactions,
  ].sort((a, b) => a.at - b.at);
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
  const visibleLogs = logs.filter((r) => visibleLogIds.has(r["?log"]!));
  const visibleTrailEntries = trailEntries.filter((r) => visibleTrailIds.has(r["?entry"]!));

  // Fetch per-step metadata only for the visible window. Predicate-only
  // scans still walk every historical payload/result row in very long chats;
  // during agent thinking, each fact write can request another describe. Bound
  // the work to the requested timeline page so one refresh cannot monopolize a
  // worker and leave the UI stuck on "agent thinking…" while loading.
  const stepMetaRows = await Promise.all(
    [...visibleStepIds].map(async (stepId) => {
      const [payload, result, model, effort, deletedAt] = await Promise.all([
        moo.facts.match(c.facts, { graph: c.graph, subject: stepId, predicate: "agent:payload", limit: 1 }),
        moo.facts.match(c.facts, { graph: c.graph, subject: stepId, predicate: "agent:result", limit: 1 }),
        moo.facts.match(c.facts, { graph: c.graph, subject: stepId, predicate: "agent:model", limit: 1 }),
        moo.facts.match(c.facts, { graph: c.graph, subject: stepId, predicate: "agent:effort", limit: 1 }),
        moo.facts.match(c.facts, { graph: c.graph, subject: stepId, predicate: "agent:deletedAt", limit: 1 }),
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
  for (const h of wantedHashes) objectByHash.set(h, await moo.objects.getJSON(h));

  const lookupPayload = (stepId: string) => {
    const h = payloadHashByStep.get(stepId);
    return h ? objectByHash.get(h) ?? null : null;
  };
  const lookupResult = (stepId: string) => {
    const h = resultHashByStep.get(stepId);
    return h ? objectByHash.get(h) ?? null : null;
  };

  const timeline: any[] = [];
  for (const s of visibleSteps) {
    const stepId = s["?step"]!;
    const item: any = {
      type: "step",
      step: stepId,
      kind: s["?kind"],
      status: s["?status"],
      at: Number(s["?at"]),
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
      timeline.push({
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
        at: Number(s["?at"]),
      });
      continue;
    }
    item.text = formatStep(item, payload, result);
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
    timeline.push(item);
  }

  // Same bounded lookup pattern for UI requests/responses: only inspect the
  // visible requests and their response subjects instead of scanning every
  // historical ui:payload/ui:respondsTo row on each refresh.
  const inputMetaRows = await Promise.all(
    [...visibleInputIds].map(async (reqId) => {
      const [payload, responses] = await Promise.all([
        moo.facts.match(c.facts, { graph: c.graph, subject: reqId, predicate: "ui:payload", limit: 1 }),
        moo.facts.match(c.facts, { graph: c.graph, predicate: "ui:respondsTo", object: reqId, limit: 1 }),
      ]);
      return { reqId, payload, responses };
    }),
  );
  const responderByRequest = new Map<string, string>();
  const visibleResponseIds = new Set<string>();
  const uiPayloadHashBySubject = new Map<string, string>();
  for (const row of inputMetaRows) {
    const reqPayload = row.payload[0]?.[3];
    if (reqPayload) uiPayloadHashBySubject.set(row.reqId, reqPayload);
    const respId = row.responses[0]?.[1];
    if (respId) {
      responderByRequest.set(row.reqId, respId);
      visibleResponseIds.add(respId);
    }
  }
  await Promise.all(
    [...visibleResponseIds].map(async (respId) => {
      const payload = await moo.facts.match(c.facts, {
        graph: c.graph,
        subject: respId,
        predicate: "ui:payload",
        limit: 1,
      });
      const hash = payload[0]?.[3];
      if (hash) uiPayloadHashBySubject.set(respId, hash);
    }),
  );
  const uiHashes = new Set<string>(uiPayloadHashBySubject.values());
  for (const h of uiHashes) {
    if (!objectByHash.has(h)) objectByHash.set(h, await moo.objects.getJSON(h));
  }
  const lookupUiPayload = (subject: string) => {
    const h = uiPayloadHashBySubject.get(subject);
    return h ? objectByHash.get(h) ?? null : null;
  };
  for (const r of visibleLogs) {
    timeline.push({
      type: "log",
      id: r["?log"],
      at: Number(r["?at"]),
      message: r["?message"] || "",
    });
  }

  const trailPayloadHashByEntry = new Map<string, string>();
  await Promise.all(
    [...visibleTrailIds].map(async (entryId) => {
      const payload = await moo.facts.match(c.facts, {
        graph: c.graph,
        subject: entryId,
        predicate: "agent:payload",
        limit: 1,
      });
      const hash = payload[0]?.[3];
      if (hash) trailPayloadHashByEntry.set(entryId, hash);
    }),
  );
  for (const h of trailPayloadHashByEntry.values()) {
    if (!objectByHash.has(h)) objectByHash.set(h, await moo.objects.getJSON(h));
  }
  const lookupTrailPayload = (entryId: string) => {
    const h = trailPayloadHashByEntry.get(entryId);
    return h ? objectByHash.get(h) ?? null : null;
  };
  for (const r of visibleTrailEntries) {
    const entryId = r["?entry"]!;
    const payload = lookupTrailPayload(entryId);
    const value = payload?.value || {};
    timeline.push({
      type: "trail",
      id: entryId,
      kind: r["?kind"] || payload?.kind || "agent:Summary",
      at: Number(r["?at"]) || Number(value.at) || 0,
      title: value.title ?? null,
      previousTitle: value.previousTitle ?? null,
      body: value.body ?? value.summary ?? null,
      summary: value.summary ?? null,
    });
  }

  for (const layer of visibleCompactions) {
    const trigger =
      layer.trigger === "automatic"
        ? "automatic "
        : layer.trigger === "manual"
          ? "manual "
          : "";
    timeline.push({
      type: "step",
      step: `compaction:${layer.hash}`,
      kind: "agent:Compaction",
      status: "agent:Done",
      at: Number(layer.at || layer.throughAt) || 0,
      text: `${trigger}compaction\n${layer.summary || ""}`,
    });
  }

  for (const r of visibleInputs) {
    const reqId = r["?req"]!;
    const spec = lookupUiPayload(reqId);
    let response: { values: Record<string, unknown>; at: number; cancelled?: boolean } | null = null;
    if (r["?status"] === "ui:Done" || r["?status"] === "ui:Cancelled") {
      const respId = responderByRequest.get(reqId);
      if (respId) {
        const payload = lookupUiPayload(respId);
        if (payload?.value) {
          response = {
            values: payload.value.values || {},
            at: Number(payload.value.at) || 0,
            ...(payload.value.cancelled ? { cancelled: true } : {}),
          };
        }
      }
    }
    timeline.push({
      type: "input",
      requestId: reqId,
      kind: r["?kind"],
      status: r["?status"],
      at: Number(r["?at"]),
      spec: spec?.value || null,
      response,
    });
  }
  timeline.sort((a, b) => a.at - b.at);

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
      head,
      totalFacts,
      totalTurns,
      totalSteps,
      totalCodeCalls,
      timeline,
      tokens,
      totalTimelineItems,
      hiddenTimelineItems,
      timelineLimit,
    },
  };
}

export type ModelPrice = { input: number; cachedInput: number; output: number };

// USD per million tokens. Cache lookups are subset matched (substring):
// `gpt-5.5` matches both `gpt-5.5` and `gpt-5.5-2026-01`. Override or extend
// via MOO_LLM_PRICING (JSON: {"<model-substring>": {input,cachedInput,output}}).
const DEFAULT_MODEL_PRICING: Record<string, ModelPrice> = {
  "gpt-5.5": { input: 2.5, cachedInput: 0.25, output: 10 },
  "gpt-5": { input: 2.5, cachedInput: 0.25, output: 10 },
  "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },
  "qwen3.6": { input: 0.4, cachedInput: 0.04, output: 1.2 },
  "qwen": { input: 0.4, cachedInput: 0.04, output: 1.2 },
};

export function validPrice(v: unknown): v is ModelPrice {
  const r = v as Partial<ModelPrice> | null;
  return !!r &&
    Number.isFinite(r.input) && r.input >= 0 &&
    Number.isFinite(r.cachedInput) && r.cachedInput >= 0 &&
    Number.isFinite(r.output) && r.output >= 0;
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
  usage: { models: Record<string, { input: number; cachedInput: number; output: number }> } | null,
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
        counts.output * rate.output) /
      1_000_000;
  }
  return { costUsd: total, unpricedModels };
}

