import { moo } from "../moo";
import { chatRefs } from "../lib";
import { formatStep } from "../agent";
import type { Input } from "./_shared";
import { describeCommand } from "./describe";

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
    return { ok: false, error: { message: `export upload failed: HTTP ${res.status}`, body: res.body } };
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
  const title = 'moo chat ' + desc.chatId;
  const rows = (desc.timeline || []).map((item: any) => renderExportItem(item)).join('\n');
  return '<!doctype html>' +
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHtml(title) + '</title>' +
    '<style>' + exportCss() + '</style></head><body>' +
    '<h1>' + escapeHtml(title) + '</h1>' +
    '<p class="meta">Exported ' + escapeHtml(new Date().toISOString()) + ' · ' + Number(desc.totalTurns || 0) + ' turns · ' + Number(desc.totalFacts || 0) + ' facts</p>' +
    (rows || '<p>No timeline items.</p>') + '</body></html>';
}

export function exportCss(): string {
  return ':root{color-scheme:light dark;--muted:color-mix(in srgb,CanvasText 60%,Canvas);--line:color-mix(in srgb,CanvasText 18%,Canvas);--soft:color-mix(in srgb,CanvasText 6%,Canvas)}' +
    'body{font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;max-width:980px;margin:2rem auto;padding:0 1rem;color:CanvasText;background:Canvas}' +
    '.meta,.step-footer{color:var(--muted);font-size:.85em}.step,.item{border:1px solid var(--line);border-radius:10px;padding:1rem;margin:1rem 0}.kind{font-weight:700}' +
    'pre{white-space:pre-wrap;word-break:break-word;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:.75rem;overflow:auto}img{max-width:100%;height:auto}' +
    'details>summary{cursor:pointer;list-style:none}details>summary::-webkit-details-marker{display:none}details>summary:before{content:"▸";display:inline-block;margin-right:.45rem;color:var(--muted)}details[open]>summary:before{content:"▾"}' +
    '.runjs-step,.file-diff{padding:0}.runjs-step>summary,.file-diff>summary{display:flex;align-items:center;gap:.5rem;padding:.85rem 1rem}.runjs-body{padding:0 1rem 1rem}.runjs-pill{font-size:.75em;text-transform:uppercase;border:1px solid var(--line);border-radius:999px;padding:.1rem .45rem;color:var(--muted)}.runjs-label,.file-diff-label{font-weight:700}.runjs-desc-inline,.runjs-desc-full,.file-diff-summary{color:var(--muted)}' +
    '.collapsible{padding:0;border:0}.collapsible>summary{display:flex;justify-content:space-between;gap:1rem;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:.55rem .75rem}.summary-head{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.summary-meta{color:var(--muted);white-space:nowrap}.shell-cmd,.shell-tail{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);border-radius:7px;padding:.5rem .65rem;margin:.45rem 0}' +
    '.file-diff-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.file-diff-summary{margin-left:auto}.file-diff-body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;border-top:1px solid var(--line);overflow:auto}.diff-line{white-space:pre;display:block;padding:0 .75rem}.diff-add{background:color-mix(in srgb,#2f8f46 18%,Canvas)}.diff-del{background:color-mix(in srgb,#b64242 18%,Canvas)}.diff-hunk,.diff-meta,.diff-file{color:var(--muted)}.diff-prefix{opacity:.7}.diff-collapsed{border-block:1px dashed var(--line);margin:.15rem 0}.diff-collapsed>summary{padding:.25rem .75rem;color:var(--muted);background:var(--soft)}' +
    '.input,.log{border-left:4px solid color-mix(in srgb,CanvasText 35%,Canvas)}.timeline-attachments{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.75rem}.timeline-attachment img{max-width:16rem;max-height:16rem;object-fit:contain}.step-footer{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:.75rem}';
}

export function renderExportItem(item: any): string {
  const at = item.at ? new Date(Number(item.at)).toISOString() : '';
  if (item.type === 'file-diff' || item.type === 'memory-diff') return renderExportFileDiff(item, at);
  if (item.type === 'input') return '<section class="step input"><div class="meta">' + escapeHtml(at) + ' · ' + escapeHtml(item.kind || 'input') + ' · ' + escapeHtml(item.status || '') + '</div><pre>' + escapeHtml(JSON.stringify({ spec: item.spec, response: item.response }, null, 2)) + '</pre></section>';
  if (item.type === 'log') return '<section class="step log"><div class="meta">log</div><pre>' + escapeHtml(item.message || '') + '</pre>' + renderExportFooter(item, at) + '</section>';
  if (item.kind === 'agent:RunJS') return renderExportRunJS(item, at);
  const cls = 'step ' + kindClass(item.kind) + (item.status === 'agent:Failed' ? ' failed' : '');
  const meta = '<div class="meta">' + escapeHtml(String(item.kind || 'agent:Step').replace(/^agent:/, '')) + (item.status === 'agent:Failed' ? ' · failed' : '') + '</div>';
  let body = '';
  if (item.kind === 'agent:ShellCommand') body = renderExportShell(item);
  else if (item.kind === 'agent:UserInput') body = (item.text ? '<div class="body">' + escapeHtml(item.text) + '</div>' : '') + renderExportAttachments(item.attachments);
  else body = item.text ? '<pre class="body">' + escapeHtml(item.text) + '</pre>' : '';
  return '<section class="' + escapeAttr(cls) + '">' + meta + body + renderExportFooter(item, at) + '</section>';
}

export function renderExportRunJS(item: any, at: string): string {
  const parsed = parseExportRunJS(item.text || '');
  return '<details class="step runjs-step"><summary><span class="runjs-pill">code</span><span class="runjs-label">' + escapeHtml(parsed.label || '(unlabeled)') + '</span>' + (parsed.description ? '<span class="runjs-desc-inline">· ' + escapeHtml(parsed.description) + '</span>' : '') + '</summary><div class="runjs-body">' + (parsed.description ? '<p class="runjs-desc-full">' + escapeHtml(parsed.description) + '</p>' : '') + (parsed.code ? '<pre class="runjs-code">' + escapeHtml(parsed.code) + '</pre>' : '') + (parsed.result ? '<pre class="runjs-out">' + escapeHtml(parsed.result) + '</pre>' : '') + renderExportFooter(item, at) + '</div></details>';
}

export function parseExportRunJS(text: string): { label: string; description: string; code: string; result: string } {
  const lines = text.split('\n'); let label = ''; let description = ''; const codeBuf: string[] = []; const resultBuf: string[] = []; let mode: 'header' | 'code' | 'result' = 'header';
  for (const line of lines) {
    if (line.startsWith('@@label ')) { label = line.slice('@@label '.length); continue; }
    if (line.startsWith('@@desc ')) { description = line.slice('@@desc '.length); continue; }
    if (line === '@@code') { mode = 'code'; continue; }
    if (line.startsWith('→ ') || line.startsWith('→')) { mode = 'result'; resultBuf.push(line.replace(/^→ ?/, '')); continue; }
    if (mode === 'header' && !label) { label = line.replace(/:$/, ''); mode = 'code'; continue; }
    if (mode === 'code') codeBuf.push(line); else if (mode === 'result') resultBuf.push(line);
  }
  return { label: label.trim(), description: description.trim(), code: codeBuf.join('\n').trim(), result: resultBuf.join('\n').trim() };
}

export function renderExportShell(item: any): string {
  const lines = String(item.text || '').split('\n'); const cmd = lines.find((l) => l.startsWith('$ ')) || ''; const tail = lines.find((l) => l.startsWith('(exit ')) || ''; const out = lines.filter((l) => l !== cmd && l !== tail).join('\n');
  return (cmd ? '<div class="shell-cmd">' + escapeHtml(cmd) + '</div>' : '') + (out ? renderCollapsiblePre('shell-out', out) : '') + (tail ? '<div class="shell-tail">' + escapeHtml(tail) + '</div>' : '');
}

export function renderCollapsiblePre(klass: string, content: string): string {
  const lines = content.split('\n'); const long = lines.length > 12 || content.length > 600;
  if (!long) return '<pre class="' + escapeAttr(klass) + '">' + escapeHtml(content) + '</pre>';
  return '<details class="collapsible ' + escapeAttr(klass) + '"><summary><span class="summary-head">' + escapeHtml(firstNonEmpty(lines)) + '</span><span class="summary-meta">' + lines.length + ' lines · ' + content.length + ' chars</span></summary><pre>' + escapeHtml(content) + '</pre></details>';
}
export function firstNonEmpty(lines: string[]): string { return lines.find((l) => l.trim())?.trim() || '(blank)'; }

export function renderExportFileDiff(item: any, at: string): string {
  const diff = String(item.diff || ''); const stats = diffStats(diff); const sections = diffSections(diff);
  const body = sections.map((section) => section.kind === 'collapsed' ? '<details class="diff-collapsed"><summary>' + section.total + ' unchanged lines hidden</summary>' + section.lines.map((line) => renderDiffLineHtml(line)).join('') + '</details>' : section.lines.map((line) => renderDiffLineHtml(line)).join('')).join('');
  const label = item.type === 'memory-diff' ? 'memory diff' : 'file diff';
  const detail = item.type === 'memory-diff' ? (item.graph || item.refName || '(memory)') : (item.path || '(unknown)');
  return '<details class="step file-diff"><summary><small class="file-diff-time">' + escapeHtml(at) + '</small><span class="file-diff-label">' + escapeHtml(label) + '</span><span class="file-diff-path">· ' + escapeHtml(detail) + '</span><span class="file-diff-summary">+' + stats.added + ' −' + stats.removed + ' · ' + stats.lines + ' lines</span></summary><div class="file-diff-body" role="log" aria-label="Diff">' + body + '</div></details>';
}
export type ExportDiffSection = { kind: 'lines'; lines: string[] } | { kind: 'collapsed'; lines: string[]; total: number };
export const EXPORT_DIFF_CONTEXT_KEEP = 3; const EXPORT_DIFF_COLLAPSE_MIN = 14;
export function diffStats(diff: string): { added: number; removed: number; lines: number } { let added = 0; let removed = 0; const lines = diff ? diff.split('\n') : []; for (const line of lines) { if (line.startsWith('+') && !line.startsWith('+++')) added++; else if (line.startsWith('-') && !line.startsWith('---')) removed++; } return { added, removed, lines: lines.length }; }
export function diffSections(diff: string): ExportDiffSection[] { const lines = diff.split('\n'); const sections: ExportDiffSection[] = []; let pending: string[] = []; const flush = () => { if (pending.length) { sections.push({ kind: 'lines', lines: pending }); pending = []; } }; for (let i = 0; i < lines.length;) { if (!isCollapsibleContextLine(lines[i]!)) { pending.push(lines[i]!); i++; continue; } const start = i; while (i < lines.length && isCollapsibleContextLine(lines[i]!)) i++; const run = lines.slice(start, i); if (run.length < EXPORT_DIFF_COLLAPSE_MIN) { pending.push(...run); continue; } pending.push(...run.slice(0, EXPORT_DIFF_CONTEXT_KEEP)); flush(); const middle = run.slice(EXPORT_DIFF_CONTEXT_KEEP, run.length - EXPORT_DIFF_CONTEXT_KEEP); sections.push({ kind: 'collapsed', lines: middle, total: middle.length }); pending.push(...run.slice(run.length - EXPORT_DIFF_CONTEXT_KEEP)); } flush(); return sections; }
export function isCollapsibleContextLine(line: string): boolean { return line.startsWith(' ') || line === ''; }
export function renderDiffLineHtml(line: string): string { let cls = 'diff-line diff-context'; let body = ''; if (line.startsWith('@@')) { cls = 'diff-line diff-hunk'; body = escapeHtml(line); } else if (line.startsWith('diff --git') || line.startsWith('index ')) { cls = 'diff-line diff-meta'; body = escapeHtml(line); } else if (line.startsWith('+++') || line.startsWith('---')) { cls = 'diff-line diff-file'; body = '<span class="diff-prefix">' + escapeHtml(line.slice(0, 3)) + '</span>' + escapeHtml(line.slice(3)); } else if (line.startsWith('+')) { cls = 'diff-line diff-add'; body = '<span class="diff-prefix">+</span>' + escapeHtml(line.slice(1)); } else if (line.startsWith('-')) { cls = 'diff-line diff-del'; body = '<span class="diff-prefix">-</span>' + escapeHtml(line.slice(1)); } else if (line.startsWith(' ')) body = '<span class="diff-prefix"> </span>' + escapeHtml(line.slice(1)); else if (line.startsWith('\\ No newline')) { cls = 'diff-line diff-meta'; body = escapeHtml(line); } else body = escapeHtml(line); return '<div class="' + cls + '">' + body + '</div>'; }
export function renderExportAttachments(attachments: any[]): string { return (attachments || []).length ? '<div class="timeline-attachments">' + (attachments || []).map((a: any) => a?.dataUrl ? '<a class="timeline-attachment" href="' + escapeAttr(a.dataUrl) + '" target="_blank" rel="noopener"><img src="' + escapeAttr(a.dataUrl) + '" alt="' + escapeAttr(a.name || a.mimeType || 'attachment') + '"></a>' : '').join('') + '</div>' : ''; }
export function renderExportFooter(item: any, at: string): string { const parts = ['<time class="step-time">' + escapeHtml(at) + '</time>']; if (item.model) parts.push('<span class="step-model" title="' + escapeAttr(item.model) + '">' + escapeHtml(item.model) + '</span>'); if (item.effort) parts.push('<span class="step-effort">effort ' + escapeHtml(item.effort) + '</span>'); return '<footer class="step-footer">' + parts.join('') + '</footer>'; }
export function kindClass(kind: string): string { return String(kind || 'agent:Step').replace(/^agent:/, '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(); }
export function escapeHtml(value: any): string { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!)); }
export function escapeAttr(value: any): string { return escapeHtml(value); }
