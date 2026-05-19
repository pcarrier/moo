import type { DiffStats, StepItem } from "../api";
import { formatHjson, maybeFormatHjsonTextForView } from "../syntax";

export function shortHash(hash: string): string {
  const normalized = String(hash || "");
  const bare = normalized.startsWith("sha256:")
    ? normalized.slice("sha256:".length)
    : normalized;
  return bare ? bare.slice(0, 12) : "unknown";
}

export function formatByteCount(bytes: unknown): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "unknown size";
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = n / 1024;
  let unit = units[0]!;
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i]!;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}


export type ParsedRunTS = {
  label: string;
  description: string;
  args: string;
  hasArgs: boolean;
  code: string;
  result: string;
  hasResult: boolean;
  error: string;
  backgroundAfterNs?: number;
  durationNs?: number;
};

export function normalizeRunTS(runts: NonNullable<StepItem["runts"]>): ParsedRunTS {
  const hasArgs = Object.prototype.hasOwnProperty.call(runts, "args");
  return {
    label: cleanRunTSLabel(String(runts.label ?? "")),
    description: String(runts.description ?? "").trim(),
    args: hasArgs ? formatRunTSArgs(runts.args) : "",
    hasArgs,
    code: trimRunTSBlock(String(runts.code ?? "")),
    result: trimRunTSBlock(String(runts.result ?? "")),
    hasResult: runts.result != null,
    error: trimRunTSBlock(String(runts.error ?? "")),
    backgroundAfterNs:
      typeof runts.backgroundAfterNs === "number"
        ? runts.backgroundAfterNs
        : undefined,
    durationNs:
      typeof runts.durationNs === "number" ? runts.durationNs : undefined,
  };
}

export function parseRunTS(text: string): ParsedRunTS {
  const lines = text.split("\n");
  let label = "";
  let description = "";
  const codeBuf: string[] = [];
  const resultBuf: string[] = [];
  const errorBuf: string[] = [];
  let hasResult = false;
  let mode: "header" | "code" | "result" | "error" = "header";

  for (const line of lines) {
    if (line.startsWith("@@label ")) {
      label = line.slice("@@label ".length);
      continue;
    }
    if (line.startsWith("@@desc ")) {
      description = line.slice("@@desc ".length);
      continue;
    }
    if (line === "@@code") {
      mode = "code";
      continue;
    }
    if (line.startsWith("→ ") || line.startsWith("→")) {
      mode = "result";
      hasResult = true;
      resultBuf.push(line.replace(/^→ ?/, ""));
      continue;
    }
    if (/^error:?\s*/i.test(line)) {
      mode = "error";
      errorBuf.push(line.replace(/^error:?\s*/i, ""));
      continue;
    }
    if (mode === "header") {
      // Backward-compat for older steps written before sentinel prefixes:
      // first line is label (with trailing colon), rest is code until arrow.
      if (!label) {
        label = line.replace(/:$/, "");
        mode = "code";
        continue;
      }
    }
    if (mode === "code") codeBuf.push(line);
    else if (mode === "result") resultBuf.push(line);
    else if (mode === "error") errorBuf.push(line);
  }

  return {
    label: cleanRunTSLabel(label),
    description: description.trim(),
    args: "",
    hasArgs: false,
    code: trimRunTSBlock(codeBuf.join("\n")),
    result: trimRunTSBlock(resultBuf.join("\n")),
    hasResult,
    error: trimRunTSBlock(errorBuf.join("\n")),
  };
}

function cleanRunTSLabel(label: string): string {
  return label.replace(/^\s*\[code\]\s*:?[ \t]*/i, "").trim();
}

function trimRunTSBlock(text: string): string {
  return text.replace(/\r?\n$/, "");
}

export function formatRunTSArgs(args: unknown): string {
  if (typeof args === "undefined") return "undefined";
  if (typeof args === "string") {
    const formatted = maybeFormatHjsonTextForView(args.trim());
    if (formatted !== null) return formatted;
  }
  try {
    return formatHjson(args);
  } catch {
    return String(args);
  }
}

// Long preformatted blocks fold into a <details> with a one-line summary so
// the timeline stays scannable; short blocks render inline. JSON-shaped
// content gets light syntax highlighting.

export function displayDiffStats(item: {
  diff?: string;
  stats?: DiffStats;
  before?: string;
  after?: string;
}): DiffStats {
  const lines = item.diff ? item.diff.split("\n").length : 0;
  if (item.stats) {
    return {
      added: Number(item.stats.added) || 0,
      removed: Number(item.stats.removed) || 0,
      lines: Number(item.stats.lines) || lines,
    };
  }
  return { added: 0, removed: 0, lines };
}

