import { moo } from "../moo";
import type { StepKind } from "../types";
import { chatRefs, decodeJsonPointer, encodeJsonPointer } from "../lib";
import {
  appendStep,
  buildLLMMessages,
  buildCompactionMessages,
  latestUserInputAt,
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
  persistCompactionLayer,
  recordCompactionFailure,
  recordErrorStep,
  recordLastCompactionPromptTokens,
  recordLastContextTokens,
  recordUsage,
  effortLevelsForProvider,
  reply,
  normalizeEffort,
  normalizeUsage,
  tokenUsageEvent,
  tokenPressureEvent,
  llmStreamEventOptions,
  resolveProvider,
  llmBodyForTrace,
  messagesForTrace,
  messagesHaveImageAttachments,
  toolCallForTrace,
  traceMark,
  traceSpan,
  buildStreamingLLMRequest,
  stripDynamicContextMessages,
  compactionProviderForRequest,
  compactionRequestTokenLimit,
  fitCompactionSummaryMessages,
  runCompaction,
  TOOLS,
} from "../agent";
import type {
  DriverStateInput,
  Input,
  JsonValue,
  LlmMessageInput,
  LlmStreamResultInput,
  ProviderInput,
  ToolCallInput,
} from "./_shared";
import { buildCompactionSummaryPromptMessages } from "../prompt";
import {
  initialStepDriverState,
  planStepDriverEffects,
  reduceStepDriverState,
  stepNextInputEvents,
  type StepDriverState,
} from "../driver/step";
import { llmAttempt, llmRetryDecisionFromSchedule } from "../core/retry";
import { currentLlmRetryPolicy } from "./llm_auth";
import type { ProviderName } from "../llm_models";
import {
  defaultChatEffort,
  effortAllowedForModel,
  getChatEffort,
  getChatModel,
  getChatProvider,
  modelSupportsAttachments,
} from "./models";

type PendingAttachment = {
  type: "image";
  mimeType: string;
  dataUrl: string;
  name?: string;
};
type PendingMessage = {
  id: string;
  chatId: string;
  text: string;
  attachments?: PendingAttachment[];
};
type LlmMessage = LlmMessageInput;
const CHAT_PENDING_MESSAGES_REF = "chat/pending-messages";

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageArray(value: unknown): LlmMessage[] | null {
  return Array.isArray(value) ? value : null;
}

function sanitizePendingMessage(value: unknown): PendingMessage | null {
  const record = objectRecord(value);
  if (!record) return null;
  const chatId = String(record.chatId ?? "").trim();
  const text = String(record.text ?? "");
  const attachments = sanitizeAttachments(record.attachments);
  if (!chatId || (!text.trim() && attachments.length === 0)) return null;
  const id =
    String(record.id ?? "").trim() ||
    String(Date.now()) + "." + Math.random().toString(36).slice(2, 8);
  return { id, chatId, text, ...(attachments.length ? { attachments } : {}) };
}

async function readPendingMessages(): Promise<PendingMessage[]> {
  const target = await moo.pointers.get({ name: CHAT_PENDING_MESSAGES_REF });
  const decoded = target ? decodeJsonPointer(target) : null;
  if (!Array.isArray(decoded)) return [];
  return decoded
    .map(sanitizePendingMessage)
    .filter((m): m is PendingMessage => !!m);
}

async function writePendingMessages(messages: unknown[]) {
  const clean = messages
    .map(sanitizePendingMessage)
    .filter((m): m is PendingMessage => !!m);
  if (clean.length === 0)
    await moo.pointers.delete({ name: CHAT_PENDING_MESSAGES_REF });
  else
    await moo.pointers.set({
      name: CHAT_PENDING_MESSAGES_REF,
      target: encodeJsonPointer(clean),
    });
  return clean;
}

export async function pendingMessagesCommand(_input: Input) {
  return { ok: true, value: { messages: await readPendingMessages() } };
}

export async function pendingMessagesSaveCommand(input: Input) {
  const raw = Array.isArray(input.messages) ? input.messages : [];
  return { ok: true, value: { messages: await writePendingMessages(raw) } };
}

function parseProviderErrorBody(raw: unknown): unknown {
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

function asObject(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function providerErrorMessage(parsed: unknown, status: number): string {
  const p = asObject(parsed);
  const err = asObject(p.error);
  const detail = asObject(p.detail);
  const candidates = [
    err.message,
    typeof p.error === "string" ? p.error : "",
    p.message,
    detail.message,
    typeof p.detail === "string" ? p.detail : "",
    p.details,
    p.error_description,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim())
      return candidate.trim();
  }
  if (typeof parsed === "string" && parsed.trim() && parsed.trim() !== "error")
    return parsed.trim();
  if (status >= 400) return `request failed with HTTP ${status}`;
  if (status >= 200) return "provider stream returned an error";
  if (status > 0) return `request ended with HTTP ${status}`;
  return "LLM request failed before an HTTP response was received";
}

function providerErrorType(parsed: unknown): string | null {
  const p = asObject(parsed);
  const err = asObject(p.error);
  return stringField(err.type) || stringField(p.type);
}

function providerErrorCode(parsed: unknown): string | null {
  const p = asObject(parsed);
  const err = asObject(p.error);
  return stringField(err.code) || stringField(p.code);
}

function providerErrorRequestId(
  parsed: unknown,
  headers: unknown,
): string | null {
  const p = asObject(parsed);
  const err = asObject(p.error);
  return (
    firstHeader(
      headers,
      "request-id",
      "x-request-id",
      "anthropic-request-id",
      "cf-ray",
    ) ||
    stringField(p.request_id) ||
    stringField(p.requestId) ||
    stringField(err.request_id) ||
    stringField(err.requestId)
  );
}

function providerErrorRetryAfter(
  headers: unknown,
  parsed: unknown,
): string | null {
  const p = asObject(parsed);
  const err = asObject(p.error);
  return (
    firstHeader(
      headers,
      "retry-after",
      "x-ratelimit-reset",
      "anthropic-ratelimit-requests-reset",
    ) ||
    stringField(p.retry_after) ||
    stringField(p.retryAfter) ||
    stringField(err.retry_after) ||
    stringField(err.retryAfter)
  );
}

function providerErrorBodyForRecord(parsed: unknown, raw: unknown): unknown {
  if (parsed != null) return parsed;
  if (raw == null) return "";
  return raw;
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

function providerFailureReason(status: number): string {
  if (status >= 400) return `provider returned HTTP ${status}`;
  if (status >= 200) return "provider stream returned an error";
  if (status > 0) return `provider returned HTTP ${status}`;
  return "provider request failed before an HTTP response";
}

function providerErrorMatches(parsed: unknown, pattern: RegExp): boolean {
  const stack: unknown[] = [parsed];
  const seen = new Set<object>();
  while (stack.length) {
    const value = stack.pop();
    if (value == null) continue;
    if (typeof value === "string") {
      if (pattern.test(value)) return true;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      if (pattern.test(String(value))) return true;
      continue;
    }
    if (typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    for (const item of Object.values(value)) stack.push(item);
  }
  return false;
}

export function isContextLengthExceededError(parsed: unknown): boolean {
  return providerErrorMatches(
    parsed,
    /context[_ -]?length[_ -]?exceeded|exceeds?[^\n]{0,80}context window|context window[^\n]{0,80}exceeds?|maximum context|too many[^\n]{0,80}tokens/i,
  );
}

export type MissingAuthProvider = {
  name: string;
  keyEnvHint: string;
  model?: string | null;
  effort?: string | null;
  authMode?: string | null;
};

export function missingLlmAuthMessage(
  provider: Pick<MissingAuthProvider, "name" | "keyEnvHint">,
  action: "step" | "resume" = "step",
): string {
  const prefix = action === "resume" ? "Cannot resume this chat because " : "";
  return [
    prefix + "LLM authentication is not configured for " + provider.name + ".",
    "Open [Settings](/settings) to configure auth, or set `" +
      provider.keyEnvHint +
      "` before starting the server.",
  ].join("\n");
}

export function missingLlmAuthDetail(
  provider: MissingAuthProvider,
  action: "step" | "resume" = "step",
) {
  return {
    source: "authentication",
    provider: provider.name,
    authMode: provider.authMode ?? null,
    keyEnvHint: provider.keyEnvHint,
    message: missingLlmAuthMessage(provider, action),
    ...(provider.model ? { model: provider.model } : {}),
  };
}

async function recordMissingLlmAuthError(
  chatId: string,
  provider: MissingAuthProvider,
  action: "step" | "resume",
) {
  await recordErrorStep(
    chatId,
    "authentication",
    missingLlmAuthDetail(provider, action),
    provider.model,
    provider.effort,
  );
  await setChatOngoing(chatId, false);
}

type AttachmentSupportProvider = Pick<
  MissingAuthProvider,
  "model" | "effort"
> & { name: ProviderName };

function attachmentUnsupportedMessage(
  provider: AttachmentSupportProvider,
): string {
  const model = provider.model
    ? provider.name + " / " + provider.model
    : provider.name;
  return (
    model +
    " does not support image attachments. Switch to a vision-capable model or remove the images."
  );
}

function unsupportedAttachmentDetail(
  provider: AttachmentSupportProvider,
  attachmentCount: number,
) {
  return {
    source: "unsupported_attachments",
    provider: provider.name,
    model: provider.model ?? null,
    effort: provider.effort ?? null,
    attachments: attachmentCount,
    message: attachmentUnsupportedMessage(provider),
  };
}

function providerAcceptsAttachments(
  provider: AttachmentSupportProvider,
): boolean {
  return modelSupportsAttachments(provider.name, provider.model);
}

async function unsupportedAttachmentsForChat(
  chatId: string,
  attachmentCount: number,
) {
  if (attachmentCount === 0) return null;
  const selectedModel = await getChatModel(chatId);
  const selectedEffort = await getChatEffort(chatId);
  const selectedProvider = await getChatProvider(chatId);
  const provider = await resolveProvider(
    selectedModel,
    selectedEffort,
    selectedProvider,
  );
  return providerAcceptsAttachments(provider)
    ? null
    : unsupportedAttachmentDetail(provider, attachmentCount);
}

async function recordUnsupportedAttachments(
  chatId: string,
  provider: AttachmentSupportProvider,
  attachmentCount: number,
) {
  const detail = unsupportedAttachmentDetail(provider, attachmentCount);
  await recordErrorStep(
    chatId,
    "unsupported_attachments",
    detail,
    provider.model,
    provider.effort,
  );
  await setChatOngoing(chatId, false);
}

export async function stepCommand(input: Input) {
  const chatId = String(input.chatId || "demo").trim() || "demo";
  const message = String(input.message || "").trim();
  const attachments = sanitizeAttachments(input.attachments);
  if (!message && attachments.length === 0) {
    return {
      ok: false,
      error: { message: "step requires a message or attachment" },
    };
  }
  const unsupported = await unsupportedAttachmentsForChat(
    chatId,
    attachments.length,
  );
  if (unsupported) return { ok: false, error: unsupported };

  return {
    ok: true,
    value: {
      chatId,
      accepted: true,
      driver: stepDriverAction(chatId, "step", { message, attachments }),
    },
  };
}

export async function compactCommand(input: Input) {
  const chatId = String(input.chatId || "demo").trim() || "demo";
  return {
    ok: true,
    value: {
      chatId,
      accepted: true,
      driver: stepDriverAction(chatId, "compact", {}),
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
  const kind = (input.kind || "agent:Tick") as StepKind;
  const shellPayload = (
    value: unknown,
  ): { cmd?: unknown; args?: unknown; cwd?: unknown; stdin?: unknown } =>
    value != null && typeof value === "object"
      ? (value as {
          cmd?: unknown;
          args?: unknown;
          cwd?: unknown;
          stdin?: unknown;
        })
      : {};

  let payloadHash: string | null = null;
  if (kind === "agent:ShellCommand") {
    const p = shellPayload(input.payload) || shellPayload(input);
    if (typeof p.cmd !== "string" || !p.cmd) {
      return {
        ok: false,
        error: { message: "agent:ShellCommand requires payload.cmd" },
      };
    }
    payloadHash = await moo.objects.putJSON({
      kind,
      value: {
        cmd: p.cmd,
        args: Array.isArray(p.args) ? p.args : [],
        cwd: typeof p.cwd === "string" ? p.cwd : null,
        stdin: typeof p.stdin === "string" ? p.stdin : null,
      },
    });
  } else if (input.payload != null) {
    payloadHash = await moo.objects.putJSON({
      kind: kind,
      value: input.payload,
    });
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
  const runId = await moo.pointers.get({ name: c.run });

  const claim = await moo.agent.claim({
    store: c.facts,
    graph: c.graph,
    runId: runId,
    leaseMs: input.leaseMs ?? 60_000,
  });
  if (!claim) {
    return {
      ok: true,
      value: { chatId, ran: false, reason: "no queued step" },
    };
  }

  const { stepId, leaseId } = claim;
  const kindRows = await moo.facts.match({
    store: c.facts,
    ...{
      graph: c.graph,
      subject: stepId,
      predicate: "agent:kind",
      limit: 1,
    },
  });
  const kind = kindRows[0]?.[3];

  let result: Awaited<ReturnType<typeof moo.proc.run>> | null = null;
  let resultHash: string | null = null;
  let status: "agent:Done" | "agent:Failed" = "agent:Done";
  let errorMessage: string | null = null;

  try {
    if (kind === "agent:ShellCommand") {
      const payloadObj = await loadPayloadJSON(c.facts, c.graph, stepId);
      if (!payloadObj) throw new Error("ShellCommand step has no payload");
      const { cmd, args, cwd, stdin } = payloadObj.value;
      const wt = cwd ?? (await moo.chat.scratch({ chatId: chatId }));
      result = await moo.proc.run({
        cmd: cmd,
        args: args || [],
        ...{ cwd: wt, stdin },
      });
      resultHash = await moo.objects.putJSON({
        kind: "agent:ToolResult",
        value: { kind, cmd, args, cwd: wt, ...result },
      });
      if (result.code !== 0 || result.timedOut) status = "agent:Failed";
    } else if (kind === "agent:Tick") {
      // no-op
    } else {
      throw new Error(`unsupported step kind: ${kind}`);
    }
  } catch (err: unknown) {
    status = "agent:Failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    moo.log({ args: ["tick error:", errorMessage] });
  }

  await moo.facts.update({
    store: c.facts,
    fn: (txn) => {
      if (resultHash)
        txn.add({
          graph: c.graph,
          subject: stepId,
          predicate: "agent:result",
          object: resultHash,
        });
      if (result)
        txn.add({
          graph: c.graph,
          subject: stepId,
          predicate: "agent:exitCode",
          object: String(result.code),
        });
      if (errorMessage)
        txn.add({
          graph: c.graph,
          subject: stepId,
          predicate: "agent:error",
          object: errorMessage,
        });
      if (leaseId)
        txn.remove({
          graph: c.graph,
          subject: stepId,
          predicate: "agent:lease",
          object: leaseId,
        });
    },
  });
  await moo.agent.complete({
    store: c.facts,
    graph: c.graph,
    stepId: stepId,
    status: status,
  });

  return {
    ok: true,
    value: {
      chatId,
      ran: true,
      stepId,
      kind,
      status,
      exitCode: result?.code ?? null,
    },
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

  const statusRows = await moo.facts.match({
    store: c.facts,
    ...{
      graph: c.graph,
      subject: requestId,
      predicate: "ui:status",
      limit: 1,
    },
  });
  if (!statusRows.length) {
    return { ok: false, error: { message: "request not found" } };
  }
  const currentStatus = statusRows[0]![3];
  if (currentStatus !== "ui:Pending") {
    return {
      ok: false,
      error: { message: `request already ${currentStatus}` },
    };
  }

  const kindRows = await moo.facts.match({
    store: c.facts,
    ...{
      graph: c.graph,
      subject: requestId,
      predicate: "ui:kind",
      limit: 1,
    },
  });
  const kind = kindRows[0]?.[3] || null;

  const respondedAt = await moo.time.nowMs({});
  const respPayload = await moo.objects.putJSON({
    kind: "ui:Response",
    value: {
      values,
      at: respondedAt,
      ...(cancelled ? { cancelled: true } : {}),
    },
  });
  const respId = await moo.id.new({ prefix: "uires" });

  await moo.facts.update({
    store: c.facts,
    fn: (txn) => {
      txn.add({
        graph: c.graph,
        subject: respId,
        predicate: "rdf:type",
        object: "ui:InputResponse",
      });
      txn.add({
        graph: c.graph,
        subject: respId,
        predicate: "ui:respondsTo",
        object: requestId,
      });
      txn.add({
        graph: c.graph,
        subject: respId,
        predicate: "ui:payload",
        object: respPayload,
      });
      txn.add({
        graph: c.graph,
        subject: respId,
        predicate: "ui:createdAt",
        object: respondedAt,
      });
      txn.remove({
        graph: c.graph,
        subject: requestId,
        predicate: "ui:status",
        object: "ui:Pending",
      });
      txn.add({
        graph: c.graph,
        subject: requestId,
        predicate: "ui:status",
        object: cancelled ? "ui:Cancelled" : "ui:Done",
      });
    },
  });

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

export function sanitizeAttachments(value: unknown): PendingAttachment[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(objectRecord)
    .filter(
      (a): a is Record<string, unknown> =>
        !!a &&
        a.type === "image" &&
        typeof a.dataUrl === "string" &&
        a.dataUrl.startsWith("data:image/"),
    )
    .slice(0, 8)
    .map((a) => ({
      type: "image" as const,
      mimeType: typeof a.mimeType === "string" ? a.mimeType : "image/png",
      dataUrl: String(a.dataUrl),
      ...(typeof a.name === "string" ? { name: a.name } : {}),
    }));
}

export function chatOngoingRef(chatId: string): string {
  return `chat/${chatId}/ongoing`;
}

export async function setChatOngoing(chatId: string, ongoing: boolean) {
  if (ongoing)
    await moo.pointers.set({
      name: chatOngoingRef(chatId),
      target: String(await moo.time.nowMs({})),
    });
  else await moo.pointers.delete({ name: chatOngoingRef(chatId) });
}

export async function cancelChatInFlightSteps(
  chatId: string,
  reason = "interrupted",
) {
  const c = chatRefs(chatId);
  const rows = await moo.facts.matchAll({
    patterns: [
      ["?step", "rdf:type", "agent:Step"],
      ["?step", "agent:status", "?status"],
    ],
    ...{ store: c.facts, graph: c.graph },
  });
  const steps = new Set<string>();
  const removes: Array<[string, string, string, string]> = [];
  for (const row of rows) {
    const step = row["?step"];
    const status = row["?status"];
    if (!step || (status !== "agent:Running" && status !== "agent:Queued"))
      continue;
    steps.add(step);
    removes.push([c.graph, step, "agent:status", status]);
  }
  if (steps.size === 0) return { cancelled: 0 };

  const now = String(await moo.time.nowMs({}));
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

export function stepLifecycleEvents(chatId: string, compacting = false) {
  return {
    start: compacting
      ? { kind: "step-start", chatId, compacting: true }
      : { kind: "step-start", chatId },
    end: { kind: "step-end", chatId },
  };
}

export function stepDriverAction(
  chatId: string,
  mode: "step" | "resume" | "compact",
  extra: Record<string, JsonValue | undefined> = {},
) {
  const lifecycleEvents = stepLifecycleEvents(chatId, mode === "compact");
  return {
    action: "drive",
    chatId,
    state: { chatId, mode, ...extra, lifecycleEvents },
    lifecycleEvents,
  };
}

export async function compactPreludeCommand(input: Input) {
  const chatId = input.chatId || "demo";

  await moo.chat.unarchive({ chatId: chatId });
  const selectedModel = await getChatModel(chatId);
  const selectedEffort = await getChatEffort(chatId);
  const selectedProvider = await getChatProvider(chatId);
  const provider = await resolveProvider(
    selectedModel,
    selectedEffort,
    selectedProvider,
  );
  if (!provider.apiKey) {
    await reply(chatId, `cannot compact: ${provider.keyEnvHint} not set`);
    await setChatOngoing(chatId, false);
    return { ok: true, value: { kind: "done" } };
  }

  await setChatOngoing(chatId, true);
  const draftId = await moo.id.new({ prefix: "draft" });
  await traceMark("compaction.draft.created", {
    chatId,
    draftId,
    trigger: "manual",
  });
  const result = await runCompaction(chatId, provider, {
    trigger: "manual",
    draftId,
  });
  moo.events.publish({ payload: { kind: "draft-end", chatId, draftId } });
  if (result === "compacted") {
    moo.events.publish({ payload: { kind: "compaction-end", chatId } });
    return { ok: true, value: { kind: "loop", provider, mode: "resume" } };
  }

  await reply(
    chatId,
    result === "empty"
      ? "nothing to compact yet"
      : "compaction failed; see the error above",
  );
  await setChatOngoing(chatId, false);
  return { ok: true, value: { kind: "done" } };
}

export async function stepPreludeCommand(input: Input) {
  const chatId = input.chatId || "demo";
  const message = String(input.message ?? "").trim();
  const attachments = sanitizeAttachments(input.attachments);
  if (!message && attachments.length === 0) {
    return {
      ok: false,
      error: { message: "step requires a message or attachment" },
    };
  }

  // A new user turn makes the chat active again, regardless of whether it
  // was hidden in the archived section before the user sent the message.
  await moo.chat.unarchive({ chatId: chatId });

  const artificial = input.artificial === true;
  const payloadHash = await moo.objects.putJSON({
    kind: "agent:UserInput",
    value: {
      message,
      at: await moo.time.nowMs({}),
      ...(attachments.length ? { attachments } : {}),
      ...(artificial ? { artificial: true } : {}),
    },
  });
  await appendStep(chatId, {
    kind: "agent:UserInput",
    status: "agent:Done",
    payloadHash,
    ...(artificial ? { extras: [["agent:artificial", "true"]] } : {}),
  });

  const selectedModel = await getChatModel(chatId);
  const selectedEffort = await getChatEffort(chatId);
  const selectedProvider = await getChatProvider(chatId);
  const provider = await resolveProvider(
    selectedModel,
    selectedEffort,
    selectedProvider,
  );
  if (attachments.length && !providerAcceptsAttachments(provider)) {
    await recordUnsupportedAttachments(chatId, provider, attachments.length);
    return { ok: true, value: { kind: "done" } };
  }
  if (!provider.apiKey) {
    await recordMissingLlmAuthError(chatId, provider, "step");
    return { ok: true, value: { kind: "done" } };
  }

  await setChatOngoing(chatId, true);
  return { ok: true, value: { kind: "loop", provider } };
}

export async function stepResumeCommand(input: Input) {
  const chatId = String(input.chatId ?? "").trim();
  if (!chatId)
    return { ok: false, error: { message: "step-resume requires chatId" } };

  if (await hasPendingInput(chatId)) {
    await setChatOngoing(chatId, false);
    return { ok: true, value: { kind: "done" } };
  }

  const selectedModel = await getChatModel(chatId);
  const selectedEffort = await getChatEffort(chatId);
  const selectedProvider = await getChatProvider(chatId);
  const provider = await resolveProvider(
    selectedModel,
    selectedEffort,
    selectedProvider,
  );
  if (!provider.apiKey) {
    await recordMissingLlmAuthError(chatId, provider, "resume");
    return { ok: true, value: { kind: "done" } };
  }

  await setChatOngoing(chatId, true);
  return { ok: true, value: { kind: "loop", provider } };
}

type CommandResultValue =
  | StepDriverState
  | {
      kind?: string;
      state?: DriverStateInput;
      toolCall?: ToolCallInput | null;
      model?: string | null;
      messages?: LlmMessage[];
      provider?: ProviderInput;
      retryAttempt?: number;
      retryReason?: string;
      retryDelayMs?: number;
      forceCompact?: boolean;
      [key: string]: unknown;
    };
type RawCommandResultValue = Omit<CommandResultValue, "messages"> & {
  messages?: LlmMessage[] | null;
};
type CommandResultEnvelope = {
  ok?: boolean;
  value?: RawCommandResultValue | null;
  error?: { message?: string };
};

export async function commandValue(
  result: CommandResultEnvelope,
): Promise<CommandResultValue> {
  if (!result || result.ok !== true) {
    const msg = result?.error?.message || "driver step command failed";
    throw new Error(msg);
  }
  const value = result.value ?? {};
  if (value.messages === null) {
    const { messages: _messages, ...rest } = value;
    return rest;
  }
  return value as CommandResultValue;
}

export async function stepNextCommand(input: Input) {
  let state = initialStepDriverState(input);
  const chatId = state.chatId;
  if (!chatId)
    return { ok: false, error: { message: "step-next requires state.chatId" } };

  for (const event of stepNextInputEvents(input, state)) {
    await traceMark("driver.event", {
      chatId,
      type: event.type,
      beforePhase: state.phase ?? null,
      hadMessages: Array.isArray(state.messages),
      pendingToolCalls: Array.isArray(state.pendingToolCalls)
        ? state.pendingToolCalls.length
        : 0,
    });
    state = reduceStepDriverState(state, event);
    await traceMark("driver.state", {
      chatId,
      afterEvent: event.type,
      phase: state.phase ?? null,
      messages: Array.isArray(state.messages) ? state.messages.length : null,
      pendingToolCalls: Array.isArray(state.pendingToolCalls)
        ? state.pendingToolCalls.length
        : 0,
      llmAttempts: (state as Record<string, unknown>).llmAttempts ?? null,
    });
  }

  while (true) {
    const [effect] = planStepDriverEffects(state);
    if (!effect) return { ok: true, value: { kind: "done" } };

    await traceMark("driver.effect", {
      chatId,
      type: effect.type,
      phase: state.phase ?? null,
      pendingToolCalls: Array.isArray(state.pendingToolCalls)
        ? state.pendingToolCalls.length
        : 0,
      llmAttempts: (state as Record<string, unknown>).llmAttempts ?? null,
      hasMessages: Array.isArray(state.messages),
    });

    if (effect.type === "Return") {
      const retVal = effect.value as Record<string, unknown> | null | undefined;
      await traceMark("driver.return", {
        chatId,
        kind: retVal?.kind ?? null,
        hasState: !!retVal?.state,
        hasToolCall: !!retVal?.toolCall,
      });
      return { ok: true, value: effect.value };
    }

    if (effect.type === "ContinueToolCalls") {
      const handled = await traceSpan(
        "driver.continue_tools",
        {
          chatId,
          pendingToolCalls: Array.isArray(effect.input.toolCalls)
            ? effect.input.toolCalls.length
            : 0,
        },
        async () =>
          commandValue(
            await stepContinueToolCallsCommand(
              effect.input as unknown as Input,
            ),
          ),
      );
      state = reduceStepDriverState(state, {
        type: "ToolContinuationHandled",
        handled,
      });
      continue;
    }

    if (effect.type === "HandleLlm") {
      const handled = await traceSpan(
        "driver.handle_llm",
        {
          chatId,
          purpose: effect.input.purpose ?? null,
          attempt: effect.input.attempt ?? null,
          ok:
            (effect.input.llmResult as Record<string, unknown> | null)?.ok ??
            null,
          status:
            (effect.input.llmResult as Record<string, unknown> | null)
              ?.status ?? null,
        },
        async () =>
          commandValue(
            await stepHandleLlmCommand(effect.input as unknown as Input),
          ),
      );
      state = reduceStepDriverState(state, { type: "LlmHandled", handled });
      continue;
    }

    if (effect.type === "Start") {
      const startInput = effect.input;
      const started = await traceSpan(
        "driver.start",
        {
          chatId,
          mode: effect.mode,
          hasMessage:
            typeof startInput.message === "string" &&
            startInput.message.length > 0,
          attachments: Array.isArray(startInput.attachments)
            ? startInput.attachments.length
            : 0,
        },
        async () =>
          commandValue(
            effect.mode === "resume"
              ? await stepResumeCommand(effect.input as unknown as Input)
              : startInput.mode === "compact"
                ? await compactPreludeCommand(effect.input as unknown as Input)
                : await stepPreludeCommand(effect.input as unknown as Input),
          ),
      );
      state = reduceStepDriverState(state, { type: "Started", started });
      continue;
    }

    if (effect.type === "Prepare") {
      const prepared = await traceSpan(
        "driver.prepare_llm",
        {
          chatId,
          hasCarriedMessages: Array.isArray(effect.input.messages),
          provider:
            (effect.input.provider as Record<string, unknown> | null)?.name ??
            null,
          model:
            (effect.input.provider as Record<string, unknown> | null)?.model ??
            null,
        },
        async () =>
          commandValue(
            await stepPrepareCommand(effect.input as unknown as Input),
          ),
      );
      state = reduceStepDriverState(state, { type: "Prepared", prepared });
      continue;
    }

    return { ok: true, value: { kind: "done" } };
  }
}
export async function stepContinueToolCallsCommand(input: Input) {
  const state =
    input.state != null &&
    typeof input.state === "object" &&
    !Array.isArray(input.state)
      ? (input.state as DriverStateInput)
      : {};
  const chatId = String(input.chatId ?? "").trim();
  const messages = Array.isArray(state.messages) ? state.messages : [];
  const toolCalls: ToolCallInput[] = Array.isArray(input.toolCalls)
    ? input.toolCalls
    : [];
  const usedModel = input.usedModel ?? null;
  const requestEffort = input.requestEffort ?? state.requestEffort ?? null;
  await traceMark("tool.batch.start", {
    chatId,
    count: toolCalls.length,
    carriedMessages: messages.length,
    usedModel,
    requestEffort,
  });
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    await traceMark("tool.call.queued", {
      chatId,
      index: i,
      ...toolCallForTrace(tc),
    });
    if (tc?.function?.name === "runTS") {
      await traceMark("tool.runts.deferred", {
        chatId,
        index: i,
        remainingToolCalls: toolCalls.length - i - 1,
        ...toolCallForTrace(tc),
      });
      return {
        ok: true,
        value: {
          kind: "tool-ts",
          state: {
            ...state,
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
    const exec = await traceSpan(
      "tool.execute",
      { chatId, usedModel, requestEffort, ...toolCallForTrace(tc) },
      () => executeToolCall(chatId, tc, usedModel, requestEffort),
    );
    await traceMark("tool.result.ready", {
      chatId,
      index: i,
      toolCallId: tc.id ?? null,
      result: exec,
    });
    messages.push({
      role: "tool",
      tool_call_id: tc.id,
      content: exec.toolText,
    });
  }
  if (await hasPendingInput(chatId)) {
    await traceMark("tool.batch.wait_input", {
      chatId,
      messages: messages.length,
    });
    await setChatOngoing(chatId, false);
    return { ok: true, value: { kind: "wait-input" } };
  }
  await traceMark("tool.batch.complete", { chatId, messages: messages.length });
  return { ok: true, value: { kind: "iterate", messages } };
}

export async function runTsToolCommand(input: Input) {
  const state =
    input.state != null &&
    typeof input.state === "object" &&
    !Array.isArray(input.state)
      ? (input.state as {
          chatId?: string;
          requestEffort?: string | null;
          usedModel?: string | null;
        })
      : {};
  const chatId = String(input.chatId ?? state.chatId ?? "").trim();
  if (!chatId)
    return { ok: false, error: { message: "run-ts-tool requires chatId" } };
  try {
    const requestEffort =
      input.effort ?? input.requestEffort ?? state.requestEffort ?? null;
    const exec = await runToolCall(
      chatId,
      input.toolCall,
      input.model ?? state.usedModel ?? null,
      requestEffort,
    );
    return {
      ok: true,
      value: {
        toolCallId: input.toolCall?.id,
        content: exec.toolText,
        status: "done",
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
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
  if (!chatId)
    return { ok: false, error: { message: "subagent-final requires chatId" } };
  const c = chatRefs(chatId);
  const rows = await moo.facts.matchAll({
    patterns: [
      ["?step", "agent:kind", "agent:Reply"],
      ["?step", "agent:createdAt", "?at"],
    ],
    ...{ store: c.facts, graph: c.graph },
  });
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
  if (!chatId)
    return { ok: false, error: { message: "interrupt requires chatId" } };

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
    const marked = await moo.pointers.get({ name: chatOngoingRef(c.chatId) });
    const staleInflightStatus =
      c.status === "agent:Running" || c.status === "agent:Queued";
    if (!marked) {
      // Only the durable ongoing marker means a chat is crash-recoverable.
      // Status-only Running/Queued rows can be leftovers from an interrupted
      // tool call (for example RunTS aborted before it could write Done).
      // Treat them as stale instead of relaunching the LLM after restart.
      if (staleInflightStatus) {
        await cancelChatInFlightSteps(
          c.chatId,
          "cleared stale in-flight status during startup",
        );
        clearedStale.push(c.chatId);
      }
      continue;
    }

    // A crash/restart can happen after a tool created a ui:InputRequest but
    // before the driver reached its wait-input cleanup path. In that case the
    // stale ongoing marker must not relaunch the chat; the user's submit is the
    // correct resume point.
    if (c.status === "ui:Pending" || (await hasPendingInput(c.chatId))) {
      if (marked) await setChatOngoing(c.chatId, false);
      skippedPending.push(c.chatId);
      continue;
    }

    // Any step left Running/Queued was interrupted by the crash — its V8
    // execution is gone. Cancel before resuming so the UI doesn't keep a
    // spinner on the orphaned runTS step.
    await cancelChatInFlightSteps(c.chatId, "interrupted by server restart");
    chatIds.push(c.chatId);
  }
  return {
    ok: true,
    value: {
      chatIds,
      skippedPending,
      clearedStale,
      driverActions: chatIds.map((chatId) =>
        stepDriverAction(chatId, "resume"),
      ),
    },
  };
}

export function tokenPressureFromEstimates(
  compactionPromptTokens: number,
  requestPromptTokens: number,
): {
  used: number;
  source: "context" | "compaction";
} {
  const compaction = Math.max(
    0,
    Math.floor(Number(compactionPromptTokens) || 0),
  );
  const request = Math.max(0, Math.floor(Number(requestPromptTokens) || 0));
  return {
    used: Math.max(compaction, request),
    source: request > compaction ? "context" : "compaction",
  };
}

export async function stepPrepareCommand(input: Input) {
  const chatId = input.chatId || "demo";
  const provider = input.provider;
  if (!provider)
    return { ok: false, error: { message: "step-prepare requires provider" } };
  const passedMessages = messageArray(input.messages);
  await traceMark("llm.prepare.start", {
    chatId,
    provider: provider?.name ?? null,
    baseModel: provider?.model ?? null,
    carriedMessages: passedMessages?.length ?? null,
  });
  const selectedProvider = await getChatProvider(chatId);
  const selectedModel = await getChatModel(chatId);
  const selectedEffort = await getChatEffort(chatId);
  if (selectedModel) provider.model = selectedModel;
  if (selectedProvider) provider.name = selectedProvider;
  const efforts = effortLevelsForProvider(provider);
  if (efforts.length) {
    const defaultEffort = await defaultChatEffort();
    provider.effort =
      effortAllowedForModel(efforts, selectedEffort) ||
      effortAllowedForModel(efforts, defaultEffort);
  } else {
    provider.effort = null;
  }
  await traceMark("llm.provider.selected", {
    chatId,
    provider: provider?.name ?? null,
    model: provider?.model ?? null,
    effort: provider?.effort ?? null,
    selectedModel: selectedModel ?? null,
    selectedEffort: selectedEffort ?? null,
    supportedEfforts: efforts,
  });
  // First iteration (no carried-over messages): build from DB and check
  // compaction. Subsequent iterations carry the in-progress message array
  // through the driver — the assistant + tool entries from the previous
  // round must persist across the LLM call.
  let messages: LlmMessage[];
  let estimatedPromptTokens = 0;
  let budget = await contextBudget(provider);
  if (passedMessages == null) {
    messages = await traceSpan("llm.build_messages", { chatId }, () =>
      buildLLMMessages(chatId),
    );
    await traceMark("llm.messages.ready", {
      chatId,
      source: "chat",
      ...messagesForTrace(messages, TOOLS),
    });
    if (
      messagesHaveImageAttachments(messages) &&
      !providerAcceptsAttachments(provider)
    ) {
      await traceMark("llm.attachments.unsupported", {
        chatId,
        provider: provider.name,
        model: provider.model,
      });
      await recordUnsupportedAttachments(chatId, provider, 1);
      return { ok: true, value: { kind: "done" } };
    }
    const compactionPromptTokens = await traceSpan(
      "compaction.estimate",
      { chatId, messages: messages.length },
      () => estimateCompactionPromptTokens(chatId, messages),
    );
    const requestPromptTokens = estimateTokens(messages, TOOLS);
    const pressure = tokenPressureFromEstimates(
      compactionPromptTokens,
      requestPromptTokens,
    );
    estimatedPromptTokens = pressure.used;
    const threshold = await compactionThresholdForBudget(budget);
    await recordLastCompactionPromptTokens(chatId, estimatedPromptTokens);
    moo.events.publish({
      payload: tokenPressureEvent(chatId, estimatedPromptTokens, {
        budget,
        threshold,
        source: pressure.source,
        estimated: true,
      }),
    });
    await traceMark("compaction.pressure.recorded", {
      chatId,
      estimatedPromptTokens,
      compactionPromptTokens,
      requestPromptTokens,
      tokenBudget: budget,
      tokenThreshold: threshold,
    });
    const forceCompact = input.forceCompact === true;
    const shouldCompact = forceCompact || estimatedPromptTokens >= threshold;
    await traceMark("compaction.check", {
      chatId,
      estimatedPromptTokens,
      compactionPromptTokens,
      requestPromptTokens,
      tokenBudget: budget,
      tokenThreshold: threshold,
      forceCompact,
      shouldCompact,
    });
    if (shouldCompact) {
      await traceMark("compaction.triggered", {
        chatId,
        estimatedPromptTokens,
        compactionPromptTokens,
        requestPromptTokens,
        tokenBudget: budget,
        tokenThreshold: threshold,
        forceCompact,
      });
      const compactionMessages = await traceSpan(
        "compaction.build_messages",
        { chatId },
        () => buildCompactionMessages(chatId),
      );
      moo.events.publish({ payload: { kind: "compaction-start", chatId } });
      const rawSummaryMessages =
        buildCompactionSummaryPromptMessages(compactionMessages);
      const requestTokenLimit = compactionRequestTokenLimit(budget, threshold);
      const summaryMessages = fitCompactionSummaryMessages(
        rawSummaryMessages,
        requestTokenLimit,
      );
      const summaryRequestPromptTokens = estimateTokens(summaryMessages);
      const compactionProvider = compactionProviderForRequest(provider);
      const draftId = await moo.id.new({ prefix: "draft" });
      await traceMark("compaction.draft.created", {
        chatId,
        draftId,
        trigger: "automatic",
        forceCompact,
      });
      const request = buildStreamingLLMRequest(
        compactionProvider,
        summaryMessages,
        null,
      );
      await traceMark("llm.request.prepared", {
        chatId,
        purpose: "compact",
        provider: compactionProvider.name,
        model: request.requestModel,
        effort: request.requestEffort,
        url: request.url,
        responsesApi: request.responsesApi,
        estimatedPromptTokens,
        requestPromptTokens: summaryRequestPromptTokens,
        requestTokenLimit,
        tokenBudget: budget,
        tokenThreshold: threshold,
        truncatedForRequest:
          summaryRequestPromptTokens < estimateTokens(rawSummaryMessages),
        ...messagesForTrace(summaryMessages, null),
        request: llmBodyForTrace(request.body),
      });
      return {
        ok: true,
        value: {
          kind: "llm",
          purpose: "compact",
          ...request,
          countThoughtDuration: false,
          headers: request.headers,
          draftId,
          // After compaction, the next prepare call rebuilds from DB.
          messages: null,
          estimatedPromptTokens,
          tokenBudget: budget,
          tokenThreshold: threshold,
          requestPromptTokens: summaryRequestPromptTokens,
          requestTokenLimit,
          requestProvider: compactionProvider.name,
          streamEvents: llmStreamEventOptions(
            chatId,
            draftId,
            {
              estimatedPromptTokens,
              tokenBudget: budget,
              tokenThreshold: threshold,
              provider: compactionProvider.name,
              model: request.requestModel,
              effort: request.requestEffort,
              source: "compaction",
              estimated: true,
            },
            { draftKind: "compaction-draft" },
          ),
        },
      };
    }
  } else {
    messages = stripDynamicContextMessages(passedMessages);
    if (
      messagesHaveImageAttachments(messages) &&
      !providerAcceptsAttachments(provider)
    ) {
      await traceMark("llm.attachments.unsupported", {
        chatId,
        provider: provider.name,
        model: provider.model,
      });
      await recordUnsupportedAttachments(chatId, provider, 1);
      return { ok: true, value: { kind: "done" } };
    }
    estimatedPromptTokens = estimateTokens(messages, TOOLS);
    await traceMark("llm.messages.ready", {
      chatId,
      source: "carried",
      ...messagesForTrace(messages, TOOLS),
    });
    const threshold = await compactionThresholdForBudget(budget);
    moo.events.publish({
      payload: tokenPressureEvent(chatId, estimatedPromptTokens, {
        budget,
        threshold,
        source: "context",
        estimated: true,
      }),
    });
    await traceMark("compaction.carried_check", {
      chatId,
      estimatedPromptTokens,
      tokenBudget: budget,
      tokenThreshold: threshold,
      shouldCompact: estimatedPromptTokens >= threshold,
    });
    if (estimatedPromptTokens >= threshold) {
      await traceMark("compaction.carried_triggered", {
        chatId,
        estimatedPromptTokens,
        tokenBudget: budget,
        tokenThreshold: threshold,
      });
      return { ok: true, value: { kind: "iterate", messages: null } };
    }
  }

  const threshold = await compactionThresholdForBudget(budget);
  const draftId = await moo.id.new({ prefix: "draft" });
  await traceMark("llm.draft.created", { chatId, draftId });
  const request = buildStreamingLLMRequest(provider, messages, TOOLS);
  await traceMark("llm.request.prepared", {
    chatId,
    purpose: "step",
    ...messagesForTrace(messages, TOOLS),
    provider: provider.name,
    model: request.requestModel,
    effort: request.requestEffort,
    url: request.url,
    responsesApi: request.responsesApi,
    estimatedPromptTokens,
    tokenBudget: budget,
    tokenThreshold: threshold,
    request: llmBodyForTrace(request.body),
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
        provider: provider.name,
        model: request.requestModel,
        effort: request.requestEffort,
        source: passedMessages == null ? "compaction" : "context",
        estimated: true,
      }),
    },
  };
}

export async function stepHandleLlmCommand(input: Input) {
  const chatId = input.chatId || "demo";
  const attempt = llmAttempt(input);
  const purpose = input.purpose as "step" | "compact";
  const llmResult = input.llmResult as LlmStreamResultInput;
  const draftId = String(input.draftId ?? "");
  const thoughtDurationNs = Number(input.thoughtDurationNs);
  let messages = messageArray(input.messages);

  if (draftId)
    moo.events.publish({ payload: { kind: "draft-end", chatId, draftId } });
  await traceMark("llm.result.received", {
    chatId,
    purpose,
    attempt,
    ok: llmResult.ok,
    status: llmResult.status,
    model: llmResult.model,
    usage: llmResult.usage,
    content: llmResult.content || "",
    toolCalls: Array.isArray(llmResult.toolCalls) ? llmResult.toolCalls : [],
    errorBody: llmResult.errorBody || null,
  });

  // The model that actually served the request. Provider may echo back a
  // pinned variant (e.g. `gpt-5.5-2026-01`), so prefer that over the model
  // we requested.
  const usedModel =
    (typeof llmResult.model === "string" && llmResult.model) ||
    (typeof input.requestModel === "string" && input.requestModel) ||
    null;

  const partialToolCallsText =
    Array.isArray(llmResult.toolCalls) && llmResult.toolCalls.length > 0
      ? JSON.stringify(llmResult.toolCalls)
      : "";
  const partialOutputText = llmResult.content || partialToolCallsText;
  const hasPartialBillableOutput = Boolean(partialOutputText);
  const normalizedUsage =
    normalizeUsage(llmResult.usage) ??
    (llmResult.ok || hasPartialBillableOutput
      ? estimateRawUsage(
          messages,
          partialOutputText,
          Number(input.estimatedPromptTokens) || 0,
        )
      : null);
  await traceMark("usage.normalized", {
    chatId,
    purpose,
    hasProviderUsage: !!llmResult.usage,
    estimated: !llmResult.usage && !!normalizedUsage,
    hasPartialBillableOutput,
    usage: normalizedUsage,
  });
  if (normalizedUsage && purpose !== "compact") {
    const requestProvider =
      input.requestProvider === "anthropic" ||
      input.requestProvider === "qwen" ||
      input.requestProvider === "xai" ||
      input.requestProvider === "deepseek"
        ? input.requestProvider
        : "openai";
    const requestAuthMode =
      input.requestAuthMode === "env" ||
      input.requestAuthMode === "apiKey" ||
      input.requestAuthMode === "oauth"
        ? input.requestAuthMode
        : undefined;
    const tokenEvent = await tokenUsageEvent(
      chatId,
      normalizedUsage,
      usedModel
        ? { name: requestProvider, model: usedModel, authMode: requestAuthMode }
        : null,
    );
    if (tokenEvent) moo.events.publish({ payload: tokenEvent });
    await recordUsage(chatId, usedModel, normalizedUsage);
    await traceMark("usage.persisted", {
      chatId,
      purpose,
      updateLastContextTokens: true,
      model: usedModel,
    });
  } else if (normalizedUsage) {
    await recordUsage(chatId, usedModel, normalizedUsage, {
      updateLastContextTokens: false,
    });
    await traceMark("usage.persisted", {
      chatId,
      purpose,
      updateLastContextTokens: false,
      model: usedModel,
    });
  }

  if (purpose === "compact") {
    if (!llmResult.ok) {
      const status = Number(llmResult.status) || 0;
      const parsed = parseProviderErrorBody(llmResult.errorBody);
      const reason = providerFailureReason(status);
      const message = providerErrorMessage(parsed, status);
      const type = providerErrorType(parsed);
      const requestId = providerErrorRequestId(parsed, llmResult.headers);
      const retryAfter = providerErrorRetryAfter(llmResult.headers, parsed);
      const hint = null;
      await traceMark("compaction.failed", {
        chatId,
        reason,
        status,
        attempt,
        errorBody: llmResult.errorBody || null,
        requestId,
        retryAfter,
        hint,
      });
      await recordCompactionFailure(chatId, reason, {
        trigger: "automatic",
        promptTokens: Number(input.estimatedPromptTokens) || null,
        tokenBudget: Number(input.tokenBudget) || null,
        tokenThreshold: Number(input.tokenThreshold) || null,
        requestPromptTokens: Number(input.requestPromptTokens) || null,
        requestTokenLimit: Number(input.requestTokenLimit) || null,
        status,
        message,
        type,
        code: providerErrorCode(parsed),
        requestId,
        retryAfter,
        hint,
        body: providerErrorBodyForRecord(parsed, llmResult.errorBody),
        provider: input.requestProvider || null,
        model: usedModel,
        effort: input.requestEffort || null,
        draftId: draftId || null,
      });
      await setChatOngoing(chatId, false);
      moo.events.publish({ payload: { kind: "compaction-end", chatId } });
      // Don't iterate — the next prepare would see token-pressure still
      // over threshold and try to compact again forever.
      return { ok: true, value: { kind: "done" } };
    }
    const summary = (llmResult.content || "").trim();
    if (!summary) {
      await traceMark("compaction.failed", {
        chatId,
        reason: "empty_stream_summary",
        attempt,
      });
      await recordCompactionFailure(
        chatId,
        "provider returned an empty summary",
        {
          trigger: "automatic",
          promptTokens: Number(input.estimatedPromptTokens) || null,
          tokenBudget: Number(input.tokenBudget) || null,
          tokenThreshold: Number(input.tokenThreshold) || null,
          requestPromptTokens: Number(input.requestPromptTokens) || null,
          requestTokenLimit: Number(input.requestTokenLimit) || null,
          draftId: draftId || null,
        },
      );
      await setChatOngoing(chatId, false);
      moo.events.publish({ payload: { kind: "compaction-end", chatId } });
      return { ok: true, value: { kind: "done" } };
    }
    const compactionTracking = {
      trigger: "automatic",
      promptTokens: Number(input.estimatedPromptTokens) || null,
      tokenBudget: Number(input.tokenBudget) || null,
      tokenThreshold: Number(input.tokenThreshold) || null,
      requestPromptTokens: Number(input.requestPromptTokens) || null,
      requestTokenLimit: Number(input.requestTokenLimit) || null,
      draftId: draftId || null,
    };
    const now = await moo.time.nowMs({});
    const lastUserAt = await latestUserInputAt(chatId);
    const throughAt = lastUserAt > 0 ? Math.max(0, lastUserAt - 1) : now;
    await traceMark("compaction.summary.received", {
      chatId,
      chars: summary.length,
      attempt,
      usedModel,
      throughAt,
      lastUserAt,
    });
    const compactionHash = await persistCompactionLayer(chatId, {
      summary,
      throughAt,
      at: now,
      ...compactionTracking,
    });
    await appendStep(chatId, {
      kind: "agent:Compaction",
      status: "agent:Done",
      payloadHash: compactionHash,
      extras: [
        ...stepLlmExtras(usedModel, input.requestEffort),
        ["agent:trigger", "agent:Automatic"],
        ...(compactionTracking.promptTokens != null
          ? [
              [
                "agent:promptTokens",
                String(compactionTracking.promptTokens),
              ] as [string, string],
            ]
          : []),
        ...(compactionTracking.tokenBudget != null
          ? [
              ["agent:tokenBudget", String(compactionTracking.tokenBudget)] as [
                string,
                string,
              ],
            ]
          : []),
        ...(compactionTracking.tokenThreshold != null
          ? [
              [
                "agent:tokenThreshold",
                String(compactionTracking.tokenThreshold),
              ] as [string, string],
            ]
          : []),
      ],
    });
    await traceMark("compaction.persisted", { chatId, compactionHash });
    const postMessages = await buildLLMMessages(chatId);
    const postContextTokens = estimateTokens(postMessages, TOOLS);
    const postPressureTokens = await estimateCompactionPromptTokens(
      chatId,
      postMessages,
    );
    const budget = Number(input.tokenBudget) || (await contextBudget());
    const threshold =
      Number(input.tokenThreshold) ||
      (await compactionThresholdForBudget(budget));
    await recordLastContextTokens(chatId, postContextTokens, {
      compactionPromptTokens: postPressureTokens,
    });
    moo.events.publish({
      payload: tokenPressureEvent(chatId, postPressureTokens, {
        budget,
        threshold,
        source: "compaction",
        estimated: true,
        reset: true,
      }),
    });
    await traceMark("compaction.post_context", {
      chatId,
      postContextTokens,
      postPressureTokens,
      budget,
      threshold,
    });
    moo.events.publish({ payload: { kind: "compaction-end", chatId } });
    return { ok: true, value: { kind: "iterate", messages: null } };
  }

  // purpose === "step"
  if (!llmResult.ok) {
    const retry = llmRetryDecisionFromSchedule(
      llmResult,
      attempt,
      await currentLlmRetryPolicy(),
    );
    await traceMark("llm.retry.decision", {
      chatId,
      attempt,
      retry: retry.retry,
      reason: retry.reason,
      delayMs: retry.delayMs,
      status: llmResult.status,
    });
    const contextLengthParsed = parseProviderErrorBody(llmResult.errorBody);
    if (
      !input.forceCompact &&
      isContextLengthExceededError(contextLengthParsed)
    ) {
      const status = Number(llmResult.status) || 0;
      await traceMark("compaction.context_length_retry", {
        chatId,
        attempt,
        status,
        estimatedPromptTokens: Number(input.estimatedPromptTokens) || null,
        tokenBudget: Number(input.tokenBudget) || null,
        tokenThreshold: Number(input.tokenThreshold) || null,
        code: providerErrorCode(contextLengthParsed),
        type: providerErrorType(contextLengthParsed),
        requestId: providerErrorRequestId(
          contextLengthParsed,
          llmResult.headers,
        ),
      });
      return {
        ok: true,
        value: {
          kind: "iterate",
          messages: null,
          retryAttempt: attempt + 1,
          retryReason: "context-length-compaction",
          forceCompact: true,
        },
      };
    }
    if (retry.retry) {
      await traceMark("llm.retry.scheduled", {
        chatId,
        attempt,
        nextAttempt: attempt + 1,
        reason: retry.reason,
        delayMs: retry.delayMs,
      });
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
    await traceMark("llm.provider_error.record", {
      chatId,
      attempt,
      status: llmResult.status,
      errorBody: llmResult.errorBody || null,
    });

    const parsed = parseProviderErrorBody(llmResult.errorBody);
    const status = Number(llmResult.status) || 0;
    const type = providerErrorType(parsed);
    const requestId = providerErrorRequestId(parsed, llmResult.headers);
    const retryAfter = providerErrorRetryAfter(llmResult.headers, parsed);
    const hint = null;
    await recordErrorStep(
      chatId,
      "provider",
      {
        source: "provider",
        status: llmResult.status,
        attempts: attempt,
        retryReason: retry.reason,
        message: providerErrorMessage(parsed, status),
        type,
        code: providerErrorCode(parsed),
        requestId,
        retryAfter,
        hint,
        body: providerErrorBodyForRecord(parsed, llmResult.errorBody),
      },
      usedModel,
      input.requestEffort,
    );
    await setChatOngoing(chatId, false);
    await traceMark("llm.provider_error.done", {
      chatId,
      attempt,
      status: llmResult.status,
      usedModel,
    });
    return { ok: true, value: { kind: "done" } };
  }

  if (!messages)
    messages = await traceSpan(
      "llm.rebuild_messages",
      { chatId, reason: "missing_carried_messages" },
      () => buildLLMMessages(chatId),
    );

  if (Array.isArray(llmResult.toolCalls) && llmResult.toolCalls.length > 0) {
    await traceMark("llm.tool_calls", {
      chatId,
      count: llmResult.toolCalls.length,
      toolCalls: llmResult.toolCalls,
      names: llmResult.toolCalls.map((tc) => tc.function?.name ?? null),
    });
    // Persist any preamble text or streamed reasoning the model emitted alongside
    // its tool calls so the streaming draft bubble has a real Reply step to land
    // into. Without this the UI clears the draft on draft-end and the content or
    // thinking block vanishes.
    const preamble = (llmResult.content || "").trim();
    const reasoningContent = llmResult.reasoningContent ?? "";
    if (preamble || reasoningContent.trim()) {
      await traceMark("llm.tool_preamble", {
        chatId,
        preamble,
        hasReasoningContent: !!reasoningContent.trim(),
        usedModel,
      });
      await reply(
        chatId,
        preamble,
        usedModel,
        input.requestEffort,
        Number.isFinite(thoughtDurationNs) ? thoughtDurationNs : null,
        draftId,
        reasoningContent,
      );
    }
    messages.push({
      role: "assistant",
      content: llmResult.content || null,
      ...(llmResult.reasoningContent
        ? { reasoning_content: llmResult.reasoningContent }
        : {}),
      tool_calls: llmResult.toolCalls,
    });
    await traceMark("llm.assistant_tool_message", {
      chatId,
      messages: messages.length,
      content: llmResult.content || "",
      toolCalls: llmResult.toolCalls,
    });
    return await stepContinueToolCallsCommand({
      chatId,
      state: { messages, thoughtDurationNs: input.thoughtDurationNs },
      toolCalls: llmResult.toolCalls,
      usedModel,
      requestEffort: input.requestEffort,
    });
  }

  const text = (llmResult.content || "").trim();
  const stopReason =
    typeof llmResult.stopReason === "string" ? llmResult.stopReason : null;
  const reasoningContent = llmResult.reasoningContent ?? "";
  const thinkingBlocks = Array.isArray(llmResult.anthropicThinkingBlocks)
    ? llmResult.anthropicThinkingBlocks
    : [];
  await traceMark("llm.final_reply", {
    chatId,
    chars: text.length,
    usedModel,
    stopReason,
    hasReasoningContent: !!reasoningContent.trim(),
    thinkingBlocks: thinkingBlocks.length,
    thoughtDurationNs: Number.isFinite(thoughtDurationNs)
      ? thoughtDurationNs
      : null,
  });

  // Anthropic's interleaved-thinking turns can pause mid-turn (`pause_turn`).
  // The protocol requires us to feed the assistant message - including the
  // signed thinking blocks - back and continue. Treating that as a terminal
  // empty reply is what produced the old "(no response)" placeholder.
  if (stopReason === "pause_turn") {
    await traceMark("llm.pause_turn", {
      chatId,
      chars: text.length,
      thinkingBlocks: thinkingBlocks.length,
      usedModel,
    });
    if (text || reasoningContent.trim()) {
      await reply(
        chatId,
        text,
        usedModel,
        input.requestEffort,
        Number.isFinite(thoughtDurationNs) ? thoughtDurationNs : null,
        draftId,
        reasoningContent || null,
      );
    }
    const assistantMessage: {
      role: string;
      content: unknown;
      reasoning_content?: string;
      anthropic_thinking_blocks?: unknown[];
    } = {
      role: "assistant",
      content: llmResult.content || null,
    };
    if (reasoningContent) assistantMessage.reasoning_content = reasoningContent;
    if (thinkingBlocks.length)
      assistantMessage.anthropic_thinking_blocks = thinkingBlocks;
    messages.push(assistantMessage);
    return { ok: true, value: { kind: "iterate", messages } };
  }

  if (!text) {
    // The model produced no visible text and no tool calls. Don't fabricate a
    // `(no response)` Reply step - record a real error so the UI shows what
    // happened and the agent loop stops cleanly.
    await traceMark("llm.empty_completion", {
      chatId,
      stopReason,
      hasReasoningContent: !!reasoningContent.trim(),
      thinkingBlocks: thinkingBlocks.length,
      usedModel,
    });
    await recordErrorStep(
      chatId,
      "empty_completion",
      {
        source: "empty_completion",
        stopReason,
        hasReasoningContent: !!reasoningContent.trim(),
        thinkingBlocks: thinkingBlocks.length,
        message:
          stopReason === "max_tokens"
            ? "Model response was truncated before any text was emitted (stop_reason=max_tokens)."
            : "Model returned no text content" +
              (stopReason ? ` (stop_reason=${stopReason})` : "") +
              ".",
      },
      usedModel,
      input.requestEffort,
    );
    await setChatOngoing(chatId, false);
    await traceMark("llm.empty_completion.done", {
      chatId,
      stopReason,
      usedModel,
    });
    return { ok: true, value: { kind: "done" } };
  }

  await reply(
    chatId,
    text,
    usedModel,
    input.requestEffort,
    Number.isFinite(thoughtDurationNs) ? thoughtDurationNs : null,
    draftId,
    reasoningContent || null,
  );
  const postReplyMessages = await traceSpan(
    "compaction.post_reply_estimate",
    { chatId },
    () => buildLLMMessages(chatId),
  );
  const postReplyPressureTokens = await traceSpan(
    "compaction.post_reply_pressure",
    { chatId, messages: postReplyMessages.length },
    () => estimateCompactionPromptTokens(chatId, postReplyMessages),
  );
  await recordLastCompactionPromptTokens(chatId, postReplyPressureTokens);
  const pressureBudget = Number(input.tokenBudget) || (await contextBudget());
  const pressureThreshold =
    Number(input.tokenThreshold) ||
    (await compactionThresholdForBudget(pressureBudget));
  moo.events.publish({
    payload: tokenPressureEvent(chatId, postReplyPressureTokens, {
      budget: pressureBudget,
      threshold: pressureThreshold,
      source: "compaction",
      estimated: true,
    }),
  });
  await traceMark("compaction.post_reply_pressure.recorded", {
    chatId,
    postReplyPressureTokens,
    budget: pressureBudget,
    threshold: pressureThreshold,
  });
  await setChatOngoing(chatId, false);
  await traceMark("llm.final_reply.done", { chatId, usedModel });
  return { ok: true, value: { kind: "done" } };
}

export function stepLlmExtras(
  model: string | null | undefined,
  effort: unknown,
): Array<[string, string]> {
  const extras: Array<[string, string]> = [];
  const m = String(model ?? "").trim();
  const e = normalizeEffort(effort);
  if (m) extras.push(["agent:model", m]);
  if (e) extras.push(["agent:effort", e]);
  return extras;
}
