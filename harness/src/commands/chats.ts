import { moo } from "../moo";
import { assertFactObjects, chatRefs } from "../lib";
import type { Input } from "./_shared";
import { applyLastChatSettings, rememberChatEffort, rememberChatModel, setChatEffort, setChatModel } from "./models";
import { estimateCostUsd, loadPricing } from "./describe";
import type { FactHistoryRow, Quad } from "../types";


export type ChatAutocompleteSuggestion = {
  chatId: string;
  chatTitle: string | null;
  step: string;
  at: number;
  text: string;
};

type ChatAutocompleteIndexEntry = Omit<ChatAutocompleteSuggestion, "chatId" | "chatTitle"> & {
  lowerText: string;
};

type ChatAutocompleteChatMeta = {
  chatId: string;
  title: string | null;
  factsCount: number;
  lastAt: number;
};

type ChatAutocompleteIndex = {
  chatId: string;
  chatTitle: string | null;
  factsCount: number;
  entries: ChatAutocompleteIndexEntry[];
  pending?: Promise<ChatAutocompleteIndex>;
};

const CHAT_AUTOCOMPLETE_CHAT_CONCURRENCY = 8;
const CHAT_AUTOCOMPLETE_PAYLOAD_CONCURRENCY = 24;
const CHAT_AUTOCOMPLETE_COLD_CHAT_LIMIT = 8;
const CHAT_AUTOCOMPLETE_BACKGROUND_CHAT_LIMIT = 160;
const CHAT_AUTOCOMPLETE_META_TTL_MS = 3000;
const CHAT_AUTOCOMPLETE_QUERY_CACHE_LIMIT = 200;
const chatAutocompleteIndexCache = new Map<string, ChatAutocompleteIndex>();
let chatAutocompleteMetasCache: { at: number; metas: ChatAutocompleteChatMeta[]; signature: string } | null = null;
let chatAutocompleteMetasPending: Promise<{ metas: ChatAutocompleteChatMeta[]; signature: string }> | null = null;
const chatAutocompleteQueryCache = new Map<string, ChatAutocompleteSuggestion[]>();

function normalizeAutocompleteText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function autocompleteTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function autocompleteMatchesLower(lowerText: string, terms: string[]): boolean {
  return terms.every((term) => lowerText.includes(term));
}

function autocompleteRankLower(lowerText: string, needle: string): number {
  if (!needle) return 0;
  if (lowerText === needle) return 4;
  if (lowerText.startsWith(needle)) return 3;
  if (lowerText.includes(needle)) return 2;
  return 1;
}

function chatAutocompleteFactsCount(chat: { totalFacts?: unknown }, fallback = -1): number {
  const value = Number(chat.totalFacts);
  return Number.isFinite(value) ? value : fallback;
}

function chatAutocompleteMeta(chat: { chatId?: string; title?: string | null; totalFacts?: unknown; lastAt?: unknown }): ChatAutocompleteChatMeta | null {
  const chatId = String(chat.chatId || "").trim();
  if (!chatId) return null;
  const lastAt = Number(chat.lastAt);
  return {
    chatId,
    title: chat.title ?? null,
    factsCount: chatAutocompleteFactsCount(chat),
    lastAt: Number.isFinite(lastAt) ? lastAt : 0,
  };
}

function validChatAutocompleteIndex(meta: ChatAutocompleteChatMeta): ChatAutocompleteIndex | null {
  const cached = chatAutocompleteIndexCache.get(meta.chatId);
  if (!cached || cached.pending || cached.factsCount !== meta.factsCount) return null;
  if (cached.chatTitle !== meta.title) cached.chatTitle = meta.title;
  return cached;
}

function chatAutocompleteMetasSignature(metas: ChatAutocompleteChatMeta[]): string {
  return metas.map((meta) => meta.chatId + ":" + meta.factsCount + ":" + meta.lastAt).join("|");
}

async function loadChatAutocompleteMetas(): Promise<{ metas: ChatAutocompleteChatMeta[]; signature: string }> {
  const metas = ((await moo.chat.list()) as Array<{ chatId?: string; title?: string | null; totalFacts?: unknown; lastAt?: unknown }>)
    .map(chatAutocompleteMeta)
    .filter(Boolean)
    .sort((a, b) => b.lastAt - a.lastAt) as ChatAutocompleteChatMeta[];
  return { metas, signature: chatAutocompleteMetasSignature(metas) };
}

async function refreshChatAutocompleteMetas(): Promise<{ metas: ChatAutocompleteChatMeta[]; signature: string }> {
  if (chatAutocompleteMetasPending) return chatAutocompleteMetasPending;
  chatAutocompleteMetasPending = loadChatAutocompleteMetas()
    .then((snapshot) => {
      chatAutocompleteMetasCache = { at: Date.now(), ...snapshot };
      chatAutocompleteQueryCache.clear();
      return snapshot;
    })
    .finally(() => {
      chatAutocompleteMetasPending = null;
    });
  return chatAutocompleteMetasPending;
}

async function chatAutocompleteMetas(): Promise<{ metas: ChatAutocompleteChatMeta[]; signature: string }> {
  const now = Date.now();
  if (chatAutocompleteMetasCache && now - chatAutocompleteMetasCache.at < CHAT_AUTOCOMPLETE_META_TTL_MS) {
    return chatAutocompleteMetasCache;
  }
  if (chatAutocompleteMetasCache) {
    void refreshChatAutocompleteMetas();
    return chatAutocompleteMetasCache;
  }
  return refreshChatAutocompleteMetas();
}

function rememberChatAutocompleteQuery(key: string, suggestions: ChatAutocompleteSuggestion[]): void {
  if (chatAutocompleteQueryCache.has(key)) chatAutocompleteQueryCache.delete(key);
  chatAutocompleteQueryCache.set(key, suggestions);
  if (chatAutocompleteQueryCache.size > CHAT_AUTOCOMPLETE_QUERY_CACHE_LIMIT) {
    const oldest = chatAutocompleteQueryCache.keys().next().value;
    if (oldest) chatAutocompleteQueryCache.delete(oldest);
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function buildChatAutocompleteIndex(meta: ChatAutocompleteChatMeta): Promise<ChatAutocompleteIndex> {
  const c = chatRefs(meta.chatId);
  const rows = await moo.facts.matchAll({ patterns: [
      ["?step", "rdf:type", "agent:Step"],
      ["?step", "agent:kind", "agent:UserInput"],
      ["?step", "agent:createdAt", "?at"],
      ["?step", "agent:payload", "?payload"],
    ], ...{ ref: c.facts, graph: c.graph } });

  const entries = (
    await mapWithConcurrency(rows, CHAT_AUTOCOMPLETE_PAYLOAD_CONCURRENCY, async (row) => {
      const payloadHash = row["?payload"];
      if (!payloadHash) return null;
      const payload = await moo.objects.getJSON<{ message?: string }>({ hash: payloadHash });
      const text = normalizeAutocompleteText(payload?.value?.message);
      if (!text) return null;
      return {
        step: row["?step"]!,
        at: Number(row["?at"]) || 0,
        text,
        lowerText: text.toLowerCase(),
      } satisfies ChatAutocompleteIndexEntry;
    })
  ).filter(Boolean) as ChatAutocompleteIndexEntry[];

  const index = { chatId: meta.chatId, chatTitle: meta.title, factsCount: meta.factsCount, entries };
  chatAutocompleteIndexCache.set(meta.chatId, index);
  return index;
}

async function chatAutocompleteIndex(meta: ChatAutocompleteChatMeta): Promise<ChatAutocompleteIndex> {
  const cached = chatAutocompleteIndexCache.get(meta.chatId);
  if (cached?.factsCount === meta.factsCount) {
    if (cached.chatTitle !== meta.title) cached.chatTitle = meta.title;
    return cached.pending ? cached.pending : cached;
  }
  if (cached?.pending && cached.factsCount === meta.factsCount) return cached.pending;

  const pending = buildChatAutocompleteIndex(meta).finally(() => {
    const latest = chatAutocompleteIndexCache.get(meta.chatId);
    if (latest?.pending === pending) chatAutocompleteIndexCache.delete(meta.chatId);
  });
  chatAutocompleteIndexCache.set(meta.chatId, {
    chatId: meta.chatId,
    chatTitle: meta.title,
    factsCount: meta.factsCount,
    entries: cached?.entries ?? [],
    pending,
  });
  return pending;
}

function warmChatAutocompleteIndexes(metas: ChatAutocompleteChatMeta[]): void {
  if (!metas.length) return;
  void mapWithConcurrency(metas.slice(0, CHAT_AUTOCOMPLETE_BACKGROUND_CHAT_LIMIT), CHAT_AUTOCOMPLETE_CHAT_CONCURRENCY, async (meta) => {
    try {
      await chatAutocompleteIndex(meta);
    } catch {
      // Best-effort warmup; the foreground request will retry on demand.
    }
  });
}

function addAutocompleteMatches(
  byText: Map<string, ChatAutocompleteSuggestion & { uses: number; lowerText: string }>,
  index: ChatAutocompleteIndex,
  terms: string[],
): void {
  for (const entry of index.entries) {
    if (!autocompleteMatchesLower(entry.lowerText, terms)) continue;
    const existing = byText.get(entry.lowerText);
    if (existing) {
      existing.uses += 1;
      if (entry.at > existing.at) {
        existing.chatId = index.chatId;
        existing.chatTitle = index.chatTitle;
        existing.step = entry.step;
        existing.at = entry.at;
        existing.text = entry.text;
      }
    } else {
      byText.set(entry.lowerText, {
        chatId: index.chatId,
        chatTitle: index.chatTitle,
        step: entry.step,
        at: entry.at,
        text: entry.text,
        lowerText: entry.lowerText,
        uses: 1,
      });
    }
  }
}

export async function chatAutocompleteCommand(input: Input) {
  const query = normalizeAutocompleteText(input.query);
  const rawLimit = Number(input.limit ?? 12);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, Math.floor(rawLimit))) : 12;
  if (!query) return { ok: true, value: { suggestions: [] } };

  const queryLower = query.toLowerCase();
  const terms = autocompleteTerms(query);
  const { metas, signature } = await chatAutocompleteMetas();
  const cacheKey = signature + "\0" + queryLower + "\0" + limit;
  const cachedSuggestions = chatAutocompleteQueryCache.get(cacheKey);
  if (cachedSuggestions) return { ok: true, value: { suggestions: cachedSuggestions } };

  const byText = new Map<string, ChatAutocompleteSuggestion & { uses: number; lowerText: string }>();
  const coldChats: ChatAutocompleteChatMeta[] = [];

  for (const chat of metas) {
    const cached = validChatAutocompleteIndex(chat);
    if (cached) addAutocompleteMatches(byText, cached, terms);
    else coldChats.push(chat);
  }

  // Autocomplete is on the typing hot path: never wait for a cold chat scan.
  // Return whatever is indexed now and warm the missing chats for subsequent
  // keystrokes. This makes warm queries memory-only and cold queries bounded by
  // chat-list metadata instead of payload reads across many histories.
  let complete = coldChats.length === 0;
  if (!complete && byText.size < limit) {
    const foregroundChats = coldChats.slice(0, CHAT_AUTOCOMPLETE_COLD_CHAT_LIMIT);
    const indexes = await mapWithConcurrency(foregroundChats, CHAT_AUTOCOMPLETE_CHAT_CONCURRENCY, async (chat) => {
      try {
        return await chatAutocompleteIndex(chat);
      } catch {
        return null;
      }
    });
    for (const index of indexes) {
      if (index) addAutocompleteMatches(byText, index, terms);
    }
    complete = coldChats.length <= CHAT_AUTOCOMPLETE_COLD_CHAT_LIMIT;
    warmChatAutocompleteIndexes(coldChats.slice(CHAT_AUTOCOMPLETE_COLD_CHAT_LIMIT));
  } else {
    warmChatAutocompleteIndexes(coldChats);
  }

  const deduped = Array.from(byText.values())
    .sort((a, b) =>
      b.uses - a.uses ||
      autocompleteRankLower(b.lowerText, queryLower) - autocompleteRankLower(a.lowerText, queryLower) ||
      b.at - a.at,
    )
    .slice(0, limit)
    .map(({ uses: _uses, lowerText: _lowerText, ...suggestion }) => suggestion);

  if (complete) rememberChatAutocompleteQuery(cacheKey, deduped);
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
  const homeDir = (await moo.env.get("HOME")) || null;
  return { ok: true, value: { chats: enriched, homeDir } };
}

export const RECENT_CHAT_PATHS_REF = "user/recent-chat-paths";
export const RECENT_CHAT_PATHS_LIMIT = 8;

export async function normalizeDir(path: string): Promise<string> {
  let raw = String(path || ".").trim() || ".";
  // Allow callers to pass shell-style "~" / "~/foo" — the backend resolves
  // them against $HOME so the UI can show tilde paths and round-trip them.
  if (raw === "~" || raw.startsWith("~/")) {
    const home = (await moo.env.get("HOME")) || "";
    if (home) raw = home + raw.slice(1);
  }
  const result = await moo.proc.run({ cmd: "pwd", args: ["-P"], ...{ cwd: raw, timeoutMs: 5_000 } });
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
  const entries = await Promise.all(
    names.map(async (name) => {
      const child = path === "/" ? "/" + name : path + "/" + name;
      const stat = await moo.fs.stat(child);
      return { name, path: child, kind: stat?.kind || "unknown", size: stat?.size || 0, mtime: stat?.mtime || 0 };
    }),
  );
  entries.sort((a, b) => {
    const ad = a.kind === "dir" ? 0 : 1;
    const bd = b.kind === "dir" ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const parent = path === "/" ? null : path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
  return { ok: true, value: { path, parent, entries, recent: await loadRecentChatPaths() } };
}


function clampFsSearchLimit(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 24;
  return Math.max(1, Math.min(100, n));
}

function normalizeFsSearchQuery(value: unknown): string {
  return String(typeof value === "string" ? value : "")
    .trim()
    .replace(/^@+/, "")
    .replace(/^\/+/, "");
}

function joinChildPath(base: string, child: string): string {
  return base === "/" ? "/" + child : base.replace(/\/+$/, "") + "/" + child;
}

function fsSearchName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function pathHasHiddenSegment(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."));
}

function shouldSkipFsSearchDir(name: string): boolean {
  return (
    name === ".git" ||
    name === ".moo" ||
    name === ".direnv" ||
    name === "node_modules" ||
    name === "target" ||
    name === "dist" ||
    name === ".cache" ||
    name === ".next" ||
    name === ".vite"
  );
}

function fuzzySubsequenceScore(candidate: string, query: string): number {
  let last = -1;
  let streak = 0;
  let score = 0;
  for (const ch of query) {
    const at = candidate.indexOf(ch, last + 1);
    if (at < 0) return 0;
    const gap = at - last - 1;
    streak = gap === 0 ? streak + 1 : 0;
    score += 12 + streak * 6;
    if (at === 0 || "/._-".includes(candidate[at - 1] || "")) score += 10;
    score -= Math.min(gap, 12);
    last = at;
  }
  return Math.max(1, score - candidate.length * 0.05);
}

function fsSearchScore(relativePath: string, query: string): number {
  const candidate = relativePath.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 0;
  const name = fsSearchName(candidate);

  if (candidate === q) return 100_000;
  if (name === q) return 95_000 - relativePath.length;
  if (candidate.startsWith(q)) return 90_000 - relativePath.length;
  if (name.startsWith(q)) return 85_000 - relativePath.length;

  const nameIndex = name.indexOf(q);
  if (nameIndex >= 0) return 80_000 - nameIndex * 100 - relativePath.length;
  const pathIndex = candidate.indexOf(q);
  if (pathIndex >= 0) return 70_000 - pathIndex * 100 - relativePath.length;

  const nameFuzzy = fuzzySubsequenceScore(name, q);
  const pathFuzzy = fuzzySubsequenceScore(candidate, q);
  return Math.max(nameFuzzy > 0 ? nameFuzzy + 10 : 0, pathFuzzy);
}

function addFsSearchCandidate(
  candidates: Map<string, { relativePath: string; kind: string }>,
  relativePath: string,
  kind: string,
) {
  const clean = relativePath.replace(/^\/+/, "").replace(/\/+/g, "/").replace(/\/+$/, "");
  if (!clean || clean === "." || clean.split("/").some((part) => part === "..")) return;
  const existing = candidates.get(clean);
  if (existing?.kind === "file") return;
  candidates.set(clean, { relativePath: clean, kind });
}

const FS_SEARCH_CANDIDATE_CACHE_TTL_MS = 30_000;
const fsSearchCandidateCache = new Map<
  string,
  { at: number; promise: Promise<Map<string, { relativePath: string; kind: string }> | null> }
>();

async function gitFsSearchCandidates(base: string): Promise<Map<string, { relativePath: string; kind: string }> | null> {
  const result = await moo.proc.run({ cmd: "git", args: ["ls-files", "-co", "--exclude-standard"], ...{
    cwd: base,
    timeoutMs: 10_000,
  } });
  if (result.code !== 0) return null;

  const candidates = new Map<string, { relativePath: string; kind: string }>();
  for (const line of result.stdout.split("\n")) {
    const file = line.trim();
    if (!file || file.startsWith("/") || file.split("/").some((part) => part === "..")) continue;
    const parts = file.split("/").filter(Boolean);
    let dir = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      dir = dir ? dir + "/" + parts[i] : parts[i];
      addFsSearchCandidate(candidates, dir, "dir");
    }
    addFsSearchCandidate(candidates, parts.join("/"), "file");
  }
  return candidates;
}

async function fallbackFsSearchCandidates(base: string): Promise<Map<string, { relativePath: string; kind: string }>> {
  const candidates = new Map<string, { relativePath: string; kind: string }>();
  const queue = [""];
  let visited = 0;
  const maxVisited = 5_000;

  while (queue.length > 0 && visited < maxVisited) {
    const dir = queue.shift() || "";
    const absDir = dir ? joinChildPath(base, dir) : base;
    let names: string[];
    try {
      names = await moo.fs.list(absDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name || name.includes("/")) continue;
      const relativePath = dir ? dir + "/" + name : name;
      const stat = await moo.fs.stat(joinChildPath(base, relativePath));
      const kind = stat?.kind || "unknown";
      addFsSearchCandidate(candidates, relativePath, kind);
      visited += 1;
      if (kind === "dir" && !shouldSkipFsSearchDir(name)) queue.push(relativePath);
      if (visited >= maxVisited) break;
    }
  }

  return candidates;
}

async function cachedFsSearchCandidates(base: string): Promise<Map<string, { relativePath: string; kind: string }> | null> {
  const now = Date.now();
  const cached = fsSearchCandidateCache.get(base);
  if (cached && now - cached.at < FS_SEARCH_CANDIDATE_CACHE_TTL_MS) return cached.promise;

  const promise = (async () => {
    let candidates = await gitFsSearchCandidates(base);
    if (!candidates) candidates = await fallbackFsSearchCandidates(base);
    return candidates;
  })();
  fsSearchCandidateCache.set(base, { at: now, promise });
  try {
    return await promise;
  } catch (e) {
    if (fsSearchCandidateCache.get(base)?.promise === promise) fsSearchCandidateCache.delete(base);
    throw e;
  }
}

export async function fsSearchCommand(input: Input) {
  let base: string;
  try {
    base = await normalizeDir(typeof input.path === "string" ? input.path : ".");
  } catch (e: any) {
    return { ok: false, error: { message: e?.message || String(e) } };
  }

  const query = normalizeFsSearchQuery(input.query);
  const limit = clampFsSearchLimit(input.limit);
  if (!query) return { ok: true, value: { path: base, entries: [] } };

  const includeHidden = query.startsWith(".") || query.includes("/.");
  const candidates = await cachedFsSearchCandidates(base);

  const matches = [];
  for (const candidate of candidates.values()) {
    if (!includeHidden && pathHasHiddenSegment(candidate.relativePath)) continue;
    const score = fsSearchScore(candidate.relativePath, query);
    if (score <= 0) continue;
    matches.push({ ...candidate, score });
  }

  matches.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const ad = a.kind === "dir" ? 0 : 1;
    const bd = b.kind === "dir" ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
  });

  const entries = matches.slice(0, limit).map((match) => ({
    name: fsSearchName(match.relativePath),
    path: joinChildPath(base, match.relativePath),
    relativePath: match.relativePath,
    kind: match.kind,
    size: 0,
    mtime: 0,
  }));

  return { ok: true, value: { path: base, entries } };
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


function parseHistoryAt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isAddAction(action: string): boolean {
  return action === "+" || action === "add" || action === "added";
}

function isRemoveAction(action: string): boolean {
  return action === "-" || action === "remove" || action === "removed";
}

function remapChatQuad(q: Quad, fromGraph: string, toGraph: string): Quad {
  return [q[0] === fromGraph ? toGraph : q[0], q[1], q[2], q[3]];
}

function latestFactsAt(history: FactHistoryRow[], cutoffAt: number, fromGraph: string, toGraph: string): Quad[] {
  const present = new Map<string, Quad>();
  for (const row of history) {
    if (parseHistoryAt(row[5]) > cutoffAt) break;
    const quad = remapChatQuad([row[0], row[1], row[2], row[3]], fromGraph, toGraph);
    const key = JSON.stringify(quad);
    const action = String(row[4] ?? "");
    if (isAddAction(action)) present.set(key, quad);
    else if (isRemoveAction(action)) present.delete(key);
  }
  return Array.from(present.values());
}

function addEncodedQuads(ref: string, quads: Quad[]) {
  if (!quads.length) return;
  // facts.history() returns object terms exactly as stored in the quad table
  // (e.g. agent:Step, 123, or "literal"). Passing those rows back through
  // moo.facts.addAll() would encode them a second time, turning IRIs/numbers
  // into string literals and making describe/timeline queries miss every step.
  assertFactObjects(quads);
  __op_facts_swap(ref, "[]", JSON.stringify(quads));
}

function literalString(value: string): string {
  return JSON.stringify(value);
}

function forkTitle(title: string | null, chatId: string): string {
  const base = (title || chatId).trim() || chatId;
  const suffix = " fork";
  const maxBase = 80 - suffix.length;
  return (base.length > maxBase ? base.slice(0, maxBase).trimEnd() : base) + suffix;
}

function stepAddedAt(history: FactHistoryRow[], stepId: string): number {
  for (const row of history) {
    if (row[1] !== stepId) continue;
    if (row[2] !== "rdf:type" || row[3] !== "agent:Step") continue;
    if (isAddAction(String(row[4] ?? ""))) return parseHistoryAt(row[5]);
  }
  return 0;
}

async function copyRefIfPresent(from: string, to: string) {
  const value = await moo.refs.get(from);
  if (value != null) await moo.refs.set(to, value);
}

export async function chatForkCommand(input: Input) {
  const sourceChatId = String(input.chatId || input.sourceChatId || "").trim();
  const stepId = String(input.step || input.stepId || input.fromStepId || "").trim();
  if (!sourceChatId) return { ok: false, error: { message: "chat-fork requires chatId" } };
  if (!stepId) return { ok: false, error: { message: "chat-fork requires step" } };

  const sourceRefs = chatRefs(sourceChatId);
  const history = await moo.facts.history({ ref: sourceRefs.facts, ...{ graph: sourceRefs.graph } });
  const cutoffAt = stepAddedAt(history, stepId);
  if (!cutoffAt) {
    return { ok: false, error: { message: "step not found in " + sourceChatId + ": " + stepId } };
  }

  const [sourcePath, sourceTitle] = await Promise.all([
    moo.refs.get("chat/" + sourceChatId + "/path"),
    moo.refs.get("chat/" + sourceChatId + "/title"),
  ]);
  const forkChatId = await moo.chat.create(input.forkChatId || input.newChatId, sourcePath || null);
  const forkRefs = chatRefs(forkChatId);

  const quads = latestFactsAt(history, cutoffAt, sourceRefs.graph, forkRefs.graph);
  addEncodedQuads(forkRefs.facts, quads);

  await Promise.all([
    copyRefIfPresent(sourceRefs.model, forkRefs.model),
    copyRefIfPresent(sourceRefs.effort, forkRefs.effort),
  ]);

  const headRows = quads.filter((q) => q[1] === stepId && q[2] === "agent:kind");
  if (headRows.length) await moo.refs.set(forkRefs.head, stepId);
  await moo.refs.set("chat/" + forkChatId + "/parent", sourceChatId);
  await moo.refs.set("chat/" + forkChatId + "/forked-from-step", stepId);
  await moo.refs.set("chat/" + forkChatId + "/forked-from-at", String(cutoffAt));
  await moo.chat.setTitle({ chatId: forkChatId, title: forkTitle(sourceTitle, sourceChatId) });
  await moo.chat.recordSummary({
    chatId: forkChatId,
    title: "Forked chat",
    summary: "Forked from " + (sourceTitle || sourceChatId) + " at " + stepId + ".",
  });
  await moo.facts.addAll({ ref: forkRefs.facts, quads: [
    [forkRefs.graph, forkRefs.graph, "agent:forkedFromChat", "chat:" + sourceChatId],
    [forkRefs.graph, forkRefs.graph, "agent:forkedFromStep", stepId],
    [forkRefs.graph, forkRefs.graph, "agent:forkedFromAt", String(cutoffAt)],
    [forkRefs.graph, forkRefs.graph, "agent:forkedFromTitle", literalString(sourceTitle || sourceChatId)],
  ] });
  await moo.chat.touch(forkChatId);

  return { ok: true, value: {
    chatId: forkChatId,
    sourceChatId,
    forkedFromStep: stepId,
    forkedFromAt: cutoffAt,
    path: sourcePath || null,
    copiedFacts: quads.length,
  } };
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
  const cleared = await moo.facts.deleteGraphEverywhere({ graph });
  return { ok: true, value: { graph, ref, quadsCleared: cleared } };
}

export async function chatRenameCommand(input: Input) {
  if (!input.chatId) {
    return { ok: false, error: { message: "chat-rename requires chatId" } };
  }
  const title = typeof input.title === "string" ? input.title : null;
  await moo.chat.setTitle({ chatId: input.chatId, title });
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

