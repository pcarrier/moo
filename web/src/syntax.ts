export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Highlighters tokenize the entire input synchronously; on multi-MB files
// they freeze the main thread. Above this size, fall back to plain-escaped
// text — viewers can still read the content, just without syntax colors.
const HIGHLIGHT_MAX_BYTES = 256 * 1024;

export function highlightByPath(text: string, path: string): string {
  if (text.length > HIGHLIGHT_MAX_BYTES) return escapeHtml(text);
  const clean = path.toLowerCase().replace(/(?:^|\.)(?:new|old)$/, "");
  if (/\.(json|jsonc|jsonl)$/.test(clean) || /^[\s]*[\[{"]/.test(text)) return highlightJson(formatJsonTextForView(text));
  if (/\.(ttl|turtle|rdf)$/.test(clean)) return highlightTurtle(text);
  if (/\.(ts|tsx|js|jsx|mjs|cjs|css|scss|html|svelte|vue|rs|toml|yaml|yml|md|mdx)$/.test(clean)) {
    return highlightGenericCode(text);
  }
  return escapeHtml(text);
}

// Auto-detect JSON / Turtle / plain and apply the matching highlighter.
export function highlightAuto(text: string): string {
  if (text.length > HIGHLIGHT_MAX_BYTES) return escapeHtml(text);
  if (/^[\s]*[\[{"]/.test(text)) return highlightJson(formatJsonTextForView(text));
  if (
    /^@prefix\b/m.test(text) ||
    /^[A-Za-z][\w:-]*\s+(a|[A-Za-z][\w:-]*)\s/m.test(text)
  ) {
    return highlightTurtle(text);
  }
  if (/\b(function|const|let|var|class|interface|type|import|export|return|async|await|fn|struct|enum|impl|use|mod)\b/.test(text)) {
    return highlightGenericCode(text);
  }
  return escapeHtml(text);
}

function highlightEmbeddedHjsonString(text: string): string {
  // Preserve the literal string body; embedded code should be tinted but not
  // reformatted the way top-level strict JSON is in the timeline view.
  if (/^[\s]*[\[{"]/.test(text)) return highlightJson(text);
  if (
    /^@prefix\b/m.test(text) ||
    /^[A-Za-z][\w:-]*\s+(a|[A-Za-z][\w:-]*)\s/m.test(text)
  ) {
    return highlightTurtle(text);
  }
  if (/\b(function|const|let|var|class|interface|type|import|export|return|async|await|fn|struct|enum|impl|use|mod)\b/.test(text)) {
    return highlightGenericCode(text);
  }
  return escapeHtml(text);
}

const IDENTIFIER_KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

type HjsonFormatOptions = {
  indent?: number;
  maxDepth?: number;
};

export function formatHjson(value: unknown, options: HjsonFormatOptions = {}): string {
  const indent = options.indent ?? 2;
  const maxDepth = options.maxDepth ?? 40;
  const seen = new WeakSet<object>();

  const padFor = (depth: number) => " ".repeat(depth * indent);

  const fmt = (v: unknown, depth: number): string => {
    if (v === null) return "null";
    if (typeof v === "string") return formatHjsonString(v, padFor(depth));
    if (typeof v === "number") {
      if (Number.isNaN(v)) return quoteHjsonString("NaN");
      if (v === Infinity) return quoteHjsonString("Infinity");
      if (v === -Infinity) return quoteHjsonString("-Infinity");
      return Object.is(v, -0) ? "-0" : String(v);
    }
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "bigint") return quoteHjsonString(String(v));
    if (typeof v === "undefined") return quoteHjsonString("undefined");
    if (typeof v === "function") return formatHjsonString(String(v), padFor(depth));
    if (typeof v === "symbol") return quoteHjsonString(String(v));
    if (!v || typeof v !== "object") return quoteHjsonString(String(v));
    if (depth >= maxDepth) return quoteHjsonString("[Max depth]");
    if (seen.has(v)) return quoteHjsonString("[Circular]");
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (v.length === 0) return "[]";
        const pad = padFor(depth + 1);
        const endPad = padFor(depth);
        const lines = v.map((item) => pad + fmt(item, depth + 1));
        return "[\n" + lines.join("\n") + "\n" + endPad + "]";
      }
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) return "{}";
      const pad = padFor(depth + 1);
      const endPad = padFor(depth);
      const lines = entries.map(([key, val]) => {
        const formatted = fmt(val, depth + 1);
        return pad + formatHjsonKey(key) + ": " + formatted;
      });
      return "{\n" + lines.join("\n") + "\n" + endPad + "}";
    } finally {
      seen.delete(v);
    }
  };

  return fmt(value, 0);
}

export function formatJsonTextForView(text: string): string {
  // Keep JSONL, JSONC, HJSON, and partial output as-authored; convert strict JSON
  // objects/arrays/strings to an HJSON-style view with multiline strings.
  if (!/^[\s]*[\[{"]/.test(text)) return text;
  try {
    return formatHjson(JSON.parse(text));
  } catch {
    return text;
  }
}

function formatHjsonKey(key: string): string {
  return IDENTIFIER_KEY_RE.test(key) ? key : quoteHjsonString(key);
}

function isHjsonMultilineString(value: unknown): value is string {
  return typeof value === "string" && /\r|\n/.test(value) && !value.includes("'''");
}

function decodeEscapedNewlineString(value: string): string | null {
  // Some timeline payloads arrive as already-stringified JSON-ish text. In that
  // path a logical multiline value can reach the view as literal \n escapes.
  if (!/(?:^|[^\\])(?:\\\\)*\\[nr]/.test(value) || value.includes("'''") || /\r|\n/.test(value)) return null;
  try {
    const decoded = JSON.parse(quoteJsonString(value));
    return typeof decoded === "string" && /\r|\n/.test(decoded) && !decoded.includes("'''") ? decoded : null;
  } catch {
    return null;
  }
}

function quoteJsonString(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case '"': out += "\\\""; break;
      case "\\": out += "\\\\"; break;
      case "\b": out += "\\b"; break;
      case "\f": out += "\\f"; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      default: {
        const code = ch.charCodeAt(0);
        out += code < 0x20 ? "\\u" + code.toString(16).padStart(4, "0") : ch;
      }
    }
  }
  return out + '"';
}

function formatHjsonString(value: string, pad: string): string {
  if (isHjsonMultilineString(value)) {
    // Indent body and closing fence one level deeper than the key, so
    // multiline values sit visibly inside the value scope.
    const body = pad + "  ";
    const lines = value.replace(/\r\n?/g, "\n").split("\n");
    return "'''\n" + lines.map((line) => body + line).join("\n") + "\n" + body + "'''";
  }
  const escapedNewlineValue = decodeEscapedNewlineString(value);
  if (escapedNewlineValue !== null) return formatHjsonString(escapedNewlineValue, pad);
  return quoteHjsonString(value);
}

function quoteHjsonString(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case '"': out += '\\\"'; break;
      case "\\": out += "\\\\"; break;
      case "\b": out += "\\b"; break;
      case "\f": out += "\\f"; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      case "\v": out += "\\v"; break;
      case "\0": out += "\\0"; break;
      default: {
        const code = ch.charCodeAt(0);
        out += code < 0x20 ? "\\u" + code.toString(16).padStart(4, "0") : ch;
      }
    }
  }
  return out + '"';
}

export function highlightJson(text: string): string {
  let html = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    // Bare identifier key (HJSON/JSON5): `name:`
    if (/[A-Za-z_$]/.test(ch)) {
      const m = text.slice(i).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
      if (m) {
        const ident = m[0];
        if (ident !== "true" && ident !== "false" && ident !== "null" && ident !== "undefined" && ident !== "Infinity" && ident !== "NaN") {
          let j = i + ident.length;
          while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
          if (text[j] === ":") {
            html += '<span class="json-key">' + ident + '</span>';
            i += ident.length;
            continue;
          }
        }
      }
    }
    if (ch === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i + 2);
      const tok = end === -1 ? text.slice(i) : text.slice(i, end);
      html += '<span class="json-comment">' + escapeHtml(tok) + '</span>';
      i += tok.length;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const tok = end === -1 ? text.slice(i) : text.slice(i, end + 2);
      html += '<span class="json-comment">' + escapeHtml(tok) + '</span>';
      i += tok.length;
      continue;
    }
    if (text.startsWith("'''", i)) {
      const bodyStart = i + 3;
      const end = text.indexOf("'''", bodyStart);
      const bodyEnd = end === -1 ? text.length : end;
      const body = text.slice(bodyStart, bodyEnd);
      html += '<span class="json-str">' + escapeHtml("'''") + '</span>';
      html += '<span class="json-embedded">' + highlightEmbeddedHjsonString(body) + '</span>';
      if (end !== -1) html += '<span class="json-str">' + escapeHtml("'''") + '</span>';
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    if (ch === "\"" || ch === "\'") {
      const quote = ch;
      let end = i + 1;
      while (end < text.length) {
        const c = text[end]!;
        if (c === "\\" && end + 1 < text.length) {
          end += 2;
          continue;
        }
        if (c === quote) {
          end++;
          break;
        }
        end++;
      }
      const tok = text.slice(i, end);
      let j = end;
      while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
      const cls = text[j] === ":" ? "json-key" : "json-str";
      html += '<span class="' + cls + '">' + escapeHtml(tok) + '</span>';
      i = end;
      continue;
    }
    if (ch === "-" || ch === "+" || (ch >= "0" && ch <= "9")) {
      const m = text.slice(i).match(/^[+-]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|Infinity|NaN)/);
      if (m) {
        html += '<span class="json-num">' + m[0] + '</span>';
        i += m[0].length;
        continue;
      }
    }
    if (text.startsWith("true", i)) { html += '<span class="json-bool">true</span>'; i += 4; continue; }
    if (text.startsWith("false", i)) { html += '<span class="json-bool">false</span>'; i += 5; continue; }
    if (text.startsWith("null", i)) { html += '<span class="json-null">null</span>'; i += 4; continue; }
    if (text.startsWith("undefined", i)) { html += '<span class="json-null">undefined</span>'; i += 9; continue; }
    if (text.startsWith("Infinity", i)) { html += '<span class="json-num">Infinity</span>'; i += 8; continue; }
    if (text.startsWith("NaN", i)) { html += '<span class="json-num">NaN</span>'; i += 3; continue; }
    if (ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === "," || ch === ":") {
      html += '<span class="json-punct">' + ch + '</span>';
      i++;
      continue;
    }
    html += escapeHtml(ch);
    i++;
  }
  return html;
}
export function highlightTurtle(text: string): string {
  // Lightweight pass: directives, IRIs, prefixed names, literals, comments.
  const tokens: Array<[RegExp, string]> = [
    [/(@prefix|@base|a)\b/g, "ttl-kw"],
    [/<[^>\s]+>/g, "ttl-iri"],
    [/"(?:[^"\\]|\\.)*"(?:@[a-z][a-zA-Z0-9-]*|\^\^[A-Za-z][A-Za-z0-9_-]*:[^\s]+)?/g, "ttl-str"],
    [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, "ttl-num"],
    [/\btrue\b|\bfalse\b/g, "ttl-bool"],
    [/[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9_:.-]*/g, "ttl-pn"],
    [/#([^\n]*)/g, "ttl-comment"],
  ];
  // Build segments: mark spans where tokens match, then emit sequentially.
  type Span = { start: number; end: number; cls: string };
  const spans: Span[] = [];
  for (const [re, cls] of tokens) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0]!.length;
      // Skip if any existing span overlaps (first match wins, in declaration order).
      if (spans.some((s) => start < s.end && end > s.start)) continue;
      spans.push({ start, end, cls });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  let out = "";
  let i = 0;
  for (const s of spans) {
    if (i < s.start) out += escapeHtml(text.slice(i, s.start));
    out += `<span class="${s.cls}">${escapeHtml(text.slice(s.start, s.end))}</span>`;
    i = s.end;
  }
  out += escapeHtml(text.slice(i));
  return out;
}

export function highlightGenericCode(text: string): string {
  const tokens: Array<[RegExp, string]> = [
    [/\/\/[^\n]*/g, "code-comment"],
    [/#([^\n]*)/g, "code-comment"],
    [/\/\*[\s\S]*?\*\//g, "code-comment"],
    [/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, "code-str"],
    [/\b(?:function|const|let|var|class|interface|type|import|export|from|return|if|else|for|while|switch|case|break|continue|async|await|try|catch|finally|new|extends|implements|public|private|protected|static|readonly|fn|struct|enum|impl|trait|use|mod|pub|match|where|self|Self|crate|super|mut|ref|move|in|as|true|false|null|undefined|None|Some|Ok|Err)\b/g, "code-kw"],
    [/-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, "code-num"],
    [/[A-Za-z_$][A-Za-z0-9_$]*(?=\s*[:=]\s*(?:async\s*)?(?:function|\(|<|[A-Za-z_$]|["'`{[]))/g, "code-ident"],
  ];
  type Span = { start: number; end: number; cls: string };
  const spans: Span[] = [];
  for (const [re, cls] of tokens) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0]!.length;
      if (spans.some((s) => start < s.end && end > s.start)) continue;
      spans.push({ start, end, cls });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  let out = "";
  let i = 0;
  for (const s of spans) {
    if (i < s.start) out += escapeHtml(text.slice(i, s.start));
    out += '<span class="' + s.cls + '">' + escapeHtml(text.slice(s.start, s.end)) + '</span>';
    i = s.end;
  }
  out += escapeHtml(text.slice(i));
  return out;
}
