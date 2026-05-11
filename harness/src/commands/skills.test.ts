import { beforeEach, describe, expect, test } from "bun:test";

import { skillGetCommand, skillsListCommand } from "./skills";

const refs = new Map<string, string>();
const files = new Map<string, string>();
let scratchCalls = 0;

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

function putFile(path: string, content: string): void {
  files.set(normalizePath(path), content);
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

globalThis.__op_now = () => Date.UTC(2026, 0, 1);
globalThis.__op_id = (prefix: string) => prefix + ":test";
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
globalThis.__op_object_put = (kind: string) => "sha256:" + kind.padEnd(64, "0").slice(0, 64);
globalThis.__op_object_get = () => null;
globalThis.__op_fs_read = (path: string) => {
  const content = files.get(normalizePath(path));
  if (content == null) throw new Error("not found: " + path);
  return content;
};
globalThis.__op_fs_write = (path: string, content: string) => { files.set(normalizePath(path), content); };
globalThis.__op_fs_mkdir = (path: string) => {
  scratchCalls += String(path).includes("/moo/") ? 1 : 0;
};
globalThis.__op_fs_list = (path: string) => dirChildren(path);
globalThis.__op_fs_glob = () => [];
globalThis.__op_fs_stat = (path: string) => {
  const normalized = normalizePath(path);
  if (files.has(normalized)) return { kind: "file", size: files.get(normalized)!.length, mtime: Date.UTC(2026, 0, 2) };
  if (dirExists(normalized)) return { kind: "dir", size: 0, mtime: Date.UTC(2026, 0, 2) };
  return null;
};
globalThis.__op_fs_canonical = (path: string) => normalizePath(path);
globalThis.__op_env_get = (name: string) => name === "HOME" ? "/home/test" : null;
globalThis.__op_proc_run = () => {
  scratchCalls += 1;
  return { code: 1, stdout: "", stderr: "", durationNs: 0, timedOut: false };
};
globalThis.__op_http_fetch = () => ({ status: 404, headers: "{}", body: "" });
globalThis.__op_broadcast = () => {};
globalThis.__op_chat_running_ids = () => "[]";
globalThis.__op_chat_running_started_at = () => "{}";
globalThis.__op_trace_current = () => "null";
globalThis.__op_trace_start_root = () => JSON.stringify({ id: "trace:test", traceId: "trace:test" });
globalThis.__op_trace_finish = () => "true";
globalThis.__op_trace_insert = () => "null";
globalThis.__op_trace_set_parent = () => null;
globalThis.__op_trace_leave = () => {};
globalThis.__op_trace_get = () => "null";
globalThis.__op_trace_events = () => "[]";
globalThis.__op_trace_recent = () => "[]";
globalThis.__op_trace_enabled = () => false;
globalThis.__op_trace_ensure_root = () => "null";
globalThis.__op_trace_ensure_span = () => "null";

describe("skill commands", () => {
  beforeEach(() => {
    refs.clear();
    files.clear();
    scratchCalls = 0;
  });

  test("skill reads use an existing worktree without materializing chat scratch", async () => {
    putFile("/home/test/moo/chat1/.skills/local.md", "---\nname: Local\n---\n\nLocal skill.");
    refs.set("chat/chat1/path", "/repo");

    const listed = await skillsListCommand({ chatId: "chat1" });
    const loaded = await skillGetCommand({ chatId: "chat1", id: "local" });

    expect(listed.ok).toBe(true);
    expect((listed as any).value.skills.map((skill: any) => skill.id)).toContain("local");
    expect((loaded as any).value.skill.content).toContain("Local skill");
    expect(scratchCalls).toBe(0);
  });

  test("skill reads fall back to chat repo path without creating a worktree", async () => {
    refs.set("chat/chat1/path", "/repo");
    putFile("/repo/.skills/repo.md", "---\nname: Repo Skill\n---\n\nRepo body.");

    const listed = await skillsListCommand({ chatId: "chat1" });

    expect(listed.ok).toBe(true);
    expect((listed as any).value.skills.map((skill: any) => skill.id)).toContain("repo-skill");
    expect(scratchCalls).toBe(0);
  });
});
