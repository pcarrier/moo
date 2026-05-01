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

export async function allFactRefs(): Promise<string[]> {
  // facts.refs() is backed by both quads and fact_log, so it covers current
  // and historical fact refs across chats, memory, vocab, and project memory.
  // Keep the well-known refs for a deterministic empty-store dump.
  const out = new Set<string>(["memory/facts", "vocab/facts"]);
  for (const ref of await moo.facts.refs()) out.add(ref);
  return [...out].sort();
}
