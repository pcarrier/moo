import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { createMutable } from "solid-js/store";
import {
  anchorFromEventTarget,
  renderMarkdown,
  renderMarkdownInline,
  renderUserMessage,
  repoFilePathFromHref,
} from "./markdown";
import {
  formatHjson,
  formatHjsonTextForView,
  highlightAuto,
  highlightMarkdownCode,
  maybeFormatHjsonTextForView,
} from "./syntax";
import { collapseHome } from "./paths";
import { DiffView } from "./DiffView";
import { LoadingDots } from "./LoadingDots";
import { ChatTerminals } from "./TerminalView";

import type { Bag, DismissedReply } from "./state";
import { absoluteTime, displayChatId } from "./state";
import { RightSidebarToggle } from "./Sidebar";
import {
  api,
  type ChatAutocompleteSuggestion,
  type FsEntry,
  type FsSearchEntry,
} from "./api";
import type {
  ChoiceSpec,
  FormField,
  FormSpec,
  BlobAddItem,
  DiffStats,
  ImageAttachment,
  FileDiffItem,
  MemoryDiffItem,
  InputItem,
  InputResponseItem,
  LogItem,
  StepItem,
  TimelineItem,
  UiApp,
} from "./api";

type PlayPromptMode = "restart" | "resume" | null;

type TimelineExpansionStore = {
  isOpen: (key: string) => boolean;
  setOpen: (key: string, open: boolean) => void;
  shown: (key: string) => number;
  setShown: (key: string, shown: number) => void;
};

type DismissedTimelineEntry =
  | { kind: "draft"; reply: DismissedReply }
  | { kind: "item"; item: StepItem };

type TimelineRenderEntry =
  | { kind: "item"; item: TimelineItem }
  | {
      kind: "dismissed";
      id: string;
      at: number;
      entries: DismissedTimelineEntry[];
    };

const COPY_FEEDBACK_MS = 1600;

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to the legacy selection-based path below. Some browsers expose
      // navigator.clipboard but reject writes outside secure contexts.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.insetBlockStart = "-1000px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);

  const selection = document.getSelection();
  const ranges: Range[] = [];
  if (selection) {
    for (let i = 0; i < selection.rangeCount; i += 1)
      ranges.push(selection.getRangeAt(i));
  }

  textarea.focus();
  textarea.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy command rejected");
  } finally {
    textarea.remove();
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}

function timelineTypeOrder(item: TimelineItem): number {
  switch (item.type) {
    case "input":
      return 10;
    case "input-response":
      return 20;
    case "step":
      return 30;
    case "log":
      return 40;
    case "trail":
      return 50;
    case "file-diff":
    case "blob-add":
    case "memory-diff":
      return 60;
    default:
      return 100;
  }
}

function compareTimelineItems(a: TimelineItem, b: TimelineItem): number {
  return (
    (a.at ?? 0) - (b.at ?? 0) || timelineTypeOrder(a) - timelineTypeOrder(b)
  );
}

function insertTimelineItemChronologically(
  rows: TimelineItem[],
  item: TimelineItem,
): TimelineItem[] {
  const next = rows.slice();
  const index = next.findIndex((row) => compareTimelineItems(item, row) < 0);
  if (index < 0) next.push(item);
  else next.splice(index, 0, item);
  return next;
}

function timelineExpansionKey(item: TimelineItem): string {
  if (item.type === "step") return `step:${item.step}`;
  if (item.type === "input") return `input:${item.requestId}`;
  if (item.type === "input-response")
    return `input-response:${item.responseId}`;
  if (item.type === "log") return `log:${item.id}`;
  if (item.type === "trail") return `trail:${item.id}`;
  if (item.type === "memory-diff") return `memory-diff:${item.id}`;
  if (item.type === "blob-add") return `blob-add:${item.id}`;
  return `file-diff:${item.id}`;
}

function replyDraftKey(item: TimelineItem): string | null {
  if (item.type !== "step") return null;
  return item.kind === "agent:Reply" && item.draftId
    ? `step:draft:${item.draftId}`
    : null;
}

function timelineItemKey(item: TimelineItem): string {
  if (item.type === "step") return replyDraftKey(item) ?? `step:${item.step}`;
  if (item.type === "input") return `input:${item.requestId}`;
  if (item.type === "input-response")
    return `input-response:${item.responseId}`;
  if (item.type === "log") return `log:${item.id}`;
  if (item.type === "trail") return `trail:${item.id}`;
  if (item.type === "memory-diff") return `memory-diff:${item.id}`;
  if (item.type === "blob-add") return `blob-add:${item.id}`;
  return `file-diff:${item.id}`;
}

function timelineAnchorKey(item: TimelineItem): string {
  if (item.type === "step") return `step:${item.step}`;
  return timelineItemKey(item);
}

function timelineJumpKeys(item: TimelineItem): string[] {
  const keys = [timelineAnchorKey(item)];
  const renderKey = timelineItemKey(item);
  if (!keys.includes(renderKey)) keys.push(renderKey);
  if (
    (item.type === "file-diff" ||
      item.type === "memory-diff" ||
      item.type === "blob-add") &&
    item.step
  ) {
    keys.push(`step:${item.step}`);
  }
  return keys;
}

function isCancelledTimelineItem(item: TimelineItem): item is StepItem {
  return item.type === "step" && item.status === "agent:Cancelled";
}

function dismissedTimelineEntryKey(entry: DismissedTimelineEntry): string {
  if (entry.kind === "draft") return `draft:${entry.reply.id}`;
  return timelineItemKey(entry.item);
}

function dismissedTimelineEntryAt(entry: DismissedTimelineEntry): number {
  return entry.kind === "draft" ? entry.reply.at : entry.item.at;
}

function sameDismissedTimelineEntries(
  a: DismissedTimelineEntry[],
  b: DismissedTimelineEntry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.kind !== right.kind) return false;
    if (left.kind === "draft" && right.kind === "draft") {
      if (left.reply !== right.reply) return false;
    } else if (left.kind === "item" && right.kind === "item") {
      if (left.item !== right.item) return false;
    } else {
      return false;
    }
  }
  return true;
}

function timelineRenderEntries(
  items: TimelineItem[],
  dismissedReplies: DismissedReply[],
  cache?: Map<string, TimelineRenderEntry>,
): TimelineRenderEntry[] {
  const rows: Array<
    | { bucket: "item"; at: number; order: number; item: TimelineItem }
    | {
        bucket: "dismissed";
        at: number;
        order: number;
        entry: DismissedTimelineEntry;
      }
  > = [];

  items.forEach((item, order) => {
    const at = Number(item.at) || 0;
    if (isCancelledTimelineItem(item)) {
      rows.push({
        bucket: "dismissed",
        at,
        order,
        entry: { kind: "item", item },
      });
    } else {
      rows.push({ bucket: "item", at, order, item });
    }
  });

  dismissedReplies.forEach((reply, index) => {
    rows.push({
      bucket: "dismissed",
      at: Number(reply.at) || Date.now(),
      order: items.length + index,
      entry: { kind: "draft", reply },
    });
  });

  rows.sort((a, b) => a.at - b.at || a.order - b.order);

  const rendered: TimelineRenderEntry[] = [];
  let dismissed: DismissedTimelineEntry[] = [];
  const flushDismissed = () => {
    if (dismissed.length === 0) return;
    const first = dismissed[0]!;
    const id = `dismissed:${dismissed.map(dismissedTimelineEntryKey).join(":")}`;
    const at = dismissedTimelineEntryAt(first);
    const previous = cache?.get(id);
    if (
      previous?.kind === "dismissed" &&
      previous.at === at &&
      sameDismissedTimelineEntries(previous.entries, dismissed)
    ) {
      rendered.push(previous);
    } else {
      rendered.push({
        kind: "dismissed",
        id,
        at,
        entries: dismissed,
      });
    }
    dismissed = [];
  };

  for (const row of rows) {
    if (row.bucket === "dismissed") {
      dismissed.push(row.entry);
    } else {
      flushDismissed();
      const key = timelineItemKey(row.item);
      const previous = cache?.get(key);
      rendered.push(
        previous?.kind === "item" && previous.item === row.item
          ? previous
          : { kind: "item", item: row.item },
      );
    }
  }
  flushDismissed();
  if (cache) {
    cache.clear();
    for (const entry of rendered)
      cache.set(
        entry.kind === "dismissed" ? entry.id : timelineItemKey(entry.item),
        entry,
      );
  }
  return rendered;
}

function formatThoughtDuration(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}m ${remaining}s`;
}

function isTerminalStepStatus(status: string | undefined): boolean {
  return (
    status === "agent:Done" ||
    status === "agent:Failed" ||
    status === "agent:Cancelled"
  );
}

function isRunningToolTimelineItem(item: TimelineItem): boolean {
  return (
    item.type === "step" &&
    item.kind === "agent:ToolCall" &&
    !isTerminalStepStatus(item.status)
  );
}

function formatThinkingElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function HeaderAppList(props: {
  apps: UiApp[];
  openUiId: string | null | undefined;
  onOpen: (id: string) => void;
  onOpenCode: (id: string) => void;
}) {
  const count = () => props.apps.length;
  return (
    <Show when={count() > 0}>
      <nav class="timeline-header-apps" aria-label="Timeline apps">
        <span class="timeline-header-apps-label">Apps</span>
        <For each={props.apps}>
          {(app) => (
            <span class="timeline-header-app-group">
              <button
                type="button"
                class="timeline-header-app"
                classList={{ active: props.openUiId === app.id }}
                title={app.description || `Open ${app.title || app.id}`}
                onClick={() => props.onOpen(app.id)}
              >
                <span class="app-icon">{app.icon || "▣"}</span>
                <span class="timeline-header-app-title">
                  {app.title || app.id}
                </span>
              </button>
              <button
                type="button"
                class="timeline-header-app-code"
                title={`Open code for ${app.title || app.id}`}
                aria-label={`Open code for ${app.title || app.id}`}
                onClick={() => props.onOpenCode(app.id)}
              >
                code
              </button>
            </span>
          )}
        </For>
      </nav>
    </Show>
  );
}

export function Timeline(props: {
  bag: Bag;
  onToggleSidebar: () => void;
  onOpenSidebar?: () => void;
}) {
  const { bag, onToggleSidebar } = props;
  const [lightboxImage, setLightboxImage] =
    createSignal<ImageAttachment | null>(null);
  const openLightbox = (attachment: ImageAttachment) =>
    setLightboxImage(attachment);
  const closeLightbox = () => setLightboxImage(null);

  const handleLightboxKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && lightboxImage()) closeLightbox();
  };
  onMount(() => window.addEventListener("keydown", handleLightboxKeyDown));
  onCleanup(() => window.removeEventListener("keydown", handleLightboxKeyDown));

  const handleMarkdownClick = (e: MouseEvent) => {
    const anchor = anchorFromEventTarget(e.target);
    if (!anchor || !timelineEl?.contains(anchor)) return;
    const href = anchor.getAttribute("href") || "";
    if (href === "/settings") {
      e.preventDefault();
      bag.showSettings();
      return;
    }
    const path = repoFilePathFromHref(href);
    if (!path) return;
    e.preventDefault();
    props.onOpenSidebar?.();
    void bag.openFileInSidebar(path);
  };
  let timelineEl: HTMLDivElement | undefined;
  let handledTimelineJumpId = 0;
  let timelineJumpHighlightTimer: number | undefined;

  const [thinkingNow, setThinkingNow] = createSignal(Date.now());
  let thinkingTimer: number | undefined;
  createEffect(() => {
    if (bag.thinking()) {
      setThinkingNow(Date.now());
      if (thinkingTimer === undefined) {
        thinkingTimer = window.setInterval(
          () => setThinkingNow(Date.now()),
          1000,
        );
      }
    } else if (thinkingTimer !== undefined) {
      window.clearInterval(thinkingTimer);
      thinkingTimer = undefined;
    }
  });
  onCleanup(() => {
    if (thinkingTimer !== undefined) window.clearInterval(thinkingTimer);
    if (timelineJumpHighlightTimer !== undefined)
      window.clearTimeout(timelineJumpHighlightTimer);
  });

  const thinkingElapsed = createMemo(() => {
    const startedAt = bag.thinkingStartedAt();
    return startedAt === null
      ? "0:00"
      : formatThinkingElapsed(thinkingNow() - startedAt);
  });

  // Keep the scroll position stable across timeline refreshes. If the user is
  // at the bottom, new content sticks to the bottom. If they have scrolled up,
  // remember the first visible timeline row and keep it pinned even when rows
  // above it are inserted, markdown streams in, or media/code blocks resize.
  let stuck = true;
  let scrollAnchor: { key: string; offset: number } | null = null;
  let restoreFrame: number | undefined;
  const timelineAnchorSelector = "[data-timeline-key]";
  const isAtBottom = () => {
    if (!timelineEl) return true;
    const slack = parseFloat(getComputedStyle(timelineEl).fontSize) * 3;
    return (
      timelineEl.scrollTop + timelineEl.clientHeight >=
      timelineEl.scrollHeight - slack
    );
  };
  const scrollToBottom = () => {
    if (!timelineEl) return;
    timelineEl.scrollTop = timelineEl.scrollHeight;
  };
  const anchorElements = () =>
    timelineEl
      ? Array.from(
          timelineEl.querySelectorAll<HTMLElement>(timelineAnchorSelector),
        )
      : [];
  const findAnchorElement = (key: string) => {
    if (!timelineEl) return null;
    // Avoid scanning every anchor: a direct attribute selector is O(1)-ish
    // in modern engines and replaces the prior O(N) Array.from+find that
    // turned timeline jumps into O(N^2) work on long chats.
    try {
      return timelineEl.querySelector<HTMLElement>(
        `[data-timeline-key="${(window as any).CSS && (CSS as any).escape ? (CSS as any).escape(key) : key.replace(/["\\\\]/g, (c) => "\\\\" + c)}"]`,
      );
    } catch {
      return (
        anchorElements().find((el) => el.dataset.timelineKey === key) ?? null
      );
    }
  };
  const captureScrollAnchor = () => {
    if (!timelineEl) return;
    const containerRect = timelineEl.getBoundingClientRect();
    const top = containerRect.top;
    const bottom = containerRect.bottom;
    const firstVisible = anchorElements().find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.bottom > top + 1 && rect.top < bottom - 1;
    });
    if (!firstVisible?.dataset.timelineKey) {
      scrollAnchor = null;
      return;
    }
    scrollAnchor = {
      key: firstVisible.dataset.timelineKey,
      offset: firstVisible.getBoundingClientRect().top - top,
    };
  };
  const restoreScrollAnchor = () => {
    if (!timelineEl) return;
    if (stuck) {
      scrollToBottom();
      return;
    }
    if (!scrollAnchor) return;
    const el = findAnchorElement(scrollAnchor.key);
    if (!el) return;
    const containerTop = timelineEl.getBoundingClientRect().top;
    const nextOffset = el.getBoundingClientRect().top - containerTop;
    timelineEl.scrollTop += nextOffset - scrollAnchor.offset;
  };
  const scheduleScrollRestore = () => {
    if (restoreFrame !== undefined) return;
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = undefined;
      restoreScrollAnchor();
      if (!stuck) captureScrollAnchor();
    });
  };
  const clearTimelineJumpHighlights = () => {
    if (!timelineEl) return;
    for (const el of timelineEl.querySelectorAll<HTMLElement>(
      ".timeline-jump-highlight",
    )) {
      el.classList.remove("timeline-jump-highlight");
    }
  };
  const highlightTimelineJump = (el: HTMLElement) => {
    clearTimelineJumpHighlights();
    el.classList.add("timeline-jump-highlight");
    if (timelineJumpHighlightTimer !== undefined)
      window.clearTimeout(timelineJumpHighlightTimer);
    timelineJumpHighlightTimer = window.setTimeout(() => {
      timelineJumpHighlightTimer = undefined;
      el.classList.remove("timeline-jump-highlight");
    }, 1800);
  };
  const findTimelineJumpElement = (target: {
    key?: string;
    at?: number;
    id?: string;
  }) => {
    if (!timelineEl) return null;
    if (target.key) {
      const byKey = findAnchorElement(target.key);
      if (byKey) return byKey;
    }
    if (target.id) {
      const idKey = target.id.includes(":") ? target.id : `trail:${target.id}`;
      const byId = findAnchorElement(idKey);
      if (byId) return byId;
    }
    const at = Number(target.at);
    if (Number.isFinite(at)) {
      const candidates = bag
        .timeline()
        .filter(
          (item) =>
            item.type !== "trail" &&
            Number.isFinite(Number((item as { at?: number }).at)),
        )
        .sort(
          (a, b) =>
            Math.abs(Number((a as { at?: number }).at) - at) -
            Math.abs(Number((b as { at?: number }).at) - at),
        );
      for (const item of candidates) {
        for (const key of timelineJumpKeys(item)) {
          const el = findAnchorElement(key);
          if (el) return el;
        }
      }
    }
    return null;
  };
  onMount(() => {
    const handleScroll = () => {
      stuck = isAtBottom();
      if (!stuck) captureScrollAnchor();
    };
    timelineEl?.addEventListener("scroll", handleScroll, { passive: true });
    const mutationObserver = new MutationObserver(scheduleScrollRestore);
    if (timelineEl) {
      mutationObserver.observe(timelineEl, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    const resizeObserver = new ResizeObserver(scheduleScrollRestore);
    // Track which anchors we currently observe so each MutationObserver tick
    // does an incremental diff (O(changed)) instead of disconnecting and
    // reattaching every anchor (which made initial render of long chats
    // quadratic: each appended item caused a full sweep of all prior items).
    const observedAnchors = new Set<HTMLElement>();
    const refreshResizeTargets = () => {
      if (!timelineEl) return;
      if (!observedAnchors.has(timelineEl as unknown as HTMLElement)) {
        resizeObserver.observe(timelineEl);
        observedAnchors.add(timelineEl as unknown as HTMLElement);
      }
      const live = new Set<HTMLElement>(anchorElements());
      for (const el of observedAnchors) {
        if (el === (timelineEl as unknown as HTMLElement)) continue;
        if (!live.has(el)) {
          resizeObserver.unobserve(el);
          observedAnchors.delete(el);
        }
      }
      for (const el of live) {
        if (!observedAnchors.has(el)) {
          resizeObserver.observe(el);
          observedAnchors.add(el);
        }
      }
    };
    let refreshScheduled = false;
    const scheduleRefreshResizeTargets = () => {
      if (refreshScheduled) return;
      refreshScheduled = true;
      requestAnimationFrame(() => {
        refreshScheduled = false;
        refreshResizeTargets();
      });
    };
    refreshResizeTargets();
    // Coalesce mutation bursts (markdown rendering inserts many nodes per
    // item) into one rAF-scheduled reconciliation rather than one per
    // mutation record.
    const targetObserver = new MutationObserver(scheduleRefreshResizeTargets);
    if (timelineEl)
      targetObserver.observe(timelineEl, { childList: true, subtree: true });
    scrollToBottom();
    onCleanup(() => {
      timelineEl?.removeEventListener("scroll", handleScroll);
      mutationObserver.disconnect();
      targetObserver.disconnect();
      resizeObserver.disconnect();
      if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame);
    });
  });

  createEffect(() => {
    const request = bag.timelineJumpRequest();
    if (!request || request.id === handledTimelineJumpId) return;
    handledTimelineJumpId = request.id;
    bag.timeline();
    queueMicrotask(() => {
      requestAnimationFrame(() => {
        const el = findTimelineJumpElement(request.target);
        if (!el || !timelineEl) return;
        stuck = false;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        highlightTimelineJump(el);
        window.setTimeout(captureScrollAnchor, 250);
      });
    });
  });

  // Re-scroll on every reactive change that could grow the timeline.
  createEffect(() => {
    bag.timeline();
    bag.draftReply();
    bag.thinking();
    bag.pending();
    if (stuck) {
      // Defer to next frame so the DOM has actually grown.
      queueMicrotask(scrollToBottom);
    } else {
      scheduleScrollRestore();
    }
  });

  const draftReplyProxies = new Map<string, StepItem>();
  const draftProxyFor = (draftId: string): StepItem => {
    let item = draftReplyProxies.get(draftId);
    if (!item) {
      item = createMutable<StepItem>({
        type: "step",
        step: `draft:${draftId}` as StepItem["step"],
        kind: "agent:Reply",
        status: "agent:Running",
        at: Date.now(),
        text: "",
        draftId,
      });
      draftReplyProxies.set(draftId, item);
    }
    return item;
  };
  const syncDraftProxy = (target: StepItem, source: StepItem) => {
    target.step = source.step;
    target.kind = source.kind;
    target.status = source.status;
    target.at = source.at;
    target.text = source.text;
    target.model = source.model;
    target.effort = source.effort;
    target.thoughtDurationMs = source.thoughtDurationMs;
    target.draftId = source.draftId;
  };
  const syncActiveDraftProxy = (
    target: StepItem,
    draft: { draftId: string; content: string; at: number },
  ) => {
    target.step = `draft:${draft.draftId}` as StepItem["step"];
    target.kind = "agent:Reply";
    target.status = "agent:Running";
    target.at = Number(draft.at) || Date.now();
    target.text = draft.content;
    target.draftId = draft.draftId;
  };

  const visibleTimeline = createMemo(() => {
    const draft = bag.draftReply();
    const rows = bag
      .timeline()
      .filter((item) => item.type !== "trail")
      .map((item) => {
        if (
          item.type !== "step" ||
          item.kind !== "agent:Reply" ||
          !item.draftId
        )
          return item;
        const proxy = draftReplyProxies.get(item.draftId);
        if (!proxy) return item;
        syncDraftProxy(proxy, item);
        return proxy;
      });
    if (!draft || draft.chatId !== bag.chatId() || !draft.content) return rows;
    if (
      rows.some(
        (item) =>
          item.type === "step" &&
          item.kind === "agent:Reply" &&
          item.draftId === draft.draftId,
      )
    ) {
      return rows;
    }
    const proxy = draftProxyFor(draft.draftId);
    syncActiveDraftProxy(proxy, draft);
    return insertTimelineItemChronologically(rows, proxy);
  });
  const visibleDismissedReplies = createMemo(() => {
    const id = bag.chatId();
    if (!id) return [];
    return bag
      .dismissedReplies()
      .filter((reply) => reply.chatId === id && reply.content.trim());
  });
  const renderEntryCache = new Map<string, TimelineRenderEntry>();
  const renderedTimeline = createMemo(() =>
    timelineRenderEntries(
      visibleTimeline(),
      visibleDismissedReplies(),
      renderEntryCache,
    ),
  );
  const hasRunningToolRow = createMemo(() =>
    visibleTimeline().some(isRunningToolTimelineItem),
  );
  const hasStreamingReply = () =>
    Boolean(
      bag.draftReply()?.chatId === bag.chatId() && bag.draftReply()?.content,
    );
  const showStandaloneThinking = () =>
    bag.thinking() && !hasStreamingReply() && !hasRunningToolRow();
  const currentChat = () => bag.currentChatSummary();
  const emptyTitle = () =>
    (
      bag.currentChatTitle() ||
      (bag.chatId() ? displayChatId(bag.chatId()) : "")
    ).trim();
  const chatReady = () => bag.loadedChatId() === bag.chatId();
  const chatLoading = () => !!bag.chatId() && !chatReady();
  const hasOnlyTrail = () =>
    !!bag.chatId() &&
    bag.timeline().length > 0 &&
    visibleTimeline().length === 0;
  return (
    <div class="chat-shell">
      <section class="main conversation-main">
        <header
          class="conv-header"
          classList={{ "chat-loading": chatLoading() }}
        >
          <button
            class="header-icon-button"
            title="toggle sidebar"
            onClick={onToggleSidebar}
          >
            ☰
          </button>
          <ParentChatLink bag={bag} />
          <h1 class="page-title chat-page-title">{emptyTitle() || "Chat"}</h1>
          <Show when={!chatLoading()}>
            <ModelPicker bag={bag} />
            <div class="conv-token-slot">
              <TokenBar tokens={bag.tokens} />
            </div>
          </Show>
          <RightSidebarToggle bag={bag} />
        </header>
        <Show when={!chatLoading()}>
          <HeaderAppList
            apps={bag.chatUiApps()}
            openUiId={bag.openUiId()}
            onOpen={(id) => bag.openUi(id)}
            onOpenCode={(id) => bag.openAppCodeInSidebar(id)}
          />
        </Show>
        <Show when={bag.chatId()}>
          {(chatId) => <ChatTerminals chatId={chatId()} />}
        </Show>
        <main class="timeline" ref={timelineEl} onClick={handleMarkdownClick}>
          <Show
            when={chatReady()}
            fallback={
              <div class="empty">
                <LoadingDots class="thinking-dots" label="loading chat" />
              </div>
            }
          >
            <Show
              when={bag.chatId()}
              fallback={
                <div class="empty">
                  no chats yet — start a new chat from the sidebar
                </div>
              }
            >
              <Show
                when={
                  visibleTimeline().length > 0 ||
                  visibleDismissedReplies().length > 0 ||
                  showStandaloneThinking() ||
                  bag.draftReply() != null
                }
                fallback={
                  <div class="empty">
                    <Show
                      when={hasOnlyTrail()}
                      fallback={
                        <>
                          nothing yet — try <code>/help</code>
                        </>
                      }
                    >
                      <div class="empty-title">
                        {emptyTitle() || "This chat"}
                      </div>
                      <div>No conversation messages yet.</div>
                      <Show when={currentChat()?.hidden}>
                        <div>
                          This is a hidden child chat. Use the back link in the
                          header to return to its parent.
                        </div>
                      </Show>
                      <div>
                        Open the trail sidebar to see title and summary entries.
                      </div>
                    </Show>
                  </div>
                }
              >
                <Show when={bag.hiddenTimelineItems() > 0}>
                  <button
                    type="button"
                    class="load-older"
                    onClick={() => bag.loadOlderTimeline()}
                  >
                    Load {bag.olderTimelineLoadCount()} older items ·{" "}
                    {bag.hiddenTimelineItems()} hidden
                  </button>
                </Show>
                <For each={renderedTimeline()}>
                  {(entry) =>
                    entry.kind === "dismissed" ? (
                      <DismissedBlock
                        group={entry}
                        bag={bag}
                        onOpenImage={openLightbox}
                      />
                    ) : (
                      <Item
                        item={entry.item}
                        bag={bag}
                        onOpenImage={openLightbox}
                      />
                    )
                  }
                </For>
                <Show when={showStandaloneThinking()}>
                  <div class="step thinking" data-timeline-key="thinking">
                    <LoadingDots class="thinking-dots" label="thinking" />
                    <div class="meta">Thinking… {thinkingElapsed()}</div>
                  </div>
                </Show>
              </Show>
            </Show>
          </Show>
        </main>
        <Show when={lightboxImage()}>
          {(att) => (
            <div
              class="image-lightbox-backdrop"
              role="dialog"
              aria-modal="true"
              aria-label={
                att().name ? `Image preview: ${att().name}` : "Image preview"
              }
              onClick={closeLightbox}
            >
              <button
                type="button"
                class="image-lightbox-close"
                aria-label="close image preview"
                onClick={closeLightbox}
              >
                ×
              </button>
              <img
                class="image-lightbox-image"
                src={att().dataUrl}
                alt={att().name || "image"}
                onClick={(e) => e.stopPropagation()}
              />
              <Show when={att().name}>
                <div
                  class="image-lightbox-caption"
                  onClick={(e) => e.stopPropagation()}
                >
                  {att().name}
                </div>
              </Show>
            </div>
          )}
        </Show>
        <PendingList bag={bag} onOpenImage={openLightbox} />
        <InputBar bag={bag} />
      </section>
    </div>
  );
}

const readImageAttachment = (file: File) =>
  new Promise<ImageAttachment>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        type: "image",
        mimeType: file.type || "image/png",
        dataUrl: String(reader.result),
        name: file.name || "pasted image",
      });
    reader.onerror = () =>
      reject(reader.error || new Error("failed to read image"));
    reader.readAsDataURL(file);
  });

const imageAttachmentsFromFiles = async (files: File[]) => {
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (!images.length) return [];
  return Promise.all(images.map(readImageAttachment));
};

function PendingList(props: {
  bag: Bag;
  onOpenImage: (attachment: ImageAttachment) => void;
}) {
  const { bag, onOpenImage } = props;
  // Only show pending items that belong to the current chat. Items queued
  // for other chats keep draining in the background but stay out of the
  // user's way.
  const visible = () => bag.pending().filter((p) => p.chatId === bag.chatId());
  return (
    <Show when={visible().length > 0}>
      <ul class="pending-list">
        <Index each={visible()}>
          {(item) => (
            <PendingItem item={item} bag={bag} onOpenImage={onOpenImage} />
          )}
        </Index>
      </ul>
    </Show>
  );
}

function PendingItem(props: {
  item: () => ReturnType<Bag["pending"]>[number];
  bag: Bag;
  onOpenImage: (attachment: ImageAttachment) => void;
}) {
  let inputEl: HTMLTextAreaElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  let blurTimer: number | null = null;
  const [autocompleteEnabled, setAutocompleteEnabled] = createSignal(false);
  const addImages = async (files: File[]) => {
    const next = await imageAttachmentsFromFiles(files);
    props.bag.addPendingAttachments(props.item().id, next);
  };
  const handleFilePick = (e: Event) => {
    const el = e.currentTarget as HTMLInputElement;
    const files = Array.from(el.files || []);
    void addImages(files);
    el.value = "";
  };
  const autosize = () => {
    if (!inputEl) return;
    inputEl.style.height = "auto";
    const max = 320;
    const next = Math.min(inputEl.scrollHeight, max);
    inputEl.style.height = next + "px";
    inputEl.style.overflowY = inputEl.scrollHeight > max ? "auto" : "hidden";
  };
  createEffect(() => {
    props.item().text;
    queueMicrotask(autosize);
  });
  const focusMessageInput = () => inputEl?.focus({ preventScroll: true });
  const autocomplete = createComposerAutocomplete({
    value: () => props.item().text,
    setValue: (value) => props.bag.editPending(props.item().id, value),
    cursorFromInput: () => inputEl?.selectionStart,
    setSelectionRange: (start, end) => inputEl?.setSelectionRange(start, end),
    currentChatWorktreePath: () => props.bag.currentChatWorktreePath(),
    autosize,
    focus: focusMessageInput,
    enabled: autocompleteEnabled,
  });
  const beginEditing = () => {
    if (blurTimer !== null) {
      window.clearTimeout(blurTimer);
      blurTimer = null;
    }
    setAutocompleteEnabled(true);
    props.bag.beginPendingEdit(props.item().id);
  };
  const finishEditingSoon = () => {
    if (blurTimer !== null) window.clearTimeout(blurTimer);
    blurTimer = window.setTimeout(() => {
      blurTimer = null;
      setAutocompleteEnabled(false);
      autocomplete.closeAutocomplete();
      props.bag.endPendingEdit(props.item().id);
    }, 120);
  };
  onCleanup(() => {
    if (blurTimer !== null) window.clearTimeout(blurTimer);
    setAutocompleteEnabled(false);
    props.bag.endPendingEdit(props.item().id);
  });
  return (
    <li class="pending-item">
      <Show when={props.item().attachments?.length}>
        <div class="attachment-strip">
          <Index each={props.item().attachments || []}>
            {(attachment, i) => (
              <div class="attachment-thumb">
                <button
                  type="button"
                  class="attachment-thumb-open"
                  onClick={() => props.onOpenImage(attachment())}
                  title={attachment().name || "open image"}
                >
                  <img
                    src={attachment().dataUrl}
                    alt={attachment().name || "attachment"}
                  />
                </button>
                <button
                  type="button"
                  class="attachment-remove"
                  title="remove image"
                  aria-label="remove image"
                  onClick={() =>
                    props.bag.removePendingAttachment(props.item().id, i)
                  }
                >
                  ×
                </button>
              </div>
            )}
          </Index>
        </div>
      </Show>
      <div class="message-row pending-message-row">
        <button
          type="button"
          class="attach-btn"
          title="attach image"
          aria-label="attach image"
          onClick={() => fileInput?.click()}
        >
          +
        </button>
        <input
          ref={(e) => (fileInput = e)}
          class="attachment-file-input"
          type="file"
          accept="image/*"
          multiple
          onChange={handleFilePick}
        />
        <div class="composer-field">
          <AutocompleteDropdown autocomplete={autocomplete} />
          <textarea
            ref={(el) => (inputEl = el)}
            class="message-input pending-input"
            rows={1}
            autocomplete="off"
            value={props.item().text}
            onInput={(e) => {
              beginEditing();
              props.bag.editPending(props.item().id, e.currentTarget.value);
              autocomplete.updateComposerCursor();
              autosize();
            }}
            onKeyDown={(e) => autocomplete.handleAutocompleteKey(e)}
            onKeyUp={autocomplete.updateComposerCursor}
            onClick={autocomplete.updateComposerCursor}
            onSelect={autocomplete.updateComposerCursor}
            onFocus={() => {
              beginEditing();
              autocomplete.updateComposerCursor();
              autocomplete.openAutocomplete();
            }}
            onBlur={finishEditingSoon}
            aria-label="queued message"
          />
        </div>
        <button
          type="button"
          class="primary send-btn pending-remove-btn"
          title="remove queued message"
          aria-label="remove queued message"
          onClick={() => props.bag.removePending(props.item().id)}
        >
          ×
        </button>
      </div>
    </li>
  );
}

function formatAutocompleteChat(
  suggestion: ChatAutocompleteSuggestion,
): string {
  const title = suggestion.chatTitle?.trim();
  return title || suggestion.chatId;
}

function formatAutocompleteTime(ms: number): string {
  return absoluteTime(ms);
}

type AutocompleteMode = "chat" | "path";

const PATH_AUTOCOMPLETE_LIMIT = 24;
const PATH_AUTOCOMPLETE_FUZZY_MIN_QUERY = 2;

type PathAutocompleteContext = {
  start: number;
  end: number;
  basePath: string;
  query: string;
  dirPrefix: string;
  namePrefix: string;
  listDir: string;
};

type PathAutocompleteSuggestion = {
  name: string;
  path: string;
  kind: string;
  size: number;
  mtime: number;
};

type PathAutocompleteSnapshot = {
  key: string;
  suggestions: PathAutocompleteSuggestion[];
  loading: boolean;
  interactive: boolean;
};

const PATH_TOKEN_BOUNDARIES = "([{\"'`";

function isPathTokenBoundary(value: string): boolean {
  return (
    value === "" || /\s/.test(value) || PATH_TOKEN_BOUNDARIES.includes(value)
  );
}

function findPathAutocompleteContext(
  text: string,
  cursor: number,
  basePath: string | null | undefined,
): PathAutocompleteContext | null {
  if (!basePath) return null;
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  let at = safeCursor > 0 ? text.lastIndexOf("@", safeCursor - 1) : -1;
  while (at >= 0) {
    const hasBoundary = isPathTokenBoundary(at === 0 ? "" : text[at - 1] || "");
    const rawBeforeCursor = text.slice(at + 1, safeCursor);
    if (hasBoundary && !/\s/.test(rawBeforeCursor)) break;
    at = at > 0 ? text.lastIndexOf("@", at - 1) : -1;
  }
  if (at < 0) return null;

  const rawBeforeCursor = text.slice(at + 1, safeCursor);
  if (/\s/.test(rawBeforeCursor)) return null;

  let end = safeCursor;
  while (end < text.length && !/\s/.test(text[end] || "")) end += 1;

  const lastSlash = rawBeforeCursor.lastIndexOf("/");
  const dirPrefix =
    lastSlash >= 0 ? rawBeforeCursor.slice(0, lastSlash + 1) : "";
  const namePrefix =
    lastSlash >= 0 ? rawBeforeCursor.slice(lastSlash + 1) : rawBeforeCursor;
  const relativeDir = dirPrefix.replace(/^\/+/, "").replace(/\/+$/, "");
  const base = basePath.replace(/\/+$/, "");
  const listDir = relativeDir ? base + "/" + relativeDir : base || "/";

  return {
    start: at,
    end,
    basePath: base,
    query: rawBeforeCursor.replace(/^\/+/, ""),
    dirPrefix,
    namePrefix,
    listDir,
  };
}

function pathAutocompleteKey(context: PathAutocompleteContext): string {
  return [
    context.basePath,
    context.listDir,
    context.dirPrefix,
    context.namePrefix,
    context.query,
  ].join("\0");
}

function pathAutocompleteRank(name: string, prefix: string): number {
  if (!prefix) return 2;
  const lowerName = name.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lowerName === lowerPrefix) return 5;
  if (lowerName.startsWith(lowerPrefix)) return 4;
  if (lowerName.includes(lowerPrefix)) return 2;
  return 0;
}

function pathAutocompleteSuggestions(
  context: PathAutocompleteContext,
  entries: FsEntry[],
  limit: number,
): PathAutocompleteSuggestion[] {
  const prefix = context.namePrefix;
  return entries
    .filter((entry) => isPathAutocompleteEntry(entry))
    .filter((entry) => prefix.startsWith(".") || !entry.name.startsWith("."))
    .map((entry) => ({ entry, rank: pathAutocompleteRank(entry.name, prefix) }))
    .filter(({ rank }) => rank > 0)
    .sort((a, b) => {
      const ak = a.entry.kind === "dir" ? 0 : 1;
      const bk = b.entry.kind === "dir" ? 0 : 1;
      if (ak !== bk) return ak - bk;
      if (a.rank !== b.rank) return b.rank - a.rank;
      return a.entry.name.localeCompare(b.entry.name, undefined, {
        sensitivity: "base",
      });
    })
    .slice(0, limit)
    .map(({ entry }) =>
      pathAutocompleteSuggestionFromEntry(
        context.dirPrefix + entry.name,
        entry,
      ),
    );
}

function isPathAutocompleteEntry(entry: unknown): entry is FsEntry {
  return Boolean(
    entry &&
    typeof entry === "object" &&
    typeof (entry as FsEntry).name === "string",
  );
}

function pathAutocompleteSuggestionFromEntry(
  path: string,
  entry: FsEntry,
): PathAutocompleteSuggestion {
  const cleanPath = typeof path === "string" ? path : entry.name;
  const kind = typeof entry.kind === "string" ? entry.kind : "unknown";
  const isDir = kind === "dir";
  return {
    name: entry.name,
    path:
      cleanPath.replace(/^\/+/, "") +
      (isDir && !cleanPath.endsWith("/") ? "/" : ""),
    kind,
    size:
      typeof entry.size === "number" && Number.isFinite(entry.size)
        ? entry.size
        : 0,
    mtime:
      typeof entry.mtime === "number" && Number.isFinite(entry.mtime)
        ? entry.mtime
        : 0,
  };
}

function pathAutocompleteSearchSuggestions(
  entries: FsSearchEntry[],
): PathAutocompleteSuggestion[] {
  return entries
    .filter(
      (entry) =>
        isPathAutocompleteEntry(entry) &&
        typeof entry.relativePath === "string",
    )
    .map((entry) =>
      pathAutocompleteSuggestionFromEntry(entry.relativePath, entry),
    );
}

function mergePathAutocompleteSuggestions(
  direct: PathAutocompleteSuggestion[],
  fuzzy: PathAutocompleteSuggestion[],
  limit: number,
): PathAutocompleteSuggestion[] {
  const seen = new Set<string>();
  const merged: PathAutocompleteSuggestion[] = [];
  for (const suggestion of [...direct, ...fuzzy]) {
    const key = suggestion.path.replace(/\/+$/, "") || suggestion.path;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(suggestion);
    if (merged.length >= limit) break;
  }
  return merged;
}

function formatPathAutocompleteKind(
  suggestion: PathAutocompleteSuggestion,
): string {
  if (suggestion.kind === "dir") return "directory";
  if (suggestion.kind === "file") return "file";
  return suggestion.kind || "path";
}

type CachedPromise<T> = { promise: Promise<T>; value?: T };

const pathAutocompleteListCache = new Map<string, CachedPromise<FsEntry[]>>();
const pathAutocompleteSearchCache = new Map<
  string,
  CachedPromise<FsSearchEntry[]>
>();

function cachedPathAutocompleteListValue(path: string): FsEntry[] | undefined {
  return pathAutocompleteListCache.get(path)?.value;
}

function cachedPathAutocompleteSearchValue(
  basePath: string,
  query: string,
  limit: number,
): FsSearchEntry[] | undefined {
  return pathAutocompleteSearchCache.get(basePath + "\0" + query + "\0" + limit)
    ?.value;
}

async function cachedPathAutocompleteList(path: string): Promise<FsEntry[]> {
  let cached = pathAutocompleteListCache.get(path);
  if (!cached) {
    const promise = api.fs
      .list(path)
      .then((result) =>
        result.ok && Array.isArray(result.value.entries)
          ? result.value.entries
          : [],
      )
      .catch(() => []);
    cached = { promise };
    pathAutocompleteListCache.set(path, cached);
    promise.then(
      (value) => {
        cached.value = value;
      },
      () => {
        if (pathAutocompleteListCache.get(path) === cached)
          pathAutocompleteListCache.delete(path);
      },
    );
  }
  return cached.promise;
}

async function cachedPathAutocompleteSearch(
  basePath: string,
  query: string,
  limit: number,
): Promise<FsSearchEntry[]> {
  const key = basePath + "\0" + query + "\0" + limit;
  let cached = pathAutocompleteSearchCache.get(key);
  if (!cached) {
    const promise = api.fs
      .search(basePath, query, limit)
      .then((result) =>
        result.ok && Array.isArray(result.value.entries)
          ? result.value.entries
          : [],
      )
      .catch(() => []);
    cached = { promise };
    pathAutocompleteSearchCache.set(key, cached);
    promise.then(
      (value) => {
        cached.value = value;
      },
      () => {
        if (pathAutocompleteSearchCache.get(key) === cached)
          pathAutocompleteSearchCache.delete(key);
      },
    );
  }
  return cached.promise;
}

function cachedPathAutocompleteSnapshot(
  context: PathAutocompleteContext,
): PathAutocompleteSnapshot | null {
  const directEntries = cachedPathAutocompleteListValue(context.listDir);
  if (!directEntries) return null;
  const direct = pathAutocompleteSuggestions(
    context,
    directEntries,
    PATH_AUTOCOMPLETE_LIMIT,
  );
  const fuzzyEntries =
    context.query.length >= PATH_AUTOCOMPLETE_FUZZY_MIN_QUERY
      ? cachedPathAutocompleteSearchValue(
          context.basePath,
          context.query,
          PATH_AUTOCOMPLETE_LIMIT,
        )
      : undefined;
  const fuzzy = fuzzyEntries
    ? pathAutocompleteSearchSuggestions(fuzzyEntries)
    : [];
  const suggestions = mergePathAutocompleteSuggestions(
    direct,
    fuzzy,
    PATH_AUTOCOMPLETE_LIMIT,
  );
  return {
    key: pathAutocompleteKey(context),
    suggestions,
    loading:
      context.query.length >= PATH_AUTOCOMPLETE_FUZZY_MIN_QUERY &&
      !fuzzyEntries,
    interactive: true,
  };
}

type ComposerAutocomplete = ReturnType<typeof createComposerAutocomplete>;

type ComposerAutocompleteOptions = {
  value: () => string;
  setValue: (value: string) => void;
  cursorFromInput: () => number | undefined;
  setSelectionRange: (start: number, end: number) => void;
  currentChatWorktreePath: () => string | null | undefined;
  autosize: () => void;
  focus: () => void;
  enabled?: () => boolean;
};

function createComposerAutocomplete(options: ComposerAutocompleteOptions) {
  const [composerCursor, setComposerCursor] = createSignal(0);
  const [autocompleteOpen, setAutocompleteOpen] = createSignal(false);
  const [autocompleteMode, setAutocompleteMode] =
    createSignal<AutocompleteMode>("chat");
  const [autocompleteLoading, setAutocompleteLoading] = createSignal(false);
  const [autocompleteSuggestions, setAutocompleteSuggestions] = createSignal<
    ChatAutocompleteSuggestion[]
  >([]);
  const [pathSnapshot, setPathSnapshot] =
    createSignal<PathAutocompleteSnapshot | null>(null);
  const [autocompleteActive, setAutocompleteActive] = createSignal(0);
  const [chatAutocompleteSuppressedFor, setChatAutocompleteSuppressedFor] =
    createSignal<string | null>(null);
  const [
    pathAutocompleteSuppressedFuzzyFor,
    setPathAutocompleteSuppressedFuzzyFor,
  ] = createSignal<string | null>(null);
  let autocompleteRequestSeq = 0;
  const chatAutocompleteCache = new Map<string, ChatAutocompleteSuggestion[]>();

  const autocompleteQuery = () => options.value().trim();
  const pathAutocompleteContext = createMemo(() =>
    findPathAutocompleteContext(
      options.value(),
      composerCursor(),
      options.currentChatWorktreePath(),
    ),
  );
  const pathSuggestions = () => pathSnapshot()?.suggestions ?? [];
  const activeAutocompleteCount = () =>
    autocompleteMode() === "path"
      ? pathSuggestions().length
      : autocompleteSuggestions().length;
  const pathAutocompleteInteractive = () =>
    pathSnapshot()?.interactive ?? false;
  const showAutocomplete = () => {
    if (!autocompleteOpen()) return false;
    if (autocompleteMode() === "path") return activeAutocompleteCount() > 0;
    return activeAutocompleteCount() > 0;
  };
  const openAutocomplete = () => setAutocompleteOpen(true);
  const closeAutocomplete = () => setAutocompleteOpen(false);
  const updateComposerCursor = () => {
    const value = options.value();
    setComposerCursor(options.cursorFromInput() ?? value.length);
  };
  const applyAutocomplete = (suggestion: ChatAutocompleteSuggestion) => {
    options.setValue(suggestion.text);
    setComposerCursor(suggestion.text.length);
    setAutocompleteOpen(false);
    queueMicrotask(() => {
      options.autosize();
      options.focus();
      options.setSelectionRange(suggestion.text.length, suggestion.text.length);
    });
  };
  const applyPathAutocomplete = (
    suggestion: PathAutocompleteSuggestion | undefined,
  ) => {
    const context = pathAutocompleteContext();
    const snapshot = pathSnapshot();
    if (
      !context ||
      !suggestion ||
      !snapshot?.interactive ||
      snapshot.key !== pathAutocompleteKey(context)
    )
      return;
    const current = options.value();
    const isDir = suggestion.kind === "dir";
    const replacement = "@" + suggestion.path + (isDir ? "" : " ");
    const next =
      current.slice(0, context.start) +
      replacement +
      current.slice(context.end);
    const nextContext = isDir
      ? findPathAutocompleteContext(
          next,
          context.start + replacement.length,
          context.basePath,
        )
      : null;
    setPathAutocompleteSuppressedFuzzyFor(
      nextContext ? pathAutocompleteKey(nextContext) : null,
    );
    const cursor = context.start + replacement.length;
    options.setValue(next);
    setComposerCursor(cursor);
    setAutocompleteOpen(false);
    if (!isDir) setChatAutocompleteSuppressedFor(next);
    queueMicrotask(() => {
      options.autosize();
      options.focus();
      options.setSelectionRange(cursor, cursor);
    });
  };
  const handleAutocompleteKey = (e: KeyboardEvent): boolean => {
    const mode = autocompleteMode();
    const count = activeAutocompleteCount();
    const pathContextActive = mode === "path" && autocompleteOpen();
    if (pathContextActive && e.key === "Tab") {
      e.preventDefault();
      if (e.repeat || count === 0 || !pathAutocompleteInteractive())
        return true;
      const suggestions = pathSuggestions();
      applyPathAutocomplete(
        suggestions[autocompleteActive()] || suggestions[0],
      );
      return true;
    }
    if (
      autocompleteOpen() &&
      count > 0 &&
      (mode !== "path" || pathAutocompleteInteractive())
    ) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAutocompleteActive((i) => (i + 1) % count);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAutocompleteActive((i) => (i - 1 + count) % count);
        return true;
      }
      if (
        e.key === "Tab" ||
        (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey)
      ) {
        e.preventDefault();
        if (e.repeat) return true;
        if (mode === "path") {
          const suggestions = pathSuggestions();
          applyPathAutocomplete(
            suggestions[autocompleteActive()] || suggestions[0],
          );
        } else {
          const suggestions = autocompleteSuggestions();
          applyAutocomplete(
            suggestions[autocompleteActive()] || suggestions[0],
          );
        }
        return true;
      }
    }
    if (e.key === "Escape" && showAutocomplete()) {
      e.preventDefault();
      closeAutocomplete();
      return true;
    }
    return false;
  };

  createEffect(() => {
    const enabled = options.enabled?.() ?? true;
    const seq = ++autocompleteRequestSeq;
    if (!enabled) {
      closeAutocomplete();
      setAutocompleteLoading(false);
      setAutocompleteSuggestions([]);
      setPathSnapshot(null);
      return;
    }
    const context = pathAutocompleteContext();
    const query = autocompleteQuery();
    setAutocompleteActive(0);

    if (context) {
      const key = pathAutocompleteKey(context);
      setAutocompleteMode("path");
      setAutocompleteSuggestions([]);
      openAutocomplete();

      const cached = cachedPathAutocompleteSnapshot(context);
      if (cached) {
        setPathSnapshot(cached);
      } else {
        setPathSnapshot((previous) =>
          previous?.key === key
            ? previous
            : { key, suggestions: [], loading: true, interactive: false },
        );
      }
      setAutocompleteLoading(false);

      const timer = window.setTimeout(async () => {
        const directEntries = await cachedPathAutocompleteList(context.listDir);
        if (seq !== autocompleteRequestSeq) return;

        const direct = pathAutocompleteSuggestions(
          context,
          directEntries,
          PATH_AUTOCOMPLETE_LIMIT,
        );
        const suppressFuzzy =
          untrack(pathAutocompleteSuppressedFuzzyFor) === key;
        const willSearch =
          !suppressFuzzy &&
          context.query.length >= PATH_AUTOCOMPLETE_FUZZY_MIN_QUERY;
        setPathSnapshot({
          key,
          suggestions: direct,
          loading: willSearch,
          interactive: true,
        });

        if (!willSearch) return;

        const fuzzyEntries = await cachedPathAutocompleteSearch(
          context.basePath,
          context.query,
          PATH_AUTOCOMPLETE_LIMIT,
        );
        if (seq !== autocompleteRequestSeq) return;
        const fuzzy = pathAutocompleteSearchSuggestions(fuzzyEntries);
        const suggestions = mergePathAutocompleteSuggestions(
          direct,
          fuzzy,
          PATH_AUTOCOMPLETE_LIMIT,
        );
        setPathSnapshot({
          key,
          suggestions,
          loading: false,
          interactive: true,
        });
      }, 30);
      onCleanup(() => window.clearTimeout(timer));
      return;
    }

    setPathSnapshot(null);
    if (
      query.length === 0 ||
      chatAutocompleteSuppressedFor() === options.value()
    ) {
      closeAutocomplete();
      setAutocompleteLoading(false);
      setAutocompleteSuggestions([]);
      return;
    }
    setAutocompleteMode("chat");
    openAutocomplete();
    const cached = chatAutocompleteCache.get(query.toLowerCase());
    if (cached) {
      setAutocompleteSuggestions(cached);
      setAutocompleteLoading(false);
    } else {
      setAutocompleteLoading(true);
    }
    const timer = window.setTimeout(
      async () => {
        const r = await api.chat.autocomplete(query, 12);
        if (seq !== autocompleteRequestSeq) return;
        if (r.ok) {
          if (r.value.suggestions.length)
            chatAutocompleteCache.set(query.toLowerCase(), r.value.suggestions);
          setAutocompleteSuggestions(r.value.suggestions);
        } else {
          setAutocompleteSuggestions([]);
        }
        setAutocompleteLoading(false);
      },
      cached ? 0 : 20,
    );
    onCleanup(() => window.clearTimeout(timer));
  });

  return {
    autocompleteMode,
    autocompleteLoading,
    autocompleteSuggestions,
    pathSuggestions,
    autocompleteActive,
    setAutocompleteActive,
    showAutocomplete,
    openAutocomplete,
    closeAutocomplete,
    updateComposerCursor,
    applyAutocomplete,
    applyPathAutocomplete,
    handleAutocompleteKey,
  };
}

function AutocompleteDropdown(props: { autocomplete: ComposerAutocomplete }) {
  const autocomplete = props.autocomplete;
  return (
    <Show when={autocomplete.showAutocomplete()}>
      <div
        class="autocomplete-dropdown"
        role="listbox"
        aria-label={
          autocomplete.autocompleteMode() === "path"
            ? "path suggestions"
            : "chat input suggestions"
        }
      >
        <Show
          when={autocomplete.autocompleteMode() !== "path"}
          fallback={
            <For each={autocomplete.pathSuggestions()}>
              {(suggestion, i) => (
                <button
                  type="button"
                  classList={{
                    "autocomplete-option": true,
                    active: i() === autocomplete.autocompleteActive(),
                  }}
                  role="option"
                  aria-selected={i() === autocomplete.autocompleteActive()}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => autocomplete.setAutocompleteActive(i())}
                  onClick={() => autocomplete.applyPathAutocomplete(suggestion)}
                  title={"@" + suggestion.path}
                >
                  <span class="autocomplete-path-row">
                    <span class="autocomplete-path-kind" aria-hidden="true">
                      {suggestion.kind === "dir" ? "▸" : "•"}
                    </span>
                    <span class="autocomplete-text autocomplete-path">
                      @{suggestion.path}
                    </span>
                  </span>
                  <span class="autocomplete-meta">
                    {formatPathAutocompleteKind(suggestion)}
                  </span>
                </button>
              )}
            </For>
          }
        >
          <Show
            when={
              !autocomplete.autocompleteLoading() ||
              autocomplete.autocompleteSuggestions().length > 0
            }
            fallback={null}
          >
            <Show
              when={autocomplete.autocompleteSuggestions().length > 0}
              fallback={
                <div class="autocomplete-empty">No matching chat messages</div>
              }
            >
              <For each={autocomplete.autocompleteSuggestions()}>
                {(suggestion, i) => (
                  <button
                    type="button"
                    classList={{
                      "autocomplete-option": true,
                      active: i() === autocomplete.autocompleteActive(),
                    }}
                    role="option"
                    aria-selected={i() === autocomplete.autocompleteActive()}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => autocomplete.setAutocompleteActive(i())}
                    onClick={() => autocomplete.applyAutocomplete(suggestion)}
                    title={suggestion.text}
                  >
                    <span class="autocomplete-text">{suggestion.text}</span>
                    <span class="autocomplete-meta">
                      {formatAutocompleteChat(suggestion)}
                      <Show when={formatAutocompleteTime(suggestion.at)}>
                        {" "}
                        · {formatAutocompleteTime(suggestion.at)}
                      </Show>
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </Show>
      </div>
    </Show>
  );
}

function InputBar(props: { bag: Bag }) {
  const { bag } = props;
  let inputEl: HTMLTextAreaElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  let restartPromptTimer: number | null = null;
  let seenResumeOfferRequest = bag.resumeOfferRequest();
  const focusMessageInput = () => {
    // Focusing the composer after a refresh or submit should not ask the browser
    // to scroll ancestors; scroll ownership stays with the timeline logic above.
    inputEl?.focus({ preventScroll: true });
  };
  const [attachments, setAttachments] = createSignal<ImageAttachment[]>([]);
  const [playPromptMode, setPlayPromptMode] =
    createSignal<PlayPromptMode>(null);
  const addImages = async (files: File[]) => {
    const next = await imageAttachmentsFromFiles(files);
    if (!next.length) return;
    setAttachments([...attachments(), ...next]);
  };

  const handlePaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (!files.some((f) => f.type.startsWith("image/"))) return;
    e.preventDefault();
    addImages(files);
  };

  const handleFilePick = (e: Event) => {
    const el = e.currentTarget as HTMLInputElement;
    const files = Array.from(el.files || []);
    addImages(files);
    // Allow picking the same screenshot again after removing it.
    el.value = "";
  };

  const closeRestartPrompt = () => {
    if (restartPromptTimer !== null) {
      window.clearTimeout(restartPromptTimer);
      restartPromptTimer = null;
    }
    setPlayPromptMode(null);
  };
  const offerPlayPrompt = (mode: Exclude<PlayPromptMode, null>) => {
    if (disabled() || bag.thinking()) return;
    autocomplete.closeAutocomplete();
    if (restartPromptTimer !== null) window.clearTimeout(restartPromptTimer);
    setPlayPromptMode(mode);
    restartPromptTimer = window.setTimeout(() => {
      restartPromptTimer = null;
      setPlayPromptMode(null);
    }, 8000);
  };
  const offerRestart = () => offerPlayPrompt("restart");
  const offerResume = () => offerPlayPrompt("resume");
  const playPromptOpen = () => playPromptMode() !== null && !bag.thinking();
  const playPromptTitle = () =>
    playPromptMode() === "resume" ? "resume agent" : "restart chat";
  const runPlayPrompt = async (
    fallbackMode?: Exclude<PlayPromptMode, null>,
  ) => {
    if (bag.thinking()) {
      closeRestartPrompt();
      return;
    }
    const mode = playPromptMode();
    closeRestartPrompt();
    if (!mode && !fallbackMode) {
      focusMessageInput();
      return;
    }
    if ((mode ?? fallbackMode) === "resume") await bag.resumeAgent();
    else await bag.createChat(bag.currentChatPath() ?? undefined);
    focusMessageInput();
  };
  const submit = () => {
    if (!bag.chatId()) return;
    const message = bag.wipText().trim();
    const imgs = attachments();
    if (!message && imgs.length === 0) return;
    closeRestartPrompt();
    bag.setWipText("");
    setAttachments([]);
    bag.sendMessage(message || "Please inspect this image.", imgs);
    focusMessageInput();
  };
  const autosize = () => {
    if (!inputEl) return;
    inputEl.style.height = "auto";
    const max = 320;
    const next = Math.min(inputEl.scrollHeight, max);
    inputEl.style.height = next + "px";
    inputEl.style.overflowY = inputEl.scrollHeight > max ? "auto" : "hidden";
  };
  const autocomplete = createComposerAutocomplete({
    value: () => bag.wipText(),
    setValue: bag.setWipText,
    cursorFromInput: () => inputEl?.selectionStart,
    setSelectionRange: (start, end) => inputEl?.setSelectionRange(start, end),
    currentChatWorktreePath: () => bag.currentChatWorktreePath(),
    autosize,
    focus: focusMessageInput,
  });
  // Cmd+Enter (or Ctrl+Enter) submits. Plain Enter inserts a newline.
  const handleKey = (e: KeyboardEvent) => {
    if (autocomplete.handleAutocompleteKey(e)) return;
    if (e.key === "Escape") {
      if (!e.isComposing && !bag.thinking()) {
        e.preventDefault();
        offerRestart();
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  createEffect(() => {
    bag.wipText();
    queueMicrotask(autosize);
    if (bag.wipText().trim()) closeRestartPrompt();
  });
  createEffect(() => {
    const request = bag.resumeOfferRequest();
    if (request === seenResumeOfferRequest) return;
    seenResumeOfferRequest = request;
    if (bag.view() !== "chat") return;
    queueMicrotask(offerResume);
  });
  createEffect(() => {
    if (bag.thinking()) closeRestartPrompt();
  });
  onCleanup(() => {
    if (restartPromptTimer !== null) window.clearTimeout(restartPromptTimer);
  });

  createEffect(() => {
    bag.chatFocusRequest();
    if (bag.view() !== "chat") return;
    queueMicrotask(focusMessageInput);
  });
  const disabled = () => !bag.chatId();
  return (
    <form
      id="input-bar"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Show when={attachments().length > 0}>
        <div class="attachment-strip">
          <For each={attachments()}>
            {(att, i) => (
              <div class="attachment-thumb">
                <img src={att.dataUrl} alt={att.name || "image"} />
                <button
                  type="button"
                  class="attachment-remove"
                  title="remove image"
                  onClick={() =>
                    setAttachments(
                      attachments().filter((_, idx) => idx !== i()),
                    )
                  }
                >
                  ×
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="message-row">
        <button
          type="button"
          class="attach-btn"
          title="attach image"
          aria-label="attach image"
          onClick={() => fileInput?.click()}
          disabled={disabled()}
        >
          +
        </button>
        <input
          type="file"
          ref={fileInput}
          class="attachment-file-input"
          accept="image/*"
          multiple
          onChange={handleFilePick}
          disabled={disabled()}
        />
        <div class="composer-field">
          <AutocompleteDropdown autocomplete={autocomplete} />
          <textarea
            ref={inputEl}
            id="message"
            class="message-input"
            rows={1}
            placeholder={
              disabled()
                ? "start a new chat to send a message"
                : 'say something or "/help"'
            }
            autocomplete="off"
            value={bag.wipText()}
            onInput={(e) => {
              bag.setWipText(e.currentTarget.value);
              autocomplete.updateComposerCursor();
            }}
            disabled={disabled()}
            onKeyDown={handleKey}
            onKeyUp={autocomplete.updateComposerCursor}
            onClick={autocomplete.updateComposerCursor}
            onSelect={autocomplete.updateComposerCursor}
            onPaste={handlePaste}
            onFocus={() => {
              autocomplete.updateComposerCursor();
              autocomplete.openAutocomplete();
            }}
            onBlur={() =>
              window.setTimeout(autocomplete.closeAutocomplete, 120)
            }
          />
        </div>
        <button
          class="primary send-btn"
          type="submit"
          title="send"
          aria-label="send"
          disabled={disabled()}
        >
          ↑
        </button>
        <Show when={playPromptOpen()}>
          <button
            type="button"
            class="restart-btn"
            title={playPromptTitle()}
            aria-label={playPromptTitle()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={runPlayPrompt}
          >
            ▶
          </button>
        </Show>
        <Show when={bag.canResumeAgent() && !playPromptOpen()}>
          <button
            type="button"
            class="restart-btn"
            title="resume agent"
            aria-label="resume agent"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runPlayPrompt("resume")}
          >
            ▶
          </button>
        </Show>
        <Show when={bag.thinking()}>
          <button
            type="button"
            class="stop-btn"
            title="stop agent and send queued messages (Esc)"
            aria-label="stop agent and send queued messages"
            onClick={() => bag.stopAgent()}
          >
            ⏹
          </button>
        </Show>
      </div>
    </form>
  );
}

function dismissedEntryLabel(entry: DismissedTimelineEntry): string {
  if (entry.kind === "draft") return "partial reply";
  return displayStepKind(entry.item.kind).toLowerCase();
}

function DismissedDraft(props: { reply: DismissedReply }) {
  return (
    <div
      class="step reply draft dismissed-draft"
      data-timeline-key={`draft:${props.reply.id}`}
    >
      <div class="meta">partial reply · cancelled</div>
      <div
        class="body markdown"
        innerHTML={renderMarkdown(props.reply.content)}
      />
    </div>
  );
}

function DismissedBlock(props: {
  group: Extract<TimelineRenderEntry, { kind: "dismissed" }>;
  bag: Bag;
  onOpenImage: (attachment: ImageAttachment) => void;
}) {
  const expansion = () => props.bag.expansionStore();
  const key = () => props.group.id;
  const open = () => expansion().isOpen(key());
  const setOpen = (next: boolean) => expansion().setOpen(key(), next);
  const count = () => props.group.entries.length;
  const labels = () => {
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const entry of props.group.entries) {
      const label = dismissedEntryLabel(entry);
      if (seen.has(label)) continue;
      seen.add(label);
      parts.push(label);
    }
    return parts.join(", ");
  };
  return (
    <details
      class="dismissed-block"
      data-timeline-key={key()}
      open={open()}
      onToggle={(ev) => setOpen(ev.currentTarget.open)}
    >
      <summary>
        <span class="dismissed-title">Dismissed</span>
        <span class="dismissed-meta">
          {count()} {count() === 1 ? "item" : "items"} · {labels()} ·{" "}
          <time>{absoluteTime(props.group.at)}</time>
        </span>
      </summary>
      <div class="dismissed-body">
        <For each={props.group.entries}>
          {(entry) =>
            entry.kind === "draft" ? (
              <DismissedDraft reply={entry.reply} />
            ) : (
              <Item
                item={entry.item}
                bag={props.bag}
                onOpenImage={props.onOpenImage}
              />
            )
          }
        </For>
      </div>
    </details>
  );
}

function Item(props: {
  item: TimelineItem;
  bag: Bag;
  onOpenImage: (attachment: ImageAttachment) => void;
}) {
  const expansion = () => props.bag.expansionStore();
  const key = () => timelineAnchorKey(props.item);
  return (
    <Show
      when={props.item.type === "input-response"}
      fallback={
        <Show
          when={props.item.type === "input"}
          fallback={
            <Show
              when={
                props.item.type === "file-diff" ||
                props.item.type === "memory-diff"
              }
              fallback={
                <Show
                  when={props.item.type === "blob-add"}
                  fallback={
                    <Show
                      when={props.item.type === "log"}
                      fallback={
                        <Step
                          item={props.item as StepItem}
                          bag={props.bag}
                          expansion={expansion()}
                          timelineKey={key()}
                          onOpenImage={props.onOpenImage}
                        />
                      }
                    >
                      <Log item={props.item as LogItem} timelineKey={key()} />
                    </Show>
                  }
                >
                  <BlobAdd
                    item={props.item as BlobAddItem}
                    bag={props.bag}
                    timelineKey={key()}
                  />
                </Show>
              }
            >
              <DiffItem
                item={props.item as FileDiffItem | MemoryDiffItem}
                bag={props.bag}
                expansion={expansion()}
                timelineKey={key()}
              />
            </Show>
          }
        >
          <Input
            item={props.item as InputItem}
            bag={props.bag}
            timelineKey={key()}
          />
        </Show>
      }
    >
      <InputResponse
        item={props.item as InputResponseItem}
        timelineKey={key()}
      />
    </Show>
  );
}

function Log(props: { item: LogItem; timelineKey: string }) {
  return (
    <div class="step log" data-timeline-key={props.timelineKey}>
      <div class="meta">log</div>
      <pre class="body log-message">{props.item.message}</pre>
      <StepFooter item={props.item} />
    </div>
  );
}

function shortHash(hash: string): string {
  const normalized = String(hash || "");
  const bare = normalized.startsWith("sha256:")
    ? normalized.slice("sha256:".length)
    : normalized;
  return bare ? bare.slice(0, 12) : "unknown";
}

function formatByteCount(bytes: unknown): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "unknown size";
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = n / 1024;
  let unit = units[0]!;
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i]!;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function BlobAdd(props: { item: BlobAddItem; bag: Bag; timelineKey: string }) {
  const open = () => props.bag.openStorePreviewInSidebar(props.item.hash);
  const meta = () =>
    `${formatByteCount(props.item.size)} · ${props.item.encoding || "object"}`;
  return (
    <div class="step file-diff blob-add" data-timeline-key={props.timelineKey}>
      <button
        type="button"
        class="blob-add-summary"
        onClick={open}
        title="Open object preview"
      >
        <span class="file-diff-label">blob add</span>
        <span class="file-diff-path">
          · {props.item.objectKind || "object"}
        </span>
        <code class="blob-add-hash">{shortHash(props.item.hash)}</code>
        <span class="file-diff-summary">{meta()}</span>
      </button>
    </div>
  );
}

function DiffItem(props: {
  item: FileDiffItem | MemoryDiffItem;
  bag: Bag;
  expansion: TimelineExpansionStore;
  timelineKey: string;
}) {
  const stats = createMemo(() => displayDiffStats(props.item));
  const key = () => timelineExpansionKey(props.item);
  const open = () => props.expansion.isOpen(key());
  const setOpen = (next: boolean) => props.expansion.setOpen(key(), next);
  const isMemory = () => props.item.type === "memory-diff";
  const label = () => (isMemory() ? "memory diff" : "file diff");
  const detail = () =>
    isMemory()
      ? `· ${(props.item as MemoryDiffItem).graph}`
      : `· ${collapseHome(props.item.path)}`;
  const installSummaryClick = (summary: HTMLElement) => {
    const onClick = (ev: MouseEvent) => {
      if (isMemory()) return;
      // Use a native listener rather than Solid's delegated onClick here: the
      // browser's <summary>/<details> default toggle can otherwise win on some
      // paths, leaving file diffs expandable but not opening their sidebar tab.
      ev.preventDefault();
      ev.stopPropagation();
      props.bag.openDiffInSidebar(props.item as FileDiffItem);
    };
    summary.addEventListener("click", onClick);
    onCleanup(() => summary.removeEventListener("click", onClick));
  };
  return (
    <details
      class="step file-diff"
      data-timeline-key={props.timelineKey}
      open={open()}
      onToggle={(ev) => setOpen(ev.currentTarget.open)}
    >
      <summary ref={installSummaryClick}>
        <span class="file-diff-label">{label()}</span>
        <span class="file-diff-path">{detail()}</span>
        <span class="file-diff-summary">
          <span class="file-diff-added">+{stats().added}</span>
          <span class="file-diff-removed">−{stats().removed}</span>
          <span>({stats().lines})</span>
        </span>
      </summary>
      <Show when={open()}>
        <div
          class="file-diff-body"
          role="log"
          aria-label={`Diff for ${collapseHome(props.item.path)}`}
        >
          <DiffView
            diff={props.item.diff}
            snapshot={props.item.after}
            path={props.item.path}
            onOpenStore={(hash) =>
              void props.bag.openStorePreviewInSidebar(hash)
            }
            expansion={props.expansion}
            expansionKeyPrefix={key()}
          />
        </div>
      </Show>
      <StepFooter item={props.item} />
    </details>
  );
}

function displayStepKind(kind: string): string {
  if (kind === "agent:UserInput") return "User";
  if (kind === "agent:Subagent") return "Subagent";
  return kind.replace(/^agent:/, "");
}

function Step(props: {
  item: StepItem;
  bag: Bag;
  expansion: TimelineExpansionStore;
  timelineKey: string;
  onOpenImage: (attachment: ImageAttachment) => void;
}) {
  const cls = createMemo(() => {
    const item = props.item;
    let c =
      "step " +
      item.kind
        .replace(/^agent:/, "")
        .replace(/([a-z])([A-Z])/g, "$1-$2")
        .toLowerCase();
    if (item.status === "agent:Failed") c += " failed";
    if (item.status === "agent:Cancelled") c += " cancelled";
    if (item.kind === "agent:Reply" && item.status !== "agent:Done")
      c += " draft";
    if (item.kind === "agent:UserInput" && item.deletedAt)
      c += " message-hidden";
    return c;
  });

  // RunJS owns its own header (label is the headline), so suppress the
  // generic meta line for it.
  const showStandardMeta = () =>
    props.item.kind !== "agent:RunJS" && props.item.kind !== "agent:Subagent";
  return (
    <div class={cls()} data-timeline-key={props.timelineKey}>
      <Show when={showStandardMeta()}>
        <div class="meta">
          {props.item.kind === "agent:Reply" &&
          !isTerminalStepStatus(props.item.status)
            ? "Thinking…"
            : displayStepKind(props.item.kind)}
          {props.item.status === "agent:Failed" ? " · failed" : ""}
          {props.item.status === "agent:Cancelled" ? " · cancelled" : ""}
          {props.item.kind === "agent:UserInput" && props.item.deletedAt
            ? " · hidden"
            : ""}
        </div>
      </Show>
      <Show when={props.item.kind === "agent:Reply" && props.item.text}>
        <div
          class="body markdown"
          innerHTML={renderMarkdown(props.item.text)}
        />
      </Show>
      <Show when={props.item.kind === "agent:UserInput"}>
        <Show when={props.item.text}>
          <div
            class="body markdown"
            innerHTML={renderUserMessage(props.item.text)}
          />
        </Show>
        <Show when={props.item.attachments?.length}>
          <div class="timeline-attachments">
            <For each={props.item.attachments}>
              {(att) => (
                <button
                  type="button"
                  class="timeline-attachment"
                  title={att.name || "image"}
                  aria-label={
                    att.name ? `open image ${att.name}` : "open image"
                  }
                  onClick={() => props.onOpenImage(att)}
                >
                  <img src={att.dataUrl} alt={att.name || "image"} />
                </button>
              )}
            </For>
          </div>
        </Show>
      </Show>
      <Show when={props.item.kind === "agent:ShellCommand"}>
        <ShellBody item={props.item} expansion={props.expansion} />
      </Show>
      <Show when={props.item.kind === "agent:RunJS"}>
        <RunJSBody
          item={props.item}
          bag={props.bag}
          expansion={props.expansion}
        />
      </Show>
      <Show when={props.item.kind === "agent:Subagent"}>
        <SubagentBody
          item={props.item}
          bag={props.bag}
          expansion={props.expansion}
        />
      </Show>
      <Show when={props.item.kind === "agent:Error"}>
        <ErrorBody item={props.item} />
      </Show>
      <Show when={props.item.kind === "agent:Compaction"}>
        <CompactionBody item={props.item} />
      </Show>
      <Show
        when={
          props.item.kind === "agent:Tick" ||
          props.item.kind === "agent:ToolCall"
        }
      >
        <Show when={props.item.text}>
          <div class="body">{props.item.text}</div>
        </Show>
      </Show>
      <Show
        when={
          props.item.kind !== "agent:RunJS" &&
          props.item.kind !== "agent:Subagent" &&
          !(
            props.item.kind === "agent:Reply" &&
            props.item.status !== "agent:Done"
          )
        }
      >
        <StepFooter item={props.item} bag={props.bag} />
      </Show>
    </div>
  );
}

function compactionSummaryText(text: string): string {
  return text
    .replace(/^(?:automatic |manual )?compaction\n?/, "")
    .replace(/^compacted earlier turns\n?/, "")
    .trim();
}

function compactionLabel(text: string): string {
  if (/^automatic compaction(?:\n|$)/.test(text)) return "automatic compaction";
  if (/^manual compaction(?:\n|$)/.test(text)) return "manual compaction";
  return "compacted earlier turns";
}

function ParentChatLink(props: { bag: Bag }) {
  const parent = () => props.bag.currentChatParent();
  const label = () => {
    const p = parent();
    if (!p) return "";
    return p.title?.trim() || displayChatId(p.chatId);
  };
  const onClick = (ev: MouseEvent) => {
    const p = parent();
    if (!p) return;
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0)
      return;
    ev.preventDefault();
    ev.stopPropagation();
    void props.bag.selectChat(p.chatId);
  };
  return (
    <Show when={parent()}>
      {(p) => (
        <a
          class="parent-chat-link"
          href={`/chat/${encodeURIComponent(p().chatId)}`}
          title={`back to ${label()}`}
          aria-label={`back to parent chat ${label()}`}
          onClick={onClick}
        >
          <span class="parent-chat-arrow" aria-hidden="true">
            ↩
          </span>
          <span class="parent-chat-title">{label()}</span>
        </a>
      )}
    </Show>
  );
}

function SubagentBody(props: {
  item: StepItem;
  bag: Bag;
  expansion: TimelineExpansionStore;
}) {
  const info = () => props.item.subagent || {};
  const result = () => info().result || null;
  const output = () => result()?.output ?? result()?.text;
  const childHref = () =>
    info().childChatId
      ? `/chat/${encodeURIComponent(info().childChatId || "")}`
      : "#";
  const onChildClick = (ev: MouseEvent) => {
    const id = info().childChatId;
    if (!id) return;
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0)
      return;
    ev.preventDefault();
    ev.stopPropagation();
    void props.bag.selectChat(id);
  };
  const key = () => timelineExpansionKey(props.item);
  const open = () => props.expansion.isOpen(key());
  const setOpen = (next: boolean) => props.expansion.setOpen(key(), next);
  const label = () => info().label || "Subagent";
  const task = () => info().task || "";
  const statusText = () => result()?.status || props.item.status;
  const duration = () =>
    typeof result()?.durationMs === "number" ? result()?.durationMs || 0 : null;
  return (
    <details
      class="runjs-step subagent-step"
      open={open()}
      onToggle={(ev) => setOpen(ev.currentTarget.open)}
    >
      <summary>
        <Show when={props.item.status === "agent:Running"}>
          <LoadingDots class="runjs-loading" label="running" />
        </Show>
        <RunJSMarkdown class="runjs-label" content={label()} inline />
        <Show when={task()}>
          <span class="runjs-desc-inline">
            <span class="runjs-desc-separator" aria-hidden="true">
              ·
            </span>
            <RunJSMarkdown class="runjs-desc-text" content={task()} inline />
          </span>
        </Show>
      </summary>
      <Show when={open()}>
        <div class="runjs-body subagent-body">
          <Show when={task()}>
            <RunJSMarkdown
              class="runjs-desc-full subagent-task"
              content={task()}
            />
          </Show>
          <Show when={info().childChatId || result()}>
            <div class="subagent-result">
              <Show when={result()}>
                <span class="subagent-status">{statusText()}</span>
                <Show when={duration() !== null}>
                  <span> · {formatThoughtDuration(duration() || 0)}</span>
                </Show>
              </Show>
              <Show when={info().childChatId}>
                <span class="subagent-link-part">
                  <Show when={result()}>
                    <span class="subagent-separator" aria-hidden="true">
                      {" "}
                      ·{" "}
                    </span>
                  </Show>
                  <a
                    class="subagent-link"
                    href={childHref()}
                    onClick={onChildClick}
                  >
                    open child chat
                  </a>
                </span>
              </Show>
            </div>
          </Show>
          <Show when={result()?.error}>
            <RunJSBlock
              label="Error"
              klass="runjs-out runjs-error subagent-error"
              content={result()?.error || ""}
            />
          </Show>
          <Show when={output()}>
            <div
              class="markdown subagent-output"
              innerHTML={renderMarkdown(output() || "")}
            />
          </Show>
        </div>
      </Show>
      <StepFooter
        item={props.item}
        bag={props.bag}
        durationMs={duration() ?? undefined}
      />
    </details>
  );
}

function CompactionBody(props: { item: StepItem }) {
  const summary = createMemo(() =>
    compactionSummaryText(props.item.text || ""),
  );
  return (
    <details class="compaction-summary">
      <summary>
        <span>{compactionLabel(props.item.text || "")}</span>
        <time>{absoluteTime(props.item.at)}</time>
      </summary>
      <Show when={summary()}>
        <div class="body markdown" innerHTML={renderMarkdown(summary())} />
      </Show>
    </details>
  );
}

type StepFooterItem =
  | StepItem
  | FileDiffItem
  | MemoryDiffItem
  | BlobAddItem
  | LogItem;

function isStepItem(item: StepFooterItem): item is StepItem {
  return item.type === "step";
}

function StepFooter(props: {
  item: StepFooterItem;
  bag?: Bag;
  durationMs?: number;
}) {
  const step = () => (isStepItem(props.item) ? props.item : null);
  const effort = () => step()?.effort || null;
  const showForkControl = () => !!step() && !!props.bag;
  const copyableMessageText = () => {
    const item = step();
    if (
      !item ||
      (item.kind !== "agent:Reply" && item.kind !== "agent:UserInput")
    )
      return null;
    return item.text || null;
  };
  const [copyState, setCopyState] = createSignal<"idle" | "copied" | "failed">(
    "idle",
  );
  const [forkPending, setForkPending] = createSignal(false);
  const forkChatHere = async () => {
    const target = step();
    if (!target || !props.bag || forkPending()) return;
    setForkPending(true);
    try {
      await props.bag.forkChatAtStep(target.step);
    } finally {
      setForkPending(false);
    }
  };
  let copyResetTimer: number | null = null;
  const resetCopyFeedbackSoon = () => {
    if (copyResetTimer !== null) window.clearTimeout(copyResetTimer);
    copyResetTimer = window.setTimeout(() => {
      copyResetTimer = null;
      setCopyState("idle");
    }, COPY_FEEDBACK_MS);
  };
  const copyRawMessage = async () => {
    const text = copyableMessageText();
    if (!text) return;
    try {
      await writeClipboardText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    resetCopyFeedbackSoon();
  };
  onCleanup(() => {
    if (copyResetTimer !== null) window.clearTimeout(copyResetTimer);
  });
  const showVisibilityControl = () =>
    step()?.kind === "agent:UserInput" && !!props.bag;
  return (
    <footer class="step-footer">
      <span class="step-time-group">
        <time class="step-time">{absoluteTime(props.item.at)}</time>
        <Show when={typeof props.durationMs === "number"}>
          <span class="step-duration">{props.durationMs}ms</span>
        </Show>
        <Show
          when={
            step()?.kind === "agent:Reply" &&
            typeof step()?.thoughtDurationMs === "number"
          }
        >
          <span class="step-thought">
            ({formatThoughtDuration(step()!.thoughtDurationMs!)})
          </span>
        </Show>
      </span>
      <Show when={step()?.model}>
        <span class="step-footer-part">
          <span class="step-footer-separator" aria-hidden="true">
            ·
          </span>
          <span class="step-model-group">
            <span class="step-model" title={step()!.model}>
              {step()!.model}
            </span>
            <Show when={effort()}>
              <span class="step-effort" title="reasoning effort">
                ({effort()})
              </span>
            </Show>
          </span>
        </span>
      </Show>
      <Show when={!step()?.model && effort()}>
        <span class="step-footer-part">
          <span class="step-footer-separator" aria-hidden="true">
            ·
          </span>
          <span class="step-effort" title="reasoning effort">
            ({effort()})
          </span>
        </span>
      </Show>
      <Show when={copyableMessageText()}>
        <span class="step-footer-part">
          <span class="step-footer-separator" aria-hidden="true">
            ·
          </span>
          <button
            type="button"
            class="step-action-btn message-copy-btn"
            title="copy raw markdown"
            aria-label="copy raw markdown"
            onClick={() => void copyRawMessage()}
          >
            <span class="step-action-label">
              {copyState() === "copied"
                ? "copied"
                : copyState() === "failed"
                  ? "copy failed"
                  : "copy"}
            </span>
          </button>
        </span>
      </Show>
      <Show when={showForkControl()}>
        <span class="step-footer-part">
          <span class="step-footer-separator" aria-hidden="true">
            ·
          </span>
          <button
            type="button"
            class="step-action-btn"
            title={
              forkPending()
                ? "forking chat…"
                : "fork this chat at this point in the timeline"
            }
            disabled={forkPending()}
            onClick={() => void forkChatHere()}
          >
            <span class="step-action-label">
              {forkPending() ? "forking…" : "fork here"}
            </span>
          </button>
        </span>
      </Show>
      <Show when={showVisibilityControl()}>
        <span class="step-footer-part">
          <span class="step-footer-separator" aria-hidden="true">
            ·
          </span>
          <button
            type="button"
            class="step-action-btn message-visibility-btn"
            title={
              step()!.deletedAt
                ? "send this user message to future LLM prompts again"
                : "hide this user message from future LLM prompts"
            }
            onClick={() =>
              step()!.deletedAt
                ? props.bag!.restoreMessage(step()!.step)
                : props.bag!.deleteMessage(step()!.step)
            }
          >
            <span class="step-action-label">
              {step()!.deletedAt ? "restore" : "hide"}
            </span>
          </button>
        </span>
      </Show>
    </footer>
  );
}

function ShellBody(props: {
  item: StepItem;
  expansion: TimelineExpansionStore;
}) {
  const lines = () => props.item.text.split("\n");
  const cmd = () => lines().find((l) => l.startsWith("$ ")) || "";
  const tail = () => lines().find((l) => l.startsWith("(exit ")) || "";
  const out = () =>
    lines()
      .filter((l) => l !== cmd() && l !== tail())
      .join("\n");
  return (
    <>
      <Show when={cmd()}>
        <div class="shell-cmd">{cmd()}</div>
      </Show>
      <Show when={out()}>
        <CollapsibleBlock
          klass="shell-out"
          content={out()}
          expansion={props.expansion}
          expansionKey={`${timelineExpansionKey(props.item)}:shell-out`}
        />
      </Show>
      <Show when={tail()}>
        <div class="shell-tail">{tail()}</div>
      </Show>
    </>
  );
}

function parseStoreObjectJSON(object: unknown): unknown {
  if (!object || typeof object !== "object") return null;
  const content = (object as { content?: unknown }).content;
  if (typeof content !== "string") return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function runJSResultFromObject(
  result: unknown,
): Pick<NonNullable<StepItem["runjs"]>, "result" | "error" | "durationMs"> {
  const r =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  return {
    result: typeof r.value === "string" ? r.value : null,
    error: typeof r.error === "string" ? r.error : null,
    durationMs: typeof r.durationMs === "number" ? r.durationMs : undefined,
  };
}

function RunJSBody(props: {
  item: StepItem;
  bag: Bag;
  expansion: TimelineExpansionStore;
}) {
  // Prefer structured runJS data from the timeline API. parseRunJS is only
  // retained for historical timeline entries and older exported payloads.
  //
  // Default render is a single line: "<title> · <desc>           <time>".
  // Click expands to reveal the full description (when long) plus the
  // code and result fold rows.
  const [hydratedResult, setHydratedResult] = createSignal<Pick<
    NonNullable<StepItem["runjs"]>,
    "result" | "error" | "durationMs"
  > | null>(null);
  const [hydrateError, setHydrateError] = createSignal<string | null>(null);
  let hydrationStarted = false;
  const ensureHydrated = async () => {
    if (!props.item.lazyRunjsResult || hydrationStarted) return;
    hydrationStarted = true;
    setHydrateError(null);
    try {
      const object = props.item.resultHash
        ? await api.objects.get(props.item.resultHash as any)
        : null;
      if (object && object.ok)
        setHydratedResult(
          runJSResultFromObject(parseStoreObjectJSON(object.value.object)),
        );
    } catch (err) {
      setHydrateError(err instanceof Error ? err.message : String(err));
      hydrationStarted = false;
    }
  };
  const currentRunJS = () => {
    if (!props.item.runjs || !hydratedResult()) return props.item.runjs;
    return { ...props.item.runjs, ...hydratedResult() };
  };
  const parsed = createMemo(() =>
    currentRunJS()
      ? normalizeRunJS(currentRunJS()!)
      : parseRunJS(props.item.text),
  );

  const key = () => timelineExpansionKey(props.item);
  const open = () => props.expansion.isOpen(key());
  const setOpen = (next: boolean) => {
    props.expansion.setOpen(key(), next);
    if (next) void ensureHydrated();
  };
  createEffect(() => {
    if (open()) void ensureHydrated();
  });

  return (
    <details
      class="runjs-step"
      open={open()}
      onToggle={(ev) => setOpen(ev.currentTarget.open)}
    >
      <summary>
        <Show when={props.item.status === "agent:Running"}>
          <LoadingDots class="runjs-loading" label="running" />
        </Show>
        <RunJSMarkdown
          class="runjs-label"
          content={parsed().label || "(unlabeled)"}
          inline
        />
        <Show when={parsed().description}>
          <span class="runjs-desc-inline">
            <span class="runjs-desc-separator" aria-hidden="true">
              ·
            </span>
            <RunJSMarkdown
              class="runjs-desc-text"
              content={parsed().description}
              inline
            />
          </span>
        </Show>
      </summary>
      <Show when={open()}>
        <div class="runjs-body">
          <Show when={parsed().description}>
            <RunJSMarkdown
              class="runjs-desc-full"
              content={parsed().description}
            />
          </Show>
          <Show when={parsed().code}>
            <RunJSBlock
              label="Code"
              klass="runjs-code"
              content={parsed().code}
              language="js"
            />
          </Show>
          <Show when={parsed().hasArgs}>
            <RunJSBlock
              label="Args"
              klass="runjs-args"
              content={parsed().args}
            />
          </Show>
          <Show
            when={
              props.item.lazyRunjsResult && !hydratedResult() && !hydrateError()
            }
          >
            <section class="runjs-block" aria-label="Loading result">
              <div class="runjs-block-label">Result</div>
              <pre class="runjs-out">Loading…</pre>
            </section>
          </Show>
          <Show when={parsed().result}>
            <RunJSBlock
              label="Result"
              klass="runjs-out"
              content={parsed().result}
            />
          </Show>
          <Show when={parsed().error}>
            <RunJSBlock
              label="Error"
              klass="runjs-out runjs-error"
              content={parsed().error}
            />
          </Show>
          <Show when={hydrateError()}>
            <RunJSBlock
              label="Error"
              klass="runjs-out runjs-error"
              content={hydrateError()!}
            />
          </Show>
        </div>
      </Show>
      <StepFooter
        item={props.item}
        bag={props.bag}
        durationMs={parsed().durationMs}
      />
    </details>
  );
}

function RunJSMarkdown(props: {
  class?: string;
  content: string;
  inline?: boolean;
}) {
  const cls = () =>
    (props.class ? props.class + " " : "") + "markdown runjs-markdown";
  const html = () =>
    props.inline
      ? renderMarkdownInline(props.content.replace(/\n+/g, " "))
      : renderMarkdown(props.content);
  return props.inline ? (
    <span class={cls()} innerHTML={html()} />
  ) : (
    <div class={cls()} innerHTML={html()} />
  );
}

function RunJSBlock(props: {
  label: string;
  klass: string;
  content: string;
  language?: string;
}) {
  const html = () =>
    props.language
      ? highlightMarkdownCode(props.content, props.language)
      : highlightAuto(props.content);
  return (
    <section class="runjs-block" aria-label={props.label}>
      <div class="runjs-block-label">{props.label}</div>
      <pre class={props.klass} innerHTML={html()} />
    </section>
  );
}

type ParsedRunJS = {
  label: string;
  description: string;
  args: string;
  hasArgs: boolean;
  code: string;
  result: string;
  error: string;
  durationMs?: number;
};

function normalizeRunJS(runjs: NonNullable<StepItem["runjs"]>): ParsedRunJS {
  const hasArgs = Object.prototype.hasOwnProperty.call(runjs, "args");
  return {
    label: cleanRunJSLabel(String(runjs.label ?? "")),
    description: String(runjs.description ?? "").trim(),
    args: hasArgs ? formatRunJSArgs(runjs.args) : "",
    hasArgs,
    code: trimRunJSBlock(String(runjs.code ?? "")),
    result: trimRunJSBlock(String(runjs.result ?? "")),
    error: trimRunJSBlock(String(runjs.error ?? "")),
    durationMs:
      typeof runjs.durationMs === "number" ? runjs.durationMs : undefined,
  };
}

function parseRunJS(text: string): ParsedRunJS {
  const lines = text.split("\n");
  let label = "";
  let description = "";
  const codeBuf: string[] = [];
  const resultBuf: string[] = [];
  const errorBuf: string[] = [];
  let mode: "header" | "code" | "result" | "error" = "header";

  for (const line of lines) {
    if (line.startsWith("@@label ")) {
      label = line.slice("@@label ".length);
      continue;
    }
    if (line.startsWith("@@desc ")) {
      description = line.slice("@@desc ".length);
      continue;
    }
    if (line === "@@code") {
      mode = "code";
      continue;
    }
    if (line.startsWith("→ ") || line.startsWith("→")) {
      mode = "result";
      resultBuf.push(line.replace(/^→ ?/, ""));
      continue;
    }
    if (/^error:?\s*/i.test(line)) {
      mode = "error";
      errorBuf.push(line.replace(/^error:?\s*/i, ""));
      continue;
    }
    if (mode === "header") {
      // Backward-compat for older steps written before sentinel prefixes:
      // first line is label (with trailing colon), rest is code until arrow.
      if (!label) {
        label = line.replace(/:$/, "");
        mode = "code";
        continue;
      }
    }
    if (mode === "code") codeBuf.push(line);
    else if (mode === "result") resultBuf.push(line);
    else if (mode === "error") errorBuf.push(line);
  }

  return {
    label: cleanRunJSLabel(label),
    description: description.trim(),
    args: "",
    hasArgs: false,
    code: trimRunJSBlock(codeBuf.join("\n")),
    result: trimRunJSBlock(resultBuf.join("\n")),
    error: trimRunJSBlock(errorBuf.join("\n")),
  };
}

function cleanRunJSLabel(label: string): string {
  return label.replace(/^\s*\[code\]\s*:?[ \t]*/i, "").trim();
}

function trimRunJSBlock(text: string): string {
  return text.replace(/\r?\n$/, "");
}

function formatRunJSArgs(args: unknown): string {
  if (typeof args === "undefined") return "undefined";
  if (typeof args === "string") {
    const formatted = maybeFormatHjsonTextForView(args.trim());
    if (formatted !== null) return formatted;
  }
  try {
    return formatHjson(args);
  } catch {
    return String(args);
  }
}

// Long preformatted blocks fold into a <details> with a one-line summary so
// the timeline stays scannable; short blocks render inline. JSON-shaped
// content gets light syntax highlighting.
function CollapsibleBlock(props: {
  klass: string;
  content: string;
  expansion: TimelineExpansionStore;
  expansionKey: string;
}) {
  const lines = () => props.content.split("\n");
  const long = () => lines().length > 12 || props.content.length > 600;
  const highlighted = (): string => highlightAuto(props.content);

  return (
    <Show
      when={long()}
      fallback={<pre class={props.klass} innerHTML={highlighted()} />}
    >
      <details
        class={"collapsible " + props.klass}
        open={props.expansion.isOpen(props.expansionKey)}
        onToggle={(ev) =>
          props.expansion.setOpen(props.expansionKey, ev.currentTarget.open)
        }
      >
        <summary>
          <span class="summary-head">{firstNonEmpty(lines())}</span>
          <span class="summary-meta">
            {lines().length} lines · {props.content.length} chars
          </span>
        </summary>
        <pre innerHTML={highlighted()} />
      </details>
    </Show>
  );
}

function displayDiffStats(item: {
  diff?: string;
  stats?: DiffStats;
  before?: string;
  after?: string;
}): DiffStats {
  const lines = item.diff ? item.diff.split("\n").length : 0;
  if (item.stats) {
    return {
      added: Number(item.stats.added) || 0,
      removed: Number(item.stats.removed) || 0,
      lines: Number(item.stats.lines) || lines,
    };
  }
  return { added: 0, removed: 0, lines };
}

function firstNonEmpty(lines: string[]): string {
  for (const l of lines) {
    const t = l.trim();
    if (t) return t;
  }
  return lines[0] || "";
}

function ModelPicker(props: { bag: Bag }) {
  const { bag } = props;
  const info = () => bag.chatModel();
  const modelOptions = () => {
    const modelInfo = info();
    const structured = modelInfo?.modelOptions ?? [];
    const models = structured.length
      ? structured
      : (modelInfo?.models ?? []).map((id) => ({
          id,
          provider: id.includes(":")
            ? id.slice(0, id.indexOf(":"))
            : (modelInfo?.provider ?? ""),
          model: id.includes(":") ? id.slice(id.indexOf(":") + 1) : id,
          label: id,
        }));
    const byId = new Map(models.map((m) => [m.id, m]));
    const currentId = modelInfo?.selectedModelId ?? modelInfo?.effectiveModelId;
    const ordered: typeof models = [];
    for (const m of bag.modelMru()) {
      const option =
        byId.get(m) ?? models.find((candidate) => candidate.model === m);
      if (option) ordered.push(option);
    }
    if (currentId) {
      const option = byId.get(currentId);
      if (option) ordered.push(option);
    }
    ordered.push(...models);
    const seen = new Set<string>();
    return ordered.filter((option) => {
      if (seen.has(option.id)) return false;
      seen.add(option.id);
      return true;
    });
  };
  const selectEffort = async (value: string) => {
    await bag.setSelectedEffort(value === "__default" ? null : value);
  };
  const selectModel = async (value: string) => {
    if (value) await bag.setSelectedModel(value);
  };
  const selectedModelValue = () => {
    const modelInfo = info();
    if (!modelInfo) return "";
    return (
      modelInfo.selectedModelId ??
      modelInfo.effectiveModelId ??
      modelInfo.selectedModel ??
      ""
    );
  };
  const effortSupported = () =>
    Boolean(info()?.effortSupported && (info()?.efforts?.length ?? 0) > 0);
  const effortTitle = () => {
    if (!info()) return "reasoning effort";
    if (info()?.provider === "openai") return "OpenAI reasoning effort";
    if (info()?.provider === "anthropic" && effortSupported())
      return "Anthropic thinking effort";
    return "effort is only sent to providers/models that support it";
  };
  return (
    <div class="model-picker" title="model and effort for this chat">
      <span class="model-label">model</span>
      <select
        value={selectedModelValue()}
        disabled={!info()}
        onChange={(e) => selectModel(e.currentTarget.value)}
      >
        <For each={modelOptions()}>
          {(m) => <option value={m.id}>{m.label}</option>}
        </For>
      </select>
      <Show when={effortSupported()}>
        <span class="model-label effort-label">effort</span>
        <select
          value={info()?.selectedEffort ?? "__default"}
          title={effortTitle()}
          onChange={(e) => selectEffort(e.currentTarget.value)}
        >
          <option value="__default">
            {info()?.defaultEffort
              ? `default (${info()?.defaultEffort})`
              : "default"}
          </option>
          <For each={info()?.efforts ?? []}>
            {(effort) => <option value={effort}>{effort}</option>}
          </For>
        </select>
      </Show>
    </div>
  );
}

function TokenBar(props: {
  tokens: () => {
    used: number;
    budget: number;
    threshold: number;
    fraction: number;
  } | null;
}) {
  const currentTokens = () => props.tokens();
  const safeTokens = () =>
    currentTokens() ?? { used: 0, budget: 0, threshold: 0, fraction: 0 };
  const safeBudget = () => Math.max(0, safeTokens().budget);
  const pct = () => {
    if (safeBudget() <= 0) return 0;
    const tokens = safeTokens();
    const fraction = Number.isFinite(tokens.fraction)
      ? tokens.fraction
      : tokens.used / safeBudget();
    return Math.min(100, Math.max(0, fraction * 100));
  };
  const thresholdPct = () => {
    const tokens = safeTokens();
    if (safeBudget() <= 0) return 0;
    return Math.min(100, Math.max(0, (tokens.threshold / safeBudget()) * 100));
  };
  const formatCount = (value: number) => {
    if (!Number.isFinite(value)) return "0";
    const n = Math.max(0, Math.trunc(value));
    if (n >= 1_000_000)
      return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
    if (n >= 1_000)
      return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
    return n.toLocaleString();
  };
  const cls = () => {
    const tokens = safeTokens();
    return (
      "token-meter" +
      (!currentTokens() ? " empty" : "") +
      (safeBudget() > 0 && tokens.used >= tokens.threshold ? " over" : "")
    );
  };
  const title = () => {
    const tokens = safeTokens();
    if (!currentTokens()) return "token usage loading";
    return `${tokens.used.toLocaleString()} / ${tokens.budget.toLocaleString()} tokens · compaction at ${tokens.threshold.toLocaleString()}`;
  };
  return (
    <div class={cls()} title={title()} aria-label={title()}>
      <div class="token-meter-head">
        <span>tokens</span>
        <strong>
          {currentTokens()
            ? `${formatCount(safeTokens().used)} / ${formatCount(safeTokens().budget)}`
            : "—"}
        </strong>
      </div>
      <div class="token-bar">
        <span class="token-fill" style={{ width: pct() + "%" }} />
        <span class="token-mark" style={{ left: thresholdPct() + "%" }} />
      </div>
    </div>
  );
}

function compactErrorDetail(detail: unknown): string {
  if (!detail || typeof detail !== "object") return "";
  const d = detail as Record<string, any>;
  const parts = [
    typeof d.reason === "string" ? d.reason : "",
    typeof d.error === "string" ? d.error : "",
    typeof d.message === "string" ? d.message : "",
    typeof d.body?.error?.message === "string" ? d.body.error.message : "",
    typeof d.body?.message === "string" ? d.body.message : "",
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length) return parts[0];
  try {
    const text = JSON.stringify(detail, null, 2).trim();
    return text === "{}" ? "" : text;
  } catch {
    return String(detail ?? "").trim();
  }
}

function ErrorBody(props: { item: StepItem }) {
  const text = () => props.item.text || "";
  const lines = () => text().split("\n");
  const head = () => lines()[0] || "error";
  const detail = () => props.item.error?.detail;
  const message = () =>
    String(
      (detail()?.message ?? lines().slice(1).join("\n")) ||
        compactErrorDetail(detail() ?? props.item.error) ||
        "No error details recorded.",
    ).trim();
  const payloadText = () => formatErrorPayloadForView(detail()?.body);
  const showPayload = () => {
    const payload = payloadText();
    return payload && payload !== message();
  };
  return (
    <>
      <div class="error-head">
        <span class="error-icon">!</span>
        <strong>{head()}</strong>
      </div>
      <Show when={message()}>
        <div class="error-body">{message()}</div>
      </Show>
      <Show when={showPayload()}>
        <details class="error-payload" open>
          <summary>Response payload</summary>
          <pre>{payloadText()}</pre>
        </details>
      </Show>
    </>
  );
}

function formatErrorPayloadForView(body: unknown): string {
  if (body == null || body === "") return "";
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return "";
    const formatted = formatHjsonTextForView(trimmed);
    return formatted === trimmed ? trimmed : formatted;
  }
  try {
    return formatHjson(body);
  } catch {
    return String(body);
  }
}

function Input(props: { item: InputItem; bag: Bag; timelineKey: string }) {
  return (
    <Show
      when={props.item.kind === "ui:Form"}
      fallback={
        <ChoiceUi
          item={props.item}
          bag={props.bag}
          timelineKey={props.timelineKey}
        />
      }
    >
      <FormUi
        item={props.item}
        bag={props.bag}
        timelineKey={props.timelineKey}
      />
    </Show>
  );
}

function FormUi(props: { item: InputItem; bag: Bag; timelineKey: string }) {
  const spec = () => props.item.spec as FormSpec;
  let formEl: HTMLFormElement | undefined;
  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    const fd = new FormData(formEl!);
    const values: Record<string, unknown> = {};
    for (const f of spec().fields) {
      const raw = fd.get(f.name);
      if (f.type === "boolean") values[f.name] = !!raw;
      else if (f.type === "number")
        values[f.name] = raw === "" ? null : Number(raw);
      else values[f.name] = String(raw ?? "");
    }
    await props.bag.submitForm(props.item.requestId, values);
  };
  const answered = () => props.item.status !== "ui:Pending";
  const response = () => props.item.response;
  const cancelled = () =>
    props.item.status === "ui:Cancelled" || !!response()?.cancelled;
  return (
    <div
      class="input form"
      data-timeline-key={props.timelineKey}
      classList={{ answered: !!answered() }}
    >
      <div class="input-meta">
        {absoluteTime(props.item.at)} · form
        <Show when={answered()}>
          <span> · {cancelled() ? "cancelled" : "answered"} below</span>
        </Show>
      </div>
      <Show when={spec().title}>
        <div class="input-title">{spec().title}</div>
      </Show>
      <Show
        when={!answered()}
        fallback={
          <div class="answer-summary input-deferred-answer">
            {cancelled() ? "cancelled below" : "answered below"}
          </div>
        }
      >
        <form ref={formEl} class="input-fields" onSubmit={handleSubmit}>
          <For each={spec().fields}>{(f) => <FieldRow field={f} />}</For>
          <div class="input-actions">
            <button class="primary" type="submit">
              {spec().submitLabel || "submit"}
            </button>
            <button
              type="button"
              class="secondary"
              onClick={() => props.bag.cancelForm(props.item.requestId)}
            >
              cancel
            </button>
          </div>
        </form>
      </Show>
    </div>
  );
}

function InputResponse(props: {
  item: InputResponseItem;
  timelineKey: string;
}) {
  return (
    <Show
      when={props.item.kind === "ui:Form"}
      fallback={
        <ChoiceResponse item={props.item} timelineKey={props.timelineKey} />
      }
    >
      <FormResponse item={props.item} timelineKey={props.timelineKey} />
    </Show>
  );
}

function FormResponse(props: { item: InputResponseItem; timelineKey: string }) {
  const spec = () => props.item.spec as FormSpec | null;
  const response = () => props.item.response;
  const cancelled = () => !!response().cancelled;
  return (
    <div class="input response form" data-timeline-key={props.timelineKey}>
      <div class="input-meta">
        {absoluteTime(props.item.at)} · {cancelled() ? "cancelled" : "answered"}{" "}
        form
      </div>
      <Show when={spec()?.title}>
        <div class="input-title">{spec()!.title}</div>
      </Show>
      <Show
        when={!cancelled()}
        fallback={<div class="answer-summary cancelled">cancelled</div>}
      >
        <Show
          when={spec()}
          fallback={<RawAnswerSummary values={response().values || {}} />}
        >
          {(s) => <AnswerSummary spec={s()} values={response().values || {}} />}
        </Show>
      </Show>
    </div>
  );
}

function ChoiceResponse(props: {
  item: InputResponseItem;
  timelineKey: string;
}) {
  const spec = () => props.item.spec as ChoiceSpec | null;
  const response = () => props.item.response;
  const cancelled = () => !!response().cancelled;
  const pickedId = () =>
    response().values?.id != null ? String(response().values.id) : null;
  const pickedItem = () => spec()?.items.find((i) => i.id === pickedId());
  return (
    <div class="input response choice" data-timeline-key={props.timelineKey}>
      <div class="input-meta">
        {absoluteTime(props.item.at)} · {cancelled() ? "cancelled" : "answered"}{" "}
        choice
      </div>
      <Show when={spec()?.title}>
        <div class="input-title">{spec()!.title}</div>
      </Show>
      <div class="answer-summary">
        <strong>
          {cancelled() ? "cancelled" : pickedItem()?.label || pickedId() || "—"}
        </strong>
      </div>
    </div>
  );
}

function RawAnswerSummary(props: { values: Record<string, unknown> }) {
  const entries = () => Object.entries(props.values || {});
  return (
    <dl class="answer-summary">
      <For each={entries()}>
        {([name, value]) => (
          <>
            <dt>{name}</dt>
            <dd>{formatValue(value)}</dd>
          </>
        )}
      </For>
    </dl>
  );
}

function AnswerSummary(props: {
  spec: FormSpec;
  values: Record<string, unknown>;
}) {
  return (
    <dl class="answer-summary">
      <For each={props.spec.fields}>
        {(f) => (
          <Show when={f.name in props.values}>
            <dt>{f.label || f.name}</dt>
            <dd>{formatValue(props.values[f.name])}</dd>
          </Show>
        )}
      </For>
    </dl>
  );
}

function formatValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return v;
  return formatHjson(v);
}

function FieldRow(props: { field: FormField }) {
  const f = props.field;
  return (
    <label class={"field" + (f.type === "boolean" ? " checkbox" : "")}>
      <Show when={f.type !== "boolean"}>
        <span class="field-label">{f.label || f.name}</span>
      </Show>
      <FieldControl field={f} />
      <Show when={f.type === "boolean"}>
        <span class="field-label">{f.label || f.name}</span>
      </Show>
    </label>
  );
}

function FieldControl(props: { field: FormField }) {
  const f = props.field;
  const optionValue = (opt: string | { label?: string; value?: string }) =>
    typeof opt === "string" ? opt : String(opt.value ?? opt.label ?? "");
  const optionLabel = (opt: string | { label?: string; value?: string }) =>
    typeof opt === "string" ? opt : String(opt.label ?? opt.value ?? "");
  if (f.type === "textarea") {
    return (
      <textarea
        name={f.name}
        rows={2}
        required={f.required}
        value={typeof f.default === "string" ? f.default : ""}
      />
    );
  }
  if (f.type === "boolean") {
    return <input type="checkbox" name={f.name} checked={!!f.default} />;
  }
  if (f.type === "select") {
    return (
      <select name={f.name} required={f.required}>
        <For each={f.options || []}>
          {(opt) => (
            <option value={optionValue(opt)}>{optionLabel(opt)}</option>
          )}
        </For>
      </select>
    );
  }
  if (f.type === "number") {
    return (
      <input
        type="number"
        name={f.name}
        required={f.required}
        value={f.default != null ? String(f.default) : ""}
      />
    );
  }
  if (f.type === "url") {
    return (
      <input
        type="url"
        name={f.name}
        required={f.required}
        value={typeof f.default === "string" ? f.default : ""}
      />
    );
  }
  if (f.type === "secretRef") {
    return (
      <input
        type="password"
        name={f.name}
        required={f.required}
        placeholder="secret reference"
      />
    );
  }
  return (
    <input
      type="text"
      name={f.name}
      required={f.required}
      value={typeof f.default === "string" ? f.default : ""}
    />
  );
}

function ChoiceUi(props: { item: InputItem; bag: Bag; timelineKey: string }) {
  const spec = () => props.item.spec as ChoiceSpec;
  const answered = () => props.item.status !== "ui:Pending";
  const response = () => props.item.response;
  const cancelled = () =>
    props.item.status === "ui:Cancelled" || !!response()?.cancelled;
  const pickedId = () =>
    response()?.values?.id != null ? String(response()!.values.id) : null;
  const pickedItem = () => spec().items.find((i) => i.id === pickedId());
  return (
    <div
      class="input choice"
      data-timeline-key={props.timelineKey}
      classList={{ answered: !!answered() }}
    >
      <div class="input-meta">
        {absoluteTime(props.item.at)} · choice
        <Show when={answered()}>
          <span> · {cancelled() ? "cancelled" : "answered"} below</span>
        </Show>
      </div>
      <Show when={spec().title}>
        <div class="input-title">{spec().title}</div>
      </Show>
      <Show
        when={!answered()}
        fallback={
          <div class="answer-summary input-deferred-answer">
            {cancelled() ? "cancelled below" : "answered below"}
          </div>
        }
      >
        <div class="choices">
          <For each={spec().items}>
            {(opt) => (
              <button
                type="button"
                class="choice-btn"
                onClick={() =>
                  props.bag.submitForm(props.item.requestId, {
                    id: opt.id,
                    ...(opt.input || {}),
                  })
                }
              >
                <strong>{opt.label || opt.id}</strong>
                <Show when={opt.description}>
                  <small class="choice-desc">{opt.description}</small>
                </Show>
              </button>
            )}
          </For>
          <div class="input-actions">
            <button
              type="button"
              class="secondary"
              onClick={() => props.bag.cancelForm(props.item.requestId)}
            >
              cancel
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
