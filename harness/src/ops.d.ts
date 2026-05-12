declare global {
  function __op_now(): number;
  function __op_id(prefix: string): string;
  function __op_sha256_base64url(input: string): string;
  function __op_object_put(kind: string, content: string): string;
  function __op_object_get(hash: string): { kind: string; content: string; bytesBase64?: string; size?: number } | null;
  function __op_ref_set(name: string, target: string): void;
  function __op_ref_get(name: string): string | null;
  function __op_ref_cas(name: string, expected: string | null, next: string): boolean;
  function __op_refs_list(prefix: string): string[];
  function __op_refs_entries(prefix: string): string;
  function __op_ref_delete(name: string): boolean;
  function __op_facts_add(
    store: string,
    graph: string,
    s: string,
    p: string,
    o: string,
  ): void;
  function __op_facts_remove(
    store: string,
    graph: string,
    s: string,
    p: string,
    o: string,
  ): void;
  function __op_facts_present(store: string, quadsJson: string): boolean[];
  function __op_facts_match(
    store: string,
    graph: string | null,
    subject: string | null,
    predicate: string | null,
    object: string | null,
    limit: number | null,
  ): string[][];
  function __op_facts_match_all(
    store: string,
    patternsJson: string,
    graph: string | null,
    limit: number | null,
  ): Record<string, string>[];
  function __op_facts_history(
    store: string,
    graph: string | null,
    subject: string | null,
    predicate: string | null,
    object: string | null,
    limit: number | null,
  ): string[][];
  function __op_facts_refs(prefix?: string | null): string[];
  function __op_facts_graph_summaries(store?: string | null, graph?: string | null): string;
  function __op_facts_count(store: string, graph?: string | null, subject?: string | null, predicate?: string | null, object?: string | null): number;
  function __op_chat_fact_summaries(): string;
  function __op_facts_swap(store: string, removesJson: string, addsJson: string): void;
  function __op_facts_snapshot_copy(
    sourceStore: string,
    targetStore: string,
    cutoffAt: number,
    fromGraph: string,
    toGraph: string,
  ): number;
  function __op_facts_clear(store: string): number;
  function __op_facts_purge(store: string): number;
  function __op_facts_purge_graph(graph: string): number;
  function __op_facts_purge_subject_prefix(store: string, subjectPrefix: string, graph?: string | null): number;
  function __op_sparql_query(
    query: string,
    store: string,
    graph: string | null,
    limit: number | null,
  ):
    | { type: "select"; result: Record<string, string>[] }
    | { type: "ask"; result: boolean }
    | { type: "construct"; result: Array<[string, string, string, string]> };
  function __op_fs_read(path: string): string;
  function __op_fs_write(path: string, content: string): void;
  function __op_fs_delete(path: string): void;
  function __op_fs_mkdir(path: string): void;
  function __op_fs_list(path: string): string[];
  function __op_fs_glob(pattern: string): string[];
  function __op_fs_stat(path: string): { kind: string; size: number; mtime: number } | null;
  function __op_fs_canonical(path: string): string;
  function __op_proc_run(
    cmd: string,
    argsJson: string,
    cwd: string | null,
    stdin: string | null,
    timeoutMs: number,
    envJson?: string | null,
    maxOutputBytes?: number | null,
  ): {
    code: number;
    stdout: string;
    stderr: string;
    durationNs: number;
    timedOut: boolean;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
  };
  function __op_http_fetch(
    method: string,
    url: string,
    headersJson: string,
    body: string | null,
    timeoutMs: number,
  ): { status: number; headers?: string; body: string };
  function __op_http_stream_open(
    method: string,
    url: string,
    headersJson: string,
    body: string | null,
    timeoutMs: number,
  ): { handle: number; status: number; headers?: string };
  function __op_http_stream_next(handle: number): string | null;
  function __op_http_stream_close(handle: number): void;
  function __op_llm_stream_chat(optsJson: string): string;
  function __op_env_get(name: string): string | null;
  function __op_broadcast(json: string): void;
  function __op_chat_running_ids(): string;
  function __op_chat_running_started_at(): string;
  function __op_agent_run(requestJson: string): Promise<string>;
  function __op_trace_ensure_root(optsJson: string): void;
  function __op_trace_ensure_span(optsJson: string): void;
  function __op_trace_start_root(stepId: string | null, dataJson: string): string;
  function __op_trace_enter(optsJson: string): string;
  function __op_trace_current(): string | null;
  function __op_trace_get(optsJson: string): string | null;
  function __op_trace_events(optsJson: string): string;
  function __op_trace_recent(limit: number): string;
  function __op_trace_enabled(): boolean;
  function __op_trace_insert(optsJson: string): string | null;
  function __op_trace_finish(id: string, status?: string | null, dataJson?: string | null): boolean;
  function __op_trace_set_parent(id: string | null): string | null;
  function __op_trace_leave(): void;

  // Set by index.ts so command handlers can call back into agent code without
  // a circular module-import problem.
  var main: (input: any) => Promise<any>;
  var moo: import("./types").Moo;
}

export {};
