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
      expect(tracesApi).not.toContain(`callCommand("${oldCommand}"`);
      expect(tracesView).not.toContain(`callCommand("${oldCommand}"`);
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
    expect(css).toContain(".trace-load-more");
    expect(css).toContain(".trace-panel-resizer-column");
    expect(css).toContain(".trace-timeline-grid");
    expect(css).toContain("overscroll-behavior: contain");
    expect(css).toContain(".trace-tree-cell");
    expect(css).toContain("grid-area: detail");
    expect(css).toContain("var(--trace-timeline-fr, 1fr)");
    expect(css).toContain(".trace-detail-panel .trace-event-card");
    expect(css).toContain(".trace-row-right");
  });

  test("reroots focused trace timelines to show loaded ancestors", () => {
    expect(tracesView).toContain("currentRootIsFocusedNode");
    expect(tracesView).toContain("currentRootIsInAncestorChain");
    expect(tracesView).toContain("loadedAncestors[0]");
    expect(tracesView).toContain("setRootId(loadedAncestors[0].id)");
    expect(tracesView).toContain("for (const ancestor of loadedAncestors) next.add(ancestor.id)");
    expect(tracesView).toContain("const parent = node.parentId && ids.has(node.parentId) ? node.parentId : node.parentId ? undefined : null;");
    expect(tracesView).toContain("if (parent !== undefined)");
    expect(tracesView).toContain("const roots = rootId() && nodeById().has(rootId()!) ? [nodeById().get(rootId()!)!] : (byParent.get(null) || [])");
  });

  test("applies trace filters to the selector result list directly", () => {
    expect(tracesView).toContain("selectorSummary");
    expect(tracesView).toContain("filteredTraceRoots");
    expect(tracesView).toContain("filteredFailures");
    expect(tracesView).toContain("filteredSearchHits");
    expect(tracesView).toContain('traceRoots().filter((root) => rowMatchesTraceFilters(root))');
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
    expect(tracesView).toContain('api.traces.roots(rootArgs)');
    expect(tracesApi).toContain('roots: (args: TraceSearchArgs = {}) => callCommand("trace-roots", args)');
  });

  test("paginates roots by started time", () => {
    expect(tracesView).toContain("const t = rowStartedUs(row) || 0");
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
    expect(transport).not.toContain("endedMs - startedMs >");
    expect(transport).toContain("recordFrontendTrace(name, receivedMs, receivedMs, result, receivedMs - rpcStartedMs)");
    expect(transport).toContain("rpcDurationMs");
    expect(tracesApi).toContain("rpcDurationMs?: number");
  });

  test("records and filters frontend global traces", () => {
    expect(tracesView).toContain('value="global"');
    expect(tracesView).toContain('"frontend", "chat"');
    expect(tracesView).toContain("args.scope = scopeFilter()");
    expect(tracesApi).toContain('ApiCommand<"trace-frontend"');
    expect(tracesApi).toContain('callCommand("trace-search"');
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
    expect(tracesView).toContain('<span>{nodeTitle(root)}</span>');
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
    expect(tracesView).toContain('unwrap(api.traces.node({ id: trace.id }), "trace sidebar trace load")');
    expect(tracesView).toContain("revealHitInTree({ node: value.node, ancestors: value.ancestors })");
    expect(tracesView).toContain("await loadSubtree(ancestor.id, { focus: value.node.id, append: true, request })");
  });

  test("keeps detail input, output, and errors hash sections hidden when empty", () => {
    expect(tracesView).toContain('<Show when={state().node.inputHash}>');
    expect(tracesView).toContain('<HashBlock label="Input" hash={hash()}');
    expect(tracesView).toContain('<Show when={state().node.outputHash}>');
    expect(tracesView).toContain('<HashBlock label="Output" hash={hash()}');
    expect(tracesView).toContain('<Show when={state().node.errorHash}>');
    expect(tracesView).toContain('<HashBlock label="Errors" hash={hash()}');
    expect(tracesView).toContain('<DataBlock label="Trace data" value={state().node.dataJson}');
    expect(tracesView).toContain("api.objects.get(hash)");
    expect(tracesView).toContain("props.onOpenStore?.(hash())");
    expect(tracesView).not.toContain("api.traces.summary");
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

});
