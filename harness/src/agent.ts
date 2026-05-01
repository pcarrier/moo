import type { LLMProvider } from "./types";
import { moo, withMooChatContext, withMooRunJSContext } from "./moo";
import { appendStep } from "./steps";
import { chatRefs, parseArgv, truncate, maybeQuote } from "./lib";
import { buildSystemPrompt } from "./prompt";

export { appendStep, ensureRun } from "./steps";

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "runJS",
      description:
        "Evaluate JavaScript in the harness. Body is wrapped in an async IIFE; use `return value` to surface a result. `moo`, `chatId`, `scratch`, and optional `args` are in scope. Use `moo.agent.run(...)` for substantial independent awaited subagent work.",
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
            description: "JavaScript source to execute as the body of an async IIFE.",
          },
          args: {
            description: "Arbitrary JSON value made available to the JavaScript body as `args`.",
          },
        },
        required: ["label", "description", "code"],
        additionalProperties: false,
      },
    },
  },
];

// Compact when the next prompt would consume more than half the model's
// context window. Token count is a chars-÷-4 estimate; calibration tuned to
// English-with-code prose.
const DEFAULT_CONTEXT_TOKENS = 128_000;
export const COMPACT_FRACTION = 0.5;

type ContextWindowRule = { pattern: RegExp; tokens: number };

const OPENAI_CONTEXT_WINDOWS: ContextWindowRule[] = [
  { pattern: /^gpt-5\.5(?:[.-]|$)/, tokens: 1_000_000 },
  { pattern: /^gpt-5(?:[.-]|$)/, tokens: 400_000 },
  { pattern: /^gpt-4\.1(?:[.-]|$)/, tokens: 1_000_000 },
  { pattern: /^gpt-4o(?:[.-]|$)/, tokens: 128_000 },
  { pattern: /^o3(?:[.-]|$)/, tokens: 200_000 },
  { pattern: /^o4(?:[.-]|$)/, tokens: 200_000 },
  { pattern: /^chatgpt-/, tokens: 128_000 },
];

const ANTHROPIC_CONTEXT_WINDOWS: ContextWindowRule[] = [
  { pattern: /^claude-(?:opus|sonnet|haiku)-4(?:[.-]|$)/, tokens: 200_000 },
  { pattern: /^claude-3[-.]7(?:[.-]|$)/, tokens: 200_000 },
];

const QWEN_CONTEXT_WINDOWS: ContextWindowRule[] = [
  { pattern: /^qwen3(?:[.-]|$)/, tokens: 262_144 },
  { pattern: /^qwen-(?:plus|max|turbo|flash)(?:[-.]|$)/, tokens: 131_072 },
];

export function estimateTokens(messages: any[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m?.content === "string") total += m.content.length;
    if (Array.isArray(m?.tool_calls)) {
      for (const tc of m.tool_calls) {
        try {
          total += JSON.stringify(tc).length;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return Math.ceil(total / 4);
}

function contextBudgetFromRules(model: string | null | undefined, rules: ContextWindowRule[]): number | null {
  const id = String(model ?? "").trim().toLowerCase();
  if (!id) return null;
  return rules.find(({ pattern }) => pattern.test(id))?.tokens ?? null;
}

export function modelContextBudget(provider: Pick<LLMProvider, "name" | "model"> | null | undefined): number {
  if (!provider) return DEFAULT_CONTEXT_TOKENS;
  if (provider.name === "openai") return contextBudgetFromRules(provider.model, OPENAI_CONTEXT_WINDOWS) ?? DEFAULT_CONTEXT_TOKENS;
  if (provider.name === "anthropic") return contextBudgetFromRules(provider.model, ANTHROPIC_CONTEXT_WINDOWS) ?? DEFAULT_CONTEXT_TOKENS;
  if (provider.name === "qwen") return contextBudgetFromRules(provider.model, QWEN_CONTEXT_WINDOWS) ?? DEFAULT_CONTEXT_TOKENS;
  return DEFAULT_CONTEXT_TOKENS;
}

export async function contextBudget(provider?: Pick<LLMProvider, "name" | "model"> | null): Promise<number> {
  return modelContextBudget(provider);
}

function modelExtras(model: string | null | undefined, effort?: string | null): Array<[string, string]> {
  const extras: Array<[string, string]> = [];
  const m = (model ?? "").trim();
  const e = normalizeEffort(effort);
  if (m) extras.push(["agent:model", m]);
  if (e) extras.push(["agent:effort", e]);
  return extras;
}

export async function reply(
  chatId: string,
  text: string,
  model?: string | null,
  effort?: string | null,
  thoughtDurationMs?: number | null,
) {
  const payloadBody: any = { text, at: await moo.time.now() };
  if (Number.isFinite(thoughtDurationMs) && thoughtDurationMs! >= 0) {
    payloadBody.thoughtDurationMs = Math.round(thoughtDurationMs!);
  }
  const payload = await moo.objects.put(
    "agent:Reply",
    JSON.stringify(payloadBody),
  );
  const { stepId } = await appendStep(chatId, {
    kind: "agent:Reply",
    status: "agent:Done",
    payloadHash: payload,
    extras: modelExtras(model, effort),
  });
  return { stepId, kind: "agent:Reply" as const, status: "agent:Done" as const };
}

export async function recordErrorStep(
  chatId: string,
  kind: string,
  detail: any,
  model?: string | null,
  effort?: string | null,
) {
  const payloadHash = await moo.objects.put(
    "agent:Error",
    JSON.stringify({ kind, detail, at: await moo.time.now() }),
  );
  const { stepId } = await appendStep(chatId, {
    kind: "agent:Error",
    status: "agent:Failed",
    payloadHash,
    extras: modelExtras(model, effort),
  });
  return { stepId, kind: "agent:Error" as const, status: "agent:Failed" as const };
}

// -- provider --------------------------------------------------------------

export function inferProviderForModel(model: string | null | undefined): "openai" | "qwen" | "anthropic" | null {
  const id = String(model ?? "").trim().toLowerCase();
  if (!id) return null;
  if (id.startsWith("qwen")) return "qwen";
  if (id.startsWith("claude")) return "anthropic";
  if (id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4") || id.startsWith("chatgpt-")) return "openai";
  return null;
}


const CHAT_MODEL_PREDICATE = "ui:model";
const CHAT_EFFORT_PREDICATE = "ui:effortLevel";

async function selectedChatFact(chatId: string, predicate: string): Promise<string | null> {
  const c = chatRefs(chatId);
  const rows = await moo.facts.match(c.facts, {
    graph: c.graph,
    subject: `chat:${chatId}`,
    predicate,
    limit: 1,
  });
  return String(rows[0]?.[3] ?? "").trim() || null;
}


async function selectedModelForChat(chatId: string): Promise<string | null> {
  return selectedChatFact(chatId, CHAT_MODEL_PREDICATE);
}

async function selectedEffortForChat(chatId: string): Promise<string | null> {
  return normalizeEffort(await selectedChatFact(chatId, CHAT_EFFORT_PREDICATE));
}

function decodeSimpleTurtleString(value: string): string {
  const trimmed = value.trim();
  const m = /^"((?:[^"\\\r\n]|\\["\\nrtbf])*)"(?:@[A-Za-z]+(?:-[A-Za-z0-9]+)*|\^\^\S+)?$/.exec(trimmed);
  if (!m) return trimmed;
  return m[1].replace(/\\(["\\nrtbf])/g, (_all, ch: string) => {
    switch (ch) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "b": return "\b";
      case "f": return "\f";
      default: return ch;
    }
  });
}

export const ALL_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type EffortLevel = (typeof ALL_EFFORT_LEVELS)[number];
type EffortBudgetMap = Partial<Record<EffortLevel, number>>;

export function normalizeEffort(value: unknown): EffortLevel | null {
  const effort = decodeSimpleTurtleString(String(value ?? "")).trim().toLowerCase();
  return (ALL_EFFORT_LEVELS as readonly string[]).includes(effort) ? effort as EffortLevel : null;
}

function effortAllowed(efforts: readonly string[], effort: string | null | undefined): EffortLevel | null {
  const normalized = normalizeEffort(effort);
  return normalized && efforts.includes(normalized) ? normalized : null;
}

async function defaultEffort(): Promise<string | null> {
  return normalizeEffort(
    (await moo.env.get("ANTHROPIC_EFFORT")) ||
      (await moo.env.get("ANTHROPIC_THINKING_EFFORT")) ||
      (await moo.env.get("OPENAI_REASONING_EFFORT")) ||
      (await moo.env.get("OPENAI_EFFORT")),
  );
}

export function usesResponsesApi(provider: LLMProvider): boolean {
  return provider.name === "openai" && /^gpt-5(?:[.-]|$)/i.test(provider.model);
}

export function effortLevelsForProvider(provider: Pick<LLMProvider, "name" | "model">): string[] {
  if (provider.name === "anthropic") return anthropicEffortLevels(provider.model);
  if (provider.name === "openai") return openaiEffortLevels(provider.model);
  return [];
}

export function supportsEffort(provider: Pick<LLMProvider, "name" | "model">): boolean {
  return effortLevelsForProvider(provider).length > 0;
}

function openaiEffortLevels(model: string | null | undefined): string[] {
  const id = String(model ?? "").trim().toLowerCase();
  if (/^gpt-5\.5(?:[.-]|$)/.test(id)) return ["minimal", "low", "medium", "high", "xhigh"];
  if (/^gpt-5(?:[.-]|$)/.test(id)) return ["minimal", "low", "medium", "high"];
  if (/^o(?:1|3|4)(?:[.-]|$)/.test(id)) return ["low", "medium", "high"];
  return [];
}

const ANTHROPIC_DEFAULT_THINKING_BUDGETS: EffortBudgetMap = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 6144,
  xhigh: 7168,
};

const ANTHROPIC_ADAPTIVE_EFFORT_LEVELS = ["low", "medium", "high"] as const;
const ANTHROPIC_ADAPTIVE_MAX_EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;
const ANTHROPIC_ADAPTIVE_OPUS_4_7_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

const ANTHROPIC_BUDGET_THINKING_MODELS: Array<{ pattern: RegExp; budgets: EffortBudgetMap }> = [
  // Claude 3.7 exposes extended thinking via budget_tokens. Newer Claude
  // models use adaptive thinking controlled by output_config.effort instead.
  { pattern: /(?:^|[-.])3[-.]7(?:[-.]|$)/, budgets: ANTHROPIC_DEFAULT_THINKING_BUDGETS },
];

function isClaudeOpus47(id: string): boolean {
  return /(?:^|[-.])opus[-.]4[-.]7(?:[-.]|$)/.test(id);
}

function isClaudeMaxEffortModel(id: string): boolean {
  return (
    /(?:^|[-.])mythos(?:[-.]|$)/.test(id) ||
    /(?:^|[-.])opus[-.]4[-.](?:6|7)(?:[-.]|$)/.test(id) ||
    /(?:^|[-.])sonnet[-.]4[-.]6(?:[-.]|$)/.test(id)
  );
}

function anthropicAdaptiveEffortLevels(model: string | null | undefined): readonly EffortLevel[] | null {
  const id = String(model ?? "").trim().toLowerCase();
  if (!id.startsWith("claude")) return null;
  if (isClaudeOpus47(id)) return ANTHROPIC_ADAPTIVE_OPUS_4_7_EFFORT_LEVELS;
  if (isClaudeMaxEffortModel(id)) return ANTHROPIC_ADAPTIVE_MAX_EFFORT_LEVELS;
  if (/(?:^|[-.])(?:opus|sonnet|haiku)[-.]4(?:[-.]|$)/.test(id)) return ANTHROPIC_ADAPTIVE_EFFORT_LEVELS;
  return null;
}

function anthropicThinkingBudgets(model: string | null | undefined): EffortBudgetMap | null {
  const id = String(model ?? "").trim().toLowerCase();
  if (!id.startsWith("claude")) return null;
  return ANTHROPIC_BUDGET_THINKING_MODELS.find(({ pattern }) => pattern.test(id))?.budgets ?? null;
}

function anthropicEffortLevels(model: string | null | undefined): string[] {
  const adaptive = anthropicAdaptiveEffortLevels(model);
  if (adaptive) return [...adaptive];
  const budgets = anthropicThinkingBudgets(model);
  if (!budgets) return [];
  return ALL_EFFORT_LEVELS.filter((effort) => budgets[effort] != null);
}

export function supportsAnthropicThinking(model: string | null | undefined): boolean {
  return anthropicEffortLevels(model).length > 0;
}

function anthropicThinkingBudget(model: string | null | undefined, effort: string | null | undefined): number | null {
  const budgets = anthropicThinkingBudgets(model);
  if (!budgets) return null;
  const allowedEffort = effortAllowed(anthropicEffortLevels(model), effort);
  return allowedEffort ? budgets[allowedEffort] ?? null : null;
}

function applyEffort(provider: LLMProvider, body: Record<string, unknown>, responsesApi = false) {
  if (!provider.effort) return;
  if (provider.name === "openai") {
    const effort = effortAllowed(openaiEffortLevels(provider.model), provider.effort);
    if (!effort) return;
    if (responsesApi) body.reasoning = { effort };
    else body.reasoning_effort = effort;
    return;
  }
  if (provider.name === "anthropic" && supportsAnthropicThinking(provider.model)) {
    const effort = effortAllowed(anthropicEffortLevels(provider.model), provider.effort);
    if (!effort) return;
    if (anthropicAdaptiveEffortLevels(provider.model)) {
      body.thinking = { type: "adaptive" };
      body.output_config = { ...((body.output_config as Record<string, unknown> | undefined) ?? {}), effort };
      return;
    }
    const budget = anthropicThinkingBudget(provider.model, effort);
    if (budget) body.thinking = { type: "enabled", budget_tokens: budget };
  }
}

export function buildStreamingLLMRequest(provider: LLMProvider, messages: any[], tools: any[] | null) {
  if (provider.name === "anthropic") {
    const anthropic = toAnthropicMessages(messages);
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
      requestEffort: effortAllowed(effortLevelsForProvider(provider), provider.effort),
    };
  }

  const responsesApi = usesResponsesApi(provider);
  const body: Record<string, unknown> = responsesApi
    ? { model: provider.model, input: toResponsesInput(messages), stream: true }
    : {
        model: provider.model,
        messages,
        stream: true,
        // Ask OpenAI-compatible endpoints to include token usage in the final
        // SSE chunk. Endpoints that ignore the option simply drop it.
        stream_options: { include_usage: true },
      };
  applyEffort(provider, body, responsesApi);
  if (tools?.length) {
    if (responsesApi) body.tools = toResponsesTools(tools);
    else body.tools = tools;
    body.tool_choice = "auto";
  }
  return {
    url: provider.baseUrl + "/" + (responsesApi ? "responses" : "chat/completions"),
    body,
    responsesApi,
    headers: llmProviderHeaders(provider),
    requestModel: provider.model || null,
    requestEffort: effortAllowed(effortLevelsForProvider(provider), provider.effort),
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

export function llmProviderHeaders(provider: LLMProvider): Record<string, string> {
  if (provider.name === "anthropic") {
    return {
      "x-api-key": provider.apiKey || "",
      "anthropic-version": "2023-06-01",
    };
  }
  return { Authorization: "Bearer " + (provider.apiKey || "") };
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

export function toAnthropicMessages(messages: any[]): { system: string; messages: any[] } {
  const systemParts: string[] = [];
  const out: any[] = [];
  for (const msg of messages) {
    if (msg?.role === "system") {
      const text = contentText(msg.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (msg?.role === "tool") {
      out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: String(msg.tool_call_id || ""), content: String(msg.content ?? "") }] });
      continue;
    }
    if (msg?.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const content: any[] = [];
      const text = contentText(msg.content);
      if (text) content.push({ type: "text", text });
      for (const tc of msg.tool_calls) {
        content.push({ type: "tool_use", id: String(tc?.id || ""), name: String(tc?.function?.name || ""), input: parseToolArgs(tc?.function?.arguments) });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    const role = msg?.role === "assistant" ? "assistant" : "user";
    out.push({ role, content: toAnthropicContent(msg?.content, role) });
  }
  return { system: systemParts.join("\n\n"), messages: out };
}

function contentText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n");
  return content == null ? "" : String(content);
}

function toAnthropicContent(content: any, role: string): any {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const blocks: any[] = [];
  for (const part of content) {
    if (part?.type === "text") blocks.push({ type: "text", text: String(part.text ?? "") });
    else if (role === "user" && part?.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
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
  try { return JSON.parse(String(raw || "{}")); } catch { return {}; }
}
function toResponsesContent(role: string, content: any): any {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part?.type === "text") {
      return { type: role === "assistant" ? "output_text" : "input_text", text: part.text ?? "" };
    }
    if (part?.type === "image_url") {
      const imageUrl =
        typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      return { type: "input_image", image_url: imageUrl };
    }
    return part;
  });
}

export function toResponsesInput(messages: any[]): any[] {
  const input: any[] = [];
  for (const msg of messages) {
    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
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
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function?.name || "",
          arguments: tc.function?.arguments || "{}",
        });
      }
    }
  }
  return input;
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
  if (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined) return usage;
  if (usage.input_tokens !== undefined || usage.output_tokens !== undefined) {
    return {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      prompt_tokens_details: usage.input_tokens_details || usage.cache_read_input_tokens !== undefined
        ? { cached_tokens: usage.input_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens }
        : undefined,
    };
  }
  return usage;
}

async function defaultProviderName(): Promise<"openai" | "qwen" | "anthropic"> {
  if (await moo.env.get("OPENAI_MODEL")) return "openai";
  if (await moo.env.get("QWEN_MODEL")) return "qwen";
  if (await moo.env.get("ANTHROPIC_MODEL")) return "anthropic";

  if (await moo.env.get("OPENAI_API_KEY")) return "openai";
  if (await moo.env.get("ANTHROPIC_API_KEY")) return "anthropic";
  if ((await moo.env.get("QWEN_API_KEY")) || (await moo.env.get("DASHSCOPE_API_KEY"))) return "qwen";
  return "openai";
}

export async function resolveProvider(modelOverride?: string | null, effortOverride?: string | null, providerOverride?: string | null): Promise<LLMProvider> {
  const explicitProvider = String(providerOverride ?? "").trim().toLowerCase();
  const which =
    explicitProvider === "openai" || explicitProvider === "qwen" || explicitProvider === "anthropic"
      ? explicitProvider
      : inferProviderForModel(modelOverride) || (await defaultProviderName());
  if (which === "anthropic") {
    const apiKey = await moo.env.get("ANTHROPIC_API_KEY");
    const baseUrl = (await moo.env.get("ANTHROPIC_BASE_URL")) || "https://api.anthropic.com/v1";
    const model = (await moo.env.get("ANTHROPIC_MODEL")) || "claude-opus-4-7";
    const resolvedModel = modelOverride || model;
    return { name: "anthropic", apiKey, baseUrl, model: resolvedModel, effort: normalizeEffort(effortOverride) || (await defaultEffort()), keyEnvHint: "ANTHROPIC_API_KEY" };
  }
  if (which === "qwen") {
    const apiKey = (await moo.env.get("QWEN_API_KEY")) || (await moo.env.get("DASHSCOPE_API_KEY"));
    const baseUrl = (await moo.env.get("QWEN_BASE_URL")) || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
    const model = (await moo.env.get("QWEN_MODEL")) || "qwen3.6";
    return { name: "qwen", apiKey, baseUrl, model: modelOverride || model, effort: null, keyEnvHint: "QWEN_API_KEY" };
  }
  const apiKey = await moo.env.get("OPENAI_API_KEY");
  const baseUrl = (await moo.env.get("OPENAI_BASE_URL")) || "https://api.openai.com/v1";
  const model = (await moo.env.get("OPENAI_MODEL")) || "gpt-5.5";
  return { name: "openai", apiKey, baseUrl, model: modelOverride || model, effort: normalizeEffort(effortOverride) || (await defaultEffort()), keyEnvHint: "OPENAI_API_KEY" };
}

async function callChatCompletions(
  provider: LLMProvider,
  messages: any[],
  tools: any[] | null,
) {
  const responsesApi = usesResponsesApi(provider);
  const body: Record<string, unknown> = responsesApi
    ? { model: provider.model, input: toResponsesInput(messages) }
    : { model: provider.model, messages };
  applyEffort(provider, body, responsesApi);
  if (tools && tools.length) {
    if (responsesApi) body.tools = toResponsesTools(tools);
    else body.tools = tools;
    body.tool_choice = "auto";
  }
  if (provider.name === "anthropic") {
    const anthropic = toAnthropicMessages(messages);
    const anthropicBody: Record<string, unknown> = {
      model: provider.model,
      max_tokens: anthropicMaxTokens(),
      messages: anthropic.messages,
    };
    if (anthropic.system) anthropicBody.system = anthropic.system;
    applyEffort(provider, anthropicBody);
    const anthropicTools = toAnthropicTools(tools);
    if (anthropicTools?.length) {
      anthropicBody.tools = anthropicTools;
      anthropicBody.tool_choice = { type: "auto" };
    }
    const resp = await moo.http.fetch({
      method: "POST",
      url: provider.baseUrl + "/messages",
      headers: llmProviderHeaders(provider),
      body: anthropicBody,
    });
    if (resp.status >= 400) return resp;
    try {
      const body = JSON.parse(resp.body);
      return {
        ...resp,
        body: JSON.stringify({
          model: body?.model || provider.model,
          usage: normalizeUsage(body?.usage),
          choices: [{ message: { content: anthropicOutputText(body) } }],
        }),
      };
    } catch {
      return resp;
    }
  }

  const resp = await moo.http.fetch({
    method: "POST",
    url: provider.baseUrl + "/" + (responsesApi ? "responses" : "chat/completions"),
    headers: llmProviderHeaders(provider),
    body,
  });
  if (!responsesApi || resp.status >= 400) return resp;
  try {
    const body = JSON.parse(resp.body);
    return {
      ...resp,
      body: JSON.stringify({
        model: body?.model || provider.model,
        usage: normalizeUsage(body?.usage),
        choices: [{ message: { content: responseOutputText(body) } }],
      }),
    };
  } catch {
    return resp;
  }
}

// -- usage tracking -------------------------------------------------------
//
// Per-chat token totals, grouped by model. Stored as JSON at
// `chat/{id}/usage`; the chats listing reads it and multiplies by the
// pricing table to expose a per-chat cost in the sidebar.
export type RawUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

export type LlmStreamProgress = {
  estimatedPromptTokens: number;
  tokenBudget: number;
  tokenThreshold: number;
};

export function llmStreamEventOptions(
  chatId: string,
  draftId: string,
  tokenProgress?: LlmStreamProgress | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (draftId) out.draftEvent = { kind: "draft", chatId, draftId };
  if (tokenProgress) {
    Object.assign(out, tokenProgress);
    out.tokenProgressEvent = {
      kind: "tokens",
      chatId,
      budget: tokenProgress.tokenBudget,
      threshold: tokenProgress.tokenThreshold,
      estimated: true,
    };
  }
  return out;
}

function promptTokensFromUsage(usage: RawUsage | null | undefined): number | null {
  const used = Number(usage?.prompt_tokens ?? 0);
  return Number.isFinite(used) && used > 0 ? used : null;
}

export async function tokenUsageEvent(chatId: string, usage: RawUsage | null | undefined, provider?: Pick<LLMProvider, "name" | "model"> | null) {
  const used = promptTokensFromUsage(usage);
  if (used == null) return null;
  const budget = await contextBudget(provider);
  const threshold = Math.floor(budget * COMPACT_FRACTION);
  return {
    kind: "tokens",
    chatId,
    used,
    budget,
    threshold,
    fraction: budget > 0 ? used / budget : 0,
    usage,
  };
}

export type ChatUsage = {
  models: Record<string, { input: number; cachedInput: number; output: number }>;
  // Most recent prompt token count, used to drive the header bar and the
  // compaction trigger. The provider's number is far more accurate than our
  // chars/4 estimate (which misses tool schemas, array content, and images).
  lastPromptTokens?: number;
};

export async function recordUsage(
  chatId: string,
  model: string | null,
  usage: RawUsage | null | undefined,
): Promise<void> {
  if (!usage || !model) return;
  const promptTotal = Number(usage.prompt_tokens ?? 0);
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? 0);
  if (!promptTotal && !output) return;
  const ref = chatRefs(chatId).usage;
  const existingHash = await moo.refs.get(ref);
  const current: ChatUsage = existingHash
    ? ((await moo.objects.getJSON<ChatUsage>(existingHash))?.value ?? { models: {} })
    : { models: {} };
  const slot = current.models[model] ?? { input: 0, cachedInput: 0, output: 0 };
  // Keep `input` as the non-cached portion so cost math stays additive.
  slot.input += Math.max(0, promptTotal - cached);
  slot.cachedInput += cached;
  slot.output += output;
  current.models[model] = slot;
  if (promptTotal > 0) current.lastPromptTokens = promptTotal;
  const next = await moo.objects.put("agent:Usage", JSON.stringify(current));
  await moo.refs.set(ref, next);
}

export async function readLastPromptTokens(chatId: string): Promise<number> {
  const ref = chatRefs(chatId).usage;
  const hash = await moo.refs.get(ref);
  if (!hash) return 0;
  const obj = await moo.objects.getJSON<ChatUsage>(hash);
  return Number(obj?.value?.lastPromptTokens ?? 0);
}

// -- compaction ------------------------------------------------------------

async function readCompaction(chatId: string): Promise<{
  throughAt: number;
  summary: string | null;
  hash: string | null;
}> {
  const ref = chatRefs(chatId).compaction;
  const hash = await moo.refs.get(ref);
  if (!hash) return { throughAt: 0, summary: null, hash: null };
  const obj = await moo.objects.getJSON<{
    throughAt?: number;
    summary?: string;
    parent?: string | null;
  }>(hash);
  return {
    throughAt: obj?.value?.throughAt ?? 0,
    summary: obj?.value?.summary ?? null,
    hash,
  };
}


async function deletedUserInputSteps(chatId: string): Promise<Array<{ step: string; at: number }>> {
  const c = chatRefs(chatId);
  const rows = await moo.facts.matchAll(
    [
      ["?step", "rdf:type", "agent:Step"],
      ["?step", "agent:kind", "agent:UserInput"],
      ["?step", "agent:createdAt", "?at"],
      ["?step", "agent:deletedAt", "?deletedAt"],
    ],
    { ref: c.facts, graph: c.graph },
  );
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
    promptTokens?: number | null;
    tokenBudget?: number | null;
    tokenThreshold?: number | null;
  }> = [];
  let cursor: string | null = await moo.refs.get(chatRefs(chatId).compaction);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const obj = await moo.objects.getJSON<{
      summary?: string;
      throughAt?: number;
      at?: number;
      parent?: string | null;
      trigger?: string | null;
      promptTokens?: number | null;
      tokenBudget?: number | null;
      tokenThreshold?: number | null;
    }>(cursor);
    if (!obj?.value) break;
    out.push({
      hash: cursor,
      summary: obj.value.summary || "",
      throughAt: obj.value.throughAt || 0,
      at: obj.value.at || 0,
      parent: obj.value.parent ?? null,
      trigger: obj.value.trigger ?? null,
      promptTokens: obj.value.promptTokens ?? null,
      tokenBudget: obj.value.tokenBudget ?? null,
      tokenThreshold: obj.value.tokenThreshold ?? null,
    });
    cursor = obj.value.parent ?? null;
  }
  return out;
}

export type CompactionTracking = {
  trigger?: "automatic" | "manual";
  promptTokens?: number | null;
  tokenBudget?: number | null;
  tokenThreshold?: number | null;
};

function compactionExtras(meta: CompactionTracking | undefined, model?: string | null, effort?: string | null): Array<[string, string]> {
  const extras = modelExtras(model, effort);
  const trigger = meta?.trigger === "manual" ? "agent:Manual" : "agent:Automatic";
  extras.push(["agent:trigger", trigger]);
  if (meta?.promptTokens != null) extras.push(["agent:promptTokens", String(meta.promptTokens)]);
  if (meta?.tokenBudget != null) extras.push(["agent:tokenBudget", String(meta.tokenBudget)]);
  if (meta?.tokenThreshold != null) extras.push(["agent:tokenThreshold", String(meta.tokenThreshold)]);
  return extras;
}

export async function recordCompactionFailure(chatId: string, reason: string, meta: CompactionTracking = {}): Promise<void> {
  const trigger = meta.trigger ?? "automatic";
  const payloadHash = await moo.objects.put("agent:Error", JSON.stringify({ phase: "compaction", reason, trigger, ...meta }));
  await appendStep(chatId, {
    kind: "agent:Error",
    status: "agent:Failed",
    payloadHash,
    extras: [["agent:phase", "agent:Compaction"], ...compactionExtras({ ...meta, trigger })],
  });
}

export async function runCompaction(chatId: string, provider: LLMProvider, meta: CompactionTracking = {}): Promise<boolean> {
  const messages = await buildLLMMessages(chatId);
  if (messages.length < 4) return false;

  const summaryMessages = [
    {
      role: "system",
      content:
        "You compress conversation history. Produce a tight summary capturing user intents, decisions made, files touched, errors hit. Plain prose, 200-400 words.",
    },
    ...messages.slice(1),
    { role: "user", content: "Summarize the above conversation now." },
  ];

  const resp = await callChatCompletions(provider, summaryMessages, null);
  if (resp.status >= 400) {
    await recordCompactionFailure(chatId, `provider returned HTTP ${resp.status}`, meta);
    return false;
  }
  let body: any;
  try {
    body = JSON.parse(resp.body);
  } catch {
    await recordCompactionFailure(chatId, "provider returned invalid JSON", meta);
    return false;
  }
  const summary: string | undefined = body?.choices?.[0]?.message?.content?.trim();
  if (!summary) {
    await recordCompactionFailure(chatId, "provider returned an empty summary", meta);
    return false;
  }
  await recordUsage(chatId, body?.model || provider.model, normalizeUsage(body?.usage));

  const now = await moo.time.now();
  const previous = await moo.refs.get(chatRefs(chatId).compaction);
  const compactionHash = await moo.objects.put(
    "agent:Compaction",
    JSON.stringify({
      summary,
      throughAt: now,
      at: now,
      parent: previous ?? null,
      trigger: meta.trigger ?? "manual",
      promptTokens: meta.promptTokens ?? null,
      tokenBudget: meta.tokenBudget ?? null,
      tokenThreshold: meta.tokenThreshold ?? null,
    }),
  );
  await moo.refs.set(chatRefs(chatId).compaction, compactionHash);
  await appendStep(chatId, {
    kind: "agent:Compaction",
    status: "agent:Done",
    payloadHash: compactionHash,
    extras: compactionExtras({ ...meta, trigger: meta.trigger ?? "manual" }, body?.model || provider.model, provider.effort),
  });
  return true;
}

// -- messages --------------------------------------------------------------

export async function buildLLMMessages(chatId: string): Promise<any[]> {
  const c = chatRefs(chatId);
  const compaction = await readCompaction(chatId);
  const deletedSteps = await deletedUserInputSteps(chatId);
  const deletedStepIds = new Set(deletedSteps.map((row) => row.step));
  const summaryMayContainDeletedUserInput = deletedSteps.some((row) => row.at > 0 && row.at <= compaction.throughAt);

  const steps = await moo.facts.matchAll(
    [
      ["?step", "rdf:type", "agent:Step"],
      ["?step", "agent:kind", "?kind"],
      ["?step", "agent:createdAt", "?at"],
    ],
    { ref: c.facts, graph: c.graph },
  );

  const responses = await moo.facts.matchAll(
    [
      ["?resp", "rdf:type", "ui:InputResponse"],
      ["?resp", "ui:respondsTo", "?req"],
      ["?resp", "ui:createdAt", "?at"],
    ],
    { ref: c.facts, graph: c.graph },
  );

  type Entry = { at: number; role: "user" | "assistant"; content: any };
  const entries: Entry[] = [];

  for (const s of steps) {
    const at = Number(s["?at"]);
    if (at <= compaction.throughAt) continue;
    if (s["?kind"] === "agent:UserInput") {
      if (deletedStepIds.has(s["?step"]!)) continue;
      const p = await loadPayloadJSON(c.facts, c.graph, s["?step"]!);
      const text = p?.value?.message || "";
      const attachments = Array.isArray(p?.value?.attachments) ? p.value.attachments : [];
      if (attachments.length) {
        entries.push({
          at,
          role: "user",
          content: [
            { type: "text", text: text || "Please inspect this image." },
            ...attachments
              .filter((a: any) => a?.type === "image" && typeof a.dataUrl === "string")
              .map((a: any) => ({ type: "image_url", image_url: { url: a.dataUrl } })),
          ],
        });
      } else if (text) {
        entries.push({ at, role: "user", content: text });
      }
    } else if (s["?kind"] === "agent:Reply") {
      const p = await loadPayloadJSON(c.facts, c.graph, s["?step"]!);
      const text = p?.value?.text;
      if (text) entries.push({ at, role: "assistant", content: text });
    }
  }

  for (const r of responses) {
    const at = Number(r["?at"]);
    if (at <= compaction.throughAt) continue;
    const reqId = r["?req"]!;
    const spec = await loadPayloadJSON(c.facts, c.graph, reqId, "ui:payload");
    const payload = await loadPayloadJSON(c.facts, c.graph, r["?resp"]!, "ui:payload");
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

  const messages: any[] = [{ role: "system", content: await buildSystemPrompt(chatId) }];
  if (compaction.summary && !summaryMayContainDeletedUserInput) {
    messages.push({
      role: "system",
      content: `Summary of earlier conversation:\n${compaction.summary}`,
    });
  }
  for (const e of entries) messages.push({ role: e.role, content: e.content });
  return messages;
}

export async function loadPayloadJSON(
  factsRef: string,
  graph: string,
  subject: string,
  predicate: string = "agent:payload",
): Promise<{ kind: string; value: any } | null> {
  const rows = await moo.facts.match(factsRef, {
    graph,
    subject,
    predicate,
    limit: 1,
  });
  if (!rows.length) return null;
  return await moo.objects.getJSON(rows[0]![3]);
}

export async function loadResultJSON(
  factsRef: string,
  graph: string,
  subject: string,
): Promise<{ kind: string; value: any } | null> {
  const rows = await moo.facts.match(factsRef, {
    graph,
    subject,
    predicate: "agent:result",
    limit: 1,
  });
  if (!rows.length) return null;
  return await moo.objects.getJSON(rows[0]![3]);
}

// -- tool execution --------------------------------------------------------
//
// One tool is exposed to the LLM: runJS. The model sends JS code; the harness
// evaluates it as the body of an async IIFE with `moo`, `chatId`, `scratch`, and optional `args` in scope.

function serializeToolValue(v: any): string {
  if (v === undefined) return "undefined";
  if (typeof v === "string") return v;
  try {
    return formatHjson(v, "", 60);
  } catch {
    return String(v);
  }
}

// HJSON/JSON5-style formatter: unquoted keys when they're identifiers,
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
    return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
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
    const items = keys.map((k) => {
      const fk = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
      const formatted = formatHjson(value[k], inner, wrap);
      const sep = formatted.startsWith("'''") ? `:\n${inner}` : ": ";
      return `${fk}${sep}${formatted}`;
    });
    const single = `{ ${items.join(", ")} }`;
    if (single.length <= wrap && !single.includes("\n")) return single;
    return `{\n${inner}${items.join(`,\n${inner}`)}\n${indent}}`;
  }
  return String(value);
}

function formatHjsonString(value: string, indent: string): string {
  if (!/[\r\n]/.test(value) || value.includes("'''")) return JSON.stringify(value);
  const inner = indent + "  ";
  const lines = value.split(/\r\n|\r|\n/);
  return `'''\n${lines.map((l) => inner + l).join("\n")}\n${inner}'''`;
}

async function toolRunJS(
  chatId: string,
  toolArgs: any,
  model?: string | null,
): Promise<{ toolText: string }> {
  const code = typeof toolArgs?.code === "string" ? toolArgs.code : "";
  const label = typeof toolArgs?.label === "string" ? toolArgs.label.trim() : "";
  const description = typeof toolArgs?.description === "string" ? toolArgs.description.trim() : "";
  const hasRunArgs = Object.prototype.hasOwnProperty.call(toolArgs ?? {}, "args");
  const runArgs = hasRunArgs ? toolArgs.args : undefined;
  const started = Date.now();
  const runJsStep = await startRunJSStep(chatId, code, label, description, runArgs, hasRunArgs, started, model);
  if (!code.trim()) {
    await finishRunJSStep(chatId, runJsStep.stepId, null, "missing code");
    return { toolText: "error: runJS requires `code`" };
  }
  let result: any = undefined;
  let error: string | null = null;
  try {
    const fn = new Function(
      "moo",
      "chatId",
      "scratch",
      "args",
      `return (async () => { ${code}\n})();`,
    );
    const scratch = await moo.chat.scratch(chatId);
    const depth = await subagentDepth(chatId);
    result = await withMooRunJSContext(chatId, runJsStep.stepId, depth, () =>
      withMooChatContext(chatId, () => fn(moo, chatId, scratch, runArgs)),
    );
  } catch (e: any) {
    error = e?.message ?? String(e);
  }
  const durationMs = Date.now() - started;
  const serialized = error ? null : serializeToolValue(result);
  await finishRunJSStep(
    chatId,
    runJsStep.stepId,
    error ? null : { value: serialized, durationMs },
    error,
  );
  if (error) return { toolText: `error: ${error}` };
  return { toolText: truncate(serialized ?? "undefined", 4000) };
}

async function subagentDepth(chatId: string): Promise<number> {
  const raw = await moo.refs.get(`chat/${chatId}/subagent-depth`);
  const n = Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

async function startRunJSStep(
  chatId: string,
  code: string,
  label: string,
  description: string,
  runArgs: any,
  hasRunArgs: boolean,
  startedAt: number,
  model?: string | null,
) {
  const payloadHash = await moo.objects.put(
    "agent:RunJS",
    JSON.stringify({
      code,
      label: label || null,
      description: description || null,
      ...(hasRunArgs ? { args: runArgs } : {}),
    }),
  );
  return await appendStep(chatId, {
    kind: "agent:RunJS",
    status: "agent:Running",
    payloadHash,
    extras: modelExtras(model),
    at: startedAt,
  });
}

async function finishRunJSStep(
  chatId: string,
  stepId: string,
  result: { value: string; durationMs: number } | null,
  error: string | null,
) {
  const c = chatRefs(chatId);
  const resultHash = result
    ? await moo.objects.put("agent:ToolResult", JSON.stringify(result))
    : error
      ? await moo.objects.put("agent:ToolResult", JSON.stringify({ error }))
      : null;
  const statusRows = await moo.facts.match(c.facts, { graph: c.graph, subject: stepId, predicate: "agent:status" });
  await moo.facts.update(c.facts, (txn) => {
    for (const [g, s, p, o] of statusRows) txn.remove(g, s, p, o);
    txn.add(c.graph, stepId, "agent:status", error ? "agent:Failed" : "agent:Done");
    if (resultHash) txn.add(c.graph, stepId, "agent:result", resultHash);
    if (error) txn.add(c.graph, stepId, "agent:error", error);
  });
}

export async function hasPendingInput(chatId: string): Promise<boolean> {
  const c = chatRefs(chatId);
  const rows = await moo.facts.matchAll(
    [
      ["?req", "rdf:type", "ui:InputRequest"],
      ["?req", "ui:status", "ui:Pending"],
    ],
    { ref: c.facts, graph: c.graph, limit: 1 },
  );
  return rows.length > 0;
}

export async function executeToolCall(
  chatId: string,
  tc: any,
  model?: string | null,
): Promise<{ toolText: string }> {
  const name = tc?.function?.name;
  let args: any = {};
  try {
    args = JSON.parse(tc?.function?.arguments || "{}");
  } catch {
    args = {};
  }
  if (name === "runJS") return toolRunJS(chatId, args, model);
  const started = Date.now();
  const unknown = await startRunJSStep(
    chatId,
    JSON.stringify({ tool: name, args }),
    "",
    "",
    undefined,
    false,
    started,
    model,
  );
  await finishRunJSStep(chatId, unknown.stepId, null, `unknown tool: ${name}`);
  return { toolText: `unknown tool: ${name}` };
}

export async function runToolCall(chatId: string, tc: any, model?: string | null): Promise<{ toolText: string }> {
  return executeToolCall(chatId, tc, model);
}

// -- /slash commands -------------------------------------------------------

export async function respondTo(chatId: string, message: string) {
  if (message.startsWith("/run ")) {
    const cmdline = message.slice(5).trim();
    if (!cmdline) return [await reply(chatId, "usage: /run <cmd> [args...]")];
    return [await runShellAndRecord(chatId, cmdline)];
  }
  if (message === "/compact") {
    const provider = await resolveProvider(await selectedModelForChat(chatId), await selectedEffortForChat(chatId));
    if (!provider.apiKey) {
      return [await reply(chatId, `cannot compact: ${provider.keyEnvHint} not set`)];
    }
    const did = await runCompaction(chatId, provider, { trigger: "manual" });
    return [
      await reply(
        chatId,
        did ? "compacted older turns into a summary" : "nothing to compact yet",
      ),
    ];
  }
  if (message === "/help") {
    return [
      await reply(
        chatId,
        [
          "## Commands",
          "",
          "| Command | Description |",
          "| --- | --- |",
          "| `/run <cmd> [args]` | Run a shell command in this chat's scratch directory. |",
          "| `/compact` | Summarise older turns into a synthetic system note. |",
          "| `/help` | Show this help. |",
          "",
          "Type a normal non-slash message to talk to the LLM agent (needs the provider's API key).",
        ].join("\n"),
      ),
    ];
  }

  return [await reply(chatId, `unknown command: ${message}`)];
}

export async function runShellAndRecord(
  chatId: string,
  cmdline: string,
  procOpts: { cwd?: string; stdin?: string; timeoutMs?: number } = {},
) {
  const argv = parseArgv(cmdline);
  const [cmd, ...args] = argv;
  if (!cmd) return await reply(chatId, "usage: /run <cmd> [args...]");
  const wt = await moo.chat.scratch(chatId);
  const payloadHash = await moo.objects.put(
    "agent:ShellCommand",
    JSON.stringify({ cmd, args, cwd: wt }),
  );
  let result: any = null;
  let status: "agent:Done" | "agent:Failed" = "agent:Done";
  let errMsg: string | null = null;
  try {
    result = await moo.proc.run(cmd, args, { cwd: wt, ...procOpts });
    if (result.timedOut || result.code !== 0) status = "agent:Failed";
  } catch (err: any) {
    errMsg = err?.message ?? String(err);
    status = "agent:Failed";
  }

  const extras: Array<[string, string]> = [];
  if (result) {
    const resultHash = await moo.objects.put(
      "agent:ToolResult",
      JSON.stringify({ cmd, args, cwd: wt, ...result }),
    );
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

export function formatStep(item: any, payload: any, result: any): string {
  switch (item.kind) {
    case "agent:UserInput":
      return payload?.value?.message ?? "";
    case "agent:Reply":
      return payload?.value?.text ?? "";
    case "agent:Compaction": {
      const summary = payload?.value?.summary || "";
      const trigger = payload?.value?.trigger === "automatic" ? "automatic " : payload?.value?.trigger === "manual" ? "manual " : "";
      return `${trigger}compaction\n${summary}`;
    }
    case "agent:RunJS": {
      const code = payload?.value?.code ?? "";
      const label = payload?.value?.label ?? "";
      const description = payload?.value?.description ?? "";
      let tail = "";
      if (result?.value) {
        if (typeof result.value === "object" && result.value.error) {
          tail = `error: ${result.value.error}`;
        } else if (typeof result.value === "object" && "value" in result.value) {
          tail = `→ ${result.value.value} (${result.value.durationMs}ms)`;
        } else {
          tail = JSON.stringify(result.value);
        }
      }
      // Sentinel-prefixed lines keep the format robust if code or
      // description happens to start with a colon. The frontend parser in
      // RunJSBody splits on these markers.
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
      const text = r?.text ? `\n\n${truncate(r.text, 1200)}` : "";
      const err = r?.error ? `\nerror: ${r.error}` : "";
      return [label, child, status, task].filter(Boolean).join("\n") + text + err;
    }
    case "agent:ShellCommand": {
      const cmd = payload?.value
        ? `$ ${payload.value.cmd}${(payload.value.args || [])
            .map((a: string) => " " + maybeQuote(a))
            .join("")}`
        : "";
      const tail = result?.value
        ? `(exit ${result.value.code} · ${result.value.durationMs}ms${
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
      const detail = v.detail || {};
      const status = detail.status ? `HTTP ${detail.status}` : null;
      const source = detail.source || v.kind || "error";
      const head = [source, detail.model, status].filter(Boolean).join(" · ");
      const body = detail.message || "";
      return [head, body].filter(Boolean).join("\n");
    }
    default:
      return "";
  }
}
