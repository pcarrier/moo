import type { DiffStats, FileDiffItem, TimelineItem } from "./api";

export function normalizeDiffPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function sameDiffPath(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeDiffPath(a || "");
  const right = normalizeDiffPath(b || "");
  if (!left || !right) return false;
  return left === right || left.endsWith("/" + right) || right.endsWith("/" + left);
}

export function mergedFileDiffs(items: TimelineItem[] | FileDiffItem[]): FileDiffItem[] {
  // Group by normalized path in O(N) using a Map. The previous implementation
  // scanned existing groups for each item via sameDiffPath, making the
  // "Total diff" panel O(N^2) over the number of file diffs in the timeline
  // (and this was recomputed on every Sidebar render). sameDiffPath also
  // has a lenient "endsWith" tail-match rule for paths that don't share an
  // exact normalized form; keep that behavior as a fallback for groups that
  // miss the fast Map lookup.
  const groups: FileDiffItem[][] = [];
  const byKey = new Map<string, FileDiffItem[]>();
  for (const item of items) {
    if (item.type !== "file-diff") continue;
    const key = normalizeDiffPath(item.path || "");
    let group = key ? byKey.get(key) : undefined;
    if (!group) {
      // Rare path: nonempty but unnormalizable, or paths that only match
      // via the tail-suffix rule. Fall back to the O(groups) scan but only
      // when the exact-key lookup misses, so the common case stays O(N).
      group = groups.find((candidate) => sameDiffPath(candidate[0]?.path, item.path));
      if (group) {
        if (key) byKey.set(key, group);
      } else {
        group = [];
        groups.push(group);
        if (key) byKey.set(key, group);
      }
    }
    group.push(item);
  }
  return groups.map((group) => mergeFileDiffItems(group));
}

// Cap synthetic full-file diffs to keep mergedFileDiffs cheap on huge files.
// `unifiedDiff` line-splits and patience-matches each side, and the LCS
// fallback allocates an O(N*M) Uint32Array — running that across many groups
// on chat load freezes the main thread. Beyond this size, fall back to
// concatenating the recorded per-step diffs instead.
const SYNTHETIC_DIFF_MAX_BYTES = 1 << 20;

export function mergeFileDiffItems(items: FileDiffItem[]): FileDiffItem {
  if (items.length === 0) throw new Error("cannot merge an empty diff list");
  if (items.length === 1) return items[0]!;

  const ordered = [...items].sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const path = last.path || first.path;
  const before = first.before;
  const after = last.after;
  const hasBeforeSnapshot = Object.prototype.hasOwnProperty.call(first, "before");
  const hasAfterSnapshot = Object.prototype.hasOwnProperty.call(last, "after");
  const beforeSize = typeof before === "string" ? before.length : 0;
  const afterSize = typeof after === "string" ? after.length : 0;
  const tooLargeForSynthetic = beforeSize + afterSize > SYNTHETIC_DIFF_MAX_BYTES;
  const synthetic = !tooLargeForSynthetic
    && hasBeforeSnapshot && hasAfterSnapshot && typeof after === "string"
    ? unifiedDiff(path, before ?? null, after)
    : null;
  const diff = synthetic || concatenateDiffs(ordered);
  return {
    ...last,
    id: "merged:" + normalizeDiffPath(path),
    path,
    diff,
    stats: diffStats(diff),
    before,
    after,
  };
}

function concatenateDiffs(items: FileDiffItem[]): string {
  return items.map((item) => item.diff.trimEnd()).filter(Boolean).join("\n");
}

function diffStats(diff: string): DiffStats {
  const lines = diff ? diff.split("\n").length : 0;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed, lines };
}

function unifiedDiff(path: string, before: string | null, after: string): string {
  const oldLines = splitContentLines(before ?? "");
  const newLines = splitContentLines(after);
  const ops = patienceLineDiff(oldLines, newLines);
  const from = before == null ? "/dev/null" : "a/" + path;
  const header = ["diff --git a/" + path + " b/" + path, "--- " + from, "+++ b/" + path];
  const body = unifiedDiffBody(ops, DIFF_CONTEXT_LINES);
  if (body.added === 0 && body.removed === 0) return header.join("\n");
  return [...header, ...body.lines].join("\n");
}

function splitContentLines(content: string): string[] {
  if (content.length === 0) return [];
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

const DIFF_CONTEXT_LINES = 3;
const MAX_EXACT_DIFF_CELLS = 2_000_000;

type LineOp = { kind: "equal" | "insert" | "delete"; line: string };
type DiffAnchor = { oldIndex: number; newIndex: number };
type UniqueLineInfo = { oldCount: number; oldIndex: number; newCount: number; newIndex: number };
type UnifiedDiffBody = { lines: string[]; added: number; removed: number };

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

export type DiffDisplaySection =
  | { kind: "lines"; lines: string[] }
  | {
      kind: "collapsed";
      lines: string[];
      total: number;
      expandFrom?: "start" | "end";
      controlsPosition?: "before" | "after";
      location?: "above" | "below";
    };

type DisplayHunkHeader = { newStart: number; newLength: number };

const DIFF_DISPLAY_CONTEXT_KEEP = 3;
const DIFF_DISPLAY_COLLAPSE_MIN = 14;

export function diffDisplaySections(diff: string, snapshot?: string | null): DiffDisplaySection[] {
  const lines = diff.split("\n");
  if (typeof snapshot === "string") {
    const sections = diffDisplaySectionsWithSnapshotContext(lines, snapshot);
    if (sections) return sections;
  }
  return collapsedDiffLineSections(lines);
}

function diffDisplaySectionsWithSnapshotContext(lines: string[], after: string): DiffDisplaySection[] | null {
  const afterLines = splitSnapshotLines(after);
  const sections: DiffDisplaySection[] = [];
  let pending: string[] = [];
  let sawHunk = false;
  let lastNewEnd = 0;

  const flushPending = () => {
    if (!pending.length) return;
    sections.push(...collapsedDiffLineSections(pending));
    pending = [];
  };

  for (let i = 0; i < lines.length;) {
    const hunk = parseDisplayHunkHeader(lines[i]!);
    if (!hunk) {
      pending.push(lines[i]!);
      i++;
      continue;
    }

    // When a complete post-change snapshot is available, the UI can render the
    // hidden gaps as expandable code context. In that view the hunk range marker
    // would sit in the middle of otherwise contiguous code, so use it only for
    // placement calculations and do not render it.
    sawHunk = true;
    i++;
    flushPending();

    const newBefore = hunkNewBeforeCount(hunk);
    const hiddenStart = clampLineIndex(lastNewEnd, afterLines.length);
    const hiddenEnd = clampLineIndex(newBefore, afterLines.length);
    if (hiddenEnd > hiddenStart) {
      sections.push(collapsedSnapshotSection(afterLines.slice(hiddenStart, hiddenEnd), {
        expandFrom: "end",
        controlsPosition: "before",
        location: "above",
      }));
    }

    const bodyStart = i;
    while (i < lines.length && !parseDisplayHunkHeader(lines[i]!)) i++;
    sections.push(...collapsedDiffLineSections(lines.slice(bodyStart, i)));
    lastNewEnd = Math.max(lastNewEnd, clampLineIndex(newBefore + hunk.newLength, afterLines.length));
  }

  flushPending();
  if (!sawHunk) return null;

  if (lastNewEnd < afterLines.length) {
    sections.push(collapsedSnapshotSection(afterLines.slice(lastNewEnd), {
      expandFrom: "start",
      controlsPosition: "before",
      location: "below",
    }));
  }
  return sections;
}

function collapsedDiffLineSections(lines: string[]): DiffDisplaySection[] {
  const sections: DiffDisplaySection[] = [];
  let pending: string[] = [];
  const flushLines = () => {
    if (!pending.length) return;
    sections.push({ kind: "lines", lines: pending });
    pending = [];
  };
  for (let i = 0; i < lines.length;) {
    if (!isCollapsibleContextLine(lines[i]!)) {
      pending.push(lines[i]!);
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && isCollapsibleContextLine(lines[i]!)) i++;
    const run = lines.slice(start, i);
    if (run.length < DIFF_DISPLAY_COLLAPSE_MIN) {
      pending.push(...run);
      continue;
    }
    pending.push(...run.slice(0, DIFF_DISPLAY_CONTEXT_KEEP));
    flushLines();
    const hidden = run.slice(DIFF_DISPLAY_CONTEXT_KEEP, run.length - DIFF_DISPLAY_CONTEXT_KEEP);
    sections.push({ kind: "collapsed", lines: hidden, total: hidden.length, expandFrom: "start", controlsPosition: "after" });
    pending.push(...run.slice(run.length - DIFF_DISPLAY_CONTEXT_KEEP));
  }
  flushLines();
  return sections;
}

function collapsedSnapshotSection(lines: string[], options: Pick<Extract<DiffDisplaySection, { kind: "collapsed" }>, "expandFrom" | "controlsPosition" | "location">): DiffDisplaySection {
  const contextLines = lines.map((line) => " " + line);
  return { kind: "collapsed", lines: contextLines, total: contextLines.length, ...options };
}

function splitSnapshotLines(content: string): string[] {
  if (content.length === 0) return [];
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

function parseDisplayHunkHeader(line: string): DisplayHunkHeader | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) return null;
  const newStart = Number(match[3]);
  const newLength = match[4] === undefined ? 1 : Number(match[4]);
  if (!Number.isFinite(newStart) || !Number.isFinite(newLength)) return null;
  return { newStart, newLength };
}

function hunkNewBeforeCount(hunk: DisplayHunkHeader): number {
  return Math.max(0, hunk.newLength === 0 ? hunk.newStart : hunk.newStart - 1);
}

function clampLineIndex(index: number, lineCount: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(lineCount, index));
}

function isCollapsibleContextLine(line: string): boolean {
  return line.startsWith(" ") || line === "";
}

