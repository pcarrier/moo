import { callCommand } from "./contract";
import type { ApiCommand, ApiCommandReq, ApiCommandResult } from "./contract";
import { optional } from "./utils";
import type {
  GraphSummariesValue,
  MemoryBindings,
  MemoryPatch,
  MemoryPatchGroup,
  MemoryPattern,
  MemoryWrite,
  Predicate,
  TriplesValue,
} from "./types";

type MemoryWriteArgs = { subject: string; predicate: string; object: string; project?: string };
type MemoryPatchArgs = ({ asserts?: MemoryPattern[]; retracts?: MemoryPattern[] } | { groups: MemoryPatchGroup[] }) & { project?: string };

export type MemoryCommands =
  | ApiCommand<"memory-query", { patterns: MemoryPattern[]; project?: string; limit?: number }, { bindings: MemoryBindings[] }>
  | ApiCommand<"graph-summaries", { project?: string | boolean; removed?: "exclude" | "include" | "only" }, GraphSummariesValue>
  | ApiCommand<"graph-rm", { graph: string }, { graph: string; ref?: string; quadsCleared: number; chatId?: string; refsDeleted?: number }>
  | ApiCommand<"triples", { graph?: string; subject?: string; predicate?: string; object?: string; project?: string | boolean; removed?: "exclude" | "include" | "only"; limit?: number }, TriplesValue>
  | ApiCommand<"assert", MemoryWriteArgs, MemoryWrite>
  | ApiCommand<"memory-patch", MemoryPatchArgs, MemoryPatch>
  | ApiCommand<"retract", MemoryWriteArgs, MemoryWrite>
  | ApiCommand<"triple-rm", { graph: string; subject: string; predicate: string; object: string }, MemoryWrite & { graph: string; removed: number }>
  | ApiCommand<"subject-rm", { graph: string; subject: string }, { graph: string; subject: string; removed: number; project: string | null }>
  | ApiCommand<"triple-restore", { graph: string; subject: string; predicate: string; object: string }, MemoryWrite & { graph: string; restored: number }>
  | ApiCommand<"vocabulary", Record<string, never>, { predicates: Predicate[] }>
  | ApiCommand<"vocab-define", { name: string; description?: string; example?: string }, unknown>;

function triples(params: ApiCommandReq<"triples"> = {}): ApiCommandResult<"triples"> {
  return callCommand("triples", params);
}

export const memoryApi = {
  query: (patterns: MemoryPattern[], opts?: { project?: string; limit?: number }) =>
    callCommand("memory-query", {
      patterns,
      ...optional({ project: opts?.project, limit: opts?.limit }),
    }),
  triples,
  assert: (args: MemoryWriteArgs) =>
    callCommand("assert", args),
  patch: (args: MemoryPatchArgs) =>
    callCommand("memory-patch", args),
  retract: (args: MemoryWriteArgs) =>
    callCommand("retract", args),
  vocabulary: () =>
    callCommand("vocabulary", {}),
  defineVerb: (name: string, description?: string, example?: string) =>
    callCommand("vocab-define", { name, ...optional({ description, example }) }),
  graphs: {
    summaries: (opts?: { project?: string | boolean; removed?: "exclude" | "include" | "only" }) =>
      callCommand("graph-summaries", optional({ project: opts?.project, removed: opts?.removed })),
    remove: (graph: string) =>
      callCommand("graph-rm", { graph }),
  },
  subject: {
    remove: (graph: string, subject: string) =>
      callCommand("subject-rm", { graph, subject }),
  },
  triple: {
    remove: (graph: string, subject: string, predicate: string, object: string) =>
      callCommand("triple-rm", { graph, subject, predicate, object }),
    restore: (graph: string, subject: string, predicate: string, object: string) =>
      callCommand("triple-restore", { graph, subject, predicate, object }),
  },
};
