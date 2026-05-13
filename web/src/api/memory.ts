import type { ApiCommand } from "./contract";
import type {
  GraphSummariesValue,
  MemoryBindings,
  MemoryPattern,
  MemoryWrite,
  Predicate,
  TriplesValue,
  PointersValue,
} from "./types";

type MemoryWriteArgs = { subject: string; predicate: string; object: string; project?: string };

export type MemoryCommands =
  | ApiCommand<"memory-query", { patterns: MemoryPattern[]; project?: string; limit?: number }, { bindings: MemoryBindings[] }>
  | ApiCommand<"graph-summaries", { project?: string | boolean; removed?: "exclude" | "include" | "only" }, GraphSummariesValue>
  | ApiCommand<"graph-rm", { graph: string }, { graph: string; ref?: string; quadsCleared: number; chatId?: string; refsDeleted?: number }>
  | ApiCommand<"triples", { graph?: string; subject?: string; predicate?: string; object?: string; project?: string | boolean; removed?: "exclude" | "include" | "only"; limit?: number }, TriplesValue>
  | ApiCommand<"pointers", { prefix?: string }, PointersValue>
  | ApiCommand<"pointer-rm", { name: string; recursive?: boolean }, { name: string; removed: boolean; removedCount?: number; recursive?: boolean }>
  | ApiCommand<"assert", MemoryWriteArgs, MemoryWrite>
  | ApiCommand<"retract", MemoryWriteArgs, MemoryWrite>
  | ApiCommand<"triple-rm", { graph: string; subject: string; predicate: string; object: string }, MemoryWrite & { graph: string; removed: number }>
  | ApiCommand<"subject-rm", { graph: string; subject: string }, { graph: string; subject: string; removed: number; project: string | null }>
  | ApiCommand<"triple-restore", { graph: string; subject: string; predicate: string; object: string }, MemoryWrite & { graph: string; restored: number }>
  | ApiCommand<"vocabulary", Record<string, never>, { predicates: Predicate[] }>
  | ApiCommand<"vocab-define", { name: string; description?: string; example?: string }, unknown>;
