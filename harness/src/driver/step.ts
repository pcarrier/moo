// Step driver state machine types and helpers.
//
// The driver owns a state object that persists across step transitions.
// Known fields are typed explicitly; the index signature allows callers to
// store extra data (e.g. userland state forwarded from command inputs).

// ── Message / tool shapes ──────────────────────────────────────────────

export interface StepMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: unknown[];
  [key: string]: unknown;
}

export interface ToolResultPayload {
  toolCallId?: string;
  content?: unknown;
  [key: string]: unknown;
}

// ── Inflight / LLM handling ────────────────────────────────────────────

export interface InflightState {
  attempt?: number;
  purpose?: string;
  draftId?: string;
  messages?: StepMessage[];
  estimatedPromptTokens?: number;
  tokenBudget?: number;
  tokenThreshold?: number;
  availableTokens?: number;
  compactionsInARow?: number;
  requestPromptTokens?: number;
  requestTokenLimit?: number;
  requestProvider?: string;
  requestModel?: string;
  requestEffort?: string;
  requestAuthMode?: string;
  transport?: string;
  countThoughtDuration?: boolean;
  forceCompact?: boolean;
  compactionTrigger?: "automatic" | "manual";
  [key: string]: unknown;
}

export interface LlmHandlingState {
  chatId: string;
  attempt: number;
  purpose?: string;
  draftId?: string;
  messages?: StepMessage[];
  estimatedPromptTokens?: number;
  tokenBudget?: number;
  tokenThreshold?: number;
  availableTokens?: number;
  compactionsInARow?: number;
  requestPromptTokens?: number;
  requestTokenLimit?: number;
  llmResult: unknown;
  requestProvider?: string;
  requestModel?: string;
  requestEffort?: string;
  requestAuthMode?: string;
  transport?: string;
  thoughtDurationNs: number;
  forceCompact?: boolean;
  compactionTrigger?: "automatic" | "manual";
  [key: string]: unknown;
}

// ── State ───────────────────────────────────────────────────────────────

export type StepDriverState = Record<string, unknown> & {
  chatId: string;
  phase?:
    | "continueToolCalls"
    | "handleLlm"
    | "startLoop"
    | "prepare"
    | "return";
  returnValue?: unknown;
  llmHandling?: LlmHandlingState;
  messages?: StepMessage[];
  pendingToolCalls?: unknown[];
  usedModel?: string;
  requestEffort?: string;
  mode?: "step" | "resume" | "compact";
  message?: string;
  attachments?: unknown[];
  userStepId?: string;
  artificial?: boolean;
  provider?: { name?: string; model?: string; effort?: string; authMode?: string };
  retryAttempt?: number;
  retryReason?: string;
  retryDelayMs?: number;
  thoughtDurationNs?: number;
  forceCompact?: boolean;
  compactionTrigger?: "automatic" | "manual";
  inflight?: InflightState;
};

// ── Events ──────────────────────────────────────────────────────────────

export type StepDriverEvent =
  | { type: "ToolResultReceived"; toolResult: ToolResultPayload }
  | { type: "LlmResultReceived"; llmResult: unknown; llmDurationNs?: number }
  | { type: "DriverAdvanced" }
  | { type: "ToolContinuationHandled"; handled: { kind?: string; [key: string]: unknown } }
  | { type: "LlmHandled"; handled: { kind?: string; [key: string]: unknown } }
  | { type: "Started"; started: { chatId?: string; mode?: string; message?: string; attachments?: unknown[]; artificial?: boolean; [key: string]: unknown } }
  | { type: "Prepared"; prepared: { chatId?: string; provider?: unknown; messages?: StepMessage[]; attempt?: number; retryReason?: string; [key: string]: unknown } };

// ── Effects ─────────────────────────────────────────────────────────────

export interface ContinueToolCallsInput {
  chatId: string;
  state: StepDriverState;
  toolCalls: unknown[];
  usedModel?: string;
  requestEffort?: string;
}

export interface StartInput {
  chatId: string;
  mode: "step" | "resume" | "compact";
  message?: string;
  attachments?: unknown[];
  userStepId?: string;
  artificial?: boolean;
}

export interface PrepareInput {
  chatId: string;
  provider: unknown;
  messages: StepMessage[] | null;
  attempt?: number;
  retryReason?: string;
  forceCompact?: boolean;
  compactionTrigger?: "automatic" | "manual";
}

export type StepDriverEffect =
  | { type: "ContinueToolCalls"; input: ContinueToolCallsInput }
  | { type: "HandleLlm"; input: LlmHandlingState }
  | { type: "Start"; mode: "step" | "resume" | "compact"; input: StartInput }
  | { type: "Prepare"; input: PrepareInput }
  | { type: "Return"; value: unknown };

// ── Functions ───────────────────────────────────────────────────────────

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalCompactionTrigger(value: unknown): "automatic" | "manual" | undefined {
  return value === "automatic" || value === "manual" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return isObjectRecord(value) ? value : null;
}

function stepMessages(value: unknown): StepMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((message): message is StepMessage => {
    const record = objectRecord(message);
    return record !== null && typeof record.role === "string";
  });
}

function toolResultPayload(value: unknown): ToolResultPayload | null {
  const record = objectRecord(value);
  if (!record) return null;
  const rawToolCallId =
    typeof record.toolCallId === "string" ? record.toolCallId.trim() : "";
  return {
    ...(rawToolCallId ? { toolCallId: rawToolCallId } : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "content") ? { content: record.content } : {}),
  };
}

function unansweredToolCallId(state: StepDriverState): string | null {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  let assistantIndex = -1;
  let toolCalls: unknown[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      assistantIndex = i;
      toolCalls = message.tool_calls;
      break;
    }
  }
  if (assistantIndex < 0) return null;
  const answered = new Set<string>();
  for (const message of messages.slice(assistantIndex + 1)) {
    if (message?.role !== "tool") continue;
    const id = typeof message.tool_call_id === "string" ? message.tool_call_id.trim() : "";
    if (id) answered.add(id);
  }
  for (const toolCall of toolCalls) {
    const record = objectRecord(toolCall);
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    if (id && !answered.has(id)) return id;
  }
  return null;
}

export function initialStepDriverState(input: Record<string, unknown>): StepDriverState {
  const base = objectRecord(input.state) ?? {};
  const chatId = String(base.chatId ?? input?.chatId ?? "").trim();
  return { ...base, chatId };
}

export function stepNextInputEvents(
  input: Record<string, unknown>,
  _state: StepDriverState,
): StepDriverEvent[] {
  const events: StepDriverEvent[] = [];
  if (input?.toolResult != null) {
    events.push({ type: "ToolResultReceived", toolResult: toolResultPayload(input.toolResult) ?? {} });
  }
  if (input?.llmResult != null) {
    events.push({
      type: "LlmResultReceived",
      llmResult: input.llmResult,
      llmDurationNs: optionalNumber(input.llmDurationNs),
    });
  }
  if (!events.length) events.push({ type: "DriverAdvanced" });
  return events;
}

export function stepNextInputEvent(
  input: Record<string, unknown>,
  state: StepDriverState,
): StepDriverEvent {
  return stepNextInputEvents(input, state)[0]!;
}

export function reduceStepDriverState(
  state: StepDriverState,
  event: StepDriverEvent,
): StepDriverState {
  switch (event.type) {
    case "ToolResultReceived": {
      const tr = event.toolResult || {};
      const toolCallId =
        (typeof tr.toolCallId === "string" ? tr.toolCallId.trim() : "") ||
        unansweredToolCallId(state) ||
        "";
      const messages: StepMessage[] = Array.isArray(state.messages) ? [...state.messages] : [];
      if (toolCallId) {
        messages.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: typeof tr.content === "string" ? tr.content : String(tr.content ?? ""),
        });
      }
      return {
        ...state,
        messages,
        pendingToolCalls: Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : [],
        phase: "continueToolCalls" as const,
      };
    }

    case "LlmResultReceived": {
      const inflight = state.inflight ?? {};
      const elapsedNs = Number(event.llmDurationNs) || 0;
      const previousThoughtNs = Number(state.thoughtDurationNs) || 0;
      const thoughtDurationNs = previousThoughtNs + (inflight.countThoughtDuration ? elapsedNs : 0);
      return {
        ...state,
        thoughtDurationNs,
        llmHandling: {
          chatId: state.chatId,
          attempt: Number(inflight.attempt ?? 1) || 1,
          purpose: optionalString(inflight.purpose),
          draftId: optionalString(inflight.draftId),
          messages: stepMessages(inflight.messages),
          estimatedPromptTokens: optionalNumber(inflight.estimatedPromptTokens),
          tokenBudget: optionalNumber(inflight.tokenBudget),
          tokenThreshold: optionalNumber(inflight.tokenThreshold),
          availableTokens: optionalNumber(inflight.availableTokens),
          compactionsInARow: optionalNumber(inflight.compactionsInARow),
          requestPromptTokens: optionalNumber(inflight.requestPromptTokens),
          requestTokenLimit: optionalNumber(inflight.requestTokenLimit),
          llmResult: event.llmResult,
          requestProvider: optionalString(inflight.requestProvider) ?? state.provider?.name,
          requestModel: optionalString(inflight.requestModel),
          requestEffort: optionalString(inflight.requestEffort),
          requestAuthMode: optionalString(inflight.requestAuthMode),
          transport: optionalString(inflight.transport),
          thoughtDurationNs,
          forceCompact: inflight.forceCompact === true,
          compactionTrigger: optionalCompactionTrigger(inflight.compactionTrigger),
        } satisfies LlmHandlingState,
        phase: "handleLlm" as const,
      };
    }

    case "DriverAdvanced":
      return { ...state, phase: state.provider ? "prepare" : "startLoop" };

    case "ToolContinuationHandled": {
      const handled = event.handled;
      if (handled?.kind === "tool-ts") return { ...state, phase: "return", returnValue: handled };
      if (handled?.kind !== "iterate") return { ...state, phase: "return", returnValue: { kind: handled?.kind || "done" } };
      return {
        ...state,
        messages: (handled.messages as StepMessage[] | undefined) ?? state.messages,
        pendingToolCalls: [],
        inflight: undefined,
        phase: "prepare" as const,
      };
    }

    case "LlmHandled": {
      const handled = event.handled;
      if (handled?.kind === "tool-ts") {
        const handledState = objectRecord(handled.state) ?? {};
        return {
          ...state,
          phase: "return" as const,
          returnValue: {
            ...handled,
            state: stepContinuationState({
              ...state,
              ...handledState,
              provider: state.provider,
              thoughtDurationNs: state.thoughtDurationNs,
              inflight: undefined,
            } as StepDriverState),
          },
        };
      }
      if (handled?.kind !== "iterate") {
        return { ...state, phase: "return" as const, returnValue: { kind: handled?.kind || "done" } };
      }
      return {
        ...state,
        messages: stepMessages(handled.messages),
        usedModel: optionalString(handled.usedModel) ?? state.usedModel,
        requestEffort: optionalString(handled.requestEffort) ?? state.requestEffort,
        pendingToolCalls: Array.isArray(handled.toolCalls) ? handled.toolCalls : [],
        retryAttempt: optionalNumber(handled.retryAttempt),
        retryReason: optionalString(handled.retryReason),
        retryDelayMs: optionalNumber(handled.retryDelayMs),
        forceCompact: handled.forceCompact === true,
        compactionTrigger: optionalCompactionTrigger(handled.compactionTrigger),
        inflight: undefined,
        phase: "prepare" as const,
      };
    }

    case "Started": {
      const s = event.started;
      if (s?.kind !== "loop") {
        return { ...state, phase: "return" as const, returnValue: { kind: "done" } };
      }
      return {
        ...state,
        provider: s.provider as StepDriverState["provider"],
        mode: s.mode === "step" || s.mode === "resume" || s.mode === "compact" ? s.mode : state.mode,
        messages: undefined,
        thoughtDurationNs: 0,
        retryAttempt: undefined,
        retryReason: undefined,
        retryDelayMs: undefined,
        forceCompact: false,
        compactionTrigger: s.mode === "compact" ? "manual" : undefined,
        inflight: undefined,
        phase: "prepare" as const,
      };
    }

    case "Prepared": {
      const p = event.prepared as Record<string, unknown>;
      if (p?.kind === "iterate") {
        return { ...state, messages: undefined, phase: "startLoop" as const };
      }
      if (p?.kind !== "llm") {
        return { ...state, phase: "return" as const, returnValue: { kind: "done" } };
      }
      const nextState: StepDriverState = {
        ...state,
        inflight: {
          purpose: optionalString(p.purpose),
          draftId: optionalString(p.draftId),
          messages: stepMessages(p.messages),
          estimatedPromptTokens: optionalNumber(p.estimatedPromptTokens),
          tokenBudget: optionalNumber(p.tokenBudget),
          tokenThreshold: optionalNumber(p.tokenThreshold),
          availableTokens: optionalNumber(p.availableTokens),
          compactionsInARow: optionalNumber(p.compactionsInARow),
          requestPromptTokens: optionalNumber(p.requestPromptTokens),
          requestTokenLimit: optionalNumber(p.requestTokenLimit),
          requestProvider: optionalString(p.requestProvider) ?? state.provider?.name,
          requestModel: optionalString(p.requestModel),
          requestEffort: optionalString(p.requestEffort),
          requestAuthMode: optionalString(p.requestAuthMode) ?? state.provider?.authMode,
          transport: optionalString(p.transport),
          countThoughtDuration: !!p.countThoughtDuration,
          forceCompact: p.forceCompact === true || state.forceCompact === true,
          compactionTrigger: optionalCompactionTrigger(p.compactionTrigger ?? state.compactionTrigger),
          attempt: Number(p.attempt ?? state.retryAttempt ?? 1) || 1,
        },
      };
      return {
        ...nextState,
        phase: "return" as const,
        returnValue: {
          kind: "llm",
          state: stepContinuationState(nextState),
          url: p.url,
          headers: p.headers || {},
          body: p.body || {},
          transport: p.transport,
          streamEvents: p.streamEvents ?? null,
          attempt: Number(p.attempt ?? state.retryAttempt ?? 1) || 1,
          delayMs: Number(state.retryDelayMs ?? 0) || 0,
          purpose: p.purpose,
          requestProvider: p.requestProvider,
          requestModel: p.requestModel,
          requestEffort: p.requestEffort,
          responsesApi: p.responsesApi,
          estimatedPromptTokens: p.estimatedPromptTokens,
          tokenBudget: p.tokenBudget,
          tokenThreshold: p.tokenThreshold,
          availableTokens: p.availableTokens,
          compactionsInARow: p.compactionsInARow,
          compactionTrigger: optionalCompactionTrigger(p.compactionTrigger ?? state.compactionTrigger),
        },
      };
    }

    default:
      return state;
  }
}

export function planStepDriverEffects(state: StepDriverState): StepDriverEffect[] {
  switch (state.phase) {
    case "continueToolCalls":
      return [{
        type: "ContinueToolCalls",
        input: {
          chatId: state.chatId,
          state,
          toolCalls: state.pendingToolCalls ?? [],
          usedModel: state.usedModel,
          requestEffort: state.requestEffort,
        } satisfies ContinueToolCallsInput,
      }];
    case "handleLlm":
      return [{ type: "HandleLlm", input: state.llmHandling! }];
    case "startLoop": {
      const mode = state.mode === "resume" ? "resume" : state.mode === "compact" ? "compact" : "step";
      return [{
        type: "Start",
        mode,
        input: (mode === "resume" || mode === "compact"
          ? { chatId: state.chatId, mode }
          : {
              chatId: state.chatId,
              mode,
              message: state.message ?? "",
              attachments: state.attachments,
              userStepId: optionalString(state.userStepId),
              ...(state.artificial === true ? { artificial: true } : {}),
            }) as StartInput,
      }];
    }
    case "prepare":
      return [{
        type: "Prepare",
        input: {
          chatId: state.chatId,
          provider: state.provider,
          messages: state.messages ?? null,
          attempt: state.retryAttempt ?? undefined,
          retryReason: state.retryReason ?? undefined,
          forceCompact: state.forceCompact === true,
          compactionTrigger: optionalCompactionTrigger(state.compactionTrigger),
        } satisfies PrepareInput,
      }];
    case "return":
      return [{ type: "Return", value: state.returnValue ?? { kind: "done" } }];
    default:
      return [];
  }
}

export function stepContinuationState(state: StepDriverState): StepDriverState {
  const { phase, returnValue, llmHandling, ...rest } = state;
  return rest as StepDriverState;
}
