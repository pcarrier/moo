import { moo } from "../moo";

export type Input = Record<string, any>;

export function parseProjectArg(args: string[]): { project?: string; rest: string[] } {
  if (args[0] === "--project") return { project: args[1] ?? "", rest: args.slice(2) };
  if (args[0]?.startsWith("--project=")) {
    return { project: args[0].slice("--project=".length), rest: args.slice(1) };
  }
  return { rest: args };
}

export function memoryScopeFor(input: Input) {
  return input.project !== undefined ? moo.memory.project(String(input.project)) : moo.memory;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function allFactRefs(): Promise<string[]> {
  // facts.refs() is backed by both quads and fact_log, so it covers current
  // and historical fact refs across chats, memory, vocab, and project memory.
  // Keep the well-known refs for a deterministic empty-store dump. Put memory
  // refs first: the UI caps the all-graphs scan, and chat refs can otherwise
  // fill the cap before global/project memory is ever returned.
  const out = new Set<string>(["memory/facts", "vocab/facts"]);
  for (const ref of await moo.facts.refs()) out.add(ref);
  const rank = (ref: string) => {
    if (ref === "memory/facts") return 0;
    if (ref.startsWith("memory/project/")) return 1;
    if (ref === "vocab/facts") return 2;
    if (ref.startsWith("chat/")) return 4;
    return 3;
  };
  return [...out].sort((a, b) => rank(a) - rank(b) || compareStrings(a, b));
}
