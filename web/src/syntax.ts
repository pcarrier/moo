import Hjson from "hjson/bundle/hjson.js";
import Prism from "prismjs";
import YAML from "yaml";
import "prismjs/components/prism-markup.js";
import "prismjs/components/prism-clike.js";
import "prismjs/components/prism-javascript.js";
import "prismjs/components/prism-jsx.js";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-tsx.js";
import "prismjs/components/prism-css.js";
import "prismjs/components/prism-scss.js";
import "prismjs/components/prism-rust.js";
import "prismjs/components/prism-toml.js";
import "prismjs/components/prism-yaml.js";
import "prismjs/components/prism-markdown.js";
import "prismjs/components/prism-nix.js";
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-python.js";
import "prismjs/components/prism-turtle.js";
import "prismjs/components/prism-sparql.js";

Prism.languages.insertBefore("yaml", "tag", {
  "plain-scalar-string": {
    pattern: /([:\-,[{][ \t]*)(?!(?:false|true|null|~)(?=[ \t]*(?:$|,|\]|\}|(?:[\r\n]\s*)?#)))(?![+-]?(?:0x[\da-f]+|0o[0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|\.inf|\.nan)(?=[ \t]*(?:$|,|\]|\}|(?:[\r\n]\s*)?#)))(?!\d{4}-\d\d?-\d\d?(?:[tT]|[ \t]+)\d\d?:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}|\d\d?:\d{2})(?![&*!|>\[\]{}'"#\s,`])[^#\r\n,[\]{}]*?[^#\r\n,[\]{}\s](?=[ \t]*(?:$|,|\]|\}|(?:[\r\n]\s*)?#))/im,
    lookbehind: true,
    alias: "string",
  },
});

export function escapeHtml(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else out += ch;
  }
  return out;
}

// Highlighters tokenize the entire input synchronously; on multi-MB files
// they freeze the main thread. Above this size, fall back to plain-escaped
// text — viewers can still read the content, just without syntax colors.
export const DEFAULT_HIGHLIGHT_MAX_BYTES = 1024 * 1024;

const DATA_LANGUAGES = new Set(["json", "jsonc", "jsonl", "hjson"]);

const HIGHLIGHT_CACHE_MAX_ENTRIES = 512;
const HIGHLIGHT_CACHE_MAX_TEXT_LENGTH = 64 * 1024;
const HJSON_COLLAPSIBLE_STRING_MIN_CHARS = 96;
const HJSON_COLLAPSIBLE_STRING_PREVIEW_CHARS = 96;
const highlightCache = new Map<string, string>();

function cachedHighlight(key: string, textLength: number, render: () => string): string {
  if (textLength > HIGHLIGHT_CACHE_MAX_TEXT_LENGTH) return render();
  const cached = highlightCache.get(key);
  if (cached !== undefined) {
    highlightCache.delete(key);
    highlightCache.set(key, cached);
    return cached;
  }
  const html = render();
  highlightCache.set(key, html);
  if (highlightCache.size > HIGHLIGHT_CACHE_MAX_ENTRIES) highlightCache.delete(highlightCache.keys().next().value!);
  return html;
}

// Prism registers aliases for loaded grammars (e.g. js -> javascript,
// html -> markup, sh -> bash, py -> python). Keep only aliases Prism does
// not know because they are file extensions rather than language aliases.
const PRISM_LANGUAGE_EXTENSION_OVERRIDES: Record<string, string> = {
  cjs: "javascript",
  mdx: "markdown",
  mjs: "javascript",
  rdf: "turtle",
  rs: "rust",
  svelte: "markup",
  ttl: "turtle",
  vue: "markup",
  zsh: "bash",
};

type HjsonComment = {
  before: string[];
  after?: string;
};

type HjsonCommentMap = Map<string, HjsonComment>;

type HjsonFormatOptions = {
  indent?: number;
  maxDepth?: number;
  linkStoreHashes?: boolean;
  comments?: HjsonCommentMap;
};

type RenderContext = Required<Omit<HjsonFormatOptions, "linkStoreHashes" | "comments">> & {
  html: boolean;
  linkStoreHashes: boolean;
  comments: HjsonCommentMap | null;
  seen: WeakSet<object>;
  embeddedDepth: number;
};

type ParsedStructuredText = {
  ok: true;
  value: unknown;
  comments: HjsonCommentMap | null;
} | {
  ok: false;
};

type EmbeddedCodeText = {
  ok: true;
  language: string;
  html: string;
} | {
  ok: false;
};

export function highlightMarkdownCode(text: string, language: string | null | undefined, maxBytes = DEFAULT_HIGHLIGHT_MAX_BYTES): string {
  if (text.length > maxBytes) return escapeHtml(text);
  const lang = normalizeCodeLanguage(language);
  return cachedHighlight("md:" + lang + "\0" + text, text.length, () => {
    if (lang === "diff" || lang === "patch") return highlightDiff(text, null);
    if (DATA_LANGUAGES.has(lang)) {
      return highlightHjson(text, { force: true, jsonLines: lang === "jsonl" });
    }
    const prismLanguage = prismLanguageForName(lang);
    if (prismLanguage) return highlightCodeRecursive(text, prismLanguage, 0);
    return lang ? highlightCodeRecursive(text, lang, 0) : highlightAuto(text);
  });
}

function normalizeCodeLanguage(language: string | null | undefined): string {
  const raw = (language || "").trim().toLowerCase();
  return raw.startsWith("language-") ? raw.slice("language-".length) : raw;
}

export function isHjsonCodeLanguage(language: string | null | undefined): boolean {
  return DATA_LANGUAGES.has(normalizeCodeLanguage(language));
}

export function displayCodeLanguage(language: string | null | undefined): string {
  const normalized = normalizeCodeLanguage(language);
  return DATA_LANGUAGES.has(normalized) ? "hjson" : normalized;
}

export function highlightByPath(text: string, path: string, maxBytes = DEFAULT_HIGHLIGHT_MAX_BYTES): string {
  if (text.length > maxBytes) return escapeHtml(text);
  const extension = fileExtension(path);
  if (extension === "json" || extension === "jsonc" || extension === "jsonl" || extension === "hjson") {
    return highlightHjson(text, { force: true, jsonLines: extension === "jsonl" });
  }
  const prismLanguage = prismLanguageForExtension(extension);
  if (prismLanguage) return highlightCodeRecursive(text, prismLanguage, 0);
  return highlightAuto(text);
}

export function highlightLineFragmentByPath(text: string, path: string): string {
  if (text.length > DEFAULT_HIGHLIGHT_MAX_BYTES) return escapeHtml(text);
  const extension = fileExtension(path);
  const prismLanguage = DATA_LANGUAGES.has(extension) ? "json" : prismLanguageForExtension(extension);
  if (prismLanguage) return highlightCodeRecursive(text, prismLanguage, 0);
  return highlightGenericCode(text);
}

export function highlightDiff(text: string, path: string | null | undefined): string {
  if (text.length > DEFAULT_HIGHLIGHT_MAX_BYTES) return escapeHtml(text);
  const explicitLanguage = prismLanguageForPath(path || "");
  const detectedLanguage = explicitLanguage || detectDiffBodyLanguage(text);
  const lines = splitLinesKeepingEndings(text);
  let html = "";
  for (const line of lines) html += highlightDiffLine(line, detectedLanguage);
  return html;
}

function highlightDiffLine(line: string, language: string | null): string {
  const content = line.replace(/[\r\n]+$/, "");
  let cls = "diff-code-context";
  let prefix = "";
  let body = content;
  let highlightBody = false;
  if (content.startsWith("@@")) {
    cls = "diff-code-hunk";
  } else if (content.startsWith("diff --git") || content.startsWith("index ")) {
    cls = "diff-code-meta";
  } else if (content.startsWith("+++") || content.startsWith("---")) {
    cls = "diff-code-file";
    prefix = content.slice(0, 3);
    body = content.slice(3);
  } else if (content.startsWith("+")) {
    cls = "diff-code-add";
    prefix = "+";
    body = content.slice(1);
    highlightBody = true;
  } else if (content.startsWith("-")) {
    cls = "diff-code-del";
    prefix = "-";
    body = content.slice(1);
    highlightBody = true;
  } else if (content.startsWith(" ")) {
    prefix = " ";
    body = content.slice(1);
    highlightBody = true;
  } else if (content.startsWith("\\ No newline")) {
    cls = "diff-code-meta";
  } else {
    highlightBody = true;
  }
  const prefixHtml = prefix ? '<span class="diff-code-prefix">' + escapeHtml(prefix) + '</span>' : "";
  const bodyHtml = highlightBody && language ? highlightCodePreservingLeadingWhitespace(body, language) : escapeHtml(body);
  return '<span class="diff-code-line ' + cls + '">' + prefixHtml + bodyHtml + '</span>';
}

function highlightCodePreservingLeadingWhitespace(text: string, language: string): string {
  const leadingWhitespace = text.match(/^[ 	]+/)?.[0] || "";
  if (!leadingWhitespace) return highlightCodeRecursive(text, language, 0);
  return escapeHtml(leadingWhitespace) + highlightCodeRecursive(text.slice(leadingWhitespace.length), language, 0);
}

function detectDiffBodyLanguage(text: string): string | null {
  const headerLanguage = detectDiffHeaderLanguage(text);
  if (headerLanguage) return headerLanguage;
  const bodyLines: string[] = [];
  for (const line of splitLinesKeepingEndings(text)) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff --git") || line.startsWith("index ")) continue;
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) bodyLines.push(line.slice(1));
    else bodyLines.push(line);
  }
  return detectPrismLanguage(bodyLines.join(""));
}

function detectDiffHeaderLanguage(text: string): string | null {
  for (const line of splitLinesKeepingEndings(text)) {
    let candidate = "";
    if (line.startsWith("+++ ") || line.startsWith("--- ")) candidate = line.slice(4).trim();
    else if (line.startsWith("diff --git ")) candidate = line.trim().split(/\s+/).pop() || "";
    if (!candidate || candidate === "/dev/null") continue;
    const language = prismLanguageForPath(candidate.replace(/^[ab]\//, ""));
    if (language) return language;
  }
  return null;
}

function prismLanguageForPath(path: string): string | null {
  const extension = fileExtension(path);
  return extension ? prismLanguageForExtension(extension) : null;
}

function prismLanguageForExtension(extension: string): string | null {
  return prismLanguageForName(extension) || PRISM_LANGUAGE_EXTENSION_OVERRIDES[extension] || null;
}

function prismLanguageForName(language: string): string | null {
  const normalized = normalizeCodeLanguage(language);
  if (!normalized) return null;
  return Prism.languages[normalized] ? normalized : null;
}

function looksLikeDiffText(text: string): boolean {
  if (!hasLineBreak(text)) return false;
  if (/^diff --git /m.test(text) || /^@@ -\d/m.test(text)) return true;
  if (!/^---\s/m.test(text) || !/^\+\+\+\s/m.test(text)) return false;
  return /^[-+]\S/m.test(text) || /^[-+]\s/m.test(text);
}

// Auto-detect HJSON / Markdown / common code / plain and apply the matching highlighter.
export function highlightAuto(text: string): string {
  if (text.length > DEFAULT_HIGHLIGHT_MAX_BYTES) return escapeHtml(text);
  const parsed = parseStructuredText(text, false);
  if (parsed.ok) return highlightHjsonValue(parsed.value);
  if (looksLikeDiffText(text)) return highlightDiff(text, null);
  if (looksLikeMarkdownText(text)) return highlightWithPrism(text, "markdown");
  const embeddedCode = detectEmbeddedCodeText(text);
  return embeddedCode.ok ? embeddedCode.html : escapeHtml(text);
}

export function formatHjson(value: unknown, options: HjsonFormatOptions = {}): string {
  const ctx = createRenderContext(options, false);
  return renderRootHjsonComments(ctx) + renderHjsonValue(value, 0, ctx);
}

export function maybeFormatHjsonTextForView(text: string): string | null {
  const parsed = parseStructuredText(text, false);
  return parsed.ok ? formatHjson(unwrapStructuredTextString(parsed.value), { comments: parsed.comments ?? undefined }) : null;
}

export function formatHjsonTextForView(text: string): string {
  return maybeFormatHjsonTextForView(text) ?? text;
}

export function formatJsonTextForView(text: string): string {
  return formatHjsonTextForView(text);
}

export function highlightHjson(text: string, options: { force?: boolean; jsonLines?: boolean } = {}): string {
  if (text.length > DEFAULT_HIGHLIGHT_MAX_BYTES) return escapeHtml(text);
  if (options.jsonLines) {
    const highlightedLines = highlightHjsonLines(text);
    if (highlightedLines !== null) return highlightedLines;
  }
  const parsed = parseStructuredText(text, options.force === true);
  if (parsed.ok) return highlightHjsonValue(parsed.value, { comments: parsed.comments ?? undefined });
  return highlightWithPrism(text, "json");
}

export function highlightJson(text: string): string {
  return highlightHjson(text, { force: true });
}

export function highlightHjsonValue(value: unknown, options: HjsonFormatOptions = {}): string {
  const ctx = createRenderContext(options, true);
  return renderRootHjsonComments(ctx) + renderHjsonValue(value, 0, ctx);
}

export function highlightTurtle(text: string): string {
  return highlightWithPrism(text, "turtle");
}

export function highlightGenericCode(text: string, language?: string): string {
  if (language) {
    const normalized = normalizeCodeLanguage(language);
    const prismLanguage = prismLanguageForName(normalized) || normalized;
    return highlightCodeRecursive(text, prismLanguage, 0);
  }
  const embeddedCode = detectEmbeddedCodeText(text);
  return embeddedCode.ok ? embeddedCode.html : escapeHtml(text);
}

function createRenderContext(options: HjsonFormatOptions, html: boolean): RenderContext {
  return {
    html,
    indent: options.indent ?? 2,
    maxDepth: options.maxDepth ?? 40,
    linkStoreHashes: options.linkStoreHashes === true,
    comments: options.comments ?? null,
    seen: new WeakSet<object>(),
    embeddedDepth: 0,
  };
}

function renderHjsonValue(value: unknown, depth: number, ctx: RenderContext, path: Array<string | number> = []): string {
  if (value === null) return span(ctx, "json-null", "null");
  if (typeof value === "string") return renderHjsonString(value, padFor(ctx, depth), ctx);
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? span(ctx, "json-num", Object.is(value, -0) ? "-0" : String(value))
      : renderHjsonString(String(value), padFor(ctx, depth), ctx);
  }
  if (typeof value === "boolean") return span(ctx, "json-bool", value ? "true" : "false");
  if (typeof value === "bigint") return renderHjsonString(String(value), padFor(ctx, depth), ctx);
  if (typeof value === "undefined") return renderHjsonString("undefined", padFor(ctx, depth), ctx);
  if (typeof value === "function") return renderHjsonString(`[Function ${value.name || "anonymous"}]`, padFor(ctx, depth), ctx);
  if (typeof value === "symbol") return renderHjsonString(String(value), padFor(ctx, depth), ctx);
  if (!value || typeof value !== "object") return renderHjsonString(String(value), padFor(ctx, depth), ctx);

  const special = specialDisplayValue(value);
  if (special.handled) return renderHjsonValue(special.value, depth, ctx, path);

  if (depth >= ctx.maxDepth) return renderHjsonString("[Max depth]", padFor(ctx, depth), ctx);
  if (ctx.seen.has(value)) return renderHjsonString("[Circular]", padFor(ctx, depth), ctx);

  ctx.seen.add(value);
  try {
    if (Array.isArray(value)) return renderHjsonArray(value, depth, ctx, path);
    return renderHjsonObject(value as Record<string, unknown>, depth, ctx, path);
  } finally {
    ctx.seen.delete(value);
  }
}

function renderHjsonArray(value: unknown[], depth: number, ctx: RenderContext, path: Array<string | number>): string {
  if (value.length === 0) return span(ctx, "json-punct", "[]");
  const itemPad = padFor(ctx, depth + 1);
  const endPad = padFor(ctx, depth);
  const lines: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = Object.prototype.hasOwnProperty.call(value, i) ? value[i] : undefined;
    const itemPath = path.concat(i);
    const comment = commentForPath(ctx, itemPath);
    lines.push(...renderHjsonCommentLines(comment?.before, itemPad, ctx));
    let line = itemPad + renderHjsonValue(item, depth + 1, ctx, itemPath);
    if (comment?.after) line += " " + renderHjsonComment(comment.after, ctx);
    lines.push(line);
  }
  const body = "\n" + lines.join("\n") + "\n" + endPad;
  const html =
    span(ctx, "json-punct", "[") +
    hjsonCollapsedPreview(ctx, hjsonCountSummary(value.length, "item")) +
    hjsonBody(ctx, body) +
    span(ctx, "json-punct", "]");
  return hjsonCollapsible(ctx, "array", html);
}

function renderHjsonObject(value: Record<string, unknown>, depth: number, ctx: RenderContext, path: Array<string | number>): string {
  const entries = Object.entries(value);
  if (entries.length === 0) return span(ctx, "json-punct", "{}");
  const itemPad = padFor(ctx, depth + 1);
  const endPad = padFor(ctx, depth);
  const lines: string[] = [];
  for (const [key, entryValue] of entries) {
    const entryPath = path.concat(key);
    const comment = commentForPath(ctx, entryPath);
    lines.push(...renderHjsonCommentLines(comment?.before, itemPad, ctx));
    let line = itemPad + renderHjsonKey(key, ctx) + span(ctx, "json-punct", ":") + " " + renderHjsonValue(entryValue, depth + 1, ctx, entryPath);
    if (comment?.after) line += " " + renderHjsonComment(comment.after, ctx);
    lines.push(line);
  }
  const body = "\n" + lines.join("\n") + "\n" + endPad;
  const html =
    span(ctx, "json-punct", "{") +
    hjsonCollapsedPreview(ctx, hjsonCountSummary(entries.length, "key")) +
    hjsonBody(ctx, body) +
    span(ctx, "json-punct", "}");
  return hjsonCollapsible(ctx, "object", html);
}

function commentKey(path: Array<string | number>): string {
  return JSON.stringify(path);
}

function commentForPath(ctx: RenderContext, path: Array<string | number>): HjsonComment | undefined {
  return ctx.comments?.get(commentKey(path));
}

function renderRootHjsonComments(ctx: RenderContext): string {
  const before = commentForPath(ctx, [])?.before;
  if (!before?.length) return "";
  return renderHjsonCommentLines(before, "", ctx).join("\n") + "\n";
}

function renderHjsonCommentLines(comments: string[] | undefined, pad: string, ctx: RenderContext): string[] {
  return comments?.map((comment) => pad + renderHjsonComment(comment, ctx)) ?? [];
}

function renderHjsonComment(comment: string, ctx: RenderContext): string {
  return span(ctx, "json-comment", comment);
}

function renderHjsonKey(key: string, ctx: RenderContext): string {
  return span(ctx, "json-key", isBareHjsonKey(key) ? key : quoteHjsonString(key));
}

function renderHjsonString(value: string, pad: string, ctx: RenderContext): string {
  const multiline = normalizeMultilineString(value);
  if (multiline !== null) return renderHjsonMultilineString(multiline, pad, ctx);

  const quoted = quoteHjsonString(value);
  if (!ctx.html) return quoted;

  const storeHash = ctx.linkStoreHashes ? normalizedStoreHash(value) : null;
  const embedded = storeHash ? null : embeddedHighlightHtml(value, ctx);
  const rendered = storeHash
    ? renderLinkedHjsonString(quoted, storeHash, ctx)
    : embedded
      ? span(ctx, "json-str", '"') + '<span class="json-embedded">' + embedded + "</span>" + span(ctx, "json-str", '"')
      : span(ctx, "json-str", quoted);

  return maybeCollapsibleHjsonString(value, rendered, embedded !== null, ctx);
}

function renderLinkedHjsonString(quoted: string, hash: string, ctx: RenderContext): string {
  return '<button type="button" class="store-link json-store-link" data-store-hash="' + escapeHtml(hash) + '" title="open store preview">' + span(ctx, "json-str", quoted) + "</button>";
}

function normalizedStoreHash(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  return /^sha256:[a-f0-9]{64}$/.test(trimmed) ? trimmed : null;
}

function renderHjsonMultilineString(value: string, pad: string, ctx: RenderContext): string {
  const bodyPad = pad + " ".repeat(ctx.indent);
  if (!ctx.html) {
    return "'''\n" + value.split("\n").map((line) => bodyPad + protectHjsonMultilineIndent(line)).join("\n") + "\n" + pad + "'''";
  }

  const embedded = embeddedHighlightHtml(value, ctx) || escapeHtml(value);
  const rendered =
    '<span class="hjson-string-expanded">' +
    span(ctx, "json-str", "'''") + "\n" +
    '<span class="json-embedded">' + indentHtmlLines(embedded, bodyPad) + "</span>" + "\n" +
    pad + span(ctx, "json-str", "'''") +
    "</span>";
  return hjsonCollapsible(ctx, "string", rendered + hjsonStringCollapsedPreview(ctx, value));
}

function hjsonCollapsible(ctx: RenderContext, kind: "object" | "array" | "string", html: string): string {
  if (!ctx.html) return html;
  return (
    '<span class="hjson-collapsible hjson-' + kind + '" data-hjson-kind="' + kind + '">' +
    '<button type="button" class="hjson-toggle" aria-expanded="true" aria-label="collapse ' + kind + '" title="collapse ' + kind + '"></button>' +
    html +
    "</span>"
  );
}

function hjsonBody(ctx: RenderContext, html: string): string {
  return ctx.html ? '<span class="hjson-body">' + html + "</span>" : html;
}

function hjsonCollapsedPreview(ctx: RenderContext, text: string): string {
  return ctx.html ? '<span class="hjson-collapsed-preview" aria-hidden="true">' + escapeHtml(text) + "</span>" : "";
}

function hjsonStringCollapsedPreview(ctx: RenderContext, value: string): string {
  return ctx.html
    ? '<span class="hjson-collapsed-preview" aria-hidden="true">' + span(ctx, "json-str", collapsedHjsonStringPreview(value)) + "</span>"
    : "";
}

function maybeCollapsibleHjsonString(value: string, rendered: string, hasEmbedded: boolean, ctx: RenderContext): string {
  if (!ctx.html || (!hasEmbedded && value.length < HJSON_COLLAPSIBLE_STRING_MIN_CHARS && !hasLineBreak(value))) return rendered;
  return hjsonCollapsible(
    ctx,
    "string",
    '<span class="hjson-string-expanded">' + rendered + "</span>" + hjsonStringCollapsedPreview(ctx, value),
  );
}

function hjsonCountSummary(count: number, unit: string): string {
  return "… " + count + " " + unit + (count === 1 ? "" : "s");
}

function collapsedHjsonStringPreview(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
  const preview = normalized.length > HJSON_COLLAPSIBLE_STRING_PREVIEW_CHARS
    ? normalized.slice(0, HJSON_COLLAPSIBLE_STRING_PREVIEW_CHARS - 1) + "…"
    : normalized;
  return quoteHjsonString(preview);
}

function embeddedHighlightHtml(value: string, ctx: RenderContext): string | null {
  if (ctx.embeddedDepth >= 2 || value.length > DEFAULT_HIGHLIGHT_MAX_BYTES) return null;

  const embeddedCtx: RenderContext = {
    ...ctx,
    seen: new WeakSet<object>(),
    embeddedDepth: ctx.embeddedDepth + 1,
  };

  const parsed = parseStructuredText(value, false);
  if (parsed.ok) return renderHjsonValue(parsed.value, 0, embeddedCtx);
  if (looksLikeDiffText(value)) return highlightDiff(value, null);
  if (looksLikeMarkdownText(value)) return highlightWithPrism(value, "markdown");

  const embeddedCode = detectEmbeddedCodeText(value);
  return embeddedCode.ok ? embeddedCode.html : null;
}

function indentHtmlLines(html: string, pad: string): string {
  const escapedPad = escapeHtml(pad);
  return escapedPad + html.split("\n").join("\n" + escapedPad);
}

function span(ctx: RenderContext, cls: string, text: string): string {
  return ctx.html ? '<span class="' + cls + '">' + escapeHtml(text) + "</span>" : text;
}

function padFor(ctx: RenderContext, depth: number): string {
  return " ".repeat(depth * ctx.indent);
}

function quoteHjsonString(value: string): string {
  return JSON.stringify(value) || '""';
}

function normalizeMultilineString(value: string): string | null {
  if (!hasLineBreak(value) || value.includes("'''")) return null;
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "\r") {
      out += "\n";
      if (value[i + 1] === "\n") i++;
    } else {
      out += ch;
    }
  }
  return out.endsWith("\n") ? out.slice(0, -1) : out;
}

function protectHjsonMultilineIndent(line: string): string {
  return line.replace(/^[ \t]+/, (prefix) => prefix.replace(/ /g, " ").replace(/\t/g, "  "));
}


function hasLineBreak(value: string): boolean {
  return value.includes("\n") || value.includes("\r");
}

function isBareHjsonKey(key: string): boolean {
  if (!key) return false;
  if (!isIdentifierStart(key.charCodeAt(0))) return false;
  for (let i = 1; i < key.length; i++) {
    if (!isIdentifierPart(key.charCodeAt(i))) return false;
  }
  return true;
}

function isIdentifierStart(code: number): boolean {
  return code === 36 || code === 95 || isAsciiLetter(code);
}

function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || (code >= 48 && code <= 57);
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function parseStructuredText(text: string, force: boolean): ParsedStructuredText {
  if (!force && !looksLikeStructuredText(text)) return { ok: false };
  if (!text.trim()) return { ok: false };
  try {
    return { ok: true, value: Hjson.parse(text), comments: collectHjsonComments(text) };
  } catch {
    return { ok: false };
  }
}

function collectHjsonComments(text: string): HjsonCommentMap | null {
  if (!/(?:^|[\s{[,])(?:\/\/|\/\*)/.test(text)) return null;
  const comments = new Map<string, HjsonComment>();
  const stack: Array<{ type: "object" | "array"; path: Array<string | number>; index: number }> = [];
  const pending: string[] = [];
  let inBlockComment = false;
  for (const rawLine of text.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (inBlockComment) {
      pending.push(trimmed);
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    while (/^[}\]]/.test(trimmed) && stack.length) stack.pop();
    const ownLineComment = fullLineComment(trimmed);
    if (ownLineComment) {
      pending.push(ownLineComment);
      if (ownLineComment.startsWith("/*") && !ownLineComment.includes("*/")) inBlockComment = true;
      continue;
    }
    const parent = stack[stack.length - 1];
    const key = parent?.type === "object" ? propertyKey(trimmed) : undefined;
    const isItem = parent?.type === "array" && !/^[}\]]/.test(trimmed);
    const path = key !== undefined && parent ? parent.path.concat(key) : isItem && parent ? parent.path.concat(parent.index) : null;
    const trailing = trailingComment(rawLine);
    if (path) {
      if (pending.length || trailing) comments.set(commentKey(path), { before: pending.splice(0), after: trailing ?? undefined });
      if (parent?.type === "array") parent.index++;
    }
    const valueText = key !== undefined ? trimmed.slice(trimmed.indexOf(":") + 1).trim() : trimmed;
    const opener = firstContainerOpener(stripComments(valueText));
    if (opener && path) stack.push({ type: opener === "{" ? "object" : "array", path, index: 0 });
    else if (!parent && /^[{[]/.test(trimmed)) {
      if (pending.length) comments.set(commentKey([]), { before: pending.splice(0) });
      stack.push({ type: trimmed[0] === "{" ? "object" : "array", path: [], index: 0 });
    } else if (!path && pending.length) {
      pending.length = 0;
    }
  }
  return comments.size ? comments : null;
}

function fullLineComment(trimmed: string): string | null {
  return trimmed.startsWith("//") || trimmed.startsWith("/*") ? trimmed : null;
}

function propertyKey(trimmed: string): string | undefined {
  const quoted = /^"((?:\\.|[^"\\])*)"\s*:/.exec(trimmed);
  if (quoted) {
    try { return JSON.parse('"' + quoted[1] + '"'); } catch { return quoted[1]; }
  }
  const bare = /^([A-Za-z_$][A-Za-z0-9_$-]*)\s*:/.exec(trimmed);
  return bare?.[1];
}

function trailingComment(line: string): string | null {
  let quote = "";
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "/" && line[i + 1] === "/") return line.slice(i).trim();
    if (ch === "/" && line[i + 1] === "*") return line.slice(i).trim();
  }
  return null;
}

function stripComments(text: string): string {
  const at = trailingComment(text);
  return at ? text.slice(0, text.indexOf(at)).trim() : text;
}

function firstContainerOpener(text: string): "{" | "[" | null {
  const ch = firstNonWhitespaceChar(text.replace(/,$/, ""));
  return ch === "{" || ch === "[" ? ch : null;
}

function unwrapStructuredTextString(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth++) {
    if (typeof current !== "string") return current;
    const parsed = parseStructuredText(current.trim(), false);
    if (!parsed.ok || !isStructuredContainer(parsed.value)) return current;
    current = parsed.value;
  }
  return current;
}

function isStructuredContainer(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

export function looksLikeMarkdownText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || !hasLineBreak(trimmed)) return false;
  if (/^#{1,6}\s+\S/m.test(trimmed)) return true;
  if (/^>\s+\S/m.test(trimmed)) return true;
  if (/^[-*+]\s+\S/m.test(trimmed)) return true;
  if (/^\d+[.)]\s+\S/m.test(trimmed)) return true;
  if (/^```[\s\S]*```\s*$/m.test(trimmed)) return true;
  if (/^\|.*\|\s*$/m.test(trimmed) && /^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|\s*$/m.test(trimmed)) return true;
  if (/\[[^\]\n]+\]\([^\s)]+\)/.test(trimmed)) return true;
  return false;
}

function looksLikeStructuredText(text: string): boolean {
  const ch = firstNonWhitespaceChar(stripLeadingJsoncComments(text));
  return ch === "{" || ch === "[" || ch === '"';
}

function stripLeadingJsoncComments(text: string): string {
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /[ \t\n\r\f]/.test(text[i])) i++;
    if (text[i] === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i + 2);
      if (end === -1) return "";
      i = end + 1;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return "";
      i = end + 2;
      continue;
    }
    break;
  }
  return text.slice(i);
}

function firstNonWhitespaceChar(text: string): string {
  for (const ch of text) {
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r" && ch !== "\f") return ch;
  }
  return "";
}

function highlightHjsonLines(text: string): string | null {
  const out: string[] = [];
  let parsedAny = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      out.push(escapeHtml(line));
      continue;
    }
    const parsed = parseStructuredText(line, true);
    if (!parsed.ok) return null;
    parsedAny = true;
    out.push(highlightHjsonValue(parsed.value));
  }
  return parsedAny ? out.join("\n") : null;
}

function highlightWithPrism(text: string, language: string): string {
  const grammar = Prism.languages[language];
  if (!grammar) return escapeHtml(text);
  try {
    return Prism.highlight(text, grammar, language);
  } catch {
    return escapeHtml(text);
  }
}

function highlightCodeRecursive(text: string, language: string, depth: number): string {
  if (depth >= 4 || text.length > DEFAULT_HIGHLIGHT_MAX_BYTES) return highlightWithPrism(text, language);
  if (language === "yaml") return highlightYamlWithEmbeddedBlocks(text, depth);
  if (language === "javascript" || language === "typescript") return highlightJsWithEmbeddedTemplates(text, language, depth);
  if (language === "python") return highlightPythonWithEmbeddedStrings(text, depth);
  return highlightWithPrism(text, language);
}

function highlightYamlWithEmbeddedBlocks(text: string, depth: number): string {
  const lines = splitLinesKeepingEndings(text);
  let html = "";
  let plain = "";

  const flushPlain = () => {
    if (!plain) return;
    html += highlightWithPrism(plain, "yaml");
    plain = "";
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const block = yamlBlockScalarHeader(line);
    if (!block) {
      plain += line;
      continue;
    }

    const bodyStart = i + 1;
    let bodyEnd = bodyStart;
    let bodyIndent: number | null = null;
    while (bodyEnd < lines.length) {
      const bodyLine = lines[bodyEnd]!;
      const content = bodyLine.replace(/[\r\n]+$/, "");
      if (content.trim() !== "") {
        const indent = leadingSpaceCount(content);
        if (indent <= block.indent) break;
        bodyIndent = bodyIndent === null ? indent : Math.min(bodyIndent, indent);
      }
      bodyEnd++;
    }

    if (bodyEnd === bodyStart || bodyIndent === null) {
      plain += line;
      continue;
    }

    flushPlain();
    html += highlightWithPrism(line, "yaml");
    const body = lines.slice(bodyStart, bodyEnd).map((bodyLine) => stripIndentFromLine(bodyLine, bodyIndent!)).join("");
    const language = detectPrismLanguage(body) || "";
    const bodyHtml = language ? highlightCodeRecursive(body, language, depth + 1) : escapeHtml(body);
    html += indentHtmlLines(bodyHtml, " ".repeat(bodyIndent));
    i = bodyEnd - 1;
  }

  flushPlain();
  return html;
}

function yamlBlockScalarHeader(line: string): { indent: number } | null {
  const content = line.replace(/[\r\n]+$/, "");
  const match = /^( *)(?:-\s*)?(?:[^#\r\n]*:\s*)?[|>][-+0-9]*\s*(?:#.*)?$/.exec(content);
  if (!match || !content.includes(":")) return null;
  return { indent: match[1]!.length };
}

function highlightJsWithEmbeddedTemplates(text: string, language: string, depth: number): string {
  let html = "";
  let pos = 0;
  for (const template of findBacktickStrings(text)) {
    const inner = text.slice(template.innerStart, template.innerEnd);
    if (inner.includes("${")) continue;
    const innerLanguage = detectPrismLanguage(inner);
    if (!innerLanguage) continue;
    html += highlightWithPrism(text.slice(pos, template.start), language);
    html += spanToken("template-string string", "`");
    html += '<span class="json-embedded">' + highlightCodeRecursive(inner, innerLanguage, depth + 1) + "</span>";
    html += spanToken("template-string string", "`");
    pos = template.end;
  }
  if (pos === 0) return highlightWithPrism(text, language);
  html += highlightWithPrism(text.slice(pos), language);
  return html;
}

function highlightPythonWithEmbeddedStrings(text: string, depth: number): string {
  let html = "";
  let pos = 0;
  for (const quoted of findQuotedStrings(text)) {
    const raw = text.slice(quoted.innerStart, quoted.innerEnd);
    const decoded = decodeSimpleEscapes(raw);
    if (!looksLikeJson(decoded)) continue;
    html += highlightWithPrism(text.slice(pos, quoted.start), "python");
    html += spanToken("string", quoted.quote);
    html += '<span class="json-embedded">' + highlightCodeRecursive(decoded, "json", depth + 1) + "</span>";
    html += spanToken("string", quoted.quote);
    pos = quoted.end;
  }
  if (pos === 0) return highlightWithPrism(text, "python");
  html += highlightWithPrism(text.slice(pos), "python");
  return html;
}

function findBacktickStrings(text: string): Array<{ start: number; innerStart: number; innerEnd: number; end: number }> {
  const out: Array<{ start: number; innerStart: number; innerEnd: number; end: number }> = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "`" || isEscaped(text, i)) continue;
    const start = i;
    i++;
    while (i < text.length && (text[i] !== "`" || isEscaped(text, i))) i++;
    if (i >= text.length) break;
    out.push({ start, innerStart: start + 1, innerEnd: i, end: i + 1 });
  }
  return out;
}

function findQuotedStrings(text: string): Array<{ start: number; innerStart: number; innerEnd: number; end: number; quote: string }> {
  const out: Array<{ start: number; innerStart: number; innerEnd: number; end: number; quote: string }> = [];
  for (let i = 0; i < text.length; i++) {
    const quote = text[i];
    if ((quote !== "'" && quote !== '"') || isEscaped(text, i)) continue;
    const triple = text.slice(i, i + 3) === quote.repeat(3);
    const delimiter = triple ? quote.repeat(3) : quote;
    const start = i;
    i += delimiter.length;
    const innerStart = i;
    while (i < text.length) {
      if (!isEscaped(text, i) && text.slice(i, i + delimiter.length) === delimiter) {
        out.push({ start, innerStart, innerEnd: i, end: i + delimiter.length, quote: delimiter });
        i += delimiter.length - 1;
        break;
      }
      i++;
    }
  }
  return out;
}

function splitLinesKeepingEndings(text: string): string[] {
  const matches = text.match(/.*(?:\r\n|\n|\r|$)/g) || [];
  return matches.length > 0 && matches[matches.length - 1] === "" ? matches.slice(0, -1) : matches;
}

function stripIndentFromLine(line: string, indent: number): string {
  let count = 0;
  while (count < line.length && count < indent && line[count] === " ") count++;
  return line.slice(count);
}

function leadingSpaceCount(text: string): number {
  let count = 0;
  while (count < text.length && text[count] === " ") count++;
  return count;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashCount++;
  return slashCount % 2 === 1;
}

function decodeSimpleEscapes(text: string): string {
  return text.replace(/\\([\\'"/bfnrt])/g, (_match, ch: string) => {
    if (ch === "b") return "\b";
    if (ch === "f") return "\f";
    if (ch === "n") return "\n";
    if (ch === "r") return "\r";
    if (ch === "t") return "\t";
    return ch;
  });
}

function spanToken(cls: string, text: string): string {
  return '<span class="token ' + cls + '">' + escapeHtml(text) + "</span>";
}

function detectEmbeddedCodeText(text: string): EmbeddedCodeText {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false };
  if (isYamlText(trimmed)) return { ok: true, language: "yaml", html: highlightCodeRecursive(text, "yaml", 0) };
  if (!looksLikeCodeText(trimmed)) return { ok: false };
  const language = detectPrismLanguage(text);
  if (!language) return { ok: false };
  return { ok: true, language, html: highlightCodeRecursive(text, language, 0) };
}

function detectPrismLanguage(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (looksLikeJson(trimmed)) return "json";
  if (isYamlText(trimmed)) return "yaml";
  if (looksLikeTypeScript(trimmed)) return "typescript";
  if (looksLikeJavaScript(trimmed)) return "javascript";
  if (looksLikePython(trimmed)) return "python";
  if (looksLikeCss(trimmed)) return "css";
  if (looksLikeShell(trimmed)) return "bash";
  if (looksLikeMarkup(trimmed)) return "markup";
  if (looksLikeRust(trimmed)) return "rust";
  return null;
}

function looksLikeJson(text: string): boolean {
  if (!/^[\[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function looksLikeCodeText(text: string): boolean {
  if (text.length < 16 || !hasLineBreak(text)) return false;
  const codeMarkers = [
    "{",
    "}",
    "(",
    ")",
    ";",
    "=",
    "<",
    ">",
    "function ",
    "const ",
    "let ",
    "var ",
    "class ",
    "import ",
    "export ",
    "if ",
    "for ",
    "while ",
    "case ",
    "def ",
    "fn ",
    "use ",
    "package ",
    "object ",
    "trait ",
    "type ",
    "interface ",
    "#include",
    "#!/",
    "$ ",
    "# ",
    "- ",
    "* ",
    "+ ",
  ];
  return hasAny(text, codeMarkers);
}

function looksLikePython(text: string): boolean {
  return /(^|\n)\s*(?:from\s+\w+(?:\.\w+)*\s+import\s+\w+|import\s+\w+(?:\.\w+)*|def\s+\w+\s*\([^)]*\)\s*:|class\s+\w+(?:\([^)]*\))?\s*:|if\s+__name__\s*==\s*["']__main__["']\s*:|print\s*\(|elif\s+.+:|except(?:\s+\w+)?\s*:)/.test(text);
}

function looksLikeTypeScript(text: string): boolean {
  return /(^|\n)\s*(?:import\s+type\s+|export\s+type\s+|type\s+\w+\s*=|interface\s+\w+|enum\s+\w+|(?:const|let|var)\s+\w+\s*:\s*\w+)/.test(text);
}

function looksLikeJavaScript(text: string): boolean {
  return /(^|\n)\s*(?:import\s+.+\s+from\s+["'][^"']+["']|export\s+(?:default\s+)?(?:function|const|class)|(?:const|let|var)\s+\w+\s*=|function\s+\w+\s*\(|console\.log\s*\(|async\s+function\s+)/.test(text);
}

function looksLikeCss(text: string): boolean {
  return /(?:^|\n)\s*(?:[#.]?[a-zA-Z][\w-]*|:[\w-]+)\s*(?:,[^{},]+)*\{[^{}]*:[^{}]*\}/.test(text);
}

function looksLikeShell(text: string): boolean {
  return /(^|\n)\s*(?:#!\/?(?:usr\/bin\/env\s+)?(?:ba|z|fi)?sh|(?:sudo\s+)?(?:git|npm|bun|pnpm|yarn|cargo|nix|direnv|cd|mkdir|rm|cp|mv)\b|[A-Z_][A-Z0-9_]*=\S+)/.test(text);
}

function looksLikeMarkup(text: string): boolean {
  return /^\s*<[a-zA-Z][\s\S]*>\s*$/.test(text);
}

function looksLikeRust(text: string): boolean {
  return /(^|\n)\s*(?:fn\s+\w+\s*\(|use\s+[\w:]+;|impl(?:<[^>]+>)?\s+\w+|struct\s+\w+|enum\s+\w+|let\s+mut\s+\w+)/.test(text);
}

function isYamlText(text: string): boolean {
  if (!hasLineBreak(text)) return false;
  try {
    const doc = YAML.parseDocument(text);
    if (doc.errors.length > 0) return false;
    const value = doc.toJSON();
    return isYamlStructuredValue(value);
  } catch {
    return false;
  }
}

function isYamlStructuredValue(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function fileExtension(path: string): string {
  let clean = path.toLowerCase();
  if (clean.endsWith(".new")) clean = clean.slice(0, -".new".length);
  if (clean.endsWith(".old")) clean = clean.slice(0, -".old".length);
  const slash = clean.lastIndexOf("/");
  const basename = slash === -1 ? clean : clean.slice(slash + 1);
  const dot = basename.lastIndexOf(".");
  return dot === -1 ? "" : basename.slice(dot + 1);
}

function specialDisplayValue(value: object): { handled: true; value: unknown } | { handled: false } {
  if (value instanceof Date) return { handled: true, value: value.toISOString() };
  if (value instanceof RegExp) return { handled: true, value: String(value) };
  if (value instanceof Error) {
    const errorValue: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    };
    if (value.stack) errorValue.stack = value.stack;
    return { handled: true, value: errorValue };
  }
  if (value instanceof Map) return { handled: true, value: Object.fromEntries(value.entries()) };
  if (value instanceof Set) return { handled: true, value: Array.from(value.values()) };
  return { handled: false };
}
