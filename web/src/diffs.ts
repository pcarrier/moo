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
  const groups: FileDiffItem[][] = [];
  for (const item of items) {
    if (item.type !== "file-diff") continue;
    const group = groups.find((candidate) => sameDiffPath(candidate[0]?.path, item.path));
    if (group) group.push(item);
    else groups.push([item]);
  }
  return groups.map((group) => mergeFileDiffItems(group));
}

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
  const synthetic = hasBeforeSnapshot && hasAfterSnapshot && typeof after === "string"
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
  const ops = lineDiff(oldLines, newLines);
  const from = before == null ? "/dev/null" : "a/" + path;
  const header = ["diff --git a/" + path + " b/" + path, "--- " + from, "+++ b/" + path];
  if (ops.every((op) => op.kind === "equal")) return header.join("\n");
  header.push("@@ -" + rangeHeader(1, oldLines.length) + " +" + rangeHeader(1, newLines.length) + " @@");
  for (const op of ops) {
    const prefix = op.kind === "insert" ? "+" : op.kind === "delete" ? "-" : " ";
    header.push(prefix + op.line);
  }
  return header.join("\n");
}

function splitContentLines(content: string): string[] {
  if (content.length === 0) return [];
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

type LineOp = { kind: "equal" | "insert" | "delete"; line: string };

function lineDiff(oldLines: string[], newLines: string[]): LineOp[] {
  const m = oldLines.length;
  const n = newLines.length;
  const cells = (m + 1) * (n + 1);
  if (cells > 2_000_000) return fallbackLineDiff(oldLines, newLines);

  const dp = new Uint32Array(cells);
  const width = n + 1;
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * width + j] = oldLines[i] === newLines[j]
        ? dp[(i + 1) * width + j + 1]! + 1
        : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
    }
  }

  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: "equal", line: oldLines[i]! });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
      ops.push({ kind: "delete", line: oldLines[i]! });
      i++;
    } else {
      ops.push({ kind: "insert", line: newLines[j]! });
      j++;
    }
  }
  while (i < m) ops.push({ kind: "delete", line: oldLines[i++]! });
  while (j < n) ops.push({ kind: "insert", line: newLines[j++]! });
  return ops;
}

function fallbackLineDiff(oldLines: string[], newLines: string[]): LineOp[] {
  return [
    ...oldLines.map((line): LineOp => ({ kind: "delete", line })),
    ...newLines.map((line): LineOp => ({ kind: "insert", line })),
  ];
}

function rangeHeader(start: number, length: number): string {
  if (length === 0) return "0,0";
  return length === 1 ? String(start) : String(start) + "," + String(length);
}
