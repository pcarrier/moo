import { Effect, ok } from "../core/effect";
import { moo } from "../moo";
import type { Input } from "./_shared";

export function vocabularyCommand() {
  return Effect.tryPromise(() => moo.vocab.list(), "vocabulary list failed")
    .map((predicates) => ok({ predicates }));
}

export function vocabDefineCommand(input: Input) {
  if (!input.name) {
    return Effect.fail({ message: "vocab-define requires name" });
  }
  const name = String(input.name);
  return Effect.tryPromise(
    () => moo.vocab.define({ name,
      description: input.description || undefined,
      example: input.example || undefined,
      label: input.label || undefined,
    }),
    "vocabulary define failed",
  ).as(ok({ name }));
}

// -- schema introspection -------------------------------------------------
//
// Surveys the RDF graph: predicates with usage counts, classes (rdf:type
// values), distinct graphs, and per-class predicate usage. Filters to a
// single chat when chatId is given, otherwise scans every chat ref.

