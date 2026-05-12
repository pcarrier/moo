import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";

const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
const css = readStylesheetForTest();
const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
const todoRegion = timeline.slice(timeline.indexOf("function OngoingTodos"), timeline.indexOf("function PendingList"));
const todoDiffRegion = timeline.slice(timeline.indexOf("function TodoDiffBody"), timeline.indexOf("function displayStepKind"));

describe("timeline TODO UI", () => {
  test("renders ongoing TODOs between the timeline and queued/input messages", () => {
    const timelineMain = timeline.indexOf('<main class="timeline"');
    const ongoingTodos = timeline.indexOf('<OngoingTodos todos={bag.todos()} />');
    const pendingList = timeline.indexOf('<PendingList bag={bag} onOpenImage={openLightbox} />');
    const inputBar = timeline.indexOf('<InputBar bag={bag} onOpenImage={openLightbox} />');

    expect(timelineMain).toBeGreaterThanOrEqual(0);
    expect(ongoingTodos).toBeGreaterThan(timelineMain);
    expect(pendingList).toBeGreaterThan(ongoingTodos);
    expect(inputBar).toBeGreaterThan(pendingList);
    expect(css).toContain('.conversation-main > .ongoing-todos,');
    expect(css).toContain('.conversation-main > .timeline');
    expect(timeline).toContain('class="ongoing-todo-line"');
    expect(todoRegion).not.toContain('type="checkbox"');
    expect(todoRegion).not.toContain('checked={todoDone');
    expect(timeline).toContain('const items = () => props.todos.filter((item) => item.status !== "dropped");');
    expect(timeline).toContain('const label = (item: AgentTodo) => `~ ${item.id}. ${item.text}`;');
    expect(timeline).toContain('<TodoMarkdownInline className="ongoing-todo-text" content={label(item)} />');
    expect(timeline).toContain('function TodoMetaBubbles');
    expect(timeline).toContain('class="todo-bubble todo-status-bubble"');
    expect(timeline).toContain('class="todo-bubble todo-priority-bubble"');
    expect(timeline).toContain('<Show when={priority() !== "normal"}>');
    expect(timeline).toContain('function TodoMarkdownInline');
    expect(timeline).toContain('function TodoMarkdownBlock');
    expect(timeline).toContain('renderMarkdownInline(props.content.replace(/\\n+/g, " "))');
    expect(timeline).toContain('<TodoMarkdownBlock className={`${props.className} todo-note`} content={note()} />');
    expect(timeline).not.toContain('note: {props.item.note}');
    expect(timeline).not.toContain('status: {props.item.status}');
    expect(timeline).not.toContain('priority: {todoPriorityLabel(props.item.priority)}');
    expect(css).toContain('.ongoing-todos-toggle {');
    expect(css).toContain('position: absolute;');
    expect(timeline).toContain('"only-done": !showDone() && visibleItems().length === 0 && doneItems().length > 0');
    expect(css).toContain('min-block-size: 1.8em;');
    expect(css).toContain('.ongoing-todo-line {');
    expect(css).not.toContain('.ongoing-todo-check input[type="checkbox"]');
    expect(css).toContain('border: 0;');
    expect(css).toContain('font-weight: 800;');
  });

  test("keeps ongoing TODO rows to one ellipsized line", () => {
    expect(css).toContain(`.ongoing-todo {
  display: flex;
  align-items: baseline;
  gap: 0.12em;
  min-inline-size: 0;
  overflow: hidden;
  white-space: nowrap;`);
    expect(css).toContain(`.ongoing-todo-line {
  display: flex;
  align-items: baseline;
  flex: 1 1 auto;
  gap: 0.32em;`);
    expect(css).toContain(`.ongoing-todo-text,
.ongoing-todo-details {
  min-inline-size: 0;
  overflow: hidden;
  overflow-wrap: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
}`);
    expect(css).toContain(`.ongoing-todo .ongoing-todo-text {
  display: block;
  flex: 0 1 auto;
}`);
    expect(css).toContain(`.ongoing-todo-details {
  flex: 0 1 auto;
  max-inline-size: 35%;
}`);
    expect(css).toContain(`.ongoing-todo .todo-note.markdown > * {
  display: inline;
}`);
  });

  test("renders TODO diffs in the timeline without diff chrome", () => {
    expect(timeline).toContain('props.item.type === "todo-diff"');
    expect(timeline).toContain('item={props.item as FileDiffItem | MemoryDiffItem | TodoDiffItem}');
    expect(timeline).toContain('if (!Array.isArray(props.item.changes) || props.item.changes.length === 0)');
    expect(timeline).toContain('return null;');
    expect(timeline).toContain('<div class="step todo-diff" data-timeline-key={props.timelineKey}>');
    expect(timeline).toContain('<div class="todo-diff-body" role="log" aria-label="TODO changes">');
    expect(timeline).toContain('<TodoDiffBody item={props.item} />');
    expect(timeline).not.toContain('classList={{ "todo-diff": isTodo() }}');
    expect(timeline).not.toContain('todo diff');
    expect(timeline).not.toContain('changes</span>');
  });

  test("renders TODO diffs as semantic changes", () => {
    expect(timeline).toContain('function TodoDiffBody');
    expect(timeline).toContain('<TodoMarkdownInline className="todo-diff-text" content={todoLabel(item())} />');
    expect(timeline.indexOf('<TodoMarkdownInline className="todo-diff-text" content={todoLabel(item())} />')).toBeLessThan(timeline.indexOf('<TodoMetaBubbles item={item()} />'));
    expect(timeline).toContain('<TodoMarkdownInline className="todo-diff-previous-text" content={`was: ${todoLabel(previous()!)}`} />');
    expect(timeline).not.toContain('No TODO changes');
    expect(timeline).not.toContain('todo-diff-fallback');
    expect(timeline).toContain('<TodoNote item={item()} className="todo-diff-details" />');
    expect(timeline).toContain('class="todo-diff-list"');
    expect(timeline).toContain('todoChangeText(change)');
    expect(timeline).toContain('if (item.status === "dropped") return "X";');
    expect(timeline).toContain('if (item.status === "blocked") return "!";');
    expect(timeline).toContain('if (item.status === "done") return "-";');
    expect(timeline).toContain('if (change.kind === "added") return "+";');
    expect(timeline).toContain('return "~";');
    expect(timeline).not.toContain('return "dropped";');
    expect(timeline).not.toContain('return "blocked";');
    expect(timeline).not.toContain('checked={todoDone(item().status)}');
    expect(timeline).not.toContain('function todoDone');
    expect(timeline).not.toContain('☑');
    expect(timeline).not.toContain('☐');
    expect(css).toContain('text-decoration: line-through');
    expect(css).toContain('.ongoing-todos-toggle');
    expect(css).toContain('.ongoing-todos.only-done');
    expect(css).toContain('.ongoing-todo.todo-doing .ongoing-todo-text');
    expect(css).toContain('font-weight: 700;');
    expect(css).toContain('.ongoing-todo.todo-done .ongoing-todo-text');
    expect(css).toContain('.todo-bubble');
    expect(css).toContain('padding: 0.18em 0.45em;');
    expect(css).toContain('padding-right: 7em;');
    expect(css).toContain('gap: 0.02em;');
    expect(css).toContain('--bubble-todo-diff: color-mix(in srgb, orchid 16%, transparent);');
    expect(css).toContain('.todo-diff {\n  background: var(--bubble-todo-diff);\n  inline-size: 100%;');
    expect(css).toContain('.todo-diff-body {\n  margin: 0;\n  padding: 0.18rem 0.3rem;\n  font-family: inherit;\n  white-space: normal;\n}');
    expect(css).toContain('.todo-diff-list {\n  list-style: none;\n  margin: 0;\n  padding: 0;\n  display: grid;\n  gap: 0.03rem;\n}');
    expect(css).toContain('.todo-markdown-inline {\n  display: inline;\n}');
    expect(css).not.toContain('grid-template-columns: max-content minmax(0, 1fr); column-gap: 0.35rem');
    expect(css).toContain('.todo-diff-details,\n.todo-diff-previous {\n  margin-left: calc(1ch + 0.18rem);');
    expect(css).not.toContain('.todo-diff-fallback');
    expect(css).not.toContain('.todo-diff .file-diff-body');
    expect(css).toContain('.todo-diff-main {\n  display: inline-flex;\n  gap: 0.18rem;');
    expect(css).toContain('.todo-change-updated .todo-diff-action {\n  color: var(--accent-fg);\n}');
    expect(css).toContain('.todo-status-doing .todo-diff-text {\n  font-weight: 700;\n}');
    expect(css).toContain('.todo-status-dropped .todo-diff-action {\n  color: var(--danger-fg, #cf222e);\n}');
    expect(css).toContain('border-radius: 0;');
  });
  test("scopes ongoing TODOs to the selected chat", () => {
    expect(state).toContain("const todosByChat = new Map<string, AgentTodo[]>();");
    expect(state).toContain("function applyTodosForChat(id: string, next: AgentTodo[])");
    expect(state).toContain("function showTodosForChat(id: string | null)");
    expect(state).toContain(
      "applyTodosForChat(id, Array.isArray(value.todos) ? value.todos : []);",
    );

    const selectStart = state.indexOf("async function selectChat(");
    expect(selectStart).toBeGreaterThanOrEqual(0);
    const selectEnd = state.indexOf("function olderTimelineLoadCount", selectStart);
    const selectBlock = state.slice(selectStart, selectEnd);
    expect(selectBlock).toContain("setChatId(id);\n    showTodosForChat(id);");

    const todoDiffStart = state.indexOf('if (ev.kind === "todo-diff")');
    expect(todoDiffStart).toBeGreaterThanOrEqual(0);
    const todoDiffEnd = state.indexOf('if (ev.kind === "memory-diff")', todoDiffStart);
    const todoDiffBlock = state.slice(todoDiffStart, todoDiffEnd);
    expect(todoDiffBlock).toContain(
      "if (Array.isArray(ev.todos)) applyTodosForChat(ev.chatId, ev.todos);",
    );
    expect(todoDiffBlock.indexOf("applyTodosForChat(ev.chatId, ev.todos)")).toBeLessThan(
      todoDiffBlock.indexOf("if (cid && ev.chatId === cid)"),
    );
    expect(todoDiffBlock).toContain("if (!Array.isArray(ev.changes) || ev.changes.length === 0) return;");
    expect(todoDiffBlock).toContain("if (!Array.isArray(ev.changes) || ev.changes.length === 0) return;");
    expect(todoDiffBlock).not.toContain("setTodos(ev.todos)");
  });
});
