import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";

const timeline = readFileSync(
  new URL("./Timeline.tsx", import.meta.url),
  "utf8",
);
const css = readStylesheetForTest();
const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
const taskRegion = timeline.slice(
  timeline.indexOf("function OngoingTasks"),
  timeline.indexOf("function PendingList"),
);
const taskDiffRegion = timeline.slice(
  timeline.indexOf("function TaskDiffBody"),
  timeline.indexOf("function displayStepKind"),
);

describe("timeline TASK UI", () => {
  test("renders ongoing tasks between the timeline and queued/input messages", () => {
    const timelineMain = timeline.indexOf('<main class="timeline"');
    const ongoingTasks = timeline.indexOf(
      "<OngoingTasks tasks={bag.tasks()} />",
    );
    const pendingList = timeline.indexOf(
      "<PendingList bag={bag} onOpenImage={openLightbox} />",
    );
    const inputBar = timeline.indexOf(
      "<InputBar bag={bag} onOpenImage={openLightbox} />",
    );

    expect(timelineMain).toBeGreaterThanOrEqual(0);
    expect(ongoingTasks).toBeGreaterThan(timelineMain);
    expect(pendingList).toBeGreaterThan(ongoingTasks);
    expect(inputBar).toBeGreaterThan(pendingList);
    expect(css).toContain(".conversation-main > .ongoing-tasks,");
    expect(css).toContain(".conversation-main > .timeline");
    expect(timeline).toContain('class="ongoing-task-line"');
    expect(taskRegion).not.toContain('type="checkbox"');
    expect(taskRegion).not.toContain("checked={taskDone");
    expect(timeline).toContain(
      'const items = () => props.tasks.filter((item) => item.status !== "dropped");',
    );
    expect(timeline).toContain(
      "const label = (item: AgentTask) => `${item.id}. ${item.text}`;",
    );
    expect(timeline).toContain("<TaskMarkdownInline");
    expect(timeline).toContain('className="ongoing-task-text"');
    expect(timeline).toContain("content={label(item)}");
    expect(timeline).toContain("function TaskMetaBubbles");
    expect(timeline).toContain('class="task-bubble task-status-bubble"');
    expect(timeline).toContain("function TaskMarkdownInline");
    expect(timeline).toContain("function TaskMarkdownBlock");
    expect(timeline).toContain(
      'renderMarkdownInline(props.content.replace(/\\n+/g, " "))',
    );
    expect(timeline).toContain("<TaskMarkdownBlock");
    expect(timeline).toContain("className={`${props.className} task-note`}");
    expect(timeline).toContain("content={note()}");
    expect(timeline).not.toContain("note: {props.item.note}");
    expect(timeline).not.toContain("status: {props.item.status}");
    expect(css).toContain(".ongoing-tasks-toggle {");
    expect(css).toContain("position: absolute;");
    expect(taskRegion).toContain('"only-done":');
    expect(taskRegion).toContain("!showDone() &&");
    expect(taskRegion).toContain("visibleItems().length === 0 &&");
    expect(taskRegion).toContain("doneItems().length > 0");
    expect(css).toContain("min-block-size: 1.8em;");
    expect(css).toContain(".ongoing-task-line {");
    expect(css).not.toContain('.ongoing-task-check input[type="checkbox"]');
    expect(css).toContain("border: 0;");
    expect(css).toContain("font-weight: 800;");
    expect(css).toContain("margin-inline: 0.33em;");
  });

  test("keeps ongoing TASK rows to one ellipsized line", () => {
    expect(css).toContain(`.ongoing-task {
  display: flex;
  align-items: baseline;
  gap: 0.12em;
  min-inline-size: 0;
  overflow: hidden;
  white-space: nowrap;`);
    expect(css).toContain(`.ongoing-task-line {
  display: flex;
  align-items: baseline;
  flex: 0 0 auto;
  max-inline-size: 100%;
  overflow: visible;`);
    expect(css).toContain(`.ongoing-task-text,
.ongoing-task-details {
  min-inline-size: 0;
  overflow: hidden;
  overflow-wrap: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
}`);
    expect(css).toContain(`.ongoing-task .ongoing-task-text {
  display: block;
  flex: 0 0 auto;
}`);
    expect(css).toContain(`.ongoing-task-details {
  flex: 1 1 auto;
}`);
    expect(css).not.toContain(`.ongoing-task-details {
  flex: 0 1 auto;
  max-inline-size: 35%;
}`);
    expect(css).toContain(`.ongoing-task .task-note.markdown > * {
  display: inline;
}`);
  });

  test("renders task diffs in the timeline without diff chrome", () => {
    expect(timeline).toContain('props.item.type === "task-diff"');
    expect(timeline).toContain("<DiffItem");
    expect(timeline).toContain("props.item as FileDiffItem | MemoryDiffItem | TaskDiffItem");
    expect(timeline).toContain(
      "if (!Array.isArray(props.item.changes) || props.item.changes.length === 0)",
    );
    expect(timeline).toContain("return null;");
    expect(timeline).toContain(
      '<div class="step task-diff" data-timeline-key={props.timelineKey}>',
    );
    expect(timeline).toContain(
      '<div class="task-diff-body" role="log" aria-label="task changes">',
    );
    expect(timeline).toContain("<TaskDiffBody item={props.item} />");
    expect(timeline).not.toContain('classList={{ "task-diff": isTask() }}');
    expect(timeline).not.toContain("task diff");
    expect(timeline).not.toContain("changes</span>");
  });

  test("renders task diffs as semantic changes", () => {
    expect(timeline).toContain("function TaskDiffBody");
    expect(taskDiffRegion).toContain("<TaskMarkdownInline");
    expect(taskDiffRegion).toContain('className="task-diff-text"');
    expect(taskDiffRegion).toContain("content={taskLabel(item())}");
    expect(taskDiffRegion.indexOf('className="task-diff-text"')).toBeLessThan(
      taskDiffRegion.indexOf("<TaskMetaBubbles item={item()} />"),
    );
    expect(taskDiffRegion).toContain('<Show when={change.kind !== "removed"}>');
    expect(taskDiffRegion).toContain('className="task-diff-previous-text"');
    expect(taskDiffRegion).toContain("content={`was: ${taskLabel(previous()!)}`}");
    expect(timeline).not.toContain("No task changes");
    expect(timeline).not.toContain("task-diff-fallback");
    expect(taskDiffRegion).toContain("<TaskNote");
    expect(taskDiffRegion).toContain("item={item()}");
    expect(taskDiffRegion).toContain('className="task-diff-details"');
    expect(timeline).toContain('class="task-diff-list"');
    expect(timeline).toContain("taskChangeText(change)");
    expect(timeline).toContain('if (item.status === "dropped") return "X";');
    expect(timeline).toContain('if (item.status === "blocked") return "!";');
    expect(timeline).toContain('if (item.status === "done") return "-";');
    expect(timeline).toContain('if (change.kind === "added") return "+";');
    expect(timeline).toContain('return "~";');
    expect(timeline).not.toContain('return "dropped";');
    expect(timeline).not.toContain('return "blocked";');
    expect(timeline).not.toContain("checked={taskDone(item().status)}");
    expect(timeline).not.toContain("function taskDone");
    expect(timeline).not.toContain("☑");
    expect(timeline).not.toContain("☐");
    expect(css).toContain("text-decoration: line-through");
    expect(css).toContain(".ongoing-tasks-toggle");
    expect(css).toContain(".ongoing-tasks.only-done");
    expect(css).toContain(".ongoing-task.task-doing .ongoing-task-text");
    expect(css).toContain("font-weight: 700;");
    expect(css).toContain(".ongoing-task.task-done .ongoing-task-text");
    expect(css).toContain(".task-bubble");
    expect(css).toContain("padding: 0.18em 0.45em;");
    expect(css).toContain("padding-right: 7em;");
    expect(css).toContain("gap: 0.02em;");
    expect(css).toContain(
      "--bubble-task-diff: color-mix(in srgb, orchid 16%, transparent);",
    );
    expect(css).toContain(
      ".task-diff {\n  background: var(--bubble-task-diff);\n  inline-size: 100%;",
    );
    expect(css).toContain(
      ".task-diff-body {\n  margin: 0;\n  padding: 0.18rem 0.3rem;\n  font-family: inherit;\n  white-space: normal;\n}",
    );
    expect(css).toContain(
      ".task-diff-list {\n  list-style: none;\n  margin: 0;\n  padding: 0;\n  display: grid;\n  gap: 0.03rem;\n}",
    );
    expect(css).toContain(".task-markdown-inline {\n  display: inline;\n}");
    expect(css).not.toContain(
      "grid-template-columns: max-content minmax(0, 1fr); column-gap: 0.35rem",
    );
    expect(css).toContain(
      ".task-diff-details,\n.task-diff-previous {\n  margin-left: calc(1ch + 0.18rem);",
    );
    expect(css).not.toContain(".task-diff-fallback");
    expect(css).not.toContain(".task-diff .file-diff-body");
    expect(css).toContain(
      ".task-diff-main {\n  display: inline-flex;\n  gap: 0.18rem;",
    );
    expect(css).toContain(
      ".task-change-updated .task-diff-action {\n  color: var(--accent-fg);\n}",
    );
    expect(css).toContain(
      ".task-status-doing .task-diff-text {\n  font-weight: 700;\n}",
    );
    expect(css).toContain(
      ".task-status-dropped .task-diff-action {\n  color: var(--danger-fg, #cf222e);\n}",
    );
    expect(css).toContain("border-radius: 0;");
  });
  test("scopes ongoing tasks to the selected chat", () => {
    expect(state).toContain(
      "const tasksByChat = new Map<string, AgentTask[]>();",
    );
    expect(state).toContain(
      "function applyTasksForChat(id: string, next: AgentTask[])",
    );
    expect(state).toContain("function showTasksForChat(id: string | null)");
    expect(state).toContain(
      "applyTasksForChat(id, Array.isArray(value.tasks) ? value.tasks : []);",
    );

    const selectStart = state.indexOf("async function selectChat(");
    expect(selectStart).toBeGreaterThanOrEqual(0);
    const selectEnd = state.indexOf(
      "function olderTimelineLoadCount",
      selectStart,
    );
    const selectBlock = state.slice(selectStart, selectEnd);
    expect(selectBlock).toContain(
      "setChatId(id);\n    showTokensForChat(id);\n    showTasksForChat(id);",
    );

    const taskDiffStart = state.indexOf('if (ev.kind === "task-diff")');
    expect(taskDiffStart).toBeGreaterThanOrEqual(0);
    const taskDiffEnd = state.indexOf(
      'if (ev.kind === "memory-diff")',
      taskDiffStart,
    );
    const taskDiffBlock = state.slice(taskDiffStart, taskDiffEnd);
    expect(taskDiffBlock).toContain(
      "if (Array.isArray(ev.tasks)) applyTasksForChat(ev.chatId, ev.tasks);",
    );
    expect(
      taskDiffBlock.indexOf("applyTasksForChat(ev.chatId, ev.tasks)"),
    ).toBeLessThan(taskDiffBlock.indexOf("if (cid && ev.chatId === cid)"));
    expect(taskDiffBlock).toContain(
      "if (!Array.isArray(ev.changes) || ev.changes.length === 0) return;",
    );
    expect(taskDiffBlock).toContain(
      "if (!Array.isArray(ev.changes) || ev.changes.length === 0) return;",
    );
    expect(taskDiffBlock).not.toContain("setTasks(ev.tasks)");
  });

  test("clears selected-chat tasks on the new-chat route", () => {
    expect(state).toContain("function resetSelectedChatViewState(");
    expect(state).toContain("opts: {");
    expect(state).toContain("showTasksForChat(null);");
    expect(state).toContain("resetSelectedChatViewState({");
    expect(state).toContain("clearChatId: true,");
    expect(state).toContain("clearUi: true,");
    expect(state).toContain("clearWip: true,");
    const startupStart = state.indexOf("const hydrateFirstChat = () =>");
    expect(startupStart).toBeGreaterThanOrEqual(0);
    const startupEnd = state.indexOf("void chatsLoad", startupStart);
    const startupBlock = state.slice(startupStart, startupEnd);
    expect(startupBlock).toContain(
      'if (loc.view === "new" || chatId()) return;',
    );
  });
});
