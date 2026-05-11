import { moo } from "../moo";
import type { SkillFrontmatter, SkillSaveInput } from "../types";
import type { Input } from "./_shared";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || "unknown error");
}

function skillInput(input: Input): SkillSaveInput {
  const out: SkillSaveInput = {};
  if (input.id != null) out.id = String(input.id);
  if (input.name != null) out.name = String(input.name);
  if (input.enabled != null) out.enabled = input.enabled !== false;
  if (input.url != null) out.url = String(input.url);
  if (input.content != null) out.content = String(input.content);
  if (input.frontmatter && typeof input.frontmatter === "object" && !Array.isArray(input.frontmatter)) out.frontmatter = input.frontmatter as any;
  return out;
}

function clean(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function stripTrailingSlash(path: string): string {
  const stripped = path.replace(/\/+$/g, "");
  return stripped || path;
}

function joinPath(base: string, child: string): string {
  const b = stripTrailingSlash(String(base || ".")) || ".";
  return b + "/" + String(child || "").replace(/^\/+/, "");
}

async function canonicalIfPossible(path: string): Promise<string> {
  try {
    return stripTrailingSlash(await moo.fs.canonical(path));
  } catch {
    return stripTrailingSlash(path);
  }
}

function nameFromContent(content: string, frontmatter: SkillFrontmatter): string | undefined {
  const raw = frontmatter.name ?? frontmatter.title;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || undefined;
}

async function existingChatRoot(chatId: string): Promise<string | undefined> {
  const home = clean(await moo.env.get("HOME"));
  const worktree = joinPath(home ? joinPath(home, "moo") : "moo", chatId);
  try {
    if (await moo.fs.exists(worktree)) return await canonicalIfPossible(worktree);
  } catch {
    // Fall through to the chat's source repo path. Skill reads should never
    // materialize or repair the per-chat worktree just to populate /skills.
  }
  try {
    const root = clean(await moo.pointers.get(`chat/${chatId}/path`));
    return root ? await canonicalIfPossible(root) : undefined;
  } catch {
    return undefined;
  }
}

async function skillRoot(input: Input): Promise<string | undefined> {
  const root = clean(input.root);
  if (root) return root;
  const chatId = clean(input.chatId);
  return chatId ? existingChatRoot(chatId) : undefined;
}

async function skillQueryOptions(input: Input): Promise<{ root?: string }> {
  const root = await skillRoot(input);
  return root ? { root } : {};
}

export async function skillsListCommand(input: Input) {
  try {
    const enabled = input.enabled == null ? undefined : input.enabled !== false;
    const opts = await skillQueryOptions(input);
    return { ok: true, value: { skills: await moo.skills.list({ ...opts, ...(enabled == null ? {} : { enabled }) }) } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function skillGetCommand(input: Input) {
  const id = String(input.id ?? input.name ?? "").trim();
  if (!id) return { ok: false, error: { message: "skill-get requires id" } };
  try {
    return { ok: true, value: { skill: await moo.skills.load(id, await skillQueryOptions(input)) } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function skillDownloadCommand(input: Input) {
  const url = clean(input.url);
  if (!url) return { ok: false, error: { message: "skill-download requires url" } };
  try {
    const response = await moo.http.fetch({ method: "GET", url, headers: { Accept: "text/markdown, text/plain, */*" }, timeoutMs: input.timeoutMs == null ? undefined : Number(input.timeoutMs) });
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    const parsed = moo.skills.parseMarkdown(response.body);
    return {
      ok: true,
      value: {
        url,
        content: response.body,
        frontmatter: parsed.frontmatter,
        frontmatterRaw: parsed.frontmatterRaw,
        name: nameFromContent(response.body, parsed.frontmatter),
      },
    };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function skillSaveCommand(input: Input) {
  try {
    const skill = await moo.skills.save(skillInput(input));
    return { ok: true, value: { skill } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function skillRemoveCommand(input: Input) {
  const id = String(input.id ?? input.name ?? "").trim();
  if (!id) return { ok: false, error: { message: "skill-remove requires id" } };
  try {
    return { ok: true, value: { id, removed: await moo.skills.delete(id) } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function skillRefreshCommand(input: Input) {
  const id = String(input.id ?? input.name ?? "").trim();
  if (!id) return { ok: false, error: { message: "skill-refresh requires id" } };
  try {
    return { ok: true, value: await moo.skills.refresh(id, { ...(await skillQueryOptions(input)), timeoutMs: input.timeoutMs == null ? undefined : Number(input.timeoutMs) }) };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}
