import { Effect, ok } from "./core/effect";
import { moo, traceJsonValue } from "./moo";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue | undefined };
type MutableJsonObject = { [key: string]: unknown };

type LlmToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type StreamOutputEvent = JsonObject;
type ParsedStreamEvent = MutableJsonObject;
type StreamEventsView = StreamEventConfig | JsonObject;
type TokenProgressTemplate = JsonObject & { budget?: number | string };
type StreamHeaders = Record<string, string | string[] | undefined>;
type StreamEventConfig = JsonObject & {
  provider?: unknown;
  model?: string | null;
  estimatedPromptTokens?: number | string;
  tokenBudget?: number | string;
  tokenProgressEvent?: JsonObject & { budget?: number | string };
};

type LlmStreamBaseInput = {
  provider?: unknown;
  model?: string | null;
  events?: unknown[];
  state?: unknown;
  streamEvents?: StreamEventConfig;
  status?: number | string;
  headers?: StreamHeaders | JsonObject | null;
  error?: unknown;
  errorBody?: unknown;
};

type LlmStreamInitInput = LlmStreamBaseInput;
type LlmStreamAccumulateInput = LlmStreamBaseInput & {
  state?: unknown;
  events?: unknown[];
};
type LlmStreamFinalizeInput = LlmStreamBaseInput & { state?: unknown };
type LlmStreamErrorInput = LlmStreamFinalizeInput;
type Input =
  | LlmStreamInitInput
  | LlmStreamAccumulateInput
  | LlmStreamFinalizeInput
  | LlmStreamErrorInput;

type LlmAccumulatorState = {
  content: string;
  toolCalls: LlmToolCall[];
  anthropicThinkingBlocks: Array<{
    type: "thinking";
    thinking: string;
    signature: string;
  }>;
  model: string | null;
  usage: unknown | null;
  error: unknown | null;
  reasoningContent: string;
  stopReason: string | null;
  deepseekThinkOpen: boolean;
  deepseekTagBuffer: string;
  lastTokenProgressUsed: number;
  anthropicToolIndex: number | null;
  anthropicToolBlockToCall: Record<string, number>;
  anthropicThinkingBlockIndex: number | null;
  anthropicThinkingBlockToIndex: Record<string, number>;
  nextSyntheticToolCallId: number;
};

function syntheticToolCallId(state: LlmAccumulatorState): string {
  state.nextSyntheticToolCallId += 1;
  return `call_moo_${state.nextSyntheticToolCallId}`;
}

export function llmStreamInitCommand(input: LlmStreamInitInput) {
  return llmStreamInitEffect(input).map((value) => ok(value));
}

export function llmStreamInitEffect(
  input: LlmStreamInitInput,
): Effect<{ state: LlmAccumulatorState; events: StreamOutputEvent[] }> {
  return Effect.tryPromise(
    async () =>
      moo.traces.span({
        name: "llm.stream.init",
        data: llmStreamInputSummary(input),
        fn: async () => {
          const streamEvents =
            input.streamEvents && typeof input.streamEvents === "object"
              ? input.streamEvents
              : {};
          const estimated =
            Number(streamEvents.estimatedPromptTokens ?? 0) || 0;
          const state: LlmAccumulatorState = {
            content: "",
            toolCalls: [],
            anthropicThinkingBlocks: [],
            model: null,
            usage: null,
            error: null,
            reasoningContent: "",
            stopReason: null,
            deepseekThinkOpen: false,
            deepseekTagBuffer: "",
            lastTokenProgressUsed: estimated,
            anthropicToolIndex: null,
            anthropicToolBlockToCall: {},
            anthropicThinkingBlockIndex: null,
            anthropicThinkingBlockToIndex: {},
            nextSyntheticToolCallId: 0,
          };
          const events: StreamOutputEvent[] = [];
          const tokenEvent = streamEvents.tokenProgressEvent;
          if (tokenEvent && typeof tokenEvent === "object") {
            events.push(
              tokenProgressPayload(
                tokenEvent,
                estimated,
                Number(streamEvents.tokenBudget ?? tokenEvent.budget ?? 0) || 0,
              ),
            );
          }
          await moo.traces.mark({
            message: "llm.stream.init.result",
            data: { estimatedPromptTokens: estimated, events },
          });
          return { state, events };
        },
      }),
    "llm stream init failed",
  );
}

export function llmStreamAccumulateCommand(input: LlmStreamAccumulateInput) {
  return llmStreamAccumulateEffect(input).map((value) => ok(value));
}

export function llmStreamAccumulateEffect(
  input: LlmStreamAccumulateInput,
): Effect<{ state: LlmAccumulatorState; events: StreamOutputEvent[] }> {
  return Effect.tryPromise(
    async () =>
      moo.traces.span({
        name: "llm.stream.accumulate",
        data: llmStreamInputSummary(input),
        fn: async () => {
          const state = normalizeLlmAccumulatorState(input.state);
          const streamEvents =
            input.streamEvents && typeof input.streamEvents === "object"
              ? input.streamEvents
              : {};
          const events: StreamOutputEvent[] = [];
          const rawEvents = Array.isArray(input.events) ? input.events : [];
          let parsedCount = 0;
          let ignoredCount = 0;
          for (const raw of rawEvents) {
            if (typeof raw !== "string") {
              ignoredCount++;
              continue;
            }
            const parsed = parseStreamJsonEvent(raw);
            if (parsed == null) {
              ignoredCount++;
              continue;
            }
            parsedCount++;
            await moo.traces.mark({
              message: "llm.stream.event",
              data: { event: traceJsonValue(parsed) },
            });
            accumulateLlmStreamEvent(state, parsed, streamEvents, events);
          }
          await moo.traces.mark({
            message: "llm.stream.accumulate.result",
            data: {
              rawEvents,
              parsedEvents: parsedCount,
              ignoredEvents: ignoredCount,
              events,
              state: traceJsonValue(state),
            },
          });
          return { state, events };
        },
      }),
    "llm stream accumulate failed",
  );
}

export function llmStreamFinalizeCommand(input: LlmStreamFinalizeInput) {
  return llmStreamFinalizeEffect(input).map((value) => ok(value));
}

export function llmStreamFinalizeEffect(
  input: LlmStreamFinalizeInput,
): Effect<any> {
  return Effect.tryPromise(
    async () =>
      moo.traces.span({
        name: "llm.stream.finalize",
        data: llmStreamInputSummary(input),
        fn: async () => {
          const state = normalizeLlmAccumulatorState(input.state);
          const content = finalLlmContent(state);
          const status = Number(input.status ?? 0) || 0;
          const result =
            state.error != null
              ? {
                  status,
                  ok: false,
                  content,
                  toolCalls: state.toolCalls,
                  errorBody: formatStreamErrorBody(state.error),
                  headers:
                    input.headers && typeof input.headers === "object"
                      ? input.headers
                      : null,
                  reasoningContent: state.reasoningContent || null,
                  stopReason: state.stopReason,
                  anthropicThinkingBlocks: state.anthropicThinkingBlocks.length
                    ? state.anthropicThinkingBlocks
                    : undefined,
                  model: state.model,
                  usage: state.usage,
                }
              : {
                  status,
                  ok: true,
                  content,
                  toolCalls: state.toolCalls,
                  errorBody: null,
                  reasoningContent: state.reasoningContent || null,
                  stopReason: state.stopReason,
                  anthropicThinkingBlocks: state.anthropicThinkingBlocks.length
                    ? state.anthropicThinkingBlocks
                    : undefined,
                  model: state.model,
                  usage: state.usage,
                };
          await moo.traces.mark({
            message: "llm.stream.finalize.result",
            data: { result: traceJsonValue(result) },
          });
          return result;
        },
      }),
    "llm stream finalize failed",
  );
}

export function llmStreamErrorCommand(input: LlmStreamErrorInput) {
  return llmStreamErrorEffect(input).map((value) => ok(value));
}

export function llmStreamErrorEffect(input: LlmStreamErrorInput): Effect<any> {
  return Effect.tryPromise(
    async () =>
      moo.traces.span({
        name: "llm.stream.error",
        data: llmStreamInputSummary(input),
        fn: async () => {
          const state = normalizeLlmAccumulatorState(input.state);
          const content = finalLlmContent(state);
          const errorBody = formatStreamErrorBody(
            input.errorBody ?? input.error ?? "stream failed",
          );
          const result = {
            status: Number(input.status ?? 0) || 0,
            ok: false,
            content,
            toolCalls: state.toolCalls,
            errorBody,
            headers:
              input.headers && typeof input.headers === "object"
                ? input.headers
                : null,
            reasoningContent: state.reasoningContent || null,
            stopReason: state.stopReason,
            model: state.model,
            usage: state.usage,
          };
          await moo.traces.mark({
            message: "llm.stream.error.result",
            data: {
              result: traceJsonValue(result),
              state: traceJsonValue(state),
            },
          });
          return result;
        },
      }),
    "llm stream error failed",
  );
}

function llmStreamInputSummary(input: Input): Record<string, unknown> {
  const rawEvents = Array.isArray(input.events) ? input.events : [];
  const streamEvents =
    input.streamEvents && typeof input.streamEvents === "object"
      ? input.streamEvents
      : {};
  return {
    provider: input.provider ?? streamEvents.provider ?? null,
    model:
      input.model ??
      streamEvents.model ??
      (input.state != null &&
      typeof input.state === "object" &&
      !Array.isArray(input.state)
        ? (input.state as { model?: unknown }).model
        : null) ??
      null,
    status: input.status ?? null,
    events: rawEvents,
    state: input.state
      ? traceJsonValue(normalizeLlmAccumulatorState(input.state))
      : null,
    streamEvents: traceJsonValue(streamEvents),
    headers:
      input.headers && typeof input.headers === "object"
        ? traceJsonValue(input.headers)
        : null,
    error: input.error ?? input.errorBody ?? null,
  };
}

function isObject(value: unknown): value is MutableJsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isLlmToolCall(value: unknown): value is LlmToolCall {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    value.type === "function" &&
    isObject(value.function) &&
    typeof value.function.name === "string" &&
    typeof value.function.arguments === "string"
  );
}

function numericRecord(value: MutableJsonObject): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const n = Number(raw);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

function normalizeLlmAccumulatorState(raw: unknown): LlmAccumulatorState {
  return {
    content:
      isObject(raw) && typeof raw.content === "string" ? raw.content : "",
    toolCalls:
      isObject(raw) && Array.isArray(raw.toolCalls)
        ? raw.toolCalls.filter(isLlmToolCall)
        : [],
    anthropicThinkingBlocks:
      isObject(raw) && Array.isArray(raw.anthropicThinkingBlocks)
        ? (raw.anthropicThinkingBlocks
            .map(normalizeAnthropicThinkingBlock)
            .filter(Boolean) as Array<{
            type: "thinking";
            thinking: string;
            signature: string;
          }>)
        : [],
    model:
      isObject(raw) && typeof raw.model === "string" && raw.model
        ? raw.model
        : null,
    usage: isObject(raw) ? (raw.usage ?? null) : null,
    error: isObject(raw) ? (raw.error ?? null) : null,
    reasoningContent:
      isObject(raw) && typeof raw.reasoningContent === "string"
        ? raw.reasoningContent
        : "",
    stopReason:
      isObject(raw) && typeof raw.stopReason === "string" && raw.stopReason
        ? raw.stopReason
        : null,
    deepseekThinkOpen: isObject(raw) && raw.deepseekThinkOpen === true,
    deepseekTagBuffer:
      isObject(raw) && typeof raw.deepseekTagBuffer === "string"
        ? raw.deepseekTagBuffer
        : "",
    lastTokenProgressUsed:
      Number(isObject(raw) ? (raw.lastTokenProgressUsed ?? 0) : 0) || 0,
    anthropicToolIndex:
      isObject(raw) && Number.isFinite(Number(raw.anthropicToolIndex))
        ? Number(raw.anthropicToolIndex)
        : null,
    anthropicToolBlockToCall:
      isObject(raw) && isObject(raw.anthropicToolBlockToCall)
        ? numericRecord(raw.anthropicToolBlockToCall)
        : {},
    anthropicThinkingBlockIndex:
      isObject(raw) && Number.isFinite(Number(raw.anthropicThinkingBlockIndex))
        ? Number(raw.anthropicThinkingBlockIndex)
        : null,
    anthropicThinkingBlockToIndex:
      isObject(raw) && isObject(raw.anthropicThinkingBlockToIndex)
        ? numericRecord(raw.anthropicThinkingBlockToIndex)
        : {},
    nextSyntheticToolCallId:
      Number(isObject(raw) ? (raw.nextSyntheticToolCallId ?? 0) : 0) || 0,
  };
}

function normalizeAnthropicThinkingBlock(
  value: unknown,
): { type: "thinking"; thinking: string; signature: string } | null {
  if (!isObject(value) || value.type !== "thinking") return null;
  const signature = typeof value.signature === "string" ? value.signature : "";
  if (!signature) return null;
  return {
    type: "thinking",
    thinking: typeof value.thinking === "string" ? value.thinking : "",
    signature,
  };
}

function accumulateLlmStreamEvent(
  state: LlmAccumulatorState,
  parsed: ParsedStreamEvent,
  streamEvents: StreamEventConfig | JsonObject,
  events: StreamOutputEvent[],
) {
  const response = isObject(parsed.response) ? parsed.response : {};
  const topModel = typeof parsed.model === "string" ? parsed.model : "";
  const responseModel =
    typeof response.model === "string" ? response.model : "";
  if (!state.model && topModel) state.model = topModel;
  if (!state.model && responseModel) state.model = responseModel;
  if (parsed?.usage != null) state.usage = parsed.usage;
  if (response.usage != null) state.usage = response.usage;
  if (parsed?.error != null) state.error = parsed;

  const type = typeof parsed?.type === "string" ? parsed.type : "";
  if (type === "message_start") {
    const msg = isObject(parsed.message) ? parsed.message : {};
    if (typeof msg.model === "string" && msg.model) state.model = msg.model;
    if (msg.usage != null) state.usage = msg.usage;
    if (typeof msg.stop_reason === "string" && msg.stop_reason)
      state.stopReason = msg.stop_reason;
  }
  if (type === "message_delta") {
    if (parsed?.usage != null)
      state.usage = { ...(state.usage || {}), ...parsed.usage };
    const delta = isObject(parsed.delta) ? parsed.delta : {};
    if (delta.usage != null && isObject(delta.usage))
      state.usage = {
        ...(isObject(state.usage) ? state.usage : {}),
        ...delta.usage,
      };
    if (typeof delta.stop_reason === "string" && delta.stop_reason)
      state.stopReason = delta.stop_reason;
  }
  if (type === "message_stop" && !state.stopReason) {
    const msg = isObject(parsed.message) ? parsed.message : {};
    if (typeof msg?.stop_reason === "string" && msg.stop_reason)
      state.stopReason = msg.stop_reason;
  }
  const contentBlock = isObject(parsed.content_block)
    ? parsed.content_block
    : {};
  if (type === "content_block_start" && contentBlock.type === "thinking") {
    const block = {
      type: "thinking" as const,
      thinking:
        typeof contentBlock.thinking === "string" ? contentBlock.thinking : "",
      signature:
        typeof contentBlock.signature === "string"
          ? contentBlock.signature
          : "",
    };
    state.anthropicThinkingBlocks.push(block);
    const thinkingIndex = state.anthropicThinkingBlocks.length - 1;
    state.anthropicThinkingBlockIndex = thinkingIndex;
    if (Number.isFinite(Number(parsed?.index))) {
      state.anthropicThinkingBlockToIndex[String(Number(parsed.index))] =
        thinkingIndex;
    }
    if (block.thinking)
      appendLlmReasoningDelta(state, block.thinking, streamEvents, events);
  }
  if (type === "content_block_start" && contentBlock.type === "tool_use") {
    const block = contentBlock;
    state.toolCalls.push({
      id: String(block.id || ""),
      type: "function",
      function: { name: String(block.name || ""), arguments: "" },
    });
    const callIndex = state.toolCalls.length - 1;
    state.anthropicToolIndex = callIndex;
    if (Number.isFinite(Number(parsed?.index))) {
      state.anthropicToolBlockToCall[String(Number(parsed.index))] = callIndex;
    }
  }
  if (type === "content_block_delta") {
    const delta = isObject(parsed.delta) ? parsed.delta : {};
    if (typeof delta.text === "string" && delta.text) {
      appendLlmContentDelta(state, delta.text, streamEvents, events);
    }
    const blockIndex = Number.isFinite(Number(parsed?.index))
      ? String(Number(parsed.index))
      : null;
    const thinkingIndex =
      blockIndex == null
        ? state.anthropicThinkingBlockIndex
        : state.anthropicThinkingBlockToIndex[blockIndex];
    const thinkingBlock =
      thinkingIndex == null
        ? null
        : state.anthropicThinkingBlocks[thinkingIndex];
    if (typeof delta.thinking === "string" && delta.thinking) {
      if (thinkingBlock) thinkingBlock.thinking += delta.thinking;
      appendLlmReasoningDelta(state, delta.thinking, streamEvents, events);
    }
    if (typeof delta.signature === "string" && thinkingBlock) {
      thinkingBlock.signature += delta.signature;
    }
    if (typeof delta.partial_json === "string") {
      const i =
        blockIndex == null
          ? state.anthropicToolIndex
          : state.anthropicToolBlockToCall[blockIndex];
      const slot = i == null ? null : state.toolCalls[i];
      if (slot)
        slot.function.arguments =
          String(slot.function.arguments || "") + delta.partial_json;
    }
  }
  if (type === "content_block_stop") {
    if (Number.isFinite(Number(parsed?.index)))
      delete state.anthropicToolBlockToCall[String(Number(parsed.index))];
    if (Number.isFinite(Number(parsed?.index)))
      delete state.anthropicThinkingBlockToIndex[String(Number(parsed.index))];
    state.anthropicToolIndex = null;
    state.anthropicThinkingBlockIndex = null;
  }
  if (
    typeof parsed?.delta === "string" &&
    type.includes("text.delta") &&
    parsed.delta
  ) {
    appendLlmContentDelta(state, parsed.delta, streamEvents, events);
  }
  const item = isObject(parsed.item) ? parsed.item : {};
  if (type === "response.output_item.done" && item.type === "function_call") {
    state.toolCalls.push({
      id: String(item.call_id || item.id || syntheticToolCallId(state)),
      type: "function",
      function: {
        name: String(item.name || ""),
        arguments: typeof item.arguments === "string" ? item.arguments : "{}",
      },
    });
  }

  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const firstChoice = isObject(choices[0]) ? choices[0] : {};
  if (
    typeof firstChoice.finish_reason === "string" &&
    firstChoice.finish_reason
  )
    state.stopReason = firstChoice.finish_reason;
  const delta = isObject(firstChoice.delta) ? firstChoice.delta : null;
  if (!delta) return;
  if (typeof delta.content === "string" && delta.content) {
    appendProviderContentDelta(state, delta.content, streamEvents, events);
  }
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
    appendLlmReasoningDelta(
      state,
      delta.reasoning_content,
      streamEvents,
      events,
    );
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const rawTc of delta.tool_calls) {
      const tc = isObject(rawTc) ? rawTc : {};
      const fn = isObject(tc.function) ? tc.function : {};
      const i = Number.isFinite(Number(tc.index)) ? Number(tc.index) : 0;
      while (state.toolCalls.length <= i) {
        state.toolCalls.push({
          id: syntheticToolCallId(state),
          type: "function",
          function: { name: "", arguments: "" },
        });
      }
      const slot = state.toolCalls[i];
      if (typeof tc.id === "string" && tc.id) slot.id = tc.id;
      if (tc.type === "function") slot.type = tc.type;
      if (typeof fn.name === "string" && fn.name) slot.function.name = fn.name;
      if (typeof fn.arguments === "string")
        slot.function.arguments =
          String(slot.function.arguments || "") + fn.arguments;
    }
  }
}

function appendProviderContentDelta(
  state: LlmAccumulatorState,
  delta: string,
  streamEvents: StreamEventsView,
  events: StreamOutputEvent[],
) {
  if (isDeepSeekStream(streamEvents)) {
    const parsed = splitDeepSeekThinkDelta(state, delta);
    if (parsed.reasoning)
      appendLlmReasoningDelta(state, parsed.reasoning, streamEvents, events);
    if (!parsed.content) return;
    appendLlmContentDelta(state, parsed.content, streamEvents, events);
    return;
  }
  appendLlmContentDelta(state, delta, streamEvents, events);
}

function appendLlmReasoningDelta(
  state: LlmAccumulatorState,
  delta: string,
  streamEvents: StreamEventsView,
  events: StreamOutputEvent[],
) {
  state.reasoningContent += delta;
  const draft = isObject(streamEvents.draftEvent)
    ? (streamEvents.draftEvent as JsonObject)
    : null;
  if (draft && draft.kind !== "compaction-draft") {
    events.push({
      ...draft,
      kind: "reasoning-draft",
      content: state.content,
      reasoningContent: state.reasoningContent,
      delta,
    });
  }
}

function appendLlmContentDelta(
  state: LlmAccumulatorState,
  delta: string,
  streamEvents: StreamEventsView,
  events: StreamOutputEvent[],
) {
  state.content += delta;
  const draft = isObject(streamEvents.draftEvent)
    ? (streamEvents.draftEvent as JsonObject)
    : null;
  if (draft) {
    events.push({
      ...draft,
      content: state.content,
      reasoningContent: state.reasoningContent || undefined,
      delta,
    });
  }
  const tokenEvent = isObject(streamEvents.tokenProgressEvent)
    ? (streamEvents.tokenProgressEvent as TokenProgressTemplate)
    : null;
  if (tokenEvent) {
    const estimated = Number(streamEvents.estimatedPromptTokens ?? 0) || 0;
    const budget =
      Number(streamEvents.tokenBudget ?? tokenEvent.budget ?? 0) || 0;
    const used = estimated + estimateTextTokens(state.content);
    if (used >= state.lastTokenProgressUsed + 8) {
      events.push(tokenProgressPayload(tokenEvent, used, budget));
      state.lastTokenProgressUsed = used;
    }
  }
}

function finalLlmContent(state: LlmAccumulatorState): string {
  if (state.deepseekTagBuffer) {
    const parsed = splitDeepSeekThinkDelta(state, "");
    if (parsed.reasoning)
      appendLlmReasoningDelta(state, parsed.reasoning, {}, []);
    if (parsed.content) state.content += parsed.content;
    if (state.deepseekTagBuffer) {
      const trailing = state.deepseekTagBuffer;
      state.deepseekTagBuffer = "";
      if (state.deepseekThinkOpen)
        appendLlmReasoningDelta(state, trailing, {}, []);
      else state.content += trailing;
    }
  }
  return state.content;
}

function isDeepSeekStream(streamEvents: StreamEventsView): boolean {
  const provider = String(streamEvents?.provider ?? "")
    .trim()
    .toLowerCase();
  if (provider === "deepseek") return true;
  const model = String(streamEvents?.model ?? "")
    .trim()
    .toLowerCase();
  return model.startsWith("deepseek");
}

function splitDeepSeekThinkDelta(
  state: LlmAccumulatorState,
  delta: string,
): { content: string; reasoning: string } {
  const combined = state.deepseekTagBuffer + delta;
  state.deepseekTagBuffer = "";
  let content = "";
  let reasoning = "";
  let i = 0;
  while (i < combined.length) {
    const lt = combined.indexOf("<", i);
    if (lt < 0) {
      const text = combined.slice(i);
      if (state.deepseekThinkOpen) reasoning += text;
      else content += text;
      break;
    }
    const before = combined.slice(i, lt);
    if (state.deepseekThinkOpen) reasoning += before;
    else content += before;
    if (combined.startsWith("<think>", lt)) {
      state.deepseekThinkOpen = true;
      i = lt + "<think>".length;
      continue;
    }
    if (combined.startsWith("</think>", lt)) {
      state.deepseekThinkOpen = false;
      i = lt + "</think>".length;
      continue;
    }
    const maybeOpen = "<think>".startsWith(combined.slice(lt));
    const maybeClose = "</think>".startsWith(combined.slice(lt));
    if (maybeOpen || maybeClose) {
      state.deepseekTagBuffer = combined.slice(lt);
      break;
    }
    if (state.deepseekThinkOpen) reasoning += "<";
    else content += "<";
    i = lt + 1;
  }
  return { content, reasoning };
}

function parseStreamJsonEvent(raw: string): ParsedStreamEvent | null {
  const line = raw.startsWith("data: ") ? raw.slice(6).trimEnd() : raw.trim();
  if (!line || line === "[DONE]") return null;
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function estimateTextTokens(text: string): number {
  return Math.ceil(Array.from(text).length / 4);
}

function formatStreamErrorBody(error: unknown): string {
  if (typeof error === "string") {
    const trimmed = error.trim();
    if (!trimmed) return "stream failed";
    return trimmed;
  }
  const err = isObject(error) ? error : {};
  const nestedError = isObject(err.error) ? err.error : {};
  const detail = isObject(err.detail) ? err.detail : {};
  const message = nestedError.message ?? err.message ?? detail.message;
  if (typeof message === "string" && message.trim()) {
    try {
      return JSON.stringify(error);
    } catch {
      return message.trim();
    }
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? "");
  }
}

function tokenProgressPayload(
  template: TokenProgressTemplate,
  used: number,
  budget: number,
): StreamOutputEvent {
  const fraction = budget > 0 ? used / budget : 0;
  return { ...template, used, fraction };
}
