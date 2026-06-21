import * as host from "./host_ops";
import { decodeJsonPointer, encodeJsonPointer } from "./lib";
import { appendStep } from "./steps";

export type TaskValidationInput = string | (() => unknown);
export type TaskValidationResult = { ok: boolean; error?: string | null };
export type TaskValidationRunner = (chatId: string, source: string) => Promise<unknown>;

let taskValidationRunner: TaskValidationRunner | null = null;

export function setTaskValidationRunner(runner: TaskValidationRunner | null): void {
  taskValidationRunner = runner;
}

async function runTaskValidation(chatId: string, source: string): Promise<boolean> {
  if (!taskValidationRunner) throw new Error("task validation runner is not installed");
  const result = await taskValidationRunner(chatId, source);
  return result === undefined ? false : Boolean(result);
}

export async function checkTaskValidation(chatId: string, source: string): Promise<TaskValidationResult> {
  try {
    return { ok: await runTaskValidation(chatId, source), error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function cleanValidation(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "function") return value.toString();
  if (typeof value === "string") {
    const source = value.trim();
    return source || undefined;
  }
  return undefined;
}

export type TaskStatus = "todo" | "doing" | "done" | "blocked" | "dropped";
export type TaskIdInput = string | number;

export type TaskAddInput = { text: string; status?: TaskStatus; note?: string; validation?: TaskValidationInput | null };
export type TaskUpdateInput = { id: TaskIdInput; text?: string; status?: TaskStatus; note?: string | null; validation?: TaskValidationInput | null };
export type AgentTaskPatch = { id?: TaskIdInput; text?: string; status?: TaskStatus; note?: string | null; validation?: TaskValidationInput | null };

export type AgentTask = {
  id: string;
  text: string;
  status: TaskStatus;
  note?: string;
  validation?: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentTaskState = {
  version: 1;
  updatedAt: string;
  nextId: number;
  items: AgentTask[];
};

export type TaskDiffChange =
  | { kind: "added"; after: AgentTask }
  | { kind: "removed"; before: AgentTask }
  | { kind: "updated"; before: AgentTask; after: AgentTask; fields: string[] };

export type TaskDiffSummary = {
  type: "task-diff";
  id: string;
  step?: string;
  chatId: string;
  changes: TaskDiffChange[];
  tasks: AgentTask[];
  hash?: string;
  at: number;
};

export type TaskPatch = {
  items?: AgentTaskPatch[];
  add?: TaskAddInput[];
  update?: TaskUpdateInput[];
  clearDone?: boolean;
  clearStatuses?: TaskStatus[];
};

const VALID_STATUSES = new Set<TaskStatus>(["todo", "doing", "done", "blocked", "dropped"]);
const MAX_ITEMS = 50;
const MAX_TEXT = 160;
const FIRST_TASK_ID = 1;

function pointerName(chatId: string): string {
  return `chat/${chatId}/tasks`;
}

function visibleTasks(state: AgentTaskState): AgentTask[] {
  return state.items.filter((item) => item.status !== "dropped");
}

function taskDiffChanges(before: AgentTaskState, after: AgentTaskState): TaskDiffChange[] {
  const beforeById = new Map(before.items.map((item) => [item.id, item]));
  const afterById = new Map(after.items.map((item) => [item.id, item]));
  const ids = [...new Set([...before.items.map((item) => item.id), ...after.items.map((item) => item.id)])];
  const changes: TaskDiffChange[] = [];
  for (const id of ids) {
    const prev = beforeById.get(id);
    const next = afterById.get(id);
    if (!prev && next) {
      changes.push({ kind: "added", after: next });
      continue;
    }
    if (prev && !next) {
      changes.push({ kind: "removed", before: prev });
      continue;
    }
    if (!prev || !next) continue;
    const fields = (["text", "status", "note"] as const).filter((field) => (prev[field] || "") !== (next[field] || ""));
    if (fields.length) changes.push({ kind: "updated", before: prev, after: next, fields });
  }
  return changes;
}

async function recordTaskDiff(chatId: string, before: AgentTaskState, after: AgentTaskState): Promise<void> {
  const changes = taskDiffChanges(before, after);
  if (!changes.length) return;
  const at = host.now();
  const tasks = visibleTasks(after);
  const payload = { type: "task-diff", chatId, changes, tasks, at };
  const hash = host.putObject("agent:TaskDiff", JSON.stringify(payload));
  const { stepId } = await appendStep(chatId, {
    kind: "agent:TaskDiff",
    status: "agent:Done",
    payloadHash: hash,
    at,
  });
  host.broadcast(JSON.stringify({ kind: "task-diff", chatId, changes, hash, stepId, at, tasks }));
}

type TaskDiffBatch = { chatId: string; before: AgentTaskState | null; after: AgentTaskState | null };
const taskDiffBatches: TaskDiffBatch[] = [];

function currentTaskDiffBatch(chatId: string): TaskDiffBatch | null {
  for (let i = taskDiffBatches.length - 1; i >= 0; i--) {
    const batch = taskDiffBatches[i];
    if (batch?.chatId === chatId) return batch;
  }
  return null;
}

async function queueTaskDiff(chatId: string, before: AgentTaskState, after: AgentTaskState): Promise<void> {
  const batch = currentTaskDiffBatch(chatId);
  if (!batch) {
    await recordTaskDiff(chatId, before, after);
    return;
  }
  if (!batch.before) batch.before = before;
  batch.after = after;
}

export async function withTaskDiffBatch<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const batch: TaskDiffBatch = { chatId, before: null, after: null };
  taskDiffBatches.push(batch);
  try {
    return await fn();
  } finally {
    const index = taskDiffBatches.lastIndexOf(batch);
    if (index >= 0) taskDiffBatches.splice(index, 1);
    if (batch.before && batch.after) await recordTaskDiff(chatId, batch.before, batch.after);
  }
}

export function activeTasks(state: AgentTaskState): AgentTask[] {
  return visibleTasks(state);
}

function nowIso(): string {
  return new Date(host.now()).toISOString();
}

function cleanText(value: unknown, field = "text", max = MAX_TEXT): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) throw new Error(`task ${field} is required`);
  return text.length > max ? text.slice(0, max) : text;
}

function cleanOptionalText(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text || undefined;
}

function cleanStatus(value: unknown, fallback: TaskStatus = "todo"): TaskStatus {
  return typeof value === "string" && VALID_STATUSES.has(value as TaskStatus) ? value as TaskStatus : fallback;
}


function normalizeTaskId(value: unknown): string | null {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? id.slice(0, 40) : null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function numericTaskId(value: unknown): number | null {
  const id = normalizeTaskId(value);
  if (!id || !/^[1-9]\d*$/.test(id)) return null;
  const parsed = Number(id);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeNextTaskId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= FIRST_TASK_ID) return value;
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function nextTaskId(state: Pick<AgentTaskState, "items" | "nextId">, seen = new Set<string>()): string {
  let next = Math.max(FIRST_TASK_ID, state.nextId);
  while (seen.has(String(next)) || state.items.some((item) => item.id === String(next))) next += 1;
  if (!Number.isSafeInteger(next)) throw new Error("task ID limit reached");
  state.nextId = next + 1;
  return String(next);
}

function nextTaskIdAfter(items: Array<{ id?: unknown }>): number {
  let max = 0;
  for (const item of items) {
    const id = numericTaskId(item.id);
    if (id) max = Math.max(max, id);
  }
  return max + 1;
}

type StoredTaskItem = { readonly id?: unknown; readonly text?: unknown; readonly createdAt?: unknown; readonly updatedAt?: unknown; readonly status?: unknown; readonly note?: unknown; readonly validation?: unknown };

function normalizeState(value: unknown): AgentTaskState {
  const at = nowIso();
  const raw = value && typeof value === "object" ? value as { readonly items?: unknown; readonly updatedAt?: unknown; readonly nextId?: unknown } : {};
  const items = Array.isArray(raw.items) ? raw.items : [];
  const objectItems = items.filter((item): item is StoredTaskItem => !!item && typeof item === "object");
  const firstAvailableId = Math.max(FIRST_TASK_ID, nextTaskIdAfter(objectItems));
  const seen = new Set<string>();
  const out: AgentTask[] = [];
  const normalized: AgentTaskState = {
    version: 1,
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : at,
    nextId: Math.max(normalizeNextTaskId(raw.nextId) ?? firstAvailableId, firstAvailableId),
    items: out,
  };
  for (const item of objectItems) {
    const id = normalizeTaskId(item.id) ?? nextTaskId(normalized, seen);
    if (seen.has(id)) continue;
    let text: string;
    try { text = cleanText(item.text); } catch { continue; }
    const createdAt = typeof item.createdAt === "string" && item.createdAt ? item.createdAt : at;
    const updatedAt = typeof item.updatedAt === "string" && item.updatedAt ? item.updatedAt : createdAt;
    const task: AgentTask = { id, text, status: cleanStatus(item.status), createdAt, updatedAt };
    const note = cleanOptionalText(item.note);
    if (note) task.note = note;
    const validation = cleanValidation(item.validation);
    if (validation) task.validation = validation;
    seen.add(id);
    out.push(task);
    if (out.length >= MAX_ITEMS) break;
  }
  normalized.nextId = Math.max(normalized.nextId, nextTaskIdAfter(out));
  return normalized;
}

export async function getTasks(chatId: string): Promise<AgentTaskState> {
  const target = host.getRef(pointerName(chatId));
  return normalizeState(decodeJsonPointer(target));
}

async function writeTasks(chatId: string, state: AgentTaskState, before?: AgentTaskState): Promise<AgentTaskState> {
  const previous = before ?? await getTasks(chatId);
  const next = normalizeState({ ...state, updatedAt: nowIso() });
  host.setRef(pointerName(chatId), encodeJsonPointer(next));
  await queueTaskDiff(chatId, previous, next);
  return next;
}

function applyTaskUpdate(item: AgentTask, patch: TaskUpdateInput | AgentTaskPatch, at: string): void {
  if (patch.text !== undefined) item.text = cleanText(patch.text);
  if (patch.status !== undefined) item.status = cleanStatus(patch.status, item.status);
  if (Object.prototype.hasOwnProperty.call(patch, "note")) {
    const note = cleanOptionalText(patch.note);
    if (note) item.note = note;
    else delete item.note;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "validation")) {
    const validation = cleanValidation(patch.validation);
    if (validation) item.validation = validation;
    else delete item.validation;
  }
  item.updatedAt = at;
}

function appendTask(state: AgentTaskState, add: TaskAddInput | AgentTaskPatch, at: string): void {
  if (state.items.length >= MAX_ITEMS) return;
  const item: AgentTask = {
    id: nextTaskId(state),
    text: cleanText(add?.text),
    status: cleanStatus(add?.status),
    createdAt: at,
    updatedAt: at,
  };
  const note = cleanOptionalText(add?.note);
  if (note) item.note = note;
  const validation = cleanValidation(add?.validation);
  if (validation) item.validation = validation;
  state.items.push(item);
}

export async function patchTasks(chatId: string, patch: TaskPatch): Promise<AgentTaskState> {
  const state = await getTasks(chatId);
  const before = normalizeState(state);
  const at = nowIso();
  const next = normalizeState(state);
  next.updatedAt = at;
  let items = next.items;
  const clear = new Set<TaskStatus>(Array.isArray(patch.clearStatuses) ? patch.clearStatuses.filter((s) => VALID_STATUSES.has(s)) : []);
  if (patch.clearDone) clear.add("done");
  if (clear.size) {
    items = items.filter((item) => !clear.has(item.status));
    next.items = items;
  }
  if (Array.isArray(patch.update)) {
    for (const upd of patch.update) {
      const id = normalizeTaskId(upd?.id);
      if (!id) continue;
      const item = items.find((candidate) => candidate.id === id);
      if (!item) continue;
      applyTaskUpdate(item, upd, at);
    }
  }
  if (Array.isArray(patch.items)) {
    for (const entry of patch.items) {
      const id = normalizeTaskId(entry?.id);
      if (id) {
        const item = items.find((candidate) => candidate.id === id);
        if (item) applyTaskUpdate(item, entry, at);
        continue;
      }
      appendTask(next, entry, at);
    }
  }
  if (Array.isArray(patch.add)) {
    for (const add of patch.add) appendTask(next, add, at);
  }
  const beforeStatusById = new Map(before.items.map((item) => [item.id, item.status] as const));
  const validationFailures: string[] = [];
  for (const item of next.items) {
    if (item.status !== "done" || !item.validation) continue;
    if (beforeStatusById.get(item.id) === "done") continue;
    let passed = false;
    let error = "";
    try {
      passed = await runTaskValidation(chatId, item.validation);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (!passed) {
      const previous = beforeStatusById.get(item.id);
      item.status = previous && previous !== "done" ? previous : "doing";
      item.updatedAt = at;
      validationFailures.push(
        `task ${item.id} "${item.text}" cannot be marked done: validation ${error ? `errored: ${error}` : "did not pass"}`,
      );
    }
  }
  if (validationFailures.length) throw new Error(validationFailures.join("; "));
  return await writeTasks(chatId, next, before);
}


export async function addTask(chatId: string, input: TaskAddInput): Promise<AgentTask> {
  const before = await getTasks(chatId);
  const after = await patchTasks(chatId, { add: [input] });
  const task = after.items[before.items.length] ?? after.items.at(-1);
  if (!task) throw new Error("added task not found");
  return task;
}

export async function updateTask(chatId: string, input: TaskUpdateInput): Promise<AgentTask> {
  const id = normalizeTaskId(input.id);
  const after = await patchTasks(chatId, { update: [input] });
  const item = id ? after.items.find((candidate) => candidate.id === id) : null;
  if (!item) throw new Error(`task not found: ${String(input.id)}`);
  return item;
}

export async function setTaskValidation(chatId: string, input: { id: TaskIdInput; validation?: TaskValidationInput | null }): Promise<AgentTask> {
  return await updateTask(chatId, { id: input.id, validation: input.validation ?? null });
}

export async function validateTask(chatId: string, input: { id: TaskIdInput }): Promise<TaskValidationResult> {
  const id = normalizeTaskId(input.id);
  const state = await getTasks(chatId);
  const item = id ? state.items.find((candidate) => candidate.id === id) : null;
  if (!item) throw new Error(`task not found: ${String(input.id)}`);
  if (!item.validation) return { ok: false, error: "task has no validation" };
  return await checkTaskValidation(chatId, item.validation);
}

export async function clearTasks(chatId: string, input?: { statuses?: TaskStatus[] }): Promise<AgentTaskState> {
  if (Array.isArray(input?.statuses) && input.statuses.length) return await patchTasks(chatId, { clearStatuses: input.statuses });
  const before = await getTasks(chatId);
  return await writeTasks(chatId, { ...before, updatedAt: nowIso(), items: [] }, before);
}

export function outstandingTaskCount(state: AgentTaskState): number {
  return state.items.filter((item) => {
    if (item.status === "done" || item.status === "dropped") return false;
    if (item.status === "blocked" && String(item.note ?? "").trim()) return false;
    return true;
  }).length;
}


function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

export async function formatTasksForPrompt(chatId: string): Promise<string | null> {
  const state = await getTasks(chatId);
  const active = state.items.filter((item) => item.status !== "done" && item.status !== "dropped");
  if (!active.length) return null;
  const counts = new Map<TaskStatus, number>();
  for (const item of state.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  if (active.length > 8) {
    const parts: string[] = [];
    for (const status of ["doing", "todo", "blocked", "done", "dropped"] as TaskStatus[]) {
      const count = counts.get(status) ?? 0;
      if (count) parts.push(`${count} ${status}`);
    }
    return `${parts.join(", ")}. Use moo.tasks.list() if needed.`;
  }
  const lines: string[] = [];
  for (const item of active) {
    const note = item.note ? ` — ${truncateText(item.note, 80)}` : "";
    lines.push(`- ${item.status} ${item.id}: ${truncateText(item.text, 90)}${note}`);
  }
  return lines.join("\n");
}
