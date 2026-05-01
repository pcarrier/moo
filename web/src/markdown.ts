import { marked } from "marked";

// Shared marked setup. Keep these options in sync with the timeline/store
// preview rendering instead of choosing per-call settings.
marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(content: string): string {
  return marked.parse(content) as string;
}

export function renderMarkdownInline(content: string): string {
  return marked.parseInline(content) as string;
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
  return linkifyPlainText(content);
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
