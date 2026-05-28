import type { LLMProvider } from "./types";
import {
  currentCompactionThresholdPercent,
  providerConfiguredCredential,
} from "./commands/llm_auth";
import {
  finishRunTSTraceRoot,
  moo,
  startRunTSTraceRoot,
  withMooChatContext,
  withMooRunTSContext,
} from "./moo";
import { compileRunTS } from "./runts";
import { appendStep } from "./steps";
import {
  chatRefs,
  decodeJsonPointer,
  encodeJsonPointer,
  parseArgv,
  truncate,
  maybeQuote,
} from "./lib";
import {
  buildCompactionSummaryPromptMessages,
  buildSystemPrompt,
  COMPACTION_CONTINUATION_USER_PROMPT,
  compactionContinuationSystemMessage,
} from "./prompt";
import { formatTodosForPrompt } from "./todos";
import {
  modelContextWindow,
  inferProviderForModelId,
  modelLongContextUsageKey,
  modelSupportsVision,
  normalizeProvider as normalizeProviderName,
  type ProviderName,
} from "./llm_models";
export {
  compactionRequestTokenLimit,
  estimateTokens,
  fitCompactionSummaryMessages,
} from "./core/tokens";
import {
  compactionRequestTokenLimit,
  estimateTokens,
  fitCompactionSummaryMessages,
} from "./core/tokens";

export { appendStep, ensureRun } from "./steps";

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "runTS",
      description:
        "Compile and run TypeScript 6 against bundled ES2025 + Moo harness type definitions. Body is wrapped in an async function; use `return value` to surface a result. `moo`, `chatId`, `repo`, `scratch`, and optional `args` are in scope; `setTimeout` and `setImmediate` are available. Runs in the foreground unless `backgroundAfterNs: 0` is explicitly set; positive values are nanoseconds before auto-backgrounding; detached results include an id cancellable with `await moo.tools.cancel({ id })`; use `moo.agent.run(...)` for substantial independent awaited subagent work.",
      parameters: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description:
              "Markdown title (≤6 words) shown on the tool-call row. Imperative, sentence case; use Markdown links/code when helpful.",
          },
          description: {
            type: "string",
            description:
              "Markdown sentence explaining tool intent and why. Concrete and specific; use links/code for paths, predicates, etc.",
          },
          code: {
            type: "string",
            description:
              "TypeScript source to type-check and execute as the body of an async function.",
          },
          args: {
            description:
              "Arbitrary JSON value made available to the TypeScript body as `args`.",
          },
          backgroundAfterNs: {
            type: "number",
            description:
              "Optional nanosecond delay before detaching this runTS call; set to 0 to detach immediately while the chat turn ends.",
          },
        },
        required: ["label", "description", "code"],
        additionalProperties: false,
      },
    },
  },
];

function contextInterfaceForProvider(
  provider: Pick<LLMProvider, "authMode"> | null | undefined,
): "api" | "codex" {
  return provider?.authMode === "oauth" ? "codex" : "api";
}

export function modelContextBudget(
  provider:
    | (Pick<LLMProvider, "name" | "model"> &
        Partial<Pick<LLMProvider, "authMode">>)
    | null
    | undefined,
): number {
  return modelContextWindow(
    normalizeProviderName(provider?.name),
    provider?.model,
    contextInterfaceForProvider(provider),
  );
}

export async function contextBudget(
  provider?:
    | (Pick<LLMProvider, "name" | "model"> &
        Partial<Pick<LLMProvider, "authMode">>)
    | null,
): Promise<number> {
  return modelContextBudget(provider);
}

export async function compactionThresholdForBudget(
  budget: number,
): Promise<number> {
  const percent = await currentCompactionThresholdPercent();
  return Math.floor(budget * (percent / 100));
}

export const MAX_CONSECUTIVE_COMPACTIONS = 2;

function modelExtras(
  model: string | null | undefined,
  effort?: string | null,
): Array<[string, string]> {
  const extras: Array<[string, string]> = [];
  const m = (model ?? "").trim();
  const e = normalizeEffort(effort);
  if (m) extras.push(["agent:model", m]);
  if (e) extras.push(["agent:effort", e]);
  return extras;
}

type TraceMetadata = Record<string, unknown>;

export const DYNAMIC_CONTEXT_MESSAGE_ROLE = "dynamic_context" as const;

export function isDynamicContextMessage(message: any): boolean {
  return Boolean(
    message &&
    typeof message === "object" &&
    message.role === DYNAMIC_CONTEXT_MESSAGE_ROLE,
  );
}

export function messageForProvider(message: any): any | null {
  return isDynamicContextMessage(message) ? null : message;
}

export function stripDynamicContextMessages(messages: any[]): any[] {
  return Array.isArray(messages)
    ? messages.filter((message) => !isDynamicContextMessage(message))
    : [];
}

export function messagesHaveImageAttachments(
  messages: any[] | null | undefined,
): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some(
    (message) =>
      Array.isArray(message?.content) &&
      message.content.some((part: any) => part?.type === "image_url"),
  );
}

function messagesForProvider(messages: any[]): any[] {
  return Array.isArray(messages)
    ? messages.map(messageForProvider).filter((message) => message != null)
    : [];
}

function providerSupportsAttachments(
  provider: Pick<LLMProvider, "name" | "model">,
): boolean {
  return modelSupportsVision(
    normalizeProviderName(provider.name),
    provider.model,
  );
}

function stripImageAttachmentsFromMessages(messages: any[]): any[] {
  return messages.map((message) => {
    if (!Array.isArray(message?.content)) return message;
    return {
      ...message,
      content: message.content.filter(
        (part: any) => part?.type !== "image_url",
      ),
    };
  });
}

function messagesForRequest(provider: LLMProvider, messages: any[]): any[] {
  const providerMessages = messagesForProvider(messages);
  return providerSupportsAttachments(provider)
    ? providerMessages
    : stripImageAttachmentsFromMessages(providerMessages);
}

export function messagesForTrace(
  messages: any[] | null | undefined,
  tools?: any[] | null,
): TraceMetadata {
  const list = Array.isArray(messages) ? messages : [];
  return {
    messages: list.length,
    messageList: list,
    tools: Array.isArray(tools) ? tools.length : 0,
    toolList: Array.isArray(tools) ? tools : [],
    estimatedTokens: estimateTokens(list, tools),
  };
}

export function llmBodyForTrace(body: any): TraceMetadata {
  return {
    body,
  };
}

export function toolCallForTrace(tc: any): TraceMetadata {
  const rawArgs = String(tc?.function?.arguments ?? "");
  let argumentsJson: unknown = null;
  try {
    const parsed = rawArgs ? JSON.parse(rawArgs) : null;
    argumentsJson = parsed;
  } catch {}
  return {
    toolCallId: tc?.id ?? null,
    toolName: tc?.function?.name ?? null,
    toolCall: tc,
    argumentsText: rawArgs,
    argumentsJson,
  };
}

export async function traceMark(
  message: string,
  data: TraceMetadata = {},
): Promise<void> {
  try {
    await moo.traces.mark({ message: message, data: data });
  } catch {
    // Trace writes are observational only.
  }
}

export async function traceSpan<T>(
  name: string,
  data: TraceMetadata,
  fn: () => T | Promise<T>,
): Promise<Awaited<T>> {
  return await moo.traces.span({ name: name, data: data, fn: fn });
}

export async function reply(
  chatId: string,
  text: string,
  model?: string | null,
  effort?: string | null,
  thoughtDurationNs?: number | null,
  draftId?: string | null,
  reasoningContent?: string | null,
) {
  const payloadBody: any = { text, at: await moo.time.nowMs({}) };
  if (Number.isFinite(thoughtDurationNs) && thoughtDurationNs! >= 0) {
    payloadBody.thoughtDurationNs = Math.round(thoughtDurationNs!);
  }
  if (typeof draftId === "string" && draftId) payloadBody.draftId = draftId;
  if (typeof reasoningContent === "string" && reasoningContent.trim()) {
    payloadBody.reasoningContent = reasoningContent;
  }
  await traceMark("timeline.reply", {
    chatId,
    chars: text.length,
    hasThoughtDuration: Number.isFinite(thoughtDurationNs),
    hasReasoningContent:
      typeof reasoningContent === "string" &&
      reasoningContent.trim().length > 0,
    model: model ?? null,
    effort: normalizeEffort(effort) ?? null,
  });
  const payload = await moo.objects.putJSON({
    kind: "agent:Reply",
    value: payloadBody,
  });
  const { stepId } = await appendStep(chatId, {
    kind: "agent:Reply",
    status: "agent:Done",
    payloadHash: payload,
    extras: modelExtras(model, effort),
  });
  return {
    stepId,
    kind: "agent:Reply" as const,
    status: "agent:Done" as const,
  };
}

export async function recordErrorStep(
  chatId: string,
  kind: string,
  detail: any,
  model?: string | null,
  effort?: string | null,
) {
  await traceMark("timeline.error", {
    chatId,
    kind,
    model: model ?? null,
    effort: normalizeEffort(effort) ?? null,
    detailKeys:
      detail && typeof detail === "object" ? Object.keys(detail).sort() : [],
  });
  const payloadHash = await moo.objects.putJSON({
    kind: "agent:Error",
    value: { kind, detail, at: await moo.time.nowMs({}) },
  });
  const { stepId } = await appendStep(chatId, {
    kind: "agent:Error",
    status: "agent:Failed",
    payloadHash,
    extras: modelExtras(model, effort),
  });
  return {
    stepId,
    kind: "agent:Error" as const,
    status: "agent:Failed" as const,
  };
}

// -- provider --------------------------------------------------------------

export function inferProviderForModel(
  model: string | null | undefined,
): ProviderName | null {
  return inferProviderForModelId(model);
}

const CHAT_MODEL_PREDICATE = "ui:model";
const CHAT_PROVIDER_PREDICATE = "ui:provider";
const CHAT_EFFORT_PREDICATE = "ui:effortLevel";

async function selectedChatFact(
  chatId: string,
  predicate: string,
): Promise<string | null> {
  const c = chatRefs(chatId);
  const rows = await moo.facts.match({
    store: c.facts,
    ...{
      graph: c.graph,
      subject: `chat:${chatId}`,
      predicate,
      limit: 1,
    },
  });
  // Fact objects come back in their stored Turtle form (string literals are
  // wrapped in quotes); decode so callers see the raw string they wrote.
  return decodeSimpleTurtleString(String(rows[0]?.[3] ?? "")).trim() || null;
}

async function selectedModelForChat(chatId: string): Promise<string | null> {
  return selectedChatFact(chatId, CHAT_MODEL_PREDICATE);
}

async function selectedEffortForChat(chatId: string): Promise<string | null> {
  return normalizeEffort(await selectedChatFact(chatId, CHAT_EFFORT_PREDICATE));
}

async function selectedProviderForChat(
  chatId: string,
): Promise<ProviderName | null> {
  return normalizeProviderName(
    await selectedChatFact(chatId, CHAT_PROVIDER_PREDICATE),
  );
}

export function decodeSimpleTurtleString(value: string): string {
  const trimmed = value.trim();
  const m =
    /^"((?:[^"\\\r\n]|\\["\\nrtbf])*)"(?:@[A-Za-z]+(?:-[A-Za-z0-9]+)*|\^\^\S+)?$/.exec(
      trimmed,
    );
  if (!m) return trimmed;
  return m[1].replace(/\\(["\\nrtbf])/g, (_all, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      default:
        return ch;
    }
  });
}

export const ALL_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
type EffortLevel = (typeof ALL_EFFORT_LEVELS)[number];
type EffortBudgetMap = Partial<Record<EffortLevel, number>>;

export const DEEPSEEK_THINK_MAX_SYSTEM_PROMPT =
  "DeepSeek Think Max mode: push reasoning to its fullest extent before answering. Explore the boundary of your reasoning capability, then provide the final answer.";

export function normalizeEffort(value: unknown): EffortLevel | null {
  const effort = decodeSimpleTurtleString(String(value ?? ""))
    .trim()
    .toLowerCase();
  return (ALL_EFFORT_LEVELS as readonly string[]).includes(effort)
    ? (effort as EffortLevel)
    : null;
}

function effortAllowed(
  efforts: readonly string[],
  effort: string | null | undefined,
): EffortLevel | null {
  const normalized = normalizeEffort(effort);
  return normalized && efforts.includes(normalized) ? normalized : null;
}

async function defaultEffort(): Promise<string | null> {
  return normalizeEffort(
    (await moo.env.get({ name: "ANTHROPIC_EFFORT" })) ||
      (await moo.env.get({ name: "ANTHROPIC_THINKING_EFFORT" })) ||
      (await moo.env.get({ name: "OPENAI_REASONING_EFFORT" })) ||
      (await moo.env.get({ name: "OPENAI_EFFORT" })) ||
      (await moo.env.get({ name: "DEEPSEEK_REASONING_EFFORT" })) ||
      (await moo.env.get({ name: "DEEPSEEK_EFFORT" })),
  );
}

export function usesResponsesApi(provider: LLMProvider): boolean {
  return provider.name === "openai";
}

function appendPath(baseUrl: string, suffix: string): string {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return base + suffix;
}

function openAIWebsocketUrl(provider: LLMProvider): string {
  // Both API-key and OAuth flows use the Responses-over-WebSocket beta at
  // `{base}/responses`. The base_url already includes `/v1` for the public
  // API and `/backend-api/codex` for ChatGPT auth.
  const url = appendPath(provider.baseUrl, "/responses");
  if (url.startsWith("https://")) return "wss://" + url.slice("https://".length);
  if (url.startsWith("http://")) return "ws://" + url.slice("http://".length);
  return url;
}

// UUIDv4 for the per-request `x-codex-installation-id` body field. The
// connection-level routing identity (session-id / thread-id / x-client-request-id)
// is generated and stamped by the Rust transport at WS connect time so it
// stays stable for the lifetime of a reused socket.
function uuidv4(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function effortLevelsForProvider(
  provider: Pick<LLMProvider, "name" | "model">,
): string[] {
  if (provider.name === "anthropic")
    return anthropicEffortLevels(provider.model);
  if (provider.name === "openai") return openaiEffortLevels(provider.model);
  if (provider.name === "deepseek") return deepseekEffortLevels(provider.model);
  return [];
}

export function supportsEffort(
  provider: Pick<LLMProvider, "name" | "model">,
): boolean {
  return effortLevelsForProvider(provider).length > 0;
}

export function compactionProviderForRequest(
  provider: LLMProvider,
): LLMProvider {
  const levels = effortLevelsForProvider(provider);
  if (!levels.length) return { ...provider, effort: null };
  const effort =
    ["minimal", "none", "low"].find((candidate) =>
      levels.includes(candidate),
    ) ?? null;
  return { ...provider, effort };
}

function openaiEffortLevels(model: string | null | undefined): string[] {
  const id = String(model ?? "")
    .trim()
    .toLowerCase();
  if (/^gpt-5\.5(?:[.-]|$)/.test(id))
    return ["none", "low", "medium", "high", "xhigh"];
  if (/^gpt-5(?:[.-]|$)/.test(id)) return ["minimal", "low", "medium", "high"];
  if (/^o(?:1|3|4)(?:[.-]|$)/.test(id)) return ["low", "medium", "high"];
  return [];
}

function deepseekEffortLevels(model: string | null | undefined): string[] {
  const id = String(model ?? "")
    .trim()
    .toLowerCase();
  return /^deepseek-(?:v4|chat|reasoner)(?:[-.]|$)/.test(id)
    ? ["none", "high", "max"]
    : [];
}

function deepseekEffortForRequest(
  effort: string | null | undefined,
): "none" | "high" | "max" | null {
  const normalized = normalizeEffort(effort);
  if (!normalized || normalized === "minimal") return null;
  if (normalized === "none") return "none";
  if (normalized === "max" || normalized === "xhigh") return "max";
  return "high";
}

function deepseekRequestEffort(
  provider: Pick<LLMProvider, "model" | "effort">,
): "none" | "high" | "max" | null {
  if (!deepseekEffortLevels(provider.model).length) return null;
  return deepseekEffortForRequest(provider.effort) ?? "high";
}

function requestEffortForProvider(provider: LLMProvider): EffortLevel | null {
  if (provider.name === "deepseek") return deepseekRequestEffort(provider);
  if (
    provider.name === "anthropic" &&
    anthropicAdaptiveEffortLevels(provider.model)
  ) {
    return (
      effortAllowed(anthropicEffortLevels(provider.model), provider.effort) ??
      "high"
    );
  }
  return effortAllowed(effortLevelsForProvider(provider), provider.effort);
}

function withDeepSeekThinkMaxPrompt(
  provider: LLMProvider,
  messages: any[],
): any[] {
  if (provider.name !== "deepseek" || deepseekRequestEffort(provider) !== "max")
    return messages;
  const prompt = { role: "system", content: DEEPSEEK_THINK_MAX_SYSTEM_PROMPT };
  const out = [...messages];
  let insertAt = 0;
  while (insertAt < out.length && out[insertAt]?.role === "system") insertAt++;
  out.splice(insertAt, 0, prompt);
  return out;
}

const ANTHROPIC_DEFAULT_THINKING_BUDGETS: EffortBudgetMap = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 6144,
  xhigh: 7168,
};

const ANTHROPIC_ADAPTIVE_EFFORT_LEVELS = ["low", "medium", "high"] as const;
const ANTHROPIC_ADAPTIVE_MAX_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "max",
] as const;
const ANTHROPIC_ADAPTIVE_OPUS_4_7_PLUS_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const ANTHROPIC_BUDGET_THINKING_MODELS: Array<{
  pattern: RegExp;
  budgets: EffortBudgetMap;
}> = [
  // Claude 3.7 exposes extended thinking via budget_tokens. Newer Claude
  // models use adaptive thinking controlled by output_config.effort instead.
  {
    pattern: /(?:^|[-.])3[-.]7(?:[-.]|$)/,
    budgets: ANTHROPIC_DEFAULT_THINKING_BUDGETS,
  },
];

function isClaudeOpus47Plus(id: string): boolean {
  return /(?:^|[-.])opus[-.]4[-.](?:7|8)(?:[-.]|$)/.test(id);
}

function isClaudeMaxEffortModel(id: string): boolean {
  return (
    /(?:^|[-.])mythos(?:[-.]|$)/.test(id) ||
    /(?:^|[-.])opus[-.]4[-.]6(?:[-.]|$)/.test(id) ||
    /(?:^|[-.])sonnet[-.]4[-.]6(?:[-.]|$)/.test(id)
  );
}

function anthropicAdaptiveEffortLevels(
  model: string | null | undefined,
): readonly EffortLevel[] | null {
  const id = String(model ?? "")
    .trim()
    .toLowerCase();
  if (!id.startsWith("claude")) return null;
  if (isClaudeOpus47Plus(id)) return ANTHROPIC_ADAPTIVE_OPUS_4_7_PLUS_EFFORT_LEVELS;
  if (isClaudeMaxEffortModel(id)) return ANTHROPIC_ADAPTIVE_MAX_EFFORT_LEVELS;
  if (/(?:^|[-.])(?:opus|sonnet|haiku)[-.]4(?:[-.]|$)/.test(id))
    return ANTHROPIC_ADAPTIVE_EFFORT_LEVELS;
  return null;
}

function anthropicThinkingBudgets(
  model: string | null | undefined,
): EffortBudgetMap | null {
  const id = String(model ?? "")
    .trim()
    .toLowerCase();
  if (!id.startsWith("claude")) return null;
  return (
    ANTHROPIC_BUDGET_THINKING_MODELS.find(({ pattern }) => pattern.test(id))
      ?.budgets ?? null
  );
}

function anthropicEffortLevels(model: string | null | undefined): string[] {
  const adaptive = anthropicAdaptiveEffortLevels(model);
  if (adaptive) return [...adaptive];
  const budgets = anthropicThinkingBudgets(model);
  if (!budgets) return [];
  return ALL_EFFORT_LEVELS.filter((effort) => budgets[effort] != null);
}

export function supportsAnthropicThinking(
  model: string | null | undefined,
): boolean {
  return anthropicEffortLevels(model).length > 0;
}

function anthropicThinkingBudget(
  model: string | null | undefined,
  effort: string | null | undefined,
): number | null {
  const budgets = anthropicThinkingBudgets(model);
  if (!budgets) return null;
  const allowedEffort = effortAllowed(anthropicEffortLevels(model), effort);
  return allowedEffort ? (budgets[allowedEffort] ?? null) : null;
}

function applyEffort(
  provider: LLMProvider,
  body: Record<string, unknown>,
  responsesApi = false,
) {
  if (provider.name === "deepseek") {
    const effort = deepseekRequestEffort(provider);
    if (!effort) return;
    if (effort === "none") {
      body.thinking = { type: "disabled" };
      return;
    }
    body.thinking = { type: "enabled" };
    body.reasoning_effort = effort;
    return;
  }
  if (
    provider.name === "anthropic" &&
    supportsAnthropicThinking(provider.model)
  ) {
    const adaptive = anthropicAdaptiveEffortLevels(provider.model);
    const effort =
      effortAllowed(anthropicEffortLevels(provider.model), provider.effort) ??
      (adaptive ? "high" : null);
    if (!effort) return;
    if (adaptive) {
      body.thinking = { type: "adaptive", display: "summarized" };
      body.output_config = {
        ...((body.output_config as Record<string, unknown> | undefined) ?? {}),
        effort,
      };
      return;
    }
    const budget = anthropicThinkingBudget(provider.model, effort);
    if (budget)
      body.thinking = {
        type: "enabled",
        budget_tokens: budget,
        display: "summarized",
      };
    return;
  }
  if (provider.name === "openai") {
    const levels = openaiEffortLevels(provider.model);
    if (!levels.length) return;
    const effort = effortAllowed(
      levels,
      provider.effort,
    );
    if (responsesApi) {
      body.reasoning =
        effort === "none"
          ? { effort }
          : compactObject({ effort, summary: "auto" });
    } else if (effort) body.reasoning_effort = effort;
    return;
  }
  if (!provider.effort) return;
}

export function buildStreamingLLMRequest(
  provider: LLMProvider,
  messages: any[],
  tools: any[] | null,
) {
  const providerMessages = withDeepSeekThinkMaxPrompt(
    provider,
    messagesForRequest(provider, messages),
  );
  if (provider.name === "anthropic") {
    const anthropic = toAnthropicMessages(providerMessages);
    const body: Record<string, unknown> = {
      model: provider.model,
      max_tokens: anthropicMaxTokens(),
      messages: anthropic.messages,
      stream: true,
    };
    if (anthropic.system) body.system = anthropic.system;
    applyEffort(provider, body);
    const anthropicTools = toAnthropicTools(tools);
    if (anthropicTools?.length) {
      body.tools = anthropicTools;
      body.tool_choice = { type: "auto" };
    }
    return {
      url: provider.baseUrl + "/messages",
      body,
      responsesApi: false,
      headers: llmProviderHeaders(provider),
      requestModel: provider.model || null,
      requestEffort: requestEffortForProvider(provider),
      requestAuthMode: provider.authMode || null,
    };
  }

  const responsesApi = usesResponsesApi(provider);
  const outboundMessages = requiresFinalUserContinuation(provider)
    ? ensureEndsWithUserMessage(providerMessages)
    : providerMessages;
  const body: Record<string, unknown> = responsesApi
    ? {
        // Mirrors codex's ResponseCreateWsRequest (serde tag = "type" so fields
        // are flat) — the server expects these always-serialized fields even
        // when empty.
        type: "response.create",
        model: provider.model,
        instructions: extractInstructions(outboundMessages) ?? "",
        input: toResponsesInput(outboundMessages),
        tools: tools?.length ? toResponsesTools(tools) : [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        reasoning: null,
        store: false,
        stream: true,
        include: [] as string[],
        client_metadata: { "x-codex-installation-id": uuidv4() },
      }
    : {
        model: provider.model,
        messages: outboundMessages,
        stream: true,
        // Ask OpenAI-compatible endpoints to include token usage in the final
        // SSE chunk. Endpoints that ignore the option simply drop it.
        stream_options: { include_usage: true },
      };
  applyEffort(provider, body, responsesApi);
  if (!responsesApi && tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (responsesApi) {
    // Codex's `include` is non-empty when reasoning is requested so the server
    // returns encrypted reasoning blobs the client can replay on retry.
    if (body.reasoning != null) body.include = ["reasoning.encrypted_content"];
  }
  return {
    url: responsesApi
      ? openAIWebsocketUrl(provider)
      : appendPath(provider.baseUrl, "/chat/completions"),
    body,
    transport: responsesApi ? "websocket" : "sse",
    responsesApi,
    headers: llmProviderHeaders(provider),
    requestModel: provider.model || null,
    requestEffort: requestEffortForProvider(provider),
    requestAuthMode: provider.authMode || null,
  };
}
export function toResponsesTools(tools: any[] | null): any[] | null {
  if (!tools?.length) return null;
  return tools.map((tool) => ({
    type: "function",
    name: tool?.function?.name,
    description: tool?.function?.description,
    parameters: tool?.function?.parameters,
  }));
}

export function llmProviderHeaders(
  provider: LLMProvider,
): Record<string, string> {
  if (provider.name === "anthropic") {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
    };
    headers["x-api-key"] = provider.apiKey || "";
    return headers;
  }
  const headers: Record<string, string> = {
    Authorization: "Bearer " + (provider.apiKey || ""),
  };
  if (provider.name === "openai") {
    headers["OpenAI-Beta"] = "responses_websockets=2026-02-06";
  }
  if (provider.authMode === "oauth") {
    if (provider.oauthAccountId)
      headers["ChatGPT-Account-ID"] = provider.oauthAccountId;
    headers["User-Agent"] = "codex_cli_rs/0.1.0";
    headers["originator"] = "codex_cli_rs";
  }
  return headers;
}

function anthropicMaxTokens(): number {
  return 8192;
}

export function toAnthropicTools(tools: any[] | null): any[] | null {
  if (!tools?.length) return null;
  return tools.map((tool) => ({
    name: String(tool?.function?.name || ""),
    description: String(tool?.function?.description || ""),
    input_schema: tool?.function?.parameters || { type: "object" },
  }));
}

export function toAnthropicMessages(messages: any[]): {
  system: string;
  messages: any[];
} {
  const systemParts: string[] = [];
  const out: any[] = [];
  for (const rawMsg of messages) {
    const msg = messageForProvider(rawMsg);
    if (!msg) continue;
    if (msg?.role === "system") {
      const text = contentText(msg.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (msg?.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: String(msg.tool_call_id || ""),
            content: String(msg.content ?? ""),
          },
        ],
      });
      continue;
    }
    if (
      msg?.role === "assistant" &&
      Array.isArray(msg.tool_calls) &&
      msg.tool_calls.length
    ) {
      const content: any[] = [];
      for (const block of anthropicThinkingBlocks(msg)) content.push(block);
      const text = contentText(msg.content);
      if (text) content.push({ type: "text", text });
      for (const tc of msg.tool_calls) {
        content.push({
          type: "tool_use",
          id: String(tc?.id || ""),
          name: String(tc?.function?.name || ""),
          input: parseToolArgs(tc?.function?.arguments),
        });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    const role = msg?.role === "assistant" ? "assistant" : "user";
    out.push({ role, content: toAnthropicContent(msg?.content, role) });
  }
  // Some Anthropic models reject requests whose final message is an
  // assistant turn ("assistant message prefill"). Guarantee the conversation
  // ends with a user message by appending a no-op continuation when needed.
  if (out.length === 0 || out[out.length - 1]?.role === "assistant") {
    out.push({ role: "user", content: "Continue." });
  }
  return { system: systemParts.join("\n\n"), messages: out };
}

function contentText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  return content == null ? "" : String(content);
}

function anthropicThinkingBlocks(msg: any): any[] {
  if (Array.isArray(msg?.anthropic_thinking_blocks))
    return msg.anthropic_thinking_blocks
      .map((block: any) => sanitizeAnthropicThinkingBlock(block))
      .filter(Boolean);
  if (msg?.anthropic_thinking_block) {
    const block = sanitizeAnthropicThinkingBlock(msg.anthropic_thinking_block);
    return block ? [block] : [];
  }
  if (
    typeof msg?.reasoning_content !== "string" ||
    !msg.reasoning_content.trim()
  )
    return [];
  const signature =
    typeof msg?.anthropic_thinking_signature === "string"
      ? msg.anthropic_thinking_signature
      : "";
  return signature
    ? [{ type: "thinking", thinking: msg.reasoning_content, signature }]
    : [];
}

function sanitizeAnthropicThinkingBlock(block: any): any | null {
  if (!block || typeof block !== "object" || block.type !== "thinking")
    return null;
  const signature = typeof block.signature === "string" ? block.signature : "";
  if (!signature) return null;
  return {
    type: "thinking",
    thinking: typeof block.thinking === "string" ? block.thinking : "",
    signature,
  };
}

function toAnthropicContent(content: any, role: string): any {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const blocks: any[] = [];
  for (const part of content) {
    if (part?.type === "text")
      blocks.push({ type: "text", text: String(part.text ?? "") });
    else if (role === "assistant" && part?.type === "thinking") {
      const block = sanitizeAnthropicThinkingBlock(part);
      if (block) blocks.push(block);
    } else if (role === "user" && part?.type === "image_url") {
      const url =
        typeof part.image_url === "string"
          ? part.image_url
          : part.image_url?.url;
      const image = dataUrlToAnthropicSource(url);
      if (image) blocks.push({ type: "image", source: image });
    }
  }
  return blocks.length ? blocks : "";
}

function dataUrlToAnthropicSource(url: unknown): any | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(url ?? ""));
  if (!m) return null;
  return { type: "base64", media_type: m[1], data: m[2] };
}

function parseToolArgs(raw: unknown): any {
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw || "{}"));
  } catch {
    return {};
  }
}
function toResponsesContent(role: string, content: any): any {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part?.type === "text") {
      return {
        type: role === "assistant" ? "output_text" : "input_text",
        text: part.text ?? "",
      };
    }
    if (part?.type === "image_url") {
      const imageUrl =
        typeof part.image_url === "string"
          ? part.image_url
          : part.image_url?.url;
      return { type: "input_image", image_url: imageUrl };
    }
    return part;
  });
}

// Some provider adapters reject "assistant message prefill" — i.e. a request
// whose final message is from the assistant. Keep this workaround at the
// provider boundary so canonical harness history stays clean.
export function requiresFinalUserContinuation(
  provider: Pick<LLMProvider, "name">,
): boolean {
  return provider.name === "qwen";
}

export function ensureEndsWithUserMessage<
  T extends { role?: string; tool_calls?: any[] },
>(messages: T[]): T[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    return [
      ...messages,
      { role: "user", content: "Continue." } as unknown as T,
    ];
  }
  return messages;
}

function extractInstructions(messages: any[]): string | undefined {
  const systemMsgs = messages.filter((m) => m.role === "system");
  if (!systemMsgs.length) return undefined;
  return systemMsgs
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .join("\n\n");
}

export function toResponsesInput(messages: any[]): any[] {
  const outboundMessages = messagesForProvider(messages);
  const hasNonSystem = outboundMessages.some((m) => m.role !== "system");
  const input: any[] = [];
  for (const msg of outboundMessages) {
    if (msg.role === "system" && hasNonSystem) continue;
    if (msg.role === "tool") {
      const callId = String(msg.tool_call_id ?? "").trim();
      if (!callId) continue;
      input.push({
        type: "function_call_output",
        call_id: callId,
        output: String(msg.content ?? ""),
      });
      continue;
    }
    const content = toResponsesContent(msg.role, msg.content ?? "");
    if (content || !msg.tool_calls?.length) {
      input.push({ role: msg.role, content });
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const callId = String(tc?.id ?? "").trim();
        if (!callId) continue;
        input.push({
          type: "function_call",
          call_id: callId,
          name: tc.function?.name || "",
          arguments: tc.function?.arguments || "{}",
        });
      }
    }
  }
  return input;
}

function stripDeepSeekThinkTags(text: string): string {
  let out = "";
  let i = 0;
  let inThink = false;
  while (i < text.length) {
    if (text.startsWith("<think>", i)) {
      inThink = true;
      i += "<think>".length;
      continue;
    }
    if (text.startsWith("</think>", i)) {
      inThink = false;
      i += "</think>".length;
      continue;
    }
    if (!inThink) out += text[i];
    i++;
  }
  return out;
}

function responseOutputText(body: any): string {
  if (typeof body?.output_text === "string") return body.output_text.trim();
  const parts: string[] = [];
  for (const item of body?.output || []) {
    for (const c of item?.content || []) {
      if (typeof c?.text === "string") parts.push(c.text);
    }
  }
  return parts.join("").trim();
}

function anthropicOutputText(body: any): string {
  const parts: string[] = [];
  for (const c of body?.content || []) {
    if (typeof c?.text === "string") parts.push(c.text);
  }
  return parts.join("").trim();
}

export function normalizeUsage(usage: any): RawUsage | null {
  if (!usage) return null;
  const details = usage.prompt_tokens_details || usage.input_tokens_details;
  if (
    usage.prompt_tokens !== undefined ||
    usage.completion_tokens !== undefined ||
    usage.prompt_cache_hit_tokens !== undefined ||
    usage.prompt_cache_miss_tokens !== undefined
  ) {
    const hasCacheHit = usage.prompt_cache_hit_tokens !== undefined;
    const hasCacheMiss = usage.prompt_cache_miss_tokens !== undefined;
    const cacheHit = Number(usage.prompt_cache_hit_tokens ?? 0);
    const cacheMiss = Number(usage.prompt_cache_miss_tokens ?? 0);
    const cacheBreakdownTotal =
      (hasCacheHit || hasCacheMiss) &&
      Number.isFinite(cacheHit) &&
      Number.isFinite(cacheMiss)
        ? Math.max(0, cacheHit) + Math.max(0, cacheMiss)
        : undefined;
    const promptFromCacheBreakdown =
      hasCacheHit && hasCacheMiss ? cacheBreakdownTotal : undefined;
    const cached =
      details?.cached_tokens ??
      details?.cache_read_input_tokens ??
      usage.prompt_cache_hit_tokens;
    return {
      ...usage,
      // DeepSeek reports prompt_cache_hit_tokens + prompt_cache_miss_tokens as the
      // billable prompt total. Prefer that explicit billing split when present so
      // an OpenAI-compatible prompt_tokens total cannot double-count cached input.
      prompt_tokens:
        promptFromCacheBreakdown ?? usage.prompt_tokens ?? cacheBreakdownTotal,
      prompt_tokens_details:
        details || usage.prompt_cache_hit_tokens !== undefined
          ? {
              ...(details ?? {}),
              cached_tokens: cached,
              cache_creation_tokens:
                details?.cache_creation_tokens ??
                details?.cache_creation_input_tokens,
            }
          : usage.prompt_tokens_details,
    };
  }
  if (usage.input_tokens !== undefined || usage.output_tokens !== undefined) {
    const cacheRead =
      details?.cached_tokens ??
      details?.cache_read_input_tokens ??
      usage.cache_read_input_tokens;
    const cacheWrite =
      details?.cache_creation_tokens ??
      details?.cache_creation_input_tokens ??
      usage.cache_creation_input_tokens;
    return {
      // Anthropic-style input_tokens excludes prompt-cache read/write tokens;
      // store an OpenAI-style total so recordUsage can split it additively.
      prompt_tokens:
        Number(usage.input_tokens ?? 0) +
        Number(cacheRead ?? 0) +
        Number(cacheWrite ?? 0),
      completion_tokens: usage.output_tokens,
      prompt_tokens_details:
        cacheRead !== undefined || cacheWrite !== undefined
          ? { cached_tokens: cacheRead, cache_creation_tokens: cacheWrite }
          : undefined,
    };
  }
  return usage;
}

async function defaultProviderName(): Promise<ProviderName> {
  if (await moo.env.get({ name: "OPENAI_MODEL" })) return "openai";
  if (await moo.env.get({ name: "QWEN_MODEL" })) return "qwen";
  if (await moo.env.get({ name: "ANTHROPIC_MODEL" })) return "anthropic";
  if (await moo.env.get({ name: "XAI_MODEL" })) return "xai";
  if (await moo.env.get({ name: "DEEPSEEK_MODEL" })) return "deepseek";

  if (await moo.env.get({ name: "OPENAI_API_KEY" })) return "openai";
  if (await moo.env.get({ name: "ANTHROPIC_API_KEY" })) return "anthropic";
  if (
    (await moo.env.get({ name: "QWEN_API_KEY" })) ||
    (await moo.env.get({ name: "DASHSCOPE_API_KEY" }))
  )
    return "qwen";
  if (
    (await moo.env.get({ name: "XAI_API_KEY" })) ||
    (await moo.env.get({ name: "GROK_API_KEY" }))
  )
    return "xai";
  if (await moo.env.get({ name: "DEEPSEEK_API_KEY" })) return "deepseek";
  return "openai";
}

export async function resolveProvider(
  modelOverride?: string | null,
  effortOverride?: string | null,
  providerOverride?: string | null,
): Promise<LLMProvider> {
  const explicitProvider = String(providerOverride ?? "")
    .trim()
    .toLowerCase();
  const which =
    normalizeProviderName(explicitProvider) ||
    inferProviderForModel(modelOverride) ||
    (await defaultProviderName());
  if (which === "anthropic") {
    const configured = await providerConfiguredCredential("anthropic");
    return {
      name: "anthropic",
      apiKey: configured.apiKey,
      baseUrl: configured.baseUrl,
      model: modelOverride || configured.model,
      effort: normalizeEffort(effortOverride) || (await defaultEffort()),
      keyEnvHint: configured.keyEnvHint,
      authMode: configured.authMode,
    };
  }
  if (which === "qwen") {
    const configured = await providerConfiguredCredential("qwen");
    return {
      name: "qwen",
      apiKey: configured.apiKey,
      baseUrl: configured.baseUrl,
      model: modelOverride || configured.model,
      effort: null,
      keyEnvHint: configured.keyEnvHint,
      authMode: configured.authMode,
    };
  }
  if (which === "xai") {
    const configured = await providerConfiguredCredential("xai");
    return {
      name: "xai",
      apiKey: configured.apiKey,
      baseUrl: configured.baseUrl,
      model: modelOverride || configured.model,
      effort: null,
      keyEnvHint: configured.keyEnvHint,
      authMode: configured.authMode,
    };
  }
  if (which === "deepseek") {
    const configured = await providerConfiguredCredential("deepseek");
    return {
      name: "deepseek",
      apiKey: configured.apiKey,
      baseUrl: configured.baseUrl,
      model: modelOverride || configured.model,
      effort: normalizeEffort(effortOverride) || (await defaultEffort()),
      keyEnvHint: configured.keyEnvHint,
      authMode: configured.authMode,
    };
  }
  const configuredOpenAI = await providerConfiguredCredential("openai");
  return {
    name: "openai",
    apiKey: configuredOpenAI.apiKey,
    baseUrl: configuredOpenAI.baseUrl,
    model: modelOverride || configuredOpenAI.model,
    effort: normalizeEffort(effortOverride) || (await defaultEffort()),
    keyEnvHint: configuredOpenAI.keyEnvHint,
    authMode: configuredOpenAI.authMode,
    oauthAccountId: configuredOpenAI.oauthAccountId,
  };
}

export function parseSseDataEvents(
  chunkState: { buffer: string },
  chunk: string | null,
): string[] {
  if (chunk != null) chunkState.buffer += chunk;
  const out: string[] = [];
  while (true) {
    const normalized = chunkState.buffer.replace(/\r\n/g, "\n");
    const idx = normalized.indexOf("\n\n");
    if (idx < 0) break;
    const block = normalized.slice(0, idx);
    chunkState.buffer = normalized.slice(idx + 2);
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (data) out.push(data);
  }
  if (chunk == null && chunkState.buffer.trim()) {
    const data = chunkState.buffer
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    chunkState.buffer = "";
    if (data) out.push(data);
  }
  return out;
}

export function accumulateSummaryStreamEvent(
  state: {
    content: string;
    model: string | null;
    usage: any | null;
    error: any | null;
  },
  event: any,
  responsesApi: boolean,
) {
  if (!event || typeof event !== "object") return;
  if (event.error) {
    state.error = event.error;
    return;
  }
  if (typeof event.model === "string" && event.model) state.model = event.model;
  if (event.usage) state.usage = normalizeUsage(event.usage) ?? event.usage;

  if (
    event.type === "content_block_delta" &&
    typeof event.delta?.text === "string"
  )
    state.content += event.delta.text;
  if (
    event.type === "message_start" &&
    typeof event.message?.model === "string"
  )
    state.model = event.message.model;
  if (event.type === "message_delta" && event.usage)
    state.usage = normalizeUsage(event.usage) ?? event.usage;
  if (event.type === "error") state.error = event.error ?? event;

  if (responsesApi) {
    if (
      typeof event.delta === "string" &&
      (event.type === "response.output_text.delta" ||
        event.type === "output_text.delta")
    )
      state.content += event.delta;
    const response = event.response;
    if (response && typeof response === "object") {
      if (typeof response.model === "string") state.model = response.model;
      if (response.usage)
        state.usage = normalizeUsage(response.usage) ?? response.usage;
      if (event.type === "response.completed") {
        const finalText = responseOutputText(response).trim();
        if (finalText) state.content = finalText;
      }
      if (
        event.type === "response.failed" ||
        event.type === "response.incomplete"
      )
        state.error = response.error ?? response.incomplete_details ?? response;
    }
    return;
  }

  const choice = Array.isArray(event.choices) ? event.choices[0] : null;
  if (typeof choice?.delta?.content === "string")
    state.content += choice.delta.content;
  if (typeof choice?.message?.content === "string")
    state.content += choice.message.content;
}

type SummaryStreamSnapshot = { content: string; delta?: string };

type SummaryStreamOptions = {
  onContent?: (snapshot: SummaryStreamSnapshot) => void | Promise<void>;
};

function summaryStreamContent(provider: LLMProvider, content: string): string {
  return provider.name === "deepseek"
    ? stripDeepSeekThinkTags(content)
    : content;
}

async function notifySummaryStreamContent(
  provider: LLMProvider,
  state: { content: string },
  previousContent: string,
  options?: SummaryStreamOptions,
) {
  if (!options?.onContent) return;
  const content = summaryStreamContent(provider, state.content);
  if (content === previousContent) return;
  const delta = content.startsWith(previousContent)
    ? content.slice(previousContent.length)
    : undefined;
  await options.onContent(compactObject({ content, delta }));
}

async function callStreamingChatSummary(
  provider: LLMProvider,
  messages: any[],
  tools: any[] | null,
  options?: SummaryStreamOptions,
) {
  const request = buildStreamingLLMRequest(provider, messages, tools);
  return await traceSpan(
    "llm.stream.fetch",
    {
      provider: provider.name,
      model: provider.model,
      effort: request.requestEffort,
      url: request.url,
      responsesApi: request.responsesApi,
      ...messagesForTrace(messages, tools),
      request: llmBodyForTrace(request.body),
    },
    async () => {
      const stream = await moo.http.stream({
        method: "POST",
        url: request.url,
        headers: request.headers,
        body: request.body,
      });
      const chunks: string[] = [];
      const sse = { buffer: "" };
      const state: {
        content: string;
        model: string | null;
        usage: any | null;
        error: any | null;
      } = { content: "", model: null, usage: null, error: null };
      try {
        while (true) {
          const chunk = await stream.next();
          if (chunk == null) break;
          if (stream.status >= 400) {
            chunks.push(chunk);
            continue;
          }
          for (const data of parseSseDataEvents(sse, chunk)) {
            if (data === "[DONE]") continue;
            try {
              const previousContent = summaryStreamContent(
                provider,
                state.content,
              );
              accumulateSummaryStreamEvent(
                state,
                JSON.parse(data),
                !!request.responsesApi,
              );
              await notifySummaryStreamContent(
                provider,
                state,
                previousContent,
                options,
              );
            } catch {
              // Ignore non-JSON SSE frames; providers sometimes send comments or diagnostics.
            }
          }
        }
        if (stream.status >= 400)
          return {
            status: stream.status,
            body: chunks.join(""),
            headers: stream.headers,
          };
        for (const data of parseSseDataEvents(sse, null)) {
          if (data === "[DONE]") continue;
          try {
            const previousContent = summaryStreamContent(
              provider,
              state.content,
            );
            accumulateSummaryStreamEvent(
              state,
              JSON.parse(data),
              !!request.responsesApi,
            );
            await notifySummaryStreamContent(
              provider,
              state,
              previousContent,
              options,
            );
          } catch {
            /* ignore */
          }
        }
        if (state.error)
          return {
            status: stream.status || 500,
            body: JSON.stringify({ error: state.error }),
            headers: stream.headers,
          };
        return {
          status: stream.status,
          headers: stream.headers,
          body: JSON.stringify({
            model: state.model || provider.model,
            usage: normalizeUsage(state.usage),
            choices: [
              {
                message: {
                  content:
                    provider.name === "deepseek"
                      ? stripDeepSeekThinkTags(state.content)
                      : state.content,
                },
              },
            ],
          }),
        };
      } finally {
        await stream.close();
      }
    },
  );
}

// -- usage tracking -------------------------------------------------------
//
// Per-chat token totals, grouped by model. Stored as JSON at
// `chat/{id}/usage`; the chats listing reads it and multiplies by the
// pricing table to expose a per-chat cost in the sidebar.
export type RawUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_creation_tokens?: number;
  };
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  estimated?: boolean;
};

export type LlmStreamProgress = {
  estimatedPromptTokens: number;
  tokenBudget: number;
  tokenThreshold: number;
  availableTokens?: number;
  compactionsInARow?: number;
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  source?: string;
  estimated?: boolean;
  reset?: boolean;
};

export type LlmDraftEventKind = "draft" | "compaction-draft";

export type LastTokenPressure = {
  used: number;
  source: "context" | "compaction" | "none";
};

export function llmStreamEventOptions(
  chatId: string,
  draftId: string,
  tokenProgress?: LlmStreamProgress | null,
  options: { draftKind?: LlmDraftEventKind } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { chatId };
  if (tokenProgress) Object.assign(out, tokenProgress);
  const model = typeof out.model === "string" ? out.model.trim() : "";
  const effort = typeof out.effort === "string" ? out.effort.trim() : "";
  if (draftId)
    out.draftEvent = {
      kind: options.draftKind ?? "draft",
      chatId,
      draftId,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    };
  if (tokenProgress) {
    out.tokenProgressEvent = {
      kind: "tokens",
      chatId,
      budget: tokenProgress.tokenBudget,
      threshold: tokenProgress.tokenThreshold,
      availableTokens: tokenProgress.availableTokens,
      compactionsInARow: tokenProgress.compactionsInARow,
      estimated: tokenProgress.estimated ?? true,
      source: tokenProgress.source,
      reset: tokenProgress.reset,
    };
  }
  return out;
}

function contextTokensFromUsage(
  usage: RawUsage | null | undefined,
): number | null {
  const prompt = Number(usage?.prompt_tokens ?? 0);
  const completion = Number(usage?.completion_tokens ?? 0);
  const used = prompt + completion;
  return Number.isFinite(used) && used > 0 ? used : null;
}

export async function tokenUsageEvent(
  chatId: string,
  usage: RawUsage | null | undefined,
  provider?:
    | (Pick<LLMProvider, "name" | "model"> &
        Partial<Pick<LLMProvider, "authMode">>)
    | null,
) {
  const used = contextTokensFromUsage(usage);
  if (used == null) return null;
  const estimated = usage?.estimated === true;
  const budget = await contextBudget(provider);
  const threshold = await compactionThresholdForBudget(budget);
  return {
    kind: "tokens",
    chatId,
    used,
    budget,
    threshold,
    fraction: budget > 0 ? used / budget : 0,
    usage,
    estimated,
    source: "context",
  };
}

export function tokenPressureEvent(
  chatId: string,
  used: number,
  options: {
    budget: number;
    threshold: number;
    availableTokens?: number;
    compactionsInARow?: number;
    source?: "context" | "compaction";
    estimated?: boolean;
    reset?: boolean;
  },
) {
  const budget = Math.max(0, Math.floor(Number(options.budget) || 0));
  const threshold = Math.max(0, Math.floor(Number(options.threshold) || 0));
  const n = tokenCountOrZero(used);
  return {
    kind: "tokens",
    chatId,
    used: n,
    budget,
    threshold,
    availableTokens:
      options.availableTokens == null
        ? Math.max(0, threshold - n)
        : tokenCountOrZero(options.availableTokens),
    compactionsInARow:
      options.compactionsInARow == null
        ? undefined
        : tokenCountOrZero(options.compactionsInARow),
    fraction: budget > 0 ? n / budget : 0,
    source: options.source,
    estimated: options.estimated,
    reset: options.reset,
  };
}

export type ChatUsage = {
  models: Record<
    string,
    {
      input: number;
      cachedInput: number;
      cacheWriteInput?: number;
      output: number;
    }
  >;
  // Most recent context-pressure count (prompt + generated completion), used
  // to drive the header bar. The provider's number is far more accurate than
  // our chars/4 estimate (which misses tool schemas, array content, and images).
  lastContextTokens?: number;
  // Most recent prompt size used by the automatic compaction trigger. This can
  // exceed the provider request context because compaction includes persisted
  // tool/file-diff payloads that are not all sent in the ordinary reply prompt.
  lastCompactionPromptTokens?: number;
  // Number of compaction summaries generated back-to-back without a normal
  // assistant reply or a new user turn completing between them.
  consecutiveCompactions?: number;
};

function normalizeChatUsage(value: unknown): ChatUsage {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { models: {} };
  const usage = value as Partial<ChatUsage>;
  usage.models =
    usage.models &&
    typeof usage.models === "object" &&
    !Array.isArray(usage.models)
      ? usage.models
      : {};
  return usage as ChatUsage;
}

function readChatUsageTarget(target: string | null): ChatUsage {
  if (!target) return { models: {} };
  const inline = decodeJsonPointer<ChatUsage>(target);
  return inline && typeof inline === "object" && !Array.isArray(inline)
    ? normalizeChatUsage(inline)
    : { models: {} };
}

async function writeChatUsageTarget(
  ref: string,
  usage: ChatUsage,
): Promise<void> {
  await moo.pointers.set({ name: ref, target: encodeJsonPointer(usage) });
}

export async function recordUsage(
  chatId: string,
  model: string | null,
  usage: RawUsage | null | undefined,
  options: {
    updateLastContextTokens?: boolean;
    compactionPromptTokens?: number | null;
  } = {},
): Promise<void> {
  if (!usage || !model) return;
  const promptTotal = Number(usage.prompt_tokens ?? 0);
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? 0);
  const cacheWrite = Number(
    usage.prompt_tokens_details?.cache_creation_tokens ?? 0,
  );
  const output = Number(usage.completion_tokens ?? 0);
  const cacheMiss = Number(usage.prompt_cache_miss_tokens);
  const regularInput = Number.isFinite(cacheMiss)
    ? Math.max(0, cacheMiss)
    : Math.max(0, promptTotal - cached - cacheWrite);
  if (!promptTotal && !cached && !cacheWrite && !regularInput && !output)
    return;
  const ref = chatRefs(chatId).usage;
  const current = readChatUsageTarget(await moo.pointers.get({ name: ref }));
  const usageModel = modelLongContextUsageKey(model, promptTotal) || model;
  const slot = current.models[usageModel] ?? {
    input: 0,
    cachedInput: 0,
    cacheWriteInput: 0,
    output: 0,
  };
  if (slot.cacheWriteInput == null) slot.cacheWriteInput = 0;
  // Keep `input` as regular, non-cache-read/write input so cost math stays additive.
  // DeepSeek exposes prompt_cache_miss_tokens directly; prefer it over deriving
  // miss tokens from prompt_tokens if both cache counters are present.
  slot.input += regularInput;
  slot.cachedInput += Math.max(0, cached);
  slot.cacheWriteInput += Math.max(0, cacheWrite);
  slot.output += output;
  current.models[usageModel] = slot;
  const contextTotal = promptTotal + Math.max(0, output);
  await traceMark("usage.record", {
    chatId,
    model: usageModel,
    input: regularInput,
    cachedInput: Math.max(0, cached),
    cacheWriteInput: Math.max(0, cacheWrite),
    output,
  });
  if (options.updateLastContextTokens !== false && contextTotal > 0)
    current.lastContextTokens = contextTotal;
  if (options.compactionPromptTokens != null)
    current.lastCompactionPromptTokens = tokenCountOrZero(
      options.compactionPromptTokens,
    );
  await writeChatUsageTarget(ref, current);
}

function tokenCountOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function readableTokenCount(value: unknown): string {
  const text = String(tokenCountOrZero(value));
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

async function readChatUsage(
  chatId: string,
): Promise<{ ref: string; current: ChatUsage }> {
  const ref = chatRefs(chatId).usage;
  const current = readChatUsageTarget(await moo.pointers.get({ name: ref }));
  return { ref, current };
}

export async function recordLastContextTokens(
  chatId: string,
  tokens: number,
  options: {
    compactionPromptTokens?: number | null;
    consecutiveCompactions?: number | null;
  } = {},
): Promise<void> {
  const { ref, current } = await readChatUsage(chatId);
  current.lastContextTokens = tokenCountOrZero(tokens);
  if (options.compactionPromptTokens != null)
    current.lastCompactionPromptTokens = tokenCountOrZero(
      options.compactionPromptTokens,
    );
  if (options.consecutiveCompactions != null)
    current.consecutiveCompactions = tokenCountOrZero(
      options.consecutiveCompactions,
    );
  await writeChatUsageTarget(ref, current);
}

export function estimateCompactionSummaryTokens(
  summary: string | null | undefined,
): number {
  const text = typeof summary === "string" ? summary.trim() : "";
  return text ? tokenCountOrZero(Math.ceil(text.length / 4)) : 0;
}

export async function recordLastCompactionPromptTokens(
  chatId: string,
  tokens: number,
): Promise<void> {
  const { ref, current } = await readChatUsage(chatId);
  current.lastCompactionPromptTokens = tokenCountOrZero(tokens);
  await writeChatUsageTarget(ref, current);
}

export async function readLastContextTokens(chatId: string): Promise<number> {
  const ref = chatRefs(chatId).usage;
  const current = readChatUsageTarget(await moo.pointers.get({ name: ref }));
  return tokenCountOrZero(current.lastContextTokens ?? 0);
}

export async function readLastTokenPressure(
  chatId: string,
): Promise<LastTokenPressure> {
  const ref = chatRefs(chatId).usage;
  const current = readChatUsageTarget(await moo.pointers.get({ name: ref }));
  const context = tokenCountOrZero(current.lastContextTokens ?? 0);
  const compaction = tokenCountOrZero(current.lastCompactionPromptTokens ?? 0);
  if (compaction > context) return { used: compaction, source: "compaction" };
  if (context > 0) return { used: context, source: "context" };
  if (compaction > 0) return { used: compaction, source: "compaction" };
  return { used: 0, source: "none" };
}

export async function readConsecutiveCompactions(
  chatId: string,
): Promise<number> {
  const ref = chatRefs(chatId).usage;
  const current = readChatUsageTarget(await moo.pointers.get({ name: ref }));
  return tokenCountOrZero(current.consecutiveCompactions ?? 0);
}

export async function recordConsecutiveCompactions(
  chatId: string,
  count: number,
): Promise<void> {
  const { ref, current } = await readChatUsage(chatId);
  current.consecutiveCompactions = tokenCountOrZero(count);
  await writeChatUsageTarget(ref, current);
}

export async function resetConsecutiveCompactions(chatId: string): Promise<void> {
  await recordConsecutiveCompactions(chatId, 0);
}

export function estimateRawUsage(
  messages: any[] | null | undefined,
  outputText: string | null | undefined,
  promptEstimate?: number | null,
): RawUsage | null {
  const fallbackPrompt = Number(promptEstimate ?? 0);
  const hasPromptEstimate =
    Number.isFinite(fallbackPrompt) && fallbackPrompt > 0;
  const prompt = hasPromptEstimate
    ? Math.max(0, fallbackPrompt)
    : Array.isArray(messages)
      ? estimateTokens(messages)
      : 0;
  const completion =
    typeof outputText === "string" && outputText
      ? Math.ceil(outputText.length / 4)
      : 0;
  if (!prompt && !completion) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    estimated: true,
  };
}

// -- compaction ------------------------------------------------------------

type CompactionPointerValue = {
  summary?: string;
  throughAt?: number;
  at?: number;
  parent?: string | null;
  hash?: string | null;
  draftId?: string | null;
  trigger?: string | null;
  promptTokens?: number | null;
  postPromptTokens?: number | null;
  summaryTokens?: number | null;
  tokenBudget?: number | null;
  tokenThreshold?: number | null;
  availableTokens?: number | null;
  compactionsInARow?: number | null;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readCompactionPointerTarget(
  target: string | null,
): { target: string; hash: string; value: CompactionPointerValue } | null {
  if (!target) return null;
  const inline = decodeJsonPointer<CompactionPointerValue>(target);
  if (!isObjectRecord(inline)) return null;
  const hash =
    typeof inline.hash === "string" && inline.hash.trim()
      ? inline.hash.trim()
      : null;
  if (!hash) return null;
  return { target, hash, value: inline };
}

async function readCompactionLayerHash(
  hash: string | null | undefined,
): Promise<{
  target: string;
  hash: string;
  value: CompactionPointerValue;
} | null> {
  if (!hash || !moo.validate.hash({ hash: hash })) return null;
  const obj = await moo.objects.getJSON<CompactionPointerValue>({ hash });
  if (!isObjectRecord(obj?.value)) return null;
  return { target: hash, hash, value: { ...obj.value, hash } };
}

export async function latestUserInputAt(chatId: string): Promise<number> {
  const c = chatRefs(chatId);
  const rows = await moo.facts.matchAll({
    patterns: [
      ["?step", "rdf:type", "agent:Step"],
      ["?step", "agent:kind", "agent:UserInput"],
      ["?step", "agent:createdAt", "?at"],
    ],
    store: c.facts,
    graph: c.graph,
  });
  let last = 0;
  for (const row of rows) { const at = Number(row["?at"]) || 0; if (at > last) last = at; }
  return last;
}

async function readCompaction(chatId: string): Promise<{
  throughAt: number;
  summary: string | null;
  hash: string | null;
}> {
  const layer = readCompactionPointerTarget(
    await moo.pointers.get({ name: chatRefs(chatId).compaction }),
  );
  if (!layer) return { throughAt: 0, summary: null, hash: null };
  return {
    throughAt: layer.value.throughAt ?? 0,
    summary: layer.value.summary ?? null,
    hash: layer.hash,
  };
}

export async function persistCompactionLayer(
  chatId: string,
  layer: Omit<CompactionPointerValue, "parent" | "hash"> & {
    summary: string;
    throughAt: number;
    at: number;
  },
): Promise<string> {
  const ref = chatRefs(chatId).compaction;
  const parent =
    readCompactionPointerTarget(await moo.pointers.get({ name: ref }))?.hash ??
    null;
  const value: CompactionPointerValue = { ...layer, parent };
  const hash = await moo.objects.putJSON({ kind: "agent:Compaction", value });
  await moo.pointers.set({
    name: ref,
    target: encodeJsonPointer({ ...value, hash }),
  });
  return hash;
}

export async function patchCompactionLayerPostTokens(
  chatId: string,
  _hash: string,
  postPromptTokens: number,
): Promise<string | null> {
  const ref = chatRefs(chatId).compaction;
  const current = readCompactionPointerTarget(
    await moo.pointers.get({ name: ref }),
  );
  if (!current) return null;
  const { hash: _oldHash, ...rest } = current.value;
  const patched: CompactionPointerValue = { ...rest, postPromptTokens };
  const newHash = await moo.objects.putJSON({
    kind: "agent:Compaction",
    value: patched,
  });
  await moo.pointers.set({
    name: ref,
    target: encodeJsonPointer({ ...patched, hash: newHash }),
  });
  return newHash;
}

async function deletedUserInputSteps(
  chatId: string,
): Promise<Array<{ step: string; at: number }>> {
  const c = chatRefs(chatId);
  const rows = await moo.facts.matchAll({
    patterns: [
      ["?step", "rdf:type", "agent:Step"],
      ["?step", "agent:kind", "agent:UserInput"],
      ["?step", "agent:createdAt", "?at"],
      ["?step", "agent:deletedAt", "?deletedAt"],
    ],
    ...{ store: c.facts, graph: c.graph },
  });
  return rows
    .map((row) => ({ step: row["?step"]!, at: Number(row["?at"]) || 0 }))
    .filter((row) => row.step);
}
// Walk the compaction chain newest → oldest. Useful for audit and for the UI;
// `buildLLMMessages` only uses the head summary because each layer subsumes
// everything below it.
export async function readCompactionChain(chatId: string) {
  const out: Array<{
    hash: string;
    summary: string;
    throughAt: number;
    at: number;
    parent: string | null;
    trigger?: string | null;
    draftId?: string | null;
    promptTokens?: number | null;
    postPromptTokens?: number | null;
    summaryTokens?: number | null;
    tokenBudget?: number | null;
    tokenThreshold?: number | null;
    availableTokens?: number | null;
    compactionsInARow?: number | null;
  }> = [];
  let layer: {
    target: string;
    hash: string;
    value: CompactionPointerValue;
  } | null = readCompactionPointerTarget(
    await moo.pointers.get({ name: chatRefs(chatId).compaction }),
  );
  const seen = new Set<string>();
  while (layer && !seen.has(layer.hash)) {
    seen.add(layer.hash);
    out.push({
      hash: layer.hash,
      summary: layer.value.summary || "",
      throughAt: layer.value.throughAt || 0,
      at: layer.value.at || 0,
      parent: layer.value.parent ?? null,
      trigger: layer.value.trigger ?? null,
      draftId: layer.value.draftId ?? null,
      promptTokens: layer.value.promptTokens ?? null,
      postPromptTokens: layer.value.postPromptTokens ?? null,
      summaryTokens: layer.value.summaryTokens ?? null,
      tokenBudget: layer.value.tokenBudget ?? null,
      tokenThreshold: layer.value.tokenThreshold ?? null,
      availableTokens: layer.value.availableTokens ?? null,
      compactionsInARow: layer.value.compactionsInARow ?? null,
    });
    layer = await readCompactionLayerHash(layer.value.parent);
  }
  return out;
}

export type CompactionTracking = {
  trigger?: "automatic" | "manual";
  promptTokens?: number | null;
  summaryTokens?: number | null;
  tokenBudget?: number | null;
  tokenThreshold?: number | null;
  status?: number | null;
  message?: string | null;
  type?: string | null;
  code?: string | null;
  requestId?: string | null;
  retryAfter?: string | null;
  hint?: string | null;
  body?: unknown;
  provider?: string | null;
  requestPromptTokens?: number | null;
  requestTokenLimit?: number | null;
  availableTokens?: number | null;
  compactionsInARow?: number | null;
  model?: string | null;
  effort?: string | null;
  draftId?: string | null;
};

function compactionExtras(
  meta: CompactionTracking | undefined,
  model?: string | null,
  effort?: string | null,
): Array<[string, string]> {
  const extras = modelExtras(model, effort);
  const trigger =
    meta?.trigger === "manual" ? "agent:Manual" : "agent:Automatic";
  extras.push(["agent:trigger", trigger]);
  if (meta?.promptTokens != null)
    extras.push(["agent:promptTokens", String(meta.promptTokens)]);
  if (meta?.summaryTokens != null)
    extras.push(["agent:summaryTokens", String(meta.summaryTokens)]);
  if (meta?.tokenBudget != null)
    extras.push(["agent:tokenBudget", String(meta.tokenBudget)]);
  if (meta?.tokenThreshold != null)
    extras.push(["agent:tokenThreshold", String(meta.tokenThreshold)]);
  if (meta?.availableTokens != null)
    extras.push(["agent:availableTokens", String(meta.availableTokens)]);
  if (meta?.compactionsInARow != null)
    extras.push(["agent:compactionsInARow", String(meta.compactionsInARow)]);
  return extras;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if ((value as Record<string, unknown>)[key] == null)
      delete (value as Record<string, unknown>)[key];
  }
  return value;
}

export async function recordCompactionFailure(
  chatId: string,
  reason: string,
  meta: CompactionTracking = {},
): Promise<void> {
  const trigger = meta.trigger ?? "automatic";
  const detail = compactObject({
    source: "compaction",
    phase: "compaction",
    status: meta.status,
    message: meta.message || reason,
    type: meta.type,
    code: meta.code,
    requestId: meta.requestId,
    retryAfter: meta.retryAfter,
    hint: meta.hint,
    body: meta.body,
    provider: meta.provider,
    model: meta.model,
    effort: meta.effort,
    trigger,
    promptTokens: meta.promptTokens,
    tokenBudget: meta.tokenBudget,
    tokenThreshold: meta.tokenThreshold,
    requestPromptTokens: meta.requestPromptTokens,
    requestTokenLimit: meta.requestTokenLimit,
    availableTokens: meta.availableTokens,
    compactionsInARow: meta.compactionsInARow,
  });
  const payloadHash = await moo.objects.putJSON({
    kind: "agent:Error",
    value: compactObject({
      kind: "compaction",
      phase: "compaction",
      reason,
      trigger,
      ...meta,
      detail,
      at: await moo.time.nowMs({}),
    }),
  });
  await appendStep(chatId, {
    kind: "agent:Error",
    status: "agent:Failed",
    payloadHash,
    extras: [
      ["agent:phase", "agent:Compaction"],
      ...compactionExtras({ ...meta, trigger }, meta.model, meta.effort),
    ],
  });
}

function parseCompactionProviderErrorBody(raw: unknown): any {
  if (raw == null) return null;
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function compactionProviderErrorMessage(parsed: any, status: number): string {
  const candidates = [
    parsed?.error?.message,
    typeof parsed?.error === "string" ? parsed.error : "",
    parsed?.message,
    parsed?.detail?.message,
    typeof parsed?.detail === "string" ? parsed.detail : "",
    parsed?.details,
    parsed?.error_description,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim())
      return candidate.trim();
  }
  if (typeof parsed === "string" && parsed.trim() && parsed.trim() !== "error")
    return parsed.trim();
  if (status >= 400) return `request failed with HTTP ${status}`;
  return "provider request failed";
}

function compactionProviderErrorType(parsed: any): string | null {
  return parsed?.error?.type ?? parsed?.type ?? null;
}

function compactionProviderErrorCode(parsed: any): string | null {
  return parsed?.error?.code ?? parsed?.code ?? null;
}

function providerErrorRequestId(parsed: any, headers: unknown): string | null {
  return (
    firstHeader(
      headers,
      "request-id",
      "x-request-id",
      "anthropic-request-id",
      "cf-ray",
    ) ||
    stringField(parsed?.request_id) ||
    stringField(parsed?.requestId) ||
    stringField(parsed?.error?.request_id) ||
    stringField(parsed?.error?.requestId)
  );
}

function providerErrorRetryAfter(headers: unknown, parsed: any): string | null {
  return (
    firstHeader(
      headers,
      "retry-after",
      "x-ratelimit-reset",
      "anthropic-ratelimit-requests-reset",
    ) ||
    stringField(parsed?.retry_after) ||
    stringField(parsed?.retryAfter) ||
    stringField(parsed?.error?.retry_after) ||
    stringField(parsed?.error?.retryAfter)
  );
}

function stringField(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function firstHeader(headers: unknown, ...names: string[]): string | null {
  if (!headers || typeof headers !== "object") return null;
  const map = headers as Record<string, unknown>;
  for (const name of names) {
    const direct = headerValue(map[name]);
    if (direct) return direct;
    const lower = name.toLowerCase();
    const match = Object.keys(map).find((key) => key.toLowerCase() === lower);
    if (match) {
      const value = headerValue(map[match]);
      if (value) return value;
    }
  }
  return null;
}

function headerValue(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = stringField(item);
      if (text) return text;
    }
    return null;
  }
  return stringField(value);
}

function compactionProviderErrorBodyForRecord(parsed: any, raw: unknown): any {
  if (parsed != null) return parsed;
  if (raw == null) return "";
  return raw;
}

export function hasCompactionTranscript(messages: any[]): boolean {
  return messages.some((m) => {
    if (m?.role === "system") return false;
    const text = contentText(m?.content).trim();
    return !!text;
  });
}

export type CompactionResult = "compacted" | "empty" | "failed";

export function compactionThroughAt(
  trigger: "automatic" | "manual" | null | undefined,
  lastUserAt: number,
  now: number,
): number {
  if (trigger === "automatic" && lastUserAt > 0)
    return Math.max(0, lastUserAt - 1);
  return now;
}

export async function runCompaction(
  chatId: string,
  provider: LLMProvider,
  meta: CompactionTracking = {},
): Promise<CompactionResult> {
  const requestProvider = compactionProviderForRequest(provider);
  const messages = await buildCompactionMessages(chatId);
  if (!hasCompactionTranscript(messages)) return "empty";

  const rawSummaryMessages = buildCompactionSummaryPromptMessages(messages);
  const rawPromptTokens = estimateTokens(rawSummaryMessages);
  const budget = meta.tokenBudget ?? (await contextBudget(provider));
  const threshold =
    meta.tokenThreshold ?? (await compactionThresholdForBudget(budget));
  const requestTokenLimit = compactionRequestTokenLimit(budget, threshold);
  const summaryMessages = fitCompactionSummaryMessages(
    rawSummaryMessages,
    requestTokenLimit,
  );
  const requestPromptTokens = estimateTokens(summaryMessages);
  const availableTokens = Math.max(0, threshold - rawPromptTokens);
  const compactionsInARow = Math.max(
    1,
    (await readConsecutiveCompactions(chatId)) + 1,
  );
  const tracking: CompactionTracking = compactObject({
    ...meta,
    trigger: meta.trigger ?? "manual",
    promptTokens: meta.promptTokens ?? rawPromptTokens,
    tokenBudget: meta.tokenBudget ?? budget,
    tokenThreshold: meta.tokenThreshold ?? threshold,
    requestPromptTokens,
    requestTokenLimit,
    availableTokens: meta.availableTokens ?? availableTokens,
    compactionsInARow: meta.compactionsInARow ?? compactionsInARow,
    provider: meta.provider ?? requestProvider.name,
    model: meta.model ?? requestProvider.model,
    effort: meta.effort ?? requestProvider.effort,
  });
  await traceMark("compaction.request.prepared", {
    chatId,
    trigger: tracking.trigger,
    rawPromptTokens,
    requestPromptTokens,
    requestTokenLimit,
    tokenBudget: budget,
    tokenThreshold: threshold,
    availableTokens,
    compactionsInARow,
    requestEffort: requestProvider.effort,
    truncated: requestPromptTokens < rawPromptTokens,
  });

  const draftId =
    typeof tracking.draftId === "string" && tracking.draftId
      ? tracking.draftId
      : null;
  const resp = await callStreamingChatSummary(
    requestProvider,
    summaryMessages,
    null,
    draftId
      ? {
          onContent: ({ content, delta }) => {
            moo.events.publish({
              payload: compactObject({
                kind: "compaction-draft",
                chatId,
                draftId,
                content,
                delta,
              }),
            });
          },
        }
      : undefined,
  );
  if (resp.status >= 400) {
    const parsed = parseCompactionProviderErrorBody(resp.body);
    await recordCompactionFailure(
      chatId,
      `provider returned HTTP ${resp.status}`,
      {
        ...tracking,
        status: resp.status,
        message: compactionProviderErrorMessage(parsed, resp.status),
        type: compactionProviderErrorType(parsed),
        code: compactionProviderErrorCode(parsed),
        requestId: providerErrorRequestId(parsed, resp.headers),
        retryAfter: providerErrorRetryAfter(resp.headers, parsed),
        body: compactionProviderErrorBodyForRecord(parsed, resp.body),
      },
    );
    return "failed";
  }
  let body: any;
  try {
    body = JSON.parse(resp.body);
  } catch {
    await recordCompactionFailure(
      chatId,
      "provider returned invalid JSON",
      tracking,
    );
    return "failed";
  }
  const summary: string | undefined =
    body?.choices?.[0]?.message?.content?.trim();
  if (!summary) {
    await recordCompactionFailure(
      chatId,
      "provider returned an empty summary",
      tracking,
    );
    return "failed";
  }
  await recordUsage(
    chatId,
    body?.model || requestProvider.model,
    normalizeUsage(body?.usage) ?? estimateRawUsage(summaryMessages, summary),
    { updateLastContextTokens: false },
  );

  const now = await moo.time.nowMs({});
  const lastUserAt = await latestUserInputAt(chatId);
  const throughAt = compactionThroughAt(tracking.trigger, lastUserAt, now);
  const summaryTokens = estimateCompactionSummaryTokens(summary);
  const compactionHash = await persistCompactionLayer(chatId, {
    summary,
    summaryTokens,
    draftId,
    throughAt,
    at: now,
    trigger: tracking.trigger ?? "manual",
    promptTokens: tracking.promptTokens ?? null,
    tokenBudget: tracking.tokenBudget ?? null,
    tokenThreshold: tracking.tokenThreshold ?? null,
    availableTokens: tracking.availableTokens ?? null,
    compactionsInARow: tracking.compactionsInARow ?? null,
  });
  const postMessages = await buildLLMMessages(chatId);
  const postContextTokens = estimateTokens(postMessages, TOOLS);
  const postPressureTokens = await estimateCompactionPromptTokens(
    chatId,
    postMessages,
  );
  const patchedCompactionHash =
    (await patchCompactionLayerPostTokens(
      chatId,
      compactionHash,
      postPressureTokens,
    )) ?? compactionHash;
  await appendStep(chatId, {
    kind: "agent:Compaction",
    status: "agent:Done",
    payloadHash: patchedCompactionHash,
    extras: compactionExtras(
      tracking,
      body?.model || requestProvider.model,
      requestProvider.effort,
    ),
  });
  await recordLastContextTokens(chatId, postContextTokens, {
    compactionPromptTokens: postPressureTokens,
    consecutiveCompactions: tokenCountOrZero(tracking.compactionsInARow),
  });
  await recordConsecutiveCompactions(
    chatId,
    tokenCountOrZero(tracking.compactionsInARow),
  );
  moo.events.publish({
    payload: tokenPressureEvent(chatId, postPressureTokens, {
      budget,
      threshold,
      availableTokens: Math.max(0, threshold - postPressureTokens),
      compactionsInARow: tokenCountOrZero(tracking.compactionsInARow),
      source: "compaction",
      estimated: true,
      reset: true,
    }),
  });
  await traceMark("compaction.post_pressure", {
    chatId,
    postContextTokens,
    postPressureTokens,
    budget,
    threshold,
    trigger: tracking.trigger ?? "manual",
  });
  return "compacted";
}

// -- messages --------------------------------------------------------------

export async function buildLLMMessages(chatId: string): Promise<any[]> {
  const c = chatRefs(chatId);
  const compaction = await readCompaction(chatId);
  const deletedSteps = await deletedUserInputSteps(chatId);
  const deletedStepIds = new Set(deletedSteps.map((row) => row.step));
  const summaryMayContainDeletedUserInput = deletedSteps.some(
    (row) => row.at > 0 && row.at <= compaction.throughAt,
  );

  const steps = await moo.facts.matchAll({
    patterns: [
      ["?step", "rdf:type", "agent:Step"],
      ["?step", "agent:kind", "?kind"],
      ["?step", "agent:status", "?status"],
      ["?step", "agent:createdAt", "?at"],
    ],
    ...{ store: c.facts, graph: c.graph },
  });

  const responses = await moo.facts.matchAll({
    patterns: [
      ["?resp", "rdf:type", "ui:InputResponse"],
      ["?resp", "ui:respondsTo", "?req"],
      ["?resp", "ui:createdAt", "?at"],
    ],
    ...{ store: c.facts, graph: c.graph },
  });

  type Entry = {
    at: number;
    role: "user" | "assistant" | "system";
    content: any;
  };
  const entries: Entry[] = [];

  for (const s of steps) {
    const at = Number(s["?at"]);
    if (at <= compaction.throughAt) continue;
    if (s["?kind"] === "agent:UserInput") {
      if (deletedStepIds.has(s["?step"]!)) continue;
      const p = await loadPayloadJSON(c.facts, c.graph, s["?step"]!);
      const text = p?.value?.message || "";
      const attachments = Array.isArray(p?.value?.attachments)
        ? p.value.attachments
        : [];
      if (attachments.length) {
        entries.push({
          at,
          role: "user",
          content: [
            { type: "text", text: text || "Please inspect this image." },
            ...attachments
              .filter(
                (a: any) =>
                  a?.type === "image" && typeof a.dataUrl === "string",
              )
              .map((a: any) => ({
                type: "image_url",
                image_url: { url: a.dataUrl },
              })),
          ],
        });
      } else if (text) {
        entries.push({ at, role: "user", content: text });
      }
    } else if (s["?kind"] === "agent:Reply") {
      const p = await loadPayloadJSON(c.facts, c.graph, s["?step"]!);
      const text = p?.value?.text;
      if (text) entries.push({ at, role: "assistant", content: text });
    } else {
      const text = await formatStepForLLMContext(c.facts, c.graph, {
        step: s["?step"]!,
        kind: s["?kind"]!,
        status: s["?status"] ?? "",
        at,
      });
      if (text)
        entries.push({ at, role: "system", content: toolContextMessage(text) });
    }
  }

  for (const r of responses) {
    const at = Number(r["?at"]);
    if (at <= compaction.throughAt) continue;
    const reqId = r["?req"]!;
    const spec = await loadPayloadJSON(c.facts, c.graph, reqId, "ui:payload");
    const payload = await loadPayloadJSON(
      c.facts,
      c.graph,
      r["?resp"]!,
      "ui:payload",
    );
    const values = payload?.value?.values ?? {};
    const title = spec?.value?.title || "form";
    const cancelled = payload?.value?.cancelled === true;
    entries.push({
      at,
      role: "user",
      content: cancelled
        ? `(cancelled ${title})`
        : `(answer to ${title}) ${formatHjson(values, "", 80)}`,
    });
  }

  entries.sort((a, b) => a.at - b.at);

  const compactionSummary =
    compaction.summary && !summaryMayContainDeletedUserInput
      ? compaction.summary
      : null;
  const hasPostCompactionConversation = entries.some(
    (entry) => entry.role !== "system",
  );
  const messages: any[] = [
    { role: "system", content: await buildSystemPrompt(chatId) },
  ];
  if (compactionSummary) {
    messages.push({
      role: "system",
      content: compactionContinuationSystemMessage(
        compactionSummary,
        await formatTodosForPrompt(chatId),
      ),
    });
  }
  for (const e of entries) messages.push({ role: e.role, content: e.content });
  // Automatic compaction can leave only system messages in the next request;
  // add an explicit user turn so providers do not fall back to generic "Continue."
  // prompts that tend to produce acknowledgement-only replies.
  if (compactionSummary && !hasPostCompactionConversation) {
    messages.push({
      role: "user",
      content: COMPACTION_CONTINUATION_USER_PROMPT,
    });
  }
  return messages;
}

const LLM_CONTEXT_STEP_KINDS = new Set([
  "agent:RunTS",
  "agent:Subagent",
  "agent:ShellCommand",
  "agent:Error",
]);

function toolContextMessage(text: string): string {
  return [
    "Internal tool transcript for context only; do not quote, imitate, or present this format to the user.",
    text,
  ].join("\n");
}

async function formatStepForLLMContext(
  facts: string,
  graph: string,
  item: any,
): Promise<string> {
  if (!LLM_CONTEXT_STEP_KINDS.has(item.kind)) return "";
  const payload = await loadPayloadJSON(facts, graph, item.step);
  const result = await loadResultJSON(facts, graph, item.step);
  const text = formatStepForCompaction(item, payload, result);
  if (!text) return "";
  const status = item.status ? ` · ${item.status.replace(/^agent:/, "")}` : "";
  return `[${item.kind.replace(/^agent:/, "")}${status}]\n${text}`;
}

async function transcriptMessages(
  chatId: string,
  afterAt: number,
): Promise<any[]> {
  const c = chatRefs(chatId);
  const steps = await moo.facts.matchAll({
    patterns: [
      ["?step", "rdf:type", "agent:Step"],
      ["?step", "agent:kind", "?kind"],
      ["?step", "agent:status", "?status"],
      ["?step", "agent:createdAt", "?at"],
    ],
    ...{ store: c.facts, graph: c.graph },
  });

  const items = steps
    .map((row) => ({
      step: row["?step"]!,
      kind: row["?kind"]!,
      status: row["?status"]!,
      at: Number(row["?at"]) || 0,
    }))
    .filter((item) => item.step && item.at > afterAt)
    .sort((a, b) => a.at - b.at);

  const messages: any[] = [];
  for (const item of items) {
    const payload = await loadPayloadJSON(c.facts, c.graph, item.step);
    const result = await loadResultJSON(c.facts, c.graph, item.step);
    const text = formatStepForCompaction(item, payload, result);
    if (!text) continue;
    if (item.kind === "agent:UserInput") {
      messages.push({ role: "user", content: text });
      continue;
    }
    const status = item.status
      ? ` · ${item.status.replace(/^agent:/, "")}`
      : "";
    const prefix = `[${item.kind.replace(/^agent:/, "")}${status}]\n`;
    messages.push({
      role: "system",
      content: toolContextMessage(prefix + text),
    });
  }
  return messages;
}

export async function buildCompactionMessages(chatId: string): Promise<any[]> {
  const compaction = await readCompaction(chatId);
  const messages: any[] = [
    { role: "system", content: await buildSystemPrompt(chatId) },
  ];
  if (compaction.summary) {
    messages.push({
      role: "system",
      content: compactionContinuationSystemMessage(
        compaction.summary,
        await formatTodosForPrompt(chatId),
      ),
    });
  }
  messages.push(...(await transcriptMessages(chatId, compaction.throughAt)));
  return messages;
}

export async function estimateCompactionPromptTokens(
  chatId: string,
  messages?: any[],
): Promise<number> {
  const compactionMessages = buildCompactionSummaryPromptMessages(
    await buildCompactionMessages(chatId),
  );
  const fullEstimate = estimateTokens(compactionMessages);
  const llmEstimate = Array.isArray(messages)
    ? estimateTokens(buildCompactionSummaryPromptMessages(messages))
    : 0;
  return Math.max(fullEstimate, llmEstimate);
}

export async function loadPayloadJSON(
  factsRef: string,
  graph: string,
  subject: string,
  predicate: string = "agent:payload",
): Promise<{ kind: string; value: any } | null> {
  const rows = await moo.facts.match({
    store: factsRef,
    ...{
      graph,
      subject,
      predicate,
      limit: 1,
    },
  });
  if (!rows.length) return null;
  return await moo.objects.getJSON({ hash: rows[0]![3] });
}

export async function loadResultJSON(
  factsRef: string,
  graph: string,
  subject: string,
): Promise<{ kind: string; value: any } | null> {
  const rows = await moo.facts.match({
    store: factsRef,
    ...{
      graph,
      subject,
      predicate: "agent:result",
      limit: 1,
    },
  });
  if (!rows.length) return null;
  return await moo.objects.getJSON({ hash: rows[0]![3] });
}

// -- tool execution --------------------------------------------------------
//
// One tool is exposed to the LLM: runTS. The model sends TypeScript code; the harness
// type-checks it against bundled TypeScript 6 + ES2025 + Moo declarations, then
// evaluates it as the body of an async function with `moo`, `chatId`, `repo`, `scratch`, and optional `args` in scope.

export function serializeToolValue(v: any): string {
  if (v === undefined) return "undefined";
  if (typeof v === "string") return v;
  try {
    return formatHjson(v, "", 60);
  } catch {
    return String(v);
  }
}

// HJSON-style formatter: unquoted keys when they're identifiers,
// braces on the same line as the first/last value, no whitespace padding for
// short objects. Tries to fit each level on one line; spills onto multiple
// indented lines when the single-line form would exceed `wrap`. Strings
// containing newlines render as HJSON triple-quoted multiline blocks so the
// timeline UI can show them across real lines.
function formatHjson(value: any, indent: string, wrap: number): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "function") {
    return `"[Function ${value.name || "anonymous"}]"`;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? String(value)
      : JSON.stringify(String(value));
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return formatHjsonString(value, indent);

  const inner = indent + "  ";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => formatHjson(v, inner, wrap));
    const single = `[${items.join(", ")}]`;
    if (single.length <= wrap && !single.includes("\n")) return single;
    return `[\n${inner}${items.join(`,\n${inner}`)}\n${indent}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const renderInline = (k: string) => {
      const fk = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
      return `${fk}: ${formatHjson(value[k], inner, wrap)}`;
    };
    const inlineItems = keys.map(renderInline);
    const single = `{ ${inlineItems.join(", ")} }`;
    if (
      single.length <= wrap &&
      !single.includes("\n") &&
      !inlineItems.some((s) => s.includes("'''"))
    ) {
      return single;
    }
    const items = keys.map((k) => {
      const fk = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
      const formatted = formatHjson(value[k], inner, wrap);
      return `${fk}: ${formatted}`;
    });
    return `{\n${inner}${items.join(`,\n${inner}`)}\n${indent}}`;
  }
  return String(value);
}

function formatHjsonString(value: string, indent: string): string {
  if (!/[\r\n]/.test(value) || value.includes("'''"))
    return JSON.stringify(value);
  let normalized = value.replace(/\r\n?/g, "\n");
  // Drop a single trailing newline so we don't render a blank line before the closing '''.
  if (normalized.endsWith("\n")) normalized = normalized.slice(0, -1);
  // Indent body and closing fence one level deeper than the key, so multiline
  // values sit visibly inside the value scope rather than at the key level.
  // HJSON parsers dedent ordinary leading spaces inside ''' blocks; protect
  // string-owned leading indentation with NBSPs while leaving structural
  // indentation as regular spaces.
  const body = indent + "  ";
  const lines = normalized.split("\n");
  return `'''\n${lines.map((l) => body + protectHjsonMultilineIndent(l)).join("\n")}\n${body}'''`;
}

function protectHjsonMultilineIndent(line: string): string {
  return line.replace(/^[ \t]+/, (prefix) =>
    prefix.replace(/ /g, " ").replace(/\t/g, "  "),
  );
}

async function toolRunTS(
  chatId: string,
  toolArgs: any,
  model?: string | null,
  effort?: string | null,
  runTsStepId?: string | null,
): Promise<{ toolText: string }> {
  const code = typeof toolArgs?.code === "string" ? toolArgs.code : "";
  const label =
    typeof toolArgs?.label === "string" ? toolArgs.label.trim() : "";
  const description =
    typeof toolArgs?.description === "string"
      ? toolArgs.description.trim()
      : "";
  const hasRunArgs = Object.prototype.hasOwnProperty.call(
    toolArgs ?? {},
    "args",
  );
  const runArgs = hasRunArgs ? toolArgs.args : undefined;
  const backgroundAfterNs =
    typeof toolArgs?.backgroundAfterNs === "number" &&
    Number.isFinite(toolArgs.backgroundAfterNs)
      ? Math.max(0, Math.floor(toolArgs.backgroundAfterNs))
      : null;
  const started = Date.now();
  const runTsStep = await startRunTSStep(
    chatId,
    code,
    label,
    description,
    runArgs,
    hasRunArgs,
    backgroundAfterNs,
    started,
    model,
    effort,
    runTsStepId,
  );
  let trace: any = null;
  let result: any = undefined;
  let error: string | null = null;
  let serialized = "undefined";
  let missingCode = false;
  try {
    trace = await startRunTSTraceRoot(runTsStep.stepId, {
      chatId,
      label: label || null,
      description: description || null,
      code,
      args: runArgs ?? null,
      argsProvided: hasRunArgs,
      model: model || null,
      effort: effort || null,
    });
    if (!code.trim()) {
      missingCode = true;
      throw new Error("missing code");
    }
    const compiled = await moo.traces.span({
      name: "ts.compile",
      data: { code, target: "es2025", typescript: "6" },
      fn: () => compileRunTS(code),
    });
    if (compiled.diagnostics.length)
      throw new Error(
        "TypeScript compile failed:\n" + compiled.diagnostics.join("\n"),
      );
    const fn = await moo.traces.span({
      name: "v8.compile",
      data: { code: compiled.js, source: "runTS" },
      fn: () =>
        new Function(
          "moo",
          "chatId",
          "repo",
          "scratch",
          "args",
          compiled.js + "\nreturn __runTS__();",
        ),
    });
    const repo =
      (await moo.pointers.get({ name: `chat/${chatId}/path` })) || ".";
    const scratch = await moo.chat.scratch({ chatId: chatId });
    const depth = await subagentDepth(chatId);
    result = await withMooRunTSContext(chatId, runTsStep.stepId, depth, () =>
      withMooChatContext(chatId, () =>
        moo.traces.span({
          name: "runts.user",
          fn: () => fn(moo, chatId, repo, scratch, runArgs),
        }),
      ),
    );
    serialized = await moo.traces.span({
      name: "runts.stringify",
      data: { resultType: typeof result },
      fn: () => serializeToolValue(result),
    });
  } catch (e: any) {
    error = e?.message ?? String(e);
  }
  const cancelled = typeof error === "string" && /runTS cancelled/i.test(error);
  const resultHash = await finishRunTSStep(
    chatId,
    runTsStep.stepId,
    error ? null : { value: serialized },
    error,
    started,
    cancelled ? "agent:Cancelled" : undefined,
  );
  await finishRunTSTraceRoot({
    id: trace?.id,
    resultHash,
    error,
    status: cancelled ? "cancelled" : error ? "error" : "ok",
  });
  if (missingCode) return { toolText: "error: runTS requires `code`" };
  if (error) return { toolText: `${cancelled ? "cancelled" : "error"}: ${error}` };
  return { toolText: truncate(serialized ?? "undefined", 4000) };
}

async function subagentDepth(chatId: string): Promise<number> {
  const raw = await moo.pointers.get({ name: `chat/${chatId}/subagent-depth` });
  const n = Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

async function startRunTSStep(
  chatId: string,
  code: string,
  label: string,
  description: string,
  runArgs: any,
  hasRunArgs: boolean,
  backgroundAfterNs: number | null,
  startedAt: number,
  model?: string | null,
  effort?: string | null,
  runTsStepId?: string | null,
) {
  const payloadHash = await moo.objects.putJSON({
    kind: "agent:RunTS",
    value: {
      code,
      label: label || null,
      description: description || null,
      ...(hasRunArgs ? { args: runArgs } : {}),
      ...(backgroundAfterNs != null ? { backgroundAfterNs } : {}),
    },
  });
  return await appendStep(chatId, {
    kind: "agent:RunTS",
    status: "agent:Running",
    payloadHash,
    stepId: runTsStepId || undefined,
    extras: modelExtras(model, effort),
    at: startedAt,
  });
}

export async function finishRunTSStep(
  chatId: string,
  stepId: string,
  result: { value: string } | null,
  error: string | null,
  startedAt?: number,
  statusOverride?: "agent:Done" | "agent:Failed" | "agent:Cancelled",
): Promise<string | null> {
  const c = chatRefs(chatId);
  const resultHash = result
    ? await moo.objects.putJSON({ kind: "agent:ToolResult", value: result })
    : error
      ? await moo.objects.putJSON({
          kind: "agent:ToolResult",
          value: { error },
        })
      : null;
  const endedAt = Date.now();
  const status = statusOverride ?? (error ? "agent:Failed" : "agent:Done");
  const durationNs =
    typeof startedAt === "number"
      ? Math.max(0, endedAt - startedAt) * 1_000_000
      : undefined;
  const [statusRows, updatedAtRows] = await Promise.all([
    moo.facts.match({
      store: c.facts,
      ...{ graph: c.graph, subject: stepId, predicate: "agent:status" },
    }),
    moo.facts.match({
      store: c.facts,
      ...{ graph: c.graph, subject: stepId, predicate: "agent:updatedAt" },
    }),
  ]);
  await moo.facts.update({
    store: c.facts,
    fn: (txn) => {
      for (const [g, s, p, o] of statusRows)
        txn.remove({ graph: g, subject: s, predicate: p, object: o });
      for (const [g, s, p, o] of updatedAtRows)
        txn.remove({ graph: g, subject: s, predicate: p, object: o });
      txn.add({
        graph: c.graph,
        subject: stepId,
        predicate: "agent:status",
        object: status,
      });
      txn.add({
        graph: c.graph,
        subject: stepId,
        predicate: "agent:updatedAt",
        object: String(endedAt),
      });
      if (resultHash)
        txn.add({
          graph: c.graph,
          subject: stepId,
          predicate: "agent:result",
          object: resultHash,
        });
      if (error)
        txn.add({
          graph: c.graph,
          subject: stepId,
          predicate: "agent:error",
          object: error,
        });
    },
  });
  moo.events.publish({
    payload: {
      kind: "runts-step-finished",
      chatId,
      stepId,
      status,
      resultHash,
      error,
      at: endedAt,
      durationNs,
    },
  });
  return resultHash;
}

export async function hasPendingInput(chatId: string): Promise<boolean> {
  const c = chatRefs(chatId);
  const rows = await moo.facts.matchAll({
    patterns: [
      ["?req", "rdf:type", "ui:InputRequest"],
      ["?req", "ui:status", "ui:Pending"],
    ],
    ...{ store: c.facts, graph: c.graph, limit: 1 },
  });
  return rows.length > 0;
}

export async function executeToolCall(
  chatId: string,
  tc: any,
  model?: string | null,
  effort?: string | null,
  runTsStepId?: string | null,
): Promise<{ toolText: string }> {
  const name = tc?.function?.name;
  let args: any = {};
  try {
    args = JSON.parse(tc?.function?.arguments || "{}");
  } catch {
    args = {};
  }
  if (name === "runTS") {
    return await traceSpan(
      "tool.runTS",
      {
        chatId,
        model: model ?? null,
        effort: normalizeEffort(effort) ?? null,
        ...toolCallForTrace(tc),
        label: args?.label ?? null,
        description: args?.description ?? null,
        args,
      },
      () => toolRunTS(chatId, args, model, effort, runTsStepId),
    );
  }
  const started = Date.now();
  const unknown = await startRunTSStep(
    chatId,
    JSON.stringify({ tool: name, args }),
    "",
    "",
    undefined,
    false,
    null,
    started,
    model,
    effort,
  );
  await finishRunTSStep(chatId, unknown.stepId, null, `unknown tool: ${name}`);
  return { toolText: `unknown tool: ${name}` };
}

export async function runToolCall(
  chatId: string,
  tc: any,
  model?: string | null,
  effort?: string | null,
  runTsStepId?: string | null,
): Promise<{ toolText: string }> {
  return executeToolCall(chatId, tc, model, effort, runTsStepId);
}

export async function runShellAndRecord(
  chatId: string,
  cmdline: string,
  procOpts: { cwd?: string; stdin?: string; timeoutMs?: number } = {},
) {
  const argv = parseArgv(cmdline);
  const [cmd] = argv;
  if (!cmd) return await reply(chatId, "usage: /run <cmd> [args...]");
  const wt = await moo.chat.scratch({ chatId: chatId });
  const payloadHash = await moo.objects.putJSON({
    kind: "agent:ShellCommand",
    value: { cmd: argv, cwd: wt },
  });
  let result: any = null;
  let status: "agent:Done" | "agent:Failed" = "agent:Done";
  let errMsg: string | null = null;
  try {
    result = await moo.proc.run({
      cmd: argv,
      ...{ cwd: wt, ...procOpts },
    });
    if (result.timedOut || result.code !== 0) status = "agent:Failed";
  } catch (err: any) {
    errMsg = err?.message ?? String(err);
    status = "agent:Failed";
  }

  const extras: Array<[string, string]> = [];
  if (result) {
    const resultHash = await moo.objects.putJSON({
      kind: "agent:ToolResult",
      value: { cmd: argv, cwd: wt, ...result },
    });
    extras.push(["agent:result", resultHash]);
    extras.push(["agent:exitCode", String(result.code)]);
  }
  if (errMsg) extras.push(["agent:error", errMsg]);

  const { stepId } = await appendStep(chatId, {
    kind: "agent:ShellCommand",
    status,
    payloadHash,
    extras,
  });
  return { stepId, kind: "agent:ShellCommand" as const, status };
}

// -- timeline formatting (used by describe) --------------------------------

function firstString(...values: any[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean")
      return String(value);
  }
  return "";
}

function formatErrorPayload(body: any): string {
  if (body == null || body === "") return "";
  if (typeof body === "string") return body.trim();
  try {
    return JSON.stringify(body, null, 2).trim();
  } catch {
    return String(body).trim();
  }
}

const COMPACTION_STEP_TEXT_LIMITS = {
  userInput: 12_000,
  reply: 12_000,
  runTsCode: 8_000,
  runTsResult: 8_000,
  shellOutput: 12_000,
  subagentOutput: 2_000,
  errorPayload: 6_000,
  generic: 12_000,
};

function stringifyCompactionValue(value: any): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatStepForCompaction(
  item: any,
  payload: any,
  result: any,
): string {
  switch (item.kind) {
    case "agent:UserInput":
      return truncate(
        payload?.value?.message ?? "",
        COMPACTION_STEP_TEXT_LIMITS.userInput,
      );
    case "agent:Reply":
      return truncate(
        payload?.value?.text ?? "",
        COMPACTION_STEP_TEXT_LIMITS.reply,
      );
    case "agent:RunTS":
    case "agent:RunJS": {
      const code = truncate(
        payload?.value?.code ?? "",
        COMPACTION_STEP_TEXT_LIMITS.runTsCode,
      );
      const label = payload?.value?.label ?? "";
      const description = payload?.value?.description ?? "";
      const resultText = result?.value
        ? truncate(
            stringifyCompactionValue(result.value),
            COMPACTION_STEP_TEXT_LIMITS.runTsResult,
          )
        : "";
      const parts: string[] = [];
      if (label) parts.push(`@@label ${label}`);
      if (description) parts.push(`@@desc ${description}`);
      if (code) parts.push("@@code", code);
      if (resultText) parts.push(`@@result ${resultText}`);
      return parts.join("\n");
    }
    case "agent:Subagent": {
      const v = payload?.value || {};
      const r = result?.value || null;
      const output = r?.output ?? r?.text;
      return [
        v.label || "subagent",
        v.childChatId ? `child chat: ${v.childChatId}` : "",
        r?.status ? `status: ${r.status}` : "",
        v.task || "",
        output
          ? truncate(output, COMPACTION_STEP_TEXT_LIMITS.subagentOutput)
          : "",
        r?.error
          ? `error: ${truncate(r.error, COMPACTION_STEP_TEXT_LIMITS.generic)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "agent:ShellCommand": {
      const cmd = payload?.value
        ? `$ ${Array.isArray(payload.value.cmd) ? payload.value.cmd.map((a: string) => maybeQuote(a)).join(" ") : payload.value.cmd}`
        : "";
      const tail = result?.value
        ? `(exit ${result.value.code} · ${Math.round(result.value.durationNs / 1_000_000)}ms${
            result.value.timedOut ? " · timed out" : ""
          })`
        : "";
      const out = result?.value
        ? [
            result.value.stdout?.trim() &&
              truncate(
                result.value.stdout.trim(),
                COMPACTION_STEP_TEXT_LIMITS.shellOutput,
              ),
            result.value.stderr?.trim() &&
              truncate(
                result.value.stderr.trim(),
                COMPACTION_STEP_TEXT_LIMITS.shellOutput,
              ),
            tail,
          ]
            .filter(Boolean)
            .join("\n")
        : "";
      return [cmd, out].filter(Boolean).join("\n");
    }
    case "agent:Error": {
      const formatted = formatStep(item, payload, result);
      return truncate(formatted, COMPACTION_STEP_TEXT_LIMITS.errorPayload);
    }
    default:
      return truncate(
        formatStep(item, payload, result),
        COMPACTION_STEP_TEXT_LIMITS.generic,
      );
  }
}

export function formatStep(item: any, payload: any, result: any): string {
  switch (item.kind) {
    case "agent:UserInput":
      return payload?.value?.message ?? "";
    case "agent:Reply":
      return payload?.value?.text ?? "";
    case "agent:Compaction": {
      const summary = payload?.value?.summary || "";
      const trigger =
        payload?.value?.trigger === "automatic"
          ? "automatic "
          : payload?.value?.trigger === "manual"
            ? "manual "
            : "";
      return `${trigger}compaction\n${summary}`;
    }
    case "agent:RunTS":
    case "agent:RunJS": {
      const code = payload?.value?.code ?? "";
      const label = payload?.value?.label ?? "";
      const description = payload?.value?.description ?? "";
      let tail = "";
      if (result?.value) {
        if (typeof result.value === "object" && result.value.error) {
          tail = `error: ${result.value.error}`;
        } else if (
          typeof result.value === "object" &&
          "value" in result.value
        ) {
          tail = `→ ${result.value.value}`;
        } else {
          tail = JSON.stringify(result.value);
        }
      }
      // Sentinel-prefixed lines keep the format robust if code or
      // description happens to start with a colon. The frontend parser in
      // RunTSBody splits on these markers.
      const parts: string[] = [];
      if (label) parts.push(`@@label ${label}`);
      if (description) parts.push(`@@desc ${description}`);
      if (code) parts.push("@@code");
      if (code) parts.push(code);
      if (tail) parts.push(tail);
      return parts.join("\n");
    }
    case "agent:Subagent": {
      const v = payload?.value || {};
      const r = result?.value || null;
      const label = v.label || "subagent";
      const task = v.task || "";
      const child = v.childChatId ? `child chat: ${v.childChatId}` : "";
      const status = r?.status ? `status: ${r.status}` : "";
      const output = r?.output ?? r?.text;
      const body = output ? `\n\n${truncate(output, 1200)}` : "";
      const err = r?.error ? `\nerror: ${r.error}` : "";
      return (
        [label, child, status, task].filter(Boolean).join("\n") + body + err
      );
    }
    case "agent:ShellCommand": {
      const cmd = payload?.value
        ? `$ ${Array.isArray(payload.value.cmd) ? payload.value.cmd.map((a: string) => maybeQuote(a)).join(" ") : payload.value.cmd}`
        : "";
      const tail = result?.value
        ? `(exit ${result.value.code} · ${Math.round(result.value.durationNs / 1_000_000)}ms${
            result.value.timedOut ? " · timed out" : ""
          })`
        : "";
      const out = result?.value
        ? [
            result.value.stdout?.trim() && result.value.stdout.trim(),
            result.value.stderr?.trim() && result.value.stderr.trim(),
            tail,
          ]
            .filter(Boolean)
            .join("\n")
        : "";
      return [cmd, out].filter(Boolean).join("\n");
    }
    case "agent:Error": {
      const v = payload?.value || {};
      const detail = v.detail && typeof v.detail === "object" ? v.detail : {};
      const rawStatus = detail.status ?? v.status;
      const status = rawStatus ? `HTTP ${rawStatus}` : null;
      const source = firstString(
        detail.source,
        v.kind,
        v.phase,
        detail.type,
        detail.code,
        "error",
      );
      const model = firstString(detail.model, v.model);
      const head = [source, model, status].filter(Boolean).join(" · ");
      const message = firstString(
        detail.message,
        detail.error?.message,
        detail.body?.error?.message,
        detail.body?.message,
        v.message,
        v.reason,
        v.error?.message,
        v.error,
      );
      const payloadText = formatErrorPayload(
        detail.body ??
          detail.payload ??
          (Object.keys(detail).length ? detail : null) ??
          (Object.keys(v).length ? v : null),
      );
      const detailBits = [
        detail.type && `type: ${detail.type}`,
        detail.code && `code: ${detail.code}`,
        detail.requestId && `request id: ${detail.requestId}`,
        detail.retryAfter && `retry after: ${detail.retryAfter}`,
        v.trigger && `trigger: ${v.trigger}`,
        v.retryReason && `retry: ${v.retryReason}`,
      ]
        .filter(Boolean)
        .join("\n");
      const body = [
        message,
        detail.hint,
        detailBits,
        payloadText && payloadText !== String(message).trim()
          ? `payload:\n${payloadText}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return [head, body].filter(Boolean).join("\n");
    }
    default:
      return "";
  }
}
