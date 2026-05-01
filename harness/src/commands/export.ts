import { moo } from "../moo";
import type { Input } from "./_shared";
import { describeCommand } from "./describe";

type ExportRenderContext = {
  responseRequestIds?: Set<string>;
};

type HeaderOptions = {
  id: string;
  index: number;
  kind: string;
  at?: string;
  status?: string | null;
  detail?: string | null;
  trailing?: string | null;
};

type MetadataItem = {
  label: string;
  value: unknown;
  code?: boolean;
};

export async function chatExportCommand(input: Input) {
  const chatId = input.chatId || "demo";
  const described = await describeCommand({ ...input, chatId, limit: 100000 });
  if (!described?.ok) return described;
  const html = buildChatExportHtml(described.value);
  const res = await moo.http.fetch({
    method: "POST",
    url: "https://srv.us",
    headers: { "content-type": "text/html; charset=utf-8" },
    body: html,
    timeoutMs: 60000,
  });
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, error: { message: "export upload failed: HTTP " + res.status, body: res.body } };
  }
  const url = parseUploadedUrl(res.body);
  if (!url) return { ok: false, error: { message: "export upload did not return a URL", body: res.body } };
  return { ok: true, value: { chatId, url, bytes: utf8ByteLength(html) } };
}

export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function parseUploadedUrl(body: string): string | null {
  const text = String(body || "").trim();
  if (!text) return null;
  try {
    const json = JSON.parse(text);
    for (const k of ["url", "href", "link"]) {
      if (typeof json?.[k] === "string" && /^https?:\/\//.test(json[k])) return json[k];
    }
  } catch {}
  const m = text.match(/https?:\/\/\S+/);
  return m ? m[0].replace(/[)\]}>"']+$/, "") : null;
}

export function buildChatExportHtml(desc: any): string {
  const timeline = Array.isArray(desc?.timeline) ? desc.timeline : [];
  const chatId = String(desc?.chatId || "unknown");
  const chatTitle = typeof desc?.title === "string" && desc.title.trim() ? desc.title.trim() : "";
  const title = chatTitle ? chatTitle + " · moo chat " + chatId : "moo chat " + chatId;
  const exportedAt = new Date().toISOString();
  const responseRequestIds = new Set<string>(
    timeline
      .filter((item: any) => item?.type === "input-response" && item.requestId)
      .map((item: any) => String(item.requestId)),
  );
  const context: ExportRenderContext = { responseRequestIds };
  const rows = timeline.map((item: any, index: number) => renderExportItem(item, index, context)).join("\n");
  const hiddenNotice = renderHiddenTimelineNotice(desc, timeline.length);

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<title>" + escapeHtml(title) + "</title>",
    "<style>" + exportCss() + "</style>",
    "</head>",
    "<body>",
    "<main class=\"page-shell\">",
    "<header class=\"export-header\">",
    "<p class=\"eyebrow\">moo chat export</p>",
    "<h1>" + escapeHtml(chatTitle || "moo chat " + chatId) + "</h1>",
    "<p class=\"subtitle\">A self-contained export of chat <code>" + escapeHtml(chatId) + "</code>.</p>",
    renderExportMetadata(desc, exportedAt, timeline.length),
    "</header>",
    hiddenNotice,
    "<section class=\"timeline\" aria-label=\"Chat timeline\">",
    rows || "<p class=\"empty-state\">No timeline items.</p>",
    "</section>",
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}

export function renderExportMetadata(desc: any, exportedAt: string, visibleItems: number): string {
  const totalTimelineItems = finiteNumber(desc?.totalTimelineItems, visibleItems);
  const hiddenTimelineItems = finiteNumber(desc?.hiddenTimelineItems, 0);
  const tokens = desc?.tokens || null;
  const tokenValue = tokens && finiteNumber(tokens.budget, 0) > 0
    ? formatInteger(tokens.used) + " / " + formatInteger(tokens.budget) + " tokens"
    : "";
  const timelineValue = hiddenTimelineItems > 0
    ? formatInteger(visibleItems) + " shown of " + formatInteger(totalTimelineItems)
    : formatInteger(visibleItems) + " items";
  const items: MetadataItem[] = [
    { label: "Exported", value: exportedAt },
    { label: "Chat id", value: desc?.chatId, code: true },
    { label: "Created", value: formatExportTime(desc?.createdAt) },
    { label: "Last activity", value: formatExportTime(desc?.lastAt) },
    { label: "Turns", value: desc?.totalTurns },
    { label: "Steps", value: desc?.totalSteps },
    { label: "Code calls", value: desc?.totalCodeCalls },
    { label: "Facts", value: desc?.totalFacts },
    { label: "Timeline", value: timelineValue },
    { label: "Tokens", value: tokenValue },
    { label: "Path", value: desc?.path, code: true },
    { label: "Worktree", value: desc?.worktreePath, code: true },
  ];
  const body = items
    .filter((item) => item.value !== null && item.value !== undefined && String(item.value) !== "")
    .map((item) => renderMetadataItem(item))
    .join("");
  return "<dl class=\"metadata-grid\">" + body + "</dl>";
}

function renderMetadataItem(item: MetadataItem): string {
  const value = item.code
    ? "<code>" + escapeHtml(item.value) + "</code>"
    : escapeHtml(item.value);
  return "<div class=\"metadata-card\"><dt>" + escapeHtml(item.label) + "</dt><dd>" + value + "</dd></div>";
}

function renderHiddenTimelineNotice(desc: any, visibleItems: number): string {
  const hidden = finiteNumber(desc?.hiddenTimelineItems, 0);
  if (hidden <= 0) return "";
  const total = finiteNumber(desc?.totalTimelineItems, visibleItems + hidden);
  const limit = finiteNumber(desc?.timelineLimit, visibleItems);
  return "<aside class=\"timeline-notice\">Showing " + escapeHtml(formatInteger(visibleItems)) +
    " newest timeline items of " + escapeHtml(formatInteger(total)) + "; " +
    escapeHtml(formatInteger(hidden)) + " older items were omitted by the " +
    escapeHtml(formatInteger(limit)) + "-item export window.</aside>";
}

export function exportCss(): string {
  return [
    ":root {",
    "  color-scheme: light dark;",
    "  --bg: Canvas;",
    "  --fg: CanvasText;",
    "  --muted: color-mix(in srgb, CanvasText 58%, Canvas);",
    "  --line: color-mix(in srgb, CanvasText 18%, Canvas);",
    "  --line-strong: color-mix(in srgb, CanvasText 32%, Canvas);",
    "  --surface: color-mix(in srgb, CanvasText 4%, Canvas);",
    "  --surface-strong: color-mix(in srgb, CanvasText 8%, Canvas);",
    "  --accent: color-mix(in srgb, #4f8cff 70%, CanvasText);",
    "  --accent-soft: color-mix(in srgb, #4f8cff 14%, Canvas);",
    "  --danger: color-mix(in srgb, #cc3d3d 72%, CanvasText);",
    "  --danger-soft: color-mix(in srgb, #cc3d3d 14%, Canvas);",
    "  --success-soft: color-mix(in srgb, #2f8f46 16%, Canvas);",
    "  --warning-soft: color-mix(in srgb, #d59b23 16%, Canvas);",
    "  --radius: 14px;",
    "  --shadow: 0 14px 40px color-mix(in srgb, CanvasText 8%, transparent);",
    "}",
    "* { box-sizing: border-box; }",
    "html { scroll-behavior: smooth; }",
    "body {",
    "  margin: 0;",
    "  color: var(--fg);",
    "  background: radial-gradient(circle at top left, color-mix(in srgb, var(--accent) 10%, transparent), transparent 22rem), var(--bg);",
    "  font: 14px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif;",
    "}",
    ".page-shell { max-width: 1120px; margin: 0 auto; padding: 2rem 1rem 4rem; }",
    ".export-header { border: 1px solid var(--line); border-radius: calc(var(--radius) + 6px); background: color-mix(in srgb, Canvas 92%, CanvasText 8%); box-shadow: var(--shadow); padding: clamp(1.25rem, 3vw, 2rem); margin-bottom: 1.25rem; }",
    ".eyebrow { margin: 0 0 .35rem; color: var(--accent); font-size: .75rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }",
    "h1 { margin: 0; font-size: clamp(1.75rem, 4vw, 2.75rem); line-height: 1.1; letter-spacing: -.04em; }",
    ".subtitle { margin: .65rem 0 0; color: var(--muted); }",
    ".metadata-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10.5rem, 1fr)); gap: .65rem; margin: 1.25rem 0 0; }",
    ".metadata-card { min-width: 0; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); padding: .65rem .75rem; }",
    ".metadata-card dt { color: var(--muted); font-size: .74rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }",
    ".metadata-card dd { margin: .2rem 0 0; overflow-wrap: anywhere; font-weight: 650; }",
    ".timeline-notice { border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 12px; background: var(--accent-soft); color: var(--fg); padding: .85rem 1rem; margin: 1rem 0; }",
    ".timeline { display: grid; gap: 1rem; }",
    ".timeline-item { overflow: clip; border: 1px solid var(--line); border-radius: var(--radius); background: color-mix(in srgb, Canvas 96%, CanvasText 4%); scroll-margin-top: 1rem; }",
    ".timeline-item:target { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }",
    ".item-header { display: flex; align-items: flex-start; gap: .7rem; width: 100%; border: 0; border-bottom: 1px solid var(--line); background: var(--surface); color: inherit; padding: .8rem 1rem; text-align: left; }",
    "summary.item-header { cursor: pointer; list-style: none; }",
    "summary.item-header::-webkit-details-marker { display: none; }",
    ".disclosure { flex: 0 0 auto; width: 1rem; color: var(--muted); font-weight: 800; }",
    ".disclosure::before { content: \"▸\"; }",
    "details[open] > summary .disclosure::before { content: \"▾\"; }",
    ".item-anchor { flex: 0 0 auto; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .78rem; text-decoration: none; padding-top: .1rem; }",
    ".item-anchor:hover { color: var(--accent); text-decoration: underline; }",
    ".item-heading { display: block; min-width: 0; flex: 1 1 auto; }",
    ".item-title-row { display: flex; align-items: center; flex-wrap: wrap; gap: .45rem; }",
    ".kind { font-weight: 800; letter-spacing: -.01em; }",
    ".item-detail { display: block; margin-top: .15rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".item-extra { color: var(--muted); font-size: .86rem; white-space: nowrap; }",
    ".timestamp { margin-left: auto; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .78rem; white-space: nowrap; }",
    ".status-badge, .badge { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-strong); color: var(--muted); font-size: .72rem; font-weight: 700; line-height: 1; padding: .22rem .5rem; text-transform: uppercase; }",
    ".status-failed, .status-cancelled, .is-failed .status-badge { border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); background: var(--danger-soft); color: var(--danger); }",
    ".item-body { padding: 1rem; }",
    ".message-text { max-width: 78ch; white-space: pre-wrap; overflow-wrap: anywhere; }",
    ".user-message, .assistant-message { font-size: 1rem; }",
    ".step-user-input { border-left: 4px solid var(--accent); }",
    ".step-reply { border-left: 4px solid color-mix(in srgb, #7d65ff 60%, CanvasText); }",
    ".step-error, .is-failed { border-left: 4px solid var(--danger); }",
    ".step-compaction, .trail-item { border-left: 4px solid color-mix(in srgb, #d59b23 65%, CanvasText); }",
    ".log-item { border-left: 4px solid var(--line-strong); }",
    "pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, \"Liberation Mono\", monospace; }",
    "code { border: 1px solid var(--line); border-radius: 6px; background: var(--surface); padding: .08rem .28rem; }",
    "pre { margin: .65rem 0 0; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); padding: .75rem .85rem; overflow: auto; white-space: pre-wrap; word-break: break-word; }",
    ".code-block, .json-output, .value-json, .diff-line { font-size: .9rem; line-height: 1.45; }",
    ".tool-card, .file-diff { background: transparent; }",
    ".tool-section + .tool-section, .input-card + .input-card, .json-details, .raw-json { margin-top: .9rem; }",
    ".tool-section h3, .input-card h3 { margin: 0 0 .45rem; font-size: .82rem; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }",
    ".tool-description, .meta-inline { color: var(--muted); margin: 0 0 .7rem; }",
    ".shell-cmd, .shell-tail { border: 1px solid var(--line); border-radius: 10px; background: color-mix(in srgb, #111827 8%, Canvas); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; padding: .6rem .75rem; }",
    ".shell-tail { margin-top: .65rem; color: var(--muted); }",
    ".collapsible { margin-top: .65rem; }",
    ".collapsible > summary, .json-details > summary, .diff-collapsed > summary { display: flex; align-items: center; gap: .5rem; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); cursor: pointer; list-style: none; padding: .55rem .7rem; }",
    ".collapsible > summary::-webkit-details-marker, .json-details > summary::-webkit-details-marker, .diff-collapsed > summary::-webkit-details-marker { display: none; }",
    ".summary-head { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".summary-meta { margin-left: auto; color: var(--muted); font-size: .82rem; white-space: nowrap; }",
    ".input-card, .compaction-card, .trail-card, .error-card, .subagent-card { border: 1px solid var(--line); border-radius: 12px; background: var(--surface); padding: .85rem; }",
    ".input-card-title, .compaction-title { margin: 0 0 .55rem; font-weight: 800; }",
    ".form-fields, .response-values, .title-change, .subagent-meta { display: grid; gap: .55rem; margin: .7rem 0 0; }",
    ".form-fields > div, .response-values > div, .title-change > div, .subagent-meta > div { display: grid; grid-template-columns: minmax(8rem, 14rem) minmax(0, 1fr); gap: .75rem; border-top: 1px solid var(--line); padding-top: .55rem; }",
    ".form-fields dt, .response-values dt, .title-change dt, .subagent-meta dt { color: var(--muted); font-weight: 750; }",
    ".form-fields dd, .response-values dd, .title-change dd, .subagent-meta dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }",
    ".choice-list { display: grid; gap: .45rem; margin: .6rem 0 0; padding: 0; list-style: none; }",
    ".choice-list li { border: 1px solid var(--line); border-radius: 10px; background: color-mix(in srgb, Canvas 85%, CanvasText 15%); padding: .55rem .65rem; }",
    ".value-json { margin: .25rem 0 0; }",
    ".empty-state { color: var(--muted); margin: 0; }",
    ".empty-state.small { font-size: .9rem; }",
    ".step-footer { display: flex; flex-wrap: wrap; gap: .45rem; border-top: 1px solid var(--line); background: color-mix(in srgb, var(--surface) 72%, transparent); color: var(--muted); padding: .65rem 1rem; }",
    ".step-footer span { border: 1px solid var(--line); border-radius: 999px; padding: .15rem .5rem; }",
    ".timeline-attachments { display: flex; flex-wrap: wrap; gap: .65rem; margin-top: .85rem; }",
    ".timeline-attachment { display: inline-flex; align-items: center; gap: .45rem; max-width: 18rem; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); color: inherit; overflow: hidden; padding: .45rem; text-decoration: none; }",
    ".timeline-attachment img { display: block; max-width: 16rem; max-height: 16rem; border-radius: 8px; object-fit: contain; }",
    ".attachment-name { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".file-diff-body { overflow: auto; padding: .65rem 0; }",
    ".diff-line { display: block; min-width: max-content; padding: 0 .9rem; white-space: pre; }",
    ".diff-add { background: var(--success-soft); }",
    ".diff-del { background: var(--danger-soft); }",
    ".diff-hunk, .diff-meta, .diff-file { color: var(--muted); }",
    ".diff-prefix { opacity: .68; }",
    ".diff-collapsed { margin: .25rem .7rem; }",
    ".diff-collapsed > summary { color: var(--muted); font-size: .88rem; padding: .35rem .55rem; }",
    "@media (max-width: 720px) {",
    "  .page-shell { padding-inline: .65rem; }",
    "  .item-header { align-items: flex-start; flex-wrap: wrap; }",
    "  .timestamp { margin-left: 0; width: 100%; }",
    "  .item-detail { white-space: normal; }",
    "  .form-fields > div, .response-values > div, .title-change > div, .subagent-meta > div { grid-template-columns: 1fr; gap: .2rem; }",
    "}",
    "@media print {",
    "  body { background: Canvas; }",
    "  .page-shell { max-width: none; padding: 0; }",
    "  .timeline-item, .export-header { box-shadow: none; break-inside: avoid; }",
    "}",
  ].join("\n");
}

export function renderExportItem(item: any, index = 0, context: ExportRenderContext = {}): string {
  const at = formatExportTime(item?.at);
  const id = exportItemId(item, index);
  if (!item || typeof item !== "object") {
    return renderGenericItem(item, at, id, index);
  }
  if (item.type === "file-diff" || item.type === "memory-diff") return renderExportFileDiff(item, at, id, index);
  if (item.type === "input") {
    const includeResponse = Boolean(item.response && !context.responseRequestIds?.has(String(item.requestId || "")));
    return renderExportInputRequest(item, at, id, index, includeResponse);
  }
  if (item.type === "input-response") return renderExportInputResponse(item, at, id, index);
  if (item.type === "log") return renderExportLog(item, at, id, index);
  if (item.type === "trail") return renderExportTrail(item, at, id, index);
  if (item.kind === "agent:RunJS") return renderExportRunJS(item, at, id, index);
  if (item.kind === "agent:Subagent") return renderExportSubagent(item, at, id, index);
  return renderExportStep(item, at, id, index);
}

function renderGenericItem(item: any, at: string, id: string, index: number): string {
  return "<article id=\"" + escapeAttr(id) + "\" class=\"timeline-item generic-item\">" + renderItemHeader({ id, index, kind: "Timeline item", at }) + "<div class=\"item-body\">" + renderJsonDetails("Raw item", item, true) + "</div></article>";
}

function renderExportStep(item: any, at: string, id: string, index: number): string {
  const kind = String(item.kind || "agent:Step");
  const classes = [
    "timeline-item",
    "step",
    "step-" + kindClass(kind),
    item.status === "agent:Failed" ? "is-failed" : "",
    item.deletedAt ? "is-deleted" : "",
  ].filter(Boolean).join(" ");
  let body = "";
  if (kind === "agent:ShellCommand") body = renderExportShell(item);
  else if (kind === "agent:UserInput") body = renderMessageBody(item.text, "user-message") + renderExportAttachments(item.attachments);
  else if (kind === "agent:Reply") body = renderMessageBody(item.text, "assistant-message");
  else if (kind === "agent:Compaction") body = renderCompactionBody(item.text);
  else if (kind === "agent:Error") body = renderErrorBody(item);
  else body = item.text ? renderMessageBody(item.text, "step-message") : "<p class=\"empty-state small\">No displayable content.</p>";
  return "<article id=\"" + escapeAttr(id) + "\" class=\"" + escapeAttr(classes) + "\">" +
    renderItemHeader({ id, index, kind: roleLabel(kind), at, status: item.status }) +
    "<div class=\"item-body\">" + body + "</div>" + renderExportFooter(item, at) + "</article>";
}

export function renderExportRunJS(item: any, at: string, id = exportItemId(item, 0), index = 0): string {
  const parsed = parseExportRunJS(item.text || "");
  const runjs = item.runjs && typeof item.runjs === "object" ? item.runjs : {};
  const label = stringValue(runjs.label, parsed.label).trim() || "(unlabeled)";
  const description = stringValue(runjs.description, parsed.description).trim();
  const code = stringValue(runjs.code, parsed.code);
  const result = hasOwn(runjs, "result") && runjs.result !== null && runjs.result !== undefined
    ? stringifyDisplayValue(runjs.result)
    : parsed.result;
  const error = stringValue(runjs.error, "");
  const duration = typeof runjs.durationMs === "number" ? formatDuration(runjs.durationMs) : "";
  const status = error ? "agent:Failed" : item.status;
  const open = error || item.status === "agent:Failed" ? " open" : "";
  const classes = ["timeline-item", "step", "step-run-js", error ? "is-failed" : ""].filter(Boolean).join(" ");
  const args = hasOwn(runjs, "args") ? renderJsonDetails("Arguments", runjs.args, false) : "";
  const body = [
    description ? "<p class=\"tool-description\">" + escapeHtml(description) + "</p>" : "",
    duration ? "<p class=\"meta-inline\">Duration: " + escapeHtml(duration) + "</p>" : "",
    args,
    code ? "<section class=\"tool-section\"><h3>Code</h3><pre class=\"code-block runjs-code\">" + escapeHtml(code) + "</pre></section>" : "",
    error ? "<section class=\"tool-section\"><h3>Error</h3><pre class=\"tool-output error-output\">" + escapeHtml(error) + "</pre></section>" : "",
    result ? "<section class=\"tool-section\"><h3>Result</h3>" + renderCollapsiblePre("tool-output runjs-out", result) + "</section>" : "",
  ].filter(Boolean).join("");
  return "<article id=\"" + escapeAttr(id) + "\" class=\"" + escapeAttr(classes) + "\"><details class=\"tool-card runjs-card\"" + open + ">" +
    renderItemSummary({ id, index, kind: "Code", at, status, detail: label }) +
    "<div class=\"item-body\">" + (body || "<p class=\"empty-state small\">No code payload recorded.</p>") + "</div>" +
    renderExportFooter(item, at) + "</details></article>";
}

export function parseExportRunJS(text: string): { label: string; description: string; code: string; result: string } {
  const lines = text.split("\n");
  let label = "";
  let description = "";
  const codeBuf: string[] = [];
  const resultBuf: string[] = [];
  let mode: "header" | "code" | "result" = "header";
  for (const line of lines) {
    if (line.startsWith("@@label ")) { label = line.slice("@@label ".length); continue; }
    if (line.startsWith("@@desc ")) { description = line.slice("@@desc ".length); continue; }
    if (line === "@@code") { mode = "code"; continue; }
    if (line.startsWith("→ ") || line.startsWith("→")) { mode = "result"; resultBuf.push(line.replace(/^→ ?/, "")); continue; }
    if (mode === "header" && !label) { label = line.replace(/:$/, ""); mode = "code"; continue; }
    if (mode === "code") codeBuf.push(line);
    else if (mode === "result") resultBuf.push(line);
  }
  return { label: label.trim(), description: description.trim(), code: codeBuf.join("\n").trim(), result: resultBuf.join("\n").trim() };
}

export function renderExportSubagent(item: any, at: string, id = exportItemId(item, 0), index = 0): string {
  const subagent = item.subagent && typeof item.subagent === "object" ? item.subagent : {};
  const resultValue = subagent.result && typeof subagent.result === "object" ? subagent.result : {};
  const label = stringValue(subagent.label, "subagent").trim() || "subagent";
  const status = resultValue.status || item.status;
  const task = stringValue(subagent.task, "");
  const output = stringifyDisplayValue(resultValue.output ?? resultValue.text ?? "");
  const error = stringifyDisplayValue(resultValue.error ?? "");
  const childChatId = stringValue(subagent.childChatId, "");
  const open = error || status === "failed" || status === "agent:Failed" ? " open" : "";
  const classes = ["timeline-item", "step", "step-subagent", error ? "is-failed" : ""].filter(Boolean).join(" ");
  const meta = [
    childChatId ? "<div><dt>Child chat</dt><dd><code>" + escapeHtml(childChatId) + "</code></dd></div>" : "",
    status ? "<div><dt>Status</dt><dd>" + escapeHtml(status) + "</dd></div>" : "",
  ].filter(Boolean).join("");
  const body = "<div class=\"subagent-card\">" +
    (meta ? "<dl class=\"subagent-meta\">" + meta + "</dl>" : "") +
    (task ? "<section class=\"tool-section\"><h3>Task</h3>" + renderMessageBody(task, "subagent-task") + "</section>" : "") +
    (output ? "<section class=\"tool-section\"><h3>Output</h3>" + renderCollapsiblePre("tool-output subagent-output", output) + "</section>" : "") +
    (error ? "<section class=\"tool-section\"><h3>Error</h3><pre class=\"tool-output error-output\">" + escapeHtml(error) + "</pre></section>" : "") +
    "</div>";
  return "<article id=\"" + escapeAttr(id) + "\" class=\"" + escapeAttr(classes) + "\"><details class=\"tool-card subagent-details\"" + open + ">" +
    renderItemSummary({ id, index, kind: "Subagent", at, status: status || null, detail: label }) +
    "<div class=\"item-body\">" + body + "</div>" + renderExportFooter(item, at) + "</details></article>";
}

export function renderExportShell(item: any): string {
  const lines = String(item.text || "").split("\n");
  const cmdIndex = lines.findIndex((line) => line.startsWith("$ "));
  const tailIndex = [...lines].reverse().findIndex((line) => line.startsWith("(exit "));
  const tailRealIndex = tailIndex >= 0 ? lines.length - 1 - tailIndex : -1;
  const cmd = cmdIndex >= 0 ? lines[cmdIndex] : "";
  const tail = tailRealIndex >= 0 ? lines[tailRealIndex] : "";
  const out = lines
    .filter((_, idx) => idx !== cmdIndex && idx !== tailRealIndex)
    .join("\n")
    .trimEnd();
  return "<div class=\"shell-block\">" +
    (cmd ? "<div class=\"shell-cmd\">" + escapeHtml(cmd) + "</div>" : "") +
    (out ? renderCollapsiblePre("shell-out", out) : "") +
    (tail ? "<div class=\"shell-tail\">" + escapeHtml(tail) + "</div>" : "") +
    "</div>";
}

export function renderCollapsiblePre(klass: string, content: string): string {
  const text = String(content ?? "");
  const lines = text ? text.split("\n") : [];
  const long = lines.length > 12 || text.length > 600;
  if (!long) return "<pre class=\"" + escapeAttr(klass) + "\">" + escapeHtml(text) + "</pre>";
  return "<details class=\"collapsible " + escapeAttr(klass) + "\"><summary><span class=\"disclosure\" aria-hidden=\"true\"></span><span class=\"summary-head\">" +
    escapeHtml(firstNonEmpty(lines)) + "</span><span class=\"summary-meta\">" + formatInteger(lines.length) + " lines · " +
    formatInteger(text.length) + " chars</span></summary><pre>" + escapeHtml(text) + "</pre></details>";
}

export function firstNonEmpty(lines: string[]): string {
  return lines.find((line) => line.trim())?.trim() || "(blank)";
}

export function renderExportFileDiff(item: any, at: string, id = exportItemId(item, 0), index = 0): string {
  const diff = String(item.diff || "");
  const stats = diffStats(diff);
  const sections = diffSections(diff);
  const body = sections.length
    ? sections.map((section) => section.kind === "collapsed"
      ? "<details class=\"diff-collapsed\"><summary><span class=\"disclosure\" aria-hidden=\"true\"></span>" + formatInteger(section.total) + " unchanged lines hidden</summary>" + section.lines.map((line) => renderDiffLineHtml(line)).join("") + "</details>"
      : section.lines.map((line) => renderDiffLineHtml(line)).join(""),
    ).join("")
    : "<p class=\"empty-state small\">No diff content.</p>";
  const label = item.type === "memory-diff" ? "Memory diff" : "File diff";
  const detail = item.type === "memory-diff" ? (item.graph || item.refName || "(memory)") : (item.path || "(unknown path)");
  const trailing = "+" + formatInteger(stats.added) + " −" + formatInteger(stats.removed) + " · " + formatInteger(stats.lines) + " lines";
  return "<article id=\"" + escapeAttr(id) + "\" class=\"timeline-item file-diff-item\"><details class=\"file-diff\">" +
    renderItemSummary({ id, index, kind: label, at, detail, trailing }) +
    "<div class=\"file-diff-body\" role=\"log\" aria-label=\"Diff\">" + body + "</div></details></article>";
}

export type ExportDiffSection = { kind: "lines"; lines: string[] } | { kind: "collapsed"; lines: string[]; total: number };
export const EXPORT_DIFF_CONTEXT_KEEP = 3;
const EXPORT_DIFF_COLLAPSE_MIN = 14;

export function diffStats(diff: string): { added: number; removed: number; lines: number } {
  let added = 0;
  let removed = 0;
  const lines = diff ? diff.split("\n") : [];
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed, lines: lines.length };
}

export function diffSections(diff: string): ExportDiffSection[] {
  if (!diff) return [];
  const lines = diff.split("\n");
  const sections: ExportDiffSection[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length) {
      sections.push({ kind: "lines", lines: pending });
      pending = [];
    }
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
    if (run.length < EXPORT_DIFF_COLLAPSE_MIN) {
      pending.push(...run);
      continue;
    }
    pending.push(...run.slice(0, EXPORT_DIFF_CONTEXT_KEEP));
    flush();
    const middle = run.slice(EXPORT_DIFF_CONTEXT_KEEP, run.length - EXPORT_DIFF_CONTEXT_KEEP);
    sections.push({ kind: "collapsed", lines: middle, total: middle.length });
    pending.push(...run.slice(run.length - EXPORT_DIFF_CONTEXT_KEEP));
  }
  flush();
  return sections;
}

export function isCollapsibleContextLine(line: string): boolean {
  return line.startsWith(" ") || line === "";
}

export function renderDiffLineHtml(line: string): string {
  let cls = "diff-line diff-context";
  let body = "";
  if (line.startsWith("@@")) {
    cls = "diff-line diff-hunk";
    body = escapeHtml(line);
  } else if (line.startsWith("diff --git") || line.startsWith("index ")) {
    cls = "diff-line diff-meta";
    body = escapeHtml(line);
  } else if (line.startsWith("+++") || line.startsWith("---")) {
    cls = "diff-line diff-file";
    body = "<span class=\"diff-prefix\">" + escapeHtml(line.slice(0, 3)) + "</span>" + escapeHtml(line.slice(3));
  } else if (line.startsWith("+")) {
    cls = "diff-line diff-add";
    body = "<span class=\"diff-prefix\">+</span>" + escapeHtml(line.slice(1));
  } else if (line.startsWith("-")) {
    cls = "diff-line diff-del";
    body = "<span class=\"diff-prefix\">-</span>" + escapeHtml(line.slice(1));
  } else if (line.startsWith(" ")) {
    body = "<span class=\"diff-prefix\"> </span>" + escapeHtml(line.slice(1));
  } else if (line.startsWith("\\ No newline")) {
    cls = "diff-line diff-meta";
    body = escapeHtml(line);
  } else {
    body = escapeHtml(line);
  }
  return "<div class=\"" + cls + "\">" + body + "</div>";
}

export function renderExportAttachments(attachments: any[]): string {
  const items = (Array.isArray(attachments) ? attachments : [])
    .map((attachment, index) => renderExportAttachment(attachment, index))
    .filter(Boolean)
    .join("");
  return items ? "<div class=\"timeline-attachments\" aria-label=\"Attachments\">" + items + "</div>" : "";
}

function renderExportAttachment(attachment: any, index: number): string {
  const name = String(attachment?.name || attachment?.mimeType || "attachment " + (index + 1));
  const mimeType = String(attachment?.mimeType || "");
  const dataUrl = typeof attachment?.dataUrl === "string" ? attachment.dataUrl : "";
  const label = name + (mimeType && mimeType !== name ? " · " + mimeType : "");
  if (dataUrl && isSafeAttachmentDataUrl(dataUrl)) {
    if (/^data:image\//i.test(dataUrl)) {
      return "<a class=\"timeline-attachment image-attachment\" href=\"" + escapeAttr(dataUrl) + "\" target=\"_blank\" rel=\"noopener\"><img src=\"" + escapeAttr(dataUrl) + "\" alt=\"" + escapeAttr(name) + "\"><span class=\"attachment-name\">" + escapeHtml(label) + "</span></a>";
    }
    return "<a class=\"timeline-attachment file-attachment\" href=\"" + escapeAttr(dataUrl) + "\" target=\"_blank\" rel=\"noopener\"><span class=\"attachment-name\">" + escapeHtml(label) + "</span></a>";
  }
  return "<span class=\"timeline-attachment file-attachment\"><span class=\"attachment-name\">" + escapeHtml(label) + "</span></span>";
}

function isSafeAttachmentDataUrl(url: string): boolean {
  return /^data:(image\/|application\/pdf|text\/plain|application\/octet-stream)/i.test(url);
}

export function renderExportFooter(item: any, _at: string): string {
  const parts: string[] = [];
  if (item.model) parts.push("<span class=\"step-model\" title=\"" + escapeAttr(item.model) + "\">" + escapeHtml(item.model) + "</span>");
  if (item.effort) parts.push("<span class=\"step-effort\">effort " + escapeHtml(item.effort) + "</span>");
  if (typeof item.thoughtDurationMs === "number") parts.push("<span class=\"step-thought\">thought " + escapeHtml(formatDuration(item.thoughtDurationMs)) + "</span>");
  if (item.deletedAt) parts.push("<span class=\"step-deleted\">deleted " + escapeHtml(formatExportTime(item.deletedAt)) + "</span>");
  return parts.length ? "<footer class=\"step-footer\">" + parts.join("") + "</footer>" : "";
}

function renderExportInputRequest(item: any, at: string, id: string, index: number, includeResponse: boolean): string {
  const detail = inputTitle(item.spec) || kindLabel(item.kind || "ui:InputRequest");
  const status = item.status || null;
  const responseHint = item.response && !includeResponse
    ? "<p class=\"meta-inline\">Response recorded separately" + (item.response.at ? " at " + escapeHtml(formatExportTime(item.response.at)) : "") + ".</p>"
    : "";
  const response = includeResponse && item.response ? renderInputResponseValues(item.response) : responseHint;
  const body = renderInputSpec(item.spec) + (response || "");
  return "<article id=\"" + escapeAttr(id) + "\" class=\"timeline-item input-item input-request\">" +
    renderItemHeader({ id, index, kind: "Input request", at, status, detail }) +
    "<div class=\"item-body\">" + body + "</div></article>";
}

function renderExportInputResponse(item: any, at: string, id: string, index: number): string {
  const detail = inputTitle(item.spec) || kindLabel(item.kind || "ui:InputResponse");
  const body = renderInputResponseValues(item.response) + (item.spec ? renderJsonDetails("Input spec", item.spec, false) : "");
  return "<article id=\"" + escapeAttr(id) + "\" class=\"timeline-item input-item input-response\">" +
    renderItemHeader({ id, index, kind: "Input response", at, detail }) +
    "<div class=\"item-body\">" + body + "</div></article>";
}

function renderInputSpec(spec: any): string {
  if (!spec) return "<div class=\"input-card\"><p class=\"empty-state small\">No input request details recorded.</p></div>";
  const fields = Array.isArray(spec.fields) ? spec.fields : [];
  const items = Array.isArray(spec.items) ? spec.items : [];
  const title = inputTitle(spec);
  const parts: string[] = [];
  if (title) parts.push("<p class=\"input-card-title\">" + escapeHtml(title) + "</p>");
  if (fields.length) {
    parts.push("<dl class=\"form-fields\">" + fields.map((field: any) => renderInputField(field)).join("") + "</dl>");
  }
  if (items.length) {
    parts.push("<ul class=\"choice-list\">" + items.map((choice: any) => renderChoiceItem(choice)).join("") + "</ul>");
  }
  if (!fields.length && !items.length) parts.push(renderJsonDetails("Input spec", spec, true));
  else parts.push(renderJsonDetails("Raw input spec", spec, false));
  return "<div class=\"input-card\">" + parts.join("") + "</div>";
}

function renderInputField(field: any): string {
  const name = String(field?.name || "field");
  const label = String(field?.label || name);
  const badges = [
    field?.type ? "<span class=\"badge\">" + escapeHtml(field.type) + "</span>" : "",
    field?.required ? "<span class=\"badge\">required</span>" : "",
    hasOwn(field || {}, "default") ? "<span class=\"badge\">default " + escapeHtml(shortInlineValue(field.default)) + "</span>" : "",
    Array.isArray(field?.options) && field.options.length ? "<span class=\"badge\">" + escapeHtml(formatInteger(field.options.length)) + " options</span>" : "",
  ].filter(Boolean).join(" ");
  return "<div><dt>" + escapeHtml(label) + "<br><code>" + escapeHtml(name) + "</code></dt><dd>" + (badges || "<span class=\"empty-state small\">No constraints</span>") + "</dd></div>";
}

function renderChoiceItem(choice: any): string {
  const label = choice?.label || choice?.id || "choice";
  const description = choice?.description ? "<div class=\"item-detail\">" + escapeHtml(choice.description) + "</div>" : "";
  return "<li><strong>" + escapeHtml(label) + "</strong>" + description + "</li>";
}

function renderInputResponseValues(response: any): string {
  if (!response) return "<div class=\"input-card\"><p class=\"empty-state small\">No response recorded.</p></div>";
  const values = response.values && typeof response.values === "object" ? response.values : {};
  const entries = Object.entries(values);
  const rows = entries.length
    ? "<dl class=\"response-values\">" + entries.map(([key, value]) => "<div><dt>" + escapeHtml(key) + "</dt><dd>" + renderValueHtml(value) + "</dd></div>").join("") + "</dl>"
    : "<p class=\"empty-state small\">No submitted values.</p>";
  const cancelled = response.cancelled ? "<p class=\"meta-inline\">Response was cancelled.</p>" : "";
  const submittedAt = response.at ? "<p class=\"meta-inline\">Submitted " + escapeHtml(formatExportTime(response.at)) + "</p>" : "";
  return "<div class=\"input-card\"><h3>Submitted values</h3>" + cancelled + rows + submittedAt + "</div>";
}

function renderExportLog(item: any, at: string, id: string, index: number): string {
  const message = String(item.message || "");
  return "<article id=\"" + escapeAttr(id) + "\" class=\"timeline-item log-item\">" + renderItemHeader({ id, index, kind: "Log", at }) + "<div class=\"item-body\">" + (message ? renderCollapsiblePre("log-output", message) : "<p class=\"empty-state small\">Empty log message.</p>") + "</div></article>";
}

function renderExportTrail(item: any, at: string, id: string, index: number): string {
  const title = stringValue(item.title, "");
  const previousTitle = stringValue(item.previousTitle, "");
  const bodyText = stringValue(item.body ?? item.summary, "");
  const titleRows = [
    previousTitle ? "<div><dt>Previous title</dt><dd>" + escapeHtml(previousTitle) + "</dd></div>" : "",
    title ? "<div><dt>Title</dt><dd>" + escapeHtml(title) + "</dd></div>" : "",
  ].filter(Boolean).join("");
  const body = "<div class=\"trail-card\">" + (titleRows ? "<dl class=\"title-change\">" + titleRows + "</dl>" : "") + (bodyText ? renderMessageBody(bodyText, "trail-message") : "<p class=\"empty-state small\">No summary text recorded.</p>") + "</div>";
  return "<article id=\"" + escapeAttr(id) + "\" class=\"timeline-item trail-item\">" +
    renderItemHeader({ id, index, kind: kindLabel(item.kind || "Trail"), at, detail: title || null }) +
    "<div class=\"item-body\">" + body + "</div></article>";
}

function renderCompactionBody(text: any): string {
  const value = String(text || "");
  const [head, ...rest] = value.split("\n");
  const summary = rest.join("\n").trim();
  return "<div class=\"compaction-card\"><p class=\"compaction-title\">" + escapeHtml(head || "Compaction") + "</p>" + (summary ? renderMessageBody(summary, "compaction-summary") : "<p class=\"empty-state small\">No compaction summary recorded.</p>") + "</div>";
}

function renderErrorBody(item: any): string {
  const text = String(item.text || "");
  const raw = item.error ? renderJsonDetails("Raw error", item.error, false) : "";
  return "<div class=\"error-card\">" + (text ? renderMessageBody(text, "error-message") : "<p class=\"empty-state small\">No error message recorded.</p>") + raw + "</div>";
}

function renderMessageBody(text: any, klass: string): string {
  const value = String(text ?? "");
  if (!value.trim()) return "<p class=\"empty-state small\">Empty message.</p>";
  return "<div class=\"message-text " + escapeAttr(klass) + "\">" + escapeHtml(value) + "</div>";
}

function renderJsonDetails(label: string, value: any, open = false): string {
  return "<details class=\"json-details\"" + (open ? " open" : "") + "><summary><span class=\"disclosure\" aria-hidden=\"true\"></span>" + escapeHtml(label) + "</summary><pre class=\"json-output\">" + escapeHtml(stringifyJson(value)) + "</pre></details>";
}

function renderValueHtml(value: unknown): string {
  if (value === null || value === undefined) return "<span class=\"empty-state small\">null</span>";
  if (typeof value === "object") return "<pre class=\"value-json\">" + escapeHtml(stringifyJson(value)) + "</pre>";
  const text = String(value);
  if (text.includes("\n")) return "<pre class=\"value-json\">" + escapeHtml(text) + "</pre>";
  return escapeHtml(text);
}

function renderItemHeader(options: HeaderOptions): string {
  return "<header class=\"item-header\">" + renderHeaderInner(options) + "</header>";
}

function renderItemSummary(options: HeaderOptions): string {
  return "<summary class=\"item-header\"><span class=\"disclosure\" aria-hidden=\"true\"></span>" + renderHeaderInner(options) + "</summary>";
}

function renderHeaderInner({ id, index, kind, at, status, detail, trailing }: HeaderOptions): string {
  const number = String(index + 1).padStart(3, "0");
  return "<a class=\"item-anchor\" href=\"#" + escapeAttr(id) + "\" aria-label=\"Permalink to item " + escapeAttr(number) + "\">#" + escapeHtml(number) + "</a>" +
    "<span class=\"item-heading\"><span class=\"item-title-row\"><span class=\"kind\">" + escapeHtml(kind) + "</span>" + renderStatusBadge(status || "") +
    (trailing ? "<span class=\"item-extra\">" + escapeHtml(trailing) + "</span>" : "") + "</span>" +
    (detail ? "<span class=\"item-detail\">" + escapeHtml(detail) + "</span>" : "") + "</span>" + renderTime(at || "");
}

function renderStatusBadge(status: string): string {
  if (!status) return "";
  return "<span class=\"status-badge status-" + escapeAttr(kindClass(status)) + "\">" + escapeHtml(kindLabel(status)) + "</span>";
}

function renderTime(at: string): string {
  return at
    ? "<time class=\"timestamp\" datetime=\"" + escapeAttr(at) + "\">" + escapeHtml(at) + "</time>"
    : "<span class=\"timestamp\">time unknown</span>";
}

function exportItemId(item: any, index: number): string {
  const raw = item?.step || item?.id || item?.requestId || item?.responseId || item?.type || item?.kind || "item";
  return "item-" + String(index + 1).padStart(3, "0") + "-" + sanitizeId(raw);
}

function sanitizeId(value: any): string {
  const id = String(value ?? "item")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/[^a-zA-Z0-9_.:-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 72);
  return id || "item";
}

function inputTitle(spec: any): string {
  return stringValue(spec?.title ?? spec?.label ?? spec?.message, "").trim();
}

function roleLabel(kind: string): string {
  switch (kind) {
    case "agent:UserInput": return "User";
    case "agent:Reply": return "Assistant";
    case "agent:RunJS": return "Code";
    case "agent:ShellCommand": return "Shell";
    case "agent:Subagent": return "Subagent";
    case "agent:Compaction": return "Compaction";
    case "agent:Error": return "Error";
    default: return kindLabel(kind);
  }
}

function kindLabel(kind: any): string {
  const bare = String(kind || "item").replace(/^[a-z]+:/i, "");
  const spaced = bare
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced ? spaced.replace(/\b\w/g, (ch) => ch.toUpperCase()) : "Item";
}

export function kindClass(kind: string): string {
  return String(kind || "agent:Step")
    .replace(/^[a-z]+:/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "step";
}

function finiteNumber(value: any, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatInteger(value: any): string {
  const n = finiteNumber(value, 0);
  return Math.round(n).toLocaleString("en-US");
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return minutes + "m " + seconds + "s";
}

function formatExportTime(value: any): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  const date = new Date(n);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function stringifyJson(value: any): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch (error) {
    return String(value);
  }
}

function stringifyDisplayValue(value: any): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return stringifyJson(value);
}

function stringValue(value: any, fallback: string): string {
  return value === null || value === undefined ? fallback : String(value);
}

function shortInlineValue(value: any): string {
  const text = stringifyDisplayValue(value).replace(/\s+/g, " ").trim();
  return text.length > 80 ? text.slice(0, 77) + "…" : text;
}

function hasOwn(value: any, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: any): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch]!);
}

export function escapeAttr(value: any): string {
  return escapeHtml(value);
}
