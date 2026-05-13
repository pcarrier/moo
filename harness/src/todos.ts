import * as host from "./host_ops";
import { decodeJsonPointer, encodeJsonPointer } from "./lib";
import { appendStep } from "./steps";

export type TodoStatus = "todo" | "doing" | "done" | "blocked" | "dropped";
export type TodoIdInput = string | number;

export type TodoAddInput = { text: string; status?: TodoStatus; note?: string };
export type TodoUpdateInput = { id: TodoIdInput; text?: string; status?: TodoStatus; note?: string | null };
export type AgentTodoPatch = { id?: TodoIdInput; text?: string; status?: TodoStatus; note?: string | null };

export type AgentTodo = {
  id: string;
  text: string;
  status: TodoStatus;
  note?: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentTodoState = {
  version: 1;
  updatedAt: string;
  items: AgentTodo[];
};

export type TodoDiffChange =
  | { kind: "added"; after: AgentTodo }
  | { kind: "removed"; before: AgentTodo }
  | { kind: "updated"; before: AgentTodo; after: AgentTodo; fields: string[] };

export type TodoDiffSummary = {
  type: "todo-diff";
  id: string;
  step?: string;
  chatId: string;
  changes: TodoDiffChange[];
  todos: AgentTodo[];
  hash?: string;
  at: number;
};

export type TodoPatch = {
  items?: AgentTodoPatch[];
  add?: TodoAddInput[];
  update?: TodoUpdateInput[];
  clearDone?: boolean;
  clearStatuses?: TodoStatus[];
};

const VALID_STATUSES = new Set<TodoStatus>(["todo", "doing", "done", "blocked", "dropped"]);
const MAX_ITEMS = 50;
const MAX_TEXT = 160;

function pointerName(chatId: string): string {
  return `chat/${chatId}/todos`;
}

function visibleTodos(state: AgentTodoState): AgentTodo[] {
  return state.items.filter((item) => item.status !== "dropped");
}

function todoDiffChanges(before: AgentTodoState, after: AgentTodoState): TodoDiffChange[] {
  const beforeById = new Map(before.items.map((item) => [item.id, item]));
  const afterById = new Map(after.items.map((item) => [item.id, item]));
  const ids = [...new Set([...before.items.map((item) => item.id), ...after.items.map((item) => item.id)])];
  const changes: TodoDiffChange[] = [];
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

async function recordTodoDiff(chatId: string, before: AgentTodoState, after: AgentTodoState): Promise<void> {
  const changes = todoDiffChanges(before, after);
  if (!changes.length) return;
  const at = host.now();
  const todos = visibleTodos(after);
  const payload = { type: "todo-diff", chatId, changes, todos, at };
  const hash = host.putObject("agent:TodoDiff", JSON.stringify(payload));
  const { stepId } = await appendStep(chatId, {
    kind: "agent:TodoDiff",
    status: "agent:Done",
    payloadHash: hash,
    at,
  });
  host.broadcast(JSON.stringify({ kind: "todo-diff", chatId, changes, hash, stepId, at, todos }));
}

type TodoDiffBatch = { chatId: string; before: AgentTodoState | null; after: AgentTodoState | null };
const todoDiffBatches: TodoDiffBatch[] = [];

function currentTodoDiffBatch(chatId: string): TodoDiffBatch | null {
  for (let i = todoDiffBatches.length - 1; i >= 0; i--) {
    const batch = todoDiffBatches[i];
    if (batch?.chatId === chatId) return batch;
  }
  return null;
}

async function queueTodoDiff(chatId: string, before: AgentTodoState, after: AgentTodoState): Promise<void> {
  const batch = currentTodoDiffBatch(chatId);
  if (!batch) {
    await recordTodoDiff(chatId, before, after);
    return;
  }
  if (!batch.before) batch.before = before;
  batch.after = after;
}

export async function withTodoDiffBatch<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const batch: TodoDiffBatch = { chatId, before: null, after: null };
  todoDiffBatches.push(batch);
  try {
    return await fn();
  } finally {
    const index = todoDiffBatches.lastIndexOf(batch);
    if (index >= 0) todoDiffBatches.splice(index, 1);
    if (batch.before && batch.after) await recordTodoDiff(chatId, batch.before, batch.after);
  }
}

export function activeTodos(state: AgentTodoState): AgentTodo[] {
  return visibleTodos(state);
}

function nowIso(): string {
  return new Date(host.now()).toISOString();
}

function cleanText(value: unknown, field = "text", max = MAX_TEXT): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) throw new Error(`todo ${field} is required`);
  return text.length > max ? text.slice(0, max) : text;
}

function cleanOptionalText(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text || undefined;
}

function cleanStatus(value: unknown, fallback: TodoStatus = "todo"): TodoStatus {
  return typeof value === "string" && VALID_STATUSES.has(value as TodoStatus) ? value as TodoStatus : fallback;
}


function normalizeTodoId(value: unknown): string | null {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? id.slice(0, 40) : null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function nextTodoId(items: Array<{ id?: unknown }>, seen = new Set<string>()): string {
  let max = 0;
  for (const item of items) {
    const id = normalizeTodoId(item.id) ?? "";
    if (/^[1-9]\d*$/.test(id)) max = Math.max(max, Number(id));
  }
  let next = max + 1;
  while (seen.has(String(next))) next += 1;
  return String(next);
}

function normalizeState(value: unknown): AgentTodoState {
  const at = nowIso();
  const raw = value && typeof value === "object" ? value as any : {};
  const items = Array.isArray(raw.items) ? raw.items : [];
  const seen = new Set<string>();
  const out: AgentTodo[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const id = normalizeTodoId(item.id) ?? nextTodoId(out, seen);
    if (seen.has(id)) continue;
    let text: string;
    try { text = cleanText(item.text); } catch { continue; }
    const createdAt = typeof item.createdAt === "string" && item.createdAt ? item.createdAt : at;
    const updatedAt = typeof item.updatedAt === "string" && item.updatedAt ? item.updatedAt : createdAt;
    const todo: AgentTodo = { id, text, status: cleanStatus(item.status), createdAt, updatedAt };
    const note = cleanOptionalText(item.note);
    if (note) todo.note = note;
    seen.add(id);
    out.push(todo);
    if (out.length >= MAX_ITEMS) break;
  }
  return { version: 1, updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : at, items: out };
}

export async function getTodos(chatId: string): Promise<AgentTodoState> {
  const target = host.getRef(pointerName(chatId));
  return normalizeState(decodeJsonPointer(target));
}

async function writeTodos(chatId: string, state: AgentTodoState, before?: AgentTodoState): Promise<AgentTodoState> {
  const previous = before ?? await getTodos(chatId);
  const next = normalizeState({ ...state, updatedAt: nowIso() });
  host.setRef(pointerName(chatId), encodeJsonPointer(next));
  await queueTodoDiff(chatId, previous, next);
  return next;
}

function applyTodoUpdate(item: AgentTodo, patch: TodoUpdateInput | AgentTodoPatch, at: string): void {
  if (patch.text !== undefined) item.text = cleanText(patch.text);
  if (patch.status !== undefined) item.status = cleanStatus(patch.status, item.status);
  if (Object.prototype.hasOwnProperty.call(patch, "note")) {
    const note = cleanOptionalText(patch.note);
    if (note) item.note = note;
    else delete item.note;
  }
  item.updatedAt = at;
}

function appendTodo(items: AgentTodo[], add: TodoAddInput | AgentTodoPatch, at: string): void {
  if (items.length >= MAX_ITEMS) return;
  const item: AgentTodo = {
    id: nextTodoId(items),
    text: cleanText(add?.text),
    status: cleanStatus(add?.status),
    createdAt: at,
    updatedAt: at,
  };
  const note = cleanOptionalText(add?.note);
  if (note) item.note = note;
  items.push(item);
}

export async function patchTodos(chatId: string, patch: TodoPatch): Promise<AgentTodoState> {
  const state = await getTodos(chatId);
  const before = normalizeState(state);
  const at = nowIso();
  let items = state.items.slice();
  const clear = new Set<TodoStatus>(Array.isArray(patch.clearStatuses) ? patch.clearStatuses.filter((s) => VALID_STATUSES.has(s)) : []);
  if (patch.clearDone) clear.add("done");
  if (clear.size) items = items.filter((item) => !clear.has(item.status));
  if (Array.isArray(patch.update)) {
    for (const upd of patch.update) {
      const id = normalizeTodoId(upd?.id);
      if (!id) continue;
      const item = items.find((candidate) => candidate.id === id);
      if (!item) continue;
      applyTodoUpdate(item, upd, at);
    }
  }
  if (Array.isArray(patch.items)) {
    for (const entry of patch.items) {
      const id = normalizeTodoId(entry?.id);
      if (id) {
        const item = items.find((candidate) => candidate.id === id);
        if (item) applyTodoUpdate(item, entry, at);
        continue;
      }
      appendTodo(items, entry, at);
    }
  }
  if (Array.isArray(patch.add)) {
    for (const add of patch.add) appendTodo(items, add, at);
  }
  return await writeTodos(chatId, { version: 1, updatedAt: at, items }, before);
}

export async function addTodo(chatId: string, input: TodoAddInput): Promise<AgentTodo> {
  const before = await getTodos(chatId);
  const after = await patchTodos(chatId, { add: [input] });
  return after.items[before.items.length] ?? after.items[after.items.length - 1]!;
}

export async function updateTodo(chatId: string, input: TodoUpdateInput): Promise<AgentTodo> {
  const id = normalizeTodoId(input.id);
  const after = await patchTodos(chatId, { update: [input] });
  const item = id ? after.items.find((candidate) => candidate.id === id) : null;
  if (!item) throw new Error(`todo not found: ${String(input.id)}`);
  return item;
}

export async function clearTodos(chatId: string, input?: { statuses?: TodoStatus[] }): Promise<AgentTodoState> {
  if (Array.isArray(input?.statuses) && input.statuses.length) return await patchTodos(chatId, { clearStatuses: input.statuses });
  return await writeTodos(chatId, { version: 1, updatedAt: nowIso(), items: [] });
}

function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

export async function formatTodosForPrompt(chatId: string): Promise<string | null> {
  const state = await getTodos(chatId);
  const active = state.items.filter((item) => item.status !== "done" && item.status !== "dropped");
  if (!active.length) return null;
  const counts = new Map<TodoStatus, number>();
  for (const item of state.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  if (active.length > 8) {
    const parts: string[] = [];
    for (const status of ["doing", "todo", "blocked", "done", "dropped"] as TodoStatus[]) {
      const count = counts.get(status) ?? 0;
      if (count) parts.push(`${count} ${status}`);
    }
    return `${parts.join(", ")}. Use moo.todos.list() if needed.`;
  }
  const lines: string[] = [];
  for (const item of active) {
    const note = item.note ? ` — ${truncateText(item.note, 80)}` : "";
    lines.push(`- ${item.status} ${item.id}: ${truncateText(item.text, 90)}${note}`);
  }
  return lines.join("\n");
}
