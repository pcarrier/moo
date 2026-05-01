import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import { renderMarkdown } from "./markdown";

import { RightSidebarToggle } from "./Sidebar";
import type { Bag } from "./state";
import { api, type StoreObject, type Triple } from "./api";

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

// Two-level memory view: the index shows graphs grouped by category; opening
// a graph drills into its subjects rendered as Turtle blocks. Triples are
// still bucketed by graph+subject so blocks can be linked, scrolled to, and
// styled when focused.
export function MemoryView(props: { bag: Bag; onToggleSidebar?: () => void }) {
  const { bag } = props;
  let scrollEl: HTMLDivElement | undefined;

  const [search, setSearch] = createSignal("");
  const [page, setPage] = createSignal(1);
  const [pageSize, setPageSize] = createSignal(50);
  const [selectedGraph, setSelectedGraph] = createSignal<string | null>(bag.focusedGraph());
  const [previewHash, setPreviewHash] = createSignal<string | null>(null);
  const [previewObject, setPreviewObject] = createSignal<StoreObject>(null);
  const [previewLoading, setPreviewLoading] = createSignal(false);
  const [previewError, setPreviewError] = createSignal<string | null>(null);
  let previewSeq = 0;

  const refreshTriplesForMode = async (mode = bag.triplesRemovedMode()) => {
    await bag.refreshTriples(mode);
  };

  const openStorePreview = async (hash: string) => {
    const normalized = normalizeSha256(hash);
    setPreviewHash(normalized);
    setPreviewObject(null);
    setPreviewError(null);
    setPreviewLoading(true);
    const seq = ++previewSeq;
    const r = await api.objectGet(normalized);
    if (seq !== previewSeq) return;
    setPreviewLoading(false);
    if (r.ok) {
      setPreviewObject(r.value.object);
      if (!r.value.object) setPreviewError("object not found");
    } else {
      setPreviewError(r.error.message);
    }
  };

  const closeStorePreview = () => {
    previewSeq++;
    setPreviewHash(null);
    setPreviewObject(null);
    setPreviewError(null);
    setPreviewLoading(false);
  };

  const categories = createMemo(() => categorizeTriples(bag.triples() as Triple[]));

  // Graph index: collapse each category's subjects into a per-graph summary.
  const graphCategories = createMemo<CategoryWithGraphs[]>(() => {
    return categories().map((category) => {
      const byGraph = new Map<string, GraphSummary>();
      let factCount = 0;
      let subjectCount = 0;
      for (const group of category.groups) {
        let summary = byGraph.get(group.graph);
        if (!summary) {
          summary = {
            graph: group.graph,
            label: graphLabel(group.graph),
            factCount: 0,
            subjectCount: 0,
          };
          byGraph.set(group.graph, summary);
        }
        summary.factCount += group.count;
        summary.subjectCount += 1;
        factCount += group.count;
        subjectCount += 1;
      }
      const graphs = [...byGraph.values()].sort((a, b) => a.graph.localeCompare(b.graph));
      return {
        key: category.key,
        label: category.label,
        description: category.description,
        rank: category.rank,
        graphs,
        factCount,
        subjectCount,
      };
    });
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
    bag.triples();
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
  // /memory#<subject> links have no graph segment, so discover and publish it
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
          bag.showMemory(id, group.graph);
          return;
        }
      }
    }
  });

  // Clear search when switching between index and detail — terms targeted at
  // graph names rarely match subject content and vice versa, so leftover
  // queries just produce confusing empty states.
  const openGraph = (graph: string) => {
    setSearch("");
    bag.showMemory(null, graph);
  };
  const closeGraph = () => {
    setSearch("");
    bag.showMemory(null, null);
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
    <section class="main">
      <header class="conv-header facts-header">
        <div class="facts-header-main">
          <button
            class="collapse-btn mobile-nav-toggle"
            title="open sidebar"
            onClick={props.onToggleSidebar}
          >
            ☰
          </button>
          <button
            class="collapse-btn facts-back"
            title={selectedGraph() ? "back to graph list" : "back to chat"}
            onClick={() => (selectedGraph() ? closeGraph() : bag.showChat())}
          >
            ←
          </button>
          <div class="facts-title-block">
            <span class="facts-eyebrow">memory</span>
            <strong class="facts-title">
              <Show when={selectedGraph()} fallback="facts">
                facts <span class="facts-crumb">/ {selectedGraphLabel()}</span>
              </Show>
            </strong>
          </div>
          <div class="facts-summary" aria-label="facts summary">
            <Show
              when={selectedGraph()}
              fallback={
                <>
                  <span class="facts-stat-pill">
                    <strong>{search().trim() ? filteredGraphCount() : totalGraphs()}</strong>
                    <span>{search().trim() ? "matching graphs" : "graphs"}</span>
                  </span>
                  <span class="facts-stat-pill">
                    <strong>{bag.triples().length}</strong>
                    <span>facts</span>
                  </span>
                  <span class="facts-stat-pill">
                    <strong>{totalPredicates()}</strong>
                    <span>predicates</span>
                  </span>
                </>
              }
            >
              <span class="facts-stat-pill">
                <strong>{filteredFacts()}</strong>
                <span>{search().trim() ? "matching facts" : "facts"}</span>
              </span>
              <span class="facts-stat-pill">
                <strong>{filteredSubjects()}</strong>
                <span>{search().trim() ? "matching subjects" : "subjects"}</span>
              </span>
            </Show>
          </div>
        </div>

        <div class="facts-toolbar">
          <label class="facts-search facts-control">
            <span>Search</span>
            <input
              type="search"
              placeholder={selectedGraph() ? "subject, predicate, object…" : "graph name…"}
              value={search()}
              onInput={(event) => setSearch(event.currentTarget.value)}
            />
          </label>

          <div class="facts-actions">
            <RightSidebarToggle bag={bag} />
            <label class="facts-control facts-removed-mode">
              <span>Removed</span>
              <select
                value={bag.triplesRemovedMode()}
                onChange={(event) => {
                  const mode = event.currentTarget.value as RemovedMode;
                  bag.setTriplesRemovedMode(mode);
                  refreshTriplesForMode(mode);
                }}
              >
                <option value="exclude">hide</option>
                <option value="include">include</option>
                <option value="only">only</option>
              </select>
            </label>

            <Show when={selectedGraph()}>
              <label class="facts-control facts-page-size">
                <span>Per page</span>
                <select
                  value={pageSize()}
                  onChange={(event) => setPageSize(Number(event.currentTarget.value))}
                >
                  <For each={PAGE_SIZE_OPTIONS}>
                    {(size) => <option value={size}>{size}</option>}
                  </For>
                </select>
              </label>
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
      </header>
      <div class="memory-main" classList={{ "has-store-preview": !!previewHash() }}>
      <main class="timeline turtle" ref={scrollEl}>
        <Show
          when={selectedGraph()}
          fallback={
            <Show
              when={totalGraphs() > 0}
              fallback={<Show when={bag.triplesLoaded()}><div class="empty">no graphs yet</div></Show>}
            >
              <Show
                when={filteredGraphCount() > 0}
                fallback={<div class="empty">no graphs match <code>{search()}</code></div>}
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
              <div class="empty">
                <Show when={search().trim()} fallback={<>this graph is empty</>}>
                  no facts match <code>{search()}</code>
                </Show>
              </div>
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
                        onClick={() => bag.showMemory(group.subject, group.graph)}
                      >
                        <pre>
                          <TurtleBlock
                            group={group}
                            onOpenStore={openStorePreview}
                            onRemove={(predicate, object) => {
                              if (!confirm(`Delete this triple from ${group.graph}?`)) return;
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
      </main>
      <Show when={previewHash()}>
        <StorePreviewPanel
          hash={previewHash()!}
          object={previewObject()}
          loading={previewLoading()}
          error={previewError()}
          onClose={closeStorePreview}
        />
      </Show>
      </div>
    </section>
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
                  event.stopPropagation();
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

function StorePreviewPanel(props: {
  hash: string;
  object: StoreObject;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const preview = createMemo(() => classifyStorePreview(props.object));
  return (
    <aside class="store-preview" aria-label="store preview">
      <header class="store-preview-head">
        <div>
          <strong>store preview</strong>
          <code>{props.hash}</code>
        </div>
        <button type="button" class="icon-btn" title="close preview" onClick={props.onClose}>×</button>
      </header>
      <div class="store-preview-meta">
        <Show when={props.object} fallback={props.loading ? "loading…" : props.error ?? ""}>
          {props.object?.kind} · {formatBytes(storeObjectSize(props.object))}
        </Show>
      </div>
      <div class="store-preview-body">
        <Show when={!props.loading} fallback={<div class="empty">loading object…</div>}>
          <Show when={!props.error} fallback={<div class="empty">{props.error}</div>}>
            <Show when={props.object}>
              <StorePreviewContent preview={preview()} />
            </Show>
          </Show>
        </Show>
      </div>
    </aside>
  );
}

function StorePreviewContent(props: { preview: StorePreview }) {
  switch (props.preview.kind) {
    case "image":
      return <img class="store-preview-image" src={props.preview.src} alt="store object preview" />;
    case "html":
      return <iframe class="store-preview-frame" srcdoc={props.preview.content} sandbox="" />;
    case "markdown":
      return <div class="markdown" innerHTML={renderMarkdown(props.preview.content)} />;
    case "binary":
      return (
        <>
          <div class="empty">binary object · preview unavailable</div>
          <pre class="store-preview-text">{props.preview.content}</pre>
        </>
      );
    default:
      return <pre class="store-preview-text">{props.preview.content}</pre>;
  }
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

type StorePreview =
  | { kind: "empty"; content: string }
  | { kind: "image"; content: string; src: string }
  | { kind: "html" | "markdown" | "text" | "binary"; content: string; src?: never };

function classifyStorePreview(object: StoreObject): StorePreview {
  if (!object) return { kind: "empty", content: "" };
  const content = object.content ?? "";
  const hint = (object.kind || "").toLowerCase();
  const trimmed = content.trimStart();
  if (looksLikeImage(hint, content)) {
    return { kind: "image", content, src: imageSrc(hint, content, object.bytesBase64) };
  }
  if (hint.includes("html") || /^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return { kind: "html", content };
  }
  if (hint.includes("markdown") || hint.includes("text/x-markdown") || /(^|[/.+-])md($|[/.+-])/.test(hint) || looksLikeMarkdown(content)) {
    return { kind: "markdown", content };
  }
  if (hint.includes("octet-stream") || looksBinary(content) || looksBinaryBase64(object.bytesBase64)) {
    return { kind: "binary", content: binarySummary(object) };
  }
  return { kind: "text", content };
}

function looksLikeImage(hint: string, content: string): boolean {
  if (hint.includes("image") || /^image\//.test(hint)) return true;
  if (/^data:image\//i.test(content.trim())) return true;
  if (/^\s*<svg[\s>]/i.test(content)) return true;
  return false;
}

function imageSrc(hint: string, content: string, bytesBase64?: string): string {
  const trimmed = content.trim();
  if (/^data:image\//i.test(trimmed)) return trimmed;
  if (/^<svg[\s>]/i.test(trimmed)) return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(trimmed);
  const mime = /^image\/[a-z0-9.+-]+/i.test(hint) ? hint.match(/^image\/[a-z0-9.+-]+/i)![0] : "image/png";
  const b64 = (bytesBase64 || trimmed).replace(/\s+/g, "");
  return "data:" + mime + ";base64," + b64;
}

function looksLikeMarkdown(content: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s+|>\s+|\x60\x60\x60|\|.+\|)|\[[^\]]+\]\([^\)]+\)/.test(content);
}

function looksBinary(content: string): boolean {
  if (!content) return false;
  let suspicious = 0;
  const sample = content.slice(0, 4096);
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0 || (code < 9 || (code > 13 && code < 32))) suspicious++;
  }
  return suspicious / sample.length > 0.02;
}

function looksBinaryBase64(bytesBase64?: string): boolean {
  const bytes = bytesFromBase64(bytesBase64);
  return bytes ? looksBinaryBytes(bytes) : false;
}

function looksBinaryBytes(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  let suspicious = 0;
  const sample = bytes.slice(0, 4096);
  for (let i = 0; i < sample.length; i++) {
    const code = sample[i]!;
    if (code === 0 || (code < 9 || (code > 13 && code < 32))) suspicious++;
  }
  return suspicious / sample.length > 0.02;
}

function binarySummary(object: Exclude<StoreObject, null>): string {
  const bytes = bytesFromBase64(object.bytesBase64) ?? new TextEncoder().encode(object.content ?? "");
  const hex = Array.from(bytes.slice(0, 256), (b) => b.toString(16).padStart(2, "0")).join(" ");
  return formatBytes(bytes.length) + "\n\n" + hex + (bytes.length > 256 ? " …" : "");
}

function bytesFromBase64(bytesBase64?: string): Uint8Array | null {
  if (!bytesBase64) return null;
  try {
    const raw = atob(bytesBase64.replace(/\s+/g, ""));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function storeObjectSize(object: StoreObject): number {
  if (!object) return 0;
  if (typeof object.size === "number") return object.size;
  const bytes = bytesFromBase64(object.bytesBase64);
  if (bytes) return bytes.length;
  return new Blob([object.content ?? ""]).size;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  const kib = bytes / 1024;
  if (kib < 1024) return kib.toFixed(1) + " KiB";
  return (kib / 1024).toFixed(1) + " MiB";
}

// Lightweight Turtle tinting (matches the runJS/shell highlighter so the
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
  const marker = action === "remove" ? " # removed" : action === "add" ? " # added" : "";
  const when = at ? " @ " + new Date(Number(at)).toISOString() : "";
  return "    " + predTerm + " " + formatObjectForMemory(obj) + sep + marker + when;
}

// The backend stores objects already in canonical Turtle form (see
// `encodeObject` in harness/src/moo.ts). Don't re-encode — just detect the
// shape and pass through. Only fall back to string-literal encoding for
// values that look like raw, unencoded text (which shouldn't normally happen).
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
