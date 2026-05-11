import { moo } from "../moo";
import type { WorkflowRunStatus } from "../types";
import type { Input } from "./_shared";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || "unknown error");
}

function clean(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function workflowId(input: Input): string {
  return clean(input.id ?? input.workflowId ?? input.name);
}

function runId(input: Input): string {
  return clean(input.runId ?? input.id);
}

function status(input: Input): WorkflowRunStatus | undefined {
  const raw = clean(input.status);
  return raw ? raw as WorkflowRunStatus : undefined;
}

export async function workflowListCommand(_input: Input) {
  try {
    return { ok: true, value: { workflows: await moo.workflows.list() } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function workflowSaveCommand(input: Input) {
  const definition = input.definition ?? input.workflow;
  if (!definition || typeof definition !== "object") return { ok: false, error: { message: "workflow-save requires definition" } };
  try {
    return { ok: true, value: { workflow: await moo.workflows.save({ definition: definition as any, source: input.source, current: input.current !== false }) } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function workflowInspectCommand(input: Input) {
  const id = workflowId(input);
  if (!id) return { ok: false, error: { message: "workflow-inspect requires id" } };
  try {
    return { ok: true, value: { workflow: await moo.workflows.inspect(id) } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function workflowRunsCommand(input: Input) {
  try {
    return { ok: true, value: { runs: await moo.workflows.runs({ ...(status(input) ? { status: status(input) } : {}), ...(workflowId(input) ? { workflowId: workflowId(input) } : {}), ...(clean(input.chatId) ? { chatId: clean(input.chatId) } : {}) }) } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function workflowWaitingCommand(input: Input) {
  try {
    return { ok: true, value: { runs: await moo.workflows.waiting({ ...(clean(input.chatId) ? { chatId: clean(input.chatId) } : {}) }) } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function workflowRunCommand(input: Input) {
  const id = workflowId(input);
  if (!id) return { ok: false, error: { message: "workflow-run requires id" } };
  try {
    return { ok: true, value: { run: await moo.workflows.start(id, { input: input.input ?? {}, state: input.state, chatId: clean(input.chatId) || null, autoResume: input.autoResume !== false }) } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function workflowResumeCommand(input: Input) {
  const id = runId(input);
  if (!id) return { ok: false, error: { message: "workflow-resume requires runId" } };
  try {
    return { ok: true, value: { run: await moo.workflows.resume(id) } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function workflowInspectRunCommand(input: Input) {
  const id = runId(input);
  if (!id) return { ok: false, error: { message: "workflow-inspect-run requires runId" } };
  try {
    return { ok: true, value: { run: await moo.workflows.inspectRun(id) } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function workflowSubmitCommand(input: Input) {
  const id = runId(input);
  const stepPath = clean(input.stepPath ?? input.step);
  if (!id || !stepPath) return { ok: false, error: { message: "workflow-submit requires runId and stepPath" } };
  try {
    return { ok: true, value: { run: await moo.workflows.submit(id, stepPath, input.value ?? input.values ?? {}) } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function workflowCancelCommand(input: Input) {
  const id = runId(input);
  if (!id) return { ok: false, error: { message: "workflow-cancel requires runId" } };
  try {
    return { ok: true, value: { run: await moo.workflows.cancel(id, clean(input.reason) || undefined) } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function workflowRetryCommand(input: Input) {
  const id = runId(input);
  if (!id) return { ok: false, error: { message: "workflow-retry requires runId" } };
  try {
    return { ok: true, value: { run: await moo.workflows.retry(id, { from: clean(input.from) || null, resume: input.resume !== false }) } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function workflowForkCommand(input: Input) {
  const id = runId(input);
  if (!id) return { ok: false, error: { message: "workflow-fork requires runId" } };
  try {
    return { ok: true, value: { run: await moo.workflows.fork(id, { from: clean(input.from) || null, input: input.input, state: input.state, autoResume: input.autoResume === true }) } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function workflowLinkChatCommand(input: Input) {
  const id = runId(input);
  const chatId = clean(input.chatId);
  if (!id || !chatId) return { ok: false, error: { message: "workflow-link-chat requires runId and chatId" } };
  try {
    return { ok: true, value: { run: await moo.workflows.linkChat(id, chatId) } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function workflowUnlinkChatCommand(input: Input) {
  const id = runId(input);
  const chatId = clean(input.chatId);
  if (!id || !chatId) return { ok: false, error: { message: "workflow-unlink-chat requires runId and chatId" } };
  try {
    return { ok: true, value: { run: await moo.workflows.unlinkChat(id, chatId) } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}

export async function workflowMermaidCommand(input: Input) {
  const id = runId(input);
  if (!id) return { ok: false, error: { message: "workflow-mermaid requires runId" } };
  try {
    return { ok: true, value: { mermaid: await moo.workflows.renderMermaid(id) } };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err) } };
  }
}
