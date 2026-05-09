import { Marked, Renderer } from "marked";
import { displayCodeLanguage, highlightMarkdownCode } from "./syntax";

// Shared marked setup. Keep these options in sync with the timeline/store
// preview rendering instead of choosing per-call settings.
const renderer = new Renderer();

renderer.code = renderCodeBlock;

const userRenderer = new Renderer();
userRenderer.code = renderCodeBlock;
userRenderer.html = ({ text }) => escapeHtml(text);
userRenderer.link = function ({ href, title, tokens }) {
  const safeHref = safeLinkHref(href);
  const titleAttribute = title ? ' title="' + escapeHtmlAttribute(title) + '"' : "";
  return '<a href="' + escapeHtmlAttribute(safeHref) + '"' + titleAttribute + '>' + this.parser.parseInline(tokens) + '</a>';
};
userRenderer.image = ({ href, title, text }) => {
  const safeHref = safeLinkHref(href);
  const titleAttribute = title ? ' title="' + escapeHtmlAttribute(title) + '"' : "";
  return '<img src="' + escapeHtmlAttribute(safeHref) + '" alt="' + escapeHtmlAttribute(text) + '"' + titleAttribute + '>';
};

const marked = new Marked({ gfm: true, breaks: false, renderer });
const userMarked = new Marked({ gfm: true, breaks: true, renderer: userRenderer });

const MARKDOWN_CACHE_MAX_ENTRIES = 512;
const MARKDOWN_CACHE_MAX_CONTENT_LENGTH = 128 * 1024;

const markdownCache = new Map<string, string>();
const markdownInlineCache = new Map<string, string>();
const userMessageCache = new Map<string, string>();

function cachedRender(cache: Map<string, string>, content: string, render: () => string): string {
  if (content.length > MARKDOWN_CACHE_MAX_CONTENT_LENGTH) return render();
  const cached = cache.get(content);
  if (cached !== undefined) {
    cache.delete(content);
    cache.set(content, cached);
    return cached;
  }
  const html = render();
  cache.set(content, html);
  if (cache.size > MARKDOWN_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return html;
}

function renderCodeBlock({ text, lang, escaped }: { text: string; lang?: string; escaped?: boolean }): string {
  const rawLanguage = typeof lang === "string" ? lang.trim() : "";
  const language = rawLanguage.split(/\s+/)[0] || "";
  const displayLanguage = displayCodeLanguage(language);
  const className = displayLanguage ? ' class="language-' + escapeHtmlAttribute(displayLanguage) + '"' : "";
  const code = escaped ? unescapeMarkedCode(text) : text;
  if (displayLanguage === "mermaid") {
    return '<div class="mermaid" data-mermaid-source="' +
      escapeHtmlAttribute(code) +
      '">' + escapeHtml(code) + '</div>\n';
  }
  return '<pre><code' + className + '>' + highlightMarkdownCode(code, language) + '</code></pre>\n';
}


export function renderMarkdown(content: string): string {
  return cachedRender(markdownCache, content, () => marked.parse(content) as string);
}

export function renderMarkdownInline(content: string): string {
  return cachedRender(markdownInlineCache, content, () => marked.parseInline(content) as string);
}

function unescapeMarkedCode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/");
}

export function anchorFromEventTarget(target: EventTarget | null): HTMLAnchorElement | null {
  const element = target instanceof Element
    ? target
    : target instanceof Node
      ? target.parentElement
      : null;
  return element?.closest("a[href]") as HTMLAnchorElement | null;
}

function isRepoFileHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("?")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return false;
  return true;
}

export function repoFilePathFromHref(href: string): string | null {
  if (!isRepoFileHref(href)) return null;
  return decodeURIComponent(href.split("#")[0].split("?")[0]);
}

export function resolveRepoFileHref(href: string, basePath: string | null | undefined): string | null {
  const linkPath = repoFilePathFromHref(href);
  if (!linkPath) return null;
  if (linkPath.startsWith("/")) return linkPath;
  const base = (basePath || "").replace(/\/+$/, "");
  return base ? base + "/" + linkPath.replace(/^\/+/, "") : linkPath;
}


export function renderUserMessage(content: string): string {
  return cachedRender(userMessageCache, content, () => userMarked.parse(linkifyPathMentionsForMarkdown(content)) as string);
}

function linkifyPathMentionsForMarkdown(content: string): string {
  return rewriteMarkdownOutsideCode(content, linkifyPathMentionsInPlainText);
}

function linkifyPathMentionsInPlainText(content: string): string {
  let markdown = "";
  let cursor = 0;
  for (const match of pathMentionLinks(content)) {
    markdown += content.slice(cursor, match.start);
    const label = content.slice(match.start, match.end);
    markdown += "[" + escapeMarkdownLinkText(label) + "](" + match.href.replace(/[()\s]/g, encodeURIComponent) + ")";
    cursor = match.end;
  }
  markdown += content.slice(cursor);
  return markdown;
}

function rewriteMarkdownOutsideCode(content: string, rewrite: (chunk: string) => string): string {
  let out = "";
  let cursor = 0;
  const fenceRe = /(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/g;
  while (true) {
    const start = fenceRe.exec(content);
    if (!start) break;
    const fenceStart = start.index + start[1].length;
    out += rewriteMarkdownInlineOutsideCode(content.slice(cursor, fenceStart), rewrite);
    const marker = start[3];
    const fenceChar = marker[0];
    const fenceLength = marker.length;
    const closeRe = new RegExp("(^|\\n) {0,3}" + escapeRegExp(fenceChar.repeat(fenceLength)) + fenceChar + "* *($|\\n)", "g");
    closeRe.lastIndex = fenceRe.lastIndex;
    const close = closeRe.exec(content);
    const fenceEnd = close ? close.index + close[0].length : content.length;
    out += content.slice(fenceStart, fenceEnd);
    cursor = fenceEnd;
    fenceRe.lastIndex = cursor;
  }
  out += rewriteMarkdownInlineOutsideCode(content.slice(cursor), rewrite);
  return out;
}

function rewriteMarkdownInlineOutsideCode(content: string, rewrite: (chunk: string) => string): string {
  let out = "";
  let cursor = 0;
  const tickRe = /`+/g;
  while (true) {
    const start = tickRe.exec(content);
    if (!start) break;
    out += rewrite(content.slice(cursor, start.index));
    const marker = start[0];
    const closeIndex = content.indexOf(marker, tickRe.lastIndex);
    if (closeIndex < 0) {
      out += content.slice(start.index);
      return out;
    }
    const codeEnd = closeIndex + marker.length;
    out += content.slice(start.index, codeEnd);
    cursor = codeEnd;
    tickRe.lastIndex = cursor;
  }
  out += rewrite(content.slice(cursor));
  return out;
}

function linkifyPlainText(content: string): string {
  let html = "";
  let cursor = 0;
  for (const match of plainTextLinks(content)) {
    html += escapeHtml(content.slice(cursor, match.start));
    const label = escapeHtml(content.slice(match.start, match.end));
    const href = escapeHtmlAttribute(match.href);
    html += '<a href="' + href + '">' + label + '</a>';
    cursor = match.end;
  }
  html += escapeHtml(content.slice(cursor));
  return html;
}

type PlainTextLink = { start: number; end: number; href: string };

const URL_RE = /\bhttps?:\/\/[^\s<>'"]+/gi;
const PATH_MENTION_BOUNDARIES = "([{\"'`";
const PATH_MENTION_TRAILING_PUNCTUATION = new Set([".", ",", ":", ";", "!", "?", ")", "]", "}", "'", '"', "`"]);

function plainTextLinks(content: string): PlainTextLink[] {
  const links: PlainTextLink[] = [];
  for (const match of content.matchAll(URL_RE)) {
    const raw = match[0] || "";
    const start = match.index ?? 0;
    const end = trimUrlEnd(raw, start, content);
    if (end > start) links.push({ start, end, href: content.slice(start, end) });
  }
  for (const mention of pathMentionLinks(content)) {
    if (links.some((link) => rangesOverlap(link.start, link.end, mention.start, mention.end))) continue;
    links.push(mention);
  }
  return links.sort((a, b) => a.start - b.start || a.end - b.end);
}

function pathMentionLinks(content: string): PlainTextLink[] {
  const links: PlainTextLink[] = [];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] !== "@") continue;
    if (!isPathMentionBoundary(i === 0 ? "" : content[i - 1] || "")) continue;
    let end = i + 1;
    while (end < content.length && !/\s/.test(content[end] || "")) end += 1;
    end = trimPathMentionEnd(content, i + 1, end);
    if (end <= i + 1) continue;
    const rawPath = content.slice(i + 1, end);
    const href = encodeURI(rawPath.replace(/^\/+/, ""));
    if (!href) continue;
    links.push({ start: i, end, href });
    i = end - 1;
  }
  return links;
}

function isPathMentionBoundary(value: string): boolean {
  return value === "" || /\s/.test(value) || PATH_MENTION_BOUNDARIES.includes(value);
}

function trimPathMentionEnd(content: string, pathStart: number, end: number): number {
  while (end > pathStart && PATH_MENTION_TRAILING_PUNCTUATION.has(content[end - 1] || "")) {
    if (!isBalancedClosingPunctuation(content.slice(pathStart, end), content[end - 1] || "")) break;
    end -= 1;
  }
  return end;
}

function trimUrlEnd(raw: string, start: number, content: string): number {
  let end = start + raw.length;
  while (end > start) {
    const ch = content[end - 1] || "";
    if (![".", ",", ":", ";", "!", "?", ")", "]", "}"].includes(ch)) break;
    if (!isBalancedClosingPunctuation(content.slice(start, end), ch)) break;
    end -= 1;
  }
  return end;
}

function isBalancedClosingPunctuation(value: string, close: string): boolean {
  const open = close === ")" ? "(" : close === "]" ? "[" : close === "}" ? "{" : "";
  if (!open) return true;
  return countChar(value, close) > countChar(value, open);
}

function countChar(value: string, char: string): number {
  let count = 0;
  for (const ch of value) if (ch === char) count += 1;
  return count;
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function safeLinkHref(href: string): string {
  const trimmed = (href || "").trim();
  if (!trimmed) return "";
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return "";
  return trimmed;
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/([\\\]\[])/g, "\\$1");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
