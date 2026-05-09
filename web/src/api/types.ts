import type { UiAppBundle, UiAppManifest } from "../../../shared/src/ui";
import type { DiffStats, TimelineItem } from "./timeline";

export type Brand<T, B extends string> = T & { readonly __brand?: B };

export type ChatId = Brand<string, "ChatId">;
export type StepId = Brand<string, "StepId">;
export type UiId = Brand<string, "UiId">;
export type UiInstanceId = Brand<string, "UiInstanceId">;
export type McpServerId = Brand<string, "McpServerId">;
export type Sha256Hash = Brand<string, "Sha256Hash">;

export type ChatSummary = {
  chatId: ChatId;
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
    models: Record<string, { input: number; cachedInput: number; cacheWriteInput?: number; output: number }>;
  } | null;
  costUsd?: number;
  costEstimated?: boolean;
  unpricedModels?: string[];
  childUsageIncluded?: number;
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
  parentChatId?: ChatId | null;
};

export type ChatModelOption = {
  id: string;
  provider: string;
  model: string;
  label: string;
};

export type ChatAutocompleteSuggestion = {
  chatId: ChatId;
  chatTitle: string | null;
  step: StepId;
  at: number;
  text: string;
};

export type ChatModelInfo = {
  chatId: ChatId;
  provider: string;
  selectedProvider?: string | null;
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

export type {
  DiffStats,
  BlobAddItem,
  FileDiffItem,
  InputItem,
  InputResponseItem,
  LogItem,
  MemoryDiffItem,
  TodoDiffItem,
  TodoDiffChange,
  AgentTodo,
  MemoryFactChange,
  RunJSDetails,
  StepItem,
  SubagentDetails,
  TimelineItem,
  TrailItem,
} from "./timeline";

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
  source?: string;
  estimated?: boolean;
};

export type DescribeOverviewValue = {
  chatId: ChatId;
  title?: string | null;
  path?: string | null;
  worktreePath?: string | null;
  createdAt?: number | null;
  lastAt?: number | null;
  hidden?: boolean;
  parentChatId?: ChatId | null;
  head: string | null;
  totalFacts: number;
  totalTurns: number;
  totalSteps: number;
  totalCodeCalls?: number;
  tokens: TokenPressure;
  todos?: import("./timeline").AgentTodo[];
  totalTimelineItems?: number;
  compaction?: string | null;
};

export type DescribeTimelinePage = {
  items: TimelineItem[];
  hiddenItems: number;
  limit: number;
  sinceAt?: number;
};

export type DescribeTrailPage = {
  items: TimelineItem[];
  limit: number;
};

export type DescribeSnapshotValue = {
  mode: "snapshot";
  overview: DescribeOverviewValue;
  timeline: DescribeTimelinePage;
  trail: DescribeTrailPage;
};

export type DescribeUpdateValue = {
  mode: "update";
  overview: DescribeOverviewValue;
  changed: boolean;
  timeline?: DescribeTimelinePage;
};

export type DescribeValue =
  | DescribeSnapshotValue
  | DescribeUpdateValue;

export type CompactionLayer = {
  hash: Sha256Hash;
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
  chatId: ChatId;
  layers: CompactionLayer[];
};

export type Triple = [string, string, string, string, string?, string?]; // [graph, s, p, o, action?, at?]
export type TriplesValue = { triples: Triple[]; truncated?: boolean; limit?: number; total?: number };
export type GraphSummary = [string, number, number]; // [graph, facts, subjects]
export type GraphSummariesValue = { graphs: GraphSummary[] };
export type PointerEntry = [string, string]; // [name, target]
export type PointersValue = { pointers: PointerEntry[] };
export type MemoryPattern = [string, string, string];
export type MemoryBindings = Record<string, string>;
export type MemoryWrite = { subject: string; predicate: string; object: string; project: string | null };
export type StoreObject = { kind: string; content?: string; text?: string; bytesBase64?: string; size?: number } | null;

export type UiApp = UiAppManifest;

export type UiBundle = UiAppBundle;

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
  serverId: McpServerId;
  authorizeUrl: string;
  state: string;
  redirectUri: string;
  expiresAt: number;
  returnChatId?: ChatId;
};

export type McpOAuthStatus = {
  serverId: McpServerId;
  authenticated: boolean;
  expiresAt?: number | null;
  scope?: string | null;
  returnChatId?: ChatId;
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
  serverId: McpServerId;
  server?: string;
  name: string;
  title?: string | null;
  description?: string | null;
  denseDescription?: string;
  inputSchema?: unknown;
};

export type UiInstance = { instanceId: UiInstanceId; uiId: UiId };


export type FsEntry = {
  name: string;
  path: string;
  kind: string;
  size: number;
  mtime: number;
  changed?: boolean;
  additions?: number;
  deletions?: number;
};

export type FsListValue = {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  recent: string[];
};

export type GitBranchItem = {
  name: string;
  ref: string;
  kind: "head" | "local" | "remote";
  current?: boolean;
  upstream?: string | null;
};

export type JjRevisionItem = {
  name: string;
  rev: string;
  kind: "current" | "bookmark" | "trunk" | "recent";
  description?: string | null;
  current?: boolean;
};

export type RepoKind = "git" | "jj" | null;

export type GitBranchesValue = {
  path: string;
  gitRoot: string | null;
  repoRoot?: string | null;
  repoKind?: RepoKind;
  isRepo: boolean;
  branches: GitBranchItem[];
  jjRevisions?: JjRevisionItem[];
  currentBranch: string | null;
  defaultBranch: string | null;
  selectedBranch: string | null;
  currentJjRevision?: string | null;
  selectedJjRevision?: string | null;
  hasRemote: boolean;
  jjAvailable?: boolean;
  canUpgradeToJj?: boolean;
  fetched?: boolean;
  message?: string | null;
};

export type FsSearchEntry = FsEntry & {
  relativePath: string;
};

export type FsSearchValue = {
  path: string;
  entries: FsSearchEntry[];
};

export type FsReadValue = {
  path: string;
  kind: string;
  size: number;
  mtime: number;
  content: string;
  changed?: boolean;
  additions?: number;
  deletions?: number;
  diff?: string;
  diffStats?: DiffStats;
  entries?: FsEntry[];
};

export type Predicate = {
  name: string;
  declared: boolean;
  count: number;
  label: string | null;
  description: string | null;
  example: string | null;
};


export type V8HeapSnapshot = {
  totalHeapSize: number;
  totalHeapSizeExecutable: number;
  totalPhysicalSize: number;
  totalAvailableSize: number;
  usedHeapSize: number;
  heapSizeLimit: number;
  mallocedMemory: number;
  externalMemory: number;
  peakMallocedMemory: number;
  totalGlobalHandlesSize: number;
  usedGlobalHandlesSize: number;
  numberOfNativeContexts: number;
  numberOfDetachedContexts: number;
  totalAllocatedBytes: number;
};

export type V8PoolQueueSnapshot = {
  lane: string;
  queued: number;
  totalEnqueued: number;
  maxQueued: number;
};

export type V8WorkerSnapshot = {
  key: string;
  lane: string;
  workerId: number;
  generation: number;
  status: string;
  currentCommand?: string | null;
  currentJobStartedAt?: number | null;
  currentJobElapsedNs?: number | null;
  jobs: number;
  generationJobs: number;
  errors: number;
  terminations: number;
  recycles: number;
  nearHeapLimit: number;
  cacheHits: number;
  cacheMisses: number;
  snapshotHits: number;
  snapshotMisses: number;
  lastDurationNs: number;
  lastQueueWaitMs: number;
  lastCommand?: string | null;
  lastContextKind?: string | null;
  lastError?: string | null;
  lastRecycleReason?: string | null;
  lastRecycleAt?: number | null;
  createdAt: number;
  generationStartedAt: number;
  cacheEntries: number;
  snapshotLoaded: boolean;
  snapshotHash?: string | null;
  heap?: V8HeapSnapshot | null;
};

export type V8Event = {
  at: number;
  worker: string;
  lane: string;
  workerId: number;
  generation: number;
  kind: string;
  reason?: string | null;
  command?: string | null;
  detail?: string | null;
};

export type V8PoolRuntimeSettings = {
  maxWorkers: number | null;
  maxOldGenerationBytes: number | null;
  maxYoungGenerationBytes: number | null;
  recycleUsedHeapBytes: number | null;
};

export type V8RuntimeSettings = {
  maxWorkers: number | null;
  readMaxWorkers: number | null;
  scanMaxWorkers: number | null;
  toolMaxWorkers: number | null;
  maxOldGenerationBytes: number | null;
  maxYoungGenerationBytes: number | null;
  recycleUsedHeapBytes: number | null;
  startupSnapshotsEnabled: boolean | null;
  mainPool: V8PoolRuntimeSettings | null;
  readPool: V8PoolRuntimeSettings | null;
  scanPool: V8PoolRuntimeSettings | null;
  toolPool: V8PoolRuntimeSettings | null;
};

export type V8SettingsValue = {
  settings: V8RuntimeSettings;
  defaults: V8RuntimeSettings;
  effective: V8RuntimeSettings;
};

export type TraceConfig = {
  enabled: boolean;
  clickhouseUrl: string;
  clickhouseDatabase: string;
  clickhouseTablePrefix: string;
  clickhouseUser: string | null;
  clickhousePassword: string | null;
};

export type TraceSettingsValue = {
  enabled: boolean;
  config: TraceConfig;
  defaults: TraceConfig;
  note: string;
};

export type TraceConfigTestValue = {
  message: string;
};

export type V8StatsValue = {
  generatedAt: number;
  workers: V8WorkerSnapshot[];
  pools: V8PoolQueueSnapshot[];
  events: V8Event[];
  config: {
    recycleUsedHeapBytes: number;
    maxOldGenerationBytes: number;
    maxYoungGenerationBytes: number;
    cacheEntries: number;
    startupSnapshotsEnabled: boolean;
    maxWorkers: number;
  };
  totals: {
    workers: number;
    busy: number;
    queued: number;
    totalEnqueued: number;
    maxQueued: number;
    totalJobs: number;
    totalErrors: number;
    totalTerminations: number;
    totalRecycles: number;
    totalNearHeapLimit: number;
    totalCacheHits: number;
    totalCacheMisses: number;
    totalSnapshotHits: number;
    totalSnapshotMisses: number;
    usedHeapSize: number;
    totalHeapSize: number;
  };
};

export interface TraceRow {
  id: string;
  traceId?: string | null;
  parentId: string | null;
  chatId: string | null;
  runId: string | null;
  kind: "chat" | "turn" | "step" | "llm" | "tool" | "runjs" | "system" | "user" | "frontend" | string;
  name: string;
  depth: number;
  seq: number;
  status: "ok" | "error" | "running" | "cancelled" | "timeout" | string;
  t0Ns: number;
  t0Us?: number;
  t1Ns: number | null;
  t1Us?: number | null;
  inputHash: string | null;
  outputHash: string | null;
  errorHash: string | null;
  inputObject?: StoreObject;
  outputObject?: StoreObject;
  errorObject?: StoreObject;
  invokedFromStepId: string | null;
  dataHash?: string | null;
  dataJson: any | null;
}


export type TraceSearchArgs = Record<string, unknown> & {
  query?: string;
  kind?: string;
  status?: string;
  chatId?: string;
  runId?: string;
  scope?: "chat" | "global" | "any";
  hasError?: boolean;
  limit?: number;
  beforeNs?: number | string;
  beforeUs?: number;
  startedAfterNs?: number | string;
  startedBeforeNs?: number | string;
  minDurationNs?: number | string;
  maxDurationNs?: number | string;
};
