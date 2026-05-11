import { beforeEach, describe, expect, test } from "bun:test";

import { parseSkillMarkdown, setSkillRootProvider, skills } from "./skills";

const refs = new Map<string, string>();
const objects = new Map<string, { kind: string; content: string }>();
const files = new Map<string, { content: string; mtime: number }>();
let now = Date.UTC(2026, 0, 1);
let idSeq = 0;
let objectSeq = 0;
let httpResponse = { status: 404, headers: "{}", body: "" };
let lastFetchUrl = "";

globalThis.__op_now = () => now++;
globalThis.__op_id = (prefix: string) => prefix + ":" + (++idSeq);
globalThis.__op_ref_get = (name: string) => refs.get(name) ?? null;
globalThis.__op_ref_set = (name: string, target: string) => { refs.set(name, target); };
globalThis.__op_ref_cas = (name: string, expected: string | null, next: string) => {
  const current = refs.get(name) ?? null;
  if (current !== expected) return false;
  refs.set(name, next);
  return true;
};
globalThis.__op_refs_list = (prefix: string) => Array.from(refs.keys()).filter((name) => name.startsWith(prefix));
globalThis.__op_refs_entries = (prefix: string) => JSON.stringify(Array.from(refs.entries()).filter(([name]) => name.startsWith(prefix)));
globalThis.__op_ref_delete = (name: string) => refs.delete(name);
globalThis.__op_object_put = (kind: string, content: string) => {
  const hash = "sha256:" + String(++objectSeq).padStart(64, "0");
  objects.set(hash, { kind, content });
  return hash;
};
globalThis.__op_object_get = (hash: string) => objects.get(hash) ?? null;
globalThis.__op_http_fetch = (_method: string, url: string) => {
  lastFetchUrl = url;
  return httpResponse;
};

function normalizePath(path: string): string {
  const raw = String(path || "/");
  const absolute = raw.startsWith("/");
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return (absolute ? "/" : "") + parts.join("/") || (absolute ? "/" : ".");
}

function putFile(path: string, content: string, mtime = Date.UTC(2026, 0, 2)): void {
  files.set(normalizePath(path), { content, mtime });
}

function dirExists(path: string): boolean {
  const dir = normalizePath(path);
  if (dir === "/") return true;
  const prefix = dir.replace(/\/+$/g, "") + "/";
  for (const file of files.keys()) if (file.startsWith(prefix)) return true;
  return false;
}

function dirChildren(path: string): string[] {
  const dir = normalizePath(path).replace(/\/+$/g, "");
  const prefix = dir === "/" ? "/" : dir + "/";
  const out = new Set<string>();
  for (const file of files.keys()) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const child = rest.split("/")[0];
    if (child) out.add(child);
  }
  return [...out].sort();
}

globalThis.__op_fs_read = (path: string) => {
  const file = files.get(normalizePath(path));
  if (!file) throw new Error("not found: " + path);
  return file.content;
};
globalThis.__op_fs_write = (path: string, content: string) => {
  files.set(normalizePath(path), { content, mtime: now });
};
globalThis.__op_fs_delete = (path: string) => {
  files.delete(normalizePath(path));
};
globalThis.__op_fs_mkdir = () => {};
globalThis.__op_fs_list = (path: string) => dirChildren(path);
globalThis.__op_fs_glob = () => [];
globalThis.__op_fs_stat = (path: string) => {
  const normalized = normalizePath(path);
  const file = files.get(normalized);
  if (file) return { kind: "file", size: file.content.length, mtime: file.mtime };
  if (dirExists(normalized)) return { kind: "dir", size: 0, mtime: Date.UTC(2026, 0, 2) };
  return null;
};
globalThis.__op_fs_canonical = (path: string) => normalizePath(path);

describe("moo.skills", () => {
  beforeEach(() => {
    refs.clear();
    objects.clear();
    files.clear();
    setSkillRootProvider(null);
    now = Date.UTC(2026, 0, 1);
    idSeq = 0;
    objectSeq = 0;
    httpResponse = { status: 404, headers: "{}", body: "" };
    lastFetchUrl = "";
  });

  test("parses multiline frontmatter blocks", () => {
    const parsed = parseSkillMarkdown([
      "---",
      "description: >",
      "  Terminal multiplexer and Wayland compositor.",
      "  Use when driving GUIs.",
      "notes: |",
      "  line one",
      "  line two",
      "---",
      "",
      "Body",
    ].join("\n"));

    expect(parsed.frontmatter.description).toBe("Terminal multiplexer and Wayland compositor. Use when driving GUIs.");
    expect(parsed.frontmatter.notes).toBe("line one\nline two");
  });

  test("exposes builtin apps skill", async () => {
    const skill = await skills.load("apps");

    expect(skill?.builtin).toBe(true);
    expect(skill?.source).toEqual({ kind: "builtin" });
    expect(skill?.frontmatter.description).toContain("harness UI apps");
    expect(skill?.content).toContain("moo.ui.apps.register");
    expect(skill?.content).toContain("await moo.ui.apps.open({chatId,uiId,instanceId?,state?})");
    expect(skill?.content).toContain("broadcasts a live `ui-open` event");
  });

  test("saves editable skills in pointers and objects", async () => {
    const skill = await skills.save({
      name: "Code Review",
      enabled: true,
      content: "---\ndescription: Review code carefully\ntags: [code, review]\n---\n\nUse a checklist.",
    });

    expect(skill.id).toBe("code-review");
    expect(skill.url).toBeUndefined();
    expect(skill.frontmatter.description).toBe("Review code carefully");
    expect(skill.frontmatter.tags).toEqual(["code", "review"]);
    expect(skill.content).toContain("Use a checklist.");
    expect(refs.has("skills/index")).toBe(true);
    expect(refs.has("skills/code-review/meta")).toBe(false);
    expect(objects.get(skill.contentHash)?.kind).toBe("skill:content");

    const listed = await skills.list();
    expect(listed.map((item) => item.id)).toEqual(["apps", "code-review"]);
    expect("content" in listed.find((item) => item.id === "code-review")!).toBe(false);

    const loaded = await skills.load("Code Review");
    expect(loaded?.content).toContain("Use a checklist.");
  });

  test("updates saved timestamps for URL and manual saves", async () => {
    const skill = await skills.save({ name: "Remote", url: "https://example.test/skill.md", content: "fresh" });
    expect(skill.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect("fetchedAt" in skill).toBe(false);

    const manual = await skills.save({ name: "Remote", url: "", content: "manual" });
    expect(manual.url).toBeUndefined();
    expect(manual.updatedAt).toBeDefined();
    expect("fetchedAt" in manual).toBe(false);
  });

  test("refreshes skills that have URLs", async () => {
    const skill = await skills.save({ name: "Remote", url: "https://example.test/skill.md", content: "old" });
    expect(skill.url).toBe("https://example.test/skill.md");

    httpResponse = { status: 200, headers: "{}", body: "---\ndescription: Fresh\n---\n\nnew body" };
    const refreshed = await skills.refresh("remote");

    expect(refreshed.ok).toBe(true);
    expect(refreshed.skill?.content).toContain("new body");
    expect(refreshed.skill?.frontmatter.description).toBe("Fresh");
    expect(refreshed.skill?.url).toBe("https://example.test/skill.md");
    expect(refreshed.skill?.updatedAt).toBeDefined();
    expect("fetchedAt" in refreshed.skill!).toBe(false);
    expect(lastFetchUrl).toBe("https://example.test/skill.md");
  });

  test("refresh updates saved time even when content is unchanged", async () => {
    const body = "---\ndescription: Fresh\n---\n\nnew body";
    await skills.save({ name: "Remote", url: "https://example.test/skill.md", content: body });

    now = Date.UTC(2026, 0, 3);
    httpResponse = { status: 200, headers: "{}", body };
    const refreshed = await skills.refresh("remote");

    expect(refreshed.ok).toBe(true);
    expect(refreshed.skill?.content).toBe(body);
    expect(refreshed.skill?.updatedAt).toBe("2026-01-03T00:00:00.000Z");
    expect((await skills.get("remote"))?.updatedAt).toBe("2026-01-03T00:00:00.000Z");
    expect("fetchedAt" in refreshed.skill!).toBe(false);
  });

  test("loads repo skills from .skills", async () => {
    putFile("/repo/.skills/deploy.md", [
      "---",
      "name: Deploy",
      "description: Ship the repo",
      "---",
      "",
      "Use the deployment runbook.",
    ].join("\n"));
    putFile("/repo/.skills/review/skill.md", [
      "---",
      "title: Code Review",
      "enabled: false",
      "---",
      "",
      "Review carefully.",
    ].join("\n"));

    const listed = await skills.list({ root: "/repo" });
    expect(listed.map((skill) => skill.id)).toEqual(["apps", "code-review", "deploy"]);
    expect(listed.find((skill) => skill.id === "code-review")?.repo).toBe(true);
    expect(listed.find((skill) => skill.id === "code-review")?.source).toEqual({ kind: "repo", path: ".skills/review/skill.md", root: "/repo" });
    expect(listed.find((skill) => skill.id === "deploy")?.frontmatter.description).toBe("Ship the repo");
    expect(await skills.content("deploy", { root: "/repo" })).toContain("deployment runbook");
    expect((await skills.load("Code Review", { root: "/repo" }))?.content).toContain("Review carefully");
    expect((await skills.list({ root: "/repo", enabled: true })).map((skill) => skill.id)).toEqual(["apps", "deploy"]);
    expect(await skills.delete("deploy")).toBe(false);

    const builtinOnly = await skills.list();
    const missingWorktree = await skills.list({ root: "/missing-worktree" });
    expect(missingWorktree.map((skill) => skill.id)).toEqual(builtinOnly.map((skill) => skill.id));

    const refreshed = await skills.refresh("deploy", { root: "/repo" });
    expect(refreshed.ok).toBe(false);
    expect(refreshed.error).toBe("repo skill cannot be refreshed");
    expect(refreshed.skill?.repo).toBe(true);
  });

  test("stored skills shadow repo skills", async () => {
    putFile("/repo/.skills/deploy.md", "---\nname: Deploy\n---\n\nRepo deploy.");
    await skills.save({ name: "Deploy", content: "Manual deploy." });

    const listed = await skills.list({ root: "/repo" });
    expect(listed.map((skill) => skill.id)).toEqual(["apps", "deploy"]);
    expect(listed[1]?.repo).toBeUndefined();
    expect(listed[0]?.builtin).toBe(true);
    expect(await skills.content("deploy", { root: "/repo" })).toBe("Manual deploy.");
  });

  test("uses configured root provider for repo skills", async () => {
    putFile("/repo/.skills/local.md", "---\nname: Local\n---\n\nLoaded through provider.");
    setSkillRootProvider(() => "/repo");

    expect((await skills.get("local"))?.source).toEqual({ kind: "repo", path: ".skills/local.md", root: "/repo" });
    expect(await skills.content("local")).toContain("provider");
  });

  test("updates and deletes skills by name", async () => {
    await skills.save({ name: "Deploy", url: "https://example.test/deploy.md", content: "ship it" });
    await skills.save({ name: "Deploy", enabled: false, url: "", content: "ship carefully" });

    expect((await skills.get("deploy"))?.enabled).toBe(false);
    expect((await skills.get("deploy"))?.url).toBeUndefined();
    expect(await skills.content("deploy")).toBe("ship carefully");
    expect(await skills.delete("Deploy")).toBe(true);
    expect(await skills.get("deploy")).toBeNull();
    expect((await skills.list()).map((skill) => skill.id)).toEqual(["apps"]);
  });
});
