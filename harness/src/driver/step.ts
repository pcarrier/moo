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
  requestPromptTokens?: number;
  requestTokenLimit?: number;
  requestProvider?: string;
  requestModel?: string;
  requestEffort?: string;
  requestAuthMode?: string;
  countThoughtDuration?: boolean;
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
  requestPromptTokens?: number;
  requestTokenLimit?: number;
  llmResult: unknown;
  requestProvider?: string;
  requestModel?: string;
  requestEffort?: string;
  requestAuthMode?: string;
  thoughtDurationNs: number;
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
  artificial?: boolean;
  provider?: { name?: string; model?: string; effort?: string; authMode?: string };
  retryAttempt?: number;
  retryReason?: string;
  retryDelayMs?: number;
  thoughtDurationNs?: number;
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
  artificial?: boolean;
}

export interface PrepareInput {
  chatId: string;
  provider: unknown;
  messages: StepMessage[] | null;
  attempt?: number;
  retryReason?: string;
}

export type StepDriverEffect =
  | { type: "ContinueToolCalls"; input: ContinueToolCallsInput }
  | { type: "HandleLlm"; input: LlmHandlingState }
  | { type: "Start"; mode: "step" | "resume" | "compact"; input: StartInput }
  | { type: "Prepare"; input: PrepareInput }
  | { type: "Return"; value: unknown };

// ── Functions ───────────────────────────────────────────────────────────

export function initialStepDriverState(input: Record<string, unknown>): StepDriverState {
  const base = (input?.state && typeof input.state === "object" ? input.state : {}) as Record<string, unknown>;
  const chatId = String(base.chatId ?? input?.chatId ?? "").trim();
  return { ...base, chatId };
}

export function stepNextInputEvents(
  input: Record<string, unknown>,
  _state: StepDriverState,
): StepDriverEvent[] {
  const events: StepDriverEvent[] = [];
  if (input?.toolResult != null) {
    events.push({ type: "ToolResultReceived", toolResult: input.toolResult as ToolResultPayload });
  }
  if (input?.llmResult != null) {
    events.push({
      type: "LlmResultReceived",
      llmResult: input.llmResult,
      llmDurationNs: input.llmDurationNs as number | undefined,
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
      const messages: StepMessage[] = Array.isArray(state.messages) ? [...state.messages] : [];
      messages.push({
        role: "tool",
        tool_call_id: String(tr.toolCallId ?? ""),
        content: typeof tr.content === "string" ? tr.content : String(tr.content ?? ""),
      });
      return {
        ...state,
        messages,
        pendingToolCalls: Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : [],
        phase: "continueToolCalls" as const,
      };
    }

    case "LlmResultReceived": {
      const inflight: Record<string, unknown> = (state.inflight as Record<string, unknown> | undefined) ?? {};
      const elapsedNs = Number(event.llmDurationNs) || 0;
      const previousThoughtNs = Number(state.thoughtDurationNs) || 0;
      const thoughtDurationNs = previousThoughtNs + (inflight.countThoughtDuration ? elapsedNs : 0);
      return {
        ...state,
        thoughtDurationNs,
        llmHandling: {
          chatId: state.chatId,
          attempt: Number(inflight.attempt ?? 1) || 1,
          purpose: inflight.purpose as string | undefined,
          draftId: inflight.draftId as string | undefined,
          messages: inflight.messages as StepMessage[] | undefined,
          estimatedPromptTokens: inflight.estimatedPromptTokens as number | undefined,
          tokenBudget: inflight.tokenBudget as number | undefined,
          tokenThreshold: inflight.tokenThreshold as number | undefined,
          requestPromptTokens: inflight.requestPromptTokens as number | undefined,
          requestTokenLimit: inflight.requestTokenLimit as number | undefined,
          llmResult: event.llmResult,
          requestProvider: (inflight.requestProvider ?? (state.provider as Record<string, unknown> | undefined)?.name) as string | undefined,
          requestModel: inflight.requestModel as string | undefined,
          requestEffort: inflight.requestEffort as string | undefined,
          requestAuthMode: inflight.requestAuthMode as string | undefined,
          thoughtDurationNs,
        } satisfies LlmHandlingState,
        phase: "handleLlm" as const,
      };
    }

    case "DriverAdvanced":
      return { ...state, phase: state.provider ? "prepare" : "startLoop" };

    case "ToolContinuationHandled": {
      const handled = event.handled;
      if (handled?.kind === "tool-js") return { ...state, phase: "return", returnValue: handled };
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
      if (handled?.kind === "tool-js") {
        const handledState = (handled.state ?? {}) as Record<string, unknown>;
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
        messages: (handled.messages as StepMessage[] | undefined) ?? undefined,
        usedModel: (handled.usedModel as string | undefined) ?? state.usedModel,
        requestEffort: (handled.requestEffort as string | undefined) ?? state.requestEffort,
        pendingToolCalls: (handled.toolCalls as unknown[] | undefined) ?? [],
        retryAttempt: (handled.retryAttempt as number | undefined) ?? undefined,
        retryReason: (handled.retryReason as string | undefined) ?? undefined,
        retryDelayMs: (handled.retryDelayMs as number | undefined) ?? undefined,
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
        messages: undefined,
        thoughtDurationNs: 0,
        retryAttempt: undefined,
        retryReason: undefined,
        retryDelayMs: undefined,
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
      const providerObj = state.provider as Record<string, unknown> | undefined;
      const nextState: StepDriverState = {
        ...state,
        inflight: {
          purpose: p.purpose as string | undefined,
          draftId: p.draftId as string | undefined,
          messages: p.messages as StepMessage[] | undefined,
          estimatedPromptTokens: p.estimatedPromptTokens as number | undefined,
          tokenBudget: p.tokenBudget as number | undefined,
          tokenThreshold: p.tokenThreshold as number | undefined,
          requestPromptTokens: p.requestPromptTokens as number | undefined,
          requestTokenLimit: p.requestTokenLimit as number | undefined,
          requestProvider: (p.requestProvider ?? providerObj?.name) as string | undefined,
          requestModel: p.requestModel as string | undefined,
          requestEffort: p.requestEffort as string | undefined,
          requestAuthMode: (p.requestAuthMode ?? providerObj?.authMode) as string | undefined,
          countThoughtDuration: !!p.countThoughtDuration,
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
