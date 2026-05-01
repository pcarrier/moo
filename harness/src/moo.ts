import type { Moo, Quad, Bindings, Triple, ObjectInput, MemoryScope, UiAskSpec, UiChooseSpec, UiBundle, UiManifest, FactQuadInput, McpServerConfig, McpTool, McpOAuthStartOptions, McpOAuthStatus, McpOAuthStart, SubagentSpec, SubagentResult, FactMutationReceipt, ProcRunArgs, ProcResult, FsPatchArgs, FsPatchReceipt, TermBindings, BindingTerm, QuadObject } from "./types";
import { err, ok, errorInfo } from "./core/result";
import { Term, MooApiError } from "./types";
import { assertFactObject, assertFactObjects, chatRefs, unpackQuad, stringifyForLog } from "./lib";
import { appendStep } from "./steps";

// IRIs and prefixed names render bare. Anything else is encoded as a Turtle
// string literal with proper escaping. Numbers and booleans become bare
// numeric/boolean literals. Variables (`?x`) pass through.
function encodeObject(o: ObjectInput): string {
  if (o instanceof Term) return o.turtle;
  if (typeof o === "number") {
    if (!Number.isFinite(o)) return `"${String(o)}"`;
    return String(o);
  }
  if (typeof o === "boolean") return o ? "true" : "false";
  if (typeof o === "string") {
    if (o.startsWith("?")) return o; // variable
    if (/^[A-Za-z][A-Za-z0-9_-]*:[^\s]+$/.test(o)) return o; // prefixed IRI
    if (/^<[^>\s]+>$/.test(o)) return o; // full IRI
    return encodeStringLiteral(o);
  }
  return encodeStringLiteral(String(o));
}

function encodeStringLiteral(s: string): string {
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out + '"';
}

const HASH_RE = /^(sha256:)?[a-f0-9]{64}$/i;
const UI_APP_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const REF_NAME_RE = /^[^\s]+$/;
const GRAPH_NAME_RE = /^[^\s]+$/;

const validate: Moo["validate"] = {
  refName(name) {
    return typeof name === "string" && name.length > 0 && REF_NAME_RE.test(name);
  },
  graphName(graph) {
    return typeof graph === "string" && graph.length > 0 && GRAPH_NAME_RE.test(graph);
  },
  uiAppId(id) {
    return typeof id === "string" && UI_APP_ID_RE.test(id);
  },
  hash(hash) {
    return typeof hash === "string" && HASH_RE.test(hash);
  },
  relativePath(path) {
    if (typeof path !== "string" || path.length === 0 || path.startsWith("/")) return false;
    return !path.split("/").some((seg) => seg === "..");
  },
};

const term: Moo["term"] = {
  iri(uri) {
    if (/^<[^>\s]+>$/.test(uri)) return new Term(uri);
    if (/^[A-Za-z][A-Za-z0-9_-]*:[^\s]+$/.test(uri)) return new Term(uri);
    return new Term(`<${uri}>`);
  },
  string(s, opts) {
    let t = encodeStringLiteral(s);
    if (opts?.lang) t += `@${opts.lang}`;
    else if (opts?.type) t += `^^${opts.type}`;
    return new Term(t);
  },
  int(n) {
    return new Term(String(Math.trunc(n)));
  },
  decimal(n) {
    const s = String(n);
    return new Term(s.includes(".") ? s : `${s}.0`);
  },
  bool(b) {
    return new Term(b ? "true" : "false");
  },
  datetime(d) {
    const iso = typeof d === "string" ? d : d.toISOString();
    return new Term(`"${iso}"^^xsd:dateTime`);
  },
};

const time: Moo["time"] = {
  async nowMs() {
    return __op_now();
  },
  async nowISO() {
    return new Date(__op_now()).toISOString();
  },
  async datetime(d) {
    const value = d == null ? new Date(__op_now()) : typeof d === "number" ? new Date(d) : d;
    return term.datetime(value);
  },
  async nowPlus(ms) {
    return __op_now() + Number(ms);
  },
};

const id: Moo["id"] = {
  async new(prefix = "id") {
    return __op_id(prefix);
  },
};

const log: Moo["log"] = (...args) => {
  const message = args.map(stringifyForLog).join(" ");
  const chatId = activeChatId;
  if (!chatId) return;
  const c = chatRefs(chatId);
  const logId = __op_id("log");
  const at = String(__op_now());
  __op_facts_swap(
    c.facts,
    EMPTY_JSON_ARRAY,
    JSON.stringify([
      [c.graph, logId, "rdf:type", "agent:Log"],
      [c.graph, logId, "agent:createdBy", "agent:moo"],
      [c.graph, logId, "agent:createdAt", at],
      [c.graph, logId, "agent:message", message],
    ]),
  );
};

let activeChatId: string | null = null;
let activeRunJSContext: { chatId: string; runJsStepId: string; depth: number; outstanding: Set<string> } | null = null;

export async function withMooChatContext<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const previous = activeChatId;
  activeChatId = chatId;
  try {
    return await fn();
  } finally {
    activeChatId = previous;
  }
}

export async function withMooRunJSContext<T>(
  chatId: string,
  runJsStepId: string,
  depth: number,
  fn: () => Promise<T>,
): Promise<T> {
  const previousChat = activeChatId;
  const previousRunJS = activeRunJSContext;
  activeChatId = chatId;
  activeRunJSContext = { chatId, runJsStepId, depth, outstanding: new Set() };
  try {
    return await fn();
  } finally {
    const ctx = activeRunJSContext;
    activeRunJSContext = previousRunJS;
    activeChatId = previousChat;
    if (ctx) {
      for (const childChatId of ctx.outstanding) {
        try {
          await markOutstandingSubagentCancelled(ctx.chatId, childChatId, "runJS finished before awaiting this subagent");
        } catch {
          // best effort only
        }
      }
    }
  }
}

function splitLinesForDiff(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type DiffStats = { added: number; removed: number; lines: number };

const DIFF_CONTEXT_LINES = 3;
const MAX_EXACT_DIFF_CELLS = 2_000_000;
const EMPTY_JSON_ARRAY = "[]";

type LineOp = { kind: "equal" | "insert" | "delete"; line: string };
type DiffAnchor = { oldIndex: number; newIndex: number };
type UniqueLineInfo = { oldCount: number; oldIndex: number; newCount: number; newIndex: number };
type UnifiedDiffBody = { lines: string[]; added: number; removed: number };

function unifiedDiffWithStats(path: string, before: string | null, after: string): { diff: string; stats: DiffStats } {
  const oldLines = splitLinesForDiff(before ?? "");
  const newLines = splitLinesForDiff(after);
  const ops = patienceLineDiff(oldLines, newLines);
  const from = before == null ? "/dev/null" : "a/" + path;
  const header = ["--- " + from, "+++ b/" + path];
  const body = unifiedDiffBody(ops, DIFF_CONTEXT_LINES);

  if (body.added === 0 && body.removed === 0) {
    const diff = [...header, "@@ -1,0 +1,0 @@", " (no textual changes)"].join("\n");
    return { diff, stats: { added: 0, removed: 0, lines: header.length + 2 } };
  }

  const diff = [...header, ...body.lines].join("\n");
  return { diff, stats: { added: body.added, removed: body.removed, lines: header.length + body.lines.length } };
}

function patienceLineDiff(oldLines: string[], newLines: string[]): LineOp[] {
  const ops: LineOp[] = [];
  appendPatienceDiff(oldLines, newLines, 0, oldLines.length, 0, newLines.length, ops);
  return ops;
}

function appendPatienceDiff(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
  out: LineOp[],
): void {
  while (oldStart < oldEnd && newStart < newEnd && oldLines[oldStart] === newLines[newStart]) {
    out.push({ kind: "equal", line: oldLines[oldStart]! });
    oldStart++;
    newStart++;
  }

  const commonSuffix: string[] = [];
  while (oldStart < oldEnd && newStart < newEnd && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    commonSuffix.push(oldLines[oldEnd - 1]!);
    oldEnd--;
    newEnd--;
  }

  if (oldStart === oldEnd) {
    for (let j = newStart; j < newEnd; j++) out.push({ kind: "insert", line: newLines[j]! });
    appendCommonSuffix(commonSuffix, out);
    return;
  }
  if (newStart === newEnd) {
    for (let i = oldStart; i < oldEnd; i++) out.push({ kind: "delete", line: oldLines[i]! });
    appendCommonSuffix(commonSuffix, out);
    return;
  }

  const anchors = patienceAnchors(oldLines, newLines, oldStart, oldEnd, newStart, newEnd);
  if (anchors.length === 0) {
    appendFallbackLineDiff(oldLines, newLines, oldStart, oldEnd, newStart, newEnd, out);
  } else {
    let oldCursor = oldStart;
    let newCursor = newStart;
    for (const anchor of anchors) {
      appendPatienceDiff(oldLines, newLines, oldCursor, anchor.oldIndex, newCursor, anchor.newIndex, out);
      out.push({ kind: "equal", line: oldLines[anchor.oldIndex]! });
      oldCursor = anchor.oldIndex + 1;
      newCursor = anchor.newIndex + 1;
    }
    appendPatienceDiff(oldLines, newLines, oldCursor, oldEnd, newCursor, newEnd, out);
  }

  appendCommonSuffix(commonSuffix, out);
}

function appendCommonSuffix(commonSuffix: string[], out: LineOp[]): void {
  for (let i = commonSuffix.length - 1; i >= 0; i--) out.push({ kind: "equal", line: commonSuffix[i]! });
}

function patienceAnchors(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): DiffAnchor[] {
  const counts = new Map<string, UniqueLineInfo>();

  for (let i = oldStart; i < oldEnd; i++) {
    const line = oldLines[i]!;
    let info = counts.get(line);
    if (!info) {
      info = { oldCount: 0, oldIndex: i, newCount: 0, newIndex: -1 };
      counts.set(line, info);
    }
    info.oldCount++;
    if (info.oldCount === 1) info.oldIndex = i;
  }

  for (let j = newStart; j < newEnd; j++) {
    const line = newLines[j]!;
    let info = counts.get(line);
    if (!info) {
      info = { oldCount: 0, oldIndex: -1, newCount: 0, newIndex: j };
      counts.set(line, info);
    }
    info.newCount++;
    if (info.newCount === 1) info.newIndex = j;
  }

  const candidates: DiffAnchor[] = [];
  for (const info of counts.values()) {
    if (info.oldCount === 1 && info.newCount === 1) candidates.push({ oldIndex: info.oldIndex, newIndex: info.newIndex });
  }
  candidates.sort((a, b) => a.oldIndex - b.oldIndex);
  return longestIncreasingNewIndexSubsequence(candidates);
}

function longestIncreasingNewIndexSubsequence(candidates: DiffAnchor[]): DiffAnchor[] {
  if (candidates.length <= 1) return candidates;

  const tails: number[] = [];
  const previous = new Array<number>(candidates.length).fill(-1);

  for (let i = 0; i < candidates.length; i++) {
    const value = candidates[i]!.newIndex;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candidates[tails[mid]!]!.newIndex < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tails[lo - 1]!;
    tails[lo] = i;
  }

  const result = new Array<DiffAnchor>(tails.length);
  let cursor = tails[tails.length - 1]!;
  for (let i = tails.length - 1; i >= 0; i--) {
    result[i] = candidates[cursor]!;
    cursor = previous[cursor]!;
  }
  return result;
}

function appendFallbackLineDiff(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
  out: LineOp[],
): void {
  const oldCount = oldEnd - oldStart;
  const newCount = newEnd - newStart;

  if (oldCount === 0) {
    for (let j = newStart; j < newEnd; j++) out.push({ kind: "insert", line: newLines[j]! });
    return;
  }
  if (newCount === 0) {
    for (let i = oldStart; i < oldEnd; i++) out.push({ kind: "delete", line: oldLines[i]! });
    return;
  }

  const cells = (oldCount + 1) * (newCount + 1);
  if (cells > MAX_EXACT_DIFF_CELLS) {
    for (let i = oldStart; i < oldEnd; i++) out.push({ kind: "delete", line: oldLines[i]! });
    for (let j = newStart; j < newEnd; j++) out.push({ kind: "insert", line: newLines[j]! });
    return;
  }

  const width = newCount + 1;
  const dp = new Uint32Array(cells);
  for (let i = oldCount - 1; i >= 0; i--) {
    for (let j = newCount - 1; j >= 0; j--) {
      dp[i * width + j] = oldLines[oldStart + i] === newLines[newStart + j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < oldCount && j < newCount) {
    if (oldLines[oldStart + i] === newLines[newStart + j]) {
      out.push({ kind: "equal", line: oldLines[oldStart + i]! });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      out.push({ kind: "delete", line: oldLines[oldStart + i]! });
      i++;
    } else {
      out.push({ kind: "insert", line: newLines[newStart + j]! });
      j++;
    }
  }
  while (i < oldCount) out.push({ kind: "delete", line: oldLines[oldStart + i++]! });
  while (j < newCount) out.push({ kind: "insert", line: newLines[newStart + j++]! });
}

function unifiedDiffBody(ops: LineOp[], contextLines: number): UnifiedDiffBody {
  const lines: LineOp[] = [];
  const oldPrefixCounts: number[] = [0];
  const newPrefixCounts: number[] = [0];
  const changeIndexes: number[] = [];
  let added = 0;
  let removed = 0;

  for (const op of ops) {
    const index = lines.length;
    lines.push(op);
    if (op.kind === "insert") added++;
    else if (op.kind === "delete") removed++;
    if (op.kind !== "equal") changeIndexes.push(index);

    oldPrefixCounts.push(oldPrefixCounts[oldPrefixCounts.length - 1]! + (op.kind === "insert" ? 0 : 1));
    newPrefixCounts.push(newPrefixCounts[newPrefixCounts.length - 1]! + (op.kind === "delete" ? 0 : 1));
  }

  if (changeIndexes.length === 0) return { lines: [], added, removed };

  const hunkLines: string[] = [];
  let hunkStart = Math.max(0, changeIndexes[0]! - contextLines);
  let hunkEnd = Math.min(lines.length, changeIndexes[0]! + contextLines + 1);

  const emitHunk = (start: number, end: number) => {
    const oldBefore = oldPrefixCounts[start]!;
    const newBefore = newPrefixCounts[start]!;
    const oldLength = oldPrefixCounts[end]! - oldBefore;
    const newLength = newPrefixCounts[end]! - newBefore;
    const oldStart = oldLength === 0 ? oldBefore : oldBefore + 1;
    const newStart = newLength === 0 ? newBefore : newBefore + 1;
    hunkLines.push("@@ -" + rangeHeader(oldStart, oldLength) + " +" + rangeHeader(newStart, newLength) + " @@");
    for (let i = start; i < end; i++) {
      const line = lines[i]!;
      const prefix = line.kind === "insert" ? "+" : line.kind === "delete" ? "-" : " ";
      hunkLines.push(prefix + line.line);
    }
  };

  for (let i = 1; i < changeIndexes.length; i++) {
    const changeIndex = changeIndexes[i]!;
    const nextStart = Math.max(0, changeIndex - contextLines);
    const nextEnd = Math.min(lines.length, changeIndex + contextLines + 1);
    if (nextStart <= hunkEnd) {
      hunkEnd = Math.max(hunkEnd, nextEnd);
    } else {
      emitHunk(hunkStart, hunkEnd);
      hunkStart = nextStart;
      hunkEnd = nextEnd;
    }
  }
  emitHunk(hunkStart, hunkEnd);

  return { lines: hunkLines, added, removed };
}

function rangeHeader(start: number, length: number): string {
  return length === 1 ? String(start) : String(start) + "," + String(length);
}

async function displayPathForChat(chatId: string, path: string): Promise<string> {
  const normalizedPath = String(path).replace(/\\/g, "/");
  const scratch = (await chat.scratch(chatId)).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!scratch) return normalizedPath;
  if (normalizedPath === scratch) return ".";
  if (normalizedPath.startsWith(scratch + "/")) return normalizedPath.slice(scratch.length + 1) || ".";
  return normalizedPath;
}

async function recordFileWriteDiff(path: string, before: string | null, after: string): Promise<void> {
  const chatId = activeChatId;
  if (!chatId) return;
  const displayPath = await displayPathForChat(chatId, path);
  const { diff, stats } = unifiedDiffWithStats(displayPath, before, after);
  const at = await time.nowMs();
  const hash = await objects.putJSON({ kind: "agent:FileDiff", value: { chatId, path: displayPath, beforeExists: before != null, before, after, diff, stats, at } });
  const { stepId } = await appendStep(chatId, {
    kind: "agent:FileDiff",
    status: "agent:Done",
    payloadHash: hash,
    extras: [["agent:path", displayPath]],
  });
  const diffId = await id.new("fsdiff");
  await refs.set(`fs-diffs/${diffId}`, hash);
  events.publish({ kind: "file-diff", chatId, path: displayPath, before, after, diff, stats, hash, stepId, at });
}


type PatchLine = { kind: "context" | "add" | "del"; text: string };
type ParsedHunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: PatchLine[] };
type ParsedFilePatch = { oldPath: string | null; newPath: string | null; hunks: ParsedHunk[] };
type TextLines = { lines: string[]; trailingNewline: boolean };

function normalizePatchArgs(args: string | FsPatchArgs): FsPatchArgs {
  if (typeof args === "string") return { patch: args };
  if (!args || typeof args !== "object") throw new MooApiError("invalid_argument", "fs.patch requires a patch string or {patch,...}");
  return args;
}

function parsePatchPath(line: string): string | null {
  let raw = line.slice(4).trim();
  if (!raw || raw === "/dev/null") return null;
  if (raw.startsWith('"')) {
    const end = raw.lastIndexOf('"');
    if (end > 0) {
      try { raw = JSON.parse(raw.slice(0, end + 1)); }
      catch { raw = raw.slice(1, end); }
      return raw === "/dev/null" ? null : raw;
    }
  }
  const tab = raw.indexOf("\t");
  if (tab >= 0) raw = raw.slice(0, tab);
  return raw === "/dev/null" ? null : raw;
}

function stripPatchPath(path: string, strip?: number | null): string {
  let p = path.replace(/\\/g, "/");
  if (strip == null) {
    if (/^[ab]\//.test(p)) p = p.slice(2);
    return p;
  }
  const n = Math.max(0, Math.floor(Number(strip) || 0));
  for (let i = 0; i < n; i++) p = p.replace(/^[^/]+\/?/, "");
  return p;
}

function resolvePatchPath(path: string, cwd?: string | null, strip?: number | null): string {
  const p = stripPatchPath(path, strip);
  if (!p) throw new MooApiError("invalid_patch", "patch path became empty after stripping", { path, strip });
  if (p.startsWith("/")) return p;
  if (cwd) {
    if (!validate.relativePath(p)) throw new MooApiError("path_escape", "patch paths under cwd must be relative and may not contain ..", { cwd, path: p });
    return joinPath(cwd, p);
  }
  return p;
}

function parseUnifiedPatch(patch: string): ParsedFilePatch[] {
  const lines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const files: ParsedFilePatch[] = [];
  let current: ParsedFilePatch | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("--- ")) {
      const next = lines[i + 1];
      if (next == null || !next.startsWith("+++ ")) throw new MooApiError("invalid_patch", "unified patch file header missing +++ line", { line: i + 1 });
      current = { oldPath: parsePatchPath(line), newPath: parsePatchPath(next), hunks: [] };
      files.push(current);
      i += 2;
      continue;
    }
    if (line.startsWith("@@ ")) {
      if (!current) throw new MooApiError("invalid_patch", "hunk appears before file header", { line: i + 1 });
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new MooApiError("invalid_patch", "bad unified hunk header", { line: i + 1, header: line });
      const hunk: ParsedHunk = {
        oldStart: Number(m[1]),
        oldCount: m[2] == null ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] == null ? 1 : Number(m[4]),
        lines: [],
      };
      i++;
      while (i < lines.length) {
        const h = lines[i]!;
        if (h.startsWith("diff --git ") || h.startsWith("--- ") || h.startsWith("@@ ")) break;
        if (h.startsWith("\\ No newline at end of file")) { i++; continue; }
        const prefix = h[0];
        if (prefix === " ") hunk.lines.push({ kind: "context", text: h.slice(1) });
        else if (prefix === "+") hunk.lines.push({ kind: "add", text: h.slice(1) });
        else if (prefix === "-") hunk.lines.push({ kind: "del", text: h.slice(1) });
        else if (h === "") {
          if (i === lines.length - 1) break;
          throw new MooApiError("invalid_patch", "empty line in hunk must be prefixed with space, +, or -", { line: i + 1 });
        } else {
          throw new MooApiError("invalid_patch", "unexpected line in hunk", { line: i + 1, text: h });
        }
        i++;
      }
      current.hunks.push(hunk);
      continue;
    }
    i++;
  }
  const withHunks = files.filter((f) => f.hunks.length > 0);
  if (!withHunks.length) throw new MooApiError("invalid_patch", "patch contains no unified hunks");
  return withHunks;
}

function splitTextLines(text: string): TextLines {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function joinTextLines(t: TextLines): string {
  return t.lines.join("\n") + (t.trailingNewline && t.lines.length ? "\n" : "");
}

function hunkOldLines(hunk: ParsedHunk): string[] {
  return hunk.lines.filter((l) => l.kind !== "add").map((l) => l.text);
}

function findHunkIndex(oldLines: string[], needle: string[], preferred: number, floor: number): number {
  const exact = matchesAt(oldLines, needle, preferred) ? preferred : -1;
  if (exact >= 0) return exact;
  if (needle.length === 0) return Math.max(floor, Math.min(preferred, oldLines.length));
  for (let i = Math.max(0, floor); i <= oldLines.length - needle.length; i++) {
    if (matchesAt(oldLines, needle, i)) return i;
  }
  return -1;
}

function matchesAt(lines: string[], needle: string[], index: number): boolean {
  if (index < 0 || index + needle.length > lines.length) return false;
  for (let j = 0; j < needle.length; j++) if (lines[index + j] !== needle[j]) return false;
  return true;
}

function applyParsedFilePatch(file: ParsedFilePatch, before: string | null): { after: string; added: number; removed: number } {
  const text = splitTextLines(before ?? "");
  const out: string[] = [];
  let cursor = 0;
  let added = 0;
  let removed = 0;
  for (const hunk of file.hunks) {
    const oldSeq = hunkOldLines(hunk);
    const preferred = Math.max(0, hunk.oldStart - 1);
    const start = findHunkIndex(text.lines, oldSeq, preferred, cursor);
    if (start < 0) throw new MooApiError("patch_mismatch", "patch hunk did not match file", { path: file.newPath ?? file.oldPath, oldStart: hunk.oldStart });
    while (cursor < start) out.push(text.lines[cursor++]!);
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        out.push(line.text);
        added++;
      } else {
        const got = text.lines[cursor];
        if (got !== line.text) throw new MooApiError("patch_mismatch", "patch line did not match file", { path: file.newPath ?? file.oldPath, expected: line.text, got });
        if (line.kind === "context") out.push(got);
        else removed++;
        cursor++;
      }
    }
  }
  while (cursor < text.lines.length) out.push(text.lines[cursor++]!);
  const trailingNewline = text.trailingNewline || added > 0 || out.length > 0;
  return { after: joinTextLines({ lines: out, trailingNewline }), added, removed };
}

function turtleTriple(subject: string, predicate: string, object: string): string {
  const pred = predicate === "rdf:type" ? "a" : predicate;
  return `${subject} ${pred} ${object} .`;
}

type MemoryChange = { subject: string; predicate: string; object: string };

function memorySnapshot(changes: MemoryChange[]): string {
  if (!changes.length) return "";
  return changes.map(({ subject, predicate, object }) => turtleTriple(subject, predicate, object)).join("\n") + "\n";
}

async function recordMemoryDiff(
  refName: string,
  graph: string,
  action: "assert" | "retract",
  changes: MemoryChange[],
): Promise<void> {
  const chatId = activeChatId;
  if (!chatId || changes.length === 0) return;
  const path = `${refName}.ttl`;
  const snapshot = memorySnapshot(changes);
  const before = action === "assert" ? "" : snapshot;
  const after = action === "assert" ? snapshot : "";
  const { diff, stats } = unifiedDiffWithStats(path, before, after);
  const at = await time.nowMs();
  const first = changes[0]!;
  const payload: Record<string, unknown> = {
    chatId,
    refName,
    graph,
    action,
    path,
    diff,
    stats,
    at,
    changes,
    count: changes.length,
    subject: first.subject,
    predicate: first.predicate,
    object: first.object,
  };
  const hash = await objects.putJSON({ kind: "agent:MemoryDiff", value: payload });
  const { stepId } = await appendStep(chatId, {
    kind: "agent:MemoryDiff",
    status: "agent:Done",
    payloadHash: hash,
    extras: [["agent:path", path], ["agent:graph", graph]],
  });
  const diffId = await id.new("memdiff");
  await refs.set(`memory-diffs/${diffId}`, hash);
  events.publish({ kind: "memory-diff", chatId, refName, graph, path, diff, stats, hash, stepId, at, count: changes.length });
}

const objects: Moo["objects"] = {
  async putText({ kind, text }) {
    return __op_object_put(kind, String(text));
  },
  async putJSON({ kind, value }) {
    return __op_object_put(kind, JSON.stringify(value));
  },
  async getText({ hash }) {
    const row = __op_object_get(hash);
    return row ? { kind: row.kind, text: row.content } : null;
  },
  async getJSON({ hash }) {
    const row = __op_object_get(hash);
    if (!row) return null;
    return { kind: row.kind, value: JSON.parse(row.content) };
  },
};

const refs: Moo["refs"] = {
  async get(name) {
    return __op_ref_get(name);
  },
  async set(name, target) {
    const previous = __op_ref_get(name);
    __op_ref_set(name, target);
    return { name, target, previous, changed: previous !== target };
  },
  async cas(name, expected, next) {
    return __op_ref_cas(name, expected ?? null, next);
  },
  async list(prefix = "") {
    return __op_refs_list(prefix);
  },
  async entries(prefix = "") {
    return JSON.parse(__op_refs_entries(prefix));
  },
  async delete(name) {
    return __op_ref_delete(name);
  },
};


function unpackMemoryFact(fact: unknown): [string, string, ObjectInput] {
  if (Array.isArray(fact) && fact.length >= 3) {
    return [String(fact[0]), String(fact[1]), fact[2] as ObjectInput];
  }
  if (fact && typeof fact === "object") {
    const row = fact as { subject?: unknown; predicate?: unknown; object?: unknown };
    if (row.subject != null && row.predicate != null && row.object != null) {
      return [String(row.subject), String(row.predicate), row.object as ObjectInput];
    }
  }
  throw new Error("memory fact must be [subject, predicate, object] or {subject,predicate,object}");
}

function unpackMemoryFacts(input: unknown): Array<[string, string, ObjectInput]> {
  if (!Array.isArray(input)) throw new Error("bulk memory write requires an array of facts");
  return input.map(unpackMemoryFact);
}
function unpackMemoryWriteArgs(input: unknown): Array<[string, string, ObjectInput]> {
  if (input && typeof input === "object" && !Array.isArray(input) && "facts" in input) {
    const factsInput = (input as { facts?: unknown }).facts;
    return unpackMemoryFacts(factsInput);
  }
  return [unpackMemoryFact(input)];
}
function unpackMemoryPatchGroups(input: unknown): Array<{ asserts: Array<[string, string, ObjectInput]>; retracts: Array<[string, string, ObjectInput]> }> {
  const groupsInput = input && typeof input === "object" && !Array.isArray(input) && "groups" in input
    ? (input as { groups?: unknown }).groups
    : [input];
  if (!Array.isArray(groupsInput)) throw new Error("memory.patch groups must be an array");
  return groupsInput.map((group) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) throw new Error("memory.patch group must be {asserts?, retracts?}");
    const assertsInput = (group as { asserts?: unknown }).asserts ?? [];
    const retractsInput = (group as { retracts?: unknown }).retracts ?? [];
    return {
      asserts: unpackMemoryFacts(assertsInput),
      retracts: unpackMemoryFacts(retractsInput),
    };
  });
}


function parseBindingTerm(value: string): BindingTerm {
  const raw = String(value);
  if (raw.startsWith("<") && raw.endsWith(">")) return { value: raw.slice(1, -1), termType: "iri" };
  if (/^[A-Za-z][A-Za-z0-9_-]*:[^\s]+$/.test(raw)) return { value: raw, termType: "iri" };
  if (raw.startsWith("?")) return { value: raw.slice(1), termType: "variable" };
  if (raw.startsWith("_:")) return { value: raw, termType: "blank" };
  const dt = raw.match(/^"([\s\S]*)"\^\^(.+)$/);
  if (dt) return { value: dt[1]!.replace(/\\"/g, '"').replace(/\\n/g, "\n"), termType: "literal", datatype: dt[2] };
  const lang = raw.match(/^"([\s\S]*)"@([A-Za-z0-9-]+)$/);
  if (lang) return { value: lang[1]!.replace(/\\"/g, '"').replace(/\\n/g, "\n"), termType: "literal", language: lang[2] };
  const lit = raw.match(/^"([\s\S]*)"$/);
  if (lit) return { value: lit[1]!.replace(/\\"/g, '"').replace(/\\n/g, "\n"), termType: "literal" };
  return { value: raw };
}

function formatBindings(rows: Bindings[], format?: string): Bindings[] | TermBindings[] {
  if (format !== "term") return rows;
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, parseBindingTerm(v)])) as TermBindings);
}

function quadObjects(rows: Quad[]): QuadObject[] {
  return rows.map(([graph, subject, predicate, object]) => ({ graph, subject, predicate, object }));
}

const sparql: Moo["sparql"] = {
  async query(args) {
    const { query, ref, graph = null, limit = null, format = "string" } = args || ({} as any);
    if (!ref) throw new MooApiError("invalid_argument", "sparql.query requires ref");
    const decoded = __op_sparql_query(query, ref, graph, limit ?? null);
    if (decoded.type === "select") return formatBindings(decoded.result as Bindings[], format) as any;
    return decoded.result as any;
  },
  async select(args) {
    const { query, ref, graph = null, limit = null, format = "string" } = args;
    const decoded = __op_sparql_query(query, ref, graph, limit ?? null);
    if (decoded.type !== "select") throw new MooApiError("bad_sparql", "SPARQL query returned " + decoded.type + ", not select");
    return formatBindings(decoded.result as Bindings[], format) as any;
  },
  async ask(args) {
    const { query, ref, graph = null, limit = null } = args;
    const decoded = __op_sparql_query(query, ref, graph, limit ?? null);
    if (decoded.type !== "ask") throw new MooApiError("bad_sparql", "SPARQL query returned " + decoded.type + ", not ask");
    return decoded.result;
  },
  async construct(args) {
    const { query, ref, graph = null, limit = null } = args;
    const decoded = __op_sparql_query(query, ref, graph, limit ?? null);
    if (decoded.type !== "construct") throw new MooApiError("bad_sparql", "SPARQL query returned " + decoded.type + ", not construct");
    return decoded.result;
  },
};

function encodeFactQuad(q: FactQuadInput): Quad {
  const raw = unpackQuad(q);
  return [raw[0], raw[1], raw[2], encodeObject(raw[3])];
}

const facts: Moo["facts"] = {
  async add({ ref, graph, subject, predicate, object }) {
    const encoded = encodeObject(object);
    assertFactObject(encoded);
    __op_facts_add(ref, graph, subject, predicate, encoded);
    invalidateChatFactsSummary(ref);
    return { ref, added: 1, removed: 0 };
  },
  async addAll({ ref, quads }) {
    const adds = quads.map((q) => encodeFactQuad(q));
    if (!adds.length) return { ref, added: 0, removed: 0 };
    assertFactObjects(adds);
    __op_facts_swap(ref, EMPTY_JSON_ARRAY, JSON.stringify(adds));
    invalidateChatFactsSummary(ref);
    return { ref, added: adds.length, removed: 0 };
  },
  async remove({ ref, graph, subject, predicate, object }) {
    __op_facts_remove(ref, graph, subject, predicate, encodeObject(object));
    invalidateChatFactsSummary(ref);
    return { ref, added: 0, removed: 1 };
  },
  async match({ ref, graph = null, subject = null, predicate = null, object = null, limit = undefined, format = "tuple" }) {
    const encodedObject = object == null ? null : encodeObject(object);
    const rows = __op_facts_match(ref, graph, subject, predicate, encodedObject, limit ?? null) as Quad[];
    return (format === "object" ? quadObjects(rows) : rows) as any;
  },
  async history({ ref, graph = null, subject = null, predicate = null, object = null, limit = undefined }) {
    const encodedObject = object == null ? null : encodeObject(object);
    const rows = __op_facts_history(ref, graph, subject, predicate, encodedObject, limit ?? null);
    return rows as import("./types").FactHistoryRow[];
  },
  async matchAll({ patterns, ref, graph = undefined, limit = undefined }) {
    if (!ref) throw new Error("matchAll requires ref");
    return __op_facts_match_all(
      ref,
      JSON.stringify(patterns.map(([s, p, o]) => [s, p, encodeObject(o as ObjectInput)])),
      graph ?? null,
      limit ?? null,
    ) as Bindings[];
  },
  async refs(args = {}) {
    return __op_facts_refs(args.prefix ?? null);
  },
  async count({ ref }) {
    return __op_facts_count(ref);
  },
  async swap({ ref, removes, adds }) {
    const encodedRemoves = removes.map((q) => encodeFactQuad(q));
    const encodedAdds = adds.map((q) => encodeFactQuad(q));
    assertFactObjects(encodedAdds);
    __op_facts_swap(ref, JSON.stringify(encodedRemoves), JSON.stringify(encodedAdds));
    invalidateChatFactsSummary(ref);
    return { ref, added: encodedAdds.length, removed: encodedRemoves.length };
  },
  async update({ ref, fn }) {
    const removes: Quad[] = [];
    const adds: Quad[] = [];
    await fn({
      add({ graph, subject, predicate, object }) {
        adds.push([graph, subject, predicate, encodeObject(object)]);
      },
      remove({ graph, subject, predicate, object }) {
        removes.push([graph, subject, predicate, encodeObject(object)]);
      },
    });
    if (!removes.length && !adds.length) return { ref, added: 0, removed: 0 };
    assertFactObjects(adds);
    __op_facts_swap(ref, JSON.stringify(removes), JSON.stringify(adds));
    invalidateChatFactsSummary(ref);
    return { ref, added: adds.length, removed: removes.length };
  },
  async clearRef({ ref, dryRun = false }) {
    if (dryRun) return { ref, removed: __op_facts_count(ref), dryRun: true };
    const removed = __op_facts_clear(ref);
    invalidateChatFactsSummary(ref);
    return { ref, removed };
  },
  async deleteRef({ ref, dryRun = false }) {
    if (dryRun) return { ref, removed: __op_facts_count(ref), dryRun: true };
    const removed = __op_facts_purge(ref);
    invalidateChatFactsSummary(ref);
    return { ref, removed };
  },
  async deleteGraph({ ref, graph, dryRun = false }) {
    if (!ref) throw new MooApiError("invalid_argument", "facts.deleteGraph requires ref", { graph });
    const matches = __op_facts_match(ref, graph, null, null, null, null) as Quad[];
    if (dryRun) return { ref, graph, removed: matches.length, dryRun: true };
    if (!matches.length) return { ref, graph, removed: 0 };
    __op_facts_swap(ref, JSON.stringify(matches), EMPTY_JSON_ARRAY);
    invalidateChatFactsSummary(ref);
    return { ref, graph, removed: matches.length };
  },
  async deleteGraphEverywhere({ graph, dryRun = false }) {
    if (dryRun) {
      let removed = 0;
      for (const refName of __op_facts_refs(null)) {
        removed += (__op_facts_match(refName, graph, null, null, null, null) as Quad[]).length;
      }
      return { graph, removed, dryRun: true };
    }
    const removed = __op_facts_purge_graph(graph);
    chatFactsSummaryCache.clear();
    return { graph, removed };
  },
};

const fs: Moo["fs"] = {
  async read(path) {
    return __op_fs_read(path);
  },
  async write(path, content) {
    const text = typeof content === "string" ? content : String(content);
    let before: string | null = null;
    try {
      before = __op_fs_read(path);
    } catch (_) {
      before = null;
    }
    __op_fs_write(path, text);
    await recordFileWriteDiff(path, before, text);
  },
  async list(path) {
    return __op_fs_list(path);
  },
  async glob(pattern) {
    return __op_fs_glob(pattern);
  },
  async stat(path) {
    return __op_fs_stat(path);
  },
  async canonical(path) {
    return __op_fs_canonical(path);
  },
  async exists(path) {
    return (await fs.stat(path)) != null;
  },
  async ensureDir(path) {
    __op_fs_mkdir(path);
  },
  async patch(input) {
    const args = normalizePatchArgs(input);
    const parsed = parseUnifiedPatch(String(args.patch));
    const dryRun = !!args.dryRun;
    const files: FsPatchReceipt["files"] = [];
    for (const file of parsed) {
      const sourcePath = file.oldPath ?? file.newPath;
      const targetPath = file.newPath ?? file.oldPath;
      if (!sourcePath || !targetPath) throw new MooApiError("invalid_patch", "patch file header has no usable path", file);
      const readPath = resolvePatchPath(sourcePath, args.cwd, args.strip);
      const writePath = resolvePatchPath(targetPath, args.cwd, args.strip);
      let before: string | null = null;
      try {
        before = __op_fs_read(readPath);
      } catch (_) {
        before = null;
      }
      if (before == null && file.oldPath != null) throw new MooApiError("patch_mismatch", "patch target file does not exist", { path: readPath });
      const applied = applyParsedFilePatch(file, before);
      const deleting = file.newPath == null;
      if (!dryRun) {
        if (deleting) {
          __op_fs_remove(readPath);
          await recordFileWriteDiff(readPath, before, "");
        } else {
          __op_fs_write(writePath, applied.after);
          await recordFileWriteDiff(writePath, before, applied.after);
        }
      }
      files.push({ path: deleting ? readPath : writePath, beforeExists: before != null, afterExists: !deleting, added: applied.added, removed: applied.removed, hunks: file.hunks.length });
    }
    return { dryRun, files };
  },
};

function checkedProcResult(input: ProcRunArgs, result: ProcResult): ProcResult {
  if (input.check && result.code !== 0) {
    const code = result.timedOut ? "timeout" : "process_failed";
    const message = result.timedOut
      ? "process timed out: " + input.cmd
      : "process failed: " + input.cmd + " exited " + result.code;
    throw new MooApiError(code, message, {
      cmd: input.cmd,
      args: input.args ?? [],
      cwd: input.cwd ?? null,
      code: result.code,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated ?? false,
      stderrTruncated: result.stderrTruncated ?? false,
    });
  }
  return result;
}

const proc: Moo["proc"] = {
  async run(input) {
    const { cmd, args = [], cwd = null, stdin = null, timeoutMs = 60_000, env = undefined, maxOutputBytes = null } = input;
    const result = __op_proc_run(
      cmd,
      JSON.stringify(args),
      cwd,
      stdin,
      timeoutMs,
      env == null ? null : JSON.stringify(env),
      maxOutputBytes ?? null,
    );
    return checkedProcResult(input, result);
  },
  async runChecked(input) {
    return proc.run({ ...input, check: true });
  },
};

function workspacePath(root: string, path: string = "."): string {
  const raw = String(path || ".");
  if (!validate.relativePath(raw) && raw !== ".") throw new MooApiError("path_escape", "workspace paths must be relative and may not contain ..", { root, path: raw });
  const parts = raw.split("/").filter(Boolean);
  return parts.length ? joinPath(root, parts.join("/")) : root;
}

const workspace: Moo["workspace"] = {
  async current(args = {}) {
    const root = args.root ? await fs.canonical(args.root) : await chat.scratch(args.chatId || activeChatId || "default");
    return {
      root,
      fs: {
        read: (path) => fs.read(workspacePath(root, path)),
        write: (path, content) => fs.write(workspacePath(root, path), content),
        list: (path = ".") => fs.list(workspacePath(root, path)),
        glob: (pattern) => fs.glob(workspacePath(root, pattern)),
        stat: (path = ".") => fs.stat(workspacePath(root, path)),
        canonical: (path = ".") => fs.canonical(workspacePath(root, path)),
        exists: (path = ".") => fs.exists(workspacePath(root, path)),
        ensureDir: (path = ".") => fs.ensureDir(workspacePath(root, path)),
        patch: (input) => fs.patch(typeof input === "string" ? { patch: input, cwd: root } : { ...input, cwd: root }),
      },
      proc: {
        run: (input: Omit<ProcRunArgs, "cwd"> & { cwd?: string | null }) => proc.run({ ...input, cwd: input.cwd ? workspacePath(root, input.cwd) : root }),
        runChecked: (input: Omit<ProcRunArgs, "cwd" | "check"> & { cwd?: string | null }) => proc.runChecked({ ...input, cwd: input.cwd ? workspacePath(root, input.cwd) : root }),
      },
    };
  },
};

function buildBody(opts: any): { body: string | null; headers: Record<string, string> } {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  let body: string | null = null;
  if (opts.body != null) {
    if (typeof opts.body === "string") {
      body = opts.body;
    } else {
      body = JSON.stringify(opts.body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    }
  }
  return { body, headers };
}

function parseResponseHeaders(headersJson: string | undefined): Record<string, string | string[]> {
  if (!headersJson) return {};
  try {
    const parsed = JSON.parse(headersJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (typeof v === "string") out[key] = v;
      else if (Array.isArray(v)) out[key] = v.map((item) => String(item));
    }
    return out;
  } catch {
    return {};
  }
}

const http: Moo["http"] = {
  async fetch(opts) {
    const method = opts.method || "GET";
    if (!opts.url) throw new Error("http.fetch requires url");
    const { body, headers } = buildBody(opts);
    const response = __op_http_fetch(method, opts.url, JSON.stringify(headers), body, opts.timeoutMs ?? 60_000);
    return { status: response.status, body: response.body, headers: parseResponseHeaders(response.headers) };
  },
  async stream(opts) {
    const method = opts.method || "GET";
    if (!opts.url) throw new Error("http.stream requires url");
    const { body, headers } = buildBody(opts);
    const opened = __op_http_stream_open(
      method,
      opts.url,
      JSON.stringify(headers),
      body,
      opts.timeoutMs ?? 120_000,
    );
    return {
      status: opened.status,
      headers: parseResponseHeaders(opened.headers),
      async next() {
        return __op_http_stream_next(opened.handle);
      },
      async close() {
        __op_http_stream_close(opened.handle);
      },
    };
  },
};


// -- Model Context Protocol ---------------------------------------------

function cleanMcpId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const v = id.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(v) ? v : null;
}

function mcpRef(id: string): string {
  return `mcp/${id}/config`;
}

function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    const key = String(k).trim();
    if (!key) continue;
    if (v == null) continue;
    out[key] = String(v);
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeMcpOAuth(oauth: unknown): McpServerConfig["oauth"] | undefined {
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return undefined;
  const src = oauth as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of [
    "clientId",
    "clientSecret",
    "authorizationUrl",
    "tokenUrl",
    "scope",
    "redirectUri",
    "resourceMetadataUrl",
    "authorizationServerMetadataUrl",
    "registrationUrl",
  ]) {
    const value = src[key];
    if (value != null && String(value).trim()) out[key] = String(value).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeMcpServer(input: McpServerConfig): McpServerConfig {
  const id = cleanMcpId(input?.id);
  if (!id) throw new Error("MCP server id must match [a-zA-Z0-9_.-]+");
  const url = String(input.url || "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("MCP server url must be http(s)");
  const transport = input.transport === "sse" ? "sse" : "http";
  const timeoutMs = Number(input.timeoutMs ?? 60_000);
  return {
    id,
    title: String(input.title || id).trim() || id,
    url,
    transport,
    enabled: input.enabled !== false,
    headers: normalizeHeaders(input.headers),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 60_000,
    oauth: normalizeMcpOAuth(input.oauth),
  };
}

function parseMcpSseBody(body: string): any {
  const messages: any[] = [];
  let dataLines: string[] = [];
  let parseError: any = null;
  const flush = () => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") return;
    try {
      messages.push(JSON.parse(data));
    } catch (err: any) {
      parseError = err;
    }
  };

  for (const rawLine of body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (rawLine === "") {
      flush();
      continue;
    }
    if (rawLine.startsWith("data:")) {
      let data = rawLine.slice(5);
      if (data.startsWith(" ")) data = data.slice(1);
      dataLines.push(data);
    }
  }
  flush();

  if (messages.length) {
    return messages.find((message) => message?.error) || messages.find((message) => message?.result !== undefined) || messages[messages.length - 1];
  }
  if (parseError) throw parseError;
  throw new Error("no JSON data events found");
}

function parseMcpBody(body: string): any {
  try {
    return JSON.parse(body || "null");
  } catch (jsonErr: any) {
    try {
      return parseMcpSseBody(body || "");
    } catch (sseErr: any) {
      throw new Error(`MCP server returned non-JSON response: ${jsonErr?.message || jsonErr}; SSE parse failed: ${sseErr?.message || sseErr}`);
    }
  }
}

function mcpEndpoint(server: McpServerConfig): string {
  // Streamable HTTP MCP servers usually expose their JSON-RPC endpoint at the
  // configured URL. For SSE configs, the same request helper targets a sibling
  // /message endpoint unless the user already supplied one explicitly.
  if (server.transport !== "sse") return server.url;
  if (/\/message\/?$/i.test(server.url)) return server.url;
  return server.url.replace(/\/?$/, "/message");
}

type McpOAuthToken = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  expires_at?: number;
  refresh_token?: string;
  scope?: string;
};

type McpOAuthPending = {
  serverId: string;
  codeVerifier: string;
  redirectUri: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  expiresAt: number;
  returnChatId?: string;
};

type McpSession = {
  id?: string;
  initializedAt?: number;
  updatedAt?: number;
};

type McpRequestOptions = {
  skipInitialize?: boolean;
  omitSession?: boolean;
  retryingSession?: boolean;
};

function mcpOAuthTokenRef(id: string): string {
  return `mcp/${id}/oauth/token`;
}

function mcpOAuthPendingRef(state: string): string {
  return `mcp/oauth/state/${state}`;
}

function mcpSessionRef(id: string): string {
  return `mcp/${id}/session`;
}

function parseHttpUrl(url: string): { origin: string; path: string } | null {
  const m = /^(https?:\/\/[^/?#]+)([^?#]*)/i.exec(url);
  if (!m) return null;
  return { origin: m[1]!, path: m[2] || "/" };
}

function formEncode(values: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (v == null) continue;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
  }
  return parts.join("&");
}

function addQuery(url: string, values: Record<string, string | undefined>): string {
  const qs = formEncode(values);
  if (!qs) return url;
  const hash = url.indexOf("#");
  const base = hash >= 0 ? url.slice(0, hash) : url;
  const frag = hash >= 0 ? url.slice(hash) : "";
  return base + (base.includes("?") ? "&" : "?") + qs + frag;
}

function oauthSecret(prefix: string): string {
  let out = "";
  while (out.length < 64) out += __op_id(prefix).replace(/[^A-Za-z0-9._~-]/g, "");
  return out.slice(0, 96);
}

async function getJsonMaybe(url: string, timeoutMs = 10_000): Promise<any | null> {
  try {
    const response = await http.fetch({ method: "GET", url, headers: { Accept: "application/json" }, timeoutMs });
    if (response.status < 200 || response.status >= 300) return null;
    return parseMcpBody(response.body);
  } catch {
    return null;
  }
}

async function discoverMcpOAuth(server: McpServerConfig): Promise<Required<Pick<NonNullable<McpServerConfig["oauth"]>, "authorizationUrl" | "tokenUrl">> & NonNullable<McpServerConfig["oauth"]> & { registrationUrl?: string }> {
  let oauth = { ...(server.oauth || {}) };
  if ((!oauth.authorizationUrl || !oauth.tokenUrl) && oauth.resourceMetadataUrl) {
    const meta = await getJsonMaybe(oauth.resourceMetadataUrl, server.timeoutMs);
    const issuer = meta?.authorization_servers?.[0] || meta?.authorization_server;
    if (issuer && !oauth.authorizationServerMetadataUrl) {
      oauth.authorizationServerMetadataUrl = String(issuer).replace(/\/$/, "") + "/.well-known/oauth-authorization-server";
    }
  }
  if ((!oauth.authorizationUrl || !oauth.tokenUrl) && !oauth.resourceMetadataUrl) {
    const parsed = parseHttpUrl(server.url);
    if (parsed) {
      const candidates = [
        parsed.origin + "/.well-known/oauth-protected-resource" + parsed.path.replace(/\/$/, ""),
        parsed.origin + "/.well-known/oauth-protected-resource",
      ];
      for (const candidate of candidates) {
        const meta = await getJsonMaybe(candidate, server.timeoutMs);
        const issuer = meta?.authorization_servers?.[0] || meta?.authorization_server;
        if (issuer) {
          oauth.resourceMetadataUrl = candidate;
          oauth.authorizationServerMetadataUrl = String(issuer).replace(/\/$/, "") + "/.well-known/oauth-authorization-server";
          break;
        }
      }
    }
  }
  if ((!oauth.authorizationUrl || !oauth.tokenUrl) && oauth.authorizationServerMetadataUrl) {
    const meta = await getJsonMaybe(oauth.authorizationServerMetadataUrl, server.timeoutMs);
    oauth.authorizationUrl ||= meta?.authorization_endpoint;
    oauth.tokenUrl ||= meta?.token_endpoint;
    oauth.registrationUrl ||= meta?.registration_endpoint;
  }
  if (!oauth.authorizationUrl || !oauth.tokenUrl) {
    throw new Error(`MCP server ${server.id} needs oauth.authorizationUrl and oauth.tokenUrl (or discoverable metadata)`);
  }
  return oauth as any;
}

async function loadMcpOAuthToken(serverId: string): Promise<McpOAuthToken | null> {
  const clean = cleanMcpId(serverId);
  if (!clean) return null;
  const hash = await refs.get(mcpOAuthTokenRef(clean));
  if (!hash) return null;
  const row = await objects.getJSON<McpOAuthToken>({ hash: hash });
  return row?.value?.access_token ? row.value : null;
}

async function saveMcpOAuthToken(serverId: string, token: McpOAuthToken): Promise<McpOAuthToken> {
  const now = await time.nowMs();
  if (token.expires_in && !token.expires_at) token.expires_at = now + Number(token.expires_in) * 1000;
  const hash = await objects.putJSON({ kind: "mcp:OAuthToken", value: token });
  await refs.set(mcpOAuthTokenRef(serverId), hash);
  return token;
}

function headerValue(headers: Record<string, string | string[]> | undefined, name: string): string | null {
  if (!headers) return null;
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.find((item) => item.trim())?.trim() || null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function loadMcpSession(serverId: string): Promise<McpSession | null> {
  const clean = cleanMcpId(serverId);
  if (!clean) return null;
  const hash = await refs.get(mcpSessionRef(clean));
  if (!hash) return null;
  const row = await objects.getJSON<McpSession>({ hash: hash });
  const value = row?.value;
  if (!value || typeof value !== "object") return null;
  const session: McpSession = {};
  if (typeof value.id === "string" && value.id.trim()) session.id = value.id.trim();
  if (Number.isFinite(value.initializedAt)) session.initializedAt = Number(value.initializedAt);
  if (Number.isFinite(value.updatedAt)) session.updatedAt = Number(value.updatedAt);
  return session.id || session.initializedAt ? session : null;
}

async function saveMcpSession(serverId: string, session: McpSession): Promise<void> {
  const clean = cleanMcpId(serverId);
  if (!clean) return;
  const now = await time.nowMs();
  const current = await loadMcpSession(clean);
  const next: McpSession = {
    ...(current || {}),
    ...session,
    updatedAt: now,
  };
  if (!next.initializedAt && session.initializedAt !== undefined) next.initializedAt = now;
  const hash = await objects.putJSON({ kind: "mcp:Session", value: next });
  await refs.set(mcpSessionRef(clean), hash);
}

async function loadMcpSessionId(serverId: string): Promise<string | null> {
  return (await loadMcpSession(serverId))?.id || null;
}

async function saveMcpSessionId(serverId: string, sessionId: string): Promise<void> {
  const value = sessionId.trim();
  if (value) await saveMcpSession(serverId, { id: value });
}

async function markMcpInitialized(serverId: string, sessionId?: string | null): Promise<void> {
  const now = await time.nowMs();
  const session: McpSession = { initializedAt: now };
  if (sessionId?.trim()) session.id = sessionId.trim();
  await saveMcpSession(serverId, session);
}

async function clearMcpSessionId(serverId: string): Promise<void> {
  const clean = cleanMcpId(serverId);
  if (clean) await refs.delete(mcpSessionRef(clean));
}

function mcpInitializeParams() {
  return {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "moo", version: "0.1.0" },
  };
}

function isMcpSessionError(status: number, body: string): boolean {
  return (status === 400 || status === 404) && /mcp-session-id|session/i.test(body || "");
}

type McpOAuthClientRegistration = {
  client_id: string;
  client_secret?: string;
  redirect_uris?: string[];
  token_endpoint_auth_method?: string;
};

async function registerMcpOAuthClient(server: McpServerConfig, oauth: Awaited<ReturnType<typeof discoverMcpOAuth>>, redirectUri: string): Promise<Awaited<ReturnType<typeof discoverMcpOAuth>>> {
  if (!oauth.registrationUrl) return oauth;
  if (oauth.clientId && oauth.clientId !== "moo" && oauth.redirectUri === redirectUri) return oauth;
  const response = await http.fetch({
    method: "POST",
    url: oauth.registrationUrl,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "moo " + (server.title || server.id),
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
    timeoutMs: server.timeoutMs ?? 60_000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`MCP OAuth client registration failed with HTTP ${response.status}: ${response.body}`);
  }
  const registered = parseMcpBody(response.body) as McpOAuthClientRegistration;
  if (!registered?.client_id) throw new Error("MCP OAuth client registration response missing client_id");
  const nextOauth = {
    ...oauth,
    clientId: registered.client_id,
    clientSecret: registered.client_secret || oauth.clientSecret,
    redirectUri,
  };
  await mcpCore.saveServer({ ...server, oauth: nextOauth });
  return nextOauth;
}

async function refreshMcpOAuthToken(server: McpServerConfig, token: McpOAuthToken): Promise<McpOAuthToken | null> {
  if (!token.refresh_token) return token;
  if (token.expires_at && token.expires_at - (await time.nowMs()) > 60_000) return token;
  const oauth = await discoverMcpOAuth(server);
  const response = await http.fetch({
    method: "POST",
    url: oauth.tokenUrl,
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: formEncode({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: oauth.clientId || "moo",
      client_secret: oauth.clientSecret,
    }),
    timeoutMs: server.timeoutMs ?? 60_000,
  });
  if (response.status < 200 || response.status >= 300) return token;
  const next = parseMcpBody(response.body) as McpOAuthToken;
  if (!next.refresh_token) next.refresh_token = token.refresh_token;
  return saveMcpOAuthToken(server.id, next);
}


function truncateDensePart(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function schemaTypeName(schema: unknown, depth = 0): string {
  if (!isRecord(schema)) return "unknown";
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.slice(0, 4).map((v: unknown) => JSON.stringify(v)).join("|") + (schema.enum.length > 4 ? "|…" : "");
  }
  const union = [schema.anyOf, schema.oneOf].find(Array.isArray) as unknown[] | undefined;
  if (union?.length) return union.slice(0, 4).map((s) => schemaTypeName(s, depth + 1)).join("|");
  if (Array.isArray(schema.type)) return schema.type.map((t: unknown) => String(t)).join("|");
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type === "array") return schema.items ? `${schemaTypeName(schema.items, depth + 1)}[]` : "unknown[]";
  if (type === "object" || schema.properties) {
    if (depth >= 1) return "object";
    return schemaShape(schema, depth + 1, 4);
  }
  if (type === "integer") return "integer";
  if (type) return type;
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  return "unknown";
}

function schemaShape(schema: unknown, depth = 0, maxProps = 8): string {
  if (!isRecord(schema)) return "{}";
  const props = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const entries = Object.entries(props).slice(0, maxProps).map(([key, prop]) => {
    const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
    const optional = required.has(key) ? "" : "?";
    return `${safeKey}${optional}:${schemaTypeName(prop, depth + 1)}`;
  });
  if (Object.keys(props).length > maxProps) entries.push("…");
  if (!entries.length && schema.additionalProperties) entries.push("[key:string]:" + schemaTypeName(schema.additionalProperties, depth + 1));
  return "{" + entries.join(",") + "}";
}

function denseMcpToolDescription(tool: any, inputSchema: unknown): string {
  const shape = schemaShape(inputSchema);
  const description = truncateDensePart(String(tool.description ?? tool.title ?? tool.annotations?.title ?? tool.name ?? ""));
  return description ? `${shape}: ${description}` : shape;
}

const mcpCore = {
  async listServers(): Promise<McpServerConfig[]> {
    const ids = new Set<string>();
    for (const refName of await refs.list("mcp/")) {
      const m = /^mcp\/([^/]+)\/config$/.exec(refName);
      if (m) ids.add(m[1]!);
    }
    const out: McpServerConfig[] = [];
    for (const id of [...ids].sort()) {
      const server = await mcpCore.getServer(id);
      if (server) out.push(server);
    }
    return out;
  },
  async getServer(id: string): Promise<McpServerConfig | null> {
    const clean = cleanMcpId(id);
    if (!clean) return null;
    const hash = await refs.get(mcpRef(clean));
    if (!hash) return null;
    const row = await objects.getJSON<McpServerConfig>({ hash: hash });
    return row?.value ? normalizeMcpServer(row.value) : null;
  },
  async saveServer(config: McpServerConfig): Promise<McpServerConfig> {
    const server = normalizeMcpServer(config);
    const hash = await objects.putJSON({ kind: "mcp:ServerConfig", value: server });
    await refs.set(mcpRef(server.id), hash);
    await clearMcpSessionId(server.id);
    return server;
  },
  async removeServer(id: string): Promise<boolean> {
    const clean = cleanMcpId(id);
    if (!clean) return false;
    await refs.delete(mcpOAuthTokenRef(clean));
    await clearMcpSessionId(clean);
    return refs.delete(mcpRef(clean));
  },
  async login(serverId: string, opts: McpOAuthStartOptions = {}): Promise<McpOAuthStart> {
    const server = await mcpCore.getServer(serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}`);
    let oauth = await discoverMcpOAuth(server);
    const redirectUri = opts.redirectUri || oauth.redirectUri || ((opts.origin || "http://127.0.0.1:7777").replace(/\/$/, "") + "/mcp/oauth/callback");
    oauth = await registerMcpOAuthClient(server, oauth, redirectUri);
    const clientId = oauth.clientId || "moo";
    const state = oauthSecret("mcpstate");
    const codeVerifier = oauthSecret("mcpverifier");
    const codeChallenge = __op_sha256_base64url(codeVerifier);
    const expiresAt = (await time.nowMs()) + 10 * 60_000;
    const returnChatId = String(opts.returnChatId || activeChatId || "").trim() || undefined;
    const pending: McpOAuthPending = {
      serverId: server.id,
      codeVerifier,
      redirectUri,
      tokenUrl: oauth.tokenUrl,
      clientId,
      clientSecret: oauth.clientSecret,
      scope: opts.scope || oauth.scope,
      expiresAt,
      returnChatId,
    };
    const hash = await objects.putJSON({ kind: "mcp:OAuthPending", value: pending });
    await refs.set(mcpOAuthPendingRef(state), hash);
    return {
      serverId: server.id,
      state,
      redirectUri,
      expiresAt,
      ...(returnChatId ? { returnChatId } : {}),
      authorizeUrl: addQuery(oauth.authorizationUrl, {
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: opts.scope || oauth.scope,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }),
    };
  },
  async completeLogin(state: string, code: string): Promise<McpOAuthStatus> {
    const cleanState = String(state || "").trim();
    const hash = cleanState ? await refs.get(mcpOAuthPendingRef(cleanState)) : null;
    if (!hash) throw new Error("unknown or expired MCP OAuth state");
    const row = await objects.getJSON<McpOAuthPending>({ hash: hash });
    const pending = row?.value;
    if (!pending) throw new Error("invalid MCP OAuth state");
    if (pending.expiresAt < await time.nowMs()) {
      await refs.delete(mcpOAuthPendingRef(cleanState));
      throw new Error("expired MCP OAuth state");
    }
    const response = await http.fetch({
      method: "POST",
      url: pending.tokenUrl,
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: formEncode({
        grant_type: "authorization_code",
        code: String(code || ""),
        redirect_uri: pending.redirectUri,
        client_id: pending.clientId,
        client_secret: pending.clientSecret,
        code_verifier: pending.codeVerifier,
      }),
      timeoutMs: 60_000,
    });
    await refs.delete(mcpOAuthPendingRef(cleanState));
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`MCP OAuth token exchange failed with HTTP ${response.status}: ${response.body}`);
    }
    const token = parseMcpBody(response.body) as McpOAuthToken;
    if (!token?.access_token) throw new Error("MCP OAuth token response missing access_token");
    await saveMcpOAuthToken(pending.serverId, token);
    await clearMcpSessionId(pending.serverId);
    const status = await mcpCore.authStatus(pending.serverId);
    return pending.returnChatId ? { ...status, returnChatId: pending.returnChatId } : status;
  },
  async logout(serverId: string): Promise<boolean> {
    const clean = cleanMcpId(serverId);
    if (!clean) return false;
    await clearMcpSessionId(clean);
    return refs.delete(mcpOAuthTokenRef(clean));
  },
  async authStatus(serverId: string): Promise<McpOAuthStatus> {
    const clean = cleanMcpId(serverId);
    if (!clean) throw new Error("invalid MCP server id");
    const token = await loadMcpOAuthToken(clean);
    return { serverId: clean, authenticated: !!token, expiresAt: token?.expires_at ?? null, scope: token?.scope ?? null };
  },
  async request<T = unknown>(serverId: string, method: string, params: unknown = {}, opts: McpRequestOptions = {}): Promise<T> {
    const server = await mcpCore.getServer(serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}`);
    if (server.enabled === false) throw new Error(`MCP server disabled: ${serverId}`);
    if (!opts.skipInitialize && method !== "initialize") {
      const session = await loadMcpSession(server.id);
      if (!session?.initializedAt) {
        await mcpCore.request(server.id, "initialize", mcpInitializeParams(), { skipInitialize: true, omitSession: true });
      }
    }
    let token = await loadMcpOAuthToken(server.id);
    if (token) token = await refreshMcpOAuthToken(server, token);
    const headers = {
      Accept: "application/json, text/event-stream",
      ...(server.headers || {}),
      ...(token?.access_token ? { Authorization: `Bearer ${token.access_token}` } : {}),
    };
    const existingSessionId = (opts.omitSession || method === "initialize") ? null : await loadMcpSessionId(server.id);
    if (existingSessionId && !Object.keys(headers).some((k) => k.toLowerCase() === "mcp-session-id")) {
      headers["Mcp-Session-Id"] = existingSessionId;
    }
    const response = await http.fetch({
      method: "POST",
      url: mcpEndpoint(server),
      headers,
      body: {
        jsonrpc: "2.0",
        id: await id.new("mcp"),
        method,
        params,
      },
      timeoutMs: server.timeoutMs ?? 60_000,
    });
    const responseSessionId = headerValue(response.headers, "mcp-session-id");
    if (responseSessionId) await saveMcpSessionId(server.id, responseSessionId);
    if (response.status === 401 && server.oauth && !token) {
      throw new Error(`MCP ${server.id} requires OAuth login; run moo.mcp.login("${server.id}") from the UI or use the MCP settings Login button`);
    }
    if (isMcpSessionError(response.status, response.body) && !opts.retryingSession && method !== "initialize") {
      await clearMcpSessionId(server.id);
      await mcpCore.request(server.id, "initialize", mcpInitializeParams(), { skipInitialize: true, omitSession: true });
      return mcpCore.request<T>(server.id, method, params, { ...opts, retryingSession: true });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`MCP ${method} failed with HTTP ${response.status}: ${response.body}`);
    }
    const payload = parseMcpBody(response.body);
    if (payload?.error) {
      throw new Error(payload.error.message || JSON.stringify(payload.error));
    }
    if (method === "initialize") await markMcpInitialized(server.id, responseSessionId);
    return payload?.result as T;
  },
  async listTools(serverId?: string): Promise<McpTool[]> {
    const servers = serverId ? [await mcpCore.getServer(serverId)] : await mcpCore.listServers();
    const out: McpTool[] = [];
    for (const server of servers) {
      if (!server || server.enabled === false) continue;
      const result: any = await mcpCore.request(server.id, "tools/list", {});
      for (const tool of result?.tools || []) {
        const name = String(tool.name || "");
        if (!name) continue;
        const inputSchema = tool.inputSchema ?? tool.input_schema ?? undefined;
        out.push({
          serverId: server.id,
          server: server.id,
          name,
          title: tool.title ?? tool.annotations?.title ?? null,
          description: tool.description ?? null,
          denseDescription: denseMcpToolDescription(tool, inputSchema),
          inputSchema,
        });
      }
    }
    return out;
  },
  async callTool<T = unknown>(serverId: string, name: string, arguments_: unknown = {}): Promise<T> {
    return mcpCore.request<T>(serverId, "tools/call", { name, arguments: arguments_ ?? {} });
  },
};

function createMcpProxy(): Moo["mcp"] {
  const serverProxies = new Map<string, Record<string, unknown>>();
  const target = {
    list: () => mcpCore.listServers(),
    tools: (server?: string) => mcpCore.listTools(server),
    listServers: () => mcpCore.listServers(),
    getServer: (id: string) => mcpCore.getServer(id),
    saveServer: (config: McpServerConfig) => mcpCore.saveServer(config),
    removeServer: (id: string) => mcpCore.removeServer(id),
    login: (serverId: string, opts?: McpOAuthStartOptions) => mcpCore.login(serverId, opts),
    completeLogin: (state: string, code: string) => mcpCore.completeLogin(state, code),
    logout: (serverId: string) => mcpCore.logout(serverId),
    authStatus: (serverId: string) => mcpCore.authStatus(serverId),
    listTools: (serverId?: string) => mcpCore.listTools(serverId),
    callTool: <T = unknown>(serverId: string, name: string, arguments_?: unknown) =>
      mcpCore.callTool<T>(serverId, name, arguments_),
    request: <T = unknown>(serverId: string, method: string, params?: unknown) =>
      mcpCore.request<T>(serverId, method, params),
  };
  const getServerProxy = (serverId: string) => {
    let proxy = serverProxies.get(serverId);
    if (!proxy) {
      proxy = new Proxy({}, {
        get(_toolTarget, tool) {
          if (typeof tool !== "string") return undefined;
          if (tool === "then") return undefined;
          return (args?: unknown) => mcpCore.callTool(serverId, tool, args ?? {});
        },
      });
      serverProxies.set(serverId, proxy);
    }
    return proxy;
  };
  return new Proxy(target, {
    get(t, server) {
      if (typeof server !== "string") return undefined;
      if (server === "then") return undefined;
      if (server in t) return t[server as keyof typeof t];
      return getServerProxy(server);
    },
  }) as Moo["mcp"];
}

const mcp: Moo["mcp"] = createMcpProxy();

const events: Moo["events"] = {
  publish(payload) {
    const text =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    __op_broadcast(text);
  },
};

const env: Moo["env"] = {
  async get(name) {
    return __op_env_get(name);
  },
  async getMany(names) {
    const out: Record<string, string | null> = {};
    for (const n of names) out[n] = __op_env_get(n);
    return out;
  },
};


async function recordChatTrailEntry(
  chatId: string,
  kind: string,
  payload: Record<string, unknown>,
  opts: { touch?: boolean } = {},
): Promise<string> {
  if (!chatId) throw new Error("trail entry requires chatId");
  const factsRef = `chat/${chatId}/facts`;
  const graph = `chat:${chatId}`;
  const now = await time.nowMs();
  if (opts.touch) await chat.touch(chatId);
  const entryId = await id.new("trail");
  const payloadHash = await objects.putJSON({ kind, value: { ...payload, at: now } });
  await facts.update({ ref: factsRef, fn: (txn) => {
    txn.add({ graph: graph, subject: entryId, predicate: "rdf:type", object: "agent:TrailEntry" });
    txn.add({ graph: graph, subject: entryId, predicate: "agent:kind", object: kind });
    txn.add({ graph: graph, subject: entryId, predicate: "agent:createdBy", object: "agent:moo" });
    txn.add({ graph: graph, subject: entryId, predicate: "agent:createdAt", object: now });
    txn.add({ graph: graph, subject: entryId, predicate: "agent:payload", object: payloadHash });
  } });
  return entryId;
}

async function recordInputRequest(chatId: string, kind: string, spec: unknown): Promise<string> {
  const factsRef = `chat/${chatId}/facts`;
  const graph = `chat:${chatId}`;
  const reqId = await id.new("uireq");
  const payload = await objects.putJSON({ kind: kind, value: spec || {} });
  const now = await time.nowMs();
  await facts.update({ ref: factsRef, fn: (txn) => {
    txn.add({ graph: graph, subject: reqId, predicate: "rdf:type", object: "ui:InputRequest" });
    txn.add({ graph: graph, subject: reqId, predicate: "ui:kind", object: kind });
    txn.add({ graph: graph, subject: reqId, predicate: "ui:status", object: "ui:Pending" });
    txn.add({ graph: graph, subject: reqId, predicate: "ui:payload", object: payload });
    txn.add({ graph: graph, subject: reqId, predicate: "ui:createdAt", object: now });
  } });
  return reqId;
}


const UI_FIELD_TYPES = new Set(["text", "textarea", "url", "number", "boolean", "select", "secretRef"]);

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateUiOption(option: unknown, path: string): void {
  if (typeof option === "string") return;
  if (!isRecord(option)) throw new Error(path + " must be a string or {label?, value?}");
  if (option.label != null && typeof option.label !== "string") throw new Error(path + ".label must be a string");
  if (option.value != null && typeof option.value !== "string") throw new Error(path + ".value must be a string");
}

function validateAskSpec(spec: unknown): UiAskSpec {
  if (!isRecord(spec)) throw new Error("moo.ui.ask spec must be an object");
  if (spec.title != null && typeof spec.title !== "string") throw new Error("moo.ui.ask spec.title must be a string");
  if (!Array.isArray(spec.fields) || spec.fields.length === 0) {
    throw new Error("moo.ui.ask spec.fields must be a non-empty array");
  }
  for (let i = 0; i < spec.fields.length; i++) {
    const field = spec.fields[i];
    const path = "moo.ui.ask spec.fields[" + i + "]";
    if (!isRecord(field)) throw new Error(path + " must be an object");
    if (typeof field.name !== "string" || field.name.length === 0) throw new Error(path + ".name must be a non-empty string");
    if (field.label != null && typeof field.label !== "string") throw new Error(path + ".label must be a string");
    if (field.type != null && (typeof field.type !== "string" || !UI_FIELD_TYPES.has(field.type))) {
      throw new Error(path + ".type must be one of " + Array.from(UI_FIELD_TYPES).join(", "));
    }
    if (field.required != null && typeof field.required !== "boolean") throw new Error(path + ".required must be a boolean");
    if (field.options != null) {
      if (!Array.isArray(field.options)) throw new Error(path + ".options must be an array");
      field.options.forEach((option: unknown, j: number) => validateUiOption(option, path + ".options[" + j + "]"));
    }
  }
  if (spec.submitLabel != null && typeof spec.submitLabel !== "string") throw new Error("moo.ui.ask spec.submitLabel must be a string");
  return spec as UiAskSpec;
}

function validateChooseSpec(spec: unknown): UiChooseSpec {
  if (!isRecord(spec)) throw new Error("moo.ui.choose spec must be an object");
  if (spec.title != null && typeof spec.title !== "string") throw new Error("moo.ui.choose spec.title must be a string");
  if (!Array.isArray(spec.items) || spec.items.length === 0) {
    throw new Error("moo.ui.choose spec.items must be a non-empty array");
  }
  for (let i = 0; i < spec.items.length; i++) {
    const item = spec.items[i];
    const path = "moo.ui.choose spec.items[" + i + "]";
    if (!isRecord(item)) throw new Error(path + " must be an object");
    if (typeof item.id !== "string" || item.id.length === 0) throw new Error(path + ".id must be a non-empty string");
    if (item.label != null && typeof item.label !== "string") throw new Error(path + ".label must be a string");
    if (item.description != null && typeof item.description !== "string") throw new Error(path + ".description must be a string");
  }
  return spec as UiChooseSpec;
}

const UI_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;

function cleanUiIdOrThrow(id: unknown): string {
  if (typeof id !== "string") throw new Error("ui id must be a string");
  const v = id.trim();
  if (!UI_ID_RE.test(v)) throw new Error("ui id must match /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/");
  return v;
}

async function uiManifestExists(uiId: string): Promise<boolean> {
  return !!(await refs.get(`ui/${uiId}/manifest`));
}

const ui: Moo["ui"] = {
  async ask({ chatId, spec }) {
    return recordInputRequest(chatId, "ui:Form", validateAskSpec(spec));
  },
  async choose({ chatId, spec }) {
    return recordInputRequest(chatId, "ui:Choice", validateChooseSpec(spec));
  },
  async say({ chatId, text }) {
    const payload = await objects.putJSON({ kind: "agent:Reply", value: { text, at: await time.nowMs() } });
    const { stepId } = await appendStep(chatId, {
      kind: "agent:Reply",
      status: "agent:Done",
      payloadHash: payload,
      extras: [["agent:via", "ui:say"]],
    });
    return { chatId, stepId, payloadHash: payload };
  },
  apps: {
    async register({ id: inputId, manifest: inputManifest, bundle, handler = null }) {
      const id = cleanUiIdOrThrow(inputId ?? inputManifest.id);
      const title = String(inputManifest.title ?? id).trim() || id;
      const manifest: UiManifest = {
        ...inputManifest,
        id,
        title,
        description: inputManifest.description ?? "",
        icon: inputManifest.icon ?? "▣",
        entry: inputManifest.entry ?? "index.html",
        api: inputManifest.api ?? [],
      };
      const manifestHash = await objects.putJSON({ kind: "ui:Manifest", value: manifest });
      const bundleHash = await objects.putJSON({ kind: "ui:Bundle", value: bundle });
      await refs.set(`ui/${id}/manifest`, manifestHash);
      await refs.set(`ui/${id}/bundle`, bundleHash);
      let handlerHash: string | null = null;
      if (handler != null) {
        handlerHash = await objects.putText({ kind: "ui:Handler", text: String(handler) });
        await refs.set(`ui/${id}/handler`, handlerHash);
      }
      await memory.assert({ facts: [
        [`ui:${id}`, "rdf:type", "ui:App"],
        [`ui:${id}`, "ui:title", title],
        [`ui:${id}`, "ui:manifest", manifestHash],
        [`ui:${id}`, "ui:bundle", bundleHash],
        [`ui:${id}`, "ui:updatedAt", term.datetime(new Date(await time.nowMs()).toISOString())],
        ...(manifest.description ? [[`ui:${id}`, "ui:description", String(manifest.description)] as [string, string, ObjectInput]] : []),
        ...(handlerHash ? [[`ui:${id}`, "ui:handler", handlerHash] as [string, string, ObjectInput]] : []),
      ] });
      return { uiId: id, ui: manifest, manifestHash, bundleHash, handlerHash, refs: { manifest: `ui/${id}/manifest`, bundle: `ui/${id}/bundle`, ...(handlerHash ? { handler: `ui/${id}/handler` } : {}) } };
    },
    async open({ chatId, uiId: inputUiId, instanceId: inputInstanceId = null, state = {} }) {
      const uiId = cleanUiIdOrThrow(inputUiId);
      if (!(await uiManifestExists(uiId))) throw new Error(`ui not found: ${uiId}`);
      const c = chatRefs(chatId);
      let instanceId = typeof inputInstanceId === "string" && inputInstanceId.trim()
        ? inputInstanceId.trim().replace(/^uiinst:/, "")
        : null;
      if (!instanceId) {
        const existing = await facts.matchAll({
          patterns: [
            ["?inst", "rdf:type", "ui:Instance"],
            ["?inst", "ui:app", `ui:${uiId}`],
          ],
          ref: c.facts,
          graph: c.graph,
          limit: 1,
        });
        instanceId = existing[0]?.["?inst"]?.replace(/^uiinst:/, "") ?? await id.new("uiinst");
      }
      const inst = `uiinst:${instanceId}`;
      const factReceipt = await facts.update({ ref: c.facts, fn: (txn) => {
        txn.add({ graph: c.graph, subject: `chat:${chatId}`, predicate: "ui:involves", object: `ui:${uiId}` });
        txn.add({ graph: c.graph, subject: `chat:${chatId}`, predicate: "ui:primary", object: `ui:${uiId}` });
        txn.add({ graph: c.graph, subject: inst, predicate: "rdf:type", object: "ui:Instance" });
        txn.add({ graph: c.graph, subject: inst, predicate: "ui:app", object: `ui:${uiId}` });
        txn.add({ graph: c.graph, subject: inst, predicate: "ui:chat", object: `chat:${chatId}` });
        txn.add({ graph: c.graph, subject: inst, predicate: "ui:stateRef", object: `ref:uiinst/${instanceId}/state` });
      } });
      const stateRef = `uiinst/${instanceId}/state`;
      let stateHash = await refs.get(stateRef);
      let createdState = false;
      if (!stateHash) {
        stateHash = await objects.putJSON({ kind: "ui:State", value: state ?? {} });
        await refs.set(stateRef, stateHash);
        createdState = true;
      }
      return { chatId, uiId, instanceId, stateHash, stateRef, createdState, facts: factReceipt };
    },
  },
};

type ChatFactsSummary = {
  totalFacts: number;
  totalTurns: number;
  totalSteps: number;
  status: string;
};

type CachedChatFactsSummary = ChatFactsSummary & {
  factsCount: number;
};

const chatFactsSummaryCache = new Map<string, CachedChatFactsSummary>();

function invalidateChatFactsSummary(ref: string): void {
  const m = /^chat\/([^/]+)\/facts$/.exec(String(ref || ""));
  if (m) chatFactsSummaryCache.delete(m[1]!);
}

async function summarizeAllChatFacts(): Promise<Map<string, ChatFactsSummary>> {
  const raw = JSON.parse(__op_chat_fact_summaries()) as Record<string, ChatFactsSummary | undefined>;
  const summaries = new Map<string, ChatFactsSummary>();
  for (const [chatId, summary] of Object.entries(raw)) {
    if (!summary) continue;
    const cached = {
      factsCount: Number(summary.totalFacts || 0),
      totalFacts: Number(summary.totalFacts || 0),
      totalTurns: Number(summary.totalTurns || 0),
      totalSteps: Number(summary.totalSteps || 0),
      status: String(summary.status || "agent:Done"),
    };
    chatFactsSummaryCache.set(chatId, cached);
    summaries.set(chatId, cached);
  }
  return summaries;
}

async function summarizeChatFacts(chatId: string): Promise<ChatFactsSummary> {
  const ref = `chat/${chatId}/facts`;
  const graph = `chat:${chatId}`;
  const totalFacts = await facts.count({ ref });
  const cached = chatFactsSummaryCache.get(chatId);
  if (cached && cached.factsCount === totalFacts) {
    return {
      totalFacts: cached.totalFacts,
      totalTurns: cached.totalTurns,
      totalSteps: cached.totalSteps,
      status: cached.status,
    };
  }

  const [turnRows, pendingInputs, stepRows] = await Promise.all([
    facts.match({ ref: ref, ...{
      graph,
      predicate: "agent:kind",
      object: "agent:UserInput",
    } }),
    facts.matchAll({ patterns: [
        ["?req", "rdf:type", "ui:InputRequest"],
        ["?req", "ui:status", "ui:Pending"],
      ], ...{ ref, graph, limit: 1 } }),
    facts.matchAll({ patterns: [
        ["?step", "rdf:type", "agent:Step"],
        ["?step", "agent:status", "?status"],
        ["?step", "agent:createdAt", "?at"],
      ], ...{ ref, graph } }),
  ]);

  let status = "agent:Done";
  if (pendingInputs.length > 0) {
    status = "ui:Pending";
  } else if (stepRows.some((s) => s["?status"] === "agent:Running")) {
    status = "agent:Running";
  } else if (stepRows.some((s) => s["?status"] === "agent:Queued")) {
    status = "agent:Queued";
  } else {
    const latest = stepRows
      .map((s) => ({ status: s["?status"] || "agent:Done", at: Number(s["?at"] || 0) }))
      .sort((a, b) => b.at - a.at)[0];
    status = latest?.status || "agent:Done";
  }

  const summary = {
    factsCount: totalFacts,
    totalFacts,
    totalTurns: turnRows.length,
    totalSteps: stepRows.length,
    status,
  };
  chatFactsSummaryCache.set(chatId, summary);
  return summary;
}
function joinPath(base: string, child: string): string {
  const b = String(base || ".").replace(/\/+$/, "") || ".";
  return b + "/" + child.replace(/^\/+/, "");
}

async function chatScratchRoot(chatId: string): Promise<string> {
  return (await refs.get(`chat/${chatId}/path`)) || ".";
}

function chatWorktreePath(chatId: string, root: string): string {
  return joinPath(root, `.moo/${chatId}`);
}

const canonicalDirCache = new Map<string, Promise<string>>();

async function canonicalDir(path: string): Promise<string> {
  let promise = canonicalDirCache.get(path);
  if (!promise) {
    promise = (async () => {
      try {
        return await fs.canonical(path);
      } catch (_) {
        return path;
      }
    })();
    canonicalDirCache.set(path, promise);
  }
  return await promise;
}

function forgetCanonicalDir(path: string) {
  canonicalDirCache.delete(path);
}

const chat: Moo["chat"] = {
  refs({ chatId }) {
    const c = chatRefs(chatId);
    return {
      chatId,
      facts: c.facts,
      factsRef: c.facts,
      head: c.head,
      run: c.run,
      createdAt: c.createdAt,
      lastAt: c.lastAt,
      compaction: c.compaction,
      usage: c.usage,
      model: c.model,
      provider: (c as any).provider ?? `chat/${chatId}/provider`,
      effort: c.effort,
      graph: c.graph,
      chatIri: c.graph,
      stateRefPrefix: "uiinst/",
      headRef: c.head,
      runRef: c.run,
      createdAtRef: c.createdAt,
      lastAtRef: c.lastAt,
      compactionRef: c.compaction,
      usageRef: c.usage,
      modelRef: c.model,
      effortRef: c.effort,
    };
  },
  async scratch(chatId) {
    const root = await chatScratchRoot(chatId);
    const path = chatWorktreePath(chatId, root);
    if (await fs.exists(path)) return await canonicalDir(path);
    // If the cwd is a git repo, prefer a real `git worktree add` from HEAD so
    // the agent gets per-chat branches, diffs, and clean state. Fall back to
    // a plain mkdir when not in a repo (or when worktree creation fails).
    if (await fs.exists(joinPath(root, ".git"))) {
      const result = await proc.run({ cmd: "git", args: ["worktree", "add", "--quiet", path, "HEAD"], ...{ cwd: root, timeoutMs: 10_000 } });
      if (result.code === 0) return await canonicalDir(path);
    }
    await fs.ensureDir(path);
    return await canonicalDir(path);
  },
  async touch(chatId) {
    const createdRef = `chat/${chatId}/created-at`;
    const existing = await refs.get(createdRef);
    if (!existing) {
      await refs.set(createdRef, String(await time.nowMs()));
    }
    await refs.set(`chat/${chatId}/last-at`, String(await time.nowMs()));
  },
  async list() {
    const all = await refs.entries("chat/");
    const ids = new Set<string>();
    const byChat = new Map<string, Record<string, string>>();
    for (const [name, target] of all) {
      const parts = name.split("/");
      if (parts.length < 3) continue;
      const cid = parts[1]!;
      ids.add(cid);
      const key = parts.slice(2).join("/");
      let refsForChat = byChat.get(cid);
      if (!refsForChat) {
        refsForChat = {};
        byChat.set(cid, refsForChat);
      }
      refsForChat[key] = target;
    }
    const allSummaries = await summarizeAllChatFacts();
    const chats = await Promise.all(
      Array.from(ids, async (cid) => {
        const refsForChat = byChat.get(cid) || {};
        const created = refsForChat["created-at"] || null;
        const lastAt = refsForChat["last-at"] || null;
        const head = refsForChat["head"] || null;
        const title = refsForChat["title"] || null;
        const path = refsForChat["path"] || null;
        const archivedRaw = refsForChat["archived-at"] || null;
        const hiddenRaw = refsForChat["hidden"] || null;
        const parentChatId = refsForChat["parent"] || null;
        const usageHash = refsForChat["usage"] || null;
        const [usageObj, summary] = await Promise.all([
          usageHash ? objects.getJSON<{ models: Record<string, { input: number; cachedInput: number; cacheWriteInput?: number; output: number }> }>({ hash: usageHash }) : null,
          allSummaries.get(cid) || summarizeChatFacts(cid),
        ]);
        const archivedAt = archivedRaw ? Number(archivedRaw) : null;
        // Keep chat listing metadata-only. Checking every possible worktree path
        // hits the filesystem for each chat and can dominate initial UI load in
        // repos with many chats. chat.scratch() still resolves/creates the path
        // lazily when code actually needs it, and chat-new returns it when a new
        // chat is explicitly materialized.
        const worktreePath = null;
        const usage = usageObj?.value ?? null;
        return {
          chatId: cid,
          title: title || null,
          createdAt: created ? Number(created) : 0,
          lastAt: lastAt ? Number(lastAt) : created ? Number(created) : 0,
          head: head || null,
          path,
          worktreePath,
          archived: archivedAt != null,
          archivedAt,
          hidden: hiddenRaw === "true",
          parentChatId,
          totalFacts: summary.totalFacts,
          totalTurns: summary.totalTurns,
          totalSteps: summary.totalSteps,
          status: summary.status,
          usage,
        };
      }),
    );

    const byId = new Map(chats.map((c) => [c.chatId, c]));
    function ensureUsage(chat: any) {
      if (!chat.usage) chat.usage = { models: {} };
      return chat.usage as { models: Record<string, { input: number; cachedInput: number; cacheWriteInput?: number; output: number }> };
    }
    function nearestVisibleAncestor(chat: any): any | null {
      const seen = new Set<string>();
      let current = chat;
      while (current?.parentChatId && !seen.has(current.parentChatId)) {
        seen.add(current.parentChatId);
        const parent = byId.get(current.parentChatId);
        if (!parent) return null;
        if (!parent.hidden) return parent;
        current = parent;
      }
      return null;
    }
    for (const child of chats) {
      if (!child.hidden || !child.usage?.models) continue;
      const parent = nearestVisibleAncestor(child);
      if (!parent) continue;
      const parentUsage = ensureUsage(parent);
      for (const [model, counts] of Object.entries(child.usage.models)) {
        const slot = parentUsage.models[model] ?? { input: 0, cachedInput: 0, cacheWriteInput: 0, output: 0 };
        if (slot.cacheWriteInput == null) slot.cacheWriteInput = 0;
        slot.input += Number(counts.input ?? 0);
        slot.cachedInput += Number(counts.cachedInput ?? 0);
        slot.cacheWriteInput += Number(counts.cacheWriteInput ?? 0);
        slot.output += Number(counts.output ?? 0);
        parentUsage.models[model] = slot;
      }
      parent.childUsageIncluded = (Number(parent.childUsageIncluded) || 0) + 1;
    }

    return chats.sort((a, b) => (b.lastAt || b.createdAt || 0) - (a.lastAt || a.createdAt || 0));
  },
  async create(chatId, path = null) {
    let cid = chatId;
    if (!cid) {
      const raw = await id.new("chat");
      // Keep the whole generated payload, including the per-process counter.
      // The previous 12-char truncation kept only the high timestamp bits from
      // ids like `chat:<16 hex nanos><8 hex counter>`, so chats created within
      // the same ~65µs window could collide. Parallel subagents are commonly
      // created that close together, which made distinct prompts share one
      // hidden child chat.
      cid = raw.replace(/^chat:/, "");
    }
    if (path && String(path).trim()) {
      await refs.set(`chat/${cid}/path`, String(path).trim());
    }
    await chat.touch(cid);
    // Do not materialize the per-chat scratch/worktree during creation.
    // Creating a git worktree can be slow in large repositories, and the UI
    // only needs the chat metadata to navigate to an empty chat. The worktree
    // is still created lazily by chat.scratch() before any repo operation or
    // agent run that actually needs it.
    return cid;
  },
  async remove(chatId) {
    if (!chatId) throw new Error("remove requires chatId");
    const root = await chatScratchRoot(chatId);
    const path = chatWorktreePath(chatId, root);
    forgetCanonicalDir(path);
    // If this scratch was set up as a git worktree, the directory contains a
    // .git *file* (not a dir) pointing back at the main repo. Clean it via
    // the git CLI so we don't leave dangling worktree metadata.
    const gitFile = await fs.stat(`${path}/.git`);
    if (gitFile && gitFile.kind === "file") {
      await proc.run({ cmd: "git", args: ["worktree", "remove", "--force", path], timeoutMs: 10_000 });
    } else if (await fs.exists(path)) {
      await proc.run({ cmd: "rm", args: ["-rf", path], timeoutMs: 10_000 });
    }
    const all = await refs.list(`chat/${chatId}/`);
    let clearedQuads = 0;
    for (const name of all) {
      if (name.endsWith("/facts")) {
        clearedQuads += (await facts.deleteRef({ ref: name })).removed;
      }
      await refs.delete(name);
    }
    clearedQuads += (await facts.deleteRef({ ref: `chat/${chatId}/facts` })).removed;
    return { chatId, refsDeleted: all.length, quadsCleared: clearedQuads };
  },
  async setTitle({ chatId, title }) {
    const ref = `chat/${chatId}/title`;
    const previousTitle = await refs.get(ref);
    const nextTitle = title == null || title.trim() === "" ? null : title.trim();
    if (nextTitle == null) {
      await refs.delete(ref);
    } else {
      await refs.set(ref, nextTitle);
    }
    const changed = (previousTitle || null) !== nextTitle;
    if (changed) {
      await recordChatTrailEntry(chatId, "agent:TitleUpdate", {
        title: nextTitle,
        previousTitle: previousTitle || null,
      });
    }
    return { chatId, previousTitle: previousTitle || null, title: nextTitle, changed };
  },
  async recordSummary({ chatId, summary, title = null }) {
    const body = String(summary ?? "").trim();
    if (!body) throw new Error("recordSummary requires a non-empty summary");
    const cleanTitle = title == null ? null : String(title).trim() || null;
    const entryId = await recordChatTrailEntry(chatId, "agent:Summary", {
      title: cleanTitle,
      body,
    }, { touch: true });
    return { chatId, entryId, title: cleanTitle };
  },
  async archive(chatId) {
    const at = String(await time.nowMs());
    await refs.set(`chat/${chatId}/archived-at`, at);
    return Number(at);
  },
  async unarchive(chatId) {
    await refs.delete(`chat/${chatId}/archived-at`);
    return null;
  },
};

const MAX_SUBAGENT_DEPTH = 1;
const MAX_OUTSTANDING_SUBAGENTS_PER_RUNJS = 4;
const DEFAULT_SUBAGENT_TURNS = 6;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60_000;
const MAX_SUBAGENT_TIMEOUT_MS = 30 * 60_000;

type NormalizedSubagentSpec = Required<Pick<SubagentSpec, "label" | "task" | "worktree">> & Omit<SubagentSpec, "label" | "task" | "worktree"> & {
  maxTurns: number;
  timeoutMs: number;
};

function normalizeSubagentSpec(spec: SubagentSpec): NormalizedSubagentSpec {
  if (!spec || typeof spec !== "object") throw new Error("moo.agent.run requires a spec object");
  const label = String(spec.label ?? "").trim();
  const task = String(spec.task ?? "").trim();
  if (!label) throw new Error("moo.agent.run requires spec.label");
  if (!task) throw new Error("moo.agent.run requires spec.task");
  const maxTurns = Math.max(1, Math.min(20, Math.floor(Number(spec.maxTurns ?? DEFAULT_SUBAGENT_TURNS) || DEFAULT_SUBAGENT_TURNS)));
  const timeoutMs = Math.max(1_000, Math.min(MAX_SUBAGENT_TIMEOUT_MS, Math.floor(Number(spec.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS) || DEFAULT_SUBAGENT_TIMEOUT_MS)));
  const worktree = spec.worktree === "inherit" ? "inherit" : "isolated";
  return {
    ...spec,
    label,
    task,
    maxTurns,
    timeoutMs,
    worktree,
    ...(typeof spec.context === "string" && spec.context.trim() ? { context: spec.context } : {}),
    ...(typeof spec.expectedOutput === "string" && spec.expectedOutput.trim() ? { expectedOutput: spec.expectedOutput } : {}),
    ...(typeof spec.model === "string" && spec.model.trim() ? { model: spec.model.trim() } : {}),
    ...(typeof spec.effort === "string" && spec.effort.trim() ? { effort: spec.effort.trim() } : {}),
  };
}

function statusForSubagentResult(status: string): "agent:Done" | "agent:Failed" | "agent:Cancelled" {
  if (status === "done") return "agent:Done";
  if (status === "cancelled") return "agent:Cancelled";
  return "agent:Failed";
}

type LegacySubagentResult = SubagentResult & { text?: unknown };

function normalizeSubagentResult(result: LegacySubagentResult): SubagentResult {
  const output = typeof result.output === "string"
    ? result.output
    : typeof result.text === "string"
      ? result.text
      : "";
  const normalized = { ...result, output } as SubagentResult & { text?: unknown };
  delete normalized.text;
  return normalized;
}

function truncateTitle(title: string): string {
  const t = String(title || "subagent").replace(/\s+/g, " ").trim() || "subagent";
  return t.length <= 60 ? t : t.slice(0, 57).trimEnd() + "…";
}

async function replaceStepStatus(chatId: string, stepId: string, status: string, extras: Array<[string, string]> = []) {
  const c = chatRefs(chatId);
  const cur = await facts.match({ ref: c.facts, ...{ graph: c.graph, subject: stepId, predicate: "agent:status" } });
  await facts.update({ ref: c.facts, fn: (txn) => {
    for (const [g, s, p, o] of cur) txn.remove({ graph: g, subject: s, predicate: p, object: o });
    txn.add({ graph: c.graph, subject: stepId, predicate: "agent:status", object: status });
    for (const [p, o] of extras) txn.add({ graph: c.graph, subject: stepId, predicate: p, object: o });
  } });
}

async function markOutstandingSubagentCancelled(parentChatId: string, childChatId: string, error: string) {
  const stepId = await refs.get(`chat/${childChatId}/parent-step`);
  if (!stepId) return;
  const result: SubagentResult = {
    status: "cancelled",
    childChatId,
    output: "",
    error,
    durationMs: 0,
  };
  const resultHash = await objects.putJSON({ kind: "agent:ToolResult", value: result });
  await replaceStepStatus(parentChatId, stepId, "agent:Cancelled", [["agent:result", resultHash], ["agent:error", error]]);
}

async function createSubagentRunRequest(spec: NormalizedSubagentSpec) {
  const ctx = activeRunJSContext;
  if (!ctx) throw new Error("moo.agent.run is only available inside runJS");
  if (ctx.depth >= MAX_SUBAGENT_DEPTH) throw new Error("subagent depth limit reached");
  if (ctx.outstanding.size >= MAX_OUTSTANDING_SUBAGENTS_PER_RUNJS) {
    throw new Error(`too many outstanding subagents; max is ${MAX_OUTSTANDING_SUBAGENTS_PER_RUNJS}`);
  }

  const parentChatId = ctx.chatId;
  const parentRoot = await refs.get(`chat/${parentChatId}/path`);
  const childChatId = await chat.create(undefined, parentRoot);
  await chat.setTitle({ chatId: childChatId, title: truncateTitle(spec.label) });
  await refs.set(`chat/${childChatId}/hidden`, "true");
  await refs.set(`chat/${childChatId}/parent`, parentChatId);
  await refs.set(`chat/${childChatId}/subagent-depth`, String(ctx.depth + 1));
  await refs.set(`chat/${childChatId}/subagent-parent-runjs`, ctx.runJsStepId);
  if (spec.model) await refs.set(chatRefs(childChatId).model, spec.model);
  if (spec.effort) await memory.assert({ subject: `chat:${childChatId}`, predicate: "ui:effortLevel", object: spec.effort });

  const specHash = await objects.putJSON({ kind: "agent:SubagentSpec", value: spec });
  await refs.set(`chat/${childChatId}/subagent-spec`, specHash);

  const payloadHash = await objects.putJSON({ kind: "agent:Subagent", value: {
    label: spec.label,
    task: spec.task,
    context: spec.context ?? null,
    expectedOutput: spec.expectedOutput ?? null,
    childChatId,
    parentRunJsStepId: ctx.runJsStepId,
    spec,
  } });
  const appended = await appendStep(parentChatId, {
    kind: "agent:Subagent",
    status: "agent:Running",
    payloadHash,
    extras: [
      ["agent:childChat", childChatId],
      ["agent:parentRunJS", ctx.runJsStepId],
    ],
  });
  await refs.set(`chat/${childChatId}/parent-step`, appended.stepId);
  ctx.outstanding.add(childChatId);

  if (spec.worktree === "inherit") {
    // Never share writable dirs. For now inherit only selects the same repo root;
    // the child still gets its own lazy git worktree from chat.scratch().
    await refs.set(`chat/${childChatId}/worktree-mode`, "inherit");
  }

  return {
    requestId: await id.new("subagent"),
    parentChatId,
    parentRunJsStepId: ctx.runJsStepId,
    parentSubagentStepId: appended.stepId,
    childChatId,
    spec,
    limits: {
      maxTurns: spec.maxTurns,
      timeoutMs: spec.timeoutMs,
      depth: ctx.depth + 1,
    },
  };
}

async function finishSubagentRun(childChatId: string, result: SubagentResult) {
  result = normalizeSubagentResult(result as LegacySubagentResult);
  const ctx = activeRunJSContext;
  const parentChatId = ctx?.chatId || (await refs.get(`chat/${childChatId}/parent`));
  const stepId = await refs.get(`chat/${childChatId}/parent-step`);
  if (ctx) ctx.outstanding.delete(childChatId);
  if (!parentChatId || !stepId) return;
  const resultHash = await objects.putJSON({ kind: "agent:ToolResult", value: result });
  const extras: Array<[string, string]> = [["agent:result", resultHash]];
  if (result.error) extras.push(["agent:error", String(result.error)]);
  await replaceStepStatus(parentChatId, stepId, statusForSubagentResult(result.status), extras);
}

async function failSubagentRun(childChatId: string | null, err: unknown) {
  if (!childChatId) return;
  const message = (err as any)?.message || String(err);
  const result: SubagentResult = {
    status: "failed",
    childChatId,
    output: "",
    error: message,
    durationMs: 0,
  };
  await finishSubagentRun(childChatId, result);
}

const agent: Moo["agent"] = {
  async claim(refName, graph, runId, leaseMs = 60_000) {
    const queued = await facts.match({ ref: refName, ...{
      graph,
      predicate: "agent:status",
      object: "agent:Queued",
    } });
    for (const [, stepId] of queued) {
      if (runId) {
        const runRows = await facts.match({ ref: refName, ...{
          graph,
          subject: stepId,
          predicate: "agent:run",
          limit: 1,
        } });
        if (runRows.length && runRows[0]![3] !== runId) continue;
      }
      const leaseId = await id.new("lease");
      const expiresAt = (await time.nowMs()) + leaseMs;
      await facts.update({ ref: refName, fn: (txn) => {
        txn.remove({ graph: graph, subject: stepId, predicate: "agent:status", object: "agent:Queued" });
        txn.add({ graph: graph, subject: stepId, predicate: "agent:status", object: "agent:Running" });
        txn.add({ graph: graph, subject: stepId, predicate: "agent:lease", object: leaseId });
        txn.add({ graph: graph, subject: leaseId, predicate: "agent:expiresAt", object: String(expiresAt) });
      } });
      return { stepId, leaseId, expiresAt };
    }
    return null;
  },
  async complete(refName, graph, stepId, status = "agent:Done") {
    const cur = await facts.match({ ref: refName, ...{
      graph,
      subject: stepId,
      predicate: "agent:status",
    } });
    await facts.update({ ref: refName, fn: (txn) => {
      for (const [g, s, p, o] of cur) txn.remove({ graph: g, subject: s, predicate: p, object: o });
      txn.add({ graph: graph, subject: stepId, predicate: "agent:status", object: status });
    } });
  },
  async fork(chatId, fromStepId = null) {
    const c = {
      facts: `chat/${chatId}/facts`,
      run: `chat/${chatId}/run`,
      graph: `chat:${chatId}`,
      head: `chat/${chatId}/head`,
    };
    const runId = await id.new("run");
    const forkedFrom = fromStepId ?? (await refs.get(c.head));
    await refs.set(c.run, runId);
    await facts.update({ ref: c.facts, fn: (txn) => {
      txn.add({ graph: c.graph, subject: runId, predicate: "rdf:type", object: "agent:Run" });
      txn.add({ graph: c.graph, subject: runId, predicate: "agent:chat", object: c.graph });
      txn.add({ graph: c.graph, subject: runId, predicate: "agent:createdBy", object: "agent:moo" });
      if (forkedFrom) txn.add({ graph: c.graph, subject: runId, predicate: "agent:forkedFrom", object: forkedFrom });
    } });
    return { chatId, runId, forkedFrom };
  },
  async run(spec: SubagentSpec): Promise<SubagentResult> {
    const normalized = normalizeSubagentSpec(spec);
    let request: Awaited<ReturnType<typeof createSubagentRunRequest>> | null = null;
    try {
      request = await createSubagentRunRequest(normalized);
      const raw = await __op_agent_run(JSON.stringify(request));
      const result = normalizeSubagentResult(JSON.parse(raw) as LegacySubagentResult);
      await finishSubagentRun(request.childChatId, result);
      return result;
    } catch (err) {
      await failSubagentRun(request?.childChatId ?? null, err);
      throw err;
    }
  },
};

// -- cross-chat memory + vocabulary ---------------------------------------
//
// Memory is plain RDF: every fact is a (subject, predicate, object) triple
// stored in graph `memory:facts` under ref `memory/facts`. No envelope
// objects — the LLM writes triples directly.
//
// Vocabulary lives in graph `vocab:facts` under `vocab/facts`. Each declared
// predicate is a subject of type `vocab:Predicate` with rdfs:label,
// vocab:description, and vocab:example annotations. `vocab.list()` merges
// declared metadata with usage counts gathered from the memory graph, so the
// LLM can ask "which verbs exist?" before guessing one.

const MEMORY_REF = "memory/facts";
const MEMORY_GRAPH = "memory:facts";
const PROJECT_MEMORY_REF_PREFIX = "memory/project/";
const PROJECT_MEMORY_GRAPH_PREFIX = "memory:project/";
const ALLOWED_MEMORY_KINDS = new Set([
  "memory:Note",
  "memory:Preference",
  "memory:Decision",
  "memory:Summary",
  "memory:Observation",
]);
function validateMemoryKind(subject: string, predicate: string, object: ObjectInput) {
  const value = object instanceof Term ? object.turtle : String(object);
  if ((predicate === "rdf:type" || predicate === "a") && value.startsWith("memory:") && !ALLOWED_MEMORY_KINDS.has(value)) {
    throw new Error(`unknown memory kind ${value}; use one of ${[...ALLOWED_MEMORY_KINDS].join(", ")}`);
  }
  if (subject.startsWith("memory:") && !ALLOWED_MEMORY_KINDS.has(subject) && !subject.startsWith("memory:item/")) {
    throw new Error(`unknown memory subject template ${subject}`);
  }
}
function encodeProjectMemoryId(projectId: string): string {
  const trimmed = projectId.trim();
  if (!trimmed) throw new Error("project memory id cannot be empty");
  return encodeURIComponent(trimmed).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
async function currentProjectMemoryId(): Promise<string> {
  const git = await proc.run({ cmd: "git", args: ["rev-parse", "--show-toplevel"], ...{ timeoutMs: 2_000 } });
  if (git.code === 0 && git.stdout.trim()) return git.stdout.trim();
  const pwd = await env.get("PWD");
  if (pwd && pwd.trim()) return pwd.trim();
  return ".";
}
function memoryScope(refName: string, graph: string): MemoryScope {
  function encodeMemoryFacts(factsInput: unknown, validate: boolean): Array<[string, string, string]> {
    const seen = new Set<string>();
    const encoded: Array<[string, string, string]> = [];
    for (const [subject, predicate, object] of Array.isArray(factsInput) ? unpackMemoryFacts(factsInput) : unpackMemoryWriteArgs(factsInput)) {
      if (validate) validateMemoryKind(subject, predicate, object);
      const value = encodeObject(object);
      const key = JSON.stringify([subject, predicate, value]);
      if (seen.has(key)) continue;
      seen.add(key);
      encoded.push([subject, predicate, value]);
    }
    return encoded;
  }

  async function applyAll(action: "assert" | "retract", factsInput: unknown): Promise<void> {
    const encoded = encodeMemoryFacts(factsInput, action === "assert");
    if (encoded.length === 0) return;
    const quads: Quad[] = encoded.map(([subject, predicate, object]) => [graph, subject, predicate, object]);
    assertFactObjects(quads);
    const present = __op_facts_present(refName, JSON.stringify(quads));
    const changedQuads: Quad[] = [];
    const changes: MemoryChange[] = [];
    for (let i = 0; i < quads.length; i++) {
      const shouldChange = action === "assert" ? !present[i] : present[i];
      if (!shouldChange) continue;
      const quad = quads[i]!;
      changedQuads.push(quad);
      changes.push({ subject: quad[1], predicate: quad[2], object: quad[3] });
    }
    if (changedQuads.length === 0) return;
    if (action === "assert") {
      await facts.swap({ ref: refName, removes: [], adds: changedQuads });
    } else {
      await facts.swap({ ref: refName, removes: changedQuads, adds: [] });
    }
    await recordMemoryDiff(refName, graph, action, changes);
  }

  async function applyPatch(input: unknown): Promise<void> {
    const groups = unpackMemoryPatchGroups(input);
    for (const group of groups) {
      const retracts = encodeMemoryFacts(group.retracts, false);
      const asserts = encodeMemoryFacts(group.asserts, true);
      if (retracts.length === 0 && asserts.length === 0) continue;
      const retractQuads: Quad[] = retracts.map(([subject, predicate, object]) => [graph, subject, predicate, object]);
      const assertQuads: Quad[] = asserts.map(([subject, predicate, object]) => [graph, subject, predicate, object]);
      assertFactObjects([...retractQuads, ...assertQuads]);
      const present = __op_facts_present(refName, JSON.stringify([...retractQuads, ...assertQuads]));
      const addKeys = new Set(assertQuads.map((quad) => JSON.stringify(quad)));
      const removes: Quad[] = [];
      const adds: Quad[] = [];
      const removed: MemoryChange[] = [];
      const added: MemoryChange[] = [];
      for (let i = 0; i < retractQuads.length; i++) {
        const quad = retractQuads[i]!;
        if (!present[i] || addKeys.has(JSON.stringify(quad))) continue;
        removes.push(quad);
        removed.push({ subject: quad[1], predicate: quad[2], object: quad[3] });
      }
      const offset = retractQuads.length;
      for (let i = 0; i < assertQuads.length; i++) {
        const quad = assertQuads[i]!;
        if (present[offset + i]) continue;
        adds.push(quad);
        added.push({ subject: quad[1], predicate: quad[2], object: quad[3] });
      }
      if (removes.length === 0 && adds.length === 0) continue;
      await facts.swap({ ref: refName, removes, adds });
      if (removed.length > 0) await recordMemoryDiff(refName, graph, "retract", removed);
      if (added.length > 0) await recordMemoryDiff(refName, graph, "assert", added);
    }
  }

  return {
    async assert(args) {
      return applyAll("assert", args);
    },
    async retract(args) {
      return applyAll("retract", args);
    },
    async patch(args) {
      return applyPatch(args);
    },
    async query(patterns, opts) {
      const encoded: Triple[] = patterns.map(([s, p, o]) => [
        s as string,
        p as string,
        typeof o === "string" && o.startsWith("?")
          ? o
          : encodeObject(o as ObjectInput),
      ]);
      return facts.matchAll({ patterns: encoded, ...{
        ref: refName,
        graph,
        ...(opts?.limit ? { limit: opts.limit } : {}),
      } });
    },
    async triples(opts) {
      return facts.match({ ref: refName, ...{
        graph,
        subject: opts?.subject ?? null,
        predicate: opts?.predicate ?? null,
        object: opts?.object == null ? null : encodeObject(opts.object as ObjectInput),
        ...(opts?.limit ? { limit: opts.limit } : {}),
      } });
    },
  };
}
const globalMemory = memoryScope(MEMORY_REF, MEMORY_GRAPH);
const memory: Moo["memory"] = Object.assign(globalMemory, {
  project(projectId?: string): MemoryScope {
    let cached: MemoryScope | null = null;
    let pending: Promise<MemoryScope> | null = null;
    async function resolve(): Promise<MemoryScope> {
      if (cached) return cached;
      if (!pending) {
        pending = (async () => {
          const raw = projectId == null ? await currentProjectMemoryId() : projectId;
          const id = encodeProjectMemoryId(raw);
          const refName = `${PROJECT_MEMORY_REF_PREFIX}${id}/facts`;
          const graph = `${PROJECT_MEMORY_GRAPH_PREFIX}${id}`;
          await refs.set(refName, raw);
          cached = memoryScope(refName, graph);
          return cached;
        })();
      }
      return pending;
    }
    return {
      async assert(args) {
        return (await resolve()).assert(args);
      },
      async retract(args) {
        return (await resolve()).retract(args);
      },
      async patch(args) {
        return (await resolve()).patch(args);
      },
      async query(patterns, opts) {
        return (await resolve()).query(patterns, opts);
      },
      async triples(opts) {
        return (await resolve()).triples(opts);
      },
    };
  },
});

const VOCAB_REF = "vocab/facts";
const VOCAB_GRAPH = "vocab:facts";

const vocab: Moo["vocab"] = {
  async define(name, opts) {
    if (!name || !name.trim()) throw new Error("vocab.define requires name");
    // Subject is the literal predicate as used in triples — no auto-prefix.
    // That way `vocab.define('prefers',…)` annotates the same predicate the
    // agent uses in `moo.memory.assert({subject, predicate, object})`.
    const subject = name;
    await facts.update({ ref: VOCAB_REF, fn: (txn) => {
      txn.add({ graph: VOCAB_GRAPH, subject: subject, predicate: "rdf:type", object: "vocab:Predicate" });
      txn.add({ graph: VOCAB_GRAPH, subject: subject, predicate: "rdfs:label", object: opts?.label || name });
      if (opts?.description) {
        txn.add({ graph: VOCAB_GRAPH, subject: subject, predicate: "vocab:description", object: opts.description });
      }
      if (opts?.example) {
        txn.add({ graph: VOCAB_GRAPH, subject: subject, predicate: "vocab:example", object: opts.example });
      }
    } });
  },
  async list() {
    // Declared predicates: read all subjects of type vocab:Predicate plus
    // their annotations.
    const declared = await facts.match({ ref: VOCAB_REF, ...{
      graph: VOCAB_GRAPH,
    } });
    const byPredicate = new Map<
      string,
      { label: string | null; description: string | null; example: string | null }
    >();
    const isPredicate = new Set<string>();
    for (const [, s, p, o] of declared) {
      if (p === "rdf:type" && o === "vocab:Predicate") {
        isPredicate.add(s);
        if (!byPredicate.has(s)) {
          byPredicate.set(s, { label: null, description: null, example: null });
        }
      }
    }
    for (const [, s, p, o] of declared) {
      if (!isPredicate.has(s)) continue;
      const entry = byPredicate.get(s)!;
      if (p === "rdfs:label") entry.label = o;
      else if (p === "vocab:description") entry.description = o;
      else if (p === "vocab:example") entry.example = o;
    }

    // Observed predicates: count occurrences in memory, vocab, project, and chat fact graphs.
    const memoryRefs = [
      MEMORY_REF,
      VOCAB_REF,
      ...(await refs.list(PROJECT_MEMORY_REF_PREFIX)),
      ...(await refs.list("chat/")).filter((refName) =>
        refName.startsWith("chat/") && refName.endsWith("/facts"),
      ),
    ];
    const counts = new Map<string, number>();
    for (const refName of memoryRefs) {
      const observed = await facts.match({ ref: refName });
      for (const [, , p] of observed) {
        counts.set(p, (counts.get(p) || 0) + 1);
      }
    }

    // Backward-compat: older harness builds wrote vocab subjects as
    // "vocab:<name>". Treat those as describing the bare "<name>" predicate
    // so they line up with observed counts.
    const canonical = (s: string) =>
      s.startsWith("vocab:") ? s.slice("vocab:".length) : s;

    const out: Awaited<ReturnType<Moo["vocab"]["list"]>> = [];
    const seen = new Set<string>();
    for (const [subject, meta] of byPredicate) {
      const name = canonical(subject);
      seen.add(name);
      out.push({
        name,
        declared: true,
        count: counts.get(name) || 0,
        ...meta,
      });
    }
    for (const [name, count] of counts) {
      if (seen.has(name)) continue;
      out.push({
        name,
        declared: false,
        count,
        label: null,
        description: null,
        example: null,
      });
    }
    out.sort((a, b) =>
      b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    return out;
  },
};

export const tryApi: Moo["try"] = async (fn) => {
  try {
    return ok(await fn());
  } catch (e) {
    return err(errorInfo(e));
  }
};

export const moo: Moo = {
  try: tryApi,
  time,
  validate,
  id,
  log,
  objects,
  refs,
  sparql,
  facts,
  fs,
  proc,
  workspace,
  http,
  env,
  chat,
  ui,
  mcp,
  agent,
  memory,
  vocab,
  events,
  term,
};
