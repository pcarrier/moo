import * as host from "./host_ops";
import { decodeJsonPointer, encodeJsonPointer } from "./lib";
import type { MooSkillsApi, Skill, SkillFrontmatter, SkillListArgs, SkillMeta, SkillQueryOptions, SkillRefreshResult, SkillSaveInput, SkillSummary } from "./types";
import { BUILTIN_SKILLS } from "./builtin_skills";

const INDEX_REF = "skills/index";
const CONTENT_KIND = "skill:content";
const VERSION = 2;
const BUILTIN_TIME = "1970-01-01T00:00:00.000Z";
const REPO_SKILLS_DIR = ".skills";
const REPO_CONTENT_PREFIX = "repo:";
const BUILTIN_CONTENT_PREFIX = "builtin:";
const MAX_REPO_SKILL_FILES = 240;
const MAX_REPO_SKILL_DEPTH = 8;

type SkillIndex = { version: number; skills: SkillMeta[]; updatedAt?: string };
type RootOptions = { root?: string | null };
type SkillRootProvider = () => string | null | undefined | Promise<string | null | undefined>;

let skillRootProvider: SkillRootProvider | null = null;

export function setSkillRootProvider(provider: SkillRootProvider | null): void {
  skillRootProvider = provider;
}

const nowIso = () => new Date(host.now()).toISOString();
const clean = (value: unknown) => value == null ? "" : String(value).trim();
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const compareStrings = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sortByName = (a: SkillMeta, b: SkillMeta) => {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  return an < bn ? -1 : an > bn ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

function slug(value: string, fallback = "skill"): string {
  const lower = value.trim().toLowerCase();
  let out = "";
  let dash = false;
  for (let i = 0; i < lower.length && out.length < 72; i += 1) {
    const ch = lower[i]!;
    const code = ch.charCodeAt(0);
    const ok = (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
    if (ok) {
      out += ch;
      dash = false;
    } else if (out && !dash) {
      out += "-";
      dash = true;
    }
  }
  return out.replace(/-+$/g, "") || fallback;
}

function normalizeUrl(value: unknown): string | undefined {
  const url = clean(value);
  return url || undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function storedUrl(value: unknown): string | undefined {
  const record = objectRecord(value);
  const source = objectRecord(record?.source);
  return normalizeUrl(record?.url) ?? normalizeUrl(source?.url);
}

function inputUrl(input: SkillSaveInput): string {
  return clean(input.url);
}

function normalizeFrontmatter(value: unknown): SkillFrontmatter {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: SkillFrontmatter = {};
  for (const [key, raw] of Object.entries(value)) {
    const k = key.trim();
    if (!k) continue;
    if (raw == null) out[k] = null;
    else if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") out[k] = raw;
    else if (Array.isArray(raw)) out[k] = raw.map((item) => item == null ? null : typeof item === "string" || typeof item === "number" || typeof item === "boolean" ? item : String(item));
    else out[k] = String(raw);
  }
  return out;
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (!value) return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1).split(",").map((part) => clean(part).replace(/^[']|[']$/g, "").replace(/^[\"]|[\"]$/g, "")).filter(Boolean);
  return value.replace(/^[']|[']$/g, "").replace(/^[\"]|[\"]$/g, "");
}

export function parseSkillMarkdown(content: string): { frontmatterRaw: string; frontmatter: SkillFrontmatter; body: string } {
  const text = String(content ?? "");
  if (!text.startsWith("---\n") && text !== "---") return { frontmatterRaw: "", frontmatter: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { frontmatterRaw: "", frontmatter: {}, body: text };
  const frontmatterRaw = text.slice(4, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const frontmatter: SkillFrontmatter = {};
  const lines = frontmatterRaw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const split = trimmed.indexOf(":");
    if (split <= 0) continue;
    const key = trimmed.slice(0, split).trim();
    if (!key) continue;
    const rawValue = trimmed.slice(split + 1).trim();
    if (rawValue === ">" || rawValue === "|") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) block.push(lines[++i].trim());
      frontmatter[key] = (rawValue === ">" ? block.join(" ") : block.join("\n")) as SkillFrontmatter[string];
    } else {
      frontmatter[key] = parseScalar(rawValue) as SkillFrontmatter[string];
    }
  }
  return { frontmatterRaw, frontmatter, body };
}

function normalizeMeta(value: any): SkillMeta | null {
  if (!value || typeof value !== "object") return null;
  if (value.builtin === true || value.source?.kind === "builtin" || value.repo === true || value.source?.kind === "repo") return null;
  const id = slug(clean(value.id));
  const name = clean(value.name) || id;
  const contentHash = clean(value.contentHash);
  if (!id || !contentHash) return null;
  const url = storedUrl(value);
  return {
    version: VERSION,
    id,
    name,
    enabled: value.enabled !== false,
    url,
    source: { kind: "user", ...(url ? { url } : {}) },
    frontmatter: normalizeFrontmatter(value.frontmatter),
    frontmatterRaw: typeof value.frontmatterRaw === "string" ? value.frontmatterRaw : undefined,
    contentHash,
    createdAt: clean(value.createdAt) || nowIso(),
    updatedAt: clean(value.updatedAt) || nowIso(),
    lastRefreshError: clean(value.lastRefreshError) || undefined,
  };
}

function parseIndex(): SkillIndex {
  const raw = decodeJsonPointer<any>(host.getRef(INDEX_REF));
  const rows: unknown[] = Array.isArray(raw?.skills) ? raw.skills : [];
  const skills = rows.map((row: unknown) => normalizeMeta(row)).filter((row): row is SkillMeta => !!row).sort(sortByName);
  return { version: VERSION, skills, updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : undefined };
}

function writeIndex(skills: SkillMeta[], updatedAt = nowIso()): void {
  const unique = new Map<string, SkillMeta>();
  for (const skill of skills) {
    if (skill.builtin || skill.repo || skill.source?.kind === "repo" || skill.source?.kind === "builtin") continue;
    unique.set(skill.id, { ...skill, builtin: undefined, repo: undefined, source: { kind: "user", ...(skill.url ? { url: skill.url } : {}) } });
  }
  host.setRef(INDEX_REF, encodeJsonPointer({ version: VERSION, skills: [...unique.values()].sort(sortByName), updatedAt }));
}

function stripTrailingSlash(path: string): string {
  const trimmed = clean(path);
  if (trimmed === "/") return trimmed;
  return trimmed.replace(/\/+$/g, "");
}

function joinPath(root: string, child: string): string {
  const base = stripTrailingSlash(root);
  const rel = clean(child).replace(/^\/+/, "");
  return rel ? `${base}/${rel}` : base;
}

function basename(path: string): string {
  const parts = clean(path).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function dirname(path: string): string {
  const parts = clean(path).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function stripExtension(path: string): string {
  return path.replace(/\.(md|markdown)$/i, "");
}

function relativeTo(root: string, path: string): string {
  const prefix = stripTrailingSlash(root) + "/";
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function skillFileName(path: string): boolean {
  const lower = basename(path).toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function safeStat(path: string): host.FsStat | null {
  try {
    return host.statFile(path);
  } catch {
    return null;
  }
}

function safeRead(path: string): string {
  try {
    return host.readFile(path);
  } catch {
    return "";
  }
}

function safeList(path: string): string[] {
  try {
    return host.listDir(path).slice().sort(compareStrings);
  } catch {
    return [];
  }
}

function safeCanonical(path: string): string {
  try {
    return stripTrailingSlash(host.canonicalPath(path));
  } catch {
    return stripTrailingSlash(path);
  }
}

function repoSkillFiles(root: string): string[] {
  const dir = joinPath(root, REPO_SKILLS_DIR);
  const dirStat = safeStat(dir);
  if (!dirStat || dirStat.kind !== "dir") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: Array<{ path: string; depth: number }> = [{ path: dir, depth: 0 }];
  while (stack.length && out.length < MAX_REPO_SKILL_FILES) {
    const current = stack.shift()!;
    for (const entry of safeList(current.path)) {
      if (!entry || entry === "." || entry === "..") continue;
      const child = joinPath(current.path, entry);
      const stat = safeStat(child);
      if (!stat) continue;
      if (stat.kind === "dir") {
        if (current.depth < MAX_REPO_SKILL_DEPTH) stack.push({ path: child, depth: current.depth + 1 });
      } else if (stat.kind === "file" && skillFileName(entry) && !seen.has(child)) {
        seen.add(child);
        out.push(child);
        if (out.length >= MAX_REPO_SKILL_FILES) break;
      }
    }
  }
  return out.sort(compareStrings);
}

function repoSkillFallbackName(relativePath: string): string {
  const file = basename(relativePath);
  const lower = file.toLowerCase();
  if (lower === "skill.md" || lower === "skill.markdown") {
    const parent = basename(dirname(relativePath));
    if (parent) return parent;
  }
  return stripExtension(file) || "Repo skill";
}

function repoSkillEnabled(frontmatter: SkillFrontmatter): boolean {
  const value = frontmatter.enabled;
  if (value === false) return false;
  if (typeof value === "string" && value.trim().toLowerCase() === "false") return false;
  return true;
}

function repoSkillUpdatedAt(path: string): string {
  const mtime = safeStat(path)?.mtime;
  return typeof mtime === "number" && Number.isFinite(mtime) && mtime > 0 ? new Date(mtime).toISOString() : nowIso();
}

function uniqueRepoId(base: string, relativePath: string, seen: Set<string>): string {
  let id = slug(base, "repo-skill");
  if (!seen.has(id)) {
    seen.add(id);
    return id;
  }
  const suffix = slug(stripExtension(relativePath).replace(/\//g, "-"), "repo-skill");
  let next = `${id}-${suffix}`;
  let n = 2;
  while (seen.has(next)) next = `${id}-${suffix}-${n++}`;
  seen.add(next);
  return next;
}

function repoSkillMetas(root?: string | null): SkillMeta[] {
  const rawRoot = clean(root);
  if (!rawRoot) return [];
  const scanRoot = safeCanonical(rawRoot);
  const files = repoSkillFiles(scanRoot);
  const seenIds = new Set<string>();
  const metas: SkillMeta[] = [];
  for (const file of files) {
    const content = safeRead(file);
    if (!content.trim()) continue;
    const parsed = parseSkillMarkdown(content);
    const frontmatter = Object.keys(parsed.frontmatter).length ? parsed.frontmatter : {};
    const relativePath = relativeTo(scanRoot, file);
    const fallbackName = repoSkillFallbackName(relativePath);
    const name = clean(frontmatter.name ?? frontmatter.title) || fallbackName;
    const id = uniqueRepoId(clean(frontmatter.id) || name || fallbackName, relativePath, seenIds);
    const at = repoSkillUpdatedAt(file);
    metas.push({
      version: VERSION,
      id,
      name,
      enabled: repoSkillEnabled(frontmatter),
      repo: true,
      source: { kind: "repo", path: relativePath, root: scanRoot },
      frontmatter,
      frontmatterRaw: parsed.frontmatterRaw || undefined,
      contentHash: `${REPO_CONTENT_PREFIX}${file}`,
      createdAt: at,
      updatedAt: at,
    });
  }
  return metas.sort(sortByName);
}

async function repoRootFromOptions(opts?: RootOptions | null): Promise<string | null> {
  if (opts && typeof opts === "object" && hasOwn(opts, "root")) return clean(opts.root) || null;
  return skillRootProvider ? clean(await skillRootProvider()) || null : null;
}

function builtinMetas(): SkillMeta[] {
  const seen = new Set<string>();
  const metas: SkillMeta[] = [];
  for (const builtin of BUILTIN_SKILLS) {
    const id = slug(clean(builtin.id) || clean(builtin.name) || "skill");
    if (seen.has(id)) continue;
    seen.add(id);
    const parsed = parseSkillMarkdown(builtin.content);
    const frontmatter = Object.keys(parsed.frontmatter).length ? parsed.frontmatter : {};
    const name = clean(builtin.name)
      || clean(frontmatter.name ?? frontmatter.title)
      || id;
    metas.push({
      version: VERSION,
      id,
      name,
      enabled: builtin.enabled !== false,
      builtin: true,
      source: { kind: "builtin" },
      frontmatter,
      frontmatterRaw: parsed.frontmatterRaw || undefined,
      contentHash: `${BUILTIN_CONTENT_PREFIX}${id}`,
      createdAt: BUILTIN_TIME,
      updatedAt: BUILTIN_TIME,
    });
  }
  return metas.sort(sortByName);
}

function shadowKeys(skill: SkillMeta): string[] {
  const keys = [skill.id.toLowerCase(), skill.name.toLowerCase(), slug(skill.name)];
  return keys.map((key) => key.toLowerCase()).filter(Boolean);
}

function addShadowKeys(shadowed: Set<string>, skill: SkillMeta): void {
  for (const key of shadowKeys(skill)) shadowed.add(key);
}

function visibleUnshadowed(skills: SkillMeta[], shadowed: Set<string>): SkillMeta[] {
  const out: SkillMeta[] = [];
  for (const skill of skills) {
    const keys = shadowKeys(skill);
    if (keys.some((key) => shadowed.has(key))) continue;
    out.push(skill);
    addShadowKeys(shadowed, skill);
  }
  return out;
}

function allMetas(root?: string | null): SkillMeta[] {
  const stored = parseIndex().skills;
  const shadowed = new Set<string>();
  for (const skill of stored) addShadowKeys(shadowed, skill);
  const repo = visibleUnshadowed(repoSkillMetas(root), shadowed);
  const builtins = visibleUnshadowed(builtinMetas(), shadowed);
  return [...stored, ...repo, ...builtins].sort(sortByName);
}

function matchesSkill(skill: SkillMeta, key: string): boolean {
  return skill.id.toLowerCase() === key || skill.name.toLowerCase() === key || slug(skill.name) === key;
}

function findStoredMeta(idOrName: string): SkillMeta | null {
  const key = clean(idOrName).toLowerCase();
  if (!key) return null;
  return parseIndex().skills.find((skill) => matchesSkill(skill, key)) ?? null;
}

function findMeta(idOrName: string, root?: string | null): SkillMeta | null {
  const key = clean(idOrName).toLowerCase();
  if (!key) return null;
  return findStoredMeta(key)
    ?? repoSkillMetas(root).find((skill) => matchesSkill(skill, key))
    ?? builtinMetas().find((skill) => matchesSkill(skill, key))
    ?? null;
}

function loadContent(hash: string): string {
  if (hash.startsWith(BUILTIN_CONTENT_PREFIX)) {
    const id = hash.slice(BUILTIN_CONTENT_PREFIX.length);
    const builtin = BUILTIN_SKILLS.find((skill) => slug(clean(skill.id) || clean(skill.name) || "skill") === id);
    return builtin?.content ?? "";
  }
  if (hash.startsWith(REPO_CONTENT_PREFIX)) {
    const path = hash.slice(REPO_CONTENT_PREFIX.length);
    return safeRead(path);
  }
  return host.getObject(hash)?.content ?? "";
}

function asSkill(meta: SkillMeta): Skill {
  return { ...meta, content: loadContent(meta.contentHash) };
}

function inferName(input: SkillSaveInput, parsed: { frontmatter: SkillFrontmatter }, existing?: SkillMeta | null): string {
  return clean(input.name)
    || clean(parsed.frontmatter.name ?? parsed.frontmatter.title)
    || existing?.name
    || clean(inputUrl(input).split(/[?#]/)[0]?.split("/").filter(Boolean).pop())
    || clean(input.id)
    || "Untitled skill";
}

function chooseId(input: SkillSaveInput, name: string, existing: SkillMeta | null, current: SkillMeta[]): string {
  if (existing) return existing.id;
  const base = slug(clean(input.id) || name || inputUrl(input));
  if (!current.some((skill) => skill.id === base)) return base;
  return `${base}-${host.newId("skill").replace(/[^a-zA-Z0-9]+/g, "").slice(-8) || String(host.now()).slice(-6)}`;
}

function saveSkill(input: SkillSaveInput, opts: { clearRefreshError?: boolean } = {}): Skill {
  const index = parseIndex();
  const explicitId = clean(input.id);
  const inputName = clean(input.name);
  const existing = (explicitId ? findStoredMeta(explicitId) : null) ?? (inputName ? findStoredMeta(inputName) : null);
  const existingContent = existing ? loadContent(existing.contentHash) : "";
  const content = input.content == null ? existingContent : String(input.content);
  const parsed = parseSkillMarkdown(content);
  const frontmatter = Object.keys(parsed.frontmatter).length ? parsed.frontmatter : normalizeFrontmatter(input.frontmatter);
  const name = inferName(input, { frontmatter }, existing);
  const id = chooseId(input, name, existing, index.skills);
  const url = hasOwn(input, "url") ? normalizeUrl(input.url) : existing?.url;
  const at = nowIso();
  const urlChanged = url !== existing?.url;
  const meta: SkillMeta = {
    version: VERSION,
    id,
    name,
    enabled: input.enabled == null ? existing?.enabled !== false : input.enabled !== false,
    url,
    source: { kind: "user", ...(url ? { url } : {}) },
    frontmatter,
    frontmatterRaw: parsed.frontmatterRaw || undefined,
    contentHash: host.putObject(CONTENT_KIND, content),
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
    lastRefreshError: opts.clearRefreshError || urlChanged ? undefined : existing?.lastRefreshError,
  };
  writeIndex([...index.skills.filter((skill) => skill.id !== id), meta], at);
  return asSkill(meta);
}

export const skills: MooSkillsApi = {
  async list(args: SkillListArgs = {}) {
    const root = await repoRootFromOptions(args);
    const rows = allMetas(root);
    return args.enabled == null ? rows : rows.filter((skill) => skill.enabled === args.enabled);
  },
  async get(idOrName: string, opts?: SkillQueryOptions) {
    return findMeta(idOrName, await repoRootFromOptions(opts));
  },
  async load(idOrName: string, opts?: SkillQueryOptions) {
    const meta = findMeta(idOrName, await repoRootFromOptions(opts));
    return meta ? asSkill(meta) : null;
  },
  async content(idOrName: string, opts?: SkillQueryOptions) {
    const meta = findMeta(idOrName, await repoRootFromOptions(opts));
    return meta ? loadContent(meta.contentHash) : null;
  },
  async save(input: SkillSaveInput) {
    return saveSkill(input);
  },
  async upsert(input: SkillSaveInput) {
    return saveSkill(input);
  },
  async delete(idOrName: string) {
    const meta = findStoredMeta(idOrName);
    if (!meta) return false;
    writeIndex(parseIndex().skills.filter((skill) => skill.id !== meta.id));
    return true;
  },
  async remove(idOrName: string) {
    return this.delete(idOrName);
  },
  async refresh(idOrName: string, opts = {}): Promise<SkillRefreshResult> {
    const meta = findStoredMeta(idOrName);
    if (!meta) {
      const readonly = findMeta(idOrName, await repoRootFromOptions(opts));
      if (readonly?.builtin) return { ok: false, refreshed: false, skill: asSkill(readonly), error: "builtin skill cannot be refreshed" };
      if (readonly?.repo || readonly?.source?.kind === "repo") return { ok: false, refreshed: false, skill: asSkill(readonly), error: "repo skill cannot be refreshed" };
      return { ok: false, refreshed: false, skill: null, error: "skill not found" };
    }
    if (!meta.url) return { ok: false, refreshed: false, skill: asSkill(meta), error: "skill has no URL" };
    try {
      const response = host.fetchHttp("GET", meta.url, JSON.stringify({ Accept: "text/markdown, text/plain, */*" }), null, opts.timeoutMs ?? 60_000);
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
      const skill = saveSkill({ id: meta.id, name: meta.name, enabled: meta.enabled, url: meta.url, content: response.body }, { clearRefreshError: true });
      return { ok: true, refreshed: true, skill };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const at = nowIso();
      const next = { ...meta, lastRefreshError: message };
      writeIndex([...parseIndex().skills.filter((skill) => skill.id !== meta.id), next], at);
      return { ok: false, refreshed: false, skill: asSkill(next), error: message };
    }
  },
  parseMarkdown(content: string) {
    return parseSkillMarkdown(content);
  },
};
