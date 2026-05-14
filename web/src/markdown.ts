import { Marked, Renderer } from "marked";
import { displayCodeLanguage, highlightHjson, highlightMarkdownCode, maybeFormatHjsonTextForView } from "./syntax";

// Shared marked setup. Keep these options in sync with the timeline/store
// preview rendering instead of choosing per-call settings.
const renderer = createSafeRenderer();
const userRenderer = createSafeRenderer();

const marked = new Marked({ gfm: true, breaks: false, renderer });
const markedWithBreaks = new Marked({ gfm: true, breaks: true, renderer });
const userMarked = new Marked({ gfm: true, breaks: true, renderer: userRenderer });

const MARKDOWN_CACHE_MAX_ENTRIES = 512;
const MARKDOWN_CACHE_MAX_CONTENT_LENGTH = 128 * 1024;

const markdownCache = new Map<string, string>();
const markdownInlineCache = new Map<string, string>();
const markdownWithBreaksCache = new Map<string, string>();
const userMessageCache = new Map<string, string>();
const markdownToolDescriptionCache = new Map<string, string>();

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

function createSafeRenderer(): Renderer {
  const next = new Renderer();
  next.code = renderCodeBlock;
  next.html = ({ text }) => escapeHtml(text);
  next.link = function ({ href, title, tokens }) {
    const safeHref = safeLinkHref(href);
    const titleAttribute = title ? ' title="' + escapeHtmlAttribute(title) + '"' : "";
    return '<a href="' + escapeHtmlAttribute(safeHref) + '"' + titleAttribute + '>' + this.parser.parseInline(tokens) + '</a>';
  };
  next.image = ({ href, title, text }) => {
    const safeHref = safeLinkHref(href);
    const titleAttribute = title ? ' title="' + escapeHtmlAttribute(title) + '"' : "";
    return '<img src="' + escapeHtmlAttribute(safeHref) + '" alt="' + escapeHtmlAttribute(text) + '"' + titleAttribute + '>';
  };
  return next;
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

export function renderMarkdownWithBreaks(content: string): string {
  return cachedRender(markdownWithBreaksCache, content, () => markedWithBreaks.parse(content) as string);
}

export function renderToolDescriptionMarkdown(content: string): string {
  return cachedRender(markdownToolDescriptionCache, content, () => {
    const normalized = normalizeExampleBlocks(content);
    return restoreExampleBlocks(markedWithBreaks.parse(normalized.markdown) as string, normalized.examples);
  });
}

type TrustedExampleBlock = {
  marker: string;
  html: string;
};

const EXAMPLE_MARKER_PREFIX = "\uE000MOO_MCP_EXAMPLE_";
const EXAMPLE_MARKER_SUFFIX = "\uE001";

function normalizeExampleBlocks(content: string): { markdown: string; examples: TrustedExampleBlock[] } {
  const examples: TrustedExampleBlock[] = [];
  const markdown = content.replace(/<example(?:\s[^>]*)?>([\s\S]*?)<\/example>/gi, (_match, body: string) => {
    const code = normalizeExampleCode(trimExampleBlock(String(body)));
    const marker = EXAMPLE_MARKER_PREFIX + examples.length + EXAMPLE_MARKER_SUFFIX;
    examples.push({ marker, html: renderExampleBlock(code) });
    return "\n\n" + marker + "\n\n";
  });
  return { markdown, examples };
}

function restoreExampleBlocks(html: string, examples: TrustedExampleBlock[]): string {
  let out = html;
  for (const example of examples) {
    const markerParagraph = '<p>' + escapeHtml(example.marker) + '</p>';
    out = out.split(markerParagraph + "\n").join(example.html + "\n");
    out = out.split(markerParagraph).join(example.html);
  }
  return out;
}

function renderExampleBlock(code: string): string {
  return '<div class="mcp-example-title">EXAMPLE</div>\n' +
    '<pre class="trace-json-block mcp-example-json"><code>' +
    highlightHjson(code, { force: true }) +
    '</code></pre>';
}

function trimExampleBlock(content: string): string {
  return content.replace(/^\s*\n/, "").replace(/\n\s*$/, "");
}

function normalizeExampleCode(content: string): string {
  const escaped = escapeRawStringLineBreaks(content);
  const formatted = maybeFormatHjsonTextForView(escaped);
  if (formatted !== null) return formatted;
  const repaired = escapeRawStringLineBreaks(repairUnescapedStringQuotes(content));
  return maybeFormatHjsonTextForView(repaired) ?? expandEscapedLineBreaksForLooseExample(repaired);
}

// Some MCP examples are JSON-ish rather than JSON: multiline content strings may
// contain markdown attributes such as {color="blue"} without escaping the quotes.
// Repair quotes inside strings when they are not followed by JSON/HJSON string
// terminators, so the structured HJSON renderer can still expand multiline text.
function repairUnescapedStringQuotes(content: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (inString && ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch !== '"') {
      out += ch;
      continue;
    }
    if (!inString) {
      out += ch;
      inString = true;
      continue;
    }
    if (isLikelyStringTerminator(content, i + 1)) {
      out += ch;
      inString = false;
    } else {
      out += '\\"';
    }
  }

  return out;
}

function isLikelyStringTerminator(content: string, start: number): boolean {
  let i = start;
  while (content[i] === " " || content[i] === "\t") i++;
  const ch = content[i];
  if (ch === ":" || ch === "," || ch === "]" || ch === undefined || ch === "\n" || ch === "\r") return true;
  if (ch === "}") {
    return !hasNonStructuralTokenBeforeLineEnd(content, i + 1) && !hasEscapedLineBreakBeforeLineEnd(content, i + 1);
  }
  return false;
}

function hasEscapedLineBreakBeforeLineEnd(content: string, start: number): boolean {
  for (let i = start; i < content.length - 1; i++) {
    const ch = content[i]!;
    if (ch === "\n" || ch === "\r") return false;
    if (ch === "\\" && content[i + 1] === "n") return true;
  }
  return false;
}

function hasNonStructuralTokenBeforeLineEnd(content: string, start: number): boolean {
  for (let i = start; i < content.length; i++) {
    const ch = content[i]!;
    if (ch === " " || ch === "\t" || ch === "," || ch === "}" || ch === "]") continue;
    return ch !== "\n" && ch !== "\r";
  }
  return false;
}

function expandEscapedLineBreaksForLooseExample(content: string): string {
  return content.replace(/\\n/g, "\n");
}

// Some MCP descriptions include JSON examples with literal line breaks inside
// quoted strings. Browsers preserve those line breaks in <pre>, but JSON/HJSON
// highlighters cannot parse them as strings, so continuation lines drift to the
// left. Convert only raw line breaks encountered inside double-quoted strings
// to \n escapes; the HJSON renderer then displays those values as readable multiline
// strings.
function escapeRawStringLineBreaks(content: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (inString && ch === "\r") {
      if (content[i + 1] === "\n") i++;
      out += "\\n";
      escaped = false;
      continue;
    }
    if (inString && ch === "\n") {
      out += "\\n";
      escaped = false;
      continue;
    }

    out += ch;
    if (escaped) {
      escaped = false;
    } else if (inString && ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    }
  }

  return out;
}

function markdownFenceFor(content: string): string {
  let longest = 0;
  for (const match of content.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(3, longest + 1));
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
  return cachedRender(userMessageCache, content, () => renderUserMessagePreservingNewlines(linkifyPathMentionsForMarkdown(content)));
}

function renderUserMessagePreservingNewlines(content: string): string {
  const lines = content.split("\n");
  let html = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = /^( {0,3})(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const fence = fenceMatch[2]!;
      const fenceChar = fence[0]!;
      const fenceLength = fence.length;
      const blockLines = [line];
      let closed = false;
      while (i + 1 < lines.length) {
        i++;
        const nextLine = lines[i]!;
        blockLines.push(nextLine);
        const closing = /^( {0,3})(`{3,}|~{3,})\s*$/.exec(nextLine);
        if (closing && closing[2]![0] === fenceChar && closing[2]!.length >= fenceLength) {
          closed = true;
          break;
        }
      }
      html += closed
        ? userMarked.parse(blockLines.join("\n")) as string
        : userMarked.parseInline(blockLines.join("\n")) as string;
    } else {
      html += userMarked.parseInline(line) as string;
    }

    if (i < lines.length - 1) html += "<br>\n";
  }

  return html;
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
