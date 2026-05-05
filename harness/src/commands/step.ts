import { moo } from "../moo";
import { chatRefs } from "../lib";
import {
  appendStep,
  buildLLMMessages,
  buildCompactionMessages,
  compactionThresholdForBudget,
  estimateCompactionPromptTokens,
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
  recordCompactionFailure,
  recordErrorStep,
  recordLastContextTokens,
  recordUsage,
  effortLevelsForProvider,
  llmProviderHeaders,
  reply,
  normalizeEffort,
  normalizeUsage,
  tokenUsageEvent,
  llmStreamEventOptions,
  resolveProvider,
  summarizeLlmBodyForTrace,
  summarizeMessagesForTrace,
  summarizeToolCallForTrace,
  traceMark,
  traceSpan,
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
import { llmAttempt, llmRetryDecisionFromSchedule } from "../core/retry";
import { currentLlmRetryPolicy } from "./llm_auth";
import {
  defaultChatEffort,
  effortAllowedForModel,
  getChatEffort,
  getChatModel,
  getChatProvider,
} from "./models";

function parseProviderErrorBody(raw: unknown): any {
  if (raw == null) return null;
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return trimmed; }
}

function providerErrorMessage(parsed: any, status: number): string {
  const candidates = [
    parsed?.error?.message,
    parsed?.message,
    parsed?.detail?.message,
    parsed?.details,
    parsed?.error_description,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  if (typeof parsed === "string" && parsed.trim() && parsed.trim() !== "error") return parsed.trim();
  if (status > 0) return `request failed with HTTP ${status}`;
  return "LLM request failed before an HTTP response was received";
}

function providerErrorType(parsed: any): string | null {
  return parsed?.error?.type ?? parsed?.type ?? null;
}

function providerErrorCode(parsed: any): string | null {
  return parsed?.error?.code ?? parsed?.code ?? null;
}

function providerErrorBodyForRecord(parsed: any, raw: unknown): any {
  if (parsed != null) return parsed;
  if (raw == null) return "";
  return raw;
}

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

export async function resumeCommand(input: Input) {
  const chatId = String(input.chatId || "demo").trim() || "demo";

  return {
    ok: true,
    value: {
      chatId,
      accepted: true,
      driver: stepDriverAction(chatId, "resume"),
      // Back-compat for older hosts; src/ws.rs now reads driver.action.
      resume: true,
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
  const runId = await moo.pointers.get(c.run);

  const claim = await moo.agent.claim(c.facts, c.graph, runId, input.leaseMs ?? 60_000);
  if (!claim) {
    return { ok: true, value: { chatId, ran: false, reason: "no queued step" } };
  }

  const { stepId, leaseId } = claim;
  const kindRows = await moo.facts.match({ store: c.facts, ...{
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

  await moo.facts.update({ store: c.facts, fn: (txn) => {
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

  const statusRows = await moo.facts.match({ store: c.facts, ...{
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

  const kindRows = await moo.facts.match({ store: c.facts, ...{
    graph: c.graph,
    subject: requestId,
    predicate: "ui:kind",
    limit: 1,
  } });
  const kind = kindRows[0]?.[3] || null;

  const respondedAt = await moo.time.nowMs();
  const respPayload = await moo.objects.putJSON({ kind: "ui:Response", value: { values, at: respondedAt, ...(cancelled ? { cancelled: true } : {}) } });
  const respId = await moo.id.new("uires");

  await moo.facts.update({ store: c.facts, fn: (txn) => {
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
  if (ongoing) await moo.pointers.set(chatOngoingRef(chatId), String(await moo.time.nowMs()));
  else await moo.pointers.delete(chatOngoingRef(chatId));
}

export async function cancelChatInFlightSteps(chatId: string, reason = "interrupted") {
  const c = chatRefs(chatId);
  const rows = await moo.facts.matchAll({ patterns: [
      ["?step", "rdf:type", "agent:Step"],
      ["?step", "agent:status", "?status"],
    ], ...{ store: c.facts, graph: c.graph } });
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
  await moo.facts.swap({ store: c.facts, removes, adds });
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
        "LLM authentication is not configured for " + provider.name + ".",
        "Open [Settings](/settings) to configure auth, or set `" + provider.keyEnvHint + "` before starting the server.",
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
        "Cannot resume this chat because LLM authentication is not configured for " + provider.name + ".",
        "Open [Settings](/settings) to configure auth, or set `" + provider.keyEnvHint + "` before starting the server.",
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
    await traceMark("driver.event", {
      chatId,
      type: event.type,
      beforePhase: (state as any)?.phase ?? null,
      hadMessages: Array.isArray((state as any)?.messages),
      pendingToolCalls: Array.isArray((state as any)?.pendingToolCalls) ? (state as any).pendingToolCalls.length : 0,
    });
    state = reduceStepDriverState(state, event);
    await traceMark("driver.state", {
      chatId,
      afterEvent: event.type,
      phase: (state as any)?.phase ?? null,
      messages: Array.isArray((state as any)?.messages) ? (state as any).messages.length : null,
      pendingToolCalls: Array.isArray((state as any)?.pendingToolCalls) ? (state as any).pendingToolCalls.length : 0,
      llmAttempts: (state as any)?.llmAttempts ?? null,
    });
  }

  while (true) {
    const [effect] = planStepDriverEffects(state);
    if (!effect) return { ok: true, value: { kind: "done" } };

    await traceMark("driver.effect", {
      chatId,
      type: effect.type,
      phase: (state as any)?.phase ?? null,
      pendingToolCalls: Array.isArray((state as any)?.pendingToolCalls) ? (state as any).pendingToolCalls.length : 0,
      llmAttempts: (state as any)?.llmAttempts ?? null,
      hasMessages: Array.isArray((state as any)?.messages),
    });

    if (effect.type === "Return") {
      await traceMark("driver.return", {
        chatId,
        kind: (effect.value as any)?.kind ?? null,
        hasState: !!(effect.value as any)?.state,
        hasToolCall: !!(effect.value as any)?.toolCall,
      });
      return { ok: true, value: effect.value };
    }

    if (effect.type === "ContinueToolCalls") {
      const handled = await traceSpan("driver.continue_tools", {
        chatId,
        pendingToolCalls: Array.isArray((effect.input as any)?.toolCalls) ? (effect.input as any).toolCalls.length : 0,
      }, async () => commandValue(await stepContinueToolCallsCommand(effect.input as Input)));
      state = reduceStepDriverState(state, { type: "ToolContinuationHandled", handled });
      continue;
    }

    if (effect.type === "HandleLlm") {
      const handled = await traceSpan("driver.handle_llm", {
        chatId,
        purpose: (effect.input as any)?.purpose ?? null,
        attempt: (effect.input as any)?.attempt ?? null,
        ok: (effect.input as any)?.llmResult?.ok ?? null,
        status: (effect.input as any)?.llmResult?.status ?? null,
      }, async () => commandValue(await stepHandleLlmCommand(effect.input as Input)));
      state = reduceStepDriverState(state, { type: "LlmHandled", handled });
      continue;
    }

    if (effect.type === "Start") {
      const started = await traceSpan("driver.start", {
        chatId,
        mode: effect.mode,
        hasMessage: typeof (effect.input as any)?.message === "string" && (effect.input as any).message.length > 0,
        attachments: Array.isArray((effect.input as any)?.attachments) ? (effect.input as any).attachments.length : 0,
      }, async () => commandValue(effect.mode === "resume"
        ? await stepResumeCommand(effect.input as Input)
        : await stepPreludeCommand(effect.input as Input)));
      state = reduceStepDriverState(state, { type: "Started", started });
      continue;
    }

    if (effect.type === "Prepare") {
      const prepared = await traceSpan("driver.prepare_llm", {
        chatId,
        hasCarriedMessages: Array.isArray((effect.input as any)?.messages),
        provider: (effect.input as any)?.provider?.name ?? null,
        model: (effect.input as any)?.provider?.model ?? null,
      }, async () => commandValue(await stepPrepareCommand(effect.input as Input)));
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
  await traceMark("tool.batch.start", { chatId, count: toolCalls.length, carriedMessages: messages.length, usedModel, requestEffort });
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    await traceMark("tool.call.queued", { chatId, index: i, ...summarizeToolCallForTrace(tc) });
    if (tc?.function?.name === "runJS") {
      await traceMark("tool.runjs.deferred", { chatId, index: i, remainingToolCalls: toolCalls.length - i - 1, ...summarizeToolCallForTrace(tc) });
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
    const exec = await traceSpan("tool.execute", { chatId, usedModel, requestEffort, ...summarizeToolCallForTrace(tc) }, () => executeToolCall(chatId, tc, usedModel, requestEffort));
    await traceMark("tool.result.ready", { chatId, index: i, toolCallId: tc.id ?? null, contentChars: exec.toolText.length });
    messages.push({ role: "tool", tool_call_id: tc.id, content: exec.toolText });
  }
  if (await hasPendingInput(chatId)) {
    await traceMark("tool.batch.wait_input", { chatId, messages: messages.length });
    await setChatOngoing(chatId, false);
    return { ok: true, value: { kind: "wait-input" } };
  }
  await traceMark("tool.batch.complete", { chatId, messages: messages.length });
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
    ], ...{ store: c.facts, graph: c.graph } });
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

  // Interrupt is an explicit stop, not durable crash-recovery. Manual resume
  // goes through resumeCommand when the user presses Play. Clear the durable
  // ongoing marker before asking Rust to abort the in-flight driver; otherwise
  // a later server restart treats the stopped chat as crash-recoverable and
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
    const marked = await moo.pointers.get(chatOngoingRef(c.chatId));
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
  await traceMark("llm.prepare.start", { chatId, provider: provider?.name ?? null, baseModel: provider?.model ?? null, carriedMessages: Array.isArray(input.messages) ? (input.messages as any[]).length : null });
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
  await traceMark("llm.provider.selected", { chatId, provider: provider?.name ?? null, model: provider?.model ?? null, effort: provider?.effort ?? null, selectedModel: selectedModel ?? null, selectedEffort: selectedEffort ?? null, supportedEfforts: efforts });
  const passedMessages = Array.isArray(input.messages) ? (input.messages as any[]) : null;

  // First iteration (no carried-over messages): build from DB and check
  // compaction. Subsequent iterations carry the in-progress message array
  // through the driver — the assistant + tool entries from the previous
  // round must persist across the LLM call.
  let messages: any[];
  let estimatedPromptTokens = 0;
  let budget = await contextBudget(provider);
  if (passedMessages == null) {
    messages = await traceSpan("llm.build_messages", { chatId }, () => buildLLMMessages(chatId));
    await traceMark("llm.messages.ready", { chatId, source: "chat", ...summarizeMessagesForTrace(messages, TOOLS) });
    estimatedPromptTokens = await traceSpan("compaction.estimate", { chatId, messages: messages.length }, () => estimateCompactionPromptTokens(chatId, messages));
    const threshold = await compactionThresholdForBudget(budget);
    await traceMark("compaction.check", { chatId, estimatedPromptTokens, tokenBudget: budget, tokenThreshold: threshold, shouldCompact: estimatedPromptTokens >= threshold });
    if (estimatedPromptTokens >= threshold) {
      await traceMark("compaction.triggered", { chatId, estimatedPromptTokens, tokenBudget: budget, tokenThreshold: threshold });
      const summaryMessages = [
        {
          role: "system",
          content:
            "You compress conversation history. Produce a tight summary capturing user intents, decisions made, files touched, errors hit. Plain prose, 200-400 words.",
        },
        ...(await traceSpan("compaction.build_messages", { chatId }, () => buildCompactionMessages(chatId))).slice(1),
        { role: "user", content: "Summarize the above conversation now." },
      ];
      const request = buildStreamingLLMRequest(provider, summaryMessages, null);
      await traceMark("llm.request.prepared", {
        chatId,
        purpose: "compact",
        provider: provider.name,
        model: request.requestModel,
        effort: request.requestEffort,
        url: request.url,
        responsesApi: request.responsesApi,
        estimatedPromptTokens,
        tokenBudget: budget,
        tokenThreshold: threshold,
        ...summarizeMessagesForTrace(summaryMessages, null),
        request: summarizeLlmBodyForTrace(request.body),
      });
      return {
        ok: true,
        value: {
          kind: "llm",
          purpose: "compact",
          ...request,
          countThoughtDuration: false,
          headers: llmProviderHeaders(provider),
          draftId: "",
          // After compaction, the next prepare call rebuilds from DB.
          messages: null,
          estimatedPromptTokens,
          tokenBudget: budget,
          tokenThreshold: threshold,
        },
      };
    }
  } else {
    messages = passedMessages;
    estimatedPromptTokens = estimateTokens(messages, TOOLS);
    await traceMark("llm.messages.ready", { chatId, source: "carried", ...summarizeMessagesForTrace(messages, TOOLS) });
  }

  const threshold = await compactionThresholdForBudget(budget);
  const draftId = await moo.id.new("draft");
  await traceMark("llm.draft.created", { chatId, draftId });
  const request = buildStreamingLLMRequest(provider, messages, TOOLS);
  await traceMark("llm.request.prepared", {
    chatId,
    purpose: "step",
    ...summarizeMessagesForTrace(messages, TOOLS),
    provider: provider.name,
    model: request.requestModel,
    effort: request.requestEffort,
    url: request.url,
    responsesApi: request.responsesApi,
    estimatedPromptTokens,
    tokenBudget: budget,
    tokenThreshold: threshold,
    request: summarizeLlmBodyForTrace(request.body),
  });
  return {
    ok: true,
    value: {
      kind: "llm",
      purpose: "step",
      ...request,
      countThoughtDuration: true,
      headers: request.headers,
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
  await traceMark("llm.result.received", {
    chatId,
    purpose,
    attempt,
    ok: llmResult.ok,
    status: llmResult.status,
    model: llmResult.model,
    usage: llmResult.usage,
    contentChars: (llmResult.content || "").length,
    toolCalls: Array.isArray(llmResult.toolCalls) ? llmResult.toolCalls.length : 0,
    errorChars: (llmResult.errorBody || "").length,
  });

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
  await traceMark("usage.normalized", {
    chatId,
    purpose,
    hasProviderUsage: !!llmResult.usage,
    estimated: !llmResult.usage && !!normalizedUsage,
    hasPartialBillableOutput,
    usage: normalizedUsage,
  });
  if (normalizedUsage && purpose !== "compact") {
    const requestProvider = input.requestProvider === "anthropic" || input.requestProvider === "qwen" ? input.requestProvider : "openai";
    const tokenEvent = await tokenUsageEvent(chatId, normalizedUsage, usedModel ? { name: requestProvider, model: usedModel } : null);
    if (tokenEvent) moo.events.publish(tokenEvent);
    await recordUsage(chatId, usedModel, normalizedUsage);
    await traceMark("usage.persisted", { chatId, purpose, updateLastContextTokens: true, model: usedModel });
  } else if (normalizedUsage) {
    await recordUsage(chatId, usedModel, normalizedUsage, { updateLastContextTokens: false });
    await traceMark("usage.persisted", { chatId, purpose, updateLastContextTokens: false, model: usedModel });
  }

  if (purpose === "compact") {
    if (!llmResult.ok) {
      await traceMark("compaction.failed", { chatId, reason: "stream_http", status: llmResult.status, attempt });
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
      await traceMark("compaction.failed", { chatId, reason: "empty_stream_summary", attempt });
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
    await traceMark("compaction.summary.received", { chatId, chars: summary.length, attempt, usedModel });
    const previous = await moo.pointers.get(chatRefs(chatId).compaction);
    const compactionHash = await moo.objects.putJSON({ kind: "agent:Compaction", value: {
        summary,
        throughAt: now,
        at: now,
        parent: previous ?? null,
        ...compactionTracking,
      } });
    await moo.pointers.set(chatRefs(chatId).compaction, compactionHash);
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
    await traceMark("compaction.persisted", { chatId, compactionHash, parent: previous ?? null });
    const postMessages = await buildLLMMessages(chatId);
    const postTokens = estimateTokens(postMessages, TOOLS);
    const budget = Number(input.tokenBudget) || await contextBudget();
    const threshold = Number(input.tokenThreshold) || await compactionThresholdForBudget(budget);
    await recordLastContextTokens(chatId, postTokens);
    moo.events.publish({
      kind: "tokens",
      chatId,
      used: postTokens,
      budget,
      threshold,
      fraction: budget > 0 ? postTokens / budget : 0,
      estimated: true,
      reset: true,
    });
    await traceMark("compaction.post_context", { chatId, postTokens, budget, threshold });
    return { ok: true, value: { kind: "iterate", messages: null } };
  }

  // purpose === "step"
  if (!llmResult.ok) {
    const retry = llmRetryDecisionFromSchedule(llmResult, attempt, await currentLlmRetryPolicy());
    await traceMark("llm.retry.decision", { chatId, attempt, retry: retry.retry, reason: retry.reason, delayMs: retry.delayMs, status: llmResult.status });
    if (retry.retry) {
      await traceMark("llm.retry.scheduled", { chatId, attempt, nextAttempt: attempt + 1, reason: retry.reason, delayMs: retry.delayMs });
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
    await traceMark("llm.provider_error.record", { chatId, attempt, status: llmResult.status, errorChars: (llmResult.errorBody || "").length });

    const parsed = parseProviderErrorBody(llmResult.errorBody);
    await recordErrorStep(
      chatId,
      "provider",
      {
        source: "provider",
        status: llmResult.status,
        attempts: attempt,
        retryReason: retry.reason,
        message: providerErrorMessage(parsed, Number(llmResult.status) || 0),
        type: providerErrorType(parsed),
        code: providerErrorCode(parsed),
        body: providerErrorBodyForRecord(parsed, llmResult.errorBody),
      },
      usedModel,
      input.requestEffort,
    );
    await setChatOngoing(chatId, false);
    await traceMark("llm.provider_error.done", { chatId, attempt, status: llmResult.status, usedModel });
    return { ok: true, value: { kind: "done" } };
  }

  if (!messages) messages = await traceSpan("llm.rebuild_messages", { chatId, reason: "missing_carried_messages" }, () => buildLLMMessages(chatId));

  if (Array.isArray(llmResult.toolCalls) && llmResult.toolCalls.length > 0) {
    await traceMark("llm.tool_calls", {
      chatId,
      count: llmResult.toolCalls.length,
      names: llmResult.toolCalls.map((tc: any) => tc?.function?.name ?? null),
    });
    // Persist any preamble text the model emitted alongside its tool calls so
    // the streaming "draft" bubble has a real Reply step to land into. Without
    // this the UI clears the draft on draft-end and the preamble vanishes.
    const preamble = (llmResult.content || "").trim();
    if (preamble) {
      await traceMark("llm.tool_preamble", { chatId, chars: preamble.length, usedModel });
      await reply(
        chatId,
        preamble,
        usedModel,
        input.requestEffort,
        Number.isFinite(thoughtDurationMs) ? thoughtDurationMs : null,
        draftId,
      );
    }
    messages.push({
      role: "assistant",
      content: llmResult.content || null,
      tool_calls: llmResult.toolCalls,
    });
    await traceMark("llm.assistant_tool_message", { chatId, messages: messages.length, contentChars: (llmResult.content || "").length, toolCalls: llmResult.toolCalls.length });
    return await stepContinueToolCallsCommand({
      chatId,
      state: { messages, thoughtDurationMs: input.thoughtDurationMs },
      toolCalls: llmResult.toolCalls,
      usedModel,
      requestEffort: input.requestEffort,
    });
  }

  const text = (llmResult.content || "").trim();
  await traceMark("llm.final_reply", { chatId, chars: text.length, usedModel, thoughtDurationMs: Number.isFinite(thoughtDurationMs) ? thoughtDurationMs : null });
  await reply(
    chatId,
    text || "(no response)",
    usedModel,
    input.requestEffort,
    Number.isFinite(thoughtDurationMs) ? thoughtDurationMs : null,
    draftId,
  );
  await setChatOngoing(chatId, false);
  await traceMark("llm.final_reply.done", { chatId, usedModel });
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

