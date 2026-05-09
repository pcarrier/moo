// Diff helpers are intentionally pure so moo API wrappers can record their output
// without coupling the diff algorithm to host operations.

function splitLinesForDiff(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export type DiffStats = { added: number; removed: number; lines: number };

const DIFF_CONTEXT_LINES = 3;
const MAX_EXACT_DIFF_CELLS = 2_000_000;

type LineOp = { kind: "equal" | "insert" | "delete"; line: string };
type DiffAnchor = { oldIndex: number; newIndex: number };
type UniqueLineInfo = { oldCount: number; oldIndex: number; newCount: number; newIndex: number };
type UnifiedDiffBody = { lines: string[]; added: number; removed: number };

export function unifiedDiffWithStats(path: string, before: string | null, after: string): { diff: string; stats: DiffStats } {
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
