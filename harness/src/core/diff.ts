// Diff helpers are intentionally pure so moo API wrappers can record their output
// without coupling the diff algorithm to host operations.

type SplitLines = { lines: string[]; eofNewline: boolean };

function splitLinesForDiff(text: string): SplitLines {
  if (text.length === 0) return { lines: [], eofNewline: true };
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const eofNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return { lines, eofNewline };
}

// Marker emitted by git-style unified diffs when a side's final line is not
// terminated by a newline. patch.ts parses the identical string back into
// FileLine.hasNewline=false, so the diff round-trips through patchText.
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

export type DiffStats = { added: number; removed: number; lines: number };

const DIFF_CONTEXT_LINES = 3;
const MAX_EXACT_DIFF_CELLS = 2_000_000;

type LineOp = { kind: "equal" | "insert" | "delete"; line: string };
type DiffAnchor = { oldIndex: number; newIndex: number };
type UniqueLineInfo = { oldCount: number; oldIndex: number; newCount: number; newIndex: number };
type UnifiedDiffBody = { lines: string[]; added: number; removed: number };

export function unifiedDiffWithStats(path: string, before: string | null, after: string | null): { diff: string; stats: DiffStats } {
  const oldSplit = splitLinesForDiff(before ?? "");
  const newSplit = splitLinesForDiff(after ?? "");
  const oldLines = oldSplit.lines;
  const newLines = newSplit.lines;
  // A missing side (/dev/null) has no meaningful EOF-newline state; treat it as
  // "has newline" so it never spuriously emits a no-newline marker.
  const oldEof = before == null ? true : oldSplit.eofNewline;
  const newEof = after == null ? true : newSplit.eofNewline;
  const ops = patienceLineDiff(oldLines, newLines);
  const from = before == null ? "/dev/null" : "a/" + path;
  const to = after == null ? "/dev/null" : "b/" + path;
  const header = ["--- " + from, "+++ " + to];
  const body = unifiedDiffBody(ops, DIFF_CONTEXT_LINES, oldEof, newEof);

  if (body.added === 0 && body.removed === 0) {
    // No textual changes and matching EOF-newline state: emit an empty body so
    // patchText round-trips this diff to the original text (its !hunks.length
    // no-op path fires) instead of throwing on a placeholder hunk.
    const diff = header.join("\n");
    return { diff, stats: { added: 0, removed: 0, lines: header.length } };
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

function unifiedDiffBody(ops: LineOp[], contextLines: number, oldEof: boolean, newEof: boolean): UnifiedDiffBody {
  let lines: LineOp[] = [...ops];

  // Normalize trailing "equal" (context) ops so the no-newline marker can be
  // attached to exactly the side(s) that lack a trailing newline.
  //
  // A marker after a context (" ") line applies to BOTH the old and new
  // rendering of that line, and patchText reuses the source line's terminator
  // for context matches. So a context line may carry the marker only when it is
  // simultaneously the final line of both sides AND both sides agree on the
  // missing newline (e.g. an otherwise unchanged file that has no trailing
  // newline on either side). In any other case — the two sides disagree on the
  // EOF newline, or one side's final line is a context op but the other side
  // continues past it — that trailing context line must become a delete+insert
  // pair so the marker (and thus the rendered terminator) lands on the correct
  // side only. This also turns a pure EOF-newline delta (otherwise all "equal")
  // into a real hunk instead of collapsing to 0/0 "no textual changes".
  if (lines.length > 0) {
    // Index of the op representing each side's final line: the last non-insert
    // op for the old side, the last non-delete op for the new side.
    let oldLastIdx = -1;
    let newLastIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.kind !== "insert") oldLastIdx = i;
      if (lines[i]!.kind !== "delete") newLastIdx = i;
    }
    const lastIdx = lines.length - 1;
    const sharedFinalContext =
      oldLastIdx === lastIdx && newLastIdx === lastIdx && lines[lastIdx]!.kind === "equal";
    const splitIdx = new Set<number>();
    // Old side's final line lacks a newline and is a context op that is not the
    // safely-shared final line: split so a "-"+marker can be emitted.
    if (!oldEof && oldLastIdx >= 0 && lines[oldLastIdx]!.kind === "equal") {
      if (!(sharedFinalContext && oldEof === newEof)) splitIdx.add(oldLastIdx);
    }
    // New side's final line lacks a newline and is a context op that is not the
    // safely-shared final line: split so a "+"+marker can be emitted.
    if (!newEof && newLastIdx >= 0 && lines[newLastIdx]!.kind === "equal") {
      if (!(sharedFinalContext && oldEof === newEof)) splitIdx.add(newLastIdx);
    }
    if (splitIdx.size > 0) {
      const rebuilt: LineOp[] = [];
      for (let i = 0; i < lines.length; i++) {
        const op = lines[i]!;
        if (splitIdx.has(i)) {
          rebuilt.push({ kind: "delete", line: op.line });
          rebuilt.push({ kind: "insert", line: op.line });
        } else {
          rebuilt.push(op);
        }
      }
      lines = rebuilt;
    }
  }

  const oldPrefixCounts: number[] = [0];
  const newPrefixCounts: number[] = [0];
  const changeIndexes: number[] = [];
  let added = 0;
  let removed = 0;

  // Index (into `lines`) of the last op that consumes a line from each side.
  // A trailing no-newline marker is emitted only after these lines.
  let lastOldOpIndex = -1;
  let lastNewOpIndex = -1;

  for (let index = 0; index < lines.length; index++) {
    const op = lines[index]!;
    if (op.kind === "insert") added++;
    else if (op.kind === "delete") removed++;
    if (op.kind !== "equal") changeIndexes.push(index);

    if (op.kind !== "insert") lastOldOpIndex = index;
    if (op.kind !== "delete") lastNewOpIndex = index;

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
      // Emit the no-newline marker immediately after the line representing each
      // side's final, unterminated line. A marker after a context (" ") line
      // applies to BOTH the old and new output, so it is only safe there when
      // the line is simultaneously the last line of both sides. For a side
      // whose final line is a context line but the other side continues past it
      // (so it is not the shared last op), the split above has already turned
      // that line into a delete/insert pair, so we only reach a context line
      // here when it is genuinely the last line of both sides.
      const sharedLast = i === lastOldOpIndex && i === lastNewOpIndex;
      const oldMarker = line.kind === "delete"
        ? i === lastOldOpIndex && !oldEof
        : sharedLast && !oldEof;
      const newMarker = line.kind === "insert"
        ? i === lastNewOpIndex && !newEof
        : sharedLast && !newEof;
      if (oldMarker || newMarker) {
        hunkLines.push(NO_NEWLINE_MARKER);
      }
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
