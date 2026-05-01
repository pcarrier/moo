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

export async function allFactStores(): Promise<string[]> {
  // facts.stores() is backed by both quads and fact_log, so it covers current
  // and historical fact stores across chats, memory, vocab, and project memory.
  // Keep the well-known stores for a deterministic empty-store dump. Put memory
  // stores first: the UI caps the all-graphs scan, and chat stores can otherwise
  // fill the cap before global/project memory is ever returned.
  const out = new Set<string>(["memory/facts", "vocab/facts"]);
  for (const store of await moo.facts.stores()) out.add(store);
  const rank = (store: string) => {
    if (store === "memory/facts") return 0;
    if (store.startsWith("memory/project/")) return 1;
    if (store === "vocab/facts") return 2;
    if (store.startsWith("chat/")) return 4;
    return 3;
  };
  return [...out].sort((a, b) => rank(a) - rank(b) || compareStrings(a, b));
}
