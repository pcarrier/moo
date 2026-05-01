export type Quad = [string, string, string, string]; // [graph, s, p, o]
export type FactHistoryRow = [string, string, string, string, string, string]; // [graph, s, p, o, action, at]
export type Triple = [string, string, string]; // [s, p, o]
export type Bindings = Record<string, string>;
export type BindingTerm = { value: string; termType?: "iri" | "literal" | "blank" | "variable"; datatype?: string; language?: string };
export type TermBindings = Record<string, BindingTerm>;
export type SparqlSelectFormat = "string" | "term";
export type SparqlQueryResult<F extends SparqlSelectFormat = "string"> = F extends "term" ? TermBindings[] | boolean | Quad[] : Bindings[] | boolean | Quad[];
export type SparqlResult = SparqlQueryResult;
export type QuadObject = { graph: string; subject: string; predicate: string; object: string };
export type FactMatchFormat = "tuple" | "object";

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

export type UiManifest = {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  entry?: string;
  api?: Array<{ name: string; input?: unknown }>;
};

export type UiBundle = {
  html?: string;
  css?: string;
  js?: string;
  files?: Record<string, string>;
};

export type UiRegisterAppArgs = {
  id?: string;
  manifest: UiManifest;
  bundle: UiBundle;
  handler?: string | null;
};

export type UiRegisterAppResult = {
  uiId: string;
  ui: UiManifest;
  manifestHash: string;
  bundleHash: string;
  handlerHash: string | null;
  refs: { manifest: string; bundle: string; handler?: string };
};

export type UiOpenAppArgs = {
  chatId: string;
  uiId: string;
  instanceId?: string | null;
  state?: unknown;
};

export type UiOpenAppResult = {
  chatId: string;
  uiId: string;
  instanceId: string;
  stateHash: string | null;
  stateRef: string;
  createdState: boolean;
  facts: FactMutationReceipt;
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
  returnChatId?: string;
};

export type McpOAuthStart = {
  serverId: string;
  authorizeUrl: string;
  state: string;
  redirectUri: string;
  expiresAt: number;
  returnChatId?: string;
};

export type McpOAuthStatus = {
  serverId: string;
  authenticated: boolean;
  expiresAt?: number | null;
  scope?: string | null;
  returnChatId?: string;
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
  /** Compact call-shape summary, e.g. `{foo:string,bar?:number}: description`. */
  denseDescription: string;
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
  /** Configuration helpers. Use these only when the user explicitly asks to set up or change MCP servers. */
  listServers(): Promise<McpServerConfig[]>;
  getServer(id: string): Promise<McpServerConfig | null>;
  saveServer(config: McpServerConfig): Promise<McpServerConfig>;
  removeServer(id: string): Promise<boolean>;
  /** Start OAuth for a saved server; share authorizeUrl with the user and let /mcp/oauth/callback complete it. */
  login(serverId: string, opts?: McpOAuthStartOptions): Promise<McpOAuthStart>;
  completeLogin(state: string, code: string): Promise<McpOAuthStatus>;
  logout(serverId: string): Promise<boolean>;
  authStatus(serverId: string): Promise<McpOAuthStatus>;
  listTools(serverId?: string): Promise<McpTool[]>;
  callTool<T = unknown>(serverId: string, name: string, arguments_?: unknown): Promise<T>;
  request<T = unknown>(serverId: string, method: string, params?: unknown, opts?: { skipInitialize?: boolean; omitSession?: boolean; retryingSession?: boolean }): Promise<T>;
};

export type ChatRefs = {
  chatId?: string;
  facts: string;
  factsRef?: string;
  head: string;
  headRef?: string;
  run: string;
  runRef?: string;
  graph: string;
  chatIri?: string;
  stateRefPrefix?: string;
  createdAt: string;
  createdAtRef?: string;
  lastAt: string;
  lastAtRef?: string;
  compaction: string;
  compactionRef?: string;
  usage: string;
  usageRef?: string;
  model: string;
  modelRef?: string;
  provider: string;
  providerRef?: string;
  effort: string;
  effortRef?: string;
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
  output: string;
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
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};

export type LLMProvider = {
  name: "openai" | "qwen" | "anthropic";
  apiKey: string | null;
  baseUrl: string;
  model: string;
  effort: string | null;
  keyEnvHint: string;
  authMode?: "env" | "apiKey" | "oauth";
};

export type { Result } from "./core/result";
export type ApiResult<T> = import("./core/result").Result<T>;

export type MooApiErrorCode =
  | "invalid_argument"
  | "not_found"
  | "path_escape"
  | "process_failed"
  | "timeout"
  | "bad_sparql"
  | "conflict";

export class MooApiError extends Error {
  readonly code: MooApiErrorCode | string;
  readonly details?: unknown;
  constructor(code: MooApiErrorCode | string, message: string, details?: unknown) {
    super(message);
    this.name = "MooApiError";
    this.code = code;
    this.details = details;
  }
}

export type MooTry = <T>(fn: () => T | Promise<T>) => Promise<ApiResult<Awaited<T>>>;

export type MemoryFact = [string, string, ObjectInput] | { subject: string; predicate: string; object: ObjectInput };
export type MemoryPatchGroup = { asserts?: MemoryFact[]; retracts?: MemoryFact[] };

export type FactQuadInput = Quad | { graph: string; subject: string; predicate: string; object: ObjectInput };
export type FactPattern<F extends FactMatchFormat = "tuple"> = {
  ref: string;
  graph?: string | null;
  subject?: string | null;
  predicate?: string | null;
  object?: ObjectInput | null;
  limit?: number;
  format?: F;
};
export type FactAddArgs = { ref: string; graph: string; subject: string; predicate: string; object: ObjectInput };
export type FactAddAllArgs = { ref: string; quads: FactQuadInput[] };
export type FactRemoveArgs = { ref: string; graph: string; subject: string; predicate: string; object: ObjectInput };
export type FactMatchAllArgs = { patterns: Triple[]; ref: string; graph?: string; limit?: number };
export type FactSwapArgs = { ref: string; removes: FactQuadInput[]; adds: FactQuadInput[] };
export type FactUpdateArgs = {
  ref: string;
  fn: (txn: {
    add(args: { graph: string; subject: string; predicate: string; object: ObjectInput }): void;
    remove(args: { graph: string; subject: string; predicate: string; object: ObjectInput }): void;
  }) => void | Promise<void>;
};

export type FactMutationReceipt = { ref: string; added: number; removed: number };
export type FactClearReceipt = { ref?: string; graph?: string; removed: number; dryRun?: boolean };
export type FactClearRefArgs = { ref: string; dryRun?: boolean };
export type FactDeleteRefArgs = { ref: string; dryRun?: boolean };
export type FactDeleteGraphArgs = { ref: string; graph: string; dryRun?: boolean };
export type FactDeleteGraphEverywhereArgs = { graph: string; dryRun?: boolean };
export type RefSetReceipt = { name: string; target: string; previous: string | null; changed: boolean };
export type ChatTitleReceipt = { chatId: string; previousTitle: string | null; title: string | null; changed: boolean };
export type ChatSummaryReceipt = { chatId: string; entryId: string; title?: string | null };
export type UiSayReceipt = { chatId: string; stepId: string; payloadHash: string };
export type ValidateApi = {
  refName(name: string): boolean;
  graphName(graph: string): boolean;
  uiAppId(id: string): boolean;
  hash(hash: string): boolean;
  relativePath(path: string): boolean;
};


export type FsPatchArgs = {
  patch: string;
  cwd?: string | null;
  strip?: number | null;
  dryRun?: boolean;
};

export type FsPatchFileResult = {
  path: string;
  beforeExists: boolean;
  afterExists: boolean;
  added: number;
  removed: number;
  hunks: number;
};

export type FsPatchReceipt = {
  dryRun: boolean;
  files: FsPatchFileResult[];
};

export type ProcRunArgs = {
  cmd: string;
  args?: string[];
  cwd?: string | null;
  stdin?: string | null;
  timeoutMs?: number;
  env?: Record<string, string | null | undefined>;
  check?: boolean;
  maxOutputBytes?: number | null;
};

export type WorkspaceScope = {
  root: string;
  fs: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    list(path?: string): Promise<string[]>;
    glob(pattern: string): Promise<string[]>;
    stat(path?: string): Promise<{ kind: string; size: number; mtime: number } | null>;
    canonical(path?: string): Promise<string>;
    exists(path?: string): Promise<boolean>;
    ensureDir(path?: string): Promise<void>;
    patch(args: string | Omit<FsPatchArgs, "cwd">): Promise<FsPatchReceipt>;
  };
  proc: {
    run(args: Omit<ProcRunArgs, "cwd"> & { cwd?: string | null }): Promise<ProcResult>;
    runChecked(args: Omit<ProcRunArgs, "cwd" | "check"> & { cwd?: string | null }): Promise<ProcResult>;
  };
};

export type MemoryScope = {
  assert(args: { subject: string; predicate: string; object: ObjectInput } | { facts: MemoryFact[] }): Promise<void>;
  retract(args: { subject: string; predicate: string; object: ObjectInput } | { facts: MemoryFact[] }): Promise<void>;
  patch(args: MemoryPatchGroup | { groups: MemoryPatchGroup[] }): Promise<void>;
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
  try: MooTry;
  time: { nowMs(): Promise<number>; nowISO(): Promise<string>; datetime(d?: Date | string | number): Promise<Term>; nowPlus(ms: number): Promise<number> };
  validate: ValidateApi;
  id: { new: (prefix?: string) => Promise<string> };
  log: (...args: unknown[]) => void;
  objects: {
    putText(args: { kind: string; text: string }): Promise<string>;
    putJSON(args: { kind: string; value: unknown }): Promise<string>;
    getText(args: { hash: string }): Promise<{ kind: string; text: string } | null>;
    getJSON<V = unknown>(args: { hash: string }): Promise<{ kind: string; value: V } | null>;
  };
  refs: {
    get(name: string): Promise<string | null>;
    set(name: string, target: string): Promise<RefSetReceipt>;
    cas(name: string, expected: string | null, next: string): Promise<boolean>;
    list(prefix?: string): Promise<string[]>;
    entries(prefix?: string): Promise<Array<[string, string]>>;
    delete(name: string): Promise<boolean>;
  };
  sparql: {
    query<F extends SparqlSelectFormat = "string">(args: { query: string; ref: string; graph?: string | null; limit?: number; format?: F }): Promise<SparqlQueryResult<F>>;
    select<F extends SparqlSelectFormat = "string">(args: { query: string; ref: string; graph?: string | null; limit?: number; format?: F }): Promise<F extends "term" ? TermBindings[] : Bindings[]>;
    ask(args: { query: string; ref: string; graph?: string | null; limit?: number }): Promise<boolean>;
    construct(args: { query: string; ref: string; graph?: string | null; limit?: number }): Promise<Quad[]>;
  };
  facts: {
    add(args: FactAddArgs): Promise<FactMutationReceipt>;
    addAll(args: FactAddAllArgs): Promise<FactMutationReceipt>;
    remove(args: FactRemoveArgs): Promise<FactMutationReceipt>;
    match<F extends FactMatchFormat = "tuple">(args: FactPattern<F>): Promise<F extends "object" ? QuadObject[] : Quad[]>;
    history(args: FactPattern): Promise<FactHistoryRow[]>;
    matchAll(args: FactMatchAllArgs): Promise<Bindings[]>;
    refs(args?: { prefix?: string | null }): Promise<string[]>;
    count(args: { ref: string }): Promise<number>;
    swap(args: FactSwapArgs): Promise<FactMutationReceipt>;
    update(args: FactUpdateArgs): Promise<FactMutationReceipt>;
    clearRef(args: FactClearRefArgs): Promise<FactClearReceipt>;
    deleteRef(args: FactDeleteRefArgs): Promise<FactClearReceipt>;
    deleteGraph(args: FactDeleteGraphArgs): Promise<FactClearReceipt>;
    deleteGraphEverywhere(args: FactDeleteGraphEverywhereArgs): Promise<FactClearReceipt>;
  };
  fs: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    list(path: string): Promise<string[]>;
    glob(pattern: string): Promise<string[]>;
    stat(path: string): Promise<{ kind: string; size: number; mtime: number } | null>;
    canonical(path: string): Promise<string>;
    exists(path: string): Promise<boolean>;
    ensureDir(path: string): Promise<void>;
    patch(args: string | FsPatchArgs): Promise<FsPatchReceipt>;
  };
  proc: {
    run(args: ProcRunArgs): Promise<ProcResult>;
    runChecked(args: Omit<ProcRunArgs, "check">): Promise<ProcResult>;
  };
  workspace: {
    current(args?: { chatId?: string | null; root?: string | null }): Promise<WorkspaceScope>;
  };
  http: {
    fetch(opts: {
      method?: string;
      url: string;
      headers?: Record<string, string>;
      body?: unknown;
      timeoutMs?: number;
    }): Promise<{ status: number; body: string; headers: Record<string, string | string[]> }>;
    stream(opts: {
      method?: string;
      url: string;
      headers?: Record<string, string>;
      body?: unknown;
      timeoutMs?: number;
    }): Promise<{
      status: number;
      headers: Record<string, string | string[]>;
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
    refs(args: { chatId: string }): ChatRefs;
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
          models: Record<string, { input: number; cachedInput: number; cacheWriteInput?: number; output: number }>;
        } | null;
        costUsd?: number;
        costEstimated?: boolean;
        unpricedModels?: string[];
        childUsageIncluded?: number;
      }>
    >;
    create(chatId?: string, path?: string | null): Promise<string>;
    remove(chatId: string): Promise<{ chatId: string; refsDeleted: number; quadsCleared: number }>;
    setTitle(args: { chatId: string; title: string | null }): Promise<ChatTitleReceipt>;
    recordSummary(args: { chatId: string; summary: string; title?: string | null }): Promise<ChatSummaryReceipt>;
    archive(chatId: string): Promise<number>;
    unarchive(chatId: string): Promise<null>;
  };
  ui: {
    ask(args: { chatId: string; spec: UiAskSpec }): Promise<string>;
    choose(args: { chatId: string; spec: UiChooseSpec }): Promise<string>;
    say(args: { chatId: string; text: string }): Promise<UiSayReceipt>;
    apps: {
      register(args: UiRegisterAppArgs): Promise<UiRegisterAppResult>;
      open(args: UiOpenAppArgs): Promise<UiOpenAppResult>;
    };
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
