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
    ref: string,
    graph: string,
    s: string,
    p: string,
    o: string,
  ): void;
  function __op_facts_remove(
    ref: string,
    graph: string,
    s: string,
    p: string,
    o: string,
  ): void;
  function __op_facts_present(ref: string, quadsJson: string): boolean[];
  function __op_facts_match(
    ref: string,
    graph: string | null,
    subject: string | null,
    predicate: string | null,
    object: string | null,
    limit: number | null,
  ): string[][];
  function __op_facts_match_all(
    ref: string,
    patternsJson: string,
    graph: string | null,
    limit: number | null,
  ): Record<string, string>[];
  function __op_facts_history(
    ref: string,
    graph: string | null,
    subject: string | null,
    predicate: string | null,
    object: string | null,
    limit: number | null,
  ): string[][];
  function __op_facts_refs(prefix?: string | null): string[];
  function __op_facts_count(ref: string): number;
  function __op_chat_fact_summaries(): string;
  function __op_facts_swap(ref: string, removesJson: string, addsJson: string): void;
  function __op_facts_clear(ref: string): number;
  function __op_facts_purge(ref: string): number;
  function __op_facts_purge_graph(graph: string): number;
  function __op_sparql_query(
    query: string,
    ref: string,
    graph: string | null,
    limit: number | null,
  ):
    | { type: "select"; result: Record<string, string>[] }
    | { type: "ask"; result: boolean }
    | { type: "construct"; result: Array<[string, string, string, string]> };
  function __op_fs_read(path: string): string;
  function __op_fs_write(path: string, content: string): void;
  function __op_fs_remove(path: string): void;
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
    durationMs: number;
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

  // Set by index.ts so command handlers can call back into agent code without
  // a circular module-import problem.
  var main: (input: any) => Promise<any>;
  var moo: import("./types").Moo;
}

export {};
