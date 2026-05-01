import { moo } from "../moo";
import { chatRefs } from "../lib";
import type { Input } from "./_shared";
import { applyLastChatSettings, rememberChatEffort, rememberChatModel, setChatEffort, setChatModel } from "./models";
import { estimateCostUsd, loadPricing } from "./describe";


export type ChatAutocompleteSuggestion = {
  chatId: string;
  chatTitle: string | null;
  step: string;
  at: number;
  text: string;
};

function normalizeAutocompleteText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function autocompleteMatches(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

function autocompleteRank(text: string, query: string): number {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return 0;
  if (haystack === needle) return 4;
  if (haystack.startsWith(needle)) return 3;
  if (haystack.includes(needle)) return 2;
  return 1;
}

export async function chatAutocompleteCommand(input: Input) {
  const query = normalizeAutocompleteText(input.query);
  const rawLimit = Number(input.limit ?? 12);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, Math.floor(rawLimit))) : 12;

  const chats = await moo.chat.list();
  const suggestions: ChatAutocompleteSuggestion[] = [];

  for (const chat of chats as Array<{ chatId?: string; title?: string | null }>) {
    const chatId = String(chat.chatId || "").trim();
    if (!chatId) continue;
    const c = chatRefs(chatId);
    const rows = await moo.facts.matchAll(
      [
        ["?step", "rdf:type", "agent:Step"],
        ["?step", "agent:kind", "agent:UserInput"],
        ["?step", "agent:createdAt", "?at"],
        ["?step", "agent:payload", "?payload"],
      ],
      { ref: c.facts, graph: c.graph },
    );

    for (const row of rows) {
      const payloadHash = row["?payload"];
      if (!payloadHash) continue;
      const payload = await moo.objects.getJSON<{ message?: string }>(payloadHash);
      const text = normalizeAutocompleteText(payload?.value?.message);
      if (!text || !autocompleteMatches(text, query)) continue;
      suggestions.push({
        chatId,
        chatTitle: chat.title ?? null,
        step: row["?step"]!,
        at: Number(row["?at"]) || 0,
        text,
      });
    }
  }

  const byText = new Map<string, ChatAutocompleteSuggestion & { uses: number }>();
  for (const suggestion of suggestions) {
    const key = suggestion.text.toLowerCase();
    const existing = byText.get(key);
    if (existing) {
      existing.uses += 1;
      if (suggestion.at > existing.at) {
        existing.chatId = suggestion.chatId;
        existing.chatTitle = suggestion.chatTitle;
        existing.step = suggestion.step;
        existing.at = suggestion.at;
      }
    } else {
      byText.set(key, { ...suggestion, uses: 1 });
    }
  }

  const deduped = Array.from(byText.values())
    .sort((a, b) =>
      b.uses - a.uses ||
      autocompleteRank(b.text, query) - autocompleteRank(a.text, query) ||
      b.at - a.at,
    )
    .slice(0, limit)
    .map(({ uses: _uses, ...suggestion }) => suggestion);

  return { ok: true, value: { suggestions: deduped } };
}

export async function chatsListCommand() {
  const chats = await moo.chat.list();
  const pricing = await loadPricing();
  // Source of truth for "is the agent currently running?" is the Rust
  // driver's tracking map — fact-store steps no longer carry the running
  // state. Override fact-derived status so a page refresh reflects reality.
  let running: Set<string>;
  let runningStartedAt: Record<string, number>;
  try {
    running = new Set(JSON.parse(__op_chat_running_ids()));
  } catch {
    running = new Set();
  }
  try {
    runningStartedAt = JSON.parse(__op_chat_running_started_at());
  } catch {
    runningStartedAt = {};
  }
  const enriched = [];
  for (const c of chats) {
    if ((c as any).hidden && !(c as any).showHidden) continue;
    // Keep the sidebar list O(chats) over chat summaries only. Loading the
    // selected-model ref + env-derived model list for every chat made initial
    // navigation and chat switches wait on unrelated metadata; the selected
    // chat still gets full model info through chat-models. Also strip effort
    // metadata here so chat-list consumers cannot display reasoning effort.
    const {
      effort,
      effortLevel,
      selectedEffort,
      effectiveEffort,
      ...summary
    } = c as typeof c & {
      effort?: unknown;
      effortLevel?: unknown;
      selectedEffort?: unknown;
      effectiveEffort?: unknown;
    };
    void effort;
    void effortLevel;
    void selectedEffort;
    void effectiveEffort;
    const cost = estimateCostUsd(c.usage, pricing);
    enriched.push({
      ...summary,
      status: running.has(c.chatId) ? "agent:Running" : c.status,
      runningStartedAt: runningStartedAt[c.chatId] ?? null,
      selectedModel: null,
      costUsd: cost.costUsd,
      costEstimated: true,
      unpricedModels: cost.unpricedModels,
    });
  }
  return { ok: true, value: { chats: enriched } };
}

export const RECENT_CHAT_PATHS_REF = "user/recent-chat-paths";
export const RECENT_CHAT_PATHS_LIMIT = 8;

export async function normalizeDir(path: string): Promise<string> {
  const raw = String(path || ".").trim() || ".";
  const result = await moo.proc.run("pwd", ["-P"], { cwd: raw, timeoutMs: 5_000 });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || `not a directory: ${raw}`).trim());
  return result.stdout.trim() || raw;
}

export async function loadRecentChatPaths(): Promise<string[]> {
  const raw = await moo.refs.get(RECENT_CHAT_PATHS_REF);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function rememberChatPath(path: string, alreadyNormalized = false): Promise<string[]> {
  const normalized = alreadyNormalized ? path : await normalizeDir(path);
  const rest = (await loadRecentChatPaths()).filter((p) => p !== normalized);
  const next = [normalized, ...rest].slice(0, RECENT_CHAT_PATHS_LIMIT);
  await moo.refs.set(RECENT_CHAT_PATHS_REF, JSON.stringify(next));
  return next;
}

export async function recentChatPathsCommand() {
  return { ok: true, value: { paths: await loadRecentChatPaths() } };
}

export async function fsListCommand(input: Input) {
  let path: string;
  try {
    path = await normalizeDir(typeof input.path === "string" ? input.path : ".");
  } catch (e: any) {
    return { ok: false, error: { message: e?.message || String(e) } };
  }
  let names: string[];
  try {
    names = await moo.fs.list(path);
  } catch (e: any) {
    return { ok: false, error: { message: e?.message || String(e) } };
  }
  const entries = [];
  for (const name of names) {
    const child = path === "/" ? "/" + name : path + "/" + name;
    const stat = await moo.fs.stat(child);
    entries.push({ name, path: child, kind: stat?.kind || "unknown", size: stat?.size || 0, mtime: stat?.mtime || 0 });
  }
  entries.sort((a, b) => {
    const ad = a.kind === "dir" ? 0 : 1;
    const bd = b.kind === "dir" ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const parent = path === "/" ? null : path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
  return { ok: true, value: { path, parent, entries, recent: await loadRecentChatPaths() } };
}

export async function fsReadCommand(input: Input) {
  const requestedPath = typeof input.path === "string" ? input.path.trim() : "";
  if (!requestedPath) {
    return { ok: false, error: { message: "choose a file to open" } };
  }

  let path = requestedPath;
  const basePath = typeof input.basePath === "string" ? input.basePath.trim() : "";
  if (basePath && !path.startsWith("/")) {
    try {
      const base = await normalizeDir(basePath);
      path = base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
    } catch (e: any) {
      return { ok: false, error: { message: e?.message || String(e) } };
    }
  }

  const stat = await moo.fs.stat(path);
  if (!stat) {
    return { ok: false, error: { message: `File not found: ${requestedPath}` } };
  }
  if (stat.kind !== "file") {
    return { ok: false, error: { message: `Not a file: ${requestedPath}` } };
  }

  try {
    const content = await moo.fs.read(path);
    return { ok: true, value: { path, kind: stat.kind, size: stat.size, mtime: stat.mtime, content } };
  } catch (e: any) {
    return { ok: false, error: { message: e?.message || String(e) } };
  }
}

export async function chatNewCommand(input: Input) {
  let path: string | null = null;
  if (typeof input.path === "string" && input.path.trim()) {
    try {
      path = await normalizeDir(input.path);
    } catch (e: any) {
      return { ok: false, error: { message: e?.message || String(e) } };
    }
  }
  const cid = await moo.chat.create(input.chatId, path);
  const hasModel = Object.prototype.hasOwnProperty.call(input, "model");
  const hasEffort = Object.prototype.hasOwnProperty.call(input, "effort");
  if (!hasModel && !hasEffort) {
    await applyLastChatSettings(cid);
  } else {
    if (hasModel) {
      await setChatModel(cid, input.model ? String(input.model) : null);
      await rememberChatModel(input.model ? String(input.model) : null);
    }
    if (hasEffort) {
      await setChatEffort(cid, input.effort ? String(input.effort) : null);
      await rememberChatEffort(input.effort ? String(input.effort) : null);
    }
  }
  let recent: string[] = [];
  if (path) recent = await rememberChatPath(path, true);
  return { ok: true, value: { chatId: cid, path, recent } };
}

export async function chatRemoveCommand(input: Input) {
  if (!input.chatId) {
    return { ok: false, error: { message: "chat-rm requires chatId" } };
  }
  const result = await moo.chat.remove(input.chatId);
  return { ok: true, value: result };
}

// Map a graph name to the ref where its facts live. Mirrors the layout used
// throughout the harness: one ref per logical fact-set, each holding a
// single graph.
export function refForGraph(graph: string): string | null {
  if (graph === "memory:facts") return "memory/facts";
  if (graph === "vocab:facts") return "vocab/facts";
  if (graph.startsWith("memory:project/")) {
    return `memory/project/${graph.slice("memory:project/".length)}/facts`;
  }
  if (graph.startsWith("chat:")) {
    return `chat/${graph.slice("chat:".length)}/facts`;
  }
  return null;
}

export async function graphRemoveCommand(input: Input) {
  const graph = typeof input.graph === "string" ? input.graph.trim() : "";
  if (!graph) {
    return { ok: false, error: { message: "graph-rm requires graph" } };
  }

  // Canonical chat graphs carry refs (head/run/title/etc.) beyond the fact-set;
  // route them through full chat removal so we don't leave dangling metadata.
  // Malformed or ad-hoc graphs may still start with "chat:"; delete those by
  // exact graph name instead of interpreting the suffix as a chat id.
  if (/^chat:[A-Za-z0-9_-]+$/.test(graph)) {
    const chatId = graph.slice("chat:".length);
    const result = await moo.chat.remove(chatId);
    return { ok: true, value: { graph, ...result } };
  }

  // The memory page shows every graph found in quads/fact_log, including
  // historical and uncategorized ones. Delete by graph name so the UI button
  // works for all rows, not just the canonical one-ref-per-graph layouts.
  const ref = refForGraph(graph) ?? undefined;
  const cleared = await moo.facts.purgeGraph(graph);
  return { ok: true, value: { graph, ref, quadsCleared: cleared } };
}

export async function chatRenameCommand(input: Input) {
  if (!input.chatId) {
    return { ok: false, error: { message: "chat-rename requires chatId" } };
  }
  const title = typeof input.title === "string" ? input.title : null;
  await moo.chat.setTitle(input.chatId, title);
  return { ok: true, value: { chatId: input.chatId, title: title ?? null } };
}

export async function chatArchiveCommand(input: Input) {
  if (!input.chatId) {
    return { ok: false, error: { message: "chat-archive requires chatId" } };
  }
  const archived = input.archived !== false;
  const archivedAt = archived ? await moo.chat.archive(input.chatId) : await moo.chat.unarchive(input.chatId);
  return { ok: true, value: { chatId: input.chatId, archived, archivedAt } };
}

