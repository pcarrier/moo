import { Effect, ok } from "../core/effect";
import { moo } from "../moo";
import type { Input } from "./_shared";

export function schemaCommand(input: Input) {
  return schemaStores(input)
    .flatMap((stores) =>
      Effect.forEachPar(stores, (store) =>
        Effect.tryPromise(() => moo.facts.match({ store }), "fact match failed")
          .map((quads) => ({ store, quads })),
      ),
    )
    .map((matches) => ok(summarizeSchema(input, matches)));
}

function schemaStores(input: Input): Effect<string[]> {
  if (input.chatId) {
    return Effect.succeed([`chat/${input.chatId}/facts`]);
  }
  return Effect.tryPromise(() => moo.pointers.list({ prefix: "chat/" }), "chat pointer list failed")
    .map((all) => {
    const ids = new Set<string>();
    for (const name of all) {
      const parts = name.split("/");
      if (parts.length >= 2) ids.add(parts[1]!);
    }
    return [...ids].map((cid) => `chat/${cid}/facts`);
  });
}

function summarizeSchema(input: Input, matches: Array<{ store: string; quads: Array<[string, string, string, string]> }>) {
  const predicates = new Map<string, number>();
  const classes = new Map<string, number>();
  const graphs = new Map<string, number>();
  const predicatesByClass = new Map<string, Map<string, number>>();
  const subjectClass = new Map<string, string>();
  let totalQuads = 0;

  for (const { store, quads } of matches) {
    const all = quads;
    for (const [g, s, p, o] of all) {
      totalQuads++;
      graphs.set(g, (graphs.get(g) || 0) + 1);
      predicates.set(p, (predicates.get(p) || 0) + 1);
      if (p === "rdf:type") {
        classes.set(o, (classes.get(o) || 0) + 1);
        subjectClass.set(`${store}|${g}|${s}`, o);
      }
    }
    // Second pass: bucket predicate usage by subject class.
    for (const [g, s, p] of all) {
      const klass = subjectClass.get(`${store}|${g}|${s}`);
      if (!klass) continue;
      let bucket = predicatesByClass.get(klass);
      if (!bucket) {
        bucket = new Map();
        predicatesByClass.set(klass, bucket);
      }
      bucket.set(p, (bucket.get(p) || 0) + 1);
    }
  }

  const sortByCountDesc = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) =>
        b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
      )
      .map(([name, count]) => ({ name, count }));

  const classDetails = [...predicatesByClass.entries()]
    .sort((a, b) => (classes.get(b[0]) || 0) - (classes.get(a[0]) || 0))
    .map(([klass, preds]) => ({
      class: klass,
      instanceCount: classes.get(klass) || 0,
      predicates: sortByCountDesc(preds),
    }));

  return {
    scope: input.chatId ? `chat:${input.chatId}` : "(all chats)",
    totalQuads,
    graphs: sortByCountDesc(graphs),
    classes: sortByCountDesc(classes),
    predicates: sortByCountDesc(predicates),
    classDetails,
  };
}


