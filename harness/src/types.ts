export type Quad = [string, string, string, string]; // [graph, s, p, o]
export type FactHistoryRow = [string, string, string, string, string, string]; // [graph, s, p, o, action, at]
export type Triple = [string, string, string]; // [s, p, o]
export type Bindings = Record<string, string>;
export type SparqlResult = Bindings[] | boolean | Quad[];

// Branded class so memory.assert / memory.query can tell user-constructed
// Turtle terms from raw strings.
export class Term {
  readonly turtle: string;
  constructor(turtle: string) {
    this.turtle = turtle;
  }
  toString(): string {
    return this.turtle;
  }
}

export type ObjectInput = string | number | boolean | Term;

export type UiFieldType =
  | "text"
  | "textarea"
  | "url"
  | "number"
  | "boolean"
  | "select"
  | "secretRef";

export type UiOption = string | { label?: string; value?: string };

export type UiFormField = {
  name: string;
  label?: string;
  type?: UiFieldType;
  required?: boolean;
  default?: string | number | boolean | null;
  options?: UiOption[];
};

export type UiAskSpec = {
  title?: string;
  fields: UiFormField[];
  submitLabel?: string;
};

export type UiChoiceItem = {
  id: string;
  label?: string;
  description?: string;
  input?: unknown;
};

export type UiChooseSpec = {
  title?: string;
  items: UiChoiceItem[];
};


export type McpTransport = "http" | "sse";

export type McpOAuthConfig = {
  clientId?: string;
  clientSecret?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  scope?: string;
  redirectUri?: string;
  resourceMetadataUrl?: string;
  authorizationServerMetadataUrl?: string;
  registrationUrl?: string;
};

export type McpOAuthStartOptions = {
  origin?: string;
  redirectUri?: string;
  scope?: string;
};

export type McpOAuthStart = {
  serverId: string;
  authorizeUrl: string;
  state: string;
  redirectUri: string;
  expiresAt: number;
};

export type McpOAuthStatus = {
  serverId: string;
  authenticated: boolean;
  expiresAt?: number | null;
  scope?: string | null;
};

export type McpServerConfig = {
  id: string;
  title?: string;
  url: string;
  transport?: McpTransport;
  enabled?: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
  oauth?: McpOAuthConfig;
};

export type McpTool = {
  serverId: string;
  /** Alias for serverId in the simple JS-object MCP API. */
  server: string;
  name: string;
  title?: string | null;
  description?: string | null;
  inputSchema?: unknown;
};

export type McpToolFn<TArgs = any, TResult = any> = (args?: TArgs) => Promise<TResult>;
export type McpServerProxy = { [tool: string]: McpToolFn };
export type Mcp = {
  [server: string]: McpServerProxy | any;
  /** List MCP servers configured in the UI. */
  list(): Promise<McpServerConfig[]>;
  /** List tools exposed by all servers or by one configured server. */
  tools(server?: string): Promise<McpTool[]>;
  /** Internal/UI configuration helpers; prefer list()/tools() and server.tool(args) in agent code. */
  listServers(): Promise<McpServerConfig[]>;
  getServer(id: string): Promise<McpServerConfig | null>;
  saveServer(config: McpServerConfig): Promise<McpServerConfig>;
  removeServer(id: string): Promise<boolean>;
  login(serverId: string, opts?: McpOAuthStartOptions): Promise<McpOAuthStart>;
  completeLogin(state: string, code: string): Promise<McpOAuthStatus>;
  logout(serverId: string): Promise<boolean>;
  authStatus(serverId: string): Promise<McpOAuthStatus>;
  listTools(serverId?: string): Promise<McpTool[]>;
  callTool<T = unknown>(serverId: string, name: string, arguments_?: unknown): Promise<T>;
  request<T = unknown>(serverId: string, method: string, params?: unknown): Promise<T>;
};

export type ChatRefs = {
  facts: string;
  head: string;
  run: string;
  graph: string;
  createdAt: string;
  lastAt: string;
  compaction: string;
  usage: string;
  model: string;
  provider: string;
  effort: string;
};

export type StepKind =
  | "agent:UserInput"
  | "agent:Reply"
  | "agent:ShellCommand"
  | "agent:RunJS"
  | "agent:Subagent"
  | "agent:ToolCall"
  | "agent:FileDiff"
  | "agent:MemoryDiff"
  | "agent:Tick"
  | "agent:Final"
  | "agent:Error"
  | "agent:Compaction";

export type StepClass =
  | "agent:Message"
  | "agent:ToolInvocation"
  | "agent:LifecycleMarker"
  | "agent:ErrorEvent";

export type StepStatus = "agent:Queued" | "agent:Running" | "agent:Done" | "agent:Failed" | "agent:Cancelled";

export type AppendStepArgs = {
  kind: StepKind;
  status: StepStatus;
  payloadHash?: string | null;
  extras?: Array<[string, string]>;
  at?: number;
};

export type SubagentSpec = {
  label: string;
  task: string;
  context?: string;
  expectedOutput?: string;
  maxTurns?: number;
  timeoutMs?: number;
  model?: string;
  effort?: string;
  worktree?: "isolated" | "inherit";
};

export type SubagentResult = {
  status: "done" | "failed" | "cancelled" | "timeout" | "wait-input";
  childChatId: string;
  text: string;
  error?: string | null;
  durationMs: number;
  usage?: unknown;
};

export type ProcResult = {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

export type LLMProvider = {
  name: "openai" | "qwen" | "anthropic";
  apiKey: string | null;
  baseUrl: string;
  model: string;
  effort: string | null;
  keyEnvHint: string;
};

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string; stack?: string } };

export type MemoryFact = [string, string, ObjectInput] | { subject: string; predicate: string; object: ObjectInput };

export type MemoryScope = {
  assert(subject: string, predicate: string, object: ObjectInput): Promise<void>;
  assert(facts: MemoryFact[]): Promise<void>;
  assertAll(facts: MemoryFact[]): Promise<void>;
  retract(subject: string, predicate: string, object: ObjectInput): Promise<void>;
  retract(facts: MemoryFact[]): Promise<void>;
  retractAll(facts: MemoryFact[]): Promise<void>;
  query(
    patterns: Array<[string, string, ObjectInput]>,
    opts?: { limit?: number },
  ): Promise<Bindings[]>;
  triples(opts?: {
    subject?: string | null;
    predicate?: string | null;
    object?: ObjectInput | null;
    limit?: number;
  }): Promise<Quad[]>;
};

export type Moo = {
  time: { now(): Promise<number>; nowPlus(ms: number): Promise<number> };
  id: { new: (prefix?: string) => Promise<string> };
  log: (...args: unknown[]) => void;
  objects: {
    put(kind: string, content: unknown): Promise<string>;
    get(hash: string): Promise<{ kind: string; content: string } | null>;
    getJSON<V = unknown>(hash: string): Promise<{ kind: string; value: V } | null>;
  };
  refs: {
    get(name: string): Promise<string | null>;
    set(name: string, target: string): Promise<void>;
    cas(name: string, expected: string | null, next: string): Promise<boolean>;
    list(prefix?: string): Promise<string[]>;
    delete(name: string): Promise<boolean>;
  };
  sparql: {
    query(query: string, opts: { ref: string; graph?: string | null; limit?: number }): Promise<SparqlResult>;
    select(query: string, opts: { ref: string; graph?: string | null; limit?: number }): Promise<Bindings[]>;
    ask(query: string, opts: { ref: string; graph?: string | null; limit?: number }): Promise<boolean>;
    construct(query: string, opts: { ref: string; graph?: string | null; limit?: number }): Promise<Quad[]>;
  };
  facts: {
    add(ref: string, g: string, s: string, p: string, o: string): Promise<void>;
    addAll(ref: string, quads: Array<Quad | { graph: string; subject: string; predicate: string; object: string }>): Promise<void>;
    remove(ref: string, g: string, s: string, p: string, o: string): Promise<void>;
    match(
      ref: string,
      pattern?: {
        graph?: string | null;
        subject?: string | null;
        predicate?: string | null;
        object?: string | null;
        limit?: number;
      },
    ): Promise<Quad[]>;
    history(
      ref: string,
      pattern?: {
        graph?: string | null;
        subject?: string | null;
        predicate?: string | null;
        object?: string | null;
        limit?: number;
      },
    ): Promise<FactHistoryRow[]>;
    matchAll(
      patterns: Triple[],
      opts: { ref: string; graph?: string; limit?: number },
    ): Promise<Bindings[]>;
    refs(prefix?: string | null): Promise<string[]>;
    count(ref: string): Promise<number>;
    swap(ref: string, removes: Quad[], adds: Quad[]): Promise<void>;
    update(
      ref: string,
      fn: (txn: {
        add(g: string, s: string, p: string, o: string): void;
        remove(g: string, s: string, p: string, o: string): void;
      }) => void | Promise<void>,
    ): Promise<void>;
    clear(ref: string): Promise<number>;
    purge(ref: string): Promise<number>;
    purgeGraph(graph: string): Promise<number>;
  };
  fs: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    list(path: string): Promise<string[]>;
    glob(pattern: string): Promise<string[]>;
    stat(path: string): Promise<{ kind: string; size: number; mtime: number } | null>;
    exists(path: string): Promise<boolean>;
    ensureDir(path: string): Promise<void>;
  };
  proc: {
    run(
      cmd: string,
      args?: string[],
      opts?: { cwd?: string | null; stdin?: string | null; timeoutMs?: number },
    ): Promise<ProcResult>;
  };
  http: {
    fetch(opts: {
      method?: string;
      url: string;
      headers?: Record<string, string>;
      body?: unknown;
      timeoutMs?: number;
    }): Promise<{ status: number; body: string }>;
    stream(opts: {
      method?: string;
      url: string;
      headers?: Record<string, string>;
      body?: unknown;
      timeoutMs?: number;
    }): Promise<{
      status: number;
      next(): Promise<string | null>;
      close(): Promise<void>;
    }>;
  };
  events: {
    publish(payload: unknown): void;
  };
  env: {
    get(name: string): Promise<string | null>;
    getMany(names: string[]): Promise<Record<string, string | null>>;
  };
  chat: {
    scratch(chatId: string): Promise<string>;
    touch(chatId: string): Promise<void>;
    list(): Promise<
      Array<{
        chatId: string;
        createdAt: number;
        lastAt: number;
        head: string | null;
        title: string | null;
        path: string | null;
        worktreePath?: string | null;
        archived: boolean;
        archivedAt: number | null;
        hidden?: boolean;
        parentChatId?: string | null;
        status: string;
        totalFacts: number;
        totalTurns: number;
        totalSteps: number;
        usage: {
          models: Record<string, { input: number; cachedInput: number; output: number }>;
        } | null;
        costUsd?: number;
        costEstimated?: boolean;
        unpricedModels?: string[];
      }>
    >;
    create(chatId?: string, path?: string | null): Promise<string>;
    remove(chatId: string): Promise<{ chatId: string; refsDeleted: number; quadsCleared: number }>;
    setTitle(chatId: string, title: string | null): Promise<void>;
    recordSummary(chatId: string, summary: string, title?: string | null): Promise<string>;
    archive(chatId: string): Promise<number>;
    unarchive(chatId: string): Promise<null>;
  };
  ui: {
    ask(chatId: string, spec: UiAskSpec): Promise<string>;
    choose(chatId: string, spec: UiChooseSpec): Promise<string>;
    say(chatId: string, text: string): Promise<string>;
  };
  /**
   * Model Context Protocol servers configured from the UI. The primary API is
   * ordinary property traversal: await moo.mcp.<server>.<tool>(args).
   */
  mcp: Mcp;
  agent: {
    claim(
      ref: string,
      graph: string,
      runId: string | null,
      leaseMs?: number,
    ): Promise<{ stepId: string; leaseId: string; expiresAt: number } | null>;
    complete(ref: string, graph: string, stepId: string, status?: StepStatus): Promise<void>;
    fork(chatId: string, fromStepId?: string | null): Promise<{ chatId: string; runId: string; forkedFrom: string | null }>;
    run(spec: SubagentSpec): Promise<SubagentResult>;
  };
  /**
   * User-wide memory as RDF. The default methods use the global graph
   * `memory:facts` under ref `memory/facts`; call
   * `moo.memory.project(projectId?)` for per-project memory in the same
   * user-wide SQLite store. There are no opaque memory objects — every fact is
   * just a (subject, predicate, object) triple.
   *
   * Object values are encoded into canonical Turtle at write time. Plain
   * strings auto-detect as IRIs (`prefix:local`) or string literals; numbers,
   * booleans, and `Term` instances are written verbatim. Use `moo.term.*`
   * when the auto-detection would mis-classify (e.g. literal text containing
   * a colon).
   */
  memory: MemoryScope & {
    /**
     * Per-project memory. With no argument, the current git root is used,
     * falling back to $PWD; pass a stable project id/path to address another
     * project explicitly.
     */
    project(projectId?: string): MemoryScope;
  };
  /**
   * Term constructors. Each returns a `Term` whose toString() is its
   * canonical Turtle form. Pass these to memory.assert/query when you
   * need to disambiguate a raw string from an IRI / literal.
   */
  term: {
    iri(uri: string): Term;
    string(s: string, opts?: { lang?: string; type?: string }): Term;
    int(n: number): Term;
    decimal(n: number): Term;
    bool(b: boolean): Term;
    datetime(d: Date | string): Term;
  };
  /**
   * Vocabulary registry: predicate metadata + observed-usage stats.
   * Declared predicates live in the `vocab:facts` graph; observed predicates
   * are read out of the memory graph by counting occurrences.
   */
  vocab: {
    define(
      name: string,
      opts?: { description?: string; example?: string; label?: string },
    ): Promise<void>;
    list(): Promise<
      Array<{
        name: string;
        declared: boolean;
        count: number;
        label: string | null;
        description: string | null;
        example: string | null;
      }>
    >;
  };
};
