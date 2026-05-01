import { moo } from "../moo";
import type { Input } from "./_shared";

export async function vocabularyCommand() {
  const predicates = await moo.vocab.list();
  return { ok: true, value: { predicates } };
}

export async function vocabDefineCommand(input: Input) {
  if (!input.name) {
    return { ok: false, error: { message: "vocab-define requires name" } };
  }
  await moo.vocab.define(input.name, {
    description: input.description || undefined,
    example: input.example || undefined,
    label: input.label || undefined,
  });
  return { ok: true, value: { name: input.name } };
}

// -- schema introspection -------------------------------------------------
//
// Surveys the RDF graph: predicates with usage counts, classes (rdf:type
// values), distinct graphs, and per-class predicate usage. Filters to a
// single chat when chatId is given, otherwise scans every chat ref.

