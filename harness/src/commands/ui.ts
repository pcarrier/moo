import { moo } from "../moo";
import { chatRefs, decodeJsonPointer, encodeJsonPointer } from "../lib";
import type { Input } from "./_shared";

export type UiBundle = {
  html?: string;
  css?: string;
  js?: string;
  files?: Record<string, string>;
};

export type UiManifest = {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  entry?: string;
  api?: Array<{ name: string; input?: unknown }>;
};

export const UI_GRAPH = "memory:facts";
export const UI_REF = "memory/facts";

function readUiStateTarget(target: string | null): { state: unknown; target: string | null } {
  if (!target) return { state: {}, target: null };
  const inline = decodeJsonPointer(target);
  return { state: target.startsWith("json:") ? (inline ?? {}) : {}, target };
}

export function cleanUiId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const trimmedId = id.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(trimmedId) ? trimmedId : null;
}

export function nowIso(ms: number): string {
  return new Date(ms).toISOString();
}

export async function uiManifest(uiId: string): Promise<UiManifest | null> {
  const hash = await moo.pointers.get({ name: `ui/${uiId}/manifest` });
  if (!hash) return null;
  const row = await moo.objects.getJSON<UiManifest>({ hash: hash });
  return row?.value ?? null;
}

export async function uiBundle(uiId: string): Promise<UiBundle | null> {
  const hash = await moo.pointers.get({ name: `ui/${uiId}/bundle` });
  if (!hash) return null;
  const row = await moo.objects.getJSON<UiBundle>({ hash: hash });
  return row?.value ?? null;
}

export async function listUiIds(): Promise<string[]> {
  const refs = await moo.pointers.list({ prefix: "ui/" });
  const ids = new Set<string>();
  for (const pointerName of refs) {
    const match = /^ui\/([^/]+)\/manifest$/.exec(pointerName);
    if (match) ids.add(match[1]!);
  }
  return [...ids].sort();
}

export async function uiRegisterCommand(input: Input) {
  const id = cleanUiId(input.id ?? input.manifest?.id);
  if (!id) return { ok: false, error: { message: "ui-register requires id matching [a-zA-Z0-9_.-]+" } };
  const title = String(input.title ?? input.manifest?.title ?? id).trim();
  const manifest: UiManifest = {
    ...(input.manifest || {}),
    id,
    title,
    description: input.description ?? input.manifest?.description ?? "",
    icon: input.icon ?? input.manifest?.icon ?? "▣",
    entry: input.entry ?? input.manifest?.entry ?? "index.html",
    api: input.api ?? input.manifest?.api ?? [],
  };
  const bundle: UiBundle = input.bundle ?? {
    html: input.html ?? "<main><h1>" + title + "</h1></main>",
    css: input.css ?? "",
    js: input.js ?? "",
  };
  const manifestHash = await moo.objects.putJSON({ kind: "ui:Manifest", value: manifest });
  const bundleHash = await moo.objects.putJSON({ kind: "ui:Bundle", value: bundle });
  const now = await moo.time.nowMs({});
  await moo.pointers.set({ name: `ui/${id}/manifest`, target: manifestHash });
  await moo.pointers.set({ name: `ui/${id}/bundle`, target: bundleHash });
  let handlerHash: string | null = null;
  if (input.handler != null) {
    handlerHash = await moo.objects.putText({ kind: "ui:Handler", text: String(input.handler) });
    await moo.pointers.set({ name: `ui/${id}/handler`, target: handlerHash });
  }
  await moo.memory.assert({ facts: [
    [`ui:${id}`, "rdf:type", "ui:App"],
    [`ui:${id}`, "ui:title", title],
    ...(manifest.description ? [[`ui:${id}`, "ui:description", String(manifest.description)] as [string, string, string]] : []),
    [`ui:${id}`, "ui:manifest", manifestHash],
    [`ui:${id}`, "ui:bundle", bundleHash],
    ...(handlerHash ? [[`ui:${id}`, "ui:handler", handlerHash] as [string, string, string]] : []),
    [`ui:${id}`, "ui:updatedAt", moo.term.datetime({ d: nowIso(now) })],
  ] });
  return { ok: true, value: { ui: manifest, manifestHash, bundleHash, handlerHash } };
}

export async function uiListCommand(_input: Input) {
  const apps: UiManifest[] = [];
  for (const id of await listUiIds()) {
    const m = await uiManifest(id);
    if (m) apps.push(m);
  }
  return { ok: true, value: { apps } };
}

export async function uiRemoveCommand(input: Input) {
  const id = cleanUiId(input.uiId ?? input.id);
  if (!id) return { ok: false, error: { message: "ui-remove requires uiId" } };
  const pointerNames = await moo.pointers.list({ prefix: `ui/${id}/` });
  const existed = pointerNames.length > 0 || !!(await uiManifest(id));
  for (const name of pointerNames) await moo.pointers.delete({ name: name });

  const subject = `ui:${id}`;
  const rows = await moo.facts.match({ store: UI_REF, ...{ graph: UI_GRAPH, subject } });
  for (const row of rows) await moo.facts.remove({ store: UI_REF, graph: row[0], subject: row[1], predicate: row[2], object: row[3] });
  return { ok: true, value: { uiId: id, removed: existed, pointersDeleted: pointerNames.length, factsRemoved: rows.length } };
}

export async function uiBundleCommand(input: Input) {
  const id = cleanUiId(input.uiId ?? input.id);
  if (!id) return { ok: false, error: { message: "ui-bundle requires uiId" } };
  const manifest = await uiManifest(id);
  const bundle = await uiBundle(id);
  if (!manifest || !bundle) return { ok: false, error: { message: `ui not found: ${id}` } };
  return { ok: true, value: { manifest, bundle } };
}

export async function uiChatCommand(input: Input) {
  const chatId = input.chatId || "demo";
  const refs = chatRefs(chatId);
  const rows = await moo.facts.match({ store: refs.facts, ...{ graph: refs.graph, predicate: "ui:involves" } });
  const ids = [...new Set(rows.map((r) => String(r[3]).replace(/^ui:/, "")))];
  const apps: UiManifest[] = [];
  for (const id of ids) {
    const m = await uiManifest(id);
    if (m) apps.push(m);
  }
  const instances: any[] = [];
  const instRows = await moo.facts.matchAll({ patterns: [
    ["?inst", "rdf:type", "ui:Instance"],
    ["?inst", "ui:app", "?app"],
  ], ...{ store: refs.facts, graph: refs.graph } });
  for (const instanceRow of instRows) {
    const instanceId = instanceRow["?inst"]!.replace(/^uiinst:/, "");
    instances.push({ instanceId, uiId: instanceRow["?app"]!.replace(/^ui:/, "") });
  }
  const primaryRows = await moo.facts.match({ store: refs.facts, ...{ graph: refs.graph, subject: `chat:${chatId}`, predicate: "ui:primary", limit: 1 } });
  return { ok: true, value: { chatId, apps, instances, primaryUiId: primaryRows[0]?.[3]?.replace(/^ui:/, "") ?? null } };
}

export async function uiOpenCommand(input: Input) {
  const chatId = input.chatId || "demo";
  const uiId = cleanUiId(input.uiId ?? input.id);
  if (!uiId) return { ok: false, error: { message: "ui-open requires uiId" } };
  if (!(await uiManifest(uiId))) return { ok: false, error: { message: `ui not found: ${uiId}` } };
  const refs = chatRefs(chatId);
  let instanceId = typeof input.instanceId === "string" && input.instanceId.trim() ? input.instanceId.trim() : null;
  if (!instanceId) {
    const existing = await moo.facts.matchAll({ patterns: [
      ["?inst", "rdf:type", "ui:Instance"],
      ["?inst", "ui:app", `ui:${uiId}`],
    ], ...{ store: refs.facts, graph: refs.graph, limit: 1 } });
    instanceId = existing[0]?.["?inst"]?.replace(/^uiinst:/, "") ?? (await moo.id.new({ prefix: "uiinst" }));
  }
  const inst = `uiinst:${instanceId}`;
  const primaryRows = await moo.facts.match({
    store: refs.facts,
    graph: refs.graph,
    subject: `chat:${chatId}`,
    predicate: "ui:primary",
  });
  await moo.facts.update({ store: refs.facts, fn: (txn) => {
    for (const [graph, subject, predicate, object] of primaryRows) {
      txn.remove({ graph, subject, predicate, object });
    }
    txn.add({ graph: refs.graph, subject: `chat:${chatId}`, predicate: "ui:involves", object: `ui:${uiId}` });
    txn.add({ graph: refs.graph, subject: `chat:${chatId}`, predicate: "ui:primary", object: `ui:${uiId}` });
    txn.add({ graph: refs.graph, subject: inst, predicate: "rdf:type", object: "ui:Instance" });
    txn.add({ graph: refs.graph, subject: inst, predicate: "ui:app", object: `ui:${uiId}` });
    txn.add({ graph: refs.graph, subject: inst, predicate: "ui:chat", object: `chat:${chatId}` });
    txn.add({ graph: refs.graph, subject: inst, predicate: "ui:statePointer", object: `pointer:uiinst/${instanceId}/state` });
  } });
  const stateRef = `uiinst/${instanceId}/state`;
  let stateTarget = await moo.pointers.get({ name: stateRef });
  if (!stateTarget) {
    stateTarget = encodeJsonPointer(input.state ?? {});
    await moo.pointers.set({ name: stateRef, target: stateTarget });
  }
  moo.events.publish({ payload: { kind: "ui-open", chatId, uiId, instanceId, stateRef, stateTarget, at: await moo.time.nowMs({}) } });
  return { ok: true, value: { chatId, uiId, instanceId } };
}

export async function uiCloseCommand(input: Input) {
  const chatId = input.chatId || "demo";
  const uiId = cleanUiId(input.uiId ?? input.id);
  if (!uiId) return { ok: false, error: { message: "ui-close requires uiId" } };
  const instanceId = typeof input.instanceId === "string" && input.instanceId.trim()
    ? input.instanceId.trim().replace(/^uiinst:/, "")
    : null;
  const refs = chatRefs(chatId);
  await moo.facts.update({ store: refs.facts, fn: (txn) => {
    txn.remove({ graph: refs.graph, subject: `chat:${chatId}`, predicate: "ui:primary", object: `ui:${uiId}` });
  } });
  return { ok: true, value: { chatId, uiId, instanceId } };
}

export async function uiStateGetCommand(input: Input) {
  const instanceId = String(input.instanceId ?? "").replace(/^uiinst:/, "");
  if (!instanceId) return { ok: false, error: { message: "ui-state-get requires instanceId" } };
  const state = readUiStateTarget(await moo.pointers.get({ name: `uiinst/${instanceId}/state` }));
  return { ok: true, value: { instanceId, state: state.state, target: state.target } };
}

export async function uiStateSetCommand(input: Input) {
  const instanceId = String(input.instanceId ?? "").replace(/^uiinst:/, "");
  if (!instanceId) return { ok: false, error: { message: "ui-state-set requires instanceId" } };
  const state = input.state ?? {};
  const target = encodeJsonPointer(state);
  await moo.pointers.set({ name: `uiinst/${instanceId}/state`, target });
  return { ok: true, value: { instanceId, state, target } };
}

export async function uiCallCommand(input: Input) {
  const uiId = cleanUiId(input.uiId ?? input.id);
  if (!uiId) return { ok: false, error: { message: "ui-call requires uiId" } };
  const handlerHash = await moo.pointers.get({ name: `ui/${uiId}/handler` });
  if (!handlerHash) return { ok: false, error: { message: `ui has no handler: ${uiId}` } };
  const row = await moo.objects.getText({ hash: handlerHash });
  if (!row) return { ok: false, error: { message: `handler not found: ${handlerHash}` } };
  const context = { uiId, chatId: input.chatId ?? null, instanceId: input.instanceId ?? null };
  const request = { command: input.name ?? input.commandName, input: input.input ?? {}, context };
  try {
    const fn = new Function("moo", "request", "context", `return (async () => {\n${row.text}\n})()`);
    const value = await fn(moo, request, context);
    return { ok: true, value };
  } catch (err: any) {
    return { ok: false, error: { message: err?.message ?? String(err), stack: err?.stack } };
  }
}

