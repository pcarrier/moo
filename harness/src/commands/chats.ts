import * as host from "../host_ops";
import { moo } from "../moo";
import { chatRefs } from "../lib";
import type { Input } from "./_shared";
import { applyLastChatSettings, rememberChatEffort, rememberChatModel, setChatEffort, setChatModel } from "./models";
import { estimateCostUsd, loadPricing } from "./describe";
import { hasPendingInput } from "../agent";
import type { FactHistoryRow } from "../types";


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
const CHAT_AUTOCOMPLETE_BACKGROUND_CHAT_LIMIT = 160;
const CHAT_AUTOCOMPLETE_META_TTL_MS = 30000;
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
    .filter((meta): meta is ChatAutocompleteChatMeta => meta !== null)
    .sort((a, b) => b.lastAt - a.lastAt);
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
    ], ...{ store: c.facts, graph: c.graph } });

  const payloadHashes = rows.map((row) => row["?payload"]).filter((hash): hash is string => Boolean(hash));
  const objects = host.getObjects(payloadHashes);
  const entries = rows.flatMap((row): ChatAutocompleteIndexEntry[] => {
    const payloadHash = row["?payload"];
    if (!payloadHash) return [];
    const object = objects[payloadHash];
    if (!object) return [];
    const payload = JSON.parse(object.content) as { message?: string; artificial?: boolean };
    if (payload.artificial === true) return [];
    const text = normalizeAutocompleteText(payload.message);
    if (!text) return [];
    return [{
      step: row["?step"]!,
      at: Number(row["?at"]) || 0,
      text,
      lowerText: text.toLowerCase(),
    }];
  });

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

  // Autocomplete is on the typing hot path: never wait for cold chat
  // payloads. Return indexed matches immediately and warm missing chats in the
  // background so follow-up keystrokes become memory-only.
  const complete = coldChats.length === 0;
  warmChatAutocompleteIndexes(coldChats);

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
  const enriched = [];
  for (const c of chats) {
    const showHidden = "showHidden" in c && Boolean(c.showHidden);
    if (c.hidden && !showHidden) continue;
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
    const pendingInput = c.status === "ui:Pending" || (await hasPendingInput(c.chatId));
    const status = pendingInput ? "ui:Pending" : c.status;
    enriched.push({
      ...summary,
      status,
      runningStartedAt: status === "agent:Running" ? (c.runningStartedAt ?? null) : null,
      selectedModel: null,
      costUsd: cost.costUsd,
      costEstimated: true,
      unpricedModels: cost.unpricedModels,
    });
  }
  const homeDir = (await moo.env.get({ name: "HOME" })) || null;
  return { ok: true, value: { chats: enriched, homeDir } };
}

export const RECENT_CHAT_PATHS_REF = "user/recent-chat-paths";
export const RECENT_CHAT_PATHS_LIMIT = 8;

async function chatWorktreePath(chatId: string): Promise<string> {
  const home = String((await moo.env.get({ name: "HOME" })) || "").trim().replace(/\/+$/, "");
  const base = home ? home + "/moo" : "moo";
  return base + "/" + String(chatId).replace(/^\/+/, "");
}

async function expandHomeDir(path: string): Promise<string> {
  let raw = String(path || ".").trim() || ".";
  // Allow callers to pass shell-style "~" / "~/foo" — the backend resolves
  // them against $HOME so the UI can show tilde paths and round-trip them.
  if (raw === "~" || raw.startsWith("~/")) {
    const home = (await moo.env.get({ name: "HOME" })) || "";
    if (home) raw = home + raw.slice(1);
  }
  return raw;
}

export async function normalizeDir(path: string): Promise<string> {
  const raw = await expandHomeDir(path);
  const stat = await moo.fs.stat({ path: raw });
  if (!stat || stat.kind !== "dir") throw new Error(`not a directory: ${raw}`);
  return await moo.fs.canonical({ path: raw });
}

async function lazyWorktreePathParts(path: string): Promise<{ chatId: string; rest: string } | null> {
  const normalized = String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const home = String((await moo.env.get({ name: "HOME" })) || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (home) {
    const prefix = home + "/moo/";
    if (normalized.startsWith(prefix)) {
      const [chatId = "", ...rest] = normalized.slice(prefix.length).split("/");
      return chatId ? { chatId, rest: rest.join("/") } : null;
    }
  }
  const legacy = /(?:^|\/)\.moo\/([^/]+)(?:\/(.*))?$/.exec(normalized);
  return legacy?.[1] ? { chatId: legacy[1], rest: legacy[2] || "" } : null;
}

async function normalizeDirMaterializingChatWorktree(path: string): Promise<string> {
  const raw = await expandHomeDir(path);
  try {
    return await normalizeDir(raw);
  } catch (originalError: any) {
    const lazy = await lazyWorktreePathParts(raw);
    if (!lazy || !(await moo.pointers.get({ name: `chat/${lazy.chatId}/created-at` }))) throw originalError;
    try {
      const worktree = await moo.chat.scratch({ chatId: lazy.chatId });
      const materialized = lazy.rest ? worktree.replace(/\/+$/, "") + "/" + lazy.rest.replace(/^\/+/, "") : worktree;
      return await normalizeDir(materialized);
    } catch {
      throw originalError;
    }
  }
}

function parseRecentChatPaths(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function loadRecentChatPathsRaw(): Promise<{ raw: string | null; parsed: string[] }> {
  const raw = (await moo.pointers.get({ name: RECENT_CHAT_PATHS_REF })) ?? null;
  return { raw, parsed: parseRecentChatPaths(raw) };
}

export async function loadRecentChatPaths(): Promise<string[]> {
  return parseRecentChatPaths((await moo.pointers.get({ name: RECENT_CHAT_PATHS_REF })) ?? null);
}

const RECENT_CHAT_PATHS_CAS_ATTEMPTS = 5;

// Atomically read-modify-write the persisted recent-paths list. The host
// dispatches commands as independent async tasks, so a plain get/compute/set
// races: two concurrent mutators both read the same snapshot and the second
// write clobbers the first. CAS against the exact prior raw value (including
// the null/unset case) and retry on contention.
async function mutateRecentChatPaths(compute: (current: string[]) => string[]): Promise<string[]> {
  for (let attempt = 0; attempt < RECENT_CHAT_PATHS_CAS_ATTEMPTS; attempt += 1) {
    const { raw, parsed } = await loadRecentChatPathsRaw();
    const next = compute(parsed);
    const ok = await moo.pointers.cas({ name: RECENT_CHAT_PATHS_REF, expected: raw, next: JSON.stringify(next) });
    if (ok) return next;
  }
  // Best-effort fallback after exhausting retries: write the latest computed value.
  const { parsed } = await loadRecentChatPathsRaw();
  const next = compute(parsed);
  await moo.pointers.set({ name: RECENT_CHAT_PATHS_REF, target: JSON.stringify(next) });
  return next;
}

export async function rememberChatPath(path: string, alreadyNormalized = false): Promise<string[]> {
  const normalized = alreadyNormalized ? path : await normalizeDir(path);
  return await mutateRecentChatPaths((current) => {
    const rest = current.filter((p) => p !== normalized);
    return [normalized, ...rest].slice(0, RECENT_CHAT_PATHS_LIMIT);
  });
}


async function isJjAvailable(): Promise<boolean> {
  const result = await moo.proc.run({ cmd: ["sh", "-lc", "command -v jj >/dev/null 2>&1"], timeoutMs: 2_000 });
  return result.code === 0;
}

async function repoKindForPath(path: string): Promise<RepoKind> {
  const [jj, git] = await Promise.all([jjRepoInfo(path), gitRepoInfo(path)]);
  if (jj) return "jj";
  if (git) return "git";
  return null;
}

async function recentChatRepoSummaries(paths: string[]): Promise<Array<{ path: string; repoKind: RepoKind }>> {
  return await Promise.all(paths.map(async (path) => ({ path, repoKind: await repoKindForPath(path) })));
}

export async function recentChatPathsCommand(input: Input = {}) {
  const paths = await loadRecentChatPaths();
  const includeRepos = input.includeRepos === true;
  return { ok: true, value: { paths, ...(includeRepos ? { repos: await recentChatRepoSummaries(paths) } : {}) } };
}

export async function removeRecentChatPathCommand(input: Input = {}) {
  if (typeof input.path !== "string" || !input.path.trim()) {
    return { ok: false, error: { message: "path is required" } };
  }
  let normalized: string;
  try {
    normalized = await normalizeDir(input.path);
  } catch {
    normalized = input.path.trim();
  }
  let removed = false;
  const next = await mutateRecentChatPaths((current) => {
    const filtered = current.filter((path) => path !== normalized && path !== input.path);
    removed = filtered.length !== current.length;
    return filtered;
  });
  return { ok: true, value: { removed, paths: next } };
}

export async function fsListCommand(input: Input) {
  let path: string;
  try {
    path = await normalizeDirMaterializingChatWorktree(typeof input.path === "string" ? input.path : ".");
  } catch (e: any) {
    return { ok: false, error: { message: e?.message || String(e) } };
  }
  let names: string[];
  try {
    names = await moo.fs.list({ path: path });
  } catch (e: any) {
    return { ok: false, error: { message: e?.message || String(e) } };
  }
  const changeStats = await gitFsChangeStats(path);
  const entries = await Promise.all(
    names.map(async (name) => {
      const child = path === "/" ? "/" + name : path + "/" + name;
      const stat = await moo.fs.stat({ path: child });
      const relative = normalizeFsRelativePath(name);
      const changed = relative ? changeStats?.get(relative) : null;
      return { name, path: child, kind: stat?.kind || "unknown", size: stat?.size || 0, mtime: stat?.mtime || 0, ...(changed ? changed : {}) };
    }),
  );
  entries.sort(sortFsEntries);
  const parent = path === "/" ? null : path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
  return { ok: true, value: { path, parent, entries, recent: await loadRecentChatPaths() } };
}

function sortFsEntries(a: { name: string; kind: string }, b: { name: string; kind: string }): number {
  const ad = a.kind === "dir" ? 0 : 1;
  const bd = b.kind === "dir" ? 0 : 1;
  if (ad !== bd) return ad - bd;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

type GitBranchItem = {
  name: string;
  ref: string;
  kind: "head" | "local" | "remote";
  current?: boolean;
  upstream?: string | null;
};

type JjRevisionItem = {
  name: string;
  rev: string;
  kind: "current" | "bookmark" | "trunk" | "recent";
  description?: string | null;
  current?: boolean;
};

type RepoKind = "git" | "jj" | null;

type GitBranchesValue = {
  path: string;
  gitRoot: string | null;
  repoRoot?: string | null;
  repoKind?: RepoKind;
  isRepo: boolean;
  branches: GitBranchItem[];
  jjRevisions?: JjRevisionItem[];
  currentBranch: string | null;
  defaultBranch: string | null;
  selectedBranch: string | null;
  currentJjRevision?: string | null;
  selectedJjRevision?: string | null;
  hasRemote: boolean;
  jjAvailable?: boolean;
  fetched?: boolean;
  message?: string | null;
};

type GitBranchesCacheEntry = { expiresAt: number; value: GitBranchesValue };
const gitBranchesCache = new Map<string, GitBranchesCacheEntry>();
const GIT_BRANCHES_CACHE_MS = 15_000;

function cleanGitLine(value: string): string {
  return value.replace(/\r/g, "").trim();
}

function dedupeGitBranches(branches: GitBranchItem[]): GitBranchItem[] {
  const byRef = new Map<string, GitBranchItem>();
  for (const branch of branches) {
    const existing = byRef.get(branch.ref);
    if (!existing) {
      byRef.set(branch.ref, branch);
      continue;
    }
    byRef.set(branch.ref, {
      ...existing,
      current: Boolean(existing.current || branch.current),
      upstream: existing.upstream ?? branch.upstream ?? null,
    });
  }
  const rank = (branch: GitBranchItem) => branch.kind === "head" ? 0 : branch.kind === "local" ? 1 : 2;
  return [...byRef.values()].sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function defaultGitBranch(gitRoot: string): Promise<string | null> {
  const symbolic = await moo.proc.run({
    cmd: ["git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    ...{ cwd: gitRoot, timeoutMs: 5_000 },
  });
  if (symbolic.code === 0) {
    const remoteName = cleanGitLine(symbolic.stdout);
    const localName = remoteName.replace(/^origin\//, "");
    if (localName) {
      const local = await moo.proc.run({ cmd: ["git", "show-ref", "--verify", "--quiet", "refs/heads/" + localName], ...{ cwd: gitRoot, timeoutMs: 5_000 } });
      return local.code === 0 ? localName : remoteName;
    }
  }
  for (const candidate of ["main", "master"]) {
    const local = await moo.proc.run({ cmd: ["git", "show-ref", "--verify", "--quiet", "refs/heads/" + candidate], ...{ cwd: gitRoot, timeoutMs: 5_000 } });
    if (local.code === 0) return candidate;
    const remote = await moo.proc.run({ cmd: ["git", "show-ref", "--verify", "--quiet", "refs/remotes/origin/" + candidate], ...{ cwd: gitRoot, timeoutMs: 5_000 } });
    if (remote.code === 0) return "origin/" + candidate;
  }
  return null;
}

async function gitHasRemote(gitRoot: string): Promise<boolean> {
  const remotes = await moo.proc.run({ cmd: ["git", "remote"], ...{ cwd: gitRoot, timeoutMs: 5_000 } });
  return remotes.code === 0 && remotes.stdout.split("\n").some((line) => cleanGitLine(line));
}

function dedupeJjRevisions(revisions: JjRevisionItem[]): JjRevisionItem[] {
  const byRev = new Map<string, JjRevisionItem>();
  for (const revision of revisions) {
    if (!revision.rev || byRev.has(revision.rev)) continue;
    byRev.set(revision.rev, revision);
  }
  return [...byRev.values()];
}

async function loadJjRevisions(jjRoot: string): Promise<{ revisions: JjRevisionItem[]; current: string | null; selected: string | null }> {
  const revisions: JjRevisionItem[] = [{ name: "Current change (@)", rev: "@", kind: "current", current: true }];
  const current = await moo.proc.run({ cmd: ["jj", "log", "--no-graph", "--limit", "1", "-r", "@", "-T", "change_id.short() ++ '\t' ++ description.first_line()"], cwd: jjRoot, timeoutMs: 5_000 });
  if (current.code === 0) {
    const [changeId = "", description = ""] = current.stdout.split("\t");
    const cleanChange = cleanGitLine(changeId);
    if (cleanChange) revisions[0] = { ...revisions[0], name: "Current change @ " + cleanChange, description: cleanGitLine(description) || null };
  }
  const trunk = await moo.proc.run({ cmd: ["jj", "log", "--no-graph", "--limit", "1", "-r", "trunk()", "-T", "change_id.short() ++ '\t' ++ description.first_line()"], cwd: jjRoot, timeoutMs: 5_000 });
  if (trunk.code === 0 && trunk.stdout.trim()) {
    const [changeId = "", description = ""] = trunk.stdout.split("\t");
    revisions.push({ name: "Trunk " + cleanGitLine(changeId), rev: "trunk()", kind: "trunk", description: cleanGitLine(description) || null });
  }
  const bookmarks = await moo.proc.run({ cmd: ["jj", "bookmark", "list", "--template", "name ++ '\t' ++ if(remote, remote, '') ++ '\n'"], cwd: jjRoot, timeoutMs: 5_000 });
  if (bookmarks.code === 0) {
    for (const line of bookmarks.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [rawName = "", rawRemote = ""] = line.split("\t");
      const name = cleanGitLine(rawName);
      const remote = cleanGitLine(rawRemote);
      if (!name) continue;
      const rev = remote ? name + "@" + remote : name;
      revisions.push({ name: remote ? name + " (" + remote + ")" : name, rev, kind: "bookmark" });
    }
  }
  const recent = await moo.proc.run({ cmd: ["jj", "log", "--no-graph", "--limit", "12", "-r", "visible_heads() | ancestors(@, 6)", "-T", "change_id.short() ++ '\t' ++ description.first_line() ++ '\n'"], cwd: jjRoot, timeoutMs: 5_000 });
  if (recent.code === 0) {
    for (const line of recent.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [rawChange = "", rawDescription = ""] = line.split("\t");
      const change = cleanGitLine(rawChange);
      if (!change) continue;
      const description = cleanGitLine(rawDescription) || null;
      revisions.push({ name: description ? change + " — " + description : change, rev: change, kind: "recent", description });
    }
  }
  const deduped = dedupeJjRevisions(revisions);
  return { revisions: deduped, current: "@", selected: deduped[0]?.rev || "@" };
}

async function loadGitBranches(path: string, fetched = false, message: string | null = null): Promise<GitBranchesValue> {
  const base = await normalizeDirMaterializingChatWorktree(path);
  const [jjRepo, repo, jjAvailable] = await Promise.all([jjRepoInfo(base), gitRepoInfo(base), isJjAvailable()]);
  if (jjRepo && !repo) {
    const jj = await loadJjRevisions(jjRepo.jjRoot);
    return { path: base, gitRoot: null, repoRoot: jjRepo.jjRoot, repoKind: "jj", isRepo: true, branches: [], jjRevisions: jj.revisions, currentBranch: null, defaultBranch: null, selectedBranch: null, currentJjRevision: jj.current, selectedJjRevision: jj.selected, hasRemote: false, jjAvailable, fetched, message };
  }
  if (!repo) {
    return { path: base, gitRoot: null, repoRoot: null, repoKind: null, isRepo: false, branches: [], currentBranch: null, defaultBranch: null, selectedBranch: null, hasRemote: false, jjAvailable, fetched, message };
  }
  const cacheKey = repo.gitRoot;
  if (!fetched) {
    const cached = gitBranchesCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return { ...cached.value, path: base, message };
  }
  const [branchesResult, remotesResult, jjRevisionsResult] = await Promise.all([
    moo.proc.run({
      cmd: ["git", "for-each-ref", "--format=%(HEAD)%00%(refname:short)%00%(refname)%00%(upstream:short)%00%(symref:short)", "refs/heads", "refs/remotes"],
      ...{ cwd: repo.gitRoot, timeoutMs: 10_000 },
    }),
    moo.proc.run({ cmd: ["git", "remote"], ...{ cwd: repo.gitRoot, timeoutMs: 5_000 } }),
    jjRepo ? loadJjRevisions(jjRepo.jjRoot) : Promise.resolve(null),
  ]);
  let currentBranch: string | null = null;
  let defaultBranchResult: string | null = null;
  const branches: GitBranchItem[] = [];
  if (branchesResult.code === 0) {
    for (const line of branchesResult.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [rawHead = "", rawName = "", rawRef = "", rawUpstream = "", rawSymref = ""] = line.split("\0");
      let name = cleanGitLine(rawName);
      const fullRef = cleanGitLine(rawRef);
      const upstream = cleanGitLine(rawUpstream) || null;
      const symref = cleanGitLine(rawSymref).replace(/^refs\/remotes\//, "").replace(/^refs\/heads\//, "");
      if (!name || !fullRef) continue;
      if (fullRef.endsWith("/HEAD") || name === "origin/HEAD" || /\/HEAD$/.test(name)) {
        if (!defaultBranchResult && symref) defaultBranchResult = symref;
        continue;
      }
      const kind: GitBranchItem["kind"] = fullRef.startsWith("refs/remotes/") ? "remote" : "local";
      if (kind === "remote" && name.startsWith("remotes/")) name = name.slice("remotes/".length);
      const isCurrent = cleanGitLine(rawHead) === "*";
      if (isCurrent && kind === "local") currentBranch = name;
      branches.push({ name, ref: name, kind, current: isCurrent, upstream });
    }
  }
  const deduped = dedupeGitBranches(branches);
  if (!defaultBranchResult) {
    if (deduped.some((branch) => branch.ref === "main")) defaultBranchResult = "main";
    else if (deduped.some((branch) => branch.ref === "master")) defaultBranchResult = "master";
    else if (deduped.some((branch) => branch.ref === "origin/main")) defaultBranchResult = "origin/main";
    else if (deduped.some((branch) => branch.ref === "origin/master")) defaultBranchResult = "origin/master";
  }
  const hasRemote = remotesResult.code === 0 && remotesResult.stdout.split("\n").some((line) => cleanGitLine(line));
  const selectedBranch = currentBranch || defaultBranchResult || deduped[0]?.ref || null;
  const value: GitBranchesValue = {
    path: base,
    gitRoot: repo.gitRoot,
    repoRoot: repo.gitRoot,
    repoKind: jjRepo ? "jj" : "git",
    isRepo: true,
    branches: jjRepo ? [] : deduped,
    jjRevisions: jjRevisionsResult?.revisions,
    currentBranch: jjRepo ? null : currentBranch,
    defaultBranch: jjRepo ? null : defaultBranchResult,
    selectedBranch: jjRepo ? null : selectedBranch,
    currentJjRevision: jjRevisionsResult?.current ?? null,
    selectedJjRevision: jjRevisionsResult?.selected ?? null,
    hasRemote: jjRepo ? false : hasRemote,
    jjAvailable: Boolean(jjRepo && jjAvailable),
    fetched,
    message,
  };
  gitBranchesCache.set(cacheKey, { expiresAt: Date.now() + GIT_BRANCHES_CACHE_MS, value });
  return value;
}

export async function fsGitBranchesCommand(input: Input) {
  try {
    return { ok: true, value: await loadGitBranches(typeof input.path === "string" ? input.path : ".") };
  } catch (e: any) {
    return { ok: false, error: { message: e?.message || String(e) } };
  }
}

export async function fsGitPullBranchesCommand(input: Input) {
  try {
    const path = typeof input.path === "string" ? input.path : ".";
    const base = await normalizeDirMaterializingChatWorktree(path);
    const repo = await gitRepoInfo(base);
    if (!repo) return { ok: false, error: { message: "not a git repository: " + base } };
    const before = await gitHasRemote(repo.gitRoot);
    if (!before) return { ok: false, error: { message: "no git remotes configured for " + repo.gitRoot } };
    const fetch = await moo.proc.run({ cmd: ["git", "fetch", "--all", "--prune"], ...{ cwd: repo.gitRoot, timeoutMs: 60_000, maxOutputBytes: 120_000 } });
    if (fetch.code !== 0) {
      return { ok: false, error: { message: (fetch.stderr || fetch.stdout || "git fetch failed").trim() } };
    }
    const message = (fetch.stderr || fetch.stdout || "Fetched remote branches").trim();
    gitBranchesCache.delete(repo.gitRoot);
    return { ok: true, value: await loadGitBranches(base, true, message || "Fetched remote branches") };
  } catch (e: any) {
    return { ok: false, error: { message: e?.message || String(e) } };
  }
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

type FsChangeStats = { changed: boolean; additions: number; deletions: number };

type FsDiffStats = { added: number; removed: number; lines: number };

function normalizeFsRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function relativePathWithin(root: string, path: string): string | null {
  const cleanRoot = root.replace(/\/+$/, "");
  const cleanPath = path.replace(/\/+$/, "");
  if (cleanPath === cleanRoot) return "";
  if (cleanPath.startsWith(cleanRoot + "/")) return normalizeFsRelativePath(cleanPath.slice(cleanRoot.length + 1));
  return null;
}

function addFsChange(stats: Map<string, FsChangeStats>, relativePath: string, additions = 0, deletions = 0) {
  const clean = normalizeFsRelativePath(relativePath);
  if (!clean || clean.split("/").some((part) => !part || part === "..")) return;
  const rootPrev = stats.get("") ?? { changed: false, additions: 0, deletions: 0 };
  stats.set("", { changed: true, additions: rootPrev.additions + additions, deletions: rootPrev.deletions + deletions });
  const parts = clean.split("/");
  for (let i = 1; i <= parts.length; i += 1) {
    const key = parts.slice(0, i).join("/");
    const prev = stats.get(key) ?? { changed: false, additions: 0, deletions: 0 };
    stats.set(key, { changed: true, additions: prev.additions + additions, deletions: prev.deletions + deletions });
  }
}

async function countTextFileLines(path: string): Promise<number> {
  try {
    const stat = await moo.fs.stat({ path: path });
    if (stat?.kind !== "file" || stat.size > 1_000_000) return 0;
    const content = await moo.fs.read({ path: path });
    if (!content) return 0;
    const lines = content.split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.length;
  } catch {
    return 0;
  }
}

async function gitFsChangeStats(basePath: string): Promise<Map<string, FsChangeStats> | null> {
  let base: string;
  try {
    base = await normalizeDirMaterializingChatWorktree(basePath);
  } catch {
    return null;
  }
  const rootResult = await moo.proc.run({
    cmd: ["git", "rev-parse", "--show-toplevel"],
    ...{ cwd: base, timeoutMs: 5_000 },
  });
  if (rootResult.code !== 0) return null;
  const gitRoot = rootResult.stdout.trim();
  if (!gitRoot) return null;
  const prefix = relativePathWithin(gitRoot, base);
  if (prefix === null) return null;
  const stats = new Map<string, FsChangeStats>();
  const args = ["status", "--porcelain=v1", "--untracked-files=all"];
  if (prefix) args.push("--", prefix);
  const status = await moo.proc.run({ cmd: ["git", ...args], ...{ cwd: gitRoot, timeoutMs: 10_000 } });
  if (status.code !== 0) return null;
  for (const line of status.stdout.split("\n")) {
    if (line.length < 4) continue;
    const statusCode = line.slice(0, 2);
    let file = line.slice(3).trim();
    const arrow = file.indexOf(" -> ");
    if (arrow >= 0) file = file.slice(arrow + 4).trim();
    if (!file) continue;
    const rel = prefix ? relativePathWithin(prefix, file) : normalizeFsRelativePath(file);
    if (rel !== null) {
      const additions = statusCode === "??" ? await countTextFileLines(joinChildPath(gitRoot, file)) : 0;
      addFsChange(stats, rel, additions, 0);
    }
  }
  const numstatArgs = ["diff", "--numstat", "HEAD", "--"];
  if (prefix) numstatArgs.push(prefix);
  const numstat = await moo.proc.run({ cmd: ["git", ...numstatArgs], ...{ cwd: gitRoot, timeoutMs: 10_000 } });
  if (numstat.code === 0) {
    for (const line of numstat.stdout.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const additions = /^\d+$/.test(parts[0]) ? Number(parts[0]) : 0;
      const deletions = /^\d+$/.test(parts[1]) ? Number(parts[1]) : 0;
      let pathPart = parts.slice(2).join("\t");
      const arrow = pathPart.indexOf(" => ");
      if (arrow >= 0 && pathPart.includes("{")) {
        pathPart = pathPart.slice(arrow + 4).replace(/[{}]/g, "").trim();
      } else {
        const renameArrow = pathPart.indexOf(" -> ");
        if (renameArrow >= 0) pathPart = pathPart.slice(renameArrow + 4).trim();
      }
      const rel = prefix ? relativePathWithin(prefix, pathPart) : normalizeFsRelativePath(pathPart);
      if (rel !== null) addFsChange(stats, rel, additions, deletions);
    }
  }
  return stats;
}

function diffStatsFromText(diff: string): FsDiffStats {
  const lines = diff ? diff.split("\n").length : 0;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed, lines };
}

async function jjRepoInfo(
  basePath: string,
): Promise<{ jjRoot: string; prefix: string } | null> {
  let base: string;
  try {
    base = await normalizeDirMaterializingChatWorktree(basePath);
  } catch {
    return null;
  }
  const rootResult = await moo.proc.run({ cmd: ["jj", "root"], ...{ cwd: base, timeoutMs: 5_000 } });
  if (rootResult.code !== 0) return null;
  const jjRoot = rootResult.stdout.trim();
  if (!jjRoot) return null;
  const prefix = relativePathWithin(jjRoot, base);
  if (prefix === null) return null;
  return { jjRoot, prefix };
}

async function gitRepoInfo(
  basePath: string,
): Promise<{ gitRoot: string; prefix: string } | null> {
  let base: string;
  try {
    base = await normalizeDirMaterializingChatWorktree(basePath);
  } catch {
    return null;
  }
  const rootResult = await moo.proc.run({ cmd: ["git", "rev-parse", "--show-toplevel"], ...{ cwd: base, timeoutMs: 5_000 } });
  if (rootResult.code !== 0) return null;
  const gitRoot = rootResult.stdout.trim();
  if (!gitRoot) return null;
  const prefix = relativePathWithin(gitRoot, base);
  if (prefix === null) return null;
  return { gitRoot, prefix };
}

async function gitTrackedFileDiff(
  basePath: string,
  path: string,
): Promise<{ diff: string; stats: FsDiffStats } | null> {
  const info = await gitRepoInfo(basePath);
  if (!info) return null;
  const rel = relativePathWithin(info.gitRoot, path);
  if (rel === null) return null;
  const args = ["diff", "--no-ext-diff", "--no-color", "HEAD"];
  if (info.prefix) args.push("--relative=" + info.prefix);
  args.push("--", rel);
  const result = await moo.proc.run({
    cmd: ["git", ...args],
    ...{ cwd: info.gitRoot, timeoutMs: 10_000, maxOutputBytes: 5_000_000 },
  });
  if (result.code !== 0 || !result.stdout.trim()) return null;
  return {
    diff: result.stdout.trimEnd(),
    stats: diffStatsFromText(result.stdout),
  };
}

async function isGitUntrackedFile(
  basePath: string,
  path: string,
): Promise<boolean> {
  const info = await gitRepoInfo(basePath);
  if (!info) return false;
  const rel = relativePathWithin(info.gitRoot, path);
  if (rel === null) return false;
  const result = await moo.proc.run({
    cmd: ["git", "ls-files", "--others", "--exclude-standard", "--", rel],
    ...{ cwd: info.gitRoot, timeoutMs: 5_000 },
  });
  if (result.code !== 0) return false;
  return result.stdout
    .split("\n")
    .some((line) => normalizeFsRelativePath(line) === normalizeFsRelativePath(rel));
}

function untrackedFileDiff(
  content: string,
  displayPath: string,
): { diff: string; stats: FsDiffStats } {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.length ? normalized.split("\n") : [];
  if (lines[lines.length - 1] === "") lines.pop();
  const header = ["--- /dev/null", "+++ b/" + displayPath];
  if (lines.length === 0) {
    const diff = [...header, "@@ -0,0 +1,0 @@", " (empty file)"].join("\n");
    return { diff, stats: { added: 0, removed: 0, lines: header.length + 2 } };
  }
  const body = [
    "@@ -0,0 +1," + lines.length + " @@",
    ...lines.map((line) => "+" + line),
  ];
  return {
    diff: [...header, ...body].join("\n"),
    stats: {
      added: lines.length,
      removed: 0,
      lines: header.length + body.length,
    },
  };
}

async function currentFileDiff(
  basePath: string,
  path: string,
  content: string,
): Promise<{ diff: string; stats: FsDiffStats } | null> {
  const tracked = await gitTrackedFileDiff(basePath, path);
  if (tracked) return tracked;
  if (!(await isGitUntrackedFile(basePath, path))) return null;
  const base = await normalizeDirMaterializingChatWorktree(basePath);
  const displayPath =
    relativePathWithin(base, path) ?? normalizeFsRelativePath(path);
  return untrackedFileDiff(content, displayPath || path);
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
  if (candidate.startsWith(q + "/")) return 92_000 - relativePath.length;
  if (candidate.startsWith(q)) return 90_000 - relativePath.length;
  if (candidate.includes("/" + q + "/")) return 88_000 - relativePath.length;
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
  { at: number; promise: Promise<Map<string, { relativePath: string; kind: string }>> }
>();

async function gitFsSearchCandidates(base: string): Promise<Map<string, { relativePath: string; kind: string }> | null> {
  const result = await moo.proc.run({ cmd: ["git", "ls-files", "-co", "--exclude-standard"], ...{
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
      names = await moo.fs.list({ path: absDir });
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name || name.includes("/")) continue;
      const relativePath = dir ? dir + "/" + name : name;
      const stat = await moo.fs.stat({ path: joinChildPath(base, relativePath) });
      const kind = stat?.kind || "unknown";
      addFsSearchCandidate(candidates, relativePath, kind);
      visited += 1;
      if (kind === "dir" && !shouldSkipFsSearchDir(name)) queue.push(relativePath);
      if (visited >= maxVisited) break;
    }
  }

  return candidates;
}

async function cachedFsSearchCandidates(base: string): Promise<Map<string, { relativePath: string; kind: string }>> {
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
    base = await normalizeDirMaterializingChatWorktree(typeof input.path === "string" ? input.path : ".");
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
      const base = await normalizeDirMaterializingChatWorktree(basePath);
      path = base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
    } catch (e: any) {
      return { ok: false, error: { message: e?.message || String(e) } };
    }
  }
  const includeDiff = input.includeDiff === true;

  const normalizedBasePath = basePath ? await normalizeDirMaterializingChatWorktree(basePath) : null;
  const changeStats = normalizedBasePath ? await gitFsChangeStats(normalizedBasePath) : null;
  const relativePath = normalizedBasePath ? relativePathWithin(normalizedBasePath, path) : null;
  const changed = relativePath === null ? null : changeStats?.get(relativePath);

  const stat = await moo.fs.stat({ path: path });
  if (!stat) {
    return { ok: false, error: { message: `File not found: ${requestedPath}` } };
  }
  if (stat.kind !== "file") {
    if (stat.kind !== "dir") {
      return { ok: false, error: { message: `Not a file or directory: ${requestedPath}` } };
    }

    let names: string[];
    try {
      names = await moo.fs.list({ path: path });
    } catch (e: any) {
      return { ok: false, error: { message: e?.message || String(e) } };
    }
    const entries = await Promise.all(names.map(async (name) => {
      const child = joinChildPath(path, name);
      const childStat = await moo.fs.stat({ path: child });
      const childRelative = relativePath === null ? null : normalizeFsRelativePath(relativePath ? relativePath + "/" + name : name);
      const childChanged = childRelative ? changeStats?.get(childRelative) : null;
      return { name, path: child, kind: childStat?.kind || "unknown", size: childStat?.size || 0, mtime: childStat?.mtime || 0, ...(childChanged ? childChanged : {}) };
    }));
    entries.sort(sortFsEntries);
    return { ok: true, value: { path, kind: stat.kind, size: stat.size, mtime: stat.mtime, content: "", entries, ...(changed ? changed : {}) } };
  }

  try {
    const content = await moo.fs.read({ path: path });
    const currentDiff = includeDiff && normalizedBasePath && changed?.changed
      ? await currentFileDiff(normalizedBasePath, path, content)
      : null;
    return { ok: true, value: { path, kind: stat.kind, size: stat.size, mtime: stat.mtime, content, ...(changed ? changed : {}), ...(currentDiff ? { diff: currentDiff.diff, diffStats: currentDiff.stats } : {}) } };
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
  const branch = path && typeof input.branch === "string" && input.branch.trim() ? input.branch.trim() : null;
  const useExistingWorktree = Boolean(path && input.useExistingWorktree === true);
  const cid = await moo.chat.create({ chatId: input.chatId, path: path, branch, useExistingWorktree });
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
  return { ok: true, value: { chatId: cid, path, branch, baseBranch: branch, worktreePath: useExistingWorktree ? path : await moo.chat.scratch({ chatId: cid }), recent } };
}


function parseHistoryAt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isAddAction(action: string): boolean {
  return action === "+" || action === "add" || action === "added";
}

function snapshotCopyChatFacts(sourceStore: string, targetStore: string, cutoffAt: number, fromGraph: string, toGraph: string): number {
  return host.copyFactSnapshot(sourceStore, targetStore, cutoffAt, fromGraph, toGraph);
}

function stepAddedAt(history: FactHistoryRow[], stepId: string): number {
  for (const row of history) {
    if (row[1] !== stepId) continue;
    if (row[2] !== "rdf:type" || row[3] !== "agent:Step") continue;
    if (isAddAction(String(row[4] ?? ""))) return parseHistoryAt(row[5]);
  }
  return 0;
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

async function copyRefIfPresent(from: string, to: string) {
  const value = await moo.pointers.get({ name: from });
  if (value != null) await moo.pointers.set({ name: to, target: value });
}

export async function chatForkCommand(input: Input) {
  const sourceChatId = String(input.chatId || input.sourceChatId || "").trim();
  const stepId = String(input.step || input.stepId || input.fromStepId || "").trim();
  if (!sourceChatId) return { ok: false, error: { message: "chat-fork requires chatId" } };
  if (!stepId) return { ok: false, error: { message: "chat-fork requires step" } };

  const sourceRefs = chatRefs(sourceChatId);
  const stepHistoryPromise = moo.facts.history({
    store: sourceRefs.facts,
    ...{ graph: sourceRefs.graph, subject: stepId, predicate: "rdf:type", object: "agent:Step", limit: 1 },
  });
  const sourcePathPromise = moo.pointers.get({ name: "chat/" + sourceChatId + "/path" });
  const sourceTitlePromise = moo.pointers.get({ name: "chat/" + sourceChatId + "/title" });
  const stepHistory = await stepHistoryPromise;
  const cutoffAt = stepAddedAt(stepHistory, stepId);
  if (!cutoffAt) {
    return { ok: false, error: { message: "step not found in " + sourceChatId + ": " + stepId } };
  }

  const [sourcePath, sourceTitle] = await Promise.all([sourcePathPromise, sourceTitlePromise]);
  const sourceBranch = await moo.pointers.get({ name: sourceRefs.startBranch });
  const forkChatId = await moo.chat.create({ chatId: input.forkChatId || input.newChatId, path: sourcePath || null, ...{ branch: sourceBranch } });
  const forkRefs = chatRefs(forkChatId);

  const copiedFacts = snapshotCopyChatFacts(sourceRefs.facts, forkRefs.facts, cutoffAt, sourceRefs.graph, forkRefs.graph);

  await Promise.all([
    copyRefIfPresent(sourceRefs.model, forkRefs.model),
    copyRefIfPresent(sourceRefs.effort, forkRefs.effort),
    copyRefIfPresent(sourceRefs.startBranch, forkRefs.startBranch),
  ]);

  await moo.pointers.set({ name: forkRefs.head, target: stepId });
  await moo.pointers.set({ name: "chat/" + forkChatId + "/parent", target: sourceChatId });
  await moo.pointers.set({ name: "chat/" + forkChatId + "/forked-from-step", target: stepId });
  await moo.pointers.set({ name: "chat/" + forkChatId + "/forked-from-at", target: String(cutoffAt) });
  await moo.chat.setTitle({ chatId: forkChatId, title: forkTitle(sourceTitle, sourceChatId) });
  await moo.chat.recordSummary({
    chatId: forkChatId,
    title: "Forked chat",
    summary: "Forked from " + (sourceTitle || sourceChatId) + " at " + stepId + ".",
  });
  await moo.facts.addAll({ store: forkRefs.facts, quads: [
    [forkRefs.graph, forkRefs.graph, "agent:forkedFromChat", "chat:" + sourceChatId],
    [forkRefs.graph, forkRefs.graph, "agent:forkedFromStep", stepId],
    [forkRefs.graph, forkRefs.graph, "agent:forkedFromAt", String(cutoffAt)],
    [forkRefs.graph, forkRefs.graph, "agent:forkedFromTitle", literalString(sourceTitle || sourceChatId)],
  ] });
  await moo.chat.touch({ chatId: forkChatId });

  return { ok: true, value: {
    chatId: forkChatId,
    sourceChatId,
    forkedFromStep: stepId,
    forkedFromAt: cutoffAt,
    path: sourcePath || null,
    baseBranch: sourceBranch || null,
    worktreePath: await chatWorktreePath(forkChatId),
    copiedFacts,
  } };
}

export async function chatRemoveCommand(input: Input) {
  if (!input.chatId) {
    return { ok: false, error: { message: "chat-rm requires chatId" } };
  }
  const result = await moo.chat.remove({ chatId: input.chatId });
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
    const result = await moo.chat.remove({ chatId: chatId });
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
  const receipt = await moo.chat.setTitle({ chatId: input.chatId, title, manual: true });
  return { ok: true, value: { chatId: input.chatId, title: receipt.title } };
}

export async function chatArchiveCommand(input: Input) {
  if (!input.chatId) {
    return { ok: false, error: { message: "chat-archive requires chatId" } };
  }
  const archived = input.archived !== false;
  const archivedAt = archived ? await moo.chat.archive({ chatId: input.chatId }) : await moo.chat.unarchive({ chatId: input.chatId });
  return { ok: true, value: { chatId: input.chatId, archived, archivedAt } };
}

