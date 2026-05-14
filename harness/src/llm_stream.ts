import { Effect, ok } from "./core/effect";
import { moo, traceJsonValue } from "./moo";

type Input = Record<string, any>;

type LlmAccumulatorState = {
  content: string;
  toolCalls: any[];
  model: string | null;
  usage: any | null;
  error: any | null;
  reasoningContent: string;
  deepseekThinkOpen: boolean;
  deepseekTagBuffer: string;
  lastTokenProgressUsed: number;
  anthropicToolIndex: number | null;
  anthropicToolBlockToCall: Record<string, number>;
};

export function llmStreamInitCommand(input: Input) {
  return llmStreamInitEffect(input).map((value) => ok(value));
}

export function llmStreamInitEffect(input: Input): Effect<{ state: LlmAccumulatorState; events: any[] }> {
  return Effect.tryPromise(async () => moo.traces.span({ name: "llm.stream.init", data: llmStreamInputSummary(input), fn: async () => {
    const streamEvents = input.streamEvents && typeof input.streamEvents === "object" ? input.streamEvents : {};
    const estimated = Number(streamEvents.estimatedPromptTokens ?? 0) || 0;
    const state: LlmAccumulatorState = {
      content: "",
      toolCalls: [],
      model: null,
      usage: null,
      error: null,
      reasoningContent: "",
      deepseekThinkOpen: false,
      deepseekTagBuffer: "",
      lastTokenProgressUsed: estimated,
      anthropicToolIndex: null,
      anthropicToolBlockToCall: {},
    };
    const events: any[] = [];
    const tokenEvent = streamEvents.tokenProgressEvent;
    if (tokenEvent && typeof tokenEvent === "object") {
      events.push(tokenProgressPayload(tokenEvent, estimated, Number(streamEvents.tokenBudget ?? tokenEvent.budget ?? 0) || 0));
    }
    await moo.traces.mark({ message: "llm.stream.init.result", data: { estimatedPromptTokens: estimated, events } });
    return { state, events };
  } }), "llm stream init failed");
}

export function llmStreamAccumulateCommand(input: Input) {
  return llmStreamAccumulateEffect(input).map((value) => ok(value));
}

export function llmStreamAccumulateEffect(input: Input): Effect<{ state: LlmAccumulatorState; events: any[] }> {
  return Effect.tryPromise(async () => moo.traces.span({ name: "llm.stream.accumulate", data: llmStreamInputSummary(input), fn: async () => {
    const state = normalizeLlmAccumulatorState(input.state);
    const streamEvents = input.streamEvents && typeof input.streamEvents === "object" ? input.streamEvents : {};
    const events: any[] = [];
    const rawEvents = Array.isArray(input.events) ? input.events : [];
    let parsedCount = 0;
    let ignoredCount = 0;
    for (const raw of rawEvents) {
      if (typeof raw !== "string") { ignoredCount++; continue; }
      const parsed = parseStreamJsonEvent(raw);
      if (parsed == null) { ignoredCount++; continue; }
      parsedCount++;
      await moo.traces.mark({ message: "llm.stream.event", data: { event: traceJsonValue(parsed) } });
      accumulateLlmStreamEvent(state, parsed, streamEvents, events);
    }
    await moo.traces.mark({ message: "llm.stream.accumulate.result", data: { rawEvents, parsedEvents: parsedCount, ignoredEvents: ignoredCount, events, state: traceJsonValue(state) } });
    return { state, events };
  } }), "llm stream accumulate failed");
}

export function llmStreamFinalizeCommand(input: Input) {
  return llmStreamFinalizeEffect(input).map((value) => ok(value));
}

export function llmStreamFinalizeEffect(input: Input): Effect<any> {
  return Effect.tryPromise(async () => moo.traces.span({ name: "llm.stream.finalize", data: llmStreamInputSummary(input), fn: async () => {
    const state = normalizeLlmAccumulatorState(input.state);
    const content = finalLlmContent(state);
    const status = Number(input.status ?? 0) || 0;
    const result = state.error != null
      ? {
        status,
        ok: false,
        content,
        toolCalls: state.toolCalls,
        errorBody: formatStreamErrorBody(state.error),
        headers: input.headers && typeof input.headers === "object" ? input.headers : null,
        reasoningContent: state.reasoningContent || null,
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
        model: state.model,
        usage: state.usage,
      };
    await moo.traces.mark({ message: "llm.stream.finalize.result", data: { result: traceJsonValue(result) } });
    return result;
  } }), "llm stream finalize failed");
}

export function llmStreamErrorCommand(input: Input) {
  return llmStreamErrorEffect(input).map((value) => ok(value));
}

export function llmStreamErrorEffect(input: Input): Effect<any> {
  return Effect.tryPromise(async () => moo.traces.span({ name: "llm.stream.error", data: llmStreamInputSummary(input), fn: async () => {
    const state = normalizeLlmAccumulatorState(input.state);
    const content = finalLlmContent(state);
    const errorBody = formatStreamErrorBody(input.errorBody ?? input.error ?? "stream failed");
    const result = {
      status: Number(input.status ?? 0) || 0,
      ok: false,
      content,
      toolCalls: state.toolCalls,
      errorBody,
      headers: input.headers && typeof input.headers === "object" ? input.headers : null,
      reasoningContent: state.reasoningContent || null,
      model: state.model,
      usage: state.usage,
    };
    await moo.traces.mark({ message: "llm.stream.error.result", data: { result: traceJsonValue(result), state: traceJsonValue(state) } });
    return result;
  } }), "llm stream error failed");
}

function llmStreamInputSummary(input: Input): Record<string, unknown> {
  const rawEvents = Array.isArray(input.events) ? input.events : [];
  const streamEvents = input.streamEvents && typeof input.streamEvents === "object" ? input.streamEvents : {};
  return {
    provider: input.provider ?? streamEvents.provider ?? null,
    model: input.model ?? streamEvents.model ?? input.state?.model ?? null,
    status: input.status ?? null,
    events: rawEvents,
    state: input.state ? traceJsonValue(normalizeLlmAccumulatorState(input.state)) : null,
    streamEvents: traceJsonValue(streamEvents),
    headers: input.headers && typeof input.headers === "object" ? traceJsonValue(input.headers) : null,
    error: input.error ?? input.errorBody ?? null,
  };
}

function normalizeLlmAccumulatorState(raw: any): LlmAccumulatorState {
  return {
    content: typeof raw?.content === "string" ? raw.content : "",
    toolCalls: Array.isArray(raw?.toolCalls) ? raw.toolCalls : [],
    model: typeof raw?.model === "string" && raw.model ? raw.model : null,
    usage: raw?.usage ?? null,
    error: raw?.error ?? null,
    reasoningContent: typeof raw?.reasoningContent === "string" ? raw.reasoningContent : "",
    deepseekThinkOpen: raw?.deepseekThinkOpen === true,
    deepseekTagBuffer: typeof raw?.deepseekTagBuffer === "string" ? raw.deepseekTagBuffer : "",
    lastTokenProgressUsed: Number(raw?.lastTokenProgressUsed ?? 0) || 0,
    anthropicToolIndex: Number.isFinite(Number(raw?.anthropicToolIndex)) ? Number(raw.anthropicToolIndex) : null,
    anthropicToolBlockToCall: raw?.anthropicToolBlockToCall && typeof raw.anthropicToolBlockToCall === "object"
      ? { ...raw.anthropicToolBlockToCall }
      : {},
  };
}

function accumulateLlmStreamEvent(
  state: LlmAccumulatorState,
  parsed: any,
  streamEvents: any,
  events: any[],
) {
  const topModel = typeof parsed?.model === "string" ? parsed.model : "";
  const responseModel = typeof parsed?.response?.model === "string" ? parsed.response.model : "";
  if (!state.model && topModel) state.model = topModel;
  if (!state.model && responseModel) state.model = responseModel;
  if (parsed?.usage != null) state.usage = parsed.usage;
  if (parsed?.response?.usage != null) state.usage = parsed.response.usage;
  if (parsed?.error != null) state.error = parsed;

  const type = typeof parsed?.type === "string" ? parsed.type : "";
  if (type === "message_start") {
    const msg = parsed?.message;
    if (typeof msg?.model === "string" && msg.model) state.model = msg.model;
    if (msg?.usage != null) state.usage = msg.usage;
  }
  if (type === "message_delta") {
    if (parsed?.usage != null) state.usage = { ...(state.usage || {}), ...parsed.usage };
    if (parsed?.delta?.usage != null) state.usage = { ...(state.usage || {}), ...parsed.delta.usage };
  }
  if (type === "content_block_start" && parsed?.content_block?.type === "tool_use") {
    const block = parsed.content_block;
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
    const delta = parsed?.delta;
    if (typeof delta?.text === "string" && delta.text) {
      appendLlmContentDelta(state, delta.text, streamEvents, events);
    }
    if (typeof delta?.partial_json === "string") {
      const blockIndex = Number.isFinite(Number(parsed?.index)) ? String(Number(parsed.index)) : null;
      const i = blockIndex == null ? state.anthropicToolIndex : state.anthropicToolBlockToCall[blockIndex];
      const slot = i == null ? null : state.toolCalls[i];
      if (slot) slot.function.arguments = String(slot.function.arguments || "") + delta.partial_json;
    }
  }
  if (type === "content_block_stop") {
    if (Number.isFinite(Number(parsed?.index))) delete state.anthropicToolBlockToCall[String(Number(parsed.index))];
    state.anthropicToolIndex = null;
  }
  if (typeof parsed?.delta === "string" && type.includes("text.delta") && parsed.delta) {
    appendLlmContentDelta(state, parsed.delta, streamEvents, events);
  }
  if (type === "response.output_item.done" && parsed?.item?.type === "function_call") {
    const item = parsed.item;
    state.toolCalls.push({
      id: String(item.call_id || item.id || ""),
      type: "function",
      function: {
        name: String(item.name || ""),
        arguments: typeof item.arguments === "string" ? item.arguments : "{}",
      },
    });
  }

  const delta = parsed?.choices?.[0]?.delta;
  if (!delta || typeof delta !== "object") return;
  if (typeof delta.content === "string" && delta.content) {
    appendProviderContentDelta(state, delta.content, streamEvents, events);
  }
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
    appendLlmReasoningDelta(state, delta.reasoning_content, streamEvents, events);
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const i = Number.isFinite(Number(tc?.index)) ? Number(tc.index) : 0;
      while (state.toolCalls.length <= i) {
        state.toolCalls.push({ id: "", type: "function", function: { name: "", arguments: "" } });
      }
      const slot = state.toolCalls[i];
      if (typeof tc?.id === "string" && tc.id) slot.id = tc.id;
      if (typeof tc?.type === "string" && tc.type) slot.type = tc.type;
      if (!slot.function || typeof slot.function !== "object") slot.function = { name: "", arguments: "" };
      if (typeof tc?.function?.name === "string" && tc.function.name) slot.function.name = tc.function.name;
      if (typeof tc?.function?.arguments === "string") slot.function.arguments = String(slot.function.arguments || "") + tc.function.arguments;
    }
  }
}

function appendProviderContentDelta(state: LlmAccumulatorState, delta: string, streamEvents: any, events: any[]) {
  if (isDeepSeekStream(streamEvents)) {
    const parsed = splitDeepSeekThinkDelta(state, delta);
    if (parsed.reasoning) appendLlmReasoningDelta(state, parsed.reasoning, streamEvents, events);
    if (!parsed.content) return;
    appendLlmContentDelta(state, parsed.content, streamEvents, events);
    return;
  }
  appendLlmContentDelta(state, delta, streamEvents, events);
}

function appendLlmReasoningDelta(state: LlmAccumulatorState, delta: string, streamEvents: any, events: any[]) {
  state.reasoningContent += delta;
  const draft = streamEvents?.draftEvent;
  if (draft && typeof draft === "object") {
    events.push({ ...draft, kind: "reasoning-draft", content: state.content, reasoningContent: state.reasoningContent, delta });
  }
}

function appendLlmContentDelta(state: LlmAccumulatorState, delta: string, streamEvents: any, events: any[]) {
  state.content += delta;
  const draft = streamEvents.draftEvent;
  if (draft && typeof draft === "object") {
    events.push({ ...draft, content: state.content, reasoningContent: state.reasoningContent || undefined, delta });
  }
  const tokenEvent = streamEvents.tokenProgressEvent;
  if (tokenEvent && typeof tokenEvent === "object") {
    const estimated = Number(streamEvents.estimatedPromptTokens ?? 0) || 0;
    const budget = Number(streamEvents.tokenBudget ?? tokenEvent.budget ?? 0) || 0;
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
    if (parsed.reasoning) appendLlmReasoningDelta(state, parsed.reasoning, {}, []);
    if (parsed.content) state.content += parsed.content;
    if (state.deepseekTagBuffer) {
      const trailing = state.deepseekTagBuffer;
      state.deepseekTagBuffer = "";
      if (state.deepseekThinkOpen) appendLlmReasoningDelta(state, trailing, {}, []);
      else state.content += trailing;
    }
  }
  return state.content;
}

function isDeepSeekStream(streamEvents: any): boolean {
  const provider = String(streamEvents?.provider ?? "").trim().toLowerCase();
  if (provider === "deepseek") return true;
  const model = String(streamEvents?.model ?? "").trim().toLowerCase();
  return model.startsWith("deepseek");
}

function splitDeepSeekThinkDelta(state: LlmAccumulatorState, delta: string): { content: string; reasoning: string } {
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

function parseStreamJsonEvent(raw: string): any {
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

function formatStreamErrorBody(error: any): string {
  if (typeof error === "string") {
    const trimmed = error.trim();
    if (!trimmed) return "stream failed";
    return trimmed;
  }
  const message = error?.error?.message ?? error?.message ?? error?.detail?.message;
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

function tokenProgressPayload(template: any, used: number, budget: number) {
  const fraction = budget > 0 ? used / budget : 0;
  return { ...template, used, fraction };
}
