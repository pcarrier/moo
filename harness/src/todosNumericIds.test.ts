import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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
