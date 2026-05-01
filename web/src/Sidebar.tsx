import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { UiPanel } from "./ChatApps";
import { renderMarkdown, renderMarkdownInline, resolveRepoFileHref } from "./markdown";
import { escapeHtml, highlightByPath } from "./syntax";

import { api, type FileDiffItem, type FsEntry, type StepItem, type TrailItem } from "./api";
import { mergedFileDiffs, sameDiffPath } from "./diffs";
import { type Bag, type OpenRepoFile, type RightSidebarTab, relativeTime } from "./state";

type Chat = ReturnType<Bag["chats"]>[number];

type ThemeMode = "system" | "light" | "dark";

function fileName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() || trimmed || "file";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
}

function chatDirectory(path: string | null | undefined): string | null {
  const raw = String(path || "").trim();
  return raw || null;
}


function PrettyError(props: { message: string; title?: string }) {
  const parts = () => {
    const raw = String(props.message || "Something went wrong").trim();
    const [first, ...rest] = raw.split(/\r?\n/).filter(Boolean);
    return { first: first || "Something went wrong", rest };
  };
  return (
    <div class="pretty-error" role="alert">
      <div class="pretty-error-icon" aria-hidden="true">!</div>
      <div class="pretty-error-copy">
        <div class="pretty-error-title">{props.title || "Couldn’t open file"}</div>
        <div class="pretty-error-message">{parts().first}</div>
        <Show when={parts().rest.length}>
          <pre class="pretty-error-detail">{parts().rest.join("\n")}</pre>
        </Show>
      </div>
    </div>
  );
}

export function RightSidebarToggle(props: { bag: Bag }) {
  return (
    <button
      type="button"
      class="collapse-btn right-sidebar-toggle"
      title={props.bag.rightSidebarCollapsed() ? "show right sidebar" : "hide right sidebar"}
      aria-label={props.bag.rightSidebarCollapsed() ? "show right sidebar" : "hide right sidebar"}
      aria-pressed={!props.bag.rightSidebarCollapsed()}
      onClick={() => props.bag.toggleRightSidebarCollapsed()}
    >
      ◨
    </button>
  );
}

export function RepoFilePreview(props: { file: OpenRepoFile; onClose: () => void }) {
  const previewPath = () => props.file.path || props.file.requestedPath;
  const title = () => fileName(previewPath());
  const markdown = () => isMarkdownPath(previewPath());
  const rendered = createMemo(() => {
    const content = props.file.content || "";
    return markdown() ? renderMarkdown(content) : highlightByPath(content, previewPath());
  });
  return (
    <section class="repo-file-preview" aria-label="opened repository file">
      <header class="repo-file-header">
        <div>
          <strong>{title()}</strong>
          <span title={previewPath()}>{previewPath()}</span>
        </div>
        <button class="icon-btn" title="close file" onClick={props.onClose}>×</button>
      </header>
      <Show when={!props.file.loading} fallback={<div class="repo-file-status">Loading…</div>}>
        <Show when={!props.file.error} fallback={<div class="repo-file-error"><PrettyError message={props.file.error || "Unable to read this file"} /></div>}>
          <div class="repo-file-meta">{formatBytes(props.file.size)}</div>
          <Show
            when={markdown()}
            fallback={<pre class="repo-file-content" innerHTML={rendered()} />}
          >
            <div class="repo-file-content repo-file-markdown markdown" innerHTML={rendered()} />
          </Show>
        </Show>
      </Show>
    </section>
  );
}

export function RightSidebar(props: { bag: Bag }) {
  const activeTab = () => props.bag.activeRightSidebarTab();
  const [tabsScrollable, setTabsScrollable] = createSignal(false);
  const installTabsOverflow = (tabs: HTMLDivElement) => {
    let frame = 0;
    const measure = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        setTabsScrollable(tabs.scrollHeight > tabs.clientHeight + 1);
      });
    };
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(tabs);
    createEffect(on(
      () => props.bag.rightSidebarTabs().map((tab) => tab.id + ":" + tab.title).join("|"),
      measure,
      { defer: true },
    ));
    measure();
    onCleanup(() => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    });
  };
  const installRightResizer = (handle: HTMLDivElement) => {
    let dragging = false;
    let startX = 0;
    let startW = props.bag.rightSidebarW();
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      props.bag.setRightSidebarW(startW + (startX - e.clientX));
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startW = props.bag.rightSidebarW();
      props.bag.setRightSidebarCollapsed(false);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      e.preventDefault();
    };
    const onDoubleClick = () => props.bag.toggleRightSidebarCollapsed();
    handle.addEventListener("mousedown", onDown);
    handle.addEventListener("dblclick", onDoubleClick);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    onCleanup(() => {
      handle.removeEventListener("mousedown", onDown);
      handle.removeEventListener("dblclick", onDoubleClick);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    });
  };
  return (
    <aside
      class="repo-file-sidebar right-sidebar"
      classList={{ collapsed: props.bag.rightSidebarCollapsed() }}
      aria-label="right sidebar"
    >
      <div class="right-sidebar-resizer" ref={(e) => installRightResizer(e)} title="drag to resize, double-click to collapse" />
      <div
        class="right-tabs"
        classList={{ scrollable: tabsScrollable() }}
        role="tablist"
        aria-label="right sidebar tabs"
        ref={(e) => installTabsOverflow(e)}
      >
        <For each={props.bag.rightSidebarTabs()}>
          {(tab) => (
            <div
              role="tab"
              tabIndex={0}
              class="right-tab"
              classList={{ active: props.bag.activeRightSidebarTabId() === tab.id, closable: tab.id !== "diffs" }}
              aria-selected={props.bag.activeRightSidebarTabId() === tab.id}
              title={tabTitle(tab)}
              onClick={() => props.bag.setActiveRightSidebarTab(tab.id)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  props.bag.setActiveRightSidebarTab(tab.id);
                }
              }}
            >
              <span class="right-tab-kind">{tab.kind === "diffs" ? "✦" : tab.kind === "diff" ? "Δ" : tab.kind === "app" ? tab.icon || "▣" : "□"}</span>
              <span class="right-tab-title">{tab.title}</span>
              <Show when={tab.id !== "diffs"}>
                <button
                  type="button"
                  class="right-tab-close"
                  title="close tab"
                  aria-label={`close ${tab.title}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    void props.bag.closeRightSidebarTab(tab.id);
                  }}
                >×</button>
              </Show>
            </div>
          )}
        </For>
      </div>
      <div class="right-tab-panel" role="tabpanel">
        <Show when={activeTab()} fallback={<TrailsTab bag={props.bag} />}>
          {(tab) => (
            <Show when={tab().kind === "file"} fallback={
              <Show when={tab().kind === "diff"} fallback={
                <Show when={tab().kind === "app"} fallback={<TrailsTab bag={props.bag} />}>
                  <UiPanel bag={props.bag} embedded />
                </Show>
              }>
                <DiffDetailTab bag={props.bag} tab={tab() as Extract<RightSidebarTab, { kind: "diff" }>} />
              </Show>
            }>
              <RepoFilePreview file={(tab() as Extract<RightSidebarTab, { kind: "file" }>).file} onClose={() => void props.bag.closeRightSidebarTab(tab().id)} />
            </Show>
          )}
        </Show>
      </div>
    </aside>
  );
}

function tabTitle(tab: RightSidebarTab): string {
  if (tab.kind === "file") return tab.file.path || tab.file.requestedPath;
  if (tab.kind === "diff") return tab.path;
  if (tab.kind === "app") return tab.uiId;
  return "Trails";
}

type AgentTrailItem = {
  id: string;
  at: number;
  title: string;
  timelineKey?: string;
  detail?: string;
  kind: string;
  tone?: "title" | "summary" | "diff" | "subagent";
  path?: string;
  diff?: FileDiffItem;
  stats?: { added: number; removed: number };
  titleMarkdown?: boolean;
  detailMarkdown?: boolean;
};

function AgentTrailSection(props: { bag: Bag }) {
  const items = createMemo(() => buildTrailItems(props.bag));
  return (
    <section class="agent-trail-panel" aria-label="trail for this chat">
      <Show when={items().length > 0} fallback={<div class="repo-file-status">No trail yet.</div>}>
        <ol class="agent-trail-list">
          <For each={items()}>
            {(item) => <AgentTrailRow item={item} bag={props.bag} tick={props.bag.tick()} />}
          </For>
        </ol>
      </Show>
    </section>
  );
}

function AgentTrailRow(props: { item: AgentTrailItem; bag: Bag; tick: number }) {
  const onMarkdownClick = (ev: MouseEvent) => {
    const anchor = (ev.target as Element | null)?.closest("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute("href") || "";
    const path = resolveRepoFileHref(href, props.bag.currentChatWorktreePath());
    if (!path) return;
    ev.preventDefault();
    ev.stopPropagation();
    void props.bag.openFileInSidebar(path);
  };
  const activateTrailItem = () => {
    if (props.item.diff) {
      props.bag.openDiffInSidebar(props.item.diff, "timeline");
      return;
    }
    props.bag.jumpToTimeline({
      key: props.item.timelineKey,
      at: props.item.at,
      id: props.item.id,
    });
  };
  const onTrailKeyDown = (ev: KeyboardEvent) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    activateTrailItem();
  };
  const itemTitle = () => props.item.diff ? "Open this diff in the right sidebar" : "Jump to this point in the timeline";
  const content = () => (
    <>
      <span class="agent-trail-time">{relativeTime(props.item.at, props.tick)}</span>
      <span class="agent-trail-card">
        <span class="agent-trail-title-line">
          <AgentTrailInline class="agent-trail-title" content={props.item.title} markdown={props.item.titleMarkdown} onMarkdownClick={onMarkdownClick} />
          <Show when={props.item.stats}>
            {(stats) => (
              <span class="right-diff-stats agent-trail-diff-stats" aria-label={diffStatLabel({ stats: stats() })}>
                <span class="right-diff-added">+{stats().added}</span>
                <span class="right-diff-removed">−{stats().removed}</span>
              </span>
            )}
          </Show>
        </span>
        <Show when={props.item.detail}>
          <AgentTrailInline class="agent-trail-detail" content={props.item.detail || ""} markdown={props.item.detailMarkdown} onMarkdownClick={onMarkdownClick} />
        </Show>
      </span>
    </>
  );
  return (
    <li class="agent-trail-item" classList={{
      title: props.item.tone === "title",
      summary: props.item.tone === "summary",
      diff: props.item.tone === "diff",
      subagent: props.item.tone === "subagent",
    }}>
      <span class="agent-trail-dot" aria-hidden="true" />
      <div class="agent-trail-entry agent-trail-button" role="button" tabIndex={0} onClick={activateTrailItem} onKeyDown={onTrailKeyDown} title={itemTitle()}>
        {content()}
      </div>
    </li>
  );
}

function AgentTrailInline(props: { class: string; content: string; markdown?: boolean; onMarkdownClick: (ev: MouseEvent) => void }) {
  return props.markdown ? (
    <span class={props.class + " markdown markdown-inline"} onClick={props.onMarkdownClick} innerHTML={renderTrailMarkdownInline(props.content)} />
  ) : (
    <span class={props.class}>{props.content}</span>
  );
}

function buildTrailItems(bag: Bag): AgentTrailItem[] {
  return bag.timeline()
    .map((item) => {
      if (item.type === "trail") return trailTimelineItem(item);
      if (item.type === "file-diff") return diffTimelineItem(item);
      if (item.type === "step" && item.kind === "agent:Subagent") return subagentTimelineItem(item);
      return null;
    })
    .filter((item): item is AgentTrailItem => item !== null)
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
}

function trailTimelineItem(item: TrailItem): AgentTrailItem | null {
  if (item.kind === "agent:TitleUpdate") {
    const nextTitle = String(item.title || "").trim();
    return {
      id: item.id,
      at: item.at,
      title: nextTitle || "Untitled",
      timelineKey: `trail:${item.id}`,
      kind: item.kind,
      tone: "title",
    };
  }
  if (item.kind === "agent:Summary") {
    const title = String(item.title || "").trim() || "Agent summary";
    const detail = String(item.body || item.summary || "").trim();
    if (!detail && !title) return null;
    return {
      id: item.id,
      at: item.at,
      title,
      timelineKey: `trail:${item.id}`,
      detail,
      kind: item.kind,
      tone: "summary",
      titleMarkdown: true,
      detailMarkdown: true,
    };
  }
  return null;
}

function subagentTimelineItem(item: StepItem): AgentTrailItem | null {
  const info = item.subagent || {};
  const label = String(info.label || "Subagent").trim() || "Subagent";
  const task = String(info.task || "").trim();
  const status = String(info.result?.status || item.status || "").replace(/^agent:/, "");
  const duration = typeof info.result?.durationMs === "number"
    ? ` · ${formatTrailDuration(info.result.durationMs)}`
    : "";
  const error = String(info.result?.error || "").trim();
  const detail = [
    status ? `${status}${duration}` : "",
    error ? `error: ${error}` : "",
    task,
  ].filter(Boolean).join("\n");
  return {
    id: item.step,
    at: item.at,
    title: label,
    timelineKey: `step:${item.step}`,
    detail,
    kind: item.kind,
    tone: "subagent",
  };
}

function formatTrailDuration(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}m ${remaining}s`;
}

function diffTimelineItem(item: FileDiffItem): AgentTrailItem | null {
  const path = String(item.path || "").trim();
  if (!path) return null;
  return {
    id: item.id,
    at: item.at,
    title: path,
    timelineKey: `file-diff:${item.id}`,
    kind: "file-diff",
    tone: "diff",
    path,
    diff: item,
    stats: diffStatsForDisplay(item),
  };
}

function renderTrailMarkdownInline(content: string): string {
  return renderMarkdownInline(String(content || "").replace(/\n+/g, " "));
}

function TrailsTab(props: { bag: Bag }) {
  return (
    <div class="trails-tab">
      <AgentTrailSection bag={props.bag} />
      <DiffListSection bag={props.bag} />
    </div>
  );
}

function diffStatsForDisplay(item: { stats?: { added?: number; removed?: number }; diff?: string }): { added: number; removed: number } {
  let added = Number(item.stats?.added) || 0;
  let removed = Number(item.stats?.removed) || 0;
  if (!item.stats && item.diff) {
    for (const line of item.diff.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

function diffStatLabel(item: { stats?: { added?: number; removed?: number }; diff?: string }): string {
  const stats = diffStatsForDisplay(item);
  return `+${stats.added} −${stats.removed}`;
}

function DiffListSection(props: { bag: Bag }) {
  const diffs = createMemo(() => mergedFileDiffs(props.bag.timeline()));
  return (
    <section class="right-diff-list trail-total-diff" aria-label="total diff for this chat">
      <Show when={diffs().length > 0}>
        <div class="trail-total-diff-title">Total diff</div>
        <div class="right-diff-items">
          <For each={diffs()}>
            {(item) => {
              const stats = diffStatsForDisplay(item);
              return (
                <button type="button" class="right-diff-row trail-history-diff-row" onClick={() => props.bag.openDiffInSidebar(item, "history")} title={item.path}>
                  <span class="trail-history-diff-dot" aria-hidden="true" />
                  <span class="right-diff-path">{item.path}</span>
                  <span class="right-diff-stats" aria-label={diffStatLabel(item)}>
                    <span class="right-diff-added">+{stats.added}</span>
                    <span class="right-diff-removed">−{stats.removed}</span>
                  </span>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </section>
  );
}

function DiffDetailTab(props: { bag: Bag; tab: Extract<RightSidebarTab, { kind: "diff" }> }) {
  const item = createMemo(() => {
    if (props.tab.scope === "history") {
      return mergedFileDiffs(props.bag.timeline()).find((candidate) => sameDiffPath(candidate.path, props.tab.path)) ?? props.tab.item;
    }
    return props.bag.timeline().find((candidate): candidate is FileDiffItem => (
      candidate.type === "file-diff" && candidate.id === props.tab.diffId
    )) ?? props.tab.item;
  });
  const sections = createMemo(() => diffSections(item()?.diff ?? ""));
  const scopeLabel = () => props.tab.scope === "history" ? "Total change" : "Individual change";
  const path = () => item()?.path || props.tab.path;
  return (
    <section class="repo-file-preview right-diff-detail" aria-label={`${scopeLabel()} for ${path()}`}>
      <header class="repo-file-header">
        <div>
          <strong title={path()}>{path()}</strong>
        </div>
      </header>
      <Show when={item()} fallback={<div class="repo-file-status">Diff no longer appears in the loaded timeline.</div>}>
        <div class="repo-file-meta right-diff-meta">{scopeLabel()}</div>
        <div class="file-diff-body right-diff-body" role="log" aria-label={`${scopeLabel()} for ${path()}`}>
          <div class="diff-scroll-content">
            <For each={sections()}>
              {(section) => <DiffSectionView section={section} path={path()} />}
            </For>
          </div>
        </div>
      </Show>
    </section>
  );
}

type DiffSection =
  | { kind: "lines"; lines: string[] }
  | { kind: "collapsed"; lines: string[]; total: number };

const DIFF_CONTEXT_KEEP = 3;
const DIFF_COLLAPSE_MIN = 14;

function diffSections(diff: string): DiffSection[] {
  const lines = diff.split("\n");
  const sections: DiffSection[] = [];
  let pending: string[] = [];
  const flushLines = () => {
    if (!pending.length) return;
    sections.push({ kind: "lines", lines: pending });
    pending = [];
  };
  for (let i = 0; i < lines.length;) {
    if (!isCollapsibleContextLine(lines[i]!)) {
      pending.push(lines[i]!);
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && isCollapsibleContextLine(lines[i]!)) i++;
    const run = lines.slice(start, i);
    if (run.length < DIFF_COLLAPSE_MIN) {
      pending.push(...run);
      continue;
    }
    pending.push(...run.slice(0, DIFF_CONTEXT_KEEP));
    flushLines();
    sections.push({ kind: "collapsed", lines: run.slice(DIFF_CONTEXT_KEEP, run.length - DIFF_CONTEXT_KEEP), total: Math.max(0, run.length - DIFF_CONTEXT_KEEP * 2) });
    pending.push(...run.slice(run.length - DIFF_CONTEXT_KEEP));
  }
  flushLines();
  return sections;
}

function isCollapsibleContextLine(line: string): boolean {
  return line.startsWith(" ") || line === "";
}

function DiffSectionView(props: { section: DiffSection; path: string }) {
  const [expanded, setExpanded] = createSignal(false);
  return (
    <Show when={props.section.kind === "collapsed"} fallback={
      <For each={(props.section as Extract<DiffSection, { kind: "lines" }>).lines}>
        {(line) => <DiffLineView line={line} path={props.path} />}
      </For>
    }>
      <div class="diff-collapsed">
        <Show when={expanded()}>
          <div class="diff-expanded-lines">
            <For each={(props.section as Extract<DiffSection, { kind: "collapsed" }>).lines}>
              {(line) => <DiffLineView line={line} path={props.path} />}
            </For>
          </div>
        </Show>
        <div class="diff-collapsed-controls">
          <span class="diff-collapsed-label">{(props.section as Extract<DiffSection, { kind: "collapsed" }>).total} unchanged lines hidden</span>
          <button type="button" onClick={() => setExpanded(!expanded())}>{expanded() ? "hide" : "+all"}</button>
        </div>
      </div>
    </Show>
  );
}

function DiffLineView(props: { line: string; path: string }) {
  const rendered = createMemo(() => renderDiffLine(props.line, props.path));
  return <span class={rendered().cls} innerHTML={rendered().html || "&nbsp;"} />;
}

function renderDiffLine(line: string, path: string): { cls: string; html: string } {
  let cls = "diff-line diff-context";
  let bodyHtml = "";
  if (line.startsWith("@@")) {
    cls = "diff-line diff-hunk";
    bodyHtml = escapeHtml(line);
  } else if (line.startsWith("diff --git") || line.startsWith("index ")) {
    cls = "diff-line diff-meta";
    bodyHtml = escapeHtml(line);
  } else if (line.startsWith("+++") || line.startsWith("---")) {
    cls = "diff-line diff-file";
    bodyHtml = '<span class="diff-prefix">' + escapeHtml(line.slice(0, 3)) + '</span>' + escapeHtml(line.slice(3));
  } else if (line.startsWith("+")) {
    cls = "diff-line diff-add";
    bodyHtml = '<span class="diff-prefix">+</span>' + highlightByPath(line.slice(1), path);
  } else if (line.startsWith("-")) {
    cls = "diff-line diff-del";
    bodyHtml = '<span class="diff-prefix">-</span>' + highlightByPath(line.slice(1), path);
  } else if (line.startsWith(" ")) {
    bodyHtml = '<span class="diff-prefix"> </span>' + highlightByPath(line.slice(1), path);
  } else if (line.startsWith("\ No newline")) {
    cls = "diff-line diff-meta";
    bodyHtml = escapeHtml(line);
  } else {
    bodyHtml = highlightByPath(line, path);
  }
  return { cls, html: bodyHtml };
}


function isMarkdownPath(path: string): boolean {
  return /(?:^|\.)(?:md|markdown|mdown|mkdn|mdx)$/i.test(path);
}


const THEME_STORAGE_KEY = "moo-theme-mode";

const THEME_OPTIONS: { mode: ThemeMode; label: string; icon: string }[] = [
  { mode: "system", label: "system", icon: "◐" },
  { mode: "light", label: "light", icon: "☀" },
  { mode: "dark", label: "dark", icon: "☾" },
];

function storedThemeMode(): ThemeMode {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch {
    // Ignore storage access failures and fall back to the system setting.
  }
  return "system";
}

function applyThemeMode(mode: ThemeMode) {
  const root = document.documentElement;
  if (mode === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = mode;
  }
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Ignore storage access failures; the in-memory choice still applies.
  }
}


function chatStatusLabel(status: string) {
  return status.replace(/^(agent|ui):/, "");
}

function formatCost(usd: number, hasUnpriced = false): string {
  if (!usd) return "$0";
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return "$" + usd.toFixed(2);
  if (usd < 100) return "$" + usd.toFixed(2);
  return "$" + Math.round(usd);
}

function costTitle(chat: {
  usage: {
    models: Record<string, { input: number; cachedInput: number; output: number }>;
  } | null;
  costUsd?: number;
  unpricedModels?: string[];
}): string {
  if (!chat.usage || Object.keys(chat.usage.models).length === 0) {
    return "no LLM tokens recorded yet";
  }
  const hasUnpriced = (chat.unpricedModels?.length ?? 0) > 0;
  const costUsd = Number.isFinite(chat.costUsd) ? chat.costUsd! : 0;
  const lines = [(hasUnpriced ? "priced lower bound: $" : "total: $") + costUsd.toFixed(4)];
  if (hasUnpriced) {
    lines.push("unpriced models omitted: " + chat.unpricedModels!.join(", "));
  }
  for (const [model, c] of Object.entries(chat.usage.models)) {
    lines.push(
      model + ": " + c.input.toLocaleString() + " in (+" + c.cachedInput.toLocaleString() + " cached) · " + c.output.toLocaleString() + " out",
    );
  }
  return lines.join("\n");
}

function chatStatusClass(status: string) {
  if (status === "ui:Pending") return "pending";
  if (status === "agent:Running") return "running";
  if (status === "agent:Queued") return "queued";
  if (status === "agent:Failed") return "failed";
  return "done";
}

function effectiveStatus(status: string, active: boolean): string {
  if (status === "ui:Pending" || status === "agent:Failed") return status;
  return active ? "agent:Running" : status;
}

export function Sidebar(props: { bag: Bag; onNavigate?: () => void }) {
  const { bag } = props;
  let listEl: HTMLUListElement | undefined;
  const lastOffsets = new Map<string, number>();
  const [chatOrder, setChatOrder] = createSignal<string[]>([]);
  const [explorerOpen, setExplorerOpen] = createSignal(false);
  const [explorerExpanded, setExplorerExpanded] = createSignal(false);
  const [explorerPath, setExplorerPath] = createSignal(".");
  const [explorerParent, setExplorerParent] = createSignal<string | null>(null);
  const [explorerEntries, setExplorerEntries] = createSignal<FsEntry[]>([]);
  const [recentPaths, setRecentPaths] = createSignal<string[]>([]);
  const [explorerBusy, setExplorerBusy] = createSignal(false);
  const [explorerError, setExplorerError] = createSignal<string | null>(null);
  const [openChatMenu, setOpenChatMenu] = createSignal<string | null>(null);
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(storedThemeMode());

  createEffect(() => applyThemeMode(themeMode()));

  const sameIds = (a: string[], b: string[]) =>
    a.length === b.length && a.every((id, i) => id === b[i]);
  createEffect(
    on(
      () => bag.chats(),
      (chats) => {
        const nextOrder = chats.map((chat) => chat.chatId);
        const currentOrder = chatOrder();
        if (!sameIds(currentOrder, nextOrder)) {
          setChatOrder(nextOrder);
        }
      },
    ),
  );

  const closeChatMenu = () => setOpenChatMenu(null);
  const handleDocumentClick = (e: MouseEvent) => {
    if ((e.target as Element | null)?.closest(".chat-actions")) return;
    closeChatMenu();
  };
  const handleDocumentKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeChatMenu();
  };
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("keydown", handleDocumentKeyDown);
  onCleanup(() => {
    document.removeEventListener("click", handleDocumentClick);
    document.removeEventListener("keydown", handleDocumentKeyDown);
  });

  const orderedChats = createMemo(() => {
    const latest = new Map(bag.chats().map((chat) => [chat.chatId, chat]));
    const seen = new Set<string>();
    const ordered: Chat[] = [];
    for (const id of chatOrder()) {
      const chat = latest.get(id);
      if (!chat) continue;
      seen.add(id);
      ordered.push(chat);
    }
    for (const chat of bag.chats()) {
      if (!seen.has(chat.chatId)) ordered.push(chat);
    }
    return ordered;
  });
  const chatById = createMemo(() =>
    new Map(bag.chats().map((chat) => [chat.chatId, chat])),
  );
  const activeChats = createMemo(() => orderedChats().filter((chat) => !chat.archived));
  const archivedChats = createMemo(() => orderedChats().filter((chat) => chat.archived));
  const activeChatIds = createMemo(() => activeChats().map((chat) => chat.chatId));
  const archivedChatIds = createMemo(() => archivedChats().map((chat) => chat.chatId));

  async function loadExplorer(path = explorerPath()) {
    setExplorerBusy(true);
    setExplorerError(null);
    const r = await api.fsList(path);
    setExplorerBusy(false);
    if (!r.ok) {
      setExplorerError(r.error.message);
      return;
    }
    setExplorerPath(r.value.path);
    setExplorerParent(r.value.parent);
    setExplorerEntries(r.value.entries);
    setRecentPaths(r.value.recent);
  }

  async function openExplorer() {
    const nextOpen = !explorerOpen();
    setExplorerOpen(nextOpen);
    if (!nextOpen) return;
    setExplorerExpanded(false);
    setExplorerError(null);
    const recent = await api.recentChatPaths();
    if (recent.ok) setRecentPaths(recent.value.paths);
    const start = recent.ok && recent.value.paths[0] ? recent.value.paths[0] : explorerPath();
    setExplorerPath(start || ".");
  }

  async function createChatAtPath(path: string) {
    setExplorerBusy(true);
    const id = await bag.createChat(path);
    setExplorerBusy(false);
    if (id) {
      setExplorerOpen(false);
      props.onNavigate?.();
    }
  }

  async function chooseRecentPath(path: string) {
    setExplorerPath(path);
    // Recent-project clicks have already made their selection; dismiss the
    // popover immediately instead of waiting for chat hydration to finish.
    setExplorerOpen(false);
    await createChatAtPath(path);
  }

  async function openPathPicker(path = explorerPath()) {
    setExplorerExpanded(true);
    await loadExplorer(path || ".");
  }

  async function createChatInExplorer() {
    await createChatAtPath(explorerPath());
  }
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  createEffect(
    on(
      () => bag.chats(),
      () => {
        if (!listEl) return;
        const rows = listEl.querySelectorAll<HTMLElement>("[data-chat-id]");
        const seen = new Set<string>();
        rows.forEach((row) => {
          const id = row.dataset.chatId!;
          seen.add(id);
          const newTop = row.offsetTop;
          const oldTop = lastOffsets.get(id);
          if (!reduceMotion && oldTop !== undefined && oldTop !== newTop) {
            const dy = oldTop - newTop;
            row.animate(
              [
                { transform: "translateY(" + dy + "px)" },
                { transform: "translateY(0)" },
              ],
              { duration: 220, easing: "cubic-bezier(0.2, 0, 0.2, 1)" },
            );
          }
          lastOffsets.set(id, newTop);
        });
        for (const id of [...lastOffsets.keys()]) {
          if (!seen.has(id)) lastOffsets.delete(id);
        }
      },
    ),
  );

  const navigate = (fn: () => void) => {
    fn();
    props.onNavigate?.();
  };

  const chatRow = (chatId: string) => {
    const chat = new Proxy({} as Chat, {
      get: (_, prop) => chatById().get(chatId)?.[prop as keyof Chat],
    });
    return (
    <li
      class="chat-row"
      data-chat-id={chatId}
      classList={{
        active: chat.chatId === bag.chatId() && bag.view() === "chat",
        archived: chat.archived,
        "menu-open": openChatMenu() === chat.chatId,
      }}
    >
      <button
        class="chat-select"
        onClick={() => navigate(() => bag.selectChat(chat.chatId))}
        onDblClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const next = prompt(
            "rename chat (blank clears title)",
            chat.title || "",
          );
          if (next != null) {
            bag.renameChat(chat.chatId, next.trim() || null);
          }
        }}
        title={chat.path ? "path: " + chat.path + "\ndouble-click to rename" : "double-click to rename"}
      >
        <span class="chat-title-line">
          <span
            class={
              "chat-status " +
              chatStatusClass(
                effectiveStatus(chat.status, bag.isChatActive(chat.chatId)),
              )
            }
            title={
              "status: " +
              chatStatusLabel(
                effectiveStatus(chat.status, bag.isChatActive(chat.chatId)),
              )
            }
            aria-label={
              "status: " +
              chatStatusLabel(
                effectiveStatus(chat.status, bag.isChatActive(chat.chatId)),
              )
            }
          />
          <span class="chat-title">{chat.title || chat.chatId}</span>
        </span>
        <Show when={chatDirectory(chat.path)}>
          {(directory) => (
            <span class="chat-directory" title={"directory: " + directory()}>
              {directory()}
            </span>
          )}
        </Show>
        <span class="chat-meta">
          {relativeTime(chat.lastAt, bag.tick())} ·{" "}
          {chat.totalTurns} {chat.totalTurns === 1 ? "turn" : "turns"} ·{" "}
          {chat.totalSteps} {chat.totalSteps === 1 ? "step" : "steps"} ·{" "}
          <span class="chat-cost" title={costTitle(chat)}>
            {formatCost(chat.costUsd ?? 0, (chat.unpricedModels?.length ?? 0) > 0)}
          </span>
        </span>
      </button>
      <div
        class="chat-actions"
        classList={{ open: openChatMenu() === chat.chatId }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          class="icon-btn chat-menu"
          title={"chat actions " + chat.chatId}
          aria-label={"chat actions " + chat.chatId}
          aria-haspopup="menu"
          aria-expanded={openChatMenu() === chat.chatId}
          onClick={() =>
            setOpenChatMenu(openChatMenu() === chat.chatId ? null : chat.chatId)
          }
        >
          ☰
        </button>
        <Show when={openChatMenu() === chat.chatId}>
          <div class="chat-action-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeChatMenu();
                bag.archiveChat(chat.chatId, !chat.archived);
              }}
            >
              {chat.archived ? "unarchive" : "archive"}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeChatMenu();
                bag.exportChat(chat.chatId);
              }}
            >
              export
            </button>
            <button
              type="button"
              role="menuitem"
              class="danger"
              onClick={() => {
                closeChatMenu();
                bag.removeChat(chat.chatId);
              }}
            >
              delete
            </button>
          </div>
        </Show>
      </div>
    </li>
    );
  };

  return (
    <aside class="sidebar">
      <header class="sidebar-header">
        <div class="sidebar-brand">
          <strong>🐮 Moo</strong>
          <span
            class={"ws-status " + (bag.connected() ? "online" : "offline")}
            title={bag.connected() ? "live" : "disconnected — reconnecting…"}
            aria-label={bag.connected() ? "live" : "disconnected"}
          >
            {bag.connected() ? "live" : "offline"}
          </span>
        </div>
        <button
          type="button"
          class="new-chat-trigger"
          title="start a new chat"
          aria-label="start a new chat"
          aria-haspopup="dialog"
          aria-expanded={explorerOpen()}
          onClick={openExplorer}
        >
          <span class="new-chat-plus" aria-hidden="true">+</span>
        </button>
      </header>
      <Show when={explorerOpen()}>
        <div class="fs-explorer-popover">
          <section class="fs-explorer" role="dialog" aria-label="start a new chat">
            <header class="fs-explorer-header">
              <div>
                <strong>Start a new chat</strong>
                <span>Choose a working directory for the agent.</span>
              </div>
              <button class="icon-btn" title="close" onClick={() => setExplorerOpen(false)}>×</button>
            </header>
            <Show when={recentPaths().length > 0}>
              <div class="fs-section-title">Recent projects</div>
              <div class="fs-recent-list" role="list" aria-label="recent directories">
                <For each={recentPaths()}>
                  {(path) => (
                    <button type="button" role="listitem" title={path} onClick={() => chooseRecentPath(path)}>
                      <span class="fs-folder">📁</span>
                      <span class="fs-recent-path">{path}</span>
                      <span class="fs-recent-action">Start</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show when={recentPaths().length === 0}>
              <div class="fs-empty">No recent projects yet. Enter a path below or browse folders.</div>
            </Show>
            <div class="fs-path-card">
              <label for="new-chat-path">Project path</label>
              <div class="fs-path-row">
                <input
                  id="new-chat-path"
                  value={explorerPath()}
                  onInput={(e) => setExplorerPath(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") createChatInExplorer();
                  }}
                  aria-label="project path"
                  placeholder="/path/to/project"
                />
                <button type="button" class="primary" onClick={createChatInExplorer} disabled={explorerBusy()}>
                  Start
                </button>
              </div>
              <button type="button" class="fs-pick-toggle" onClick={() => openPathPicker()}>
                Browse folders
              </button>
            </div>
            <Show when={explorerExpanded()}>
              <div class="fs-picker">
                <div class="fs-path-row fs-browser-row">
                  <input
                    value={explorerPath()}
                    onInput={(e) => setExplorerPath(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") openPathPicker();
                    }}
                    aria-label="browse path"
                  />
                  <button type="button" onClick={() => openPathPicker()} disabled={explorerBusy()}>Go</button>
                </div>
                <Show when={explorerError()}>
                  <div class="fs-error"><PrettyError title="Couldn’t browse folder" message={explorerError() || "Unable to list this folder"} /></div>
                </Show>
                <div class="fs-entries" aria-busy={explorerBusy()}>
                  <Show when={explorerParent()}>
                    {(parent) => (
                      <button type="button" class="fs-entry dir" onClick={() => openPathPicker(parent())}>
                        <span>↩</span><span>..</span>
                      </button>
                    )}
                  </Show>
                  <For each={explorerEntries()}>
                    {(entry) => (
                      <button
                        type="button"
                        class={"fs-entry " + entry.kind}
                        disabled={entry.kind !== "dir"}
                        title={entry.path}
                        onClick={() => entry.kind === "dir" && openPathPicker(entry.path)}
                      >
                        <span>{entry.kind === "dir" ? "📁" : entry.kind === "symlink" ? "↗" : "·"}</span>
                        <span>{entry.name}</span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </section>
        </div>
      </Show>
      <ul
        class="chat-list"
        ref={listEl}
      >
        <Show
          when={bag.chats().length > 0}
          fallback={
            <Show when={bag.chatsLoaded()}>
              <li class="chat-empty">no chats yet</li>
            </Show>
          }
        >
          <For each={activeChatIds()}>{(chatId) => chatRow(chatId)}</For>
          <Show when={archivedChats().length > 0}>
            <li class="chat-archive-section">
              <button
                type="button"
                class="chat-archive-toggle"
                onClick={() => bag.setArchivedCollapsed(!bag.archivedCollapsed())}
                aria-expanded={!bag.archivedCollapsed()}
              >
                <span>{bag.archivedCollapsed() ? "▸" : "▾"}</span>
                <span>archived</span>
                <span class="chat-archive-count">{archivedChats().length}</span>
              </button>
            </li>
            <Show when={!bag.archivedCollapsed()}>
              <For each={archivedChatIds()}>{(chatId) => chatRow(chatId)}</For>
            </Show>
          </Show>
        </Show>
      </ul>
      <button
        type="button"
        class="sidebar-tab"
        classList={{ active: bag.view() === "apps" }}
        onClick={() => navigate(() => bag.showApps())}
      >
        <span class="sidebar-tab-label">apps</span>
        <span class="sidebar-tab-count">
          {bag.uiApps().length} app{bag.uiApps().length === 1 ? "" : "s"}
        </span>
      </button>
      <button
        type="button"
        class="sidebar-tab"
        classList={{ active: bag.view() === "memory" }}
        onClick={() => navigate(() => bag.showMemory(null))}
      >
        <span class="sidebar-tab-label">facts</span>
        <span class="sidebar-tab-count">
          {bag.vocabulary().length} predicate
          {bag.vocabulary().length === 1 ? "" : "s"}
        </span>
      </button>
      <button
        type="button"
        class="sidebar-tab"
        classList={{ active: bag.view() === "mcp" }}
        onClick={() => navigate(() => bag.showMcp())}
      >
        <span class="sidebar-tab-label">mcp</span>
        <span class="sidebar-tab-count">
          {bag.mcpServers().length} server{bag.mcpServers().length === 1 ? "" : "s"}
        </span>
      </button>
      <div class="sidebar-theme">
        <div class="theme-segmented" role="group" aria-label="Theme mode">
          <For each={THEME_OPTIONS}>
            {(option) => (
              <button
                type="button"
                class="theme-segment"
                classList={{ active: themeMode() === option.mode }}
                aria-label={option.label + " theme"}
                aria-pressed={themeMode() === option.mode}
                title={option.label}
                onClick={() => setThemeMode(option.mode)}
              >
                <span aria-hidden="true">{option.icon}</span>
              </button>
            )}
          </For>
        </div>
      </div>
    </aside>
  );
}
