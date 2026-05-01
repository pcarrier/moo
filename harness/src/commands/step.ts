import { moo } from "../moo";
import { chatRefs } from "../lib";
import {
  appendStep,
  buildLLMMessages,
  COMPACT_FRACTION,
  contextBudget,
  estimateTokens,
  estimateRawUsage,
  executeToolCall,
  runToolCall,
  formatStep,
  hasPendingInput,
  loadPayloadJSON,
  loadResultJSON,
  readCompactionChain,
  readLastPromptTokens,
  recordCompactionFailure,
  recordErrorStep,
  recordUsage,
  effortLevelsForProvider,
  llmProviderHeaders,
  reply,
  normalizeEffort,
  normalizeUsage,
  tokenUsageEvent,
  llmStreamEventOptions,
  resolveProvider,
  buildStreamingLLMRequest,
  respondTo,
  TOOLS,
} from "../agent";
import type { Input } from "./_shared";
import {
  initialStepDriverState,
  planStepDriverEffects,
  reduceStepDriverState,
  stepNextInputEvents,
} from "../driver/step";
import { llmAttempt, llmRetryDecision } from "../core/retry";
import { currentLlmRetryPolicy } from "./llm_auth";
import {
  defaultChatEffort,
  effortAllowedForModel,
  getChatEffort,
  getChatModel,
  getChatProvider,
} from "./models";

export async function stepCommand(input: Input) {
  const chatId = String(input.chatId || "demo").trim() || "demo";
  const message = String(input.message || "").trim();
  const attachments = sanitizeAttachments(input.attachments);
  if (!message && attachments.length === 0) {
    return { ok: false, error: { message: "step requires a message or attachment" } };
  }

  return {
    ok: true,
    value: {
      chatId,
      accepted: true,
      driver: stepDriverAction(chatId, "step", { message, attachments }),
    },
  };
}

export async function enqueueCommand(input: Input) {
  const chatId = input.chatId || "demo";
  const kind = input.kind || "agent:Tick";

  let payloadHash: string | null = null;
  if (kind === "agent:ShellCommand") {
    const p = input.payload || input;
    if (!p.cmd) {
      return { ok: false, error: { message: "agent:ShellCommand requires payload.cmd" } };
    }
    payloadHash = await moo.objects.putJSON({ kind, value: {
        cmd: p.cmd,
        args: p.args || [],
        cwd: p.cwd ?? null,
        stdin: p.stdin ?? null,
      } });
  } else if (input.payload != null) {
    payloadHash = await moo.objects.putJSON({ kind: kind, value: input.payload });
  }

  const { runId, stepId } = await appendStep(chatId, {
    kind,
    status: "agent:Queued",
    payloadHash,
  });
  return {
    ok: true,
    value: { chatId, runId, stepId, kind, payloadHash, queued: true },
  };
}

export async function tickCommand(input: Input) {
  const chatId = input.chatId || "demo";
  const c = chatRefs(chatId);
  const runId = await moo.refs.get(c.run);

  const claim = await moo.agent.claim(c.facts, c.graph, runId, input.leaseMs ?? 60_000);
  if (!claim) {
    return { ok: true, value: { chatId, ran: false, reason: "no queued step" } };
  }

  const { stepId, leaseId } = claim;
  const kindRows = await moo.facts.match({ ref: c.facts, ...{
    graph: c.graph,
    subject: stepId,
    predicate: "agent:kind",
    limit: 1,
  } });
  const kind = kindRows[0]?.[3];

  let result: any = null;
  let resultHash: string | null = null;
  let status: "agent:Done" | "agent:Failed" = "agent:Done";
  let errorMessage: string | null = null;

  try {
    if (kind === "agent:ShellCommand") {
      const payloadObj = await loadPayloadJSON(c.facts, c.graph, stepId);
      if (!payloadObj) throw new Error("ShellCommand step has no payload");
      const { cmd, args, cwd, stdin } = payloadObj.value;
      const wt = cwd ?? (await moo.chat.scratch(chatId));
      result = await moo.proc.run({ cmd: cmd, args: args || [], ...{ cwd: wt, stdin } });
      resultHash = await moo.objects.putJSON({ kind: "agent:ToolResult", value: { kind, cmd, args, cwd: wt, ...result } });
      if (result.code !== 0 || result.timedOut) status = "agent:Failed";
    } else if (kind === "agent:Tick") {
      // no-op
    } else {
      throw new Error(`unsupported step kind: ${kind}`);
    }
  } catch (err: any) {
    status = "agent:Failed";
    errorMessage = err?.message ?? String(err);
    moo.log("tick error:", errorMessage);
  }

  await moo.facts.update({ ref: c.facts, fn: (txn) => {
    if (resultHash) txn.add({ graph: c.graph, subject: stepId, predicate: "agent:result", object: resultHash });
    if (result) txn.add({ graph: c.graph, subject: stepId, predicate: "agent:exitCode", object: String(result.code) });
    if (errorMessage) txn.add({ graph: c.graph, subject: stepId, predicate: "agent:error", object: errorMessage });
    if (leaseId) txn.remove({ graph: c.graph, subject: stepId, predicate: "agent:lease", object: leaseId });
  } });
  await moo.agent.complete(c.facts, c.graph, stepId, status);

  return {
    ok: true,
    value: { chatId, ran: true, stepId, kind, status, exitCode: result?.code ?? null },
  };
}

export async function submitCommand(input: Input) {
  const chatId = input.chatId || "demo";
  const requestId = String(input.requestId ?? "").trim();
  const cancelled = input.cancelled === true;
  const values = cancelled ? {} : input.values || {};
  if (!requestId) {
    return { ok: false, error: { message: "submit requires requestId" } };
  }
  const c = chatRefs(chatId);

  const statusRows = await moo.facts.match({ ref: c.facts, ...{
    graph: c.graph,
    subject: requestId,
    predicate: "ui:status",
    limit: 1,
  } });
  if (!statusRows.length) {
    return { ok: false, error: { message: "request not found" } };
  }
  const currentStatus = statusRows[0]![3];
  if (currentStatus !== "ui:Pending") {
    return { ok: false, error: { message: `request already ${currentStatus}` } };
  }

  const kindRows = await moo.facts.match({ ref: c.facts, ...{
    graph: c.graph,
    subject: requestId,
    predicate: "ui:kind",
    limit: 1,
  } });
  const kind = kindRows[0]?.[3] || null;

  const respondedAt = await moo.time.nowMs();
  const respPayload = await moo.objects.putJSON({ kind: "ui:Response", value: { values, at: respondedAt, ...(cancelled ? { cancelled: true } : {}) } });
  const respId = await moo.id.new("uires");

  await moo.facts.update({ ref: c.facts, fn: (txn) => {
    txn.add({ graph: c.graph, subject: respId, predicate: "rdf:type", object: "ui:InputResponse" });
    txn.add({ graph: c.graph, subject: respId, predicate: "ui:respondsTo", object: requestId });
    txn.add({ graph: c.graph, subject: respId, predicate: "ui:payload", object: respPayload });
    txn.add({ graph: c.graph, subject: respId, predicate: "ui:createdAt", object: respondedAt });
    txn.remove({ graph: c.graph, subject: requestId, predicate: "ui:status", object: "ui:Pending" });
    txn.add({ graph: c.graph, subject: requestId, predicate: "ui:status", object: cancelled ? "ui:Cancelled" : "ui:Done" });
  } });

  // Normal submit resumes the Rust driver; cancel only records the response.
  return {
    ok: true,
    value: {
      chatId,
      requestId,
      kind,
      responseId: respId,
      cancelled,
      driver: !cancelled ? stepDriverAction(chatId, "resume") : null,
      // Back-compat for older hosts; src/ws.rs now reads driver.action.
      resume: !cancelled,
    },
  };
}

export function sanitizeAttachments(value: any): Array<{ type: "image"; mimeType: string; dataUrl: string; name?: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((a) => a && a.type === "image" && typeof a.dataUrl === "string" && a.dataUrl.startsWith("data:image/"))
    .slice(0, 8)
    .map((a) => ({
      type: "image" as const,
      mimeType: typeof a.mimeType === "string" ? a.mimeType : "image/png",
      dataUrl: a.dataUrl,
      ...(typeof a.name === "string" ? { name: a.name } : {}),
    }));
}


export function chatOngoingRef(chatId: string): string {
  return `chat/${chatId}/ongoing`;
}

export async function setChatOngoing(chatId: string, ongoing: boolean) {
  if (ongoing) await moo.refs.set(chatOngoingRef(chatId), String(await moo.time.nowMs()));
  else await moo.refs.delete(chatOngoingRef(chatId));
}

export async function cancelChatInFlightSteps(chatId: string, reason = "interrupted") {
  const c = chatRefs(chatId);
  const rows = await moo.facts.matchAll({ patterns: [
      ["?step", "rdf:type", "agent:Step"],
      ["?step", "agent:status", "?status"],
    ], ...{ ref: c.facts, graph: c.graph } });
  const steps = new Set<string>();
  const removes: Array<[string, string, string, string]> = [];
  for (const row of rows) {
    const step = row["?step"];
    const status = row["?status"];
    if (!step || (status !== "agent:Running" && status !== "agent:Queued")) continue;
    steps.add(step);
    removes.push([c.graph, step, "agent:status", status]);
  }
  if (steps.size === 0) return { cancelled: 0 };

  const now = String(await moo.time.nowMs());
  const adds: Array<[string, string, string, string]> = [];
  for (const step of steps) {
    adds.push([c.graph, step, "agent:status", "agent:Cancelled"]);
    adds.push([c.graph, step, "agent:cancelledAt", now]);
    adds.push([c.graph, step, "agent:error", reason]);
  }
  await moo.facts.swap({ ref: c.facts, removes: removes, adds: adds });
  return { cancelled: steps.size };
}

// -- chat-driver state machine ----------------------------------------------
//
// The Rust chat driver calls these commands in sequence, with no V8
// worker held between calls. Result: long-running LLM I/O happens in Rust
// (Tokio) without tying up an isolate; the worker is borrowed only for short
// JS calls (event shape, build messages, run tool, record fact).

export function stepLifecycleEvents(chatId: string) {
  return {
    start: { kind: "step-start", chatId },
    end: { kind: "step-end", chatId },
  };
}

export function stepDriverAction(chatId: string, mode: "step" | "resume", extra: Record<string, any> = {}) {
  const lifecycleEvents = stepLifecycleEvents(chatId);
  return {
    action: "drive",
    chatId,
    state: { chatId, mode, ...extra, lifecycleEvents },
    lifecycleEvents,
  };
}

export async function stepPreludeCommand(input: Input) {
  const chatId = input.chatId;
  const message = String(input.message ?? "").trim();
  const attachments = sanitizeAttachments(input.attachments);
  if (!message && attachments.length === 0) {
    return { ok: false, error: { message: "step requires a message or attachment" } };
  }

  // A new user turn makes the chat active again, regardless of whether it
  // was hidden in the archived section before the user sent the message.
  await moo.chat.unarchive(chatId);

  const payloadHash = await moo.objects.putJSON({ kind: "agent:UserInput", value: {
      message,
      at: await moo.time.nowMs(),
      ...(attachments.length ? { attachments } : {}),
    } });
  await appendStep(chatId, {
    kind: "agent:UserInput",
    status: "agent:Done",
    payloadHash,
  });

  // Known slash commands are dispatched inline (synchronous). They may invoke
  // shell commands or compaction, but they don't run the agent loop. Unknown
  // slash-prefixed input falls through and is sent as a normal message.
  if (message.startsWith("/") && await respondTo(chatId, message)) {
    await setChatOngoing(chatId, false);
    return { ok: true, value: { kind: "done" } };
  }

  const selectedModel = await getChatModel(chatId);
  const selectedEffort = await getChatEffort(chatId);
  const selectedProvider = await getChatProvider(chatId);
  const provider = await resolveProvider(selectedModel, selectedEffort, selectedProvider);
  if (!provider.apiKey) {
    await reply(
      chatId,
      [
        `I'd love to think for you, but \`${provider.keyEnvHint}\` isn't set.`,
        provider.name === "qwen"
          ? "Set QWEN_API_KEY (or DASHSCOPE_API_KEY) before starting the server."
          : provider.name === "anthropic"
            ? "Set ANTHROPIC_API_KEY before starting the server."
            : "Restart with: `OPENAI_API_KEY=sk-... cargo run -- serve`",
        "Until then, try `/help`.",
      ].join("\n"),
    );
    await setChatOngoing(chatId, false);
    return { ok: true, value: { kind: "done" } };
  }

  await setChatOngoing(chatId, true);
  return { ok: true, value: { kind: "loop", provider } };
}

export async function stepResumeCommand(input: Input) {
  const chatId = String(input.chatId ?? "").trim();
  if (!chatId) return { ok: false, error: { message: "step-resume requires chatId" } };

  if (await hasPendingInput(chatId)) {
    await setChatOngoing(chatId, false);
    return { ok: true, value: { kind: "done" } };
  }

  const selectedModel = await getChatModel(chatId);
  const selectedEffort = await getChatEffort(chatId);
  const selectedProvider = await getChatProvider(chatId);
  const provider = await resolveProvider(selectedModel, selectedEffort, selectedProvider);
  if (!provider.apiKey) {
    await reply(
      chatId,
      [
        "Cannot resume this chat because `" + provider.keyEnvHint + "` isn't set.",
        provider.name === "qwen"
          ? "Set QWEN_API_KEY (or DASHSCOPE_API_KEY), then restart the server."
          : provider.name === "anthropic"
            ? "Set ANTHROPIC_API_KEY, then restart the server."
            : "Restart with: `OPENAI_API_KEY=sk-... cargo run -- serve`",
      ].join("\n"),
    );
    await setChatOngoing(chatId, false);
    return { ok: true, value: { kind: "done" } };
  }

  await setChatOngoing(chatId, true);
  return { ok: true, value: { kind: "loop", provider } };
}


export async function commandValue(result: any): Promise<any> {
  if (!result || result.ok !== true) {
    const msg = result?.error?.message || "driver step command failed";
    throw new Error(msg);
  }
  return result.value ?? null;
}

export async function stepNextCommand(input: Input) {
  let state = initialStepDriverState(input as any);
  const chatId = state.chatId;
  if (!chatId) return { ok: false, error: { message: "step-next requires state.chatId" } };

  for (const event of stepNextInputEvents(input as any, state)) {
    state = reduceStepDriverState(state, event);
  }

  while (true) {
    const [effect] = planStepDriverEffects(state);
    if (!effect) return { ok: true, value: { kind: "done" } };

    if (effect.type === "Return") {
      return { ok: true, value: effect.value };
    }

    if (effect.type === "ContinueToolCalls") {
      const handled = await commandValue(await stepContinueToolCallsCommand(effect.input as Input));
      state = reduceStepDriverState(state, { type: "ToolContinuationHandled", handled });
      continue;
    }

    if (effect.type === "HandleLlm") {
      const handled = await commandValue(await stepHandleLlmCommand(effect.input as Input));
      state = reduceStepDriverState(state, { type: "LlmHandled", handled });
      continue;
    }

    if (effect.type === "Start") {
      const started = await commandValue(effect.mode === "resume"
        ? await stepResumeCommand(effect.input as Input)
        : await stepPreludeCommand(effect.input as Input));
      state = reduceStepDriverState(state, { type: "Started", started });
      continue;
    }

    if (effect.type === "Prepare") {
      const prepared = await commandValue(await stepPrepareCommand(effect.input as Input));
      state = reduceStepDriverState(state, { type: "Prepared", prepared });
      continue;
    }
  }
}

export async function stepContinueToolCallsCommand(input: Input) {
  const chatId = String(input.chatId ?? "").trim();
  const messages = Array.isArray(input.state?.messages) ? input.state.messages : [];
  const toolCalls = Array.isArray(input.toolCalls) ? input.toolCalls : [];
  const usedModel = input.usedModel ?? null;
  const requestEffort = input.requestEffort ?? input.state?.requestEffort ?? null;
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (tc?.function?.name === "runJS") {
      return {
        ok: true,
        value: {
          kind: "tool-js",
          state: {
            ...input.state,
            chatId,
            messages,
            pendingToolCalls: toolCalls.slice(i + 1),
            usedModel,
            requestEffort,
          },
          toolCall: tc,
          model: usedModel,
        },
      };
    }
    const exec = await executeToolCall(chatId, tc, usedModel, requestEffort);
    messages.push({ role: "tool", tool_call_id: tc.id, content: exec.toolText });
  }
  if (await hasPendingInput(chatId)) {
    await setChatOngoing(chatId, false);
    return { ok: true, value: { kind: "wait-input" } };
  }
  return { ok: true, value: { kind: "iterate", messages } };
}

export async function runJsToolCommand(input: Input) {
  const chatId = String(input.chatId ?? input.state?.chatId ?? "").trim();
  if (!chatId) return { ok: false, error: { message: "run-js-tool requires chatId" } };
  try {
    const requestEffort = input.effort ?? input.requestEffort ?? input.state?.requestEffort ?? null;
    const exec = await runToolCall(chatId, input.toolCall, input.model ?? input.state?.usedModel ?? null, requestEffort);
    return {
      ok: true,
      value: {
        toolCallId: input.toolCall?.id,
        content: exec.toolText,
        status: "done",
      },
    };
  } catch (err: any) {
    const message = err?.message || String(err);
    return {
      ok: true,
      value: {
        toolCallId: input.toolCall?.id,
        content: `error: ${message}`,
        status: "failed",
      },
    };
  }
}


export async function subagentFinalCommand(input: Input) {
  const chatId = String(input.chatId ?? "").trim();
  if (!chatId) return { ok: false, error: { message: "subagent-final requires chatId" } };
  const c = chatRefs(chatId);
  const rows = await moo.facts.matchAll({ patterns: [
      ["?step", "agent:kind", "agent:Reply"],
      ["?step", "agent:createdAt", "?at"],
    ], ...{ ref: c.facts, graph: c.graph } });
  const latest = rows
    .map((r) => ({ step: r["?step"]!, at: Number(r["?at"] || 0) }))
    .sort((a, b) => b.at - a.at)[0];
  if (!latest) return { ok: true, value: { output: "", text: "" } };
  const payload = await loadPayloadJSON(c.facts, c.graph, latest.step);
  const output = String(payload?.value?.text ?? "");
  // Keep the legacy `text` alias so older native drivers can still read the reply.
  return { ok: true, value: { output, text: output } };
}


export async function interruptCommand(input: Input) {
  const chatId = String(input.chatId ?? "").trim();
  if (!chatId) return { ok: false, error: { message: "interrupt requires chatId" } };

  // Interrupt is an explicit stop, not a pause-to-resume. Clear the durable
  // ongoing marker before asking Rust to abort the in-flight driver; otherwise
  // a later server restart treats the interrupted chat as crash-recoverable and
  // relaunches the LLM turn the user just stopped.
  await setChatOngoing(chatId, false);
  const cancelledSteps = await cancelChatInFlightSteps(chatId);

  return {
    ok: true,
    value: {
      chatId,
      cancelledSteps: cancelledSteps.cancelled,
      driver: { action: "interrupt", chatId },
    },
  };
}

export async function restartOngoingCommand() {
  const chats = await moo.chat.list();
  const chatIds: string[] = [];
  const skippedPending: string[] = [];
  const clearedStale: string[] = [];
  for (const c of chats) {
    if (c.archived) continue;
    const marked = await moo.refs.get(chatOngoingRef(c.chatId));
    const staleInflightStatus = c.status === "agent:Running" || c.status === "agent:Queued";
    if (!marked) {
      // Only the durable ongoing marker means a chat is crash-recoverable.
      // Status-only Running/Queued rows can be leftovers from an interrupted
      // tool call (for example RunJS aborted before it could write Done).
      // Treat them as stale instead of relaunching the LLM after restart.
      if (staleInflightStatus) {
        await cancelChatInFlightSteps(c.chatId, "cleared stale in-flight status during startup");
        clearedStale.push(c.chatId);
      }
      continue;
    }

    // A crash/restart can happen after a tool created a ui:InputRequest but
    // before the driver reached its wait-input cleanup path. In that case the
    // stale ongoing marker must not relaunch the chat; the user's submit is the
    // correct resume point.
    if (c.status === "ui:Pending" || await hasPendingInput(c.chatId)) {
      if (marked) await setChatOngoing(c.chatId, false);
      skippedPending.push(c.chatId);
      continue;
    }

    // Any step left Running/Queued was interrupted by the crash — its V8
    // execution is gone. Cancel before resuming so the UI doesn't keep a
    // spinner on the orphaned runJS step.
    await cancelChatInFlightSteps(c.chatId, "interrupted by server restart");
    chatIds.push(c.chatId);
  }
  return {
    ok: true,
    value: {
      chatIds,
      skippedPending,
      clearedStale,
      driverActions: chatIds.map((chatId) => stepDriverAction(chatId, "resume")),
    },
  };
}

export async function stepPrepareCommand(input: Input) {
  const chatId = input.chatId;
  const provider = input.provider;
  const selectedModel = await getChatModel(chatId);
  const selectedEffort = await getChatEffort(chatId);
  if (selectedModel) provider.model = selectedModel;
  const efforts = effortLevelsForProvider(provider);
  if (efforts.length) {
    const defaultEffort = await defaultChatEffort();
    provider.effort = effortAllowedForModel(efforts, selectedEffort) || effortAllowedForModel(efforts, defaultEffort);
  } else {
    provider.effort = null;
  }
  const passedMessages = Array.isArray(input.messages) ? (input.messages as any[]) : null;

  // First iteration (no carried-over messages): build from DB and check
  // compaction. Subsequent iterations carry the in-progress message array
  // through the driver — the assistant + tool entries from the previous
  // round must persist across the LLM call.
  let messages: any[];
  let estimatedPromptTokens = 0;
  let budget = await contextBudget(provider);
  if (passedMessages == null) {
    messages = await buildLLMMessages(chatId);
    estimatedPromptTokens = estimateTokens(messages);
    if (estimatedPromptTokens >= Math.floor(budget * COMPACT_FRACTION)) {
      const summaryMessages = [
        {
          role: "system",
          content:
            "You compress conversation history. Produce a tight summary capturing user intents, decisions made, files touched, errors hit. Plain prose, 200-400 words.",
        },
        ...messages.slice(1),
        { role: "user", content: "Summarize the above conversation now." },
      ];
      return {
        ok: true,
        value: {
          kind: "llm",
          purpose: "compact",
          ...buildStreamingLLMRequest(provider, summaryMessages, null),
          countThoughtDuration: false,
          headers: llmProviderHeaders(provider),
          draftId: "",
          // After compaction, the next prepare call rebuilds from DB.
          messages: null,
          estimatedPromptTokens,
          tokenBudget: budget,
          tokenThreshold: Math.floor(budget * COMPACT_FRACTION),
        },
      };
    }
  } else {
    messages = passedMessages;
    estimatedPromptTokens = estimateTokens(messages);
  }

  const threshold = Math.floor(budget * COMPACT_FRACTION);
  const draftId = await moo.id.new("draft");
  return {
    ok: true,
    value: {
      kind: "llm",
      purpose: "step",
      ...buildStreamingLLMRequest(provider, messages, TOOLS),
      countThoughtDuration: true,
      headers: llmProviderHeaders(provider),
      draftId,
      messages,
      estimatedPromptTokens,
      tokenBudget: budget,
      tokenThreshold: threshold,
      streamEvents: llmStreamEventOptions(chatId, draftId, {
        estimatedPromptTokens,
        tokenBudget: budget,
        tokenThreshold: threshold,
      }),
    },
  };
}

export async function stepHandleLlmCommand(input: Input) {
  const chatId = input.chatId;
  const attempt = llmAttempt(input);
  const purpose = input.purpose as "step" | "compact";
  const llmResult = input.llmResult as {
    status: number;
    ok: boolean;
    content: string;
    toolCalls: any[];
    errorBody: string | null;
    headers?: Record<string, unknown> | null;
    model: string | null;
    usage: any | null;
  };
  const draftId = String(input.draftId ?? "");
  const thoughtDurationMs = Number(input.thoughtDurationMs);
  let messages = (Array.isArray(input.messages) ? (input.messages as any[]) : null) as any[] | null;

  if (draftId) moo.events.publish({ kind: "draft-end", chatId, draftId });

  // The model that actually served the request. Provider may echo back a
  // pinned variant (e.g. `gpt-5.5-2026-01`), so prefer that over the model
  // we requested.
  const usedModel =
    (typeof llmResult.model === "string" && llmResult.model) ||
    (typeof input.requestModel === "string" && input.requestModel) ||
    null;

  const partialToolCallsText = Array.isArray(llmResult.toolCalls) && llmResult.toolCalls.length > 0 ? JSON.stringify(llmResult.toolCalls) : "";
  const partialOutputText = llmResult.content || partialToolCallsText;
  const hasPartialBillableOutput = Boolean(partialOutputText);
  const normalizedUsage = normalizeUsage(llmResult.usage) ?? (llmResult.ok || hasPartialBillableOutput ? estimateRawUsage(messages, partialOutputText, Number(input.estimatedPromptTokens) || 0) : null);
  if (normalizedUsage) {
    const requestProvider = input.requestProvider === "anthropic" || input.requestProvider === "qwen" ? input.requestProvider : "openai";
    const tokenEvent = await tokenUsageEvent(chatId, normalizedUsage, usedModel ? { name: requestProvider, model: usedModel } : null);
    if (tokenEvent) moo.events.publish(tokenEvent);
    await recordUsage(chatId, usedModel, normalizedUsage);
  }

  if (purpose === "compact") {
    if (!llmResult.ok) {
      await recordCompactionFailure(chatId, `provider returned HTTP ${llmResult.status}`, {
        trigger: "automatic",
        promptTokens: Number(input.estimatedPromptTokens) || null,
        tokenBudget: Number(input.tokenBudget) || null,
        tokenThreshold: Number(input.tokenThreshold) || null,
      });
      await setChatOngoing(chatId, false);
      // Don't iterate — the next prepare would see token-pressure still
      // over threshold and try to compact again forever.
      return { ok: true, value: { kind: "done" } };
    }
    const summary = (llmResult.content || "").trim();
    if (!summary) {
      await recordCompactionFailure(chatId, "provider returned an empty summary", {
        trigger: "automatic",
        promptTokens: Number(input.estimatedPromptTokens) || null,
        tokenBudget: Number(input.tokenBudget) || null,
        tokenThreshold: Number(input.tokenThreshold) || null,
      });
      await setChatOngoing(chatId, false);
      return { ok: true, value: { kind: "done" } };
    }
    const compactionTracking = {
      trigger: "automatic",
      promptTokens: Number(input.estimatedPromptTokens) || null,
      tokenBudget: Number(input.tokenBudget) || null,
      tokenThreshold: Number(input.tokenThreshold) || null,
    };
    const now = await moo.time.nowMs();
    const previous = await moo.refs.get(chatRefs(chatId).compaction);
    const compactionHash = await moo.objects.putJSON({ kind: "agent:Compaction", value: {
        summary,
        throughAt: now,
        at: now,
        parent: previous ?? null,
        ...compactionTracking,
      } });
    await moo.refs.set(chatRefs(chatId).compaction, compactionHash);
    await appendStep(chatId, {
      kind: "agent:Compaction",
      status: "agent:Done",
      payloadHash: compactionHash,
      extras: [
        ...stepLlmExtras(usedModel, input.requestEffort),
        ["agent:trigger", "agent:Automatic"],
        ...(compactionTracking.promptTokens != null ? [["agent:promptTokens", String(compactionTracking.promptTokens)] as [string, string]] : []),
        ...(compactionTracking.tokenBudget != null ? [["agent:tokenBudget", String(compactionTracking.tokenBudget)] as [string, string]] : []),
        ...(compactionTracking.tokenThreshold != null ? [["agent:tokenThreshold", String(compactionTracking.tokenThreshold)] as [string, string]] : []),
      ],
    });
    return { ok: true, value: { kind: "iterate", messages: null } };
  }

  // purpose === "step"
  if (!llmResult.ok) {
    const retry = llmRetryDecision(llmResult, attempt, await currentLlmRetryPolicy());
    if (retry.retry) {
      return {
        ok: true,
        value: {
          kind: "iterate",
          messages,
          retryAttempt: attempt + 1,
          retryReason: retry.reason,
          retryDelayMs: retry.delayMs,
        },
      };
    }

    let parsed: any = null;
    try { parsed = JSON.parse(llmResult.errorBody || ""); } catch {}
    await recordErrorStep(
      chatId,
      "provider",
      {
        source: "provider",
        status: llmResult.status,
        attempts: attempt,
        retryReason: retry.reason,
        message:
          parsed?.error?.message || `request failed with status ${llmResult.status}`,
        type: parsed?.error?.type ?? null,
        code: parsed?.error?.code ?? null,
        body: parsed ?? llmResult.errorBody ?? "",
      },
      usedModel,
      input.requestEffort,
    );
    await setChatOngoing(chatId, false);
    return { ok: true, value: { kind: "done" } };
  }

  if (!messages) messages = await buildLLMMessages(chatId);

  if (Array.isArray(llmResult.toolCalls) && llmResult.toolCalls.length > 0) {
    // Persist any preamble text the model emitted alongside its tool calls so
    // the streaming "draft" bubble has a real Reply step to land into. Without
    // this the UI clears the draft on draft-end and the preamble vanishes.
    const preamble = (llmResult.content || "").trim();
    if (preamble) {
      await reply(
        chatId,
        preamble,
        usedModel,
        input.requestEffort,
        Number.isFinite(thoughtDurationMs) ? thoughtDurationMs : null,
      );
    }
    messages.push({
      role: "assistant",
      content: llmResult.content || null,
      tool_calls: llmResult.toolCalls,
    });
    return await stepContinueToolCallsCommand({
      chatId,
      state: { messages, thoughtDurationMs: input.thoughtDurationMs },
      toolCalls: llmResult.toolCalls,
      usedModel,
      requestEffort: input.requestEffort,
    });
  }

  const text = (llmResult.content || "").trim();
  await reply(
    chatId,
    text || "(no response)",
    usedModel,
    input.requestEffort,
    Number.isFinite(thoughtDurationMs) ? thoughtDurationMs : null,
  );
  await setChatOngoing(chatId, false);
  return { ok: true, value: { kind: "done" } };
}

export function stepLlmExtras(model: string | null | undefined, effort: unknown): Array<[string, string]> {
  const extras: Array<[string, string]> = [];
  const m = String(model ?? "").trim();
  const e = normalizeEffort(effort);
  if (m) extras.push(["agent:model", m]);
  if (e) extras.push(["agent:effort", e]);
  return extras;
}

