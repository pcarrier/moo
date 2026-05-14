// Timeline display helpers — pure formatting functions for
// rendering compaction summaries, error payloads, and log entries.
//
// Extracted from Timeline.tsx to keep the component focused on layout.

import type { StepItem } from "../api";
import { formatHjson, formatHjsonTextForView } from "../syntax";

export function logSummary(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return "(empty log)";
  return normalized.length > 180 ? normalized.slice(0, 179) + "…" : normalized;
}

export function firstNonEmpty(lines: string[]): string {
  for (const l of lines) {
    const t = l.trim();
    if (t) return t;
  }
  return lines[0] || "";
}

export function formatValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return v;
  return formatHjson(v);
}

export function compactionSummaryText(text: string): string {
  return text
    .replace(/^(?:automatic |manual )?compaction\n?/, "")
    .replace(/^compacted earlier turns\n?/, "")
    .trim();
}

export function compactionLabel(text: string): string {
  if (/^automatic compaction(?:\n|$)/.test(text)) return "automatic compaction";
  if (/^manual compaction(?:\n|$)/.test(text)) return "manual compaction";
  return "compacted earlier turns";
}

export function compactErrorDetail(detail: unknown): string {
  if (!detail || typeof detail !== "object") return "";
  const d = detail as Record<string, any>;
  const parts = [
    typeof d.reason === "string" ? d.reason : "",
    typeof d.error === "string" ? d.error : "",
    typeof d.message === "string" ? d.message : "",
    typeof d.body?.error?.message === "string" ? d.body.error.message : "",
    typeof d.body?.message === "string" ? d.body.message : "",
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length) return parts[0];
  try {
    const text = JSON.stringify(detail, null, 2).trim();
    return text === "{}" ? "" : text;
  } catch {
    return String(detail ?? "").trim();
  }
}

export function compactionErrorDetail(item: StepItem): Record<string, any> | null {
  const error = item.error as Record<string, any> | undefined;
  const detail = error?.detail as Record<string, any> | undefined;
  if (detail?.phase === "compaction" || detail?.source === "compaction") return detail;
  if (error?.phase === "compaction" || error?.kind === "compaction") return error;
  return null;
}

export function errorDiagnosticLines(detail: Record<string, any> | undefined | null): string {
  if (!detail) return "";
  return [
    typeof detail.hint === "string" && detail.hint.trim() ? detail.hint.trim() : "",
    typeof detail.requestId === "string" && detail.requestId.trim() ? `Request ID: ${detail.requestId.trim()}` : "",
    typeof detail.retryAfter === "string" && detail.retryAfter.trim() ? `Retry after: ${detail.retryAfter.trim()}` : "",
  ].filter(Boolean).join("\n");
}

export function formatErrorPayloadForView(body: unknown): string {
  if (body == null || body === "") return "";
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return "";
    const formatted = formatHjsonTextForView(trimmed);
    return formatted === trimmed ? trimmed : formatted;
  }
  try {
    return formatHjson(body);
  } catch {
    return String(body);
  }
}
