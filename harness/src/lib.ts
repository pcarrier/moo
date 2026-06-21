import { z } from "zod";
import type { ObjectInput, Quad } from "./types";

const MAX_FACT_OBJECT_BYTES = 2048;
const HASH_RE = /^(sha256:)?[a-f0-9]{64}$/i;
export const JSON_POINTER_PREFIX = "json:";

export { z };

export function isSha256Hash(value: unknown): boolean {
  return typeof value === "string" && HASH_RE.test(value);
}

export function encodeJsonPointer(value: unknown): string {
  return JSON_POINTER_PREFIX + (JSON.stringify(value) ?? "null");
}

export function decodeJsonPointer<T = unknown>(target: string | null | undefined, schema?: z.ZodType<T>): T | null {
  if (typeof target !== "string" || !target.startsWith(JSON_POINTER_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(target.slice(JSON_POINTER_PREFIX.length));
  } catch (_) {
    return null;
  }
  if (schema) {
    const result = schema.safeParse(parsed);
    if (!result.success) return null;
    return result.data;
  }
  return parsed as T;
}

export function assertFactObject(object: string): void {
  if (typeof object !== "string") return;
  if (object.length <= MAX_FACT_OBJECT_BYTES) return;
  if (isSha256Hash(object)) return;
  throw new Error(
    `fact object is ${object.length} bytes; store large payloads with moo.objects.put and assert the hash instead`,
  );
}

export function assertFactObjects(quads: Quad[]): void {
  for (const [, , , object] of quads) assertFactObject(object);
}

export function unpackQuad(
  q: Quad | { graph: string; subject: string; predicate: string; object: ObjectInput },
): [string, string, string, ObjectInput] {
  if (Array.isArray(q)) return q;
  return [q.graph, q.subject, q.predicate, q.object];
}

export function stringifyForLog(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch (_) {
    return String(v);
  }
}

export function truncate(s: unknown, n: number): string {
  if (s == null) return "";
  const str = String(s);
  return str.length > n ? str.slice(0, n) + `…(${str.length - n} more)` : str;
}

export function maybeQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

export function formatToolArgs(tool: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  if (tool === "shell") {
    const cmd = args.cmd || "";
    const arr: string[] = Array.isArray(args.args) ? args.args : [];
    return [cmd, ...arr].map(maybeQuote).join(" ");
  }
  if (tool === "read_file" || tool === "list_files") {
    return args.path ? maybeQuote(args.path) : "";
  }
  if (tool === "write_file") {
    return args.path ? `${maybeQuote(args.path)}, ${args.bytes ?? "?"} bytes` : "";
  }
  return JSON.stringify(args);
}


export function parseArgv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  let hadToken = false;
  for (const ch of line) {
    if (escaping) {
      if (ch === "n") cur += "\n";
      else if (ch === "r") cur += "\r";
      else if (ch === "t") cur += "\t";
      else cur += ch;
      escaping = false;
      hadToken = true;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      hadToken = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      hadToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch as "'" | '"';
      hadToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hadToken) {
        out.push(cur);
        cur = "";
        hadToken = false;
      }
      continue;
    }
    cur += ch;
    hadToken = true;
  }
  if (escaping) throw new Error("unterminated escape in command line");
  if (quote) throw new Error("unbalanced quote in command line");
  if (hadToken) out.push(cur);
  return out;
}


export function chatRefs(chatId: string) {
  return {
    facts: `chat/${chatId}/facts`,
    head: `chat/${chatId}/head`,
    run: `chat/${chatId}/run`,
    graph: `chat:${chatId}`,
    createdAt: `chat/${chatId}/created-at`,
    lastAt: `chat/${chatId}/last-at`,
    compaction: `chat/${chatId}/compaction`,
    usage: `chat/${chatId}/usage`,
    model: `chat/${chatId}/model`,
    provider: `chat/${chatId}/provider`,
    effort: `chat/${chatId}/effort`,
    startBranch: `chat/${chatId}/start-branch`,
  };
}

export function safeWorktreePath(wt: string, path: string | undefined): string | null {
  if (typeof path !== "string" || path.length === 0) return null;
  if (path.startsWith("/")) return null;
  if (path.split("/").some((seg) => seg === "..")) return null;
  return `${wt}/${path}`;
}
