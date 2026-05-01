import { moo } from "../moo";
import { chatRefs } from "../lib";
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

export function cleanUiId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const v = id.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(v) ? v : null;
}

export function nowIso(ms: number): string {
  return new Date(ms).toISOString();
}

export async function uiManifest(uiId: string): Promise<UiManifest | null> {
  const hash = await moo.refs.get(`ui/${uiId}/manifest`);
  if (!hash) return null;
  const row = await moo.objects.getJSON<UiManifest>({ hash: hash });
  return row?.value ?? null;
}

export async function uiBundle(uiId: string): Promise<UiBundle | null> {
  const hash = await moo.refs.get(`ui/${uiId}/bundle`);
  if (!hash) return null;
  const row = await moo.objects.getJSON<UiBundle>({ hash: hash });
  return row?.value ?? null;
}

export async function listUiIds(): Promise<string[]> {
  const refs = await moo.refs.list("ui/");
  const ids = new Set<string>();
  for (const r of refs) {
    const m = /^ui\/([^/]+)\/manifest$/.exec(r);
    if (m) ids.add(m[1]!);
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
  const now = await moo.time.nowMs();
  await moo.refs.set(`ui/${id}/manifest`, manifestHash);
  await moo.refs.set(`ui/${id}/bundle`, bundleHash);
  let handlerHash: string | null = null;
  if (input.handler != null) {
    handlerHash = await moo.objects.putText({ kind: "ui:Handler", text: String(input.handler) });
    await moo.refs.set(`ui/${id}/handler`, handlerHash);
  }
  await moo.memory.assert({ facts: [
    [`ui:${id}`, "rdf:type", "ui:App"],
    [`ui:${id}`, "ui:title", title],
    ...(manifest.description ? [[`ui:${id}`, "ui:description", String(manifest.description)] as [string, string, string]] : []),
    [`ui:${id}`, "ui:manifest", manifestHash],
    [`ui:${id}`, "ui:bundle", bundleHash],
    ...(handlerHash ? [[`ui:${id}`, "ui:handler", handlerHash] as [string, string, string]] : []),
    [`ui:${id}`, "ui:updatedAt", moo.term.datetime(nowIso(now))],
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
  const refNames = await moo.refs.list(`ui/${id}/`);
  const existed = refNames.length > 0 || !!(await uiManifest(id));
  for (const ref of refNames) await moo.refs.delete(ref);

  const subject = `ui:${id}`;
  const rows = await moo.facts.match({ ref: UI_REF, ...{ graph: UI_GRAPH, subject } });
  for (const row of rows) await moo.facts.remove({ ref: UI_REF, graph: row[0], subject: row[1], predicate: row[2], object: row[3] });
  return { ok: true, value: { uiId: id, removed: existed, refsDeleted: refNames.length, factsRemoved: rows.length } };
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
  const c = chatRefs(chatId);
  const rows = await moo.facts.match({ ref: c.facts, ...{ graph: c.graph, predicate: "ui:involves" } });
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
  ], ...{ ref: c.facts, graph: c.graph } });
  for (const r of instRows) {
    const instanceId = r["?inst"]!.replace(/^uiinst:/, "");
    instances.push({ instanceId, uiId: r["?app"]!.replace(/^ui:/, "") });
  }
  const primaryRows = await moo.facts.match({ ref: c.facts, ...{ graph: c.graph, subject: `chat:${chatId}`, predicate: "ui:primary", limit: 1 } });
  return { ok: true, value: { chatId, apps, instances, primaryUiId: primaryRows[0]?.[3]?.replace(/^ui:/, "") ?? null } };
}

export async function uiOpenCommand(input: Input) {
  const chatId = input.chatId || "demo";
  const uiId = cleanUiId(input.uiId ?? input.id);
  if (!uiId) return { ok: false, error: { message: "ui-open requires uiId" } };
  if (!(await uiManifest(uiId))) return { ok: false, error: { message: `ui not found: ${uiId}` } };
  const c = chatRefs(chatId);
  let instanceId = typeof input.instanceId === "string" && input.instanceId.trim() ? input.instanceId.trim() : null;
  if (!instanceId) {
    const existing = await moo.facts.matchAll({ patterns: [
      ["?inst", "rdf:type", "ui:Instance"],
      ["?inst", "ui:app", `ui:${uiId}`],
    ], ...{ ref: c.facts, graph: c.graph, limit: 1 } });
    instanceId = existing[0]?.["?inst"]?.replace(/^uiinst:/, "") ?? await moo.id.new("uiinst");
  }
  const inst = `uiinst:${instanceId}`;
  await moo.facts.update({ ref: c.facts, fn: (txn) => {
    txn.add({ graph: c.graph, subject: `chat:${chatId}`, predicate: "ui:involves", object: `ui:${uiId}` });
    txn.add({ graph: c.graph, subject: `chat:${chatId}`, predicate: "ui:primary", object: `ui:${uiId}` });
    txn.add({ graph: c.graph, subject: inst, predicate: "rdf:type", object: "ui:Instance" });
    txn.add({ graph: c.graph, subject: inst, predicate: "ui:app", object: `ui:${uiId}` });
    txn.add({ graph: c.graph, subject: inst, predicate: "ui:chat", object: `chat:${chatId}` });
    txn.add({ graph: c.graph, subject: inst, predicate: "ui:stateRef", object: `ref:uiinst/${instanceId}/state` });
  } });
  if (!(await moo.refs.get(`uiinst/${instanceId}/state`))) {
    const stateHash = await moo.objects.putJSON({ kind: "ui:State", value: input.state ?? {} });
    await moo.refs.set(`uiinst/${instanceId}/state`, stateHash);
  }
  return { ok: true, value: { chatId, uiId, instanceId } };
}

export async function uiCloseCommand(input: Input) {
  const chatId = input.chatId || "demo";
  const uiId = cleanUiId(input.uiId ?? input.id);
  if (!uiId) return { ok: false, error: { message: "ui-close requires uiId" } };
  const instanceId = typeof input.instanceId === "string" && input.instanceId.trim()
    ? input.instanceId.trim().replace(/^uiinst:/, "")
    : null;
  const c = chatRefs(chatId);
  await moo.facts.update({ ref: c.facts, fn: (txn) => {
    txn.remove({ graph: c.graph, subject: `chat:${chatId}`, predicate: "ui:primary", object: `ui:${uiId}` });
  } });
  return { ok: true, value: { chatId, uiId, instanceId } };
}

export async function uiStateGetCommand(input: Input) {
  const instanceId = String(input.instanceId ?? "").replace(/^uiinst:/, "");
  if (!instanceId) return { ok: false, error: { message: "ui-state-get requires instanceId" } };
  const hash = await moo.refs.get(`uiinst/${instanceId}/state`);
  if (!hash) return { ok: true, value: { instanceId, state: {}, hash: null } };
  const row = await moo.objects.getJSON<any>({ hash: hash });
  return { ok: true, value: { instanceId, state: row?.value ?? {}, hash } };
}

export async function uiStateSetCommand(input: Input) {
  const instanceId = String(input.instanceId ?? "").replace(/^uiinst:/, "");
  if (!instanceId) return { ok: false, error: { message: "ui-state-set requires instanceId" } };
  const state = input.state ?? {};
  const hash = await moo.objects.putJSON({ kind: "ui:State", value: state });
  await moo.refs.set(`uiinst/${instanceId}/state`, hash);
  return { ok: true, value: { instanceId, state, hash } };
}

export async function uiCallCommand(input: Input) {
  const uiId = cleanUiId(input.uiId ?? input.id);
  if (!uiId) return { ok: false, error: { message: "ui-call requires uiId" } };
  const handlerHash = await moo.refs.get(`ui/${uiId}/handler`);
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

