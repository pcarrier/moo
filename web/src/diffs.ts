import type { DiffStats, FileDiffItem, MemoryDiffItem, MemoryFactChange, TimelineItem } from "./api";

export function normalizeDiffPath(path: string): string {
  const raw = String(path || "").trim();
  if (!raw) return "";
  const normalized = normalizePathSegments(raw).replace(/\/+$/, "");
  return normalized === "." ? "" : normalized;
}

export function sameDiffPath(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeDiffPath(a || "");
  const right = normalizeDiffPath(b || "");
  if (!left || !right) return false;
  if (left === right) return true;
  const leftAbsolute = isAbsoluteDiffPath(left);
  const rightAbsolute = isAbsoluteDiffPath(right);
  if (leftAbsolute === rightAbsolute) return false;
  const absolute = leftAbsolute ? left : right;
  const relative = leftAbsolute ? right : left;
  return absolute.endsWith("/" + relative);
}

export function sameDiffPathInRoot(
  a: string | null | undefined,
  b: string | null | undefined,
  root: string | null | undefined,
): boolean {
  const rootPath = normalizedOptionalDiffPath(root);
  if (!rootPath) return sameDiffPath(a, b);
  const left = diffPathKeys(a, rootPath);
  const right = diffPathKeys(b, rootPath);
  for (const key of left) if (right.has(key)) return true;
  return false;
}

function diffPathKeys(path: string | null | undefined, root: string): Set<string> {
  const normalized = normalizeDiffPath(String(path || ""));
  const keys = new Set<string>();
  if (!normalized) return keys;
  const absolute = isAbsoluteDiffPath(normalized);
  keys.add((absolute ? "abs:" : "rel:") + normalized);
  if (absolute) {
    if (pathWithinRoot(normalized, root)) {
      const relative = relativePathWithinRoot(root, normalized);
      if (relative) keys.add("rel:" + relative);
    }
  } else {
    const absolutePath = normalizeDiffPath(joinPath(root, normalized));
    if (absolutePath) keys.add("abs:" + absolutePath);
  }
  return keys;
}

function normalizedOptionalDiffPath(path: string | null | undefined): string | null {
  const normalized = normalizeDiffPath(String(path || ""));
  return normalized || null;
}

function isAbsoluteDiffPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

function pathWithinRoot(path: string, root: string): boolean {
  const normalizedRoot = normalizeDiffPath(root).replace(/\/+$/, "") || "/";
  const normalizedPath = normalizeDiffPath(path).replace(/\/+$/, "") || "/";
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot.replace(/\/+$/, "") + "/");
}

function relativePathWithinRoot(root: string, path: string): string {
  const normalizedRoot = normalizeDiffPath(root).replace(/\/+$/, "") || "/";
  const normalizedPath = normalizeDiffPath(path);
  if (normalizedRoot === "/") return normalizedPath.replace(/^\/+/, "");
  return normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, "");
}

function joinPath(base: string, child: string): string {
  return base.replace(/\/+$/, "") + "/" + child.replace(/^\/+/, "");
}


export type MemoryGraphDiffSummary = {
  type: "memory-graph-diff";
  id: string;
  chatId: string;
  store: string;
  graph: string;
  path: string;
  diff: string;
  stats: DiffStats;
  addedFacts: number;
  removedFacts: number;
  items: MemoryDiffItem[];
  changes?: (MemoryFactChange & { action?: "assert" | "retract" })[];
  before?: string;
  after?: string;
  at: number;
};

export function mergedMemoryDiffs(items: TimelineItem[] | MemoryDiffItem[]): MemoryGraphDiffSummary[] {
  const groups = new Map<string, MemoryDiffItem[]>();
  for (const item of items) {
    if (item.type !== "memory-diff") continue;
    const store = item.store || "memory/facts";
    const graph = item.graph || "(default)";
    const key = store + "\u0000" + graph;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(item);
  }
  return [...groups.values()].map(mergeMemoryDiffItems);
}

export function mergeMemoryDiffItems(items: MemoryDiffItem[]): MemoryGraphDiffSummary {
  if (items.length === 0) throw new Error("cannot merge an empty memory diff list");
  const ordered = [...items].sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const store = last.store || first.store || "memory/facts";
  const graph = last.graph || first.graph || "(default)";
  const path = last.path || first.path || store + ".ttl";
  let addedFacts = 0;
  let removedFacts = 0;
  for (const item of ordered) {
    const count = Number.isFinite(Number(item.count)) ? Math.max(0, Number(item.count)) : diffFactCount(item);
    if (item.action === "retract") removedFacts += count;
    else if (item.action === "assert") addedFacts += count;
    else {
      const stats = diffStats(item.diff || "");
      addedFacts += stats.added;
      removedFacts += stats.removed;
    }
  }
  const diff = concatenateMemoryDiffs(ordered);
  const changes = ordered.flatMap((item) => (item.changes || []).map((change) => ({ ...change, action: item.action })));
  return {
    type: "memory-graph-diff",
    id: "memory-merged:" + store + ":" + graph,
    chatId: last.chatId || first.chatId,
    store,
    graph,
    path,
    diff,
    stats: diffStats(diff),
    addedFacts,
    removedFacts,
    items: ordered,
    changes,
    before: first.before,
    after: last.after,
    at: Number(last.at || first.at || 0),
  };
}

function diffFactCount(item: MemoryDiffItem): number {
  const stats = diffStats(item.diff || "");
  if (stats.added === 0 && stats.removed === 0) return 0;
  if (stats.added > 0 && stats.removed === 0) return stats.added;
  if (stats.removed > 0 && stats.added === 0) return stats.removed;
  return Math.max(stats.added, stats.removed);
}

function concatenateMemoryDiffs(items: MemoryDiffItem[]): string {
  return items.map((item) => item.diff.trimEnd()).filter(Boolean).join("\n");
}

export type MergedFileDiffItem = FileDiffItem & { items?: FileDiffItem[] };

export function hasFileDiffBeforeSnapshot(item: FileDiffItem): boolean {
  return Object.prototype.hasOwnProperty.call(item, "before")
    && (typeof item.before === "string" || item.before === null);
}

export function mergedFileDiffs(items: TimelineItem[] | FileDiffItem[]): MergedFileDiffItem[] {
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

export function mergeFileDiffItems(items: FileDiffItem[]): MergedFileDiffItem {
  if (items.length === 0) throw new Error("cannot merge an empty diff list");

  const ordered = [...items].sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const path = last.path || first.path;
  const before = first.before;
  const after = last.after;
  const hasBeforeSnapshot = hasFileDiffBeforeSnapshot(first);
  const hasAfterSnapshot = Object.prototype.hasOwnProperty.call(last, "after")
    && (typeof after === "string" || after === null);
  const beforeSize = typeof before === "string" ? before.length : 0;
  const afterSize = typeof after === "string" ? after.length : 0;
  const tooLargeForSynthetic = beforeSize + afterSize > SYNTHETIC_DIFF_MAX_BYTES;
  const concatenated = concatenateDiffs(ordered);
  // Some recorded patch text has historically carried a deletion header
  // (`+++ /dev/null`) even though the hydrated payload still has a real
  // post-change snapshot. Trust the snapshots once both ends are present so a
  // lightly modified file is not rendered as a complete deletion in the
  // sidebar.
  const shouldPreferSynthetic = hasBeforeSnapshot && hasAfterSnapshot
    && !tooLargeForSynthetic
    && (after !== null || !looksLikeDeletionDiff(concatenated));
  const synthetic = shouldPreferSynthetic
    ? unifiedDiff(path, before ?? null, after ?? "", after !== null)
    : null;
  const diff = synthetic || concatenated;
  const merged: MergedFileDiffItem = {
    ...last,
    id: "merged:" + normalizeDiffPath(path),
    path,
    diff,
    stats: diffStats(diff),
    items: ordered,
  };
  delete merged.before;
  delete merged.after;
  if (hasBeforeSnapshot) merged.before = before;
  if (hasAfterSnapshot) merged.after = after;
  return merged;
}

function concatenateDiffs(items: FileDiffItem[]): string {
  return items.map((item) => item.diff.trimEnd()).filter(Boolean).join("\n");
}

function looksLikeDeletionDiff(diff: string): boolean {
  return /^\+\+\+ \/dev\/null(?:\t.*)?$/m.test(diff);
}

export function diffStats(diff: string): DiffStats {
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

export function unifiedFileDiff(path: string, before: string | null, after: string): string {
  return unifiedDiff(path, before, after);
}

function unifiedDiff(path: string, before: string | null, after: string, afterExists = true): string {
  const oldLines = splitContentLines(before ?? "");
  const newLines = splitContentLines(after);
  const ops = patienceLineDiff(oldLines, newLines);
  const from = before == null ? "/dev/null" : "a/" + path;
  const to = afterExists ? "b/" + path : "/dev/null";
  const header = ["--- " + from, "+++ " + to];
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
  if (typeof snapshot === "string" && isSingleUnifiedFilePatch(lines)) {
    const sections = diffDisplaySectionsWithSnapshotContext(lines, snapshot);
    if (sections) return sections;
  }
  return collapsedDiffLineSections(lines);
}

function isSingleUnifiedFilePatch(lines: string[]): boolean {
  let fileHeaderCount = 0;
  let oldPathHeaderCount = 0;
  let newPathHeaderCount = 0;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) fileHeaderCount++;
    else if (line.startsWith("--- ")) oldPathHeaderCount++;
    else if (line.startsWith("+++ ")) newPathHeaderCount++;
  }
  return fileHeaderCount <= 1 && oldPathHeaderCount <= 1 && newPathHeaderCount <= 1;
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
      controlsPosition: "after",
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


function normalizePathSegments(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const absolute = normalized.startsWith("/");
  const prefixMatch = normalized.match(/^[A-Za-z]:\//);
  const prefix = prefixMatch
    ? prefixMatch[0].replace(/\/$/, "")
    : absolute
      ? "/"
      : "";
  const rest = prefixMatch
    ? normalized.slice(prefixMatch[0].length)
    : absolute
      ? normalized.slice(1)
      : normalized;
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!prefix) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  if (prefix === "/") return "/" + parts.join("/");
  if (prefix) return prefix + (parts.length ? "/" + parts.join("/") : "");
  return parts.join("/") || ".";
}
