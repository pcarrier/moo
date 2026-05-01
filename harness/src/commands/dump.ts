import { moo } from "../moo";
import { allFactRefs, type Input } from "./_shared";

export type DumpQuad = [string, string, string, string];

export type DumpPattern = {
  graph?: string | null;
  subject?: string | null;
  predicate?: string | null;
  object?: string | null;
};

export async function dumpCommand(input: Input) {
  const chatId = cleanOptionalString(input.chatId);
  const ref = cleanOptionalString(input.ref) ?? (chatId ? "chat/" + chatId + "/facts" : null);
  const pattern: DumpPattern = {
    graph: cleanOptionalString(input.graph),
    subject: cleanOptionalString(input.subject),
    predicate: cleanOptionalString(input.predicate),
    object: cleanOptionalString(input.object),
  };

  const refs = ref ? [ref] : await allFactRefs();
  const rows: DumpQuad[] = [];
  for (const r of refs) {
    rows.push(...((await moo.facts.match(r, pattern)) as DumpQuad[]));
  }

  const text = formatTriG(rows);
  return {
    ok: true,
    value: {
      format: "trig",
      text,
      quads: rows.length,
      refs: refs.length,
      ...(chatId ? { chatId } : {}),
      ...(ref ? { ref } : {}),
    },
  };
}

export function cleanOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str ? str : null;
}

const STANDARD_TURTLE_PREFIXES: Record<string, string> = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
};

export function formatTriG(rows: DumpQuad[]): string {
  const prefixes = collectDumpPrefixes(rows);
  prefixes.add("rdf");

  let out = "";
  for (const prefix of [...prefixes].sort()) {
    out += "@prefix " + prefix + ": <" + dumpPrefixIri(prefix) + "> .\n";
  }
  out += "\n";

  const byGraph = new Map<string, Map<string, Array<[string, string]>>>();
  for (const [graph, subject, predicate, object] of rows) {
    let bySubject = byGraph.get(graph);
    if (!bySubject) byGraph.set(graph, (bySubject = new Map()));
    let props = bySubject.get(subject);
    if (!props) bySubject.set(subject, (props = []));
    props.push([predicate, object]);
  }

  for (const graph of [...byGraph.keys()].sort()) {
    out += formatDumpResource(graph) + " {\n";
    const bySubject = byGraph.get(graph)!;
    for (const subject of [...bySubject.keys()].sort()) {
      const props = bySubject.get(subject)!;
      props.sort((a, b) => comparePair(a, b));
      out += "    " + formatDumpResource(subject);
      for (let i = 0; i < props.length; i++) {
        const [predicate, object] = props[i];
        const predTerm = predicate === "rdf:type" ? "a" : formatDumpPredicate(predicate);
        const objTerm = formatDumpObject(object);
        const sep = i + 1 < props.length ? " ;" : " .";
        out += "\n        " + predTerm + " " + objTerm + sep;
      }
      out += "\n";
    }
    out += "}\n\n";
  }

  return out;
}

export function comparePair(a: [string, string], b: [string, string]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

export function collectDumpPrefixes(rows: DumpQuad[]): Set<string> {
  const prefixes = new Set<string>();
  for (const [graph, subject, predicate, object] of rows) {
    addResourcePrefix(prefixes, graph);
    addResourcePrefix(prefixes, subject);
    addResourcePrefix(prefixes, predicate);
    addObjectPrefix(prefixes, object);
  }
  return prefixes;
}

export function addResourcePrefix(prefixes: Set<string>, value: string) {
  const prefix = turtlePrefixedNamePrefix(value);
  if (prefix) prefixes.add(prefix);
}

export function addObjectPrefix(prefixes: Set<string>, value: string) {
  const datatype = turtleLiteralDatatype(value);
  if (datatype) addResourcePrefix(prefixes, datatype);
  if (isDumpObjectBare(value)) addResourcePrefix(prefixes, value);
}

export function dumpPrefixIri(prefix: string): string {
  return STANDARD_TURTLE_PREFIXES[prefix] ?? "urn:moo:" + prefix + ":";
}

export function formatDumpResource(value: string): string {
  if (isFullIri(value) || isBlankNode(value) || turtlePrefixedNamePrefix(value)) return value;
  return "<urn:moo:term:" + encodeURIComponent(value) + ">";
}

export function formatDumpPredicate(value: string): string {
  if (isFullIri(value) || turtlePrefixedNamePrefix(value)) return value;
  return "<urn:moo:term:" + encodeURIComponent(value) + ">";
}

export function formatDumpObject(value: string): string {
  if (isDumpObjectBare(value)) return value;
  return encodeDumpString(value);
}

export function isDumpObjectBare(value: string): boolean {
  return (
    isFullIri(value) ||
    isBlankNode(value) ||
    turtlePrefixedNamePrefix(value) != null ||
    isTurtleLiteral(value) ||
    isNumericLiteral(value) ||
    value === "true" ||
    value === "false"
  );
}

export function isFullIri(value: string): boolean {
  return /^<[^<>"{}|^\x60\\\s]+>$/.test(value);
}

export function isBlankNode(value: string): boolean {
  return /^_:[A-Za-z][A-Za-z0-9_-]*$/.test(value);
}

export function turtlePrefixedNamePrefix(value: string): string | null {
  const match = /^([A-Za-z][A-Za-z0-9_-]*):([A-Za-z0-9_][A-Za-z0-9._~%+-]*)$/.exec(value);
  return match ? match[1] : null;
}

export function isTurtleLiteral(value: string): boolean {
  return turtleLiteralDatatype(value) != null || /^"(?:[^"\\\r\n]|\\["\\nrtbf]|\\u[0-9A-Fa-f]{4}|\\U[0-9A-Fa-f]{8})*"(?:@[A-Za-z]+(?:-[A-Za-z0-9]+)*)?$/.test(value);
}

export function turtleLiteralDatatype(value: string): string | null {
  const match = /^"(?:[^"\\\r\n]|\\["\\nrtbf]|\\u[0-9A-Fa-f]{4}|\\U[0-9A-Fa-f]{8})*"\^\^(<[^<>"{}|^\x60\\\s]+>|[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9_][A-Za-z0-9._~%+-]*)$/.exec(value);
  return match ? match[1] : null;
}

export function isNumericLiteral(value: string): boolean {
  return /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(value);
}

export function encodeDumpString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += "\\u" + code.toString(16).toUpperCase().padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

