import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { addTask, clearTasks, getTasks, outstandingTaskCount, patchTasks, setTaskValidation, setTaskValidationRunner, updateTask, validateTask } from "./tasks";

const tasks = readFileSync(new URL("./tasks.ts", import.meta.url), "utf8");

describe("agent task IDs", () => {
  test("allocates sequential numeric IDs instead of random prefixed IDs", () => {
    expect(tasks).toContain("function nextTaskId");
    expect(tasks).toContain("id: nextTaskId(state)");
    expect(tasks).not.toContain('id: host.newId("todo")');
  });
});


describe("agent task diffs", () => {
  test("emits semantic task diffs without task.md compatibility payloads", () => {
    expect(tasks).toContain('const changes = taskDiffChanges(before, after);');
    expect(tasks).toContain('if (!changes.length) return;');
    expect(tasks).toContain('const payload = { type: "task-diff", chatId, changes, tasks, at };');
    expect(tasks).not.toContain('unifiedDiffWithStats');
    expect(tasks).not.toContain('TASK.md');
    expect(tasks).not.toContain('beforeText');
    expect(tasks).not.toContain('afterText');
  });

  test("batches multiple task mutations in one RunTS step into one diff", () => {
    expect(tasks).toContain("export async function withTaskDiffBatch");
    expect(tasks).toContain("await queueTaskDiff(chatId, previous, next);");
    expect(tasks).toContain("await recordTaskDiff(chatId, batch.before, batch.after);");
  });
});


describe("agent task ID coercion", () => {
  const refs = new Map<string, string>();
  const objects = new Map<string, { kind: string; content: string }>();
  let now = Date.UTC(2026, 0, 1);
  let idSeq = 0;
  let objectSeq = 0;

  (globalThis as any).__op_now = () => now++;
  (globalThis as any).__op_id = (prefix: string) => prefix + ":" + (++idSeq);
  (globalThis as any).__op_ref_get = (name: string) => refs.get(name) ?? null;
  (globalThis as any).__op_ref_set = (name: string, target: string) => { refs.set(name, target); };
  (globalThis as any).__op_ref_cas = (name: string, expected: string | null, next: string) => { const __cur = refs.has(name) ? refs.get(name) : null; if (__cur !== (expected ?? null)) return false; refs.set(name, next); return true; };
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
    const added = await addTask("numeric-update", { text: "Upgrade packages" });
    expect(added.id).toBe("1");

    const updated = await updateTask("numeric-update", {
      id: 1,
      status: "doing",
      note: "Packages are now published; upgrade and ship to main.",
    });

    expect(updated.id).toBe("1");
    expect(updated.status).toBe("doing");
    expect(updated.note).toBe("Packages are now published; upgrade and ship to main.");
  });

  test("patch update accepts numeric IDs", async () => {
    await addTask("numeric-patch", { text: "First" });
    await addTask("numeric-patch", { text: "Second" });

    const state = await patchTasks("numeric-patch", { update: [{ id: 2, status: "done" }] });

    expect(state.items.find((item) => item.id === "2")?.status).toBe("done");
  });

  test("patch items without IDs add tasks", async () => {
    const state = await patchTasks("item-add", {
      items: [
        { text: "Add abstract to runtime spec", status: "doing" },
        { text: "Validate docs", status: "todo" },
      ],
    });

    expect(state.items.map((item) => ({ id: item.id, text: item.text, status: item.status }))).toEqual([
      { id: "1", text: "Add abstract to runtime spec", status: "doing" },
      { id: "2", text: "Validate docs", status: "todo" },
    ]);
  });

  test("patch items with IDs update existing tasks", async () => {
    await patchTasks("item-update", { items: [{ text: "Draft" }] });

    const state = await patchTasks("item-update", {
      items: [{ id: 1, text: "Draft spec", status: "doing", note: "Started" }],
    });

    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.text).toBe("Draft spec");
    expect(state.items[0]?.status).toBe("doing");
    expect(state.items[0]?.note).toBe("Started");
  });

  test("normalizes numeric IDs loaded from storage without reallocating", async () => {
    refs.set(
      "chat/stored-number/tasks",
      "json:" + JSON.stringify({
        version: 1,
        updatedAt: "earlier",
        items: [{ id: 2, text: "Stored", status: "todo", createdAt: "earlier", updatedAt: "earlier" }],
      }),
    );

    const state = await getTasks("stored-number");
    expect(state.items[0]?.id).toBe("2");

    const updated = await updateTask("stored-number", { id: "2", status: "done" });
    expect(updated.id).toBe("2");
    expect(updated.status).toBe("done");
  });



  test("refuses done when validation fails and lets agents update validation", async () => {
    setTaskValidationRunner(async (_chatId, source) => source === "pass");
    await addTask("validation-gate", { text: "Ship change", status: "doing", validation: "fail" });

    await expect(updateTask("validation-gate", { id: 1, status: "done" })).rejects.toThrow("validation did not pass");
    expect((await getTasks("validation-gate")).items[0]?.status).toBe("doing");

    expect(await validateTask("validation-gate", { id: 1 })).toEqual({ ok: false, error: null });
    await setTaskValidation("validation-gate", { id: 1, validation: "pass" });
    expect(await validateTask("validation-gate", { id: 1 })).toEqual({ ok: true, error: null });

    const done = await updateTask("validation-gate", { id: 1, status: "done" });
    expect(done.status).toBe("done");
    setTaskValidationRunner(null);
  });

  test("blocked tasks with reasons are not outstanding", async () => {
    await addTask("blocked-count", { text: "Todo" });
    await addTask("blocked-count", { text: "Blocked without reason", status: "blocked" });
    await addTask("blocked-count", { text: "Blocked with reason", status: "blocked", note: "Waiting on user" });
    await addTask("blocked-count", { text: "Done", status: "done" });
    await addTask("blocked-count", { text: "Dropped", status: "dropped" });

    expect(outstandingTaskCount(await getTasks("blocked-count"))).toBe(2);
  });


  test("does not reuse IDs after clearing all tasks", async () => {
    await addTask("clear-all", { text: "First" });
    await addTask("clear-all", { text: "Second" });
    await clearTasks("clear-all");

    const added = await addTask("clear-all", { text: "Third" });
    const state = await getTasks("clear-all");

    expect(added.id).toBe("3");
    expect(state.nextId).toBe(4);
    expect(state.items.map((item) => item.id)).toEqual(["3"]);
  });

  test("does not reuse IDs after clearing the highest numeric task", async () => {
    await addTask("clear-done", { text: "First" });
    await addTask("clear-done", { text: "Second", status: "done" });

    await clearTasks("clear-done", { statuses: ["done"] });
    const added = await addTask("clear-done", { text: "Third" });

    expect(added.id).toBe("3");
    expect((await getTasks("clear-done")).items.map((item) => item.id)).toEqual(["1", "3"]);
  });

  test("respects stored next IDs above the current max", async () => {
    refs.set(
      "chat/stored-next/tasks",
      "json:" + JSON.stringify({
        version: 1,
        updatedAt: "earlier",
        nextId: 5,
        items: [{ id: 1, text: "Stored", status: "todo", createdAt: "earlier", updatedAt: "earlier" }],
      }),
    );

    const added = await addTask("stored-next", { text: "Later" });
    const state = await getTasks("stored-next");

    expect(added.id).toBe("5");
    expect(state.nextId).toBe(6);
    expect(state.items.map((item) => item.id)).toEqual(["1", "5"]);
  });
});


describe("subagent initial tasks", () => {
  const types = readFileSync(new URL("./types.ts", import.meta.url), "utf8");
  const moo = readFileSync(new URL("./moo.ts", import.meta.url), "utf8");
  const prompt = readFileSync(new URL("./prompt.ts", import.meta.url), "utf8");

  test("SubagentSpec accepts and seeds initial tasks", () => {
    expect(types).toContain("tasks?: TaskAddInput[];");
    expect(moo).toContain("const tasks = Array.isArray(spec.tasks) ? spec.tasks : undefined;");
    expect(moo).toContain("await patchTasks(childChatId, { add: spec.tasks });");
    expect(moo).toContain("runSubagent({");
    expect(moo).toContain("}, { allowNested: true });");
    expect(prompt).toContain("`tasks` seeds the subagent's initial moo.tasks list with TaskAddInput[]");
    expect(prompt).toContain("seeded tasks may include `validation` functions that call `moo.judge`");
  });
});
