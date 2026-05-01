import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { UiPanel } from "./ChatApps";
import { anchorFromEventTarget, renderMarkdown, renderMarkdownInline, resolveRepoFileHref } from "./markdown";
import { escapeHtml, formatJsonTextForView, highlightByPath, highlightJson } from "./syntax";
import { DiffView } from "./DiffView";

import { api, type FileDiffItem, type FsEntry, type StepItem, type StoreObject, type TimelineItem, type TrailItem } from "./api";
import { mergedFileDiffs, sameDiffPath } from "./diffs";
import { displayChatId, type Bag, type OpenRepoFile, type RightSidebarTab, relativeTime } from "./state";
import { collapseHome, expandHome } from "./paths";
import { applyAndPersistThemeMode, storedThemeMode, type ThemeMode } from "./theme";

type Chat = ReturnType<Bag["chats"]>[number];

const INITIAL_RENDERED_CHATS = 80;
const RENDERED_CHATS_PAGE = 120;


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
      class="header-icon-button right-sidebar-toggle"
      title={props.bag.rightSidebarCollapsed() ? "show right sidebar" : "hide right sidebar"}
      aria-label={props.bag.rightSidebarCollapsed() ? "show right sidebar" : "hide right sidebar"}
      aria-pressed={!props.bag.rightSidebarCollapsed()}
      onClick={() => props.bag.toggleRightSidebarCollapsed()}
    >
      ◨
    </button>
  );
}

export function RepoFilePreview(props: { file: OpenRepoFile; onClose: () => void; onOpenFile?: (path: string) => void; assetRootPath?: string | null }) {
  const previewPath = () => props.file.path || props.file.requestedPath;
  const title = () => fileName(previewPath());
  const previewKind = () => previewKindForPath(previewPath());
  const [mode, setMode] = createSignal<FileContentMode>(previewKind() ? "preview" : "source");
  const renderedSource = createMemo(() => highlightByPath(props.file.content || "", previewPath()));
  createEffect(on(
    () => previewPath(),
    () => setMode(previewKind() ? "preview" : "source"),
  ));
  return (
    <section class="repo-file-preview" aria-label="opened repository file">
      <header class="repo-file-header">
        <div>
          <strong>{title()}</strong>
          <span title={collapseHome(previewPath())}>{collapseHome(previewPath())}</span>
        </div>
        <button class="icon-btn" title="close file" onClick={props.onClose}>×</button>
      </header>
      <Show when={!props.file.loading} fallback={<div class="repo-file-status">Loading…</div>}>
        <Show when={!props.file.error} fallback={<div class="repo-file-error"><PrettyError message={props.file.error || "Unable to read this file"} /></div>}>
          <div class="repo-file-meta repo-file-toolbar">
            <span>{formatBytes(props.file.size)}</span>
            <Show when={previewKind()}>
              <FilePreviewModeControl mode={mode} setMode={setMode} previewKind={previewKind} />
            </Show>
          </div>
          <Show
            when={previewKind() && mode() === "preview"}
            fallback={<pre class="repo-file-content repo-file-source" innerHTML={renderedSource()} />}
          >
            <RenderedFilePreview
              kind={previewKind()!}
              content={props.file.content || ""}
              path={previewPath()}
              assetRootPath={props.assetRootPath ?? null}
              onOpenFile={props.onOpenFile}
            />
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
      <div class="right-sidebar-actions">
        <button
          type="button"
          class="header-icon-button right-sidebar-size-toggle"
          classList={{ maximized: props.bag.rightSidebarMaximized() }}
          title={props.bag.rightSidebarMaximized() ? "reduce right pane" : "maximize right pane"}
          aria-label={props.bag.rightSidebarMaximized() ? "reduce right pane" : "maximize right pane"}
          aria-pressed={props.bag.rightSidebarMaximized()}
          onClick={() => props.bag.toggleRightSidebarMaximized()}
        >
          <span class="right-sidebar-size-icon" aria-hidden="true" />
        </button>
      </div>
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
              <span class="right-tab-kind">{tab.kind === "diffs" ? "✦" : tab.kind === "diff" ? "Δ" : tab.kind === "store" ? "◈" : tab.kind === "app" ? tab.icon || "▣" : "□"}</span>
              <span class="right-tab-title">{tabTitle(tab)}</span>
              <Show when={tab.id !== "diffs"}>
                <button
                  type="button"
                  class="right-tab-close"
                  title="close tab"
                  aria-label={`close ${tabTitle(tab)}`}
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
              <Show when={tab().kind === "store"} fallback={
                <Show when={tab().kind === "diff"} fallback={
                  <Show when={tab().kind === "app"} fallback={<TrailsTab bag={props.bag} />}>
                    <UiPanel bag={props.bag} embedded />
                  </Show>
                }>
                  <DiffDetailTab bag={props.bag} tab={tab() as Extract<RightSidebarTab, { kind: "diff" }>} />
                </Show>
              }>
                <StorePreviewTab store={(tab() as Extract<RightSidebarTab, { kind: "store" }>).store} onClose={() => void props.bag.closeRightSidebarTab(tab().id)} />
              </Show>
            }>
              <RepoFilePreview
                file={(tab() as Extract<RightSidebarTab, { kind: "file" }>).file}
                assetRootPath={props.bag.currentChatWorktreePath()}
                onClose={() => void props.bag.closeRightSidebarTab(tab().id)}
                onOpenFile={(path) => void props.bag.openFileInSidebar(path)}
              />
            </Show>
          )}
        </Show>
      </div>
    </aside>
  );
}

function tabTitle(tab: RightSidebarTab): string {
  if (tab.kind === "file") return collapseHome(tab.file.path || tab.file.requestedPath);
  if (tab.kind === "store") return tab.title;
  if (tab.kind === "diff") return collapseHome(tab.path);
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
  targetChatId?: string;
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
    const anchor = anchorFromEventTarget(ev.target);
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
    if (props.item.targetChatId) {
      void props.bag.selectChat(props.item.targetChatId);
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
  const itemTitle = () => props.item.diff
    ? "Open this diff in the right sidebar"
    : props.item.targetChatId
      ? "Open this subagent chat"
      : "Jump to this point in the timeline";
  const content = () => (
    <>
      <span class="agent-trail-time">{relativeTime(props.item.at, props.tick)}</span>
      <span class="agent-trail-card">
        <span class="agent-trail-title-line">
          <AgentTrailInline class={"agent-trail-title" + (props.item.diff ? " agent-trail-path" : "")} content={props.item.title} markdown={props.item.titleMarkdown} onMarkdownClick={onMarkdownClick} />
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

function trailSourceItems(bag: Bag): TimelineItem[] {
  const byKey = new Map<string, TimelineItem>();
  for (const item of bag.timeline()) byKey.set(trailSourceKey(item), item);
  for (const item of bag.trail()) byKey.set(trailSourceKey(item), item);
  return [...byKey.values()];
}

function buildTrailItems(bag: Bag): AgentTrailItem[] {
  return trailSourceItems(bag).map((item) => {
      if (item.type === "trail") return trailTimelineItem(item);
      if (item.type === "file-diff") return diffTimelineItem(item);
      if (item.type === "step" && item.kind === "agent:Subagent") return subagentTimelineItem(item);
      return null;
    })
    .filter((item): item is AgentTrailItem => item !== null)
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
}

function trailSourceKey(item: TimelineItem): string {
  if (item.type === "step") return `step:${item.step}`;
  if (item.type === "input") return `input:${item.requestId}`;
  if (item.type === "input-response") return `input-response:${item.responseId}`;
  if (item.type === "log") return `log:${item.id}`;
  if (item.type === "trail") return `trail:${item.id}`;
  if (item.type === "memory-diff") return `memory-diff:${item.id}`;
  return `file-diff:${item.id}`;
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
  const childChatId = String(info.childChatId || info.result?.childChatId || "").trim();
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
    targetChatId: childChatId || undefined,
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
  const diffs = createMemo(() => mergedFileDiffs(trailSourceItems(props.bag)));
  return (
    <section class="right-diff-list trail-total-diff" aria-label="total diff for this chat">
      <Show when={diffs().length > 0}>
        <div class="trail-total-diff-title">Total diff</div>
        <div class="right-diff-items">
          <For each={diffs()}>
            {(item) => {
              const stats = diffStatsForDisplay(item);
              return (
                <button type="button" class="right-diff-row trail-history-diff-row" onClick={() => props.bag.openDiffInSidebar(item, "history")} title={collapseHome(item.path)}>
                  <span class="trail-history-diff-dot" aria-hidden="true" />
                  <span class="right-diff-path">{collapseHome(item.path)}</span>
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
      return mergedFileDiffs(props.bag.trail()).find((candidate) => sameDiffPath(candidate.path, props.tab.path)) ?? props.tab.item;
    }
    return props.bag.timeline().find((candidate): candidate is FileDiffItem => (
      candidate.type === "file-diff" && candidate.id === props.tab.diffId
    )) ?? props.tab.item;
  });
  const scopeLabel = () => props.tab.scope === "history" ? "Total change" : "Individual change";
  const path = () => item()?.path || props.tab.path;
  const displayPath = () => collapseHome(path());
  const previewKind = () => previewKindForPath(path());
  const hasSnapshot = () => typeof item()?.after === "string";
  const hasPreview = () => Boolean(previewKind() && hasSnapshot());
  const [mode, setMode] = createSignal<DiffContentMode>(hasPreview() ? "preview" : "diff");
  const afterContent = () => item()?.after ?? "";
  const renderedSource = createMemo(() => highlightByPath(afterContent(), path()));
  createEffect(on(
    () => `${props.tab.id}:${path()}:${hasPreview()}`,
    () => setMode(hasPreview() ? "preview" : "diff"),
  ));
  const renderedSnapshot = () => (
    <Show
      when={mode() === "preview" && hasPreview()}
      fallback={<pre class="repo-file-content repo-file-source right-diff-snapshot-source" innerHTML={renderedSource()} />}
    >
      <RenderedFilePreview
        kind={previewKind()!}
        content={afterContent()}
        path={path()}
        assetRootPath={props.bag.currentChatWorktreePath()}
        onOpenFile={(nextPath) => void props.bag.openFileInSidebar(nextPath)}
      />
    </Show>
  );
  return (
    <section class="repo-file-preview right-diff-detail" aria-label={`${scopeLabel()} for ${displayPath()}`}>
      <header class="repo-file-header">
        <div>
          <strong title={displayPath()}>{displayPath()}</strong>
        </div>
      </header>
      <Show when={item()} fallback={<div class="repo-file-status">Diff no longer appears in the loaded timeline.</div>}>
        <div class="repo-file-meta right-diff-meta repo-file-toolbar">
          <span>{scopeLabel()}</span>
          <Show when={previewKind()}>
            <DiffPreviewModeControl
              mode={mode}
              setMode={setMode}
              previewKind={previewKind}
              hasPreview={hasPreview}
              hasSnapshot={hasSnapshot}
            />
          </Show>
        </div>
        <Show when={mode() === "diff"} fallback={renderedSnapshot()}>
          <div class="file-diff-body right-diff-body" role="log" aria-label={`${scopeLabel()} for ${displayPath()}`}>
            <DiffView diff={item()?.diff ?? ""} snapshot={item()?.after} path={path()} />
          </div>
        </Show>
      </Show>
    </section>
  );
}


function isMarkdownPath(path: string): boolean {
  return /(?:^|\.)(?:md|markdown|mdown|mkdn|mdx)$/i.test(path);
}

function isHtmlPath(path: string): boolean {
  return /(?:^|\.)(?:html?|xhtml)$/i.test(path);
}

type FilePreviewKind = "html" | "markdown";
type FileContentMode = "preview" | "source";
type DiffContentMode = "diff" | "preview" | "source";

function previewKindForPath(path: string): FilePreviewKind | null {
  if (isMarkdownPath(path)) return "markdown";
  if (isHtmlPath(path)) return "html";
  return null;
}

function previewKindLabel(kind: FilePreviewKind | null): string {
  if (kind === "html") return "HTML preview";
  if (kind === "markdown") return "Markdown preview";
  return "Preview";
}

function SidebarModeButton(props: { label: string; active: boolean; disabled?: boolean; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      classList={{ active: props.active }}
      disabled={props.disabled}
      aria-pressed={props.active}
      title={props.title || props.label}
      onClick={() => {
        if (!props.disabled) props.onClick();
      }}
    >
      {props.label}
    </button>
  );
}

function FilePreviewModeControl(props: {
  mode: () => FileContentMode;
  setMode: (mode: FileContentMode) => void;
  previewKind: () => FilePreviewKind | null;
}) {
  return (
    <div class="repo-preview-mode" role="group" aria-label="File preview mode">
      <SidebarModeButton
        label="Preview"
        active={props.mode() === "preview"}
        title={previewKindLabel(props.previewKind())}
        onClick={() => props.setMode("preview")}
      />
      <SidebarModeButton
        label="Source"
        active={props.mode() === "source"}
        title="Show source"
        onClick={() => props.setMode("source")}
      />
    </div>
  );
}

function DiffPreviewModeControl(props: {
  mode: () => DiffContentMode;
  setMode: (mode: DiffContentMode) => void;
  previewKind: () => FilePreviewKind | null;
  hasPreview: () => boolean;
  hasSnapshot: () => boolean;
}) {
  const noSnapshotTitle = () => "No post-change snapshot is available for this diff";
  return (
    <div class="repo-preview-mode" role="group" aria-label="Diff preview mode">
      <SidebarModeButton
        label="Diff"
        active={props.mode() === "diff"}
        title="Show diff"
        onClick={() => props.setMode("diff")}
      />
      <SidebarModeButton
        label="Preview"
        active={props.mode() === "preview"}
        disabled={!props.hasPreview()}
        title={props.hasPreview() ? previewKindLabel(props.previewKind()) : noSnapshotTitle()}
        onClick={() => props.setMode("preview")}
      />
      <SidebarModeButton
        label="Source"
        active={props.mode() === "source"}
        disabled={!props.hasSnapshot()}
        title={props.hasSnapshot() ? "Show post-change source" : noSnapshotTitle()}
        onClick={() => props.setMode("source")}
      />
    </div>
  );
}

function RenderedFilePreview(props: {
  kind: FilePreviewKind;
  content: string;
  path: string;
  assetRootPath?: string | null;
  onOpenFile?: (path: string) => void;
}) {
  const markdownHtml = createMemo(() => renderMarkdown(props.content || ""));
  const htmlPreviewInputs = createMemo(
    (): HtmlPreviewInputs | null => props.kind === "html"
      ? {
        content: props.content || "",
        path: props.path,
        assetRootPath: props.assetRootPath ?? null,
      }
      : null,
    null,
    { equals: sameHtmlPreviewInputs },
  );
  const [htmlSrcDoc, setHtmlSrcDoc] = createSignal(htmlPreviewBaseSrcDoc(props.content || "", props.path));
  createEffect(on(htmlPreviewInputs, (inputs) => {
    if (!inputs) return;
    let cancelled = false;
    // For documents with relative stylesheets, keep the previous rendered iframe
    // until stylesheet inlining completes. Replacing srcdoc with the raw HTML
    // first makes previews appear to randomly lose CSS while refreshes race.
    if (!htmlPreviewHasRelativeStylesheet(inputs.content)) {
      setHtmlSrcDoc(htmlPreviewBaseSrcDoc(inputs.content, inputs.path));
    }
    void htmlPreviewSrcDoc(inputs.content, inputs.path, inputs.assetRootPath).then((nextSrcDoc) => {
      if (!cancelled) setHtmlSrcDoc(nextSrcDoc);
    });
    onCleanup(() => {
      cancelled = true;
    });
  }));
  const onMarkdownClick = (ev: MouseEvent) => handleRenderedMarkdownClick(ev, props.path, props.onOpenFile);
  return (
    <Show when={props.kind === "html"} fallback={
      <div
        class="repo-file-content repo-file-rendered repo-file-markdown markdown"
        onClick={onMarkdownClick}
        innerHTML={markdownHtml()}
      />
    }>
      <div class="repo-file-content repo-file-rendered repo-file-html-preview">
        <iframe
          class="repo-file-html-frame"
          title={`HTML preview of ${collapseHome(props.path)}`}
          allow="fullscreen; clipboard-read; clipboard-write; web-share; autoplay; encrypted-media; picture-in-picture"
          srcdoc={htmlSrcDoc()}
        />
      </div>
    </Show>
  );
}

type HtmlPreviewInputs = {
  content: string;
  path: string;
  assetRootPath: string | null;
};

function sameHtmlPreviewInputs(a: HtmlPreviewInputs | null, b: HtmlPreviewInputs | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.content === b.content && a.path === b.path && a.assetRootPath === b.assetRootPath;
}

function htmlPreviewBaseSrcDoc(content: string, path: string): string {
  const wrapped = /<html(?:\s|>|$)/i.test(content) || /<!doctype\s+html/i.test(content)
    ? content
    : `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(fileName(path))}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 1rem; font: 16px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  img, svg, video, canvas, iframe { max-width: 100%; }
  table { border-collapse: collapse; }
</style>
</head>
<body>${content}</body>
</html>`;
  return injectHashLinkHandler(wrapped);
}

// In srcdoc iframes the document URL is `about:srcdoc`, so a click on
// `<a href="#foo">` causes a same-document navigation that some engines
// service by reloading the srcdoc — a flicker that destroys scroll
// position. Intercept those clicks and scroll to the target instead.
const HASH_LINK_HANDLER = `<script>(function(){
  document.addEventListener("click", function(ev) {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute("href");
    if (!href || href.charAt(0) !== "#") return;
    var id = decodeURIComponent(href.slice(1));
    var target = id ? (document.getElementById(id) || document.querySelector('a[name="' + CSS.escape(id) + '"]')) : document.documentElement;
    if (!target) return;
    ev.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }, true);
})();</script>`;

function injectHashLinkHandler(srcDoc: string): string {
  if (srcDoc.includes(HASH_LINK_HANDLER)) return srcDoc;
  const bodyClose = srcDoc.search(/<\/body\s*>/i);
  if (bodyClose >= 0) return srcDoc.slice(0, bodyClose) + HASH_LINK_HANDLER + srcDoc.slice(bodyClose);
  const htmlClose = srcDoc.search(/<\/html\s*>/i);
  if (htmlClose >= 0) return srcDoc.slice(0, htmlClose) + HASH_LINK_HANDLER + srcDoc.slice(htmlClose);
  return srcDoc + HASH_LINK_HANDLER;
}

async function htmlPreviewSrcDoc(content: string, path: string, assetRootPath?: string | null): Promise<string> {
  const srcDoc = htmlPreviewBaseSrcDoc(content, path);
  return await inlineRelativeHtmlStylesheets(srcDoc, path, assetRootPath);
}

function htmlPreviewHasRelativeStylesheet(content: string): boolean {
  if (!/<link\s[^>]*rel=[^>]*stylesheet/i.test(content)) return false;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(htmlPreviewBaseSrcDoc(content, "preview.html"), "text/html");
  } catch (_) {
    return false;
  }
  return Array.from(doc.querySelectorAll("link[href]"))
    .some((link) => relIncludesStylesheet(link.getAttribute("rel")) && Boolean(resolveHtmlAssetHref(link.getAttribute("href") || "", "preview.html", null)));
}

async function inlineRelativeHtmlStylesheets(srcDoc: string, path: string, assetRootPath?: string | null): Promise<string> {
  if (!/<link\s[^>]*rel=[^>]*stylesheet/i.test(srcDoc)) return srcDoc;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(srcDoc, "text/html");
  } catch (_) {
    return srcDoc;
  }
  const links = Array.from(doc.querySelectorAll("link[href]"))
    .filter((link): link is HTMLLinkElement => link instanceof HTMLLinkElement && relIncludesStylesheet(link.getAttribute("rel")));
  if (!links.length) return srcDoc;

  await Promise.all(links.map((link) => inlineStylesheetLink(link, path, assetRootPath)));
  return "<!doctype html>\n" + doc.documentElement.outerHTML;
}

function relIncludesStylesheet(rel: string | null): boolean {
  return (rel || "").toLowerCase().split(/\s+/).includes("stylesheet");
}

async function inlineStylesheetLink(link: HTMLLinkElement, path: string, assetRootPath?: string | null): Promise<void> {
  const href = link.getAttribute("href") || "";
  const stylesheetPath = resolveHtmlAssetHref(href, path, assetRootPath);
  if (!stylesheetPath) return;

  let result: Awaited<ReturnType<typeof api.fs.read>>;
  try {
    result = await api.fs.read(stylesheetPath, assetRootPath ?? null);
  } catch (_) {
    return;
  }
  if (!result.ok) return;

  const doc = link.ownerDocument;
  const style = doc.createElement("style");
  style.setAttribute("data-moo-preview-href", href);
  const media = link.getAttribute("media");
  if (media) style.setAttribute("media", media);
  const title = link.getAttribute("title");
  if (title) style.setAttribute("title", title);
  style.appendChild(doc.createTextNode(safeStyleTextForSrcDoc(result.value.content)));
  link.replaceWith(style);
}

function safeStyleTextForSrcDoc(css: string): string {
  return css.replace(/<\/style/gi, "<\\/style");
}

function resolveHtmlAssetHref(href: string, path: string, assetRootPath?: string | null): string | null {
  const raw = href.trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("?")) return null;
  if (raw.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;

  const withoutHash = raw.split("#", 1)[0].split("?", 1)[0];
  if (!withoutHash) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutHash);
  } catch (_) {
    decoded = withoutHash;
  }

  const root = normalizedOptionalPath(assetRootPath);
  if (decoded.startsWith("/")) {
    return root ? normalizePathSegments(joinRepoPath(root, decoded.slice(1))) : normalizePathSegments(decoded);
  }

  const basePath = htmlPreviewAssetBasePath(path, root);
  return normalizePathSegments(basePath ? joinRepoPath(basePath, decoded) : decoded);
}

function htmlPreviewAssetBasePath(path: string, assetRootPath?: string | null): string | null {
  const normalizedPath = normalizeRepoPath(path).replace(/\/+$/, "");
  const fileDir = repoFileBasePath(normalizedPath);
  if (isFilesystemAbsolutePath(normalizedPath)) return fileDir;
  const root = normalizedOptionalPath(assetRootPath);
  if (!root) return fileDir;
  return fileDir ? joinRepoPath(root, fileDir) : root;
}

function normalizedOptionalPath(path: string | null | undefined): string | null {
  const normalized = normalizeRepoPath(path || "").replace(/\/+$/, "");
  return normalized || null;
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isFilesystemAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

function joinRepoPath(base: string, child: string): string {
  return base.replace(/\/+$/, "") + "/" + child.replace(/^\/+/, "");
}

function normalizePathSegments(path: string): string {
  const normalized = normalizeRepoPath(path);
  const absolute = normalized.startsWith("/");
  const prefixMatch = normalized.match(/^[A-Za-z]:\//);
  const prefix = prefixMatch ? prefixMatch[0].replace(/\/$/, "") : absolute ? "/" : "";
  const rest = prefixMatch ? normalized.slice(prefixMatch[0].length) : absolute ? normalized.slice(1) : normalized;
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!prefix) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  if (prefix === "/") return "/" + parts.join("/");
  if (prefix) return prefix + (parts.length ? "/" + parts.join("/") : "");
  return parts.join("/") || ".";
}

function handleRenderedMarkdownClick(ev: MouseEvent, currentPath: string, onOpenFile?: (path: string) => void) {
  if (!onOpenFile) return;
  const anchor = anchorFromEventTarget(ev.target);
  if (!anchor) return;
  const href = anchor.getAttribute("href") || "";
  const nextPath = resolveRepoFileHref(href, repoFileBasePath(currentPath));
  if (!nextPath) return;
  ev.preventDefault();
  ev.stopPropagation();
  onOpenFile(nextPath);
}

function repoFileBasePath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return null;
  if (slash === 0) return "/";
  return normalized.slice(0, slash);
}


const THEME_OPTIONS: { mode: ThemeMode; label: string; icon: string }[] = [
  { mode: "system", label: "system", icon: "◐" },
  { mode: "light", label: "light", icon: "☀" },
  { mode: "dark", label: "dark", icon: "☾" },
];


function chatStatusLabel(status: string) {
  return status.replace(/^(agent|ui):/, "");
}

function formatCost(usd: number, hasUnpriced = false): string {
  const prefix = hasUnpriced ? "≥" : "";
  if (!usd) return prefix + "$0";
  if (usd < 0.01) return prefix + "<$0.01";
  if (usd < 1) return prefix + "$" + usd.toFixed(2);
  if (usd < 100) return prefix + "$" + usd.toFixed(2);
  return prefix + "$" + Math.round(usd);
}

function costTitle(chat: {
  usage: {
    models: Record<string, { input: number; cachedInput: number; cacheWriteInput?: number; output: number }>;
  } | null;
  costUsd?: number;
  unpricedModels?: string[];
  childUsageIncluded?: number;
}): string {
  if (!chat.usage || Object.keys(chat.usage.models).length === 0) {
    return "no LLM tokens recorded yet";
  }
  const hasUnpriced = (chat.unpricedModels?.length ?? 0) > 0;
  const costUsd = Number.isFinite(chat.costUsd) ? chat.costUsd! : 0;
  const lines = [(hasUnpriced ? "priced lower bound: $" : "estimated total: $") + costUsd.toFixed(4)];
  if ((chat.childUsageIncluded ?? 0) > 0) {
    lines.push("includes " + chat.childUsageIncluded + " hidden subagent chat" + (chat.childUsageIncluded === 1 ? "" : "s"));
  }
  if (hasUnpriced) {
    lines.push("unpriced models omitted: " + chat.unpricedModels!.join(", "));
  }
  for (const [model, c] of Object.entries(chat.usage.models)) {
    lines.push(
      model + ": " + c.input.toLocaleString() + " in (+" + c.cachedInput.toLocaleString() + " cache read, +" + (c.cacheWriteInput ?? 0).toLocaleString() + " cache write) · " + c.output.toLocaleString() + " out",
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
  const [renderedActiveLimit, setRenderedActiveLimit] = createSignal(INITIAL_RENDERED_CHATS);
  const [renderedArchivedLimit, setRenderedArchivedLimit] = createSignal(INITIAL_RENDERED_CHATS);
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(storedThemeMode());

  createEffect(() => applyAndPersistThemeMode(themeMode()));

  const sameIds = (a: string[], b: string[]) =>
    a.length === b.length && a.every((id, i) => id === b[i]);
  // Freeze order while the mouse is over the chat list so new activity
  // doesn't yank rows out from under the cursor. We resync as soon as the
  // pointer leaves (this effect re-runs when hoveringList flips back to
  // false). Other fields (title, meta, status) still update live.
  const [hoveringList, setHoveringList] = createSignal(false);
  createEffect(() => {
    const chats = bag.chats();
    if (hoveringList()) return;
    const nextOrder = chats.map((chat) => chat.chatId);
    const currentOrder = chatOrder();
    if (!sameIds(currentOrder, nextOrder)) {
      setChatOrder(nextOrder);
    }
  });

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
  const renderedActiveChatIds = createMemo(() => activeChatIds().slice(0, renderedActiveLimit()));
  const renderedArchivedChatIds = createMemo(() => archivedChatIds().slice(0, renderedArchivedLimit()));
  const hiddenActiveChats = createMemo(() => Math.max(0, activeChatIds().length - renderedActiveChatIds().length));
  const hiddenArchivedChats = createMemo(() => Math.max(0, archivedChatIds().length - renderedArchivedChatIds().length));

  async function loadExplorer(path = explorerPath()) {
    setExplorerBusy(true);
    setExplorerError(null);
    const r = await api.fs.list(expandHome(path));
    setExplorerBusy(false);
    if (!r.ok) {
      setExplorerError(r.error.message);
      return;
    }
    setExplorerPath(collapseHome(r.value.path));
    setExplorerParent(r.value.parent ? collapseHome(r.value.parent) : r.value.parent);
    setExplorerEntries(r.value.entries);
    setRecentPaths(r.value.recent.map((p) => collapseHome(p)));
  }

  async function openExplorer() {
    const nextOpen = !explorerOpen();
    setExplorerOpen(nextOpen);
    if (!nextOpen) return;
    setExplorerExpanded(false);
    setExplorerError(null);
    const recent = await api.chat.recentPaths();
    if (recent.ok) setRecentPaths(recent.value.paths.map((p) => collapseHome(p)));
    const recentFirst = recent.ok ? recent.value.paths[0] : null;
    const start = recentFirst ? collapseHome(recentFirst) : explorerPath();
    setExplorerPath(start || ".");
  }

  async function createChatAtPath(path: string) {
    setExplorerBusy(true);
    const id = await bag.createChat(expandHome(path));
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

  const renderedChatOrderKey = createMemo(() =>
    renderedActiveChatIds().join("\0") +
    "|" +
    (archivedChats().length > 0 ? "1" : "0") +
    "|" +
    (bag.archivedCollapsed() ? "1" : "0") +
    "|" +
    (bag.archivedCollapsed() ? "" : renderedArchivedChatIds().join("\0")),
  );

  createEffect(
    on(
      renderedChatOrderKey,
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
        title={chat.path ? "path: " + collapseHome(chat.path) + "\ndouble-click to rename" : "double-click to rename"}
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
          <span class="chat-title">{chat.title || displayChatId(chat.chatId)}</span>
        </span>
        <Show when={chatDirectory(chat.path)}>
          {(directory) => (
            <span class="chat-directory" title={"directory: " + collapseHome(directory())}>
              {collapseHome(directory())}
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
                const next = prompt(
                  "rename chat (blank clears title)",
                  chat.title || "",
                );
                if (next != null) {
                  bag.renameChat(chat.chatId, next.trim() || null);
                }
              }}
            >
              rename
            </button>
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
                        title={collapseHome(entry.path)}
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
        onMouseEnter={() => setHoveringList(true)}
        onMouseLeave={() => setHoveringList(false)}
      >
        <Show
          when={bag.chats().length > 0}
          fallback={
            <Show when={bag.chatsLoaded()}>
              <li class="chat-empty">no chats yet</li>
            </Show>
          }
        >
          <For each={renderedActiveChatIds()}>{(chatId) => chatRow(chatId)}</For>
          <Show when={hiddenActiveChats() > 0}>
            <li class="chat-list-more">
              <button
                type="button"
                onClick={() => setRenderedActiveLimit((n) => n + RENDERED_CHATS_PAGE)}
              >
                show {Math.min(RENDERED_CHATS_PAGE, hiddenActiveChats())} more chats · {hiddenActiveChats()} hidden
              </button>
            </li>
          </Show>
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
              <For each={renderedArchivedChatIds()}>{(chatId) => chatRow(chatId)}</For>
              <Show when={hiddenArchivedChats() > 0}>
                <li class="chat-list-more">
                  <button
                    type="button"
                    onClick={() => setRenderedArchivedLimit((n) => n + RENDERED_CHATS_PAGE)}
                  >
                    show {Math.min(RENDERED_CHATS_PAGE, hiddenArchivedChats())} more archived · {hiddenArchivedChats()} hidden
                  </button>
                </li>
              </Show>
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
      <button
        type="button"
        class="sidebar-tab"
        classList={{ active: bag.view() === "v8" }}
        onClick={() => navigate(() => bag.showV8())}
      >
        <span class="sidebar-tab-label">v8</span>
        <Show when={bag.v8Stats()?.totals.workers && bag.v8Stats()!.totals.workers > 0}>
          <span class="sidebar-tab-count">
            {bag.v8Stats()!.totals.busy}/{bag.v8Stats()!.totals.workers} busy
          </span>
        </Show>
      </button>
      <div class="sidebar-theme">
        <button
          type="button"
          class="sidebar-settings-button"
          classList={{ active: bag.view() === "settings" }}
          title="settings"
          aria-label="settings"
          aria-pressed={bag.view() === "settings"}
          onClick={() => navigate(() => bag.showSettings())}
        >
          settings
        </button>
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
