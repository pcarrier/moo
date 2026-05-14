import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";

import type { Bag } from "./state";
import { type Triple } from "./api";
import { ControlField, EmptyState, PageBody, PageHeader, PageToolbar, StatPill, ToolbarSection } from "./PageChrome";
import { LoadingDots } from "./LoadingDots";
import { RefreshIcon } from "./icons";

const PAGE_SIZE_OPTIONS = [25, 50, 100, 250];
const SHA256_RE = /sha256:[a-f0-9]{64}/gi;
const MAX_MEMORY_STRING_CHARS = 240;

type RemovedMode = "exclude" | "include" | "only";

const PREFIX_DECLS = [
  "@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .",
  "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
  "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .",
  "@prefix agent: <urn:moo:agent:> .",
  "@prefix ui: <urn:moo:ui:> .",
  "@prefix memory: <urn:moo:memory:> .",
  "@prefix vocab: <urn:moo:vocab:> .",
];

type SubjectGroup = {
  graph: string;
  subject: string;
  props: Array<[string, string, string?, string?]>;
  count: number;
};

type FactCategory = {
  key: string;
  label: string;
  description: string;
  rank: number;
  count: number;
  groups: SubjectGroup[];
};

type GraphSummaryRow = [string, number, number];

type GraphSummary = {
  graph: string;
  label: string;
  factCount: number;
  subjectCount: number;
};

type CategoryWithGraphs = {
  key: string;
  label: string;
  description: string;
  rank: number;
  graphs: GraphSummary[];
  factCount: number;
  subjectCount: number;
};

// Two-level facts view: the index shows graphs grouped by category; opening
// a graph drills into its subjects rendered as Turtle blocks. Triples are
// still bucketed by graph+subject so blocks can be linked, scrolled to, and
// styled when focused.
export function FactsView(props: { bag: Bag; onToggleSidebar?: () => void }) {
  const { bag } = props;
  let scrollEl: HTMLElement | undefined;

  const [search, setSearch] = createSignal("");
  const [page, setPage] = createSignal(1);
  const [pageSize, setPageSize] = createSignal(50);
  const [selectedGraph, setSelectedGraph] = createSignal<string | null>(bag.focusedGraph());

  const refreshFactsForMode = async (mode = bag.triplesRemovedMode(), graph = selectedGraph()) => {
    if (graph) await bag.refreshTriples(mode, graph);
    else await bag.refreshGraphSummaries(mode);
  };

  const categories = createMemo(() => categorizeTriples(bag.triples() as Triple[]));

  // Graph index: use backend summaries so the index can show every graph without
  // materializing every fact in the browser first.
  const graphCategories = createMemo<CategoryWithGraphs[]>(() => {
    const byCategory = new Map<string, CategoryWithGraphs>();
    for (const [graph, factCount, subjectCount] of bag.graphSummaries() as GraphSummaryRow[]) {
      const info = categoryFor(graph);
      let category = byCategory.get(info.key);
      if (!category) {
        category = { ...info, graphs: [], factCount: 0, subjectCount: 0 };
        byCategory.set(info.key, category);
      }
      category.graphs.push({ graph, label: graphLabel(graph), factCount, subjectCount });
      category.factCount += factCount;
      category.subjectCount += subjectCount;
    }
    return [...byCategory.values()]
      .map((category) => ({
        ...category,
        graphs: category.graphs.sort((a, b) => a.graph.localeCompare(b.graph)),
      }))
      .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  });

  // Filter the index by search terms (matches against graph labels and
  // category labels). When viewing a single graph, search filters within
  // that graph's subjects/predicates/objects instead.
  const filteredGraphCategories = createMemo<CategoryWithGraphs[]>(() => {
    const terms = search()
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (terms.length === 0) return graphCategories();
    return graphCategories()
      .map((category) => {
        const graphs = category.graphs.filter((g) => {
          const haystack = (
            category.label +
            "\n" +
            category.description +
            "\n" +
            g.graph +
            "\n" +
            g.label
          ).toLowerCase();
          return terms.every((t) => haystack.includes(t));
        });
        if (graphs.length === 0) return null;
        return {
          ...category,
          graphs,
          factCount: graphs.reduce((s, g) => s + g.factCount, 0),
          subjectCount: graphs.reduce((s, g) => s + g.subjectCount, 0),
        };
      })
      .filter((c): c is CategoryWithGraphs => c !== null);
  });

  const totalGraphs = createMemo(() =>
    graphCategories().reduce((sum, c) => sum + c.graphs.length, 0),
  );
  const totalPredicates = createMemo(() => new Set(bag.triples().map((row) => row[2])).size);
  const filteredGraphCount = createMemo(() =>
    filteredGraphCategories().reduce((sum, c) => sum + c.graphs.length, 0),
  );

  // Graph-detail view: derive the categorized groups for the selected graph
  // alone, then run the existing search/pagination logic over them.
  const detailCategories = createMemo<FactCategory[]>(() => {
    const g = selectedGraph();
    if (!g) return [];
    return categories()
      .map((category) => {
        const groups = category.groups.filter((group) => group.graph === g);
        if (groups.length === 0) return null;
        return {
          ...category,
          groups,
          count: groups.reduce((s, gr) => s + gr.count, 0),
        };
      })
      .filter((c): c is FactCategory => c !== null);
  });
  const filteredDetailCategories = createMemo(() =>
    filterCategories(detailCategories(), search()),
  );
  const filteredFacts = createMemo(() =>
    filteredDetailCategories().reduce((sum, category) => sum + category.count, 0),
  );
  const filteredSubjects = createMemo(() =>
    filteredDetailCategories().reduce((sum, category) => sum + category.groups.length, 0),
  );
  const pageCount = createMemo(() =>
    Math.max(1, Math.ceil(filteredSubjects() / pageSize())),
  );
  const visibleCategories = createMemo(() =>
    paginateCategories(filteredDetailCategories(), page(), pageSize()),
  );

  createEffect(() => {
    search();
    pageSize();
    bag.triplesRemovedMode();
    selectedGraph();
    setPage(1);
  });

  createEffect(() => {
    const maxPage = pageCount();
    const current = page();
    if (current > maxPage) setPage(maxPage);
    else if (current < 1) setPage(1);
  });

  // Keep the local graph selection in sync with the routed graph. Legacy
  // /facts#<subject> links have no graph segment, so discover and publish it
  // once triples are available.
  createEffect(() => {
    const routedGraph = bag.focusedGraph();
    setSelectedGraph(routedGraph);
  });
  createEffect(() => {
    const id = bag.focusedSubject();
    if (!id || bag.focusedGraph()) return;
    for (const cat of categories()) {
      for (const group of cat.groups) {
        if (group.subject === id) {
          bag.showFacts(id, group.graph);
          return;
        }
      }
    }
  });

  // Clear search when switching between index and detail — terms targeted at
  // graph names rarely match subject content and vice versa, so leftover
  // queries just produce confusing empty states.
  const openGraph = async (graph: string) => {
    setSearch("");
    bag.showFacts(null, graph);
  };
  const scrollToFocus = () => {
    const id = bag.focusedSubject();
    if (!id || !scrollEl) return;
    const blocks = Array.from(
      scrollEl.querySelectorAll<HTMLElement>(".turtle-block"),
    );
    const target = blocks.find((el) => el.dataset.subject === id);
    if (target) target.scrollIntoView({ block: "center" });
  };
  onMount(scrollToFocus);
  createEffect(() => {
    bag.focusedSubject();
    bag.triples();
    selectedGraph();
    scrollToFocus();
  });

  const selectedGraphLabel = createMemo(() => {
    const g = selectedGraph();
    return g ? graphLabel(g) : "";
  });

  return (
    <section class="main conversation-main memory-view facts-view">
      <PageHeader
        bag={bag}
        class="memory-header facts-header"
        title={selectedGraph() ? "Facts / " + selectedGraphLabel() : "Facts"}
        onToggleSidebar={props.onToggleSidebar}
        showRightSidebarToggle
      />

      <PageToolbar class="memory-toolbar facts-toolbar">
        <ToolbarSection class="facts-summary" ariaLabel="summary">
          <Show
            when={selectedGraph()}
            fallback={
              <>
                <Show
                  when={bag.graphSummariesLoaded()}
                  fallback={
                    <>
                      <StatPill value="loading" label={search().trim() ? "matching graphs" : "graphs"} />
                      <StatPill value="loading" label="facts" />
                      <StatPill value={totalPredicates()} label="predicates" />
                    </>
                  }
                >
                  <StatPill value={search().trim() ? filteredGraphCount() : totalGraphs()} label={search().trim() ? "matching graphs" : "graphs"} />
                  <StatPill value={graphCategories().reduce((sum, c) => sum + c.factCount, 0)} label="facts" />
                  <StatPill value={totalPredicates()} label="predicates" />
                </Show>
              </>
            }
          >
            <StatPill value={filteredFacts()} label={search().trim() ? "matching facts" : "facts"} />
            <StatPill value={filteredSubjects()} label={search().trim() ? "matching subjects" : "subjects"} />
          </Show>
        </ToolbarSection>

        <div class="facts-filterbar">
          <ControlField class="facts-search" label="Search">
            <input
              type="search"
              placeholder={selectedGraph() ? "subject, predicate, object…" : "graph…"}
              value={search()}
              onInput={(event) => setSearch(event.currentTarget.value)}
            />
          </ControlField>

          <div class="facts-actions">
            <ControlField class="facts-removed-mode" label="Removed">
              <select
                value={bag.triplesRemovedMode()}
                onChange={(event) => {
                  const mode = event.currentTarget.value as RemovedMode;
                  bag.setTriplesRemovedMode(mode);
                  refreshFactsForMode(mode);
                }}
              >
                <option value="exclude">hide</option>
                <option value="include">include</option>
                <option value="only">only</option>
              </select>
            </ControlField>

            <Show when={selectedGraph()}>
              <ControlField class="facts-page-size" label="Per page">
                <select
                  value={pageSize()}
                  onChange={(event) => setPageSize(Number(event.currentTarget.value))}
                >
                  <For each={PAGE_SIZE_OPTIONS}>
                    {(size) => <option value={size}>{size}</option>}
                  </For>
                </select>
              </ControlField>
              <div class="facts-pager" aria-label="facts pagination">
                <button
                  type="button"
                  class="icon-btn"
                  title="previous facts page"
                  disabled={page() <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  ‹
                </button>
                <span>
                  {page()} / {pageCount()}
                </span>
                <button
                  type="button"
                  class="icon-btn"
                  title="next facts page"
                  disabled={page() >= pageCount()}
                  onClick={() => setPage((value) => Math.min(pageCount(), value + 1))}
                >
                  ›
                </button>
              </div>
            </Show>
          </div>
        </div>
      </PageToolbar>

      <div class="memory-main">
      <Show when={selectedGraph() && bag.triplesLoaded() && bag.triplesTruncated()}>
        <div class="facts-limit-note">
          Showing {bag.triples().length} of {bag.triplesTotal() ?? "many"} facts in this graph to keep the browser responsive. Use search to narrow the view.
        </div>
      </Show>
      <PageBody class="turtle" ref={(el) => { scrollEl = el; }}>
        <Show
          when={selectedGraph()}
          fallback={
            <Show
              when={totalGraphs() > 0}
              fallback={
                <Show
                  when={bag.graphSummariesLoaded()}
                  fallback={
                    <div class="facts-loading-centered">
                      <LoadingDots label="loading facts" />
                    </div>
                  }
                >
                  <EmptyState>no graphs yet</EmptyState>
                </Show>
              }
            >
              <Show
                when={filteredGraphCount() > 0}
                fallback={<EmptyState>no graphs match <code>{search()}</code></EmptyState>}
              >
                <For each={filteredGraphCategories()}>
                  {(category) => (
                    <section class="turtle-category">
                      <header class="turtle-category-head">
                        <div>
                          <strong>{category.label}</strong>
                          <small>{category.description}</small>
                        </div>
                        <span>
                          {category.factCount} facts · {category.subjectCount} subjects
                        </span>
                      </header>
                      <ul class="graph-list">
                        <For each={category.graphs}>
                          {(g) => (
                            <li class="graph-row-wrap">
                              <button
                                type="button"
                                class="graph-row"
                                onClick={() => openGraph(g.graph)}
                              >
                                <span class="graph-row-label">{g.label}</span>
                                <span class="graph-row-meta">
                                  {g.subjectCount} subject{g.subjectCount === 1 ? "" : "s"} ·{" "}
                                  {g.factCount} fact{g.factCount === 1 ? "" : "s"}
                                </span>
                              </button>
                              <button
                                type="button"
                                class="icon-btn graph-remove"
                                title={`delete ${g.graph}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  bag.removeGraph(g.graph);
                                }}
                              >
                                ×
                              </button>
                            </li>
                          )}
                        </For>
                      </ul>
                    </section>
                  )}
                </For>
              </Show>
            </Show>
          }
        >
          <pre class="turtle-prefixes">{PREFIX_DECLS.join("\n")}</pre>
          <Show
            when={visibleCategories().length > 0}
            fallback={
              <Show
                when={bag.triplesLoaded()}
                fallback={
                  <div class="facts-loading-centered">
                    <LoadingDots label="loading facts" />
                  </div>
                }
              >
                <div class="empty">
                  <Show when={search().trim()} fallback={<>this graph is empty</>}>
                    no facts match <code>{search()}</code>
                  </Show>
                </div>
              </Show>
            }
          >
            <For each={visibleCategories()}>
              {(category) => (
                <section class="turtle-category">
                  <For each={category.groups}>
                    {(group) => (
                      <article
                        class="turtle-block"
                        id={anchorFor(group.graph, group.subject)}
                        data-subject={group.subject}
                        data-graph={group.graph}
                        classList={{ focused: group.subject === bag.focusedSubject() }}
                        onClick={() => bag.showFacts(group.subject, group.graph)}
                      >
                        <button
                          type="button"
                          class="turtle-subject-action"
                          title="delete subject"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            event.stopImmediatePropagation?.();
                            void bag.removeSubject(group.graph, group.subject);
                          }}
                        >
                          × subject
                        </button>
                        <pre>
                          <TurtleBlock
                            group={group}
                            onOpenStore={(hash) => void bag.openStorePreviewInSidebar(hash)}
                            onRemove={(predicate, object) => {
                              bag.removeTriple(group.graph, group.subject, predicate, object);
                            }}
                            onRestore={(predicate, object) => {
                              bag.restoreTriple(group.graph, group.subject, predicate, object);
                            }}
                          />
                        </pre>
                      </article>
                    )}
                  </For>
                </section>
              )}
            </For>
          </Show>
        </Show>
      </PageBody>
      </div>
    </section>
  );
}


type PointerTreeNode = {
  name: string;
  path: string;
  target: string | null;
  children: Map<string, PointerTreeNode>;
};

function cleanPointerText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function isRenderablePointerName(name: string): boolean {
  return name.trim().length > 0 && !/\[object\s+Promise\]/i.test(name);
}

function pointerTree(entries: Array<[unknown, unknown]>): PointerTreeNode {
  const root: PointerTreeNode = { name: "", path: "", target: null, children: new Map() };
  for (const entry of entries) {
    const name = cleanPointerText(entry[0]);
    if (!isRenderablePointerName(name)) continue;
    const target = cleanPointerText(entry[1]);
    const parts = name.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let node = root;
    let path = "";
    for (const part of parts) {
      path = path ? path + "/" + part : part;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path, target: null, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.target = target;
  }
  return root;
}

function pointerChildren(node: PointerTreeNode): PointerTreeNode[] {
  return Array.from(node.children.values()).sort((a, b) => {
    const aDir = a.children.size > 0;
    const bDir = b.children.size > 0;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

function pointerLeafCount(node: PointerTreeNode): number {
  let count = node.target ? 1 : 0;
  for (const child of node.children.values()) count += pointerLeafCount(child);
  return count;
}

function pointerGroupCount(node: PointerTreeNode): number {
  return pointerChildren(node).filter((child) => child.children.size > 0).length;
}

function isSha256Value(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/i.test(value.trim());
}

type PointerJsonPreview = { label: string; title: string };

function summarizePointerJson(value: unknown, depth = 0): string {
  if (value == null) return String(value);
  if (typeof value === "string") return JSON.stringify(value.length > 32 ? value.slice(0, 32) + "…" : value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return depth > 0 ? `[${value.length}]` : `[${value.slice(0, 3).map((item) => summarizePointerJson(item, depth + 1)).join(", ")}${value.length > 3 ? ", …" : ""}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (depth > 0) return `{${entries.length}}`;
    return `{ ${entries.slice(0, 3).map(([key, item]) => `${key}: ${summarizePointerJson(item, depth + 1)}`).join(", ")}${entries.length > 3 ? ", …" : ""} }`;
  }
  return String(value);
}

function pointerJsonPreview(target: string): PointerJsonPreview | null {
  if (!target.startsWith("json:")) return null;
  const raw = target.slice("json:".length);
  try {
    const value = JSON.parse(raw);
    return {
      label: `json:${summarizePointerJson(value)}`,
      title: JSON.stringify(value, null, 2),
    };
  } catch {
    return { label: target.length > 160 ? target.slice(0, 160) + "…" : target, title: target };
  }
}

function PointerTree(props: {
  node: PointerTreeNode;
  bag: Bag;
  expanded: () => Set<string>;
  setExpanded: (updater: (expanded: Set<string>) => Set<string>) => void;
  depth?: number;
  expandAll?: boolean;
}) {
  return (
    <ul class="pointer-tree">
      <For each={pointerChildren(props.node)}>
        {(node) => (
          <PointerTreeItem
            node={node}
            bag={props.bag}
            depth={props.depth ?? 0}
            expandAll={props.expandAll ?? false}
            expanded={props.expanded}
            setExpanded={props.setExpanded}
          />
        )}
      </For>
    </ul>
  );
}

function PointerTarget(props: { target: string; bag: Bag }) {
  const open = (event: MouseEvent) => {
    // Pointer rows for branches live inside <summary>. Without stopping the
    // event, some browsers treat the click as a summary toggle instead of a
    // request to open the object preview.
    event.preventDefault();
    event.stopPropagation();
    if (props.target.startsWith("json:")) {
      props.bag.openJsonPreviewInSidebar(props.target);
      return;
    }
    void props.bag.openStorePreviewInSidebar(props.target);
  };
  return (
    <Show
      when={isSha256Value(props.target)}
      fallback={
        <Show
          when={pointerJsonPreview(props.target)}
          fallback={<code class="pointer-target">{props.target}</code>}
        >
          {(preview) => (
            <button
              type="button"
              class="store-link pointer-target pointer-target-link pointer-target-json"
              onClick={open}
              title={`${preview().title}\n\nopen JSON in sidebar`}
            >
              {preview().label}
            </button>
          )}
        </Show>
      }
    >
      <button type="button" class="store-link pointer-target pointer-target-link" onClick={open} title="open object in right sidebar">
        {props.target}
      </button>
    </Show>
  );
}

function PointerTreeItem(props: {
  node: PointerTreeNode;
  bag: Bag;
  depth: number;
  expandAll: boolean;
  expanded: () => Set<string>;
  setExpanded: (updater: (expanded: Set<string>) => Set<string>) => void;
}) {
  const hasChildren = () => props.node.children.size > 0;
  const hasTarget = () => props.node.target !== null;
  const isOpen = () => props.expandAll || props.expanded().has(props.node.path);
  const deleteExact = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void props.bag.removePointer(props.node.path);
  };
  const deleteHierarchy = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void props.bag.removePointer(props.node.path, true);
  };
  const setOpen = (open: boolean) => {
    if (props.expandAll) return;
    props.setExpanded((expanded) => {
      const next = new Set(expanded);
      if (open) next.add(props.node.path);
      else next.delete(props.node.path);
      return next;
    });
  };
  const row = () => (
    <div
      class="pointer-row"
      classList={{ "is-branch": hasChildren(), "is-leaf": !hasChildren(), "has-target": hasTarget() }}
      style={{ "--pointer-depth": String(props.depth) }}
    >
      <div class="pointer-row-main">
        <div class="pointer-name-block">
          <Show when={hasChildren()}>
            <span class="pointer-disclosure" aria-hidden="true" />
          </Show>
          <code class="pointer-name">{props.node.name}</code>
        </div>
        <div class="pointer-value-cell">
          <Show
            when={props.node.target}
            fallback={
              <span class="pointer-child-count">
                {pointerLeafCount(props.node)} pointer{pointerLeafCount(props.node) === 1 ? "" : "s"}
              </span>
            }
          >
            {(target) => <><span class="pointer-arrow">→</span><PointerTarget target={target()} bag={props.bag} /></>}
          </Show>
        </div>
      </div>
      <Show when={hasTarget() || hasChildren()}>
        <div class="pointer-actions">
          <Show when={hasTarget()}>
            <button
              type="button"
              class="icon-btn pointer-remove"
              title="delete pointer"
              aria-label={`delete pointer ${props.node.name}`}
              onClick={deleteExact}
            >
              ×
            </button>
          </Show>
          <Show when={hasChildren()}>
            <button
              type="button"
              class="icon-btn pointer-remove pointer-remove-tree"
              title="delete pointer hierarchy"
              aria-label={`delete pointer hierarchy ${props.node.name}`}
              onClick={deleteHierarchy}
            >
              ⨯/
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
  return (
    <li classList={{ "pointer-tree-item": true, "has-children": hasChildren() }}>
      <Show when={hasChildren()} fallback={row()}>
        <details open={isOpen()} onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary>{row()}</summary>
          <PointerTree
            node={props.node}
            bag={props.bag}
            depth={props.depth + 1}
            expandAll={props.expandAll}
            expanded={props.expanded}
            setExpanded={props.setExpanded}
          />
        </details>
      </Show>
    </li>
  );
}

export function PointersView(props: { bag: Bag; onToggleSidebar?: () => void }) {
  const { bag } = props;
  const [search, setSearch] = createSignal("");
  const [expandedPointers, setExpandedPointers] = createSignal<Set<string>>(new Set());
  const filteredPointers = createMemo(() => {
    const terms = search().trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = bag.pointers();
    const renderable = rows.filter(([name]) => isRenderablePointerName(cleanPointerText(name)));
    if (terms.length === 0) return renderable;
    return renderable.filter(([name, target]) => {
      const haystack = (cleanPointerText(name) + "\n" + cleanPointerText(target)).toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  });
  const tree = createMemo(() => pointerTree(filteredPointers() as Array<[unknown, unknown]>));
  const rootGroups = createMemo(() => pointerGroupCount(tree()));
  const visibleCount = createMemo(() => filteredPointers().length);
  const totalCount = createMemo(() => bag.pointers().length);
  const isSearching = createMemo(() => search().trim().length > 0);

  onMount(() => {
    bag.refreshPointers();
  });

  return (
    <div class="main conversation-main memory-view facts-view pointers-view">
      <PageHeader
        bag={bag}
        class="memory-header facts-header pointers-header"
        title="Pointers"
        onToggleSidebar={props.onToggleSidebar}
        showRightSidebarToggle
      />
      <PageToolbar class="memory-toolbar facts-toolbar pointers-toolbar">
          <ToolbarSection class="facts-summary pointers-summary" ariaLabel="summary">
            <Show
              when={bag.pointersLoaded()}
              fallback={<StatPill value="loading" label={isSearching() ? "matches" : "pointers"} />}
            >
              <StatPill value={isSearching() ? visibleCount() : totalCount()} label={isSearching() ? "matches" : "pointers"} />
            </Show>
            <StatPill value={rootGroups()} label="groups" />
          </ToolbarSection>
          <ControlField class="facts-search pointers-search" label="Search">
            <input type="search" placeholder="name, prefix, hash, or target…" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} />
          </ControlField>
          <div class="pointers-toolbar-actions">
            <Show when={isSearching()}>
              <button type="button" class="secondary small" onClick={() => setSearch("")}>clear</button>
            </Show>
            <button type="button" class="secondary small icon-button" title="refresh pointers" aria-label="refresh pointers" onClick={() => void bag.refreshPointers()}><RefreshIcon /></button>
          </div>
      </PageToolbar>
      <div class="memory-main">
        <PageBody class="turtle">
          <Show
            when={bag.pointersLoaded()}
            fallback={
              <div class="facts-loading-centered">
                <LoadingDots label="loading pointers" />
              </div>
            }
          >
            <section class="turtle-category memory-pointers-section">
              <header class="turtle-category-head pointers-list-head">
                <div>
                  <strong>{isSearching() ? "Matches" : "Pointer groups"}</strong>
                  <small>{isSearching() ? "expanded results matching the current search" : "slash-delimited namespaces; open a group to inspect children"}</small>
                </div>
                <span>{visibleCount()} pointer{visibleCount() === 1 ? "" : "s"}</span>
              </header>
              <Show
                when={visibleCount() > 0}
                fallback={
                  <EmptyState class="pointer-empty">{isSearching() ? "no matching pointers" : "no pointers yet"}</EmptyState>
                }
              >
                <PointerTree
                  node={tree()}
                  bag={bag}
                  expandAll={search().trim().length > 0}
                  expanded={expandedPointers}
                  setExpanded={setExpandedPointers}
                />
              </Show>
            </section>
          </Show>
        </PageBody>
      </div>
    </div>
  );
}

function TurtleBlock(props: {
  group: SubjectGroup;
  onOpenStore: (hash: string) => void;
  onRemove: (predicate: string, object: string) => void;
  onRestore: (predicate: string, object: string) => void;
}) {
  return (
    <>
      <TurtleLine text={props.group.subject} onOpenStore={props.onOpenStore} />
      <For each={props.group.props}>
        {(prop, index) => {
          const [predicate, object, action] = prop;
          const line = turtlePropLine(prop, index() + 1 === props.group.props.length);
          const removed = action === "remove";
          return (
            <span class="turtle-line" classList={{ "is-removed": removed }}>
              <TurtleLine text={line} onOpenStore={props.onOpenStore} />
              <button
                type="button"
                class="turtle-row-action"
                title={removed ? "undelete triple" : "delete triple"}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  event.stopImmediatePropagation?.();
                  removed ? props.onRestore(predicate, object) : props.onRemove(predicate, object);
                }}
              >
                {removed ? "↺" : "×"}
              </button>
            </span>
          );
        }}
      </For>
    </>
  );
}

function TurtleLine(props: { text: string; onOpenStore: (hash: string) => void }) {
  return (
    <>
      <For each={linkifyHighlightedTurtle(props.text)}>
        {(part) =>
          part.hash ? (
            <button
              type="button"
              class="store-link ttl-pn"
              title="open store preview"
              onClick={(event) => {
                event.stopPropagation();
                props.onOpenStore(part.hash!);
              }}
            >
              {part.text}
            </button>
          ) : (
            <span innerHTML={part.html} />
          )
        }
      </For>
    </>
  );
}


function filterCategories(categories: FactCategory[], query: string): FactCategory[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return categories;

  return categories
    .map((category) => {
      const groups = category.groups.filter((group) =>
        matchesGroup(category, group, terms),
      );
      if (groups.length === 0) return undefined;
      return {
        ...category,
        groups,
        count: groups.reduce((sum, group) => sum + group.count, 0),
      };
    })
    .filter((category): category is FactCategory => Boolean(category));
}

function matchesGroup(
  category: FactCategory,
  group: SubjectGroup,
  terms: string[],
): boolean {
  const haystack = [
    category.label,
    category.description,
    group.graph,
    graphLabel(group.graph),
    group.subject,
    ...group.props.flatMap(([predicate, object, action, at]) => [
      predicate,
      object,
      action ?? "",
      at ? new Date(Number(at)).toISOString() : "",
    ]),
  ]
    .join("\n")
    .toLowerCase();

  return terms.every((term) => haystack.includes(term));
}

function paginateCategories(
  categories: FactCategory[],
  page: number,
  pageSize: number,
): FactCategory[] {
  let offset = (page - 1) * pageSize;
  let remaining = pageSize;
  const visible: FactCategory[] = [];

  for (const category of categories) {
    if (remaining <= 0) break;
    if (offset >= category.groups.length) {
      offset -= category.groups.length;
      continue;
    }

    const groups = category.groups.slice(offset, offset + remaining);
    visible.push({
      ...category,
      groups,
      count: groups.reduce((sum, group) => sum + group.count, 0),
    });
    remaining -= groups.length;
    offset = 0;
  }

  return visible;
}

function categorizeTriples(triples: Triple[]): FactCategory[] {
  const categories = new Map<string, FactCategory>();
  const subjects = new Map<string, SubjectGroup>();

  for (const [graph, subject, predicate, object, action, at] of triples) {
    const info = categoryFor(graph);
    let category = categories.get(info.key);
    if (!category) {
      category = { ...info, count: 0, groups: [] };
      categories.set(info.key, category);
    }

    const subjectKey = info.key + "\u0000" + graph + "\u0000" + subject;
    let group = subjects.get(subjectKey);
    if (!group) {
      group = { graph, subject, props: [], count: 0 };
      subjects.set(subjectKey, group);
      category.groups.push(group);
    }
    group.props.push([predicate, object, action, at]);
    group.count++;
    category.count++;
  }

  return [...categories.values()]
    .map((category) => ({
      ...category,
      groups: category.groups.sort(
        (a, b) =>
          a.graph.localeCompare(b.graph) || a.subject.localeCompare(b.subject),
      ),
    }))
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

function categoryFor(graph: string): Omit<FactCategory, "count" | "groups"> {
  if (graph === "memory:facts") {
    return {
      key: "memory",
      label: "memory facts",
      description: "global user-wide memory/facts, current facts by default",
      rank: 10,
    };
  }
  if (graph.startsWith("memory:project/")) {
    return {
      key: "project",
      label: "project facts",
      description: "per-project memory/project/*/facts, current facts by default",
      rank: 20,
    };
  }
  if (graph === "vocab:facts") {
    return {
      key: "vocabulary",
      label: "predicate facts",
      description: "declared predicate metadata from vocab/facts, current definitions by default",
      rank: 30,
    };
  }
  if (graph.startsWith("chat:")) {
    return {
      key: "chat",
      label: "chat turns",
      description: "all known conversation steps, tool calls, UI requests, and replies",
      rank: 40,
    };
  }
  return {
    key: "other",
    label: "other facts",
    description: "uncategorized fact graphs",
    rank: 90,
  };
}

function graphLabel(graph: string): string {
  if (graph.startsWith("memory:project/")) {
    return decodeGraphSuffix(graph, "memory:project/");
  }
  return graph;
}

function decodeGraphSuffix(graph: string, prefix: string): string {
  const raw = graph.slice(prefix.length);
  try {
    return prefix + decodeURIComponent(raw);
  } catch {
    return graph;
  }
}

function anchorFor(graph: string, subject: string): string {
  return "subj-" + (graph + "-" + subject).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normalizeSha256(hash: string): string {
  const trimmed = hash.trim().toLowerCase();
  return trimmed.startsWith("sha256:") ? trimmed : "sha256:" + trimmed;
}

type HighlightPart = { html: string; text?: never; hash?: never } | { text: string; hash: string; html?: never };

function linkifyHighlightedTurtle(text: string): HighlightPart[] {
  const parts: HighlightPart[] = [];
  SHA256_RE.lastIndex = 0;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = SHA256_RE.exec(text)) !== null) {
    if (match.index > last) {
      parts.push({ html: highlightTurtleBlock(text.slice(last, match.index)) });
    }
    const token = match[0]!;
    parts.push({ text: token, hash: normalizeSha256(token) });
    last = match.index + token.length;
  }
  if (last < text.length) parts.push({ html: highlightTurtleBlock(text.slice(last)) });
  return parts.length ? parts : [{ html: highlightTurtleBlock(text) }];
}

// Lightweight Turtle tinting (matches the runTS/shell highlighter so the
// look is consistent with the rest of the timeline).
export function highlightTurtleBlock(text: string): string {
  const tokens: Array<[RegExp, string]> = [
    [/(@prefix|@base|a)\b/g, "ttl-kw"],
    [/<[^>\s]+>/g, "ttl-iri"],
    [/"(?:[^"\\]|\\.)*"(?:@[a-z][a-zA-Z0-9-]*|\^\^[A-Za-z][A-Za-z0-9_-]*:[^\s]+)?/g, "ttl-str"],
    [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, "ttl-num"],
    [/\btrue\b|\bfalse\b/g, "ttl-bool"],
    [/[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9_:.-]*/g, "ttl-pn"],
    [/#[^\n]*/g, "ttl-comment"],
  ];
  type Span = { start: number; end: number; cls: string };
  const spans: Span[] = [];
  for (const [re, cls] of tokens) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0]!.length;
      if (spans.some((s) => start < s.end && end > s.start)) continue;
      spans.push({ start, end, cls });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  let out = "";
  let i = 0;
  for (const s of spans) {
    if (i < s.start) out += escapeHtml(text.slice(i, s.start));
    out += '<span class="' + s.cls + '">' + escapeHtml(text.slice(s.start, s.end)) + "</span>";
    i = s.end;
  }
  out += escapeHtml(text.slice(i));
  return out;
}

function turtlePropLine(prop: [string, string, string?, string?], isLast: boolean): string {
  const [pred, obj, action, at] = prop;
  const sep = isLast ? " ." : " ;";
  const predTerm = pred === "rdf:type" ? "a" : pred;
  const marker = action === "remove" ? "removed" : action === "add" ? "added" : "";
  const when = formatFactTimestamp(at);
  const comment = [marker, when].filter(Boolean).join(" · ");
  return "    " + predTerm + " " + formatObjectForMemory(obj) + sep + (comment ? " # " + comment : "");
}

// The backend stores objects already in canonical Turtle form (see
// `encodeObject` in harness/src/moo.ts). Don't re-encode — just detect the
// shape and pass through. Only fall back to string-literal encoding for
// values that look like raw, unencoded text (which shouldn't normally happen).
function formatFactTimestamp(at?: string): string {
  if (!at) return "";
  const ms = Number(at);
  if (!Number.isFinite(ms)) return at;
  return new Date(ms).toISOString();
}

function formatObjectForMemory(value: string): string {
  return elideTurtleLiteral(formatObject(value));
}

function formatObject(value: string): string {
  if (/^[A-Za-z][A-Za-z0-9_-]*:[^\s]+$/.test(value)) return value; // prefix:local
  if (/^<[^>\s]+>$/.test(value)) return value; // <full-iri>
  if (/^-?\d+$/.test(value)) return value;
  if (/^-?\d+\.\d+$/.test(value)) return value;
  if (/^-?\d+(?:\.\d+)?[eE][+-]?\d+$/.test(value)) return value;
  if (value === "true" || value === "false") return value;
  // Already-encoded Turtle string literal: "..." with optional @lang or ^^type.
  if (
    /^"(?:[^"\\]|\\.)*"(?:@[a-z][a-zA-Z0-9-]*|\^\^(?:<[^>\s]+>|[A-Za-z][A-Za-z0-9_-]*:[^\s]+))?$/.test(
      value,
    )
  ) {
    return value;
  }
  let out = '"';
  for (const ch of value) {
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out + '"';
}

function elideTurtleLiteral(value: string): string {
  const match = value.match(/^"((?:[^"\\]|\\.)*)"(.*)$/s);
  if (!match) return value;
  const body = match[1]!;
  if (body.length <= MAX_MEMORY_STRING_CHARS) return value;
  const suffix = match[2] ?? "";
  const head = body.slice(0, Math.floor(MAX_MEMORY_STRING_CHARS * 0.65));
  const tail = body.slice(-Math.floor(MAX_MEMORY_STRING_CHARS * 0.25));
  const omitted = body.length - head.length - tail.length;
  return `"${head}…[${omitted} chars elided]…${tail}"${suffix}`;
}
