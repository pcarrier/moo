// Pure patch diff engine for unified and context diffs.
// Host filesystem operations are wired by harness/src/moo.ts.

// Shared port of Python's str.splitlines().
function isLineBreak(ch: number): boolean {
  return (
    ch === 0x0a ||
    ch === 0x0b ||
    ch === 0x0c ||
    ch === 0x0d ||
    ch === 0x1c ||
    ch === 0x1d ||
    ch === 0x1e ||
    ch === 0x85 ||
    ch === 0x2028 ||
    ch === 0x2029
  );
}

function splitLinesKeepEnds(text: string): string[] {
  if (text.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (ch === 0x0d) {
      const end = text.charCodeAt(i + 1) === 0x0a ? i + 2 : i + 1;
      lines.push(text.slice(start, end));
      i = end - 1;
      start = end;
    } else if (isLineBreak(ch)) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function splitLines(text: string): string[] {
  return splitLinesKeepEnds(text).map((line) => {
    if (line.endsWith("\r\n")) return line.slice(0, -2);
    const last = line.charCodeAt(line.length - 1);
    if (
      last === 0x0a ||
      last === 0x0b ||
      last === 0x0c ||
      last === 0x0d ||
      last === 0x1c ||
      last === 0x1d ||
      last === 0x1e ||
      last === 0x85 ||
      last === 0x2028 ||
      last === 0x2029
    ) {
      return line.slice(0, -1);
    }
    return line;
  });
}

const HUNK_HEADER_RE =
  /^@@ -(?<old_start>\d+)(?:,(?<old_count>\d+))? \+(?<new_start>\d+)(?:,(?<new_count>\d+))? @@(?: .*)?$/;
const DIFF_HEADER_PREFIXES = ["diff --git ", "index ", "--- ", "+++ "];
const APPLY_PATCH_UPDATE_FILE_PREFIX = "*** Update File: ";
const UNSUPPORTED_APPLY_PATCH_FILE_HEADER_PREFIXES = [
  "*** Add File: ",
  "*** Delete File: ",
  "*** Move to: ",
];
const APPLY_PATCH_BEGIN = "*** Begin Patch";
const APPLY_PATCH_END = "*** End Patch";
const CONTEXT_HUNK_PREFIX = "@@ ";
const EMPTY_CONTEXT_HUNK = "@@";
const END_OF_FILE_MARKER = "*** End of File";
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

export class PatchError extends Error {}

interface DiffLine {
  prefix: " " | "+" | "-";
  text: string;
  hasNewline: boolean;
}

interface UnifiedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

interface ContextHunk {
  changeContext: string | null;
  lines: DiffLine[];
  isEndOfFile: boolean;
}

interface FileLine {
  text: string;
  hasNewline: boolean;
  // Whether the original terminator for this line was CRLF rather than LF.
  // Preserved so CRLF-terminated files round-trip without silently being
  // rewritten to LF.
  crlf?: boolean;
}

function startsWithAny(line: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => line.startsWith(p));
}

function isDiffMetadataLine(line: string): boolean {
  return (
    startsWithAny(line, DIFF_HEADER_PREFIXES) ||
    line.startsWith(APPLY_PATCH_UPDATE_FILE_PREFIX) ||
    line === APPLY_PATCH_BEGIN ||
    line === APPLY_PATCH_END
  );
}

function normalizeApplyPatchPath(path: string): string {
  const trimmed = path.trim();
  const absolute = trimmed.startsWith("/");
  const parts = trimmed.split("/").filter((part) => part !== "" && part !== ".");
  return (absolute ? "/" : "") + parts.join("/");
}

export function validatePatchEnvelopeTarget(diff: string, targetPath: string): void {
  if (!diff.trim()) return;
  const lines = splitLines(diff).map((l) => l.replace(/\r$/, ""));
  const normalizedTarget = normalizeApplyPatchPath(targetPath);
  for (const line of lines) {
    if (startsWithAny(line, UNSUPPORTED_APPLY_PATCH_FILE_HEADER_PREFIXES)) {
      throw new PatchError(
        "moo.fs.patch only supports updating one existing file; " +
          line +
          " requires a different filesystem operation.",
      );
    }
    if (!line.startsWith(APPLY_PATCH_UPDATE_FILE_PREFIX)) {
      continue;
    }
    const declaredPath = normalizeApplyPatchPath(line.slice(APPLY_PATCH_UPDATE_FILE_PREFIX.length));
    if (declaredPath !== normalizedTarget) {
      throw new PatchError(
        "apply-patch target " +
          JSON.stringify(declaredPath) +
          " does not match requested path " +
          JSON.stringify(normalizedTarget) +
          ".",
      );
    }
  }
}

export function patchText(originalText: string, diff: string): string {
  if (!diff.trim()) {
    return originalText;
  }
  // Match Python: `[line.rstrip("\r") for line in diff.splitlines()]`.
  // str.splitlines() breaks on the full Unicode line-terminator set (\n,
  // \r\n, \r, \v, \f, \x1c-\x1e, \x85, U+2028, U+2029); a bare `\r?\n`
  // would leave mid-line \v/\f/NEL embedded inside a "line".
  const lines = splitLines(diff).map((l) => l.replace(/\r$/, ""));
  const format = detectDiffFormat(lines);
  if (format === "unified") {
    const hunks = parseUnifiedDiffLines(lines);
    if (!hunks.length) {
      return originalText;
    }
    return applyUnifiedHunks(originalText, hunks);
  }
  if (format === "context") {
    const hunks = parseContextDiffLines(lines);
    if (!hunks.length) {
      return originalText;
    }
    return applyContextHunks(originalText, hunks);
  }
  return originalText;
}

function detectDiffFormat(lines: string[]): "unified" | "context" | null {
  for (const line of lines) {
    if (!line || isDiffMetadataLine(line)) {
      continue;
    }
    if (HUNK_HEADER_RE.test(line)) {
      return "unified";
    }
    if (isContextHunkHeader(line)) {
      return "context";
    }
    throw new PatchError(`Unsupported patch diff line: ${line}`);
  }
  return null;
}

function isContextHunkHeader(line: string): boolean {
  return line === EMPTY_CONTEXT_HUNK || line.startsWith(CONTEXT_HUNK_PREFIX);
}

function parseUnifiedDiffLines(lines: string[]): UnifiedHunk[] {
  const hunks: UnifiedHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line) {
      i++;
      continue;
    }
    if (isDiffMetadataLine(line)) {
      i++;
      continue;
    }
    const m = HUNK_HEADER_RE.exec(line);
    if (!m) {
      throw new PatchError(`Unsupported patch diff line: ${line}`);
    }
    const oldStart = parseInt(m.groups!.old_start!, 10);
    const newStart = parseInt(m.groups!.new_start!, 10);
    i++;
    const hunkLines: DiffLine[] = [];
    while (i < lines.length) {
      const next = lines[i]!;
      if (
        HUNK_HEADER_RE.test(next) ||
        isDiffMetadataLine(next)
      ) {
        break;
      }
      if (next === NO_NEWLINE_MARKER) {
        if (!hunkLines.length) {
          throw new PatchError(
            "patch diff used a no-newline marker before any hunk line.",
          );
        }
        hunkLines[hunkLines.length - 1]!.hasNewline = false;
        i++;
        continue;
      }
      if (next && (next[0] === " " || next[0] === "+" || next[0] === "-")) {
        hunkLines.push({
          prefix: next[0] as " " | "+" | "-",
          text: next.slice(1),
          hasNewline: true,
        });
        i++;
        continue;
      }
      throw new PatchError(`Unsupported patch hunk line: ${next}`);
    }
    const consumedOld = hunkLines.filter((l) => l.prefix !== "+").length;
    const producedNew = hunkLines.filter((l) => l.prefix !== "-").length;
    // LLM-produced diffs commonly undercount or overcount context lines in
    // hunk headers. The body is the part we can verify against the source, so
    // trust it for application while keeping the header starts as placement
    // hints.
    hunks.push({
      oldStart,
      oldCount: consumedOld,
      newStart,
      newCount: producedNew,
      lines: hunkLines,
    });
  }
  return hunks;
}

function parseContextDiffLines(lines: string[]): ContextHunk[] {
  const hunks: ContextHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line) {
      i++;
      continue;
    }
    if (isDiffMetadataLine(line)) {
      i++;
      continue;
    }
    let changeContext: string | null;
    if (line === EMPTY_CONTEXT_HUNK) {
      changeContext = null;
    } else if (line.startsWith(CONTEXT_HUNK_PREFIX)) {
      changeContext = line.slice(CONTEXT_HUNK_PREFIX.length);
    } else {
      throw new PatchError(`Unsupported patch diff line: ${line}`);
    }
    i++;
    const hunkLines: DiffLine[] = [];
    let isEndOfFile = false;
    while (i < lines.length) {
      const next = lines[i]!;
      if (
        isContextHunkHeader(next) ||
        isDiffMetadataLine(next)
      ) {
        break;
      }
      if (next === END_OF_FILE_MARKER) {
        if (!hunkLines.length) {
          throw new PatchError(
            "patch diff used an end-of-file marker before any hunk line.",
          );
        }
        isEndOfFile = true;
        i++;
        break;
      }
      if (next === NO_NEWLINE_MARKER) {
        if (!hunkLines.length) {
          throw new PatchError(
            "patch diff used a no-newline marker before any hunk line.",
          );
        }
        hunkLines[hunkLines.length - 1]!.hasNewline = false;
        i++;
        continue;
      }
      if (next === "") {
        hunkLines.push({ prefix: " ", text: "", hasNewline: true });
        i++;
        continue;
      }
      if (next[0] === " " || next[0] === "+" || next[0] === "-") {
        hunkLines.push({
          prefix: next[0] as " " | "+" | "-",
          text: next.slice(1),
          hasNewline: true,
        });
        i++;
        continue;
      }
      throw new PatchError(`Unsupported patch hunk line: ${next}`);
    }
    if (!hunkLines.length) {
      throw new PatchError(
        "patch context hunk did not contain any lines.",
      );
    }
    hunks.push({ changeContext, lines: hunkLines, isEndOfFile });
  }
  return hunks;
}

function splitFileLines(text: string): FileLine[] {
  if (!text) {
    return [];
  }
  const out: FileLine[] = [];
  const parts = text.split("\n");
  const endsWithNL = text.endsWith("\n");
  for (let i = 0; i < parts.length; i++) {
    let s = parts[i]!;
    let crlf = false;
    if (s.endsWith("\r")) {
      s = s.slice(0, -1);
      crlf = true;
    }
    if (i === parts.length - 1) {
      if (s === "" && endsWithNL) {
        break; // trailing newline
      }
      out.push({
        text: s,
        hasNewline: false,
        crlf,
      });
    } else {
      out.push({ text: s, hasNewline: true, crlf });
    }
  }
  // adjust: last line has newline if original text ended with newline and non-empty final segment
  if (endsWithNL && out.length) {
    out[out.length - 1]!.hasNewline = true;
  }
  return out;
}

// New lines produced by the patch inherit the dominant terminator of the
// surrounding file so CRLF files stay CRLF and LF files stay LF. Only lines
// whose `crlf` is a boolean participate — patch-added lines (`crlf` is
// undefined) have no terminator of their own and must not vote, otherwise a
// large insertion into a small CRLF file would flip the dominant to LF and
// produce mixed endings.
function detectDominantEnding(lines: FileLine[]): "crlf" | "lf" {
  let crlf = 0;
  let lf = 0;
  for (const l of lines) {
    if (!l.hasNewline || typeof l.crlf !== "boolean") {
      continue;
    }
    if (l.crlf) {
      crlf++;
    } else {
      lf++;
    }
  }
  return crlf > lf ? "crlf" : "lf";
}

function renderFileLines(lines: FileLine[]): string {
  const dominant = detectDominantEnding(lines);
  const parts: string[] = [];
  for (const l of lines) {
    parts.push(l.text);
    if (l.hasNewline) {
      const useCrlf = l.crlf ?? dominant === "crlf";
      parts.push(useCrlf ? "\r\n" : "\n");
    }
  }
  return parts.join("");
}

function normalise(value: string): string {
  const mapping: Record<string, string> = {
    "\u2010": "-",
    "\u2011": "-",
    "\u2012": "-",
    "\u2013": "-",
    "\u2014": "-",
    "\u2015": "-",
    "\u2212": "-",
    "\u2018": "'",
    "\u2019": "'",
    "\u201a": "'",
    "\u201b": "'",
    "\u201c": '"',
    "\u201d": '"',
    "\u201e": '"',
    "\u201f": '"',
    "\u00a0": " ",
    "\u2002": " ",
    "\u2003": " ",
    "\u2004": " ",
    "\u2005": " ",
    "\u2006": " ",
    "\u2007": " ",
    "\u2008": " ",
    "\u2009": " ",
    "\u200a": " ",
    "\u202f": " ",
    "\u205f": " ",
    "\u3000": " ",
  };
  let out = "";
  for (const ch of value.trim()) {
    out += mapping[ch] ?? ch;
  }
  return out;
}

function sameLine(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  if (a.replace(/\s+$/, "") === b.replace(/\s+$/, "")) {
    return true;
  }
  if (a.trim() === b.trim()) {
    return true;
  }
  return normalise(a) === normalise(b);
}

const lineNormalizers: Array<(s: string) => string> = [
  (s) => s,
  (s) => s.replace(/\s+$/, ""),
  (s) => s.trim(),
  normalise,
];

function sequenceMatches(
  lines: FileLine[],
  pattern: string[],
  index: number,
  normalizer: (s: string) => string,
): boolean {
  for (let j = 0; j < pattern.length; j++) {
    if (normalizer(lines[index + j]!.text) !== normalizer(pattern[j]!)) return false;
  }
  return true;
}

function assertLineMatches(actual: FileLine, expected: string): void {
  if (sameLine(actual.text, expected)) {
    return;
  }
  throw new PatchError(
    `patch diff did not match the current file contents.\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual.text)}`,
  );
}

function getSourceLine(lines: FileLine[], i: number): FileLine {
  const v = lines[i];
  if (!v) {
    throw new PatchError(
      "patch expected more source lines than were available.",
    );
  }
  return v;
}

function resolveHunkSourceIndex(h: UnifiedHunk): number {
  // git's rule is uniformly "insert/replace before 1-based line oldStart", so a
  // pure-insertion hunk (oldCount === 0) must map the same way. Returning
  // oldStart directly put a prepend (`@@ -1,0 +1,1 @@`) after line 1 instead of
  // before it.
  return Math.max(h.oldStart - 1, 0);
}

function seekSequenceNear(
  lines: FileLine[],
  pattern: string[],
  start: number,
  preferred: number,
): number | null {
  if (!pattern.length) return Math.max(start, preferred);
  if (pattern.length > lines.length) return null;
  const lower = Math.max(0, start);
  const upper = lines.length - pattern.length;
  if (lower > upper) return null;
  const center = Math.max(lower, Math.min(preferred, upper));
  const maxDistance = Math.max(center - lower, upper - center);
  for (const n of lineNormalizers) {
    for (let distance = 0; distance <= maxDistance; distance++) {
      const before = center - distance;
      if (before >= lower && sequenceMatches(lines, pattern, before, n)) {
        return before;
      }
      const after = center + distance;
      if (
        distance !== 0 &&
        after <= upper &&
        sequenceMatches(lines, pattern, after, n)
      ) {
        return after;
      }
    }
  }
  return null;
}

interface UnifiedHunkApplication {
  index: number;
  consumed: number;
  replacement: FileLine[];
}

function laterSourceLineMatches(
  hunkLines: DiffLine[],
  start: number,
  actual: FileLine,
): boolean {
  for (let i = start; i < hunkLines.length; i++) {
    const dl = hunkLines[i]!;
    if (dl.prefix === "+") continue;
    return sameLine(actual.text, dl.text);
  }
  return false;
}

function tryBuildUnifiedReplacement(
  original: FileLine[],
  hunk: UnifiedHunk,
  index: number,
  fuzzy: boolean,
): UnifiedHunkApplication | null {
  if (index < 0 || index > original.length) return null;
  const replacement: FileLine[] = [];
  let src = index;
  let matchedSourceLines = 0;
  const sourceLineCount = hunk.lines.filter((l) => l.prefix !== "+").length;

  for (let i = 0; i < hunk.lines.length; i++) {
    const dl = hunk.lines[i]!;
    if (dl.prefix === "+") {
      replacement.push({ text: dl.text, hasNewline: dl.hasNewline });
      continue;
    }

    const actual = original[src];
    if (!actual) return null;
    if (sameLine(actual.text, dl.text)) {
      matchedSourceLines++;
      if (dl.prefix === " ") replacement.push(actual);
      src++;
      continue;
    }

    // If an LLM included a context line from a nearby/stale version, allow it
    // to be omitted when the next source line in the hunk matches the current
    // file. Removals still have to match exactly enough to consume a line.
    if (
      fuzzy &&
      dl.prefix === " " &&
      matchedSourceLines > 0 &&
      laterSourceLineMatches(hunk.lines, i + 1, actual)
    ) {
      continue;
    }
    return null;
  }

  if (sourceLineCount > 0 && matchedSourceLines === 0) return null;
  return { index, consumed: src - index, replacement };
}

function findFuzzyUnifiedApplication(
  original: FileLine[],
  hunk: UnifiedHunk,
  start: number,
  preferred: number,
): UnifiedHunkApplication | null {
  const sourceLineCount = hunk.lines.filter((l) => l.prefix !== "+").length;
  if (!sourceLineCount) {
    const index = Math.max(start, Math.min(preferred, original.length));
    return tryBuildUnifiedReplacement(original, hunk, index, false);
  }
  const lower = Math.max(0, start);
  const upper = original.length - 1;
  if (lower > upper) return null;
  const center = Math.max(lower, Math.min(preferred, upper));
  const maxDistance = Math.max(center - lower, upper - center);
  for (let distance = 0; distance <= maxDistance; distance++) {
    const before = center - distance;
    if (before >= lower) {
      const applied = tryBuildUnifiedReplacement(original, hunk, before, true);
      if (applied) return applied;
    }
    const after = center + distance;
    if (distance !== 0 && after <= upper) {
      const applied = tryBuildUnifiedReplacement(original, hunk, after, true);
      if (applied) return applied;
    }
  }
  return null;
}

function applyUnifiedHunks(originalText: string, hunks: UnifiedHunk[]): string {
  const original = splitFileLines(originalText);
  const out: FileLine[] = [];
  let src = 0;
  for (const hunk of hunks) {
    const expected = resolveHunkSourceIndex(hunk);
    const pattern = hunk.lines.filter((l) => l.prefix !== "+").map((l) => l.text);
    const found = pattern.length ? seekSequenceNear(original, pattern, src, expected) : Math.max(src, expected);
    let applied = found === null ? null : tryBuildUnifiedReplacement(original, hunk, found, false);
    if (!applied) {
      applied = findFuzzyUnifiedApplication(original, hunk, src, expected);
    }
    if (!applied) {
      if (expected < src) {
        throw new PatchError(
          "patch hunks overlap or are out of order.",
        );
      }
      if (expected > original.length) {
        throw new PatchError(
          "patch hunk starts past the end of the file.",
        );
      }
      throw new PatchError(
        "patch diff did not match the current file contents.\nExpected lines:\n" +
          pattern.join("\n"),
      );
    }
    out.push(...original.slice(src, applied.index));
    out.push(...applied.replacement);
    src = applied.index + applied.consumed;
  }
  out.push(...original.slice(src));
  return renderFileLines(out);
}

function seekSequence(
  lines: FileLine[],
  pattern: string[],
  start: number,
  eof: boolean,
): number | null {
  if (!pattern.length) {
    return eof ? lines.length : start;
  }
  if (pattern.length > lines.length) {
    return null;
  }
  const searchStart =
    eof && lines.length >= pattern.length
      ? lines.length - pattern.length
      : start;
  const lastIdx = lines.length - pattern.length;
  for (const n of lineNormalizers) {
    for (let i = searchStart; i <= lastIdx; i++) {
      if (sequenceMatches(lines, pattern, i, n)) {
        return i;
      }
    }
  }
  return null;
}

function buildContextReplacement(
  hunk: ContextHunk,
  matched: FileLine[],
): FileLine[] {
  const out: FileLine[] = [];
  let mi = 0;
  for (const dl of hunk.lines) {
    if (dl.prefix === " ") {
      const a = getSourceLine(matched, mi);
      assertLineMatches(a, dl.text);
      out.push(a);
      mi++;
    } else if (dl.prefix === "-") {
      const a = getSourceLine(matched, mi);
      assertLineMatches(a, dl.text);
      mi++;
    } else {
      out.push({ text: dl.text, hasNewline: dl.hasNewline });
    }
  }
  if (mi !== matched.length) {
    throw new PatchError(
      "patch context hunk did not consume the expected source lines.",
    );
  }
  return out;
}

function applyContextHunks(originalText: string, hunks: ContextHunk[]): string {
  const out = splitFileLines(originalText);
  let search = 0;
  for (const h of hunks) {
    if (h.changeContext !== null) {
      const ci = seekSequence(out, [h.changeContext], search, false);
      if (ci === null) {
        throw new PatchError(
          `patch could not find context line: ${JSON.stringify(h.changeContext)}`,
        );
      }
      search = ci + 1;
    }
    const pattern = h.lines.filter((l) => l.prefix !== "+").map((l) => l.text);
    const mi = seekSequence(out, pattern, search, h.isEndOfFile);
    if (mi === null) {
      if (!pattern.length) {
        throw new PatchError(
          "patch context hunk could not determine where to insert new lines.",
        );
      }
      throw new PatchError(
        "patch diff did not match the current file contents.\nExpected lines:\n" +
          pattern.join("\n"),
      );
    }
    const matched = out.slice(mi, mi + pattern.length);
    const repl = buildContextReplacement(h, matched);
    out.splice(mi, pattern.length, ...repl);
    search = mi + repl.length;
  }
  return renderFileLines(out);
}
