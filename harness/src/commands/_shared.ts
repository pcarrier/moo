import { moo } from "../moo";
import type { LLMProvider } from "../types";
import type { StepMessage } from "../driver/step";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export type ShellCommandPayload = JsonObject & {
  cmd?: string[];
  cwd?: string | null;
  stdin?: string | null;
};

export type ToolCallInput = {
  id?: string;
  type?: "function" | string;
  function?: { name?: string; arguments?: string };
  runTsStepId?: string;
};

export type ProviderInput = LLMProvider;

export type UiManifestInput = JsonObject & {
  id?: string;
  title?: string;
  description?: string;
  icon?: string;
  entry?: string;
  api?: Array<{ name: string; input?: unknown }>;
};

export type UiBundleInput = {
  html?: string;
  css?: string;
  js?: string;
  files?: Record<string, string>;
};

export type LlmMessageInput = StepMessage;

export type DriverLifecycleEventsInput = {
  start?: JsonObject;
  end?: JsonObject;
};

export type DriverStateInput = {
  chatId?: string;
  mode?: "step" | "resume" | "compact" | string;
  message?: string;
  attachments?: AttachmentInput[];
  artificial?: boolean;
  messages?: LlmMessageInput[];
  pendingToolCalls?: ToolCallInput[];
  requestEffort?: string | null;
  usedModel?: string | null;
  thoughtDurationNs?: number | string;
  lifecycleEvents?: DriverLifecycleEventsInput;
};

export type CommandInputBase = {
  argv?: string[];
  traceRoute?: string;
  traceParentId?: string;
  traceFrontendId?: string;
};

export type ProjectScopedInput = {
  project?: string;
};

export type ChatCommandInput = {
  chatId?: string;
  chatIds?: string[];
  newChatId?: string;
  forkChatId?: string;
  title?: string;
  archived?: boolean;
  model?: string | null;
  effort?: string | null;
  path?: string;
  branch?: string;
  query?: string;
  includeRepos?: boolean;
  basePath?: string;
  sourceChatId?: string;
  fromStepId?: string;
  messageStepId?: string;
  stepId?: string;
  knownHead?: string;
  knownCompaction?: string;
  knownTotalTimelineItems?: number | string;
  sinceAt?: number | string;
  includeDiff?: boolean;
  recursive?: boolean;
  cancelled?: boolean;
};

export type StepReferenceInput = {
  step?: string;
};

export type ShellCommandEnqueueInput = {
  kind: "agent:ShellCommand";
  payload?: ShellCommandPayload;
  cmd?: string[];
  cwd?: string | null;
  stdin?: string | null;
};

export type GenericEnqueueInput = {
  kind?: Exclude<string, "agent:ShellCommand">;
  payload?: JsonValue;
};

export type EnqueueInput = ShellCommandEnqueueInput | GenericEnqueueInput;

export type AttachmentInput = {
  type?: string;
  mimeType?: string;
  dataUrl?: string;
  name?: string;
};

export type UserStepInput = {
  message?: string;
  attachments?: AttachmentInput[];
  artificial?: boolean;
};

export type StepDriverInput = {
  state?: DriverStateInput | JsonValue;
  provider?: ProviderInput;
  messages?: LlmMessageInput[];
  forceCompact?: boolean;
  compactionTrigger?: "automatic" | "manual" | string;
  toolCalls?: ToolCallInput[];
  toolCall?: ToolCallInput | null;
  usedModel?: string | null;
  requestEffort?: string | null;
  runTsStepId?: string | null;
};

export type LlmStreamResultInput = {
  status: number;
  ok: boolean;
  content: string;
  toolCalls: ToolCallInput[];
  errorBody: string | null;
  headers?: Record<string, JsonValue | string[] | undefined> | null;
  reasoningContent?: string | null;
  stopReason?: string | null;
  anthropicThinkingBlocks?: Array<{ type: "thinking"; thinking: string; signature: string }>;
  model: string | null;
  usage: JsonValue | null;
};

export type RetryScheduleStateInput = {
  attempts?: number;
  nextDelayMs?: number;
};

export type LlmResultInput = {
  attempt?: unknown;
  purpose?: "step" | "compact" | string;
  llmResult?: LlmStreamResultInput;
  draftId?: string;
  thoughtDurationNs?: number | string;
  estimatedPromptTokens?: number | string;
  requestModel?: string | null;
  requestProvider?: string | null;
  requestAuthMode?: string | null;
  availableTokens?: number | string;
  compactionsInARow?: number | string;
  compactionTrigger?: "automatic" | "manual" | string;
};

export type StepCommandInput = StepReferenceInput & UserStepInput & StepDriverInput & LlmResultInput & {
  leaseMs?: number;
  mode?: string;
  compaction?: { promptTokens?: number; postPromptTokens?: number; summaryTokens?: number; summary?: string; [key: string]: JsonValue | undefined };
  requestPromptTokens?: number | string;
  requestTokenLimit?: number | string;
  tokenBudget?: number | string;
  tokenThreshold?: number | string;
  availableTokens?: number | string;
  compactionsInARow?: number | string;
  retries?: RetryScheduleStateInput;
};

export type MemoryCommandInput = ProjectScopedInput & {
  hash?: string;
  patterns?: Array<[string, string, string]>;
  limit?: number | string;
  graph?: string;
  subject?: string | null;
  predicate?: string | null;
  object?: string | null;
  removed?: "include" | "only" | "exclude" | string;
  store?: string;
  prefix?: string;
  recursive?: boolean;
  ref?: string;
};

export type McpCommandInput = {
  serverId?: string;
  id?: string;
  name?: string;
  arguments?: JsonObject;
  state?: DriverStateInput | JsonValue;
  code?: string;
  serverBaseUrl?: string;
  origin?: string;
  redirectUri?: string;
  scope?: string;
  returnChatId?: string;
  url?: string;
  openai?: JsonValue;
  enabled?: boolean;
  timeoutMs?: number | string;
  tool?: string;
};

export type UiCommandInput = {
  id?: string;
  uiId?: string;
  instanceId?: string;
  input?: JsonObject;
  manifest?: UiManifestInput;
  bundle?: UiBundleInput;
  html?: string;
  css?: string;
  js?: string;
  icon?: string;
  entry?: string;
  api?: Array<{ name: string; input?: unknown }>;
  handler?: string;
};

export type VocabularyCommandInput = {
  name?: string;
  description?: string;
  example?: string;
  label?: string;
};

export type ProviderAuthInput = {
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  authMode?: "env" | "apiKey" | "oauth" | null;
  enabled?: boolean;
};

export type ProviderAuthConfigInput = {
  openai?: ProviderAuthInput;
  anthropic?: ProviderAuthInput;
  qwen?: ProviderAuthInput;
  xai?: ProviderAuthInput;
  deepseek?: ProviderAuthInput;
};

export type ContentCommandInput = {
  content?: string;
  frontmatter?: JsonObject;
  root?: string;
  url?: string;
  enabled?: boolean;
  timeoutMs?: number | string;
  commandName?: string;
};

export type SubmitInput = {
  requestId?: string;
  values?: JsonObject;
};

type UnionKeys<T> = T extends unknown ? keyof T : never;
type StrictUnion<T, TAll = T> = T extends unknown
  ? T & Partial<Record<Exclude<UnionKeys<TAll>, keyof T>, never>>
  : never;

type CommandCase<C extends string, T = {}> = { command?: C } & T;

export type StepCommandName =
  | "step"
  | "compact"
  | "resume"
  | "step-next"
  | "run-ts-tool"
  | "run-ts-background"
  | "run-ts-cancel"
  | "run-ts-backgrounds"
  | "subagent-final"
  | "restart-ongoing"
  | "interrupt"
  | "tick"
  | "pending-messages"
  | "pending-messages-save"
  | "message-delete"
  | "message-restore";

export type ChatCommandName =
  | "chats"
  | "chat-autocomplete"
  | "chat-recent-paths"
  | "chat-remove-recent-path"
  | "chat-new"
  | "chat-rm"
  | "chat-fork"
  | "chat-rename"
  | "chat-archive"
  | "chat-models"
  | "chat-settings"
  | "chat-model-set"
  | "chat-effort-set"
  | "describe"
  | "compactions";

export type FileCommandName =
  | "fs-list"
  | "fs-read"
  | "fs-search"
  | "fs-git-branches"
  | "fs-git-pull-branches"
  | "dump"
  | "schema";

export type MemoryCommandName =
  | "memory-query"
  | "object-get"
  | "graph-summaries"
  | "graph-rm"
  | "pointers"
  | "pointer-rm"
  | "triples"
  | "assert"
  | "retract"
  | "triple-rm"
  | "subject-rm"
  | "triple-restore";

export type LlmCommandName =
  | "llm-stream-init"
  | "llm-stream-accumulate"
  | "llm-stream-finalize"
  | "llm-stream-error"
  | "llm-auth-get"
  | "llm-auth-save"
  | "llm-auth-oauth-start"
  | "llm-auth-oauth-complete"
  | "llm-auth-oauth-device-start"
  | "llm-auth-oauth-device-poll"
  | "llm-auth-oauth-logout";

export type McpCommandName =
  | "mcp-list"
  | "mcp-save"
  | "mcp-remove"
  | "mcp-oauth-start"
  | "mcp-oauth-complete"
  | "mcp-oauth-logout"
  | "mcp-oauth-status"
  | "mcp-tools"
  | "mcp-call";

export type UiCommandName =
  | "ui-register"
  | "ui-list"
  | "ui-remove"
  | "ui-bundle"
  | "ui-chat"
  | "ui-open"
  | "ui-close"
  | "ui-state-get"
  | "ui-state-set"
  | "ui-call";

export type SkillCommandName =
  | "skills-list"
  | "skill-get"
  | "skill-download"
  | "skill-save"
  | "skill-remove"
  | "skill-refresh";

export type CommandInputVariant =
  | CommandCase<"enqueue", ChatCommandInput & EnqueueInput>
  | CommandCase<"submit", ChatCommandInput & SubmitInput>
  | CommandCase<"vocabulary">
  | CommandCase<"vocab-define", VocabularyCommandInput>
  | CommandCase<"llm-auth-get" | "llm-auth-oauth-start" | "llm-auth-oauth-complete" | "llm-auth-oauth-device-start" | "llm-auth-oauth-device-poll" | "llm-auth-oauth-logout">
  | CommandCase<StepCommandName, ChatCommandInput & StepCommandInput>
  | CommandCase<ChatCommandName, ChatCommandInput & StepReferenceInput>
  | CommandCase<FileCommandName, ChatCommandInput & MemoryCommandInput>
  | CommandCase<MemoryCommandName, MemoryCommandInput>
  | CommandCase<LlmCommandName, ProviderAuthConfigInput & McpCommandInput & StepCommandInput>
  | CommandCase<McpCommandName, McpCommandInput>
  | CommandCase<UiCommandName, ChatCommandInput & UiCommandInput & VocabularyCommandInput>
  | CommandCase<SkillCommandName, ContentCommandInput & VocabularyCommandInput>
  | CommandCase<string, { argv?: string[] }>;

export type CommandInput = CommandInputBase & StrictUnion<CommandInputVariant>;

export type Input = CommandInput;

export function parseProjectArg(args: string[]): { project?: string; rest: string[] } {
  if (args[0] === "--project") return { project: args[1] ?? "", rest: args.slice(2) };
  if (args[0]?.startsWith("--project=")) {
    return { project: args[0].slice("--project=".length), rest: args.slice(1) };
  }
  return { rest: args };
}

export function memoryScopeFor(input: Input) {
  return input.project !== undefined ? moo.memory.project({ projectId: String(input.project) }) : moo.memory;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function allFactStores(): Promise<string[]> {
  // facts.stores() is backed by both quads and fact_log, so it covers current
  // and historical fact stores across chats, memory, vocab, and project memory.
  // Keep the well-known stores for a deterministic empty-store dump. Put memory
  // stores first: the UI caps the all-graphs scan, and chat stores can otherwise
  // fill the cap before global/project memory is ever returned.
  const out = new Set<string>(["memory/facts", "vocab/facts"]);
  for (const store of await moo.facts.stores()) out.add(store);
  const rank = (store: string) => {
    if (store === "memory/facts") return 0;
    if (store.startsWith("memory/project/")) return 1;
    if (store === "vocab/facts") return 2;
    if (store.startsWith("chat/")) return 4;
    return 3;
  };
  return [...out].sort((a, b) => rank(a) - rank(b) || compareStrings(a, b));
}
