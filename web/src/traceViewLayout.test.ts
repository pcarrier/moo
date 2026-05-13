import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";

const css = readStylesheetForTest();
const tracesView = readFileSync(new URL("./TracesView.tsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
const tracesApi = readFileSync(new URL("./api/traces.ts", import.meta.url), "utf8");
const transport = readFileSync(new URL("./api/transport.ts", import.meta.url), "utf8");
const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
const apiTypes = readFileSync(new URL("./api/types.ts", import.meta.url), "utf8");
const commands = readFileSync(new URL("../../harness/src/commands.ts", import.meta.url), "utf8");
const moo = readFileSync(new URL("../../harness/src/moo.ts", import.meta.url), "utf8");
const ws = readFileSync(new URL("../../src/ws.rs", import.meta.url), "utf8");

describe("hierarchical trace view", () => {
  test("uses the hierarchical trace commands including all roots", () => {
    for (const command of [
      "trace-chats",
      "trace-roots",
      "trace-node",
      "trace-subtree",
      "trace-search",
      "trace-failed",
      "trace-frontend",
      "trace-chat-tree",
    ]) {
      expect(tracesApi).toContain(command);
    }
    for (const oldCommand of ["trace-recent", "trace-diagnose", "trace-errors", "trace-get", "trace-tree", "trace-chat"]) {
      expect(tracesApi).not.toContain(`"${oldCommand}"`);
      expect(tracesView).not.toContain(`api("${oldCommand}"`);
    }
    expect(tracesApi).not.toContain("trace-summary");
  });

  test("does not switch List implicitly when running span searches", () => {
    const runSearchBody = tracesView.slice(tracesView.indexOf("async function runSearch()"), tracesView.indexOf("async function loadSubtree", tracesView.indexOf("async function runSearch()")));
    expect(runSearchBody).toContain('setSearchState("loading")');
    expect(runSearchBody).not.toContain('setActiveTab("search")');
  });

  test("does not self-refresh failures from idle state", () => {
    expect(tracesView).not.toContain('failedState() !== "idle"');
    expect(tracesView).not.toContain('activeTab() === "failed" && failures().length === 0 && failedState() === "idle"');
  });

  test("renders trace loading states as bare dots without empty chrome", () => {
    expect(tracesView).toContain("function BareTraceLoading");
    expect(tracesView).toContain('class="trace-loading-bare"');
    expect(css).toContain(".trace-loading-bare");
    expect(tracesView).not.toContain('fallback={<EmptyState class="trace-empty"><Show when={rootsState() === "loading"}');
    expect(tracesView).not.toContain('fallback={<EmptyState class="trace-empty"><Show when={failedState() === "loading"}');
    expect(tracesView).not.toContain('fallback={<EmptyState class="trace-empty"><Show when={searchState() === "loading"}');
    expect(tracesView).not.toContain('Loading traces <LoadingDots');
    expect(tracesView).not.toContain('Loading failures <LoadingDots');
    expect(tracesView).not.toContain('Loading spans <LoadingDots');
    expect(tracesView).not.toContain('Loading tree <LoadingDots');
  });

  test("renders a vertical all-traces selector and selectable tree timeline", () => {
    expect(tracesView).toContain("trace-workbench");
    expect(tracesView).toContain("trace-selector-pane");
    expect(tracesView).toContain("trace-direct-filter");
    expect(tracesView).toContain("filter traces");
    expect(tracesView).toContain("trace result view");
    expect(tracesView).toContain("chooseTraceView");
    expect(tracesView).toContain("trace duration range filter");
    expect(tracesView).toContain("trace age filter");
    expect(tracesView).toContain("trace-selector-results");
    expect(tracesView).not.toContain("trace-tabs trace-tabs-vertical");
    expect(tracesView).toContain("selectTraceRoot");
    expect(tracesView).toContain("trace tree timeline");
    expect(tracesView).not.toContain("Local timeline");
    expect(tracesView).not.toContain("trace-span-timeline-section");
    expect(tracesView).not.toContain("load older traces");
    expect(tracesView).toContain("installTraceSelectorAutoLoad");
    expect(tracesView).toContain("maybeLoadOlderTraceRoots");
    expect(tracesView).toContain("rootsCanLoadMore");
    expect(tracesView).toContain('el.addEventListener("scroll", onScroll, { passive: true })');
    expect(tracesView).not.toContain("window.requestAnimationFrame(onScroll)");
    expect(tracesView).toContain("compareRowsNewestFirst");
    expect(tracesView).toContain("mergeRootRowsNewestFirst(traceRoots(), value.roots)");
    expect(tracesView).toContain("[...value.roots].sort(compareRowsNewestFirst)");
    expect(tracesView).toContain("invokedFromStepId");
    expect(tracesView).toContain("Event log (");
    expect(tracesView).toContain("markRows(state().children)");
    expect(tracesView).toContain("installColumnResizer");
    expect(tracesView).toContain("installRowResizer");
    expect(tracesView).toContain("DEFAULT_TREE_OPEN_DEPTH = 1");
    expect(tracesView).toContain("node.depth - baseDepth < DEFAULT_TREE_OPEN_DEPTH");
    expect(tracesView).toContain("revealDetailInTree(value)");
    expect(tracesView).toContain("data-trace-id={row.node.id}");
    expect(tracesView).toContain("scrollIntoView({ block: \"nearest\" })");
    expect(tracesView).toContain("TRACE_DETAIL_DEFAULT_SPLIT = 0.5");
    expect(tracesView).toContain("TRACE_SELECTOR_WIDTH_STORAGE_KEY");
    expect(tracesView).toContain("TRACE_DETAIL_SPLIT_STORAGE_KEY");
    expect(tracesView).toContain("scrollTraceRowIntoView");
    expect(tracesView).toContain("preserveTimelineScroll");
    expect(tracesView).toContain("const scrollTop = scroller?.scrollTop ?? 0");
    expect(tracesView).toContain("scroller.scrollTop = scrollTop");
    expect(tracesView).toContain("window.localStorage.setItem");
    expect(css).toContain(".trace-workbench");
    expect(css).toContain("grid-template-columns: clamp(11rem, var(--trace-selector-w, 14rem), 18rem) 1px minmax(0, 1fr)");
    expect(css).toContain(".trace-selector-pane");
    expect(css).toContain(".trace-direct-filter");
    expect(css).toContain(".trace-selector-results");
    expect(css).toContain("overflow: auto");
    expect(css).toContain(".trace-root-row {\n  display: flex;\n  flex: 0 0 auto;");
    expect(css).toContain(".trace-load-more");
    expect(css).toContain(".trace-panel-resizer-column");
    expect(css).toContain(".trace-timeline-grid");
    expect(css).toContain("overscroll-behavior: contain");
    expect(css).toContain(".trace-tree-cell");
    expect(css).toContain("grid-area: detail");
    expect(css).toContain("var(--trace-timeline-fr, 1fr)");
    expect(css).toContain(".trace-detail-panel .trace-event-card");
    expect(css).toContain(".trace-row-right");
    expect(tracesView).toContain('class="trace-root-name"');
    expect(tracesView).toContain('class="trace-root-meta-text"');
    expect(tracesView).toContain('class="trace-root-age"');
    expect(css).toContain("flex-direction: column");
    expect(css).toContain(".trace-root-name");
    expect(css).toContain(".trace-root-meta-text");
    expect(css).toContain("text-overflow: ellipsis");
  });

  test("opens focused traces from their canonical root", () => {
    expect(tracesView).toContain("function isCanonicalRoot");
    expect(tracesView).toContain("loadTraceTreeFromRoot");
    expect(tracesView).toContain("const canonicalRoot = value.root || value.nodes.find(isCanonicalRoot) || value.nodes[0] || root");
    expect(tracesView).toContain("const pathIds = new Set(opts.expandIds || [])");
    expect(tracesView).toContain("for (const id of pathIds) open.add(id)");
    expect(tracesView).toContain("const preferredRoot = preferredRootId ? nodeById().get(preferredRootId) : null");
    expect(tracesView).toContain("const roots = preferredRoot ? [preferredRoot] : (byParent.get(null) || []).filter(isCanonicalRoot)");
  });

  test("applies trace filters to the selector result list directly", () => {
    expect(tracesView).toContain("selectorSummary");
    expect(tracesView).toContain("filteredTraceRoots");
    expect(tracesView).toContain("filteredFailures");
    expect(tracesView).toContain("filteredSearchHits");
    expect(tracesView).toContain('traceRoots().filter((root) => isCanonicalRoot(root) && rowMatchesTraceFilters(root))');
    expect(tracesView).toContain('searchHits().filter((hit) => hitMatchesFilters(hit, { restrictChatToSelection: true }))');
    expect(tracesView).toContain('activeTab() === "search" ? filteredSearchHits().length : activeTab() === "failed" ? filteredFailures().length : filteredTraceRoots().length');
    expect(tracesView).toContain('<For each={filteredTraceRoots()}');
    expect(tracesView).toContain('class="trace-root-row trace-hit-row"');
    expect(tracesView).toContain("onClick={() => focusHit(hit)}");
    expect(tracesView).toContain("<For each={filteredSearchHits()}");
    expect(tracesView).toContain("let searchRequest = 0");
    expect(tracesView).toContain("if (!isCurrentSearch(request)) return");
    expect(tracesView).not.toContain("Filtered spans");
  });

  test("passes selector filters to root trace loading", () => {
    expect(tracesView).toContain('const rootArgs: TraceSearchArgs = { limit: TRACE_PAGE_LIMIT');
    expect(tracesView).toContain('if (kind !== "any") rootArgs.kind = kind;');
    expect(tracesView).toContain('if (status !== "any") rootArgs.status = status;');
    expect(tracesView).toContain('if (scope !== "any") rootArgs.scope = scope;');
    expect(tracesView).toContain('let rootsRequest = 0');
    expect(tracesView).toContain('if (!isCurrentRoots(request)) return');
    expect(tracesView).toContain('api("trace-roots", rootArgs)');
    expect(tracesApi).toContain('"trace-roots"');
  });

  test("paginates roots by started time", () => {
    expect(tracesView).toContain("const t = rowStartedNs(row) || 0");
    expect(tracesView).not.toContain("const t = rowEndedNs(row) || rowStartedNs(row) || 0");
  });

  test("does not auto-page roots from loading state changes", () => {
    expect(tracesView).not.toContain(`traceRoots().length;
    rootsState();
    rootsCanLoadMore();`);
    expect(tracesView).not.toContain("window.requestAnimationFrame(() => maybeLoadOlderTraceRoots())");
  });

  test("adds direct duration and age/time range filters", () => {
    expect(tracesView).toContain("durationMinNs");
    expect(tracesView).toContain("durationMaxNs");
    expect(tracesView).toContain("parseDurationRange");
    expect(tracesView).toContain("Duration range");
    expect(tracesView).toContain(">=100ms, <5s, 100ms..2s");
    expect(tracesView).toContain("parseStartedRange");
    expect(tracesView).toContain("parseAgeDuration");
    expect(tracesView).toContain("startedBeforeNs");
    expect(tracesView).toContain("<15m, >2h, 30m..2h, ISO..ISO");
    expect(tracesView).toContain("Age/time");
    expect(tracesView).not.toContain("AGE_FILTERS");
    expect(apiTypes).toContain("minDurationNs?: number");
    expect(apiTypes).toContain("maxDurationNs?: number");
    expect(apiTypes).toContain("startedAfterNs?: number");
    expect(apiTypes).toContain("startedBeforeNs?: number");
  });

  test("keeps automatic frontend spans off the RPC wait path", () => {
    expect(transport).not.toContain("FRONTEND_TRACE_MAX_DURATION_MS");
    expect(transport).not.toContain("startedMs");
    expect(transport).not.toContain("endedMs");
    expect(transport).toContain("recordFrontendTrace(traceId, name, receivedNs, receivedNs, result, receivedNs - rpcStartedNs)");
    expect(transport).toContain("rpcDurationNs");
    expect(tracesApi).toContain("rpcDurationNs?: number");
  });

  test("parents command traces under frontend action traces", () => {
    expect(transport).toContain("traceFrontendId: traceId");
    expect(transport).toContain("traceParentId: traceId");
    expect(commands).toContain("traceParentId(payload)");
    expect(commands).toContain("traceRoute: typeof payload.traceRoute");
    expect(moo).toContain('kind: "frontend"');
    expect(moo).toContain("host.enterTrace");
    expect(moo).toContain("activeId = commandTraceId(command, rootId)");
    expect(ws).toContain('trace_string(payload, "id")');
    expect(ws).toContain("host::trace_update_data(&id");
    expect(tracesApi).toContain("id?: string");
  });

  test("uses nanosecond end timestamps when microseconds are absent", () => {
    expect(tracesView).toContain("function rowStartedNs(row: TraceRow): number { return Number(row.t0Ns); }");
    expect(tracesView).toContain("function rowEndedNs(row: TraceRow, now = nowNs()): number { return row.t1Ns == null ? now : Number(row.t1Ns); }");
    expect(tracesView).toContain('function rowIsRunning(row: TraceRow): boolean { return row.t1Ns == null && row.status === "running"; }');
    expect(tracesView).toContain('function rowDisplayStatus(row: TraceRow): TraceRow["status"] { return row.t1Ns != null && row.status === "running" ? "ok" : row.status; }');
    expect(tracesView).toContain("running: rowIsRunning(row.node)");
    expect(tracesView).toContain("<StatusBadge status={rowDisplayStatus(row.node)} />");
    expect(tracesView).not.toContain("rowEndedUs");
    expect(tracesView).not.toContain("t1Us");
  });

  test("refreshes active running trace rows until end timestamps arrive", () => {
    expect(tracesView).toContain("function refreshActiveRunningTrace()");
    expect(tracesView).toContain("if (!root || !nodes().some(rowIsRunning)) return;");
    expect(tracesView).toContain("const hasRunningRows = nodes().some(rowIsRunning);");
    expect(tracesView).toContain("window.setInterval(() => { void refreshActiveRunningTrace(); }, 2_000)");
    expect(tracesView).toContain("setNodes(mergeRows(nodes(), value.nodes));");
  });

  test("preserves tree timeline scroll during running trace refresh", () => {
    const body = tracesView.slice(tracesView.indexOf("async function refreshActiveRunningTrace()"), tracesView.indexOf("createEffect(() =>", tracesView.indexOf("async function refreshActiveRunningTrace()")));
    expect(body).toContain("preserveTimelineScroll(() => {");
    expect(body).toContain("setNodes(mergeRows(nodes(), value.nodes));");
    expect(body).not.toContain("revealDetailInTree(detailValue)");
  });

  test("records and filters frontend global traces", () => {
    expect(tracesView).toContain('value="global"');
    expect(tracesView).toContain('"frontend", "chat"');
    expect(tracesView).toContain("args.scope = scopeFilter()");
    expect(tracesApi).toContain('ApiCommand<"trace-frontend"');
    expect(tracesApi).toContain('"trace-search"');
    expect(apiTypes).toContain('scope?: "chat" | "global" | "any"');
  });

  test("keeps the redesigned trace workbench usable on narrow screens", () => {
    expect(css).toContain("container-type: inline-size");
    expect(css).toContain(".timeline.traces-view");
    expect(css).toContain("@media (max-width: 56rem)");
    expect(css).toContain("@container (max-width: 56rem)");
    expect(css).toContain("@container (max-width: 48rem)");
    expect(css).toContain("@container (max-width: 38rem)");
    expect(css).toContain("min-height: calc(100dvh - 4.4rem)");
    expect(css).toContain("grid-template-rows: minmax(8.5rem, auto) minmax(18rem, 60dvh) minmax(18rem, auto)");
    expect(css).toContain("display: flex");
    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(css).toContain(".trace-row-timeline");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) minmax(5.6rem, auto)");
    expect(css).toContain("min-width: 0");
  });

  test("links from a trace detail to its direct parent span", () => {
    expect(tracesView).toContain("function directParent");
    expect(tracesView).toContain("state().node.parentId");
    expect(tracesView).toContain("trace-parent-link");
    expect(tracesView).toContain("loadDetail(parent().id)");
    expect(tracesView).toContain("loadDetail(parentId())");
    expect(css).toContain(".trace-parent-link");
  });

  test("selecting a non-chat trace root does not switch to the whole chat trace", () => {
    expect(tracesView).toContain('if (root.kind === "chat" && root.chatId)');
    expect(tracesView).toContain('<span class="trace-root-name">{nodeTitle(root)}</span>');
    expect(tracesView).toContain('props.bag.showTrace?.(root.id)');
    expect(tracesView).toContain('setSelectedRootKey(root.id)');
    expect(tracesView).toContain('let selectionRequest = 0');
    expect(tracesView).toContain('const request = opts.request ?? nextSelectionRequest()');
    expect(tracesView).toContain('if (!isCurrentSelection(request)) return;');
    expect(tracesView).not.toContain('if (root.chatId) props.bag.showTraces?.(root.chatId)');
    expect(tracesView).not.toContain('const rootSelectionKey = (row: TraceRow) => row.chatId || row.id');
  });

  test("selector hits reveal and expand the selected span in the tree", () => {
    expect(tracesView).toContain("function revealHitInTree(hit: SearchHit)");
    expect(tracesView).toContain("revealHitInTree(hit)");
    expect(tracesView).toContain("selectTraceRoot(root, { request, focusId: hit.node.id, expandIds, preserveTab: true })");
    expect(tracesView).toContain("const root = hit.root || traceRootOf(hit.node, hit.ancestors)");
    expect(tracesView).toContain("setRootId(root.id)");
    expect(tracesView).toContain("setSelectedId(hit.node.id)");
    expect(tracesView).toContain("scrollTraceRowIntoView(hit.node.id)");
    expect(tracesView).toContain("const nextChatId = hit.node.chatId || root.chatId || null");
    expect(tracesView).toContain("props.bag.showTraces?.(nextChatId)");
    expect(tracesView).toContain("if (request != null && !isCurrentSelection(request)) return");
  });

  test("active trace sidebar entries reveal the selected span in the timeline tree", () => {
    expect(tracesView).toContain("syncedSidebarTraceId");
    expect(tracesView).toContain("props.bag.activeRightSidebarTab?.()");
    expect(tracesView).toContain('if (!tab || tab.kind !== "trace") return');
    expect(tracesView).toContain('unwrap(api("trace-node", { id: trace.id }), "trace sidebar trace load")');
    expect(tracesView).toContain("const root = value.root || traceRootOf(value.node, value.ancestors)");
    expect(tracesView).toContain("await selectTraceRoot(root, { request, focusId: value.node.id, expandIds, preserveTab: true })");
  });

  test("does not synthesize timeline file-link diffs while the file is loading", () => {
    expect(sidebar).toContain("if (file.loading) return null;");
  });

  test("keeps detail input, output, and errors hash sections hidden when empty", () => {
    expect(tracesView).toContain('<Show when={state().node.inputHash}>');
    expect(tracesView).toContain('<HashBlock label="Input" hash={hash()}');
    expect(tracesView).toContain('<Show when={state().node.outputHash}>');
    expect(tracesView).toContain('<HashBlock label="Output" hash={hash()}');
    expect(tracesView).toContain('<Show when={state().node.errorHash}>');
    expect(tracesView).toContain('<HashBlock label="Errors" hash={hash()}');
    expect(tracesView).toContain('<DataBlock label="Trace data" value={state().node.dataJson}');
    expect(tracesView).toContain('api("object-get", { hash })');
    expect(tracesView).toContain("props.onOpenStore?.(hash())");
    expect(tracesView).not.toContain('"trace-summary"');
    expect(tracesView).not.toContain('<HashBlock label="Error"');
    expect(tracesView).not.toContain('<h3>Summary</h3>');
    expect(tracesView).not.toContain('<h3>Children</h3>');
  });

  test("renders trace data blocks as highlighted HJSON", () => {
    expect(tracesView).toContain("highlightHjsonValue(value, { linkStoreHashes: true })");
    expect(tracesView).toContain("handleStoreHashClick(ev, props.onOpenStore)");
    expect(tracesView).toContain("highlightAuto");
    expect(tracesView).toContain('innerHTML={hjsonHtml(object().text ?? object().value)}');
    expect(tracesView).toContain('innerHTML={hjsonHtml(props.value)}');
    expect(tracesView).toContain('innerHTML={hjsonHtml(data())}');
    expect(tracesView).not.toContain('{object().text ?? jsonText(object().value)}');
    expect(tracesView).not.toContain('{jsonText(data())}');
  });

  test("keeps the trace workbench CSS outside terminal exit styles", () => {
    const kbdBlockEnd = css.indexOf(".terminal-exited kbd") + css.slice(css.indexOf(".terminal-exited kbd")).indexOf("}");
    const workbenchStart = css.indexOf("/* Redesigned trace workbench");
    expect(kbdBlockEnd).toBeLessThan(workbenchStart);
  });

  test("app right sidebar tabs use the app title", () => {
    expect(sidebar).toContain('if (tab.kind === "app") return tab.title || tab.uiId;');
    expect(sidebar).not.toContain('if (tab.kind === "app") return tab.uiId;');
  });

  test("sidebar traces item opens the current chat without a split separator", () => {
    expect(sidebar).toContain("bag.showTraces(bag.chatId())");
    expect(sidebar).not.toContain("sidebar-tab-pair");
    expect(sidebar).not.toContain('<span class="sidebar-tab-label">for chat</span>');
    expect(css).not.toContain(".sidebar-tab-pair");
    expect(tracesView).toContain("props.bag.traceChatId?.() || null");
    expect(tracesView).toContain("props.bag.traceId?.() || null");
    expect(tracesView).toContain("void selectChat(chatId)");
  });
  test("routes trace ids separately from chat traces", () => {
    expect(state).toContain('`/traces[/<traceId>]`, `/traces/chat/<chatId>`');
    expect(state).toContain('return { view: "traces", traceId: null, chatId: parts[2] || null }');
    expect(state).toContain('return { view: "traces", traceId: parts[1] || null, chatId: null }');
    expect(state).toContain('`/traces/chat/${encodeURIComponent(traceChat)}`');
    expect(state).toContain('traceId\n          ? `/traces/${encodeURIComponent(traceId)}`');
    expect(state).toContain(': "/traces"');
    expect(state).toContain("function showTrace(id?: string | null)");
    expect(state).toContain("setTraceChatId(null)");
    expect(state).toContain("traceId,");
    expect(tracesView).toContain("async function selectTraceId(id: string)");
    expect(tracesView).toContain("props.bag.showTrace?.(root.id)");
    expect(tracesView).toContain("if (props.bag.traceId?.() || props.bag.traceChatId?.()) return");
  });


  test("trail rows mirror timeline TODO typography", () => {
    expect(sidebar).toContain('title: nextTitle || "Untitled"');
    expect(sidebar).toContain('title: label,');
    expect(sidebar).toContain('title: `${action} ${todoText}`');
    expect(sidebar).toContain('const previousText = previous && previous.text !== todo?.text ? `was: ${previous.id}. ${previous.text}` : "";');
    expect(sidebar).toContain('function todoChangeTextForTrail(change: TodoDiffChange): string');
    expect(sidebar).toContain('[`todo-status-${props.item.todoStatus}`]: !!props.item.todoStatus');
    expect(css).toContain('.agent-trail-title {\n  min-width: 0;');
    expect(css).toContain('font-weight: 600;');
    expect(css).toContain('.agent-trail-item.todo-status-doing .agent-trail-title {\n  font-weight: 700;\n}');
    expect(css).toContain('.agent-trail-item.todo-status-done .agent-trail-title {\n  color: var(--muted);\n  text-decoration: line-through;\n}');
    expect(css).toContain('.agent-trail-item.subagent .agent-trail-title::before');
    expect(css).toContain('.agent-trail-item.title .agent-trail-dot {\n  background: darkorange;\n}');
    expect(css).toContain('.agent-trail-item.summary .agent-trail-dot {\n  background: mediumseagreen;\n}');
    expect(css).toContain('.agent-trail-item.todo .agent-trail-dot {\n  background: mediumorchid;\n}');
    expect(css).toContain('.agent-trail-item.subagent .agent-trail-dot {\n  background: mediumpurple;\n}');
  });
});

describe("right sidebar diff tabs", () => {
  test("repo file previews wait for timeline diff hydration before rendering current diffs", () => {
    expect(sidebar).toContain("const readyTimelineDiff = (item: FileDiffItem | null | undefined) =>");
    expect(sidebar).toContain("item && !expandedFileDiffNeedsHydration(item) ? item : null");
    expect(sidebar).toContain("const timelineDiffHydrating = () =>");
    expect(sidebar).toContain("if (timelineDiffHydrating()) return null;");
    expect(sidebar).toContain("const browserTimelineDiffHydrating = () =>");
    expect(sidebar).toContain("if (browserTimelineDiffHydrating()) return null;");
    expect(sidebar).not.toContain(
      "setHydratedTimelineDiff(current);\n        if (!current || !expandedFileDiffNeedsHydration(current)) return;",
    );
  });

  test("keeps separate timeline diff tabs for different diffs on the same file", () => {
    expect(state).toContain('a.scope === "timeline"');
    expect(state).toContain("? a.diffId === diff.diffId");
    expect(state).toContain('scope === "history" &&');
    expect(state).not.toContain("tab.scope === scope && sameDiffPath(tab.path, diff.path)");
  });

  test("trail TODO entries prefer live timeline rows over stale trail rows", () => {
    expect(sidebar).toContain('if (item.type === "todo-diff") return todoTrailItem(item);');
    expect(sidebar).not.toContain('if (item.type === "file-diff") return diffTimelineItem(item);');
    expect(sidebar).not.toContain('if (item.type === "memory-diff") return memoryTrailItem(item);');
    expect(sidebar).toContain("for (const item of bag.trail()) byKey.set(trailSourceKey(item), item);");
    expect(sidebar).toContain("for (const item of bag.timeline()) byKey.set(trailSourceKey(item), item);");
    expect(sidebar.indexOf("for (const item of bag.trail()) byKey.set(trailSourceKey(item), item);")).toBeLessThan(
      sidebar.indexOf("for (const item of bag.timeline()) byKey.set(trailSourceKey(item), item);"),
    );
  });
});
