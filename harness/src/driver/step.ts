export type StepDriverState = Record<string, any> & {
  chatId: string;
  phase?:
    | "continueToolCalls"
    | "handleLlm"
    | "startLoop"
    | "prepare"
    | "return";
  returnValue?: any;
  llmHandling?: any;
};

export type StepDriverEvent =
  | { type: "ToolResultReceived"; toolResult: any }
  | { type: "LlmResultReceived"; llmResult: any; llmDurationNs?: number }
  | { type: "DriverAdvanced" }
  | { type: "ToolContinuationHandled"; handled: any }
  | { type: "LlmHandled"; handled: any }
  | { type: "Started"; started: any }
  | { type: "Prepared"; prepared: any };

export type StepDriverEffect =
  | { type: "ContinueToolCalls"; input: any }
  | { type: "HandleLlm"; input: any }
  | { type: "Start"; mode: "step" | "resume" | "compact"; input: any }
  | { type: "Prepare"; input: any }
  | { type: "Return"; value: any };

export function initialStepDriverState(input: any): StepDriverState {
  const base = input?.state && typeof input.state === "object" ? input.state : {};
  const chatId = String(base.chatId ?? input?.chatId ?? "").trim();
  return { ...base, chatId };
}

export function stepNextInputEvents(input: any, _state: StepDriverState): StepDriverEvent[] {
  const events: StepDriverEvent[] = [];
  if (input?.toolResult != null) events.push({ type: "ToolResultReceived", toolResult: input.toolResult });
  if (input?.llmResult != null) events.push({ type: "LlmResultReceived", llmResult: input.llmResult, llmDurationNs: input.llmDurationNs });
  if (!events.length) events.push({ type: "DriverAdvanced" });
  return events;
}

export function stepNextInputEvent(input: any, state: StepDriverState): StepDriverEvent {
  return stepNextInputEvents(input, state)[0];
}

export function reduceStepDriverState(state: StepDriverState, event: StepDriverEvent): StepDriverState {
  switch (event.type) {
    case "ToolResultReceived": {
      const tr = event.toolResult || {};
      const messages = Array.isArray(state.messages) ? [...state.messages] : [];
      messages.push({
        role: "tool",
        tool_call_id: tr.toolCallId,
        content: typeof tr.content === "string" ? tr.content : String(tr.content ?? ""),
      });
      return {
        ...state,
        messages,
        pendingToolCalls: Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : [],
        phase: "continueToolCalls",
      };
    }

    case "LlmResultReceived": {
      const inflight = state.inflight || {};
      const elapsedNs = Number(event.llmDurationNs) || 0;
      const previousThoughtNs = Number(state.thoughtDurationNs) || 0;
      const thoughtDurationNs = previousThoughtNs + (inflight.countThoughtDuration ? elapsedNs : 0);
      return {
        ...state,
        thoughtDurationNs,
        llmHandling: {
          chatId: state.chatId,
          attempt: Number(inflight.attempt ?? 1) || 1,
          purpose: inflight.purpose,
          draftId: inflight.draftId,
          messages: inflight.messages,
          estimatedPromptTokens: inflight.estimatedPromptTokens,
          tokenBudget: inflight.tokenBudget,
          tokenThreshold: inflight.tokenThreshold,
          requestPromptTokens: inflight.requestPromptTokens,
          requestTokenLimit: inflight.requestTokenLimit,
          llmResult: event.llmResult,
          requestProvider: inflight.requestProvider ?? state.provider?.name,
          requestModel: inflight.requestModel,
          requestEffort: inflight.requestEffort,
          requestAuthMode: inflight.requestAuthMode,
          thoughtDurationNs,
        },
        phase: "handleLlm",
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
        messages: handled.messages ?? state.messages,
        pendingToolCalls: null,
        usedModel: null,
        inflight: null,
        phase: "prepare",
      };
    }

    case "LlmHandled": {
      const handled = event.handled;
      if (handled?.kind === "tool-js") {
        return {
          ...state,
          phase: "return",
          returnValue: {
            ...handled,
            state: stepContinuationState({
              ...state,
              ...(handled.state || {}),
              provider: state.provider,
              thoughtDurationNs: state.thoughtDurationNs,
              inflight: null,
            }),
          },
        };
      }
      if (handled?.kind !== "iterate") return { ...state, phase: "return", returnValue: { kind: handled?.kind || "done" } };
      return {
        ...state,
        messages: handled.messages ?? null,
        retryAttempt: handled.retryAttempt ?? null,
        retryReason: handled.retryReason ?? null,
        retryDelayMs: handled.retryDelayMs ?? null,
        inflight: null,
        phase: "prepare",
      };
    }

    case "Started": {
      const started = event.started;
      if (started?.kind !== "loop") return { ...state, phase: "return", returnValue: { kind: "done" } };
      return {
        ...state,
        provider: started.provider,
        messages: null,
        thoughtDurationNs: 0,
        retryAttempt: null,
        retryReason: null,
        retryDelayMs: null,
        inflight: null,
        phase: "prepare",
      };
    }

    case "Prepared": {
      const prepared = event.prepared;
      if (prepared?.kind !== "llm") return { ...state, phase: "return", returnValue: { kind: "done" } };
      const nextState = {
        ...state,
        messages: state.messages ?? null,
        inflight: {
          purpose: prepared.purpose,
          draftId: prepared.draftId,
          messages: prepared.messages,
          estimatedPromptTokens: prepared.estimatedPromptTokens,
          tokenBudget: prepared.tokenBudget,
          tokenThreshold: prepared.tokenThreshold,
          requestPromptTokens: prepared.requestPromptTokens,
          requestTokenLimit: prepared.requestTokenLimit,
          requestProvider: prepared.requestProvider ?? state.provider?.name,
          requestModel: prepared.requestModel,
          requestEffort: prepared.requestEffort,
          requestAuthMode: prepared.requestAuthMode ?? state.provider?.authMode,
          countThoughtDuration: !!prepared.countThoughtDuration,
          attempt: Number(prepared.attempt ?? state.retryAttempt ?? 1) || 1,
        },
      };
      return {
        ...nextState,
        phase: "return",
        returnValue: {
          kind: "llm",
          state: stepContinuationState(nextState),
          url: prepared.url,
          headers: prepared.headers || {},
          body: prepared.body || {},
          streamEvents: prepared.streamEvents || null,
          attempt: Number(prepared.attempt ?? state.retryAttempt ?? 1) || 1,
          delayMs: Number(state.retryDelayMs ?? 0) || 0,
        },
      };
    }
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
          toolCalls: state.pendingToolCalls,
          usedModel: state.usedModel,
          requestEffort: state.requestEffort,
        },
      }];
    case "handleLlm":
      return [{ type: "HandleLlm", input: state.llmHandling }];
    case "startLoop": {
      const mode = state.mode === "resume" ? "resume" : state.mode === "compact" ? "compact" : "step";
      return [{
        type: "Start",
        mode,
        input: mode === "resume" || mode === "compact"
          ? { chatId: state.chatId, mode }
          : {
              chatId: state.chatId,
              mode,
              message: state.message ?? "",
              attachments: state.attachments,
              ...(state.artificial === true ? { artificial: true } : {}),
            },
      }];
    }
    case "prepare":
      return [{
        type: "Prepare",
        input: {
          chatId: state.chatId,
          provider: state.provider,
          messages: state.messages,
          attempt: state.retryAttempt ?? undefined,
          retryReason: state.retryReason ?? undefined,
        },
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
