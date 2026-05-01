import type { TimelineItem } from "./timeline";

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

export type {
  DiffStats,
  FileDiffItem,
  InputItem,
  InputResponseItem,
  LogItem,
  MemoryDiffItem,
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
};

export type DescribeValue = {
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
  timeline: TimelineItem[];
  trail?: TimelineItem[];
  tokens: TokenPressure;
  totalTimelineItems?: number;
  hiddenTimelineItems?: number;
  timelineLimit?: number;
};

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
export type MemoryPattern = [string, string, string];
export type MemoryBindings = Record<string, string>;
export type MemoryWrite = { subject: string; predicate: string; object: string; project: string | null };
export type MemoryPatchGroup = { asserts?: MemoryPattern[]; retracts?: MemoryPattern[] };
export type MemoryPatch = { groups: MemoryPatchGroup[]; project: string | null };
export type StoreObject = { kind: string; content?: string; text?: string; bytesBase64?: string; size?: number } | null;

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
};

export type FsListValue = {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  recent: string[];
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

export type V8WorkerSnapshot = {
  key: string;
  lane: string;
  workerId: number;
  generation: number;
  status: string;
  currentCommand?: string | null;
  currentJobStartedAt?: number | null;
  currentJobElapsedMs?: number | null;
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
  lastDurationMs: number;
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

export type V8StatsValue = {
  generatedAt: number;
  workers: V8WorkerSnapshot[];
  events: V8Event[];
  config: {
    recycleUsedHeapBytes: number;
    cacheEntries: number;
    startupSnapshotsEnabled: boolean;
  };
  totals: {
    workers: number;
    busy: number;
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
