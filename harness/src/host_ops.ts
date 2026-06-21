import { parseJson } from "./core/json";

export type StoredObject = { kind: string; content: string; bytesBase64?: string; size?: number };
export type FsStat = { kind: string; size: number; mtime: number };
export type ProcRunResult = {
  code: number;
  stdout: string;
  stderr: string;
  durationNs: number;
  timedOut: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};
export type HttpFetchResult = { status: number; headers?: string; body: string; bodyTruncated?: boolean };
export type HttpStreamOpenResult = { handle: number; status: number; headers?: string };
export type SparqlResult =
  | { type: "select"; result: Record<string, string>[] }
  | { type: "ask"; result: boolean }
  | { type: "construct"; result: Array<[string, string, string, string]> };

export const now = (): number => __op_now();
export const newId = (prefix: string): string => __op_id(prefix);
export const sha256Base64Url = (input: string): string => __op_sha256_base64url(input);

export const putObject = (kind: string, content: string): string => __op_object_put(kind, content);
export const getObject = (hash: string): StoredObject | null => __op_object_get(hash);
export const getObjects = (hashes: readonly string[]): Record<string, StoredObject> =>
  parseJson(__op_objects_get(JSON.stringify(hashes)), "getObjects");

export const setRef = (name: string, target: string): void => __op_ref_set(name, target);
export const getRef = (name: string): string | null => __op_ref_get(name);
export const compareAndSetRef = (name: string, expected: string | null, next: string): boolean => __op_ref_cas(name, expected, next);
export const listRefs = (prefix: string): string[] => __op_refs_list(prefix);
export const refEntries = (prefix: string): string => __op_refs_entries(prefix);
export const deleteRef = (name: string): boolean => __op_ref_delete(name);

export const addFact = (store: string, graph: string, subject: string, predicate: string, object: string): void =>
  __op_facts_add(store, graph, subject, predicate, object);
export const removeFact = (store: string, graph: string, subject: string, predicate: string, object: string): void =>
  __op_facts_remove(store, graph, subject, predicate, object);
export const factsPresent = (store: string, quadsJson: string): boolean[] => __op_facts_present(store, quadsJson);
export const matchFacts = (
  store: string,
  graph: string | null,
  subject: string | null,
  predicate: string | null,
  object: string | null,
  limit: number | null,
): string[][] => __op_facts_match(store, graph, subject, predicate, object, limit);
export const matchFactsBySubjects = (store: string, graph: string | null, subjects: readonly string[], predicates: readonly string[]): string[][] =>
  __op_facts_match_subjects(store, graph, JSON.stringify(subjects), JSON.stringify(predicates));
export const matchFactPatterns = (store: string, patternsJson: string, graph: string | null, limit: number | null): Record<string, string>[] =>
  __op_facts_match_all(store, patternsJson, graph, limit);
export const factHistory = (
  store: string,
  graph: string | null,
  subject: string | null,
  predicate: string | null,
  object: string | null,
  limit: number | null,
): string[][] => __op_facts_history(store, graph, subject, predicate, object, limit);
export const factStores = (prefix?: string | null): string[] => __op_facts_refs(prefix);
export const graphFactSummaries = (store?: string | null, graph?: string | null): string => __op_facts_graph_summaries(store ?? null, graph ?? null);
export const countFacts = (
  store: string,
  graph: string | null = null,
  subject: string | null = null,
  predicate: string | null = null,
  object: string | null = null,
): number => __op_facts_count(store, graph, subject, predicate, object);
export const chatFactSummaries = (): string => __op_chat_fact_summaries();
export const swapFacts = (store: string, removesJson: string, addsJson: string): void => __op_facts_swap(store, removesJson, addsJson);
export const copyFactSnapshot = (sourceStore: string, targetStore: string, cutoffAt: number, fromGraph: string, toGraph: string): number =>
  __op_facts_snapshot_copy(sourceStore, targetStore, cutoffAt, fromGraph, toGraph);
export const clearFacts = (store: string): number => __op_facts_clear(store);
export const purgeFacts = (store: string): number => __op_facts_purge(store);
export const purgeFactsGraph = (graph: string): number => __op_facts_purge_graph(graph);
export const purgeFactsSubjectPrefix = (store: string, subjectPrefix: string, graph?: string | null): number =>
  __op_facts_purge_subject_prefix(store, subjectPrefix, graph ?? null);

export const sparqlQuery = (query: string, store: string, graph: string | null, limit: number | null): SparqlResult =>
  __op_sparql_query(query, store, graph, limit);

export const readFile = (path: string): string => __op_fs_read(path);
export const writeFile = (path: string, content: string): void => __op_fs_write(path, content);
export const deleteFile = (path: string, recursive = false): void => __op_fs_delete(path, recursive);
export const makeDir = (path: string): void => __op_fs_mkdir(path);
export const listDir = (path: string): string[] => __op_fs_list(path);
export const globFiles = (pattern: string): string[] => __op_fs_glob(pattern);
export const statFile = (path: string): FsStat | null => __op_fs_stat(path);
export const canonicalPath = (path: string): string => __op_fs_canonical(path);

export const runProcess = (
  cmdJson: string,
  cwd: string | null,
  stdin: string | null,
  timeoutMs: number,
  envJson?: string | null,
  maxOutputBytes?: number | null,
): ProcRunResult => __op_proc_run(cmdJson, cwd, stdin, timeoutMs, envJson, maxOutputBytes);

export const fetchHttp = (method: string, url: string, headersJson: string, body: string | null, timeoutMs: number): HttpFetchResult =>
  __op_http_fetch(method, url, headersJson, body, timeoutMs);
export const openHttpStream = (method: string, url: string, headersJson: string, body: string | null, timeoutMs: number): HttpStreamOpenResult =>
  __op_http_stream_open(method, url, headersJson, body, timeoutMs);
export const nextHttpStreamChunk = (handle: number): string | null => __op_http_stream_next(handle);
export const closeHttpStream = (handle: number): void => __op_http_stream_close(handle);

export const streamLlmChat = (optsJson: string): string => __op_llm_stream_chat(optsJson);
export const getEnv = (name: string): string | null => __op_env_get(name);
export const broadcast = (json: string): void => __op_broadcast(json);
export const runningChatIds = (): string => __op_chat_running_ids();
export const runningChatStartedAt = (): string => __op_chat_running_started_at();
export const runAgent = (requestJson: string): Promise<string> => __op_agent_run(requestJson);
export const cancelRunTS = (chatId: string, stepId?: string | null): string => __op_runts_cancel(chatId, stepId ?? null);

type TraceProbeGlobal = {
  readonly __op_trace_insert?: unknown;
  readonly __op_trace_finish?: unknown;
  readonly __op_trace_set_parent?: unknown;
};

export const canTraceSpans = (): boolean => {
  const g = globalThis as TraceProbeGlobal;
  return typeof g.__op_trace_insert === "function" && typeof g.__op_trace_finish === "function" && typeof g.__op_trace_set_parent === "function";
};

export const ensureTraceRoot = (optsJson: string): string => __op_trace_ensure_root(optsJson);
export const ensureTraceSpan = (optsJson: string): string => __op_trace_ensure_span(optsJson);
export const startTraceRoot = (stepId: string | null, dataJson: string): string => __op_trace_start_root(stepId, dataJson);
export const enterTrace = (optsJson: string): string => __op_trace_enter(optsJson);
export const currentTrace = (): string => __op_trace_current();
export const getTrace = (optsJson: string): string | null => __op_trace_get(optsJson);
export const traceEvents = (optsJson: string): string => __op_trace_events(optsJson);
export const recentTraces = (limit: number): string => __op_trace_recent(limit);
export const tracingEnabled = (): boolean => __op_trace_enabled();
export const insertTrace = (optsJson: string): string => __op_trace_insert(optsJson);
export const finishTrace = (id: string, status?: string | null, dataJson?: string | null): string => __op_trace_finish(id, status, dataJson);
export const setTraceParent = (id: string | null): string | null => __op_trace_set_parent(id);
export const leaveTrace = (): void => __op_trace_leave();

export type TracedNativeOp = { globalName: string; traceName: string };

export const TRACED_NATIVE_OPS: readonly TracedNativeOp[] = [
  { globalName: "__op_now", traceName: "now" },
  { globalName: "__op_id", traceName: "newId" },
  { globalName: "__op_sha256_base64url", traceName: "sha256Base64Url" },
  { globalName: "__op_object_put", traceName: "putObject" },
  { globalName: "__op_object_get", traceName: "getObject" },
  { globalName: "__op_objects_get", traceName: "getObjects" },
  { globalName: "__op_ref_set", traceName: "setRef" },
  { globalName: "__op_ref_get", traceName: "getRef" },
  { globalName: "__op_ref_cas", traceName: "compareAndSetRef" },
  { globalName: "__op_refs_list", traceName: "listRefs" },
  { globalName: "__op_refs_entries", traceName: "refEntries" },
  { globalName: "__op_ref_delete", traceName: "deleteRef" },
  { globalName: "__op_facts_add", traceName: "addFact" },
  { globalName: "__op_facts_remove", traceName: "removeFact" },
  { globalName: "__op_facts_present", traceName: "factsPresent" },
  { globalName: "__op_facts_match", traceName: "matchFacts" },
  { globalName: "__op_facts_match_subjects", traceName: "matchFactsBySubjects" },
  { globalName: "__op_facts_match_all", traceName: "matchFactPatterns" },
  { globalName: "__op_facts_history", traceName: "factHistory" },
  { globalName: "__op_facts_refs", traceName: "factStores" },
  { globalName: "__op_facts_graph_summaries", traceName: "graphFactSummaries" },
  { globalName: "__op_facts_count", traceName: "countFacts" },
  { globalName: "__op_chat_fact_summaries", traceName: "chatFactSummaries" },
  { globalName: "__op_facts_swap", traceName: "swapFacts" },
  { globalName: "__op_facts_snapshot_copy", traceName: "copyFactSnapshot" },
  { globalName: "__op_facts_clear", traceName: "clearFacts" },
  { globalName: "__op_facts_purge", traceName: "purgeFacts" },
  { globalName: "__op_facts_purge_graph", traceName: "purgeFactsGraph" },
  { globalName: "__op_facts_purge_subject_prefix", traceName: "purgeFactsSubjectPrefix" },
  { globalName: "__op_sparql_query", traceName: "sparqlQuery" },
  { globalName: "__op_fs_read", traceName: "readFile" },
  { globalName: "__op_fs_write", traceName: "writeFile" },
  { globalName: "__op_fs_mkdir", traceName: "makeDir" },
  { globalName: "__op_fs_list", traceName: "listDir" },
  { globalName: "__op_fs_glob", traceName: "globFiles" },
  { globalName: "__op_fs_stat", traceName: "statFile" },
  { globalName: "__op_fs_canonical", traceName: "canonicalPath" },
  { globalName: "__op_proc_run", traceName: "runProcess" },
  { globalName: "__op_http_fetch", traceName: "fetchHttp" },
  { globalName: "__op_http_stream_open", traceName: "openHttpStream" },
  { globalName: "__op_http_stream_next", traceName: "nextHttpStreamChunk" },
  { globalName: "__op_http_stream_close", traceName: "closeHttpStream" },
  { globalName: "__op_llm_stream_chat", traceName: "streamLlmChat" },
  { globalName: "__op_env_get", traceName: "getEnv" },
  { globalName: "__op_broadcast", traceName: "broadcast" },
  { globalName: "__op_chat_running_ids", traceName: "runningChatIds" },
  { globalName: "__op_chat_running_started_at", traceName: "runningChatStartedAt" },
  { globalName: "__op_agent_run", traceName: "runAgent" },
  { globalName: "__op_runts_cancel", traceName: "cancelRunTS" },
] as const;
