import type { Moo, ObjectInput } from "../types";
import { Term } from "../types";

// IRIs and prefixed names render bare. Anything else is encoded as a Turtle
// string literal with proper escaping. Numbers and booleans become bare
// numeric/boolean literals. Variables (`?x`) pass through.
export function encodeObject(o: ObjectInput): string {
  if (o instanceof Term) return o.turtle;
  if (typeof o === "number") {
    if (!Number.isFinite(o)) return `"${String(o)}"`;
    return String(o);
  }
  if (typeof o === "boolean") return o ? "true" : "false";
  if (typeof o === "string") {
    if (o.startsWith("?")) return o; // variable
    if (/^[A-Za-z][A-Za-z0-9_-]*:[^\s]+$/.test(o)) return o; // prefixed IRI
    if (/^<[^>\s]+>$/.test(o)) return o; // full IRI
    return encodeStringLiteral(o);
  }
  return encodeStringLiteral(String(o));
}

export function encodeStringLiteral(s: string): string {
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out + '"';
}

export function stringBytes(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

const HASH_RE = /^(sha256:)?[a-f0-9]{64}$/i;
const UI_APP_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const REF_NAME_RE = /^[^\s]+$/;
const POINTER_NAME_RE = /^(?!.*\[object\s+Promise\])[^\s]+$/;
const GRAPH_NAME_RE = /^[^\s]+$/;

export const validate: Moo["validate"] = {
  pointerName({ name }) {
    return typeof name === "string" && name.length > 0 && POINTER_NAME_RE.test(name);
  },
  factStoreName({ name }) {
    return typeof name === "string" && name.length > 0 && REF_NAME_RE.test(name);
  },
  graphName({ graph }) {
    return typeof graph === "string" && graph.length > 0 && GRAPH_NAME_RE.test(graph);
  },
  uiAppId({ id }) {
    return typeof id === "string" && UI_APP_ID_RE.test(id);
  },
  hash({ hash }) {
    return typeof hash === "string" && HASH_RE.test(hash);
  },
  relativePath({ path }) {
    if (typeof path !== "string" || path.length === 0 || path.startsWith("/")) return false;
    return !path.split("/").some((seg) => seg === "..");
  },
};

export const term: Moo["term"] = {
  iri({ uri }) {
    if (/^<[^>\s]+>$/.test(uri)) return new Term(uri);
    if (/^[A-Za-z][A-Za-z0-9_-]*:[^\s]+$/.test(uri)) return new Term(uri);
    return new Term(`<${uri}>`);
  },
  string({ s, lang, type }) {
    let t = encodeStringLiteral(s);
    if (lang) t += `@${lang}`;
    else if (type) t += `^^${type}`;
    return new Term(t);
  },
  int({ n }) {
    return new Term(String(Math.trunc(n)));
  },
  decimal({ n }) {
    const s = String(n);
    return new Term(s.includes(".") ? s : `${s}.0`);
  },
  bool({ b }) {
    return new Term(b ? "true" : "false");
  },
  datetime({ d }) {
    const iso = typeof d === "string" ? d : d.toISOString();
    return new Term(`"${iso}"^^xsd:dateTime`);
  },
};
