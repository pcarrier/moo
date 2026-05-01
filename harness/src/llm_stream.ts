type Input = Record<string, any>;

type LlmAccumulatorState = {
  content: string;
  toolCalls: any[];
  model: string | null;
  usage: any | null;
  error: any | null;
  lastTokenProgressUsed: number;
  anthropicToolIndex: number | null;
  anthropicToolBlockToCall: Record<string, number>;
};

export function llmStreamInitCommand(input: Input) {
  const streamEvents = input.streamEvents && typeof input.streamEvents === "object" ? input.streamEvents : {};
  const estimated = Number(streamEvents.estimatedPromptTokens ?? 0) || 0;
  const state: LlmAccumulatorState = {
    content: "",
    toolCalls: [],
    model: null,
    usage: null,
    error: null,
    lastTokenProgressUsed: estimated,
    anthropicToolIndex: null,
    anthropicToolBlockToCall: {},
  };
  const events: any[] = [];
  const tokenEvent = streamEvents.tokenProgressEvent;
  if (tokenEvent && typeof tokenEvent === "object") {
    events.push(tokenProgressPayload(tokenEvent, estimated, Number(streamEvents.tokenBudget ?? tokenEvent.budget ?? 0) || 0));
  }
  return { ok: true, value: { state, events } };
}

export function llmStreamAccumulateCommand(input: Input) {
  const state = normalizeLlmAccumulatorState(input.state);
  const streamEvents = input.streamEvents && typeof input.streamEvents === "object" ? input.streamEvents : {};
  const events: any[] = [];
  const rawEvents = Array.isArray(input.events) ? input.events : [];
  for (const raw of rawEvents) {
    if (typeof raw !== "string") continue;
    const data = raw.trim();
    if (!data || data === "[DONE]") continue;
    let parsed: any;
    try { parsed = JSON.parse(data); } catch { continue; }
    accumulateLlmStreamEvent(state, parsed, streamEvents, events);
  }
  return { ok: true, value: { state, events } };
}

export function llmStreamFinalizeCommand(input: Input) {
  const state = normalizeLlmAccumulatorState(input.state);
  const status = Number(input.status ?? 0) || 0;
  if (state.error != null) {
    return {
      ok: true,
      value: {
        status,
        ok: false,
        content: state.content,
        toolCalls: state.toolCalls,
        errorBody: formatStreamErrorBody(state.error),
        headers: input.headers && typeof input.headers === "object" ? input.headers : null,
        model: state.model,
        usage: state.usage,
      },
    };
  }
  return {
    ok: true,
    value: {
      status,
      ok: true,
      content: state.content,
      toolCalls: state.toolCalls,
      errorBody: null,
      model: state.model,
      usage: state.usage,
    },
  };
}

export function llmStreamErrorCommand(input: Input) {
  const state = normalizeLlmAccumulatorState(input.state);
  return {
    ok: true,
    value: {
      status: Number(input.status ?? 0) || 0,
      ok: false,
      content: state.content,
      toolCalls: state.toolCalls,
      errorBody: typeof input.errorBody === "string" ? input.errorBody : String(input.errorBody ?? ""),
      headers: input.headers && typeof input.headers === "object" ? input.headers : null,
      model: state.model,
      usage: state.usage,
    },
  };
}

function normalizeLlmAccumulatorState(raw: any): LlmAccumulatorState {
  return {
    content: typeof raw?.content === "string" ? raw.content : "",
    toolCalls: Array.isArray(raw?.toolCalls) ? raw.toolCalls : [],
    model: typeof raw?.model === "string" && raw.model ? raw.model : null,
    usage: raw?.usage ?? null,
    error: raw?.error ?? null,
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
    appendLlmContentDelta(state, delta.content, streamEvents, events);
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

function appendLlmContentDelta(state: LlmAccumulatorState, delta: string, streamEvents: any, events: any[]) {
  state.content += delta;
  const draft = streamEvents.draftEvent;
  if (draft && typeof draft === "object") {
    events.push({ ...draft, content: state.content, delta });
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

function estimateTextTokens(text: string): number {
  return Math.ceil(Array.from(text).length / 4);
}

function formatStreamErrorBody(error: any): string {
  if (typeof error === "string") return error;
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
