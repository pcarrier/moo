import type { WSConnection } from "./events";

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string; stack?: string } };

// state.ts wires the singleton WS up at boot via `bindWS`. All API calls
// route through it — there's no fallback to fetch. Pending requests are
// rejected on disconnect; callers see `{ok:false, error:{message:"ws ..."}}`.
let conn: WSConnection | null = null;

export function bindWS(c: WSConnection) {
  conn = c;
}

export async function call<T = unknown>(
  payload: Record<string, unknown>,
): Promise<ApiResult<T>> {
  if (!conn) return { ok: false, error: { message: "ws not bound" } };
  return await conn.run<ApiResult<T>>(payload);
}

// -- typed wrappers ---------------------------------------------------------

export type ChatSummary = {
  chatId: string;
  createdAt: number;
  lastAt: number;
  head: string | null;
  title: string | null;
  path: string | null;
  worktreePath?: string | null;
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
  model?: string;
  selectedModel?: string | null;
  effort?: never;
  effortLevel?: never;
  selectedEffort?: never;
  effectiveEffort?: never;
  archived: boolean;
  archivedAt: number | null;
  runningStartedAt?: number | null;
  hidden?: boolean;
  parentChatId?: string | null;
};

export type ChatModelOption = {
  id: string;
  provider: string;
  model: string;
  label: string;
};

export type ChatAutocompleteSuggestion = {
  chatId: string;
  chatTitle: string | null;
  step: string;
  at: number;
  text: string;
};

export type ChatModelInfo = {
  chatId: string;
  provider: string;
  selectedProvider?: string | null;
  defaultModel: string;
  defaultModelId?: string;
  selectedModel: string | null;
  selectedModelId?: string | null;
  effectiveModel: string;
  effectiveModelId?: string;
  models: string[];
  modelOptions?: ChatModelOption[];
  defaultEffort: string | null;
  selectedEffort: string | null;
  effectiveEffort: string | null;
  effortSupported?: boolean;
  efforts: string[];
};

export type ImageAttachment = {
  type: "image";
  mimeType: string;
  dataUrl: string;
  name?: string;
};

export type SubagentDetails = {
  label?: string | null;
  task?: string | null;
  childChatId?: string | null;
  parentRunJsStepId?: string | null;
  result?: {
    status?: string;
    childChatId?: string;
    text?: string;
    error?: string | null;
    durationMs?: number;
    usage?: unknown;
  } | null;
};

export type RunJSDetails = {
  label?: string | null;
  description?: string | null;
  args?: unknown;
  code?: string | null;
  result?: string | null;
  error?: string | null;
  durationMs?: number;
};

export type StepItem = {
  type: "step";
  step: string;
  kind: string;
  status: string;
  at: number;
  text: string;
  runjs?: RunJSDetails;
  subagent?: SubagentDetails;
  attachments?: ImageAttachment[];
  // Provider-echoed model that produced the step (for LLM-driven kinds).
  model?: string;
  // Reasoning/thinking effort used for the step, when applicable.
  effort?: string;
  // Milliseconds spent waiting on model responses for the final reply.
  thoughtDurationMs?: number;
  // Present when a user message is hidden from future LLM prompts.
  deletedAt?: number | string;
};

export type InputItem = {
  type: "input";
  requestId: string;
  kind: "ui:Form" | "ui:Choice";
  status: "ui:Pending" | "ui:Done" | "ui:Cancelled";
  at: number;
  spec: FormSpec | ChoiceSpec | null;
  response: { values: Record<string, unknown>; at: number; cancelled?: boolean } | null;
};

export type DiffStats = { added: number; removed: number; lines: number };

export type FileDiffItem = {
  type: "file-diff";
  id: string;
  step?: string;
  chatId: string;
  path: string;
  diff: string;
  stats?: DiffStats;
  before?: string | null;
  after?: string | null;
  hash?: string;
  at: number;
};

export type MemoryDiffItem = {
  type: "memory-diff";
  id: string;
  step?: string;
  chatId: string;
  refName: string;
  graph: string;
  path: string;
  diff: string;
  stats?: DiffStats;
  before?: string;
  after?: string;
  hash?: string;
  at: number;
};

export type LogItem = {
  type: "log";
  id: string;
  at: number;
  message: string;
};

export type TrailItem = {
  type: "trail";
  id: string;
  kind: string;
  at: number;
  title?: string | null;
  previousTitle?: string | null;
  body?: string | null;
  summary?: string | null;
};

export type TimelineItem = StepItem | InputItem | FileDiffItem | MemoryDiffItem | LogItem | TrailItem;

export type FormFieldType =
  | "text"
  | "textarea"
  | "url"
  | "number"
  | "boolean"
  | "select"
  | "secretRef"
  | "json";

export type FormField = {
  name: string;
  label?: string;
  type: FormFieldType;
  required?: boolean;
  default?: string | number | boolean;
  options?: Array<string | { label?: string; value?: string }>;
};

export type FormSpec = {
  title?: string;
  fields: FormField[];
  submitLabel?: string;
};

export type ChoiceSpec = {
  title?: string;
  items: Array<{ id: string; label: string; description?: string; input?: Record<string, unknown> }>;
};

export type TokenPressure = {
  used: number;
  budget: number;
  threshold: number;
  fraction: number;
};

export type DescribeValue = {
  chatId: string;
  head: string | null;
  totalFacts: number;
  totalTurns: number;
  totalSteps: number;
  totalCodeCalls?: number;
  timeline: TimelineItem[];
  tokens: TokenPressure;
  totalTimelineItems?: number;
  hiddenTimelineItems?: number;
  timelineLimit?: number;
};

export type CompactionLayer = {
  hash: string;
  summary: string;
  throughAt: number;
  at: number;
  parent: string | null;
  trigger: string | null;
  promptTokens: number | null;
  tokenBudget: number | null;
  tokenThreshold: number | null;
};

export type CompactionsValue = {
  chatId: string;
  layers: CompactionLayer[];
};

export type Triple = [string, string, string, string, string?, string?]; // [graph, s, p, o, action?, at?]
export type MemoryPattern = [string, string, string];
export type MemoryBindings = Record<string, string>;
export type MemoryWrite = { subject: string; predicate: string; object: string; project: string | null };
export type MemoryPatchGroup = { asserts?: MemoryPattern[]; retracts?: MemoryPattern[] };
export type MemoryPatch = { groups: MemoryPatchGroup[]; project: string | null };
export type StoreObject = { kind: string; content: string; bytesBase64?: string; size?: number } | null;

export type UiApp = {
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
  server?: string;
  name: string;
  title?: string | null;
  description?: string | null;
  inputSchema?: unknown;
};

export type UiInstance = { instanceId: string; uiId: string };


export type FsEntry = {
  name: string;
  path: string;
  kind: string;
  size: number;
  mtime: number;
};

export type FsListValue = {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  recent: string[];
};

export type FsReadValue = {
  path: string;
  kind: string;
  size: number;
  mtime: number;
  content: string;
};

export type Predicate = {
  name: string;
  declared: boolean;
  count: number;
  label: string | null;
  description: string | null;
  example: string | null;
};

export const api = {
  describe: (chatId: string, limit?: number) =>
    call<DescribeValue>({ command: "describe", chatId, ...(limit ? { limit } : {}) }),
  compactions: (chatId: string) =>
    call<CompactionsValue>({ command: "compactions", chatId }),
  step: (chatId: string, message: string, attachments: ImageAttachment[] = []) =>
    call<{ chatId: string; userStepId: string }>({
      command: "step",
      chatId,
      message,
      ...(attachments.length ? { attachments } : {}),
    }),
  interrupt: (chatId: string) =>
    call<{ chatId: string; aborted: boolean }>({
      command: "interrupt",
      chatId,
    }),
  submit: (chatId: string, requestId: string, values: Record<string, unknown>) =>
    call<{ chatId: string; requestId: string; kind: string }>({
      command: "submit",
      chatId,
      requestId,
      values,
    }),
  cancel: (chatId: string, requestId: string) =>
    call<{ chatId: string; requestId: string; kind: string }>({
      command: "submit",
      chatId,
      requestId,
      cancelled: true,
    }),
  chats: () => call<{ chats: ChatSummary[] }>({ command: "chats" }),
  chatAutocomplete: (query: string, limit = 12) =>
    call<{ suggestions: ChatAutocompleteSuggestion[] }>({
      command: "chat-autocomplete",
      query,
      limit,
    }),
  newChat: (chatId?: string, path?: string, model?: string | null, effort?: string | null) =>
    call<{ chatId: string; path?: string | null; recent?: string[] }>({
      command: "chat-new",
      ...(chatId ? { chatId } : {}),
      ...(path ? { path } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
    }),
  fsList: (path: string) => call<FsListValue>({ command: "fs-list", path }),
  fsRead: (path: string, basePath?: string | null) =>
    call<FsReadValue>({
      command: "fs-read",
      path,
      ...(basePath ? { basePath } : {}),
    }),
  recentChatPaths: () => call<{ paths: string[] }>({ command: "chat-recent-paths" }),
  removeChat: (chatId: string) =>
    call<{ chatId: string; refsDeleted: number; quadsCleared: number }>({
      command: "chat-rm",
      chatId,
    }),
  removeGraph: (graph: string) =>
    call<{ graph: string; ref?: string; quadsCleared: number; chatId?: string; refsDeleted?: number }>({
      command: "graph-rm",
      graph,
    }),
  renameChat: (chatId: string, title: string | null) =>
    call<{ chatId: string; title: string | null }>({
      command: "chat-rename",
      chatId,
      title,
    }),
  archiveChat: (chatId: string, archived: boolean) =>
    call<{ chatId: string; archived: boolean; archivedAt: number | null }>({
      command: "chat-archive",
      chatId,
      archived,
    }),
  chatExport: (chatId: string) =>
    call<{ chatId: string; url: string; bytes: number }>({
      command: "chat-export",
      chatId,
    }),
  chatModels: (chatId: string) =>
    call<ChatModelInfo>({ command: "chat-models", chatId }),
  chatSettings: (chatIds: string[]) =>
    call<{ settings: Record<string, { effort: string | null }> }>({ command: "chat-settings", chatIds }),
  setChatModel: (chatId: string, model: string | null) =>
    call<ChatModelInfo>({ command: "chat-model-set", chatId, model }),
  setChatEffort: (chatId: string, effort: string | null) =>
    call<ChatModelInfo>({ command: "chat-effort-set", chatId, effort }),
  deleteMessage: (chatId: string, step: string) =>
    call<{ chatId: string; step: string; deletedAt: number | string }>({
      command: "message-delete",
      chatId,
      step,
    }),
  restoreMessage: (chatId: string, step: string) =>
    call<{ chatId: string; step: string; deletedAt: null }>({
      command: "message-restore",
      chatId,
      step,
    }),
  objectGet: (hash: string) =>
    call<{ hash: string; object: StoreObject }>({ command: "object-get", hash }),
  memoryQuery: (patterns: MemoryPattern[], opts?: { project?: string; limit?: number }) =>
    call<{ bindings: MemoryBindings[] }>({
      command: "memory-query",
      patterns,
      ...(opts?.project !== undefined ? { project: opts.project } : {}),
      ...(opts?.limit ? { limit: opts.limit } : {}),
    }),
  triples: (
    subject?: string,
    predicate?: string,
    object?: string,
    opts?: { project?: string; removed?: "exclude" | "include" | "only" },
  ) =>
    call<{ triples: Triple[] }>({
      command: "triples",
      ...(subject ? { subject } : {}),
      ...(predicate ? { predicate } : {}),
      ...(object ? { object } : {}),
      ...(opts?.project !== undefined ? { project: opts.project } : {}),
      ...(opts?.removed ? { removed: opts.removed } : {}),
    }),
  assert: (subject: string, predicate: string, object: string, opts?: { project?: string }) =>
    call<MemoryWrite>({ command: "assert", subject, predicate, object, ...(opts?.project !== undefined ? { project: opts.project } : {}) }),
  memoryPatch: (groups: MemoryPatchGroup[], opts?: { project?: string }) =>
    call<MemoryPatch>({ command: "memory-patch", groups, ...(opts?.project !== undefined ? { project: opts.project } : {}) }),
  retract: (subject: string, predicate: string, object: string, opts?: { project?: string }) =>
    call<MemoryWrite>({ command: "retract", subject, predicate, object, ...(opts?.project !== undefined ? { project: opts.project } : {}) }),
  tripleRemove: (graph: string, subject: string, predicate: string, object: string) =>
    call<MemoryWrite & { graph: string; removed: number }>({
      command: "triple-rm",
      graph,
      subject,
      predicate,
      object,
    }),
  tripleRestore: (graph: string, subject: string, predicate: string, object: string) =>
    call<MemoryWrite & { graph: string; restored: number }>({
      command: "triple-restore",
      graph,
      subject,
      predicate,
      object,
    }),
  vocabulary: () =>
    call<{ predicates: Predicate[] }>({ command: "vocabulary" }),
  uiList: () => call<{ apps: UiApp[] }>({ command: "ui-list" }),
  uiRemove: (uiId: string) =>
    call<{ uiId: string; removed: boolean; refsDeleted: number; factsRemoved: number }>({ command: "ui-remove", uiId }),
  uiBundle: (uiId: string) =>
    call<{ manifest: UiApp; bundle: UiBundle }>({ command: "ui-bundle", uiId }),
  uiChat: (chatId: string) =>
    call<{ chatId: string; apps: UiApp[]; instances: UiInstance[]; primaryUiId: string | null }>({
      command: "ui-chat",
      chatId,
    }),
  uiOpen: (chatId: string, uiId: string, instanceId?: string | null) =>
    call<{ chatId: string; uiId: string; instanceId: string }>({
      command: "ui-open",
      chatId,
      uiId,
      ...(instanceId ? { instanceId } : {}),
    }),
  uiClose: (chatId: string, uiId: string, instanceId?: string | null) =>
    call<{ chatId: string; uiId: string; instanceId: string | null }>({
      command: "ui-close",
      chatId,
      uiId,
      ...(instanceId ? { instanceId } : {}),
    }),
  uiStateGet: (instanceId: string) =>
    call<{ instanceId: string; state: unknown; hash: string | null }>({ command: "ui-state-get", instanceId }),
  uiStateSet: (instanceId: string, state: unknown) =>
    call<{ instanceId: string; state: unknown; hash: string }>({ command: "ui-state-set", instanceId, state }),
  uiCall: (uiId: string, instanceId: string | null, chatId: string | null, name: string, input: unknown) =>
    call<unknown>({ command: "ui-call", uiId, instanceId, chatId, name, input }),
  mcpList: () => call<{ servers: McpServerConfig[] }>({ command: "mcp-list" }),
  mcpSave: (config: McpServerConfig) =>
    call<{ server: McpServerConfig }>({ command: "mcp-save", ...config }),
  mcpRemove: (id: string) =>
    call<{ id: string; removed: boolean }>({ command: "mcp-remove", id }),
  mcpOAuthStart: (serverId: string, origin?: string) =>
    call<{ login: McpOAuthStart }>({ command: "mcp-oauth-start", serverId, ...(origin ? { origin } : {}) }),
  mcpOAuthComplete: (state: string, code: string) =>
    call<{ status: McpOAuthStatus }>({ command: "mcp-oauth-complete", state, code }),
  mcpOAuthLogout: (serverId: string) =>
    call<{ serverId: string; removed: boolean }>({ command: "mcp-oauth-logout", serverId }),
  mcpOAuthStatus: (serverId: string) =>
    call<{ status: McpOAuthStatus }>({ command: "mcp-oauth-status", serverId }),
  mcpTools: (serverId?: string) =>
    call<{ tools: McpTool[] }>({
      command: "mcp-tools",
      ...(serverId ? { serverId } : {}),
    }),
  mcpCall: <T = unknown>(serverId: string, name: string, args?: unknown) =>
    call<T>({ command: "mcp-call", serverId, name, arguments: args ?? {} }),
  defineVerb: (name: string, description?: string, example?: string) =>
    call({
      command: "vocab-define",
      name,
      ...(description ? { description } : {}),
      ...(example ? { example } : {}),
    }),
};
