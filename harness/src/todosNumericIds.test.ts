import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { addTodo, getTodos, patchTodos, updateTodo } from "./todos";

const todos = readFileSync(new URL("./todos.ts", import.meta.url), "utf8");

describe("agent TODO IDs", () => {
  test("allocates sequential numeric IDs instead of random prefixed IDs", () => {
    expect(todos).toContain("function nextTodoId");
    expect(todos).toContain("id: nextTodoId(items)");
    expect(todos).not.toContain('id: host.newId("todo")');
  });
});


describe("agent TODO diffs", () => {
  test("emits semantic TODO diffs without TODO.md compatibility payloads", () => {
    expect(todos).toContain('const changes = todoDiffChanges(before, after);');
    expect(todos).toContain('if (!changes.length) return;');
    expect(todos).toContain('const payload = { type: "todo-diff", chatId, changes, todos, at };');
    expect(todos).not.toContain('unifiedDiffWithStats');
    expect(todos).not.toContain('TODO.md');
    expect(todos).not.toContain('beforeText');
    expect(todos).not.toContain('afterText');
  });

  test("batches multiple TODO mutations in one RunJS step into one diff", () => {
    expect(todos).toContain("export async function withTodoDiffBatch");
    expect(todos).toContain("await queueTodoDiff(chatId, previous, next);");
    expect(todos).toContain("await recordTodoDiff(chatId, batch.before, batch.after);");
  });
});


describe("agent TODO ID coercion", () => {
  const refs = new Map<string, string>();
  const objects = new Map<string, { kind: string; content: string }>();
  let now = Date.UTC(2026, 0, 1);
  let idSeq = 0;
  let objectSeq = 0;

  (globalThis as any).__op_now = () => now++;
  (globalThis as any).__op_id = (prefix: string) => prefix + ":" + (++idSeq);
  (globalThis as any).__op_ref_get = (name: string) => refs.get(name) ?? null;
  (globalThis as any).__op_ref_set = (name: string, target: string) => { refs.set(name, target); };
  (globalThis as any).__op_object_put = (kind: string, content: string) => {
    const hash = "sha256:" + String(++objectSeq).padStart(64, "0");
    objects.set(hash, { kind, content });
    return hash;
  };
  (globalThis as any).__op_facts_swap = () => {};
  (globalThis as any).__op_broadcast = () => {};

  beforeEach(() => {
    refs.clear();
    objects.clear();
    now = Date.UTC(2026, 0, 1);
    idSeq = 0;
    objectSeq = 0;
  });

  test("updates string-stored IDs when callers pass numbers", async () => {
    const added = await addTodo("numeric-update", { text: "Upgrade packages" });
    expect(added.id).toBe("1");

    const updated = await updateTodo("numeric-update", {
      id: 1,
      status: "doing",
      note: "Packages are now published; upgrade and ship to main.",
    });

    expect(updated.id).toBe("1");
    expect(updated.status).toBe("doing");
    expect(updated.note).toBe("Packages are now published; upgrade and ship to main.");
  });

  test("patch update accepts numeric IDs", async () => {
    await addTodo("numeric-patch", { text: "First" });
    await addTodo("numeric-patch", { text: "Second" });

    const state = await patchTodos("numeric-patch", { update: [{ id: 2, status: "done" }] });

    expect(state.items.find((item) => item.id === "2")?.status).toBe("done");
  });

  test("patch items without IDs add todos with priorities", async () => {
    const state = await patchTodos("item-add", {
      items: [
        { text: "Add abstract to runtime spec", status: "doing", priority: "high" },
        { text: "Validate docs", status: "todo", priority: "normal" },
      ],
    });

    expect(state.items.map((item) => ({ id: item.id, text: item.text, status: item.status, priority: item.priority }))).toEqual([
      { id: "1", text: "Add abstract to runtime spec", status: "doing", priority: "high" },
      { id: "2", text: "Validate docs", status: "todo", priority: "normal" },
    ]);
  });

  test("patch items with IDs update existing todos and can reset priority", async () => {
    await patchTodos("item-update", { items: [{ text: "Draft", priority: "high" }] });

    const state = await patchTodos("item-update", {
      items: [{ id: 1, text: "Draft spec", status: "doing", priority: null, note: "Started" }],
    });

    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.text).toBe("Draft spec");
    expect(state.items[0]?.status).toBe("doing");
    expect(state.items[0]?.priority).toBe("normal");
    expect(state.items[0]?.note).toBe("Started");
  });

  test("normalizes numeric IDs loaded from storage without reallocating", async () => {
    refs.set(
      "chat/stored-number/todos",
      "json:" + JSON.stringify({
        version: 1,
        updatedAt: "earlier",
        items: [{ id: 2, text: "Stored", status: "todo", createdAt: "earlier", updatedAt: "earlier" }],
      }),
    );

    const state = await getTodos("stored-number");
    expect(state.items[0]?.id).toBe("2");

    const updated = await updateTodo("stored-number", { id: "2", status: "done" });
    expect(updated.id).toBe("2");
    expect(updated.status).toBe("done");
  });
});
