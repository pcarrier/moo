import type { UiAppBundle, UiAppManifest } from "../../shared/src/ui";
import type { ProviderName } from "./llm_models";
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

export type UiManifest = UiAppManifest;

export type UiBundle = UiAppBundle;

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
  stateTarget: string | null;
  stateRef: string;
  createdState: boolean;
  facts: FactMutationReceipt;
};


export type SkillFrontmatterValue = string | number | boolean | null | Array<string | number | boolean | null>;
export type SkillFrontmatter = Record<string, SkillFrontmatterValue>;

export type SkillSource =
  | { kind: "builtin" }
  | { kind: "repo"; path: string; root?: string }
  | { kind: "user"; url?: string };

export type SkillMeta = {
  version?: number;
  id: string;
  name: string;
  enabled: boolean;
  url?: string;
  builtin?: boolean;
  repo?: boolean;
  source?: SkillSource;
  frontmatter: SkillFrontmatter;
  frontmatterRaw?: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  lastRefreshError?: string;
};

export type SkillSummary = SkillMeta;

export type Skill = SkillMeta & { content: string };

export type SkillListArgs = { enabled?: boolean; root?: string | null };
export type SkillQueryOptions = { root?: string | null };

export type SkillSaveInput = {
  id?: string;
  name?: string;
  enabled?: boolean;
  url?: string;
  frontmatter?: SkillFrontmatter;
  content?: string;
};

export type SkillRefreshResult = {
  ok: boolean;
  refreshed: boolean;
  skill: Skill | null;
  error?: string;
};

export type BuiltinSkill = {
  id: string;
  name?: string;
  enabled?: boolean;
  content: string;
};

export type MooSkillsApi = {
  list(args?: SkillListArgs): Promise<SkillSummary[]>;
  get(idOrName: string, opts?: SkillQueryOptions): Promise<SkillSummary | null>;
  load(idOrName: string, opts?: SkillQueryOptions): Promise<Skill | null>;
  content(idOrName: string, opts?: SkillQueryOptions): Promise<string | null>;
  save(input: SkillSaveInput): Promise<Skill>;
  upsert(input: SkillSaveInput): Promise<Skill>;
  delete(idOrName: string): Promise<boolean>;
  remove(idOrName: string): Promise<boolean>;
  refresh(idOrName: string, opts?: { timeoutMs?: number; root?: string | null }): Promise<SkillRefreshResult>;
  parseMarkdown(content: string): { frontmatterRaw: string; frontmatter: SkillFrontmatter; body: string };
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
  startBranch: string;
  startBranchRef?: string;
};

export type StepKind =
  | "agent:UserInput"
  | "agent:Reply"
  | "agent:ShellCommand"
  | "agent:RunTS"
  | "agent:Subagent"
  | "agent:ToolCall"
  | "agent:FileDiff"
  | "agent:MemoryDiff"
  | "agent:TodoDiff"
  | "agent:BlobAdd"
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
  stepId?: string | null;
  at?: number;
};

export type SubagentSpec = {
  label: string;
  task: string;
  context?: string;
  expectedOutput?: string;
  maxSteps?: number;
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
  durationNs: number;
  usage?: unknown;
};

export type ProcResult = {
  code: number;
  stdout: string;
  stderr: string;
  durationNs: number;
  timedOut: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};

export type LLMProvider = {
  name: ProviderName;
  apiKey: string | null;
  baseUrl: string;
  model: string;
  effort: string | null;
  serviceTier?: string | null;
  keyEnvHint: string;
  authMode?: "env" | "apiKey" | "oauth";
  oauthAccountId?: string | null;
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

export type MooTry = <T>(args: { fn: () => T | Promise<T> }) => Promise<ApiResult<Awaited<T>>>;

export type TraceStatus = "running" | "ok" | "error" | "cancelled" | "timeout";
export type TraceKind = "trace" | "span" | "mark" | string;
export type TraceRow = {
  id: string;
  traceId: string;
  rootId?: string | null;
  rootKind?: string | null;
  rootName?: string | null;
  parentId?: string | null;
  seq: number;
  stepId: string | null;
  kind: TraceKind;
  name: string;
  t0Ns: number;
  t1Ns: number | null;
  status: TraceStatus | string;
  inputHash?: string | null;
  outputHash?: string | null;
  errorHash?: string | null;
  dataHash?: string | null;
  data: Record<string, unknown>;
};
export type TraceCurrent = { traceId?: string | null; id: string; rootId?: string | null; stepId?: string | null; parentId: string };
export type TraceTreeNode = TraceRow & { children: TraceTreeNode[] };
export type TraceChat = { id: string; title: string | null };
export type TraceErrorCategory =
  | "runts_compile"
  | "patch_mismatch"
  | "missing_file"
  | "missing_tool"
  | "proc_nonzero"
  | "undefined_variable"
  | "no_change"
  | "timeout"
  | "api_error"
  | "unknown";
export type TraceErrorInfo = { message: string; category: TraceErrorCategory; row: TraceRow };
export type TraceRecentArgs = {
  limit?: number;
  includeChat?: boolean;
  chatId?: string;
  status?: TraceStatus | string;
  kind?: TraceKind;
  name?: string;
  text?: string;
  hasError?: boolean;
};
export type TraceSearchArgs = TraceRecentArgs & { includeEvents?: boolean };
export type TraceFailedArgs = Omit<TraceSearchArgs, "hasError" | "status">;
export type TraceSearchRow = TraceRow & {
  chat?: TraceChat;
  events?: TraceRow[];
  errorSummary?: string;
  category?: TraceErrorCategory;
};
export type TraceSummary = {
  traceId: string;
  status: string;
  root: TraceRow | null;
  chat?: TraceChat;
  durationNs?: number;
  error?: TraceErrorInfo;
  errors: TraceErrorInfo[];
  events?: TraceRow[];
  counts?: { total: number; byKind: Array<{ name: string; count: number }>; byStatus: Array<{ name: string; count: number }>; byName: Array<{ name: string; count: number }> };
  slowestSpans?: Array<{ row: TraceRow; durationNs: number }>;
  criticalPath?: Array<{ row: TraceRow; durationNs: number | null }>;
  waterfall?: Array<Record<string, unknown>>;
  sideEffects?: TraceRow[];
  causalLinks?: Array<Record<string, unknown>>;
};
export type TraceDiagnosisGroup = { category: TraceErrorCategory | string; count: number; examples?: TraceSearchRow[] };
export type TraceDiagnosis = { total?: number; groups?: TraceDiagnosisGroup[]; recentFailures?: TraceSummary[]; slowRecent?: TraceSummary[]; slowestSpans?: Array<Record<string, unknown>>; sideEffects?: Array<Record<string, unknown>>; failureGroups?: TraceDiagnosisGroup[] };
export type TraceDiagnostic = TraceDiagnosis;
export type TraceSpanOptions = { input?: unknown; data?: Record<string, unknown> } | Record<string, unknown>;
export type TodoStatus = "todo" | "doing" | "done" | "blocked" | "dropped";
export type TodoIdInput = string | number;
export type AgentTodo = { id: string; text: string; status: TodoStatus; note?: string; createdAt: string; updatedAt: string };
export type AgentTodoState = { version: 1; updatedAt: string; nextId: number; items: AgentTodo[] };
export type TodoAddInput = { text: string; status?: TodoStatus; note?: string };
export type TodoUpdateInput = { id: TodoIdInput; text?: string; status?: TodoStatus; note?: string | null };
export type AgentTodoPatch = { id?: TodoIdInput; text?: string; status?: TodoStatus; note?: string | null };
export type TodoPatch = { items?: AgentTodoPatch[]; add?: TodoAddInput[]; update?: TodoUpdateInput[]; clearDone?: boolean; clearStatuses?: TodoStatus[] };

export type MooTracesApi = {
  current(args?: {}): Promise<TraceCurrent | null>;
  get(args?: { traceId?: string; stepId?: string }): Promise<TraceRow | null>;
  events(args?: { traceId?: string; stepId?: string; limit?: number }): Promise<TraceRow[]>;
  tree(args?: { traceId?: string; stepId?: string; limit?: number }): Promise<TraceTreeNode | null>;
  recent(args?: TraceRecentArgs): Promise<TraceSearchRow[]>;
  search(args?: TraceSearchArgs): Promise<TraceSearchRow[]>;
  failed(args: TraceFailedArgs & { includeEvents: true }): Promise<TraceSummary[]>;
  failed(args?: TraceFailedArgs): Promise<TraceSearchRow[]>;
  summary(args?: { traceId?: string; stepId?: string; includeEvents?: boolean }): Promise<TraceSummary | null>;
  diagnose(args?: TraceFailedArgs & { examplesPerGroup?: number }): Promise<TraceDiagnosis>;
  errorOf(args: { row: TraceRow }): string | null;
  errors(args?: { traceId?: string; stepId?: string; limit?: number }): Promise<TraceErrorInfo[]>;
  mark(args: { message: string; data?: Record<string, unknown> }): Promise<string | null>;
  span<T>(args: { name: string; data?: TraceSpanOptions; fn: () => T | Promise<T> }): Promise<Awaited<T>>;
};

export type MemoryFact = [string, string, ObjectInput] | { subject: string; predicate: string; object: ObjectInput };

export type FactQuadInput = Quad | { graph: string; subject: string; predicate: string; object: ObjectInput };
export type FactStoreArg = { store: string };
export type FactPattern<F extends FactMatchFormat = "tuple"> = FactStoreArg & {
  graph?: string | null;
  subject?: string | null;
  predicate?: string | null;
  object?: ObjectInput | null;
  limit?: number;
  format?: F;
};
export type FactAddArgs = FactStoreArg & { graph: string; subject: string; predicate: string; object: ObjectInput };
export type FactAddAllArgs = FactStoreArg & { quads: FactQuadInput[] };
export type FactRemoveArgs = FactStoreArg & { graph: string; subject: string; predicate: string; object: ObjectInput };
export type FactMatchAllArgs = FactStoreArg & { patterns: Triple[]; graph?: string; limit?: number };
export type FactSwapArgs = FactStoreArg & { removes: FactQuadInput[]; adds: FactQuadInput[] };
export type FactUpdateArgs = FactStoreArg & {
  fn: (txn: {
    add(args: { graph: string; subject: string; predicate: string; object: ObjectInput }): void;
    remove(args: { graph: string; subject: string; predicate: string; object: ObjectInput }): void;
  }) => void | Promise<void>;
};

export type FactMutationReceipt = { store: string; added: number; removed: number };
export type FactClearReceipt = { store?: string; graph?: string; removed: number; dryRun?: boolean };
export type FactClearStoreArgs = FactStoreArg & { dryRun?: boolean };
export type FactDeleteStoreArgs = FactStoreArg & { dryRun?: boolean };
export type FactDeleteGraphArgs = FactStoreArg & { graph: string; dryRun?: boolean };
export type FactDeleteGraphEverywhereArgs = { graph: string; dryRun?: boolean };
export type RefSetReceipt = { name: string; target: string; previous: string | null; changed: boolean };
export type ChatTitleReceipt = { chatId: string; previousTitle: string | null; title: string | null; changed: boolean };
export type ChatSummaryReceipt = { chatId: string; entryId: string; title?: string | null };
export type UiSayReceipt = { chatId: string; stepId: string; payloadHash: string };
export type ValidateApi = {
  pointerName(args: { name: string }): boolean;
  factStoreName(args: { name: string }): boolean;
  graphName(args: { graph: string }): boolean;
  uiAppId(args: { id: string }): boolean;
  hash(args: { hash: string }): boolean;
  relativePath(args: { path: string }): boolean;
};


export type PatchResult = {
  // Successful patch/delete operations return status="completed". Patch failures throw.
  status: string;
  output?: string | null;
};

export type ProcRunArgs = {
  cmd: string[];
  cwd?: string | null;
  stdin?: string | null;
  timeoutMs?: number;
  env?: Record<string, string | null | undefined>;
  check?: boolean;
  maxOutputBytes?: number | null;
};

export type LineRange = [from: number, to: number];
export type PartialReadArgs = { path: string; lineRanges: LineRange[]; numbered?: boolean };
export type FsDeleteArgs = { path: string; recursive?: boolean };

export type WorkspaceScope = {
  root: string;
  fs: {
    read(args: { path: string }): Promise<string>;
    partialRead(args: PartialReadArgs): Promise<string>;
    write(args: { path: string; content: string }): Promise<void>;
    list(args?: { path?: string }): Promise<string[]>;
    glob(args: { pattern: string }): Promise<string[]>;
    stat(args?: { path?: string }): Promise<{ kind: string; size: number; mtime: number } | null>;
    canonical(args?: { path?: string }): Promise<string>;
    exists(args?: { path?: string }): Promise<boolean>;
    ensureDir(args?: { path?: string }): Promise<void>;
    patch(args: { path: string; diff: string }): Promise<PatchResult>;
    delete(args: FsDeleteArgs): Promise<PatchResult>;
  };
  proc: {
    run(args: Omit<ProcRunArgs, "cwd"> & { cwd?: string | null }): Promise<ProcResult>;
    runChecked(args: Omit<ProcRunArgs, "cwd" | "check"> & { cwd?: string | null }): Promise<ProcResult>;
  };
};

export type MemoryScope = {
  assert(args: { subject: string; predicate: string; object: ObjectInput } | { facts: MemoryFact[] }): Promise<void>;
  retract(args: { subject: string; predicate: string; object: ObjectInput } | { facts: MemoryFact[] }): Promise<void>;
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
  time: { nowMs(args?: {}): Promise<number>; nowISO(args?: {}): Promise<string>; datetime(args?: { d?: Date | string | number }): Promise<Term>; nowPlus(args: { ms: number }): Promise<number> };
  validate: ValidateApi;
  id: { new: (args?: { prefix?: string }) => Promise<string> };
  log: (args: { args: unknown[] }) => void;
  objects: {
    putText(args: { kind: string; text: string }): Promise<string>;
    putJSON(args: { kind: string; value: unknown }): Promise<string>;
    getText(args: { hash: string }): Promise<{ kind: string; text: string } | null>;
    getJSON<V = unknown>(args: { hash: string }): Promise<{ kind: string; value: V } | null>;
  };
  todos: {
    list(): Promise<AgentTodoState>;
    add(args: TodoAddInput): Promise<AgentTodo>;
    update(args: TodoUpdateInput): Promise<AgentTodo>;
    done(args: { id: TodoIdInput; note?: string }): Promise<AgentTodo>;
    drop(args: { id: TodoIdInput; note?: string }): Promise<AgentTodo>;
    patch(args: TodoPatch): Promise<AgentTodoState>;
    clear(args?: { statuses?: TodoStatus[] }): Promise<AgentTodoState>;
  };
  skills: MooSkillsApi;
  pointers: {
    get(args: { name: string }): Promise<string | null>;
    set(args: { name: string; target: string }): Promise<RefSetReceipt>;
    cas(args: { name: string; expected: string | null; next: string }): Promise<boolean>;
    list(args?: { prefix?: string }): Promise<string[]>;
    entries(args?: { prefix?: string }): Promise<Array<[string, string]>>;
    delete(args: { name: string }): Promise<boolean>;
  };
  sparql: {
    query<F extends SparqlSelectFormat = "string">(args: (FactStoreArg & { query: string; graph?: string | null; limit?: number; format?: F })): Promise<SparqlQueryResult<F>>;
    select<F extends SparqlSelectFormat = "string">(args: (FactStoreArg & { query: string; graph?: string | null; limit?: number; format?: F })): Promise<F extends "term" ? TermBindings[] : Bindings[]>;
    ask(args: FactStoreArg & { query: string; graph?: string | null; limit?: number }): Promise<boolean>;
    construct(args: FactStoreArg & { query: string; graph?: string | null; limit?: number }): Promise<Quad[]>;
  };
  facts: {
    add(args: FactAddArgs): Promise<FactMutationReceipt>;
    addAll(args: FactAddAllArgs): Promise<FactMutationReceipt>;
    remove(args: FactRemoveArgs): Promise<FactMutationReceipt>;
    match<F extends FactMatchFormat = "tuple">(args: FactPattern<F>): Promise<F extends "object" ? QuadObject[] : Quad[]>;
    history(args: FactPattern): Promise<FactHistoryRow[]>;
    matchAll(args: FactMatchAllArgs): Promise<Bindings[]>;
    stores(args?: { prefix?: string | null }): Promise<string[]>;
    count(args: FactStoreArg & Pick<FactPattern, "graph" | "subject" | "predicate" | "object">): Promise<number>;
    swap(args: FactSwapArgs): Promise<FactMutationReceipt>;
    update(args: FactUpdateArgs): Promise<FactMutationReceipt>;
    clearStore(args: FactClearStoreArgs): Promise<FactClearReceipt>;
    deleteStore(args: FactDeleteStoreArgs): Promise<FactClearReceipt>;
    deleteGraph(args: FactDeleteGraphArgs): Promise<FactClearReceipt>;
    deleteGraphEverywhere(args: FactDeleteGraphEverywhereArgs): Promise<FactClearReceipt>;
  };
  fs: {
    read(args: { path: string }): Promise<string>;
    partialRead(args: PartialReadArgs): Promise<string>;
    write(args: { path: string; content: string }): Promise<void>;
    list(args: { path: string }): Promise<string[]>;
    glob(args: { pattern: string }): Promise<string[]>;
    stat(args?: { path?: string }): Promise<{ kind: string; size: number; mtime: number } | null>;
    canonical(args: { path: string }): Promise<string>;
    exists(args: { path: string }): Promise<boolean>;
    ensureDir(args: { path: string }): Promise<void>;
    patch(args: { path: string; diff: string }): Promise<PatchResult>;
    delete(args: FsDeleteArgs): Promise<PatchResult>;
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
    }): Promise<{ status: number; body: string; headers: Record<string, string | string[]>; bodyTruncated: boolean }>;
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
    publish(args: { payload: unknown }): void;
  };
  traces: MooTracesApi;
  env: {
    get(args: { name: string }): Promise<string | null>;
    getMany(args: { names: string[] }): Promise<Record<string, string | null>>;
  };
  chat: {
    refs(args: { chatId: string }): Promise<ChatRefs>;
    scratch(args: { chatId: string }): Promise<string>;
    touch(args: { chatId: string }): Promise<void>;
    list(): Promise<
      Array<{
        chatId: string;
        createdAt: number;
        lastAt: number;
        head: string | null;
        title: string | null;
        path: string | null;
        baseBranch?: string | null;
        worktreePath?: string | null;
        archived: boolean;
        archivedAt: number | null;
        hidden?: boolean;
        parentChatId?: string | null;
        status: string;
        runningStartedAt?: number | null;
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
    create(args?: { chatId?: string; path?: string | null; branch?: string | null; useExistingWorktree?: boolean }): Promise<string>;
    remove(args: { chatId: string }): Promise<{ chatId: string; refsDeleted: number; quadsCleared: number }>;
    setTitle(args: { chatId: string; title: string | null; manual?: boolean }): Promise<ChatTitleReceipt>;
    recordSummary(args: { chatId?: string; summary: string; title: string }): Promise<ChatSummaryReceipt>;
    archive(args: { chatId: string }): Promise<number>;
    unarchive(args: { chatId: string }): Promise<null>;
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
  tools: {
    cancel(args: {
      id?: string | null;
      stepId?: string | null;
      chatId?: string | null;
    }): Promise<{
      chatId: string;
      stepId: string | null;
      cancelled: number;
      status: "cancelled" | "not-found";
      message: string;
    }>;
  };
  agent: {
    claim(args: { store: string; graph: string; runId: string | null; leaseMs?: number }): Promise<{ stepId: string; leaseId: string; expiresAt: number } | null>;
    complete(args: { store: string; graph: string; stepId: string; status?: StepStatus }): Promise<void>;
    fork(args: { chatId: string; fromStepId?: string | null }): Promise<{ chatId: string; runId: string; forkedFrom: string | null }>;
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
    project(args?: { projectId?: string }): MemoryScope;
  };
  /**
   * Term constructors. Each returns a `Term` whose toString() is its
   * canonical Turtle form. Pass these to memory.assert/query when you
   * need to disambiguate a raw string from an IRI / literal.
   */
  term: {
    iri(args: { uri: string }): Term;
    string(args: { s: string; lang?: string; type?: string }): Term;
    int(args: { n: number }): Term;
    decimal(args: { n: number }): Term;
    bool(args: { b: boolean }): Term;
    datetime(args: { d: Date | string }): Term;
  };
  /**
   * Vocabulary registry: predicate metadata + observed-usage stats.
   * Declared predicates live in the `vocab:facts` graph; observed predicates
   * are read out of the memory graph by counting occurrences.
   */
  vocab: {
    define(args: { name: string; description?: string; example?: string; label?: string }): Promise<void>;
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
