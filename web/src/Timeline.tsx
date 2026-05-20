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
  highlightAuto,
  highlightMarkdownCode,
  formatHjson,
  formatHjsonTextForView,
  isHjsonCodeLanguage,
  looksLikeMarkdownText,
  maybeFormatHjsonTextForView,
} from "./syntax";
import { collapseHome } from "./paths";
import { DiffView } from "./DiffView";
import { diffStats } from "./diffs";
import { LoadingDots } from "./LoadingDots";
import { CompactIcon } from "./icons";
import { BackgroundIcon, CrossIcon, SteerIcon } from "./icons";
import { ChatTerminals } from "./TerminalView";
import {
  compareTimelineItems,
  dismissedTimelineEntryAt,
  dismissedTimelineEntryKey,
  formatThinkingElapsed,
  formatThoughtDuration,
  insertTimelineItemChronologically,
  isCancelledTimelineItem,
  isRunningTimelineItem,
  isTerminalStepStatus,
  latestTerminalInteractiveStepSettlesActiveTurn,
  replyDraftKey,
  sameDismissedTimelineEntries,
  timelineAnchorKey,
  timelineExpansionKey,
  timelineItemKey,
  timelineJumpKeys,
  timelineRenderEntries,
  timelineThoughtKey,
  type DismissedTimelineEntry,
  type TimelineRenderEntry,
} from "./timeline/utils";
import {
  PATH_AUTOCOMPLETE_FUZZY_MIN_QUERY,
  PATH_AUTOCOMPLETE_LIMIT,
  cachedPathAutocompleteList,
  cachedPathAutocompleteSearch,
  cachedPathAutocompleteSnapshot,
  findPathAutocompleteContext,
  formatPathAutocompleteKind,
  mergePathAutocompleteSuggestions,
  pathAutocompleteKey,
  pathAutocompleteSearchSuggestions,
  pathAutocompleteSuggestions,
  type AutocompleteMode,
  type PathAutocompleteContext,
  type PathAutocompleteSnapshot,
  type PathAutocompleteSuggestion,
} from "./timeline/autocomplete";
import { shouldApplyComposerAutocompleteKey } from "./timeline/composerKeys";
import {
  displayDiffStats,
  formatByteCount,
  formatRunTSArgs,
  normalizeRunTS,
  parseRunTS,
  shortHash,
  type ParsedRunTS,
} from "./timeline/format";
import {
  draftStepItem,
  syncDraftStepItem,
  syncStepItem,
} from "./timeline/stepProxy";
import {
  compactErrorDetail,
  compactionErrorDetail,
  compactionLabel,
  compactionSummaryText,
  errorDiagnosticLines,
  firstNonEmpty,
  formatErrorPayloadForView,
  formatValue,
  logSummary,
} from "./timeline/display";

import type { Bag, DismissedReply } from "./state";
import { absoluteTime, displayChatId } from "./state";
import { LeftSidebarToggle, RightSidebarToggle } from "./HeaderControls";
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
  TodoDiffItem,
  AgentTodo,
  TodoDiffChange,
  InputItem,
  InputResponseItem,
  LogItem,
  StepItem,
  TimelineItem,
  Sha256Hash,
  UiApp,
} from "./api";

type PlayPromptMode = "restart" | "resume" | null;

type TimelineExpansionStore = {
  isOpen: (key: string) => boolean;
  setOpen: (key: string, open: boolean) => void;
  shown: (key: string) => number;
  setShown: (key: string, shown: number) => void;
};

const COPY_FEEDBACK_MS = 1600;
const OLDER_HISTORY_SCROLL_THRESHOLD_EM = 8;
const LAYOUT_SCROLL_STICKY_GRACE_MS = 600;
const USER_SCROLL_INTENT_GRACE_MS = 900;

const cssEscape = (value: string): string => {
  const css = window.CSS as
    | (typeof CSS & { readonly escape?: (input: string) => string })
    | undefined;
  return typeof css?.escape === "function"
    ? css.escape(value)
    : value.replace(/["\\]/g, (c) => "\\" + c);
};

const sha256Hash = (hash: string): Sha256Hash => hash as Sha256Hash;

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

type RunTSBlockLightbox = {
  sourceId: string;
  label: string;
  content: () => string;
  language?: () => string | undefined;
  meta?: () => string;
};

const RUNTS_BLOCK_PREVIEW_LINES = 10;

export function Timeline(props: {
  bag: Bag;
  onToggleSidebar: () => void;
  onOpenSidebar?: () => void;
}) {
  const { bag, onToggleSidebar } = props;
  const [lightboxImage, setLightboxImage] =
    createSignal<ImageAttachment | null>(null);
  const [runTSBlockLightbox, setRunTSBlockLightbox] =
    createSignal<RunTSBlockLightbox | null>(null);
  const [runTSBlockCopied, setRunTSBlockCopied] = createSignal(false);
  let runTSBlockLightboxContentEl: HTMLPreElement | undefined;
  const openLightbox = (attachment: ImageAttachment) =>
    setLightboxImage(attachment);
  const openRunTSBlockLightbox = (block: RunTSBlockLightbox) => {
    setRunTSBlockCopied(false);
    setRunTSBlockLightbox(block);
  };
  const updateRunTSBlockLightbox = (block: RunTSBlockLightbox) => {
    const current = runTSBlockLightbox();
    if (current?.sourceId === block.sourceId) setRunTSBlockLightbox(block);
  };
  const copyRunTSBlockLightbox = async () => {
    const block = runTSBlockLightbox();
    if (!block) return;
    await writeClipboardText(block.content());
    setRunTSBlockCopied(true);
    window.setTimeout(() => setRunTSBlockCopied(false), COPY_FEEDBACK_MS);
  };
  const closeLightbox = () => {
    setLightboxImage(null);
    setRunTSBlockLightbox(null);
  };

  createEffect(() => {
    if (!runTSBlockLightbox()) return;
    requestAnimationFrame(() => runTSBlockLightboxContentEl?.focus());
  });

  const handleLightboxKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || (!lightboxImage() && !runTSBlockLightbox()))
      return;
    e.preventDefault();
    e.stopPropagation();
    closeLightbox();
  };
  onMount(() =>
    window.addEventListener("keydown", handleLightboxKeyDown, true),
  );
  onCleanup(() =>
    window.removeEventListener("keydown", handleLightboxKeyDown, true),
  );

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
    if (bag.thinking() || bag.compacting()) {
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
  const activeWaitLabel = () => "Thinking…";

  // Keep the scroll position stable across timeline refreshes. If the user is
  // at the bottom, new content sticks to the bottom. If they have scrolled up,
  // remember the first visible timeline row and keep it pinned even when rows
  // above it are inserted, markdown streams in, or media/code blocks resize.
  let stuck = true;
  let scrollAnchor: { key: string; offset: number } | null = null;
  let restoreFrame: number | undefined;
  let olderTimelineRecheckFrame: number | undefined;
  const timelineAnchorSelector = "[data-timeline-key]";
  let lastChatId: string | null | undefined;
  let lastTimelineClientHeight = 0;
  let stickyLayoutScrollUntil = 0;
  let userScrollIntentUntil = 0;
  let scrollRestoreActive = false;
  const isAtBottom = () => {
    if (!timelineEl) return true;
    const slack = parseFloat(getComputedStyle(timelineEl).fontSize) * 3;
    return (
      timelineEl.scrollTop + timelineEl.clientHeight >=
      timelineEl.scrollHeight - slack
    );
  };
  const rememberTimelineClientHeight = () => {
    if (timelineEl) lastTimelineClientHeight = timelineEl.clientHeight;
  };
  const scrollToBottom = () => {
    if (!timelineEl) return;
    scrollRestoreActive = true;
    timelineEl.scrollTop = timelineEl.scrollHeight;
    rememberTimelineClientHeight();
    requestAnimationFrame(() => {
      scrollRestoreActive = false;
    });
  };
  const hasRecentUserScrollIntent = () => Date.now() <= userScrollIntentUntil;
  const markUserScrollIntent = () => {
    userScrollIntentUntil = Date.now() + USER_SCROLL_INTENT_GRACE_MS;
  };
  const shouldDeferAutoScrollForUserIntent = () =>
    !stuck && hasRecentUserScrollIntent();
  const scrollToBottomUnlessUserIntent = () => {
    if (!shouldDeferAutoScrollForUserIntent()) scrollToBottom();
  };
  const isLikelyLayoutScroll = () => {
    if (!timelineEl) return false;
    return (
      scrollRestoreActive ||
      Date.now() <= stickyLayoutScrollUntil ||
      Math.abs(timelineEl.clientHeight - lastTimelineClientHeight) > 1
    );
  };
  const resetScrollForChatChange = () => {
    stuck = true;
    scrollAnchor = null;
    userScrollIntentUntil = 0;
    stickyLayoutScrollUntil = Date.now() + LAYOUT_SCROLL_STICKY_GRACE_MS;
    queueMicrotask(() => {
      scrollToBottomUnlessUserIntent();
      requestAnimationFrame(scrollToBottomUnlessUserIntent);
    });
  };
  const isNearTop = () => {
    if (!timelineEl) return false;
    const threshold =
      parseFloat(getComputedStyle(timelineEl).fontSize) *
      OLDER_HISTORY_SCROLL_THRESHOLD_EM;
    return timelineEl.scrollTop <= threshold;
  };
  const maybeLoadOlderTimeline = () => {
    if (
      !bag.olderTimelineLoading() &&
      isNearTop() &&
      bag.hiddenTimelineItems() > 0
    )
      void bag.loadOlderTimeline();
  };
  const scheduleOlderTimelineRecheck = () => {
    if (olderTimelineRecheckFrame !== undefined) return;
    olderTimelineRecheckFrame = requestAnimationFrame(() => {
      olderTimelineRecheckFrame = undefined;
      if (restoreFrame !== undefined) {
        scheduleOlderTimelineRecheck();
        return;
      }
      maybeLoadOlderTimeline();
    });
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
        `[data-timeline-key="${cssEscape(key)}"]`,
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
  const notePotentialLayoutScroll = () => {
    if (stuck)
      stickyLayoutScrollUntil = Date.now() + LAYOUT_SCROLL_STICKY_GRACE_MS;
    scheduleScrollRestore();
  };
  const noteStreamingContentMutation = () => {
    if (stuck && !hasRecentUserScrollIntent())
      stickyLayoutScrollUntil = Date.now() + LAYOUT_SCROLL_STICKY_GRACE_MS;
    scheduleScrollRestore();
  };
  const scheduleScrollRestore = () => {
    if (restoreFrame !== undefined) return;
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = undefined;
      restoreScrollAnchor();
      rememberTimelineClientHeight();
      if (!stuck) captureScrollAnchor();
      scheduleOlderTimelineRecheck();
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
  createEffect(() => {
    const id = bag.chatId();
    if (id === lastChatId) return;
    lastChatId = id;
    resetScrollForChatChange();
  });

  onMount(() => {
    const handleScroll = () => {
      if (isAtBottom()) {
        stuck = true;
        scrollAnchor = null;
      } else if (
        stuck &&
        !hasRecentUserScrollIntent() &&
        isLikelyLayoutScroll()
      ) {
        stickyLayoutScrollUntil = Date.now() + LAYOUT_SCROLL_STICKY_GRACE_MS;
        scheduleScrollRestore();
      } else {
        stuck = false;
        captureScrollAnchor();
      }
      rememberTimelineClientHeight();
      maybeLoadOlderTimeline();
    };
    const handleScrollIntentKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        ![
          "ArrowDown",
          "ArrowUp",
          "End",
          "Home",
          "PageDown",
          "PageUp",
          " ",
        ].includes(event.key)
      )
        return;
      markUserScrollIntent();
    };
    timelineEl?.addEventListener("scroll", handleScroll, { passive: true });
    timelineEl?.addEventListener("wheel", markUserScrollIntent, {
      passive: true,
    });
    timelineEl?.addEventListener("touchstart", markUserScrollIntent, {
      passive: true,
    });
    timelineEl?.addEventListener("pointerdown", markUserScrollIntent);
    timelineEl?.addEventListener("keydown", handleScrollIntentKey);
    const mutationObserver = new MutationObserver(noteStreamingContentMutation);
    if (timelineEl) {
      mutationObserver.observe(timelineEl, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    const resizeObserver = new ResizeObserver(notePotentialLayoutScroll);
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
    rememberTimelineClientHeight();
    onCleanup(() => {
      timelineEl?.removeEventListener("scroll", handleScroll);
      timelineEl?.removeEventListener("wheel", markUserScrollIntent);
      timelineEl?.removeEventListener("touchstart", markUserScrollIntent);
      timelineEl?.removeEventListener("pointerdown", markUserScrollIntent);
      timelineEl?.removeEventListener("keydown", handleScrollIntentKey);
      mutationObserver.disconnect();
      targetObserver.disconnect();
      resizeObserver.disconnect();
      if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame);
      if (olderTimelineRecheckFrame !== undefined)
        cancelAnimationFrame(olderTimelineRecheckFrame);
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
      queueMicrotask(scrollToBottomUnlessUserIntent);
    } else {
      scheduleScrollRestore();
    }
  });

  let wasOlderTimelineLoading = false;
  let olderTimelineHiddenAtLoadStart = bag.hiddenTimelineItems();
  createEffect(() => {
    const loading = bag.olderTimelineLoading();
    const hidden = bag.hiddenTimelineItems();
    if (loading && !wasOlderTimelineLoading) {
      olderTimelineHiddenAtLoadStart = hidden;
    } else if (
      wasOlderTimelineLoading &&
      !loading &&
      hidden < olderTimelineHiddenAtLoadStart
    ) {
      scheduleOlderTimelineRecheck();
    }
    wasOlderTimelineLoading = loading;
  });

  const draftStepProxies = new Map<string, StepItem>();
  const draftProxyFor = (draftId: string): StepItem => {
    let item = draftStepProxies.get(draftId);
    if (!item) {
      item = createMutable<StepItem>(
        draftStepItem({
          kind: "reply",
          draftId,
          content: "",
          reasoningContent: "",
          reasoningStreaming: false,
          at: Date.now(),
        }),
      );
      draftStepProxies.set(draftId, item);
    }
    return item;
  };

  const visibleTimeline = createMemo(() => {
    const draft = bag.draftReply();
    const rows = bag
      .timeline()
      .filter((item) => item.type !== "trail")
      .map((item) => {
        if (
          item.type !== "step" ||
          (item.kind !== "agent:Reply" && item.kind !== "agent:Compaction") ||
          !item.draftId
        )
          return item;
        const proxy = draftStepProxies.get(item.draftId);
        if (!proxy) return item;
        syncStepItem(proxy, item);
        return proxy;
      });
    if (
      !draft ||
      draft.chatId !== bag.chatId() ||
      (!draft.content && !draft.reasoningContent)
    )
      return rows;
    if (
      rows.some(
        (item) =>
          item.type === "step" &&
          (item.kind === "agent:Reply" || item.kind === "agent:Compaction") &&
          item.draftId === draft.draftId,
      )
    ) {
      return rows;
    }
    const proxy = draftProxyFor(draft.draftId);
    syncDraftStepItem(proxy, draft);
    return insertTimelineItemChronologically(rows, proxy);
  });
  const visibleDismissedReplies = createMemo(() => {
    const id = bag.chatId();
    if (!id) return [];
    return bag
      .dismissedReplies()
      .filter(
        (reply) =>
          reply.chatId === id &&
          (reply.content.trim() || reply.reasoningContent?.trim()),
      );
  });
  const renderEntryCache = new Map<string, TimelineRenderEntry>();
  const renderedTimeline = createMemo(() =>
    timelineRenderEntries(
      visibleTimeline(),
      visibleDismissedReplies(),
      renderEntryCache,
    ),
  );
  const hasRunningTimelineRow = createMemo(() =>
    visibleTimeline().some(isRunningTimelineItem),
  );
  const activeTurnSettled = createMemo(() =>
    latestTerminalInteractiveStepSettlesActiveTurn(
      visibleTimeline(),
      bag.thinkingStartedAt(),
    ),
  );
  const hasStreamingReply = () =>
    Boolean(
      bag.draftReply()?.chatId === bag.chatId() &&
      (bag.draftReply()?.content || bag.draftReply()?.reasoningContent),
    );
  const showStandaloneThinking = () =>
    bag.thinking() &&
    !bag.compacting() &&
    !activeTurnSettled() &&
    !hasStreamingReply() &&
    !hasRunningTimelineRow();
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
          <LeftSidebarToggle onToggleSidebar={onToggleSidebar} />
          <ParentChatLink bag={bag} />
          <h1 class="page-title chat-page-title">{emptyTitle() || "Chat"}</h1>
          <Show when={!chatLoading()}>
            <ModelPicker bag={bag} />
            <div class="conv-token-slot">
              <TokenBar
                tokens={bag.tokens}
                onCompact={bag.compactChat}
                disabled={() => !bag.chatId() || bag.thinking()}
                compacting={bag.compacting}
              />
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
          {(chatId) => (
            <ChatTerminals
              chatId={chatId()}
              worktreePath={bag.currentChatWorktreePath()}
              notify={bag.notify}
            />
          )}
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
                        <>nothing yet — send a message to get started</>
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
                  <Show when={bag.olderTimelineLoading()}>
                    <div class="history-loading">
                      <LoadingDots
                        class="history-loading-dots"
                        label="loading older history"
                      />
                    </div>
                  </Show>
                </Show>
                <For each={renderedTimeline()}>
                  {(entry) =>
                    entry.kind === "dismissed" ? (
                      <DismissedBlock
                        group={entry}
                        bag={bag}
                        onOpenImage={openLightbox}
                        onOpenRunTSBlock={openRunTSBlockLightbox}
                        onUpdateRunTSBlock={updateRunTSBlockLightbox}
                      />
                    ) : entry.kind === "thought" ? (
                      <ThoughtBox
                        item={entry.item}
                        streaming={bag.thinking()}
                      />
                    ) : (
                      <Item
                        item={entry.item}
                        bag={bag}
                        onOpenImage={openLightbox}
                        onOpenRunTSBlock={openRunTSBlockLightbox}
                        onUpdateRunTSBlock={updateRunTSBlockLightbox}
                      />
                    )
                  }
                </For>
                <Show when={showStandaloneThinking()}>
                  <div class="step thinking" data-timeline-key="thinking">
                    <LoadingDots
                      class="thinking-dots"
                      label="thinking"
                    />
                    <div class="meta">{activeWaitLabel()} {thinkingElapsed()}</div>
                  </div>
                </Show>
                <Show
                  when={bag.timelineRefreshing() && !showStandaloneThinking()}
                >
                  <div class="history-loading history-loading-bottom">
                    <LoadingDots
                      class="history-loading-dots"
                      label="loading chat updates"
                    />
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
        <OngoingTodos todos={bag.todos()} />
        <Show when={runTSBlockLightbox()}>
          {(block) => (
            <div
              class="runts-lightbox-backdrop"
              role="dialog"
              aria-modal="true"
              aria-labelledby="runts-lightbox-title"
              onClick={closeLightbox}
            >
              <div class="runts-lightbox" onClick={(e) => e.stopPropagation()}>
                <div class="runts-lightbox-header">
                  <div class="runts-lightbox-title-wrap">
                    <div id="runts-lightbox-title" class="runts-lightbox-title">
                      {block().label}
                    </div>
                    <Show when={block().meta?.()}>
                      <div class="runts-lightbox-meta">{block().meta?.()}</div>
                    </Show>
                  </div>
                  <button
                    type="button"
                    class="runts-lightbox-copy"
                    onClick={copyRunTSBlockLightbox}
                  >
                    {runTSBlockCopied() ? "Copied" : "Copy"}
                  </button>
                  <button
                    type="button"
                    class="runts-lightbox-close"
                    aria-label="close runTS preview"
                    onClick={closeLightbox}
                  >
                    ×
                  </button>
                </div>
                <HighlightedPre
                  ref={(el) => (runTSBlockLightboxContentEl = el)}
                  class="runts-lightbox-content"
                  tabIndex={0}
                  content={block().content()}
                  language={block().language?.()}
                />
              </div>
            </div>
          )}
        </Show>
        <BackgroundRunTSPanel bag={bag} />
        <PendingList bag={bag} onOpenImage={openLightbox} />
        <InputBar bag={bag} onOpenImage={openLightbox} />
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

function TodoMetaBubbles(props: { item: AgentTodo }) {
  return (
    <span class="todo-bubbles" aria-label="TODO metadata">
      <span class="todo-bubble todo-status-bubble">{props.item.status}</span>
    </span>
  );
}

function TodoMarkdownInline(props: { content: string; className?: string }) {
  const className = () =>
    (props.className ? props.className + " " : "") +
    "markdown todo-markdown-inline";
  const html = () => renderMarkdownInline(props.content.replace(/\n+/g, " "));
  return <span class={className()} innerHTML={html()} />;
}

function TodoMarkdownBlock(props: { content: string; className?: string }) {
  const className = () =>
    (props.className ? props.className + " " : "") +
    "markdown todo-markdown-block";
  return <div class={className()} innerHTML={renderMarkdown(props.content)} />;
}

function TodoNote(props: { item: AgentTodo; className: string }) {
  const note = () => props.item.note || "";
  return (
    <Show when={note()}>
      <TodoMarkdownBlock
        className={`${props.className} todo-note`}
        content={note()}
      />
    </Show>
  );
}

function OngoingTodos(props: { todos: AgentTodo[] }) {
  const [showDone, setShowDone] = createSignal(false);
  const items = () => props.todos.filter((item) => item.status !== "dropped");
  const doneItems = () => items().filter((item) => item.status === "done");
  const visibleItems = () =>
    showDone() ? items() : items().filter((item) => item.status !== "done");
  const label = (item: AgentTodo) => `${item.id}. ${item.text}`;
  return (
    <Show when={items().length > 0}>
      <section
        class="ongoing-todos"
        classList={{
          "only-done":
            !showDone() &&
            visibleItems().length === 0 &&
            doneItems().length > 0,
        }}
        aria-label="ongoing TODOs"
      >
        <Show when={doneItems().length > 0}>
          <button
            type="button"
            class="ongoing-todos-toggle"
            aria-expanded={showDone()}
            onClick={() => setShowDone((value) => !value)}
          >
            {showDone() ? "Hide" : "Show"} {doneItems().length} done
          </button>
        </Show>
        <ul class="ongoing-todos-list">
          <For each={visibleItems()}>
            {(item) => (
              <li
                class="ongoing-todo"
                classList={{ [`todo-${item.status}`]: true }}
              >
                <div class="ongoing-todo-line">
                  <TodoMarkdownInline
                    className="ongoing-todo-text"
                    content={label(item)}
                  />
                  <TodoMetaBubbles item={item} />
                </div>
                <TodoNote item={item} className="ongoing-todo-details" />
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}

function BackgroundRunTSPanel(props: { bag: Bag }) {
  const jobs = () =>
    (props.bag.backgroundRunTS?.() || []).filter(
      (job) => job.chatId === props.bag.chatId(),
    );
  return (
    <Show when={jobs().length > 0}>
      <section
        class="background-runts-panel"
        aria-label="Background runTS tools"
      >
        <div class="background-runts-title">Background tools</div>
        <For each={jobs()}>
          {(job) => (
            <div class="background-runts-job">
              <RunTSMarkdown
                class="background-runts-label"
                content={job.label || "runTS"}
                inline
              />
              <button
                type="button"
                class="background-runts-cancel"
                title={`cancel ${job.label || "runTS"}`}
                aria-label={`cancel ${job.label || "runTS"}`}
                onClick={() => props.bag.cancelRunTSStep(job.stepId, job.chatId)}
              >
                <CrossIcon class="runts-control-icon" />
              </button>
            </div>
          )}
        </For>
      </section>
    </Show>
  );
}

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
  const attachmentsSupported = () =>
    props.bag.chatModel()?.supportsAttachments !== false;
  const attachmentTitle = () =>
    attachmentsSupported()
      ? "attach image"
      : "selected model does not support image attachments";
  const notifyUnsupportedAttachments = () =>
    props.bag.notify(
      "attachments",
      "Selected model does not support image attachments.",
      "Switch to a vision-capable model or remove the images.",
    );
  const addImages = async (files: File[]) => {
    if (!attachmentsSupported()) {
      if (files.some((f) => f.type.startsWith("image/")))
        notifyUnsupportedAttachments();
      return;
    }
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
          title={attachmentTitle()}
          aria-label={attachmentTitle()}
          onClick={() => {
            if (!attachmentsSupported()) {
              notifyUnsupportedAttachments();
              return;
            }
            fileInput?.click();
          }}
          disabled={!attachmentsSupported()}
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
          disabled={!attachmentsSupported()}
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
          class="primary send-btn pending-steer-btn"
          title="steer with this queued message now"
          aria-label="steer with this queued message now"
          onClick={() => props.bag.steerPending(props.item().id)}
        >
          <SteerIcon class="pending-action-icon" />
        </button>
        <button
          type="button"
          class="primary send-btn pending-remove-btn"
          title="remove queued message"
          aria-label="remove queued message"
          onClick={() => props.bag.removePending(props.item().id)}
        >
          <CrossIcon class="pending-action-icon" />
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
      if (shouldApplyComposerAutocompleteKey(e)) {
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
          !context.absolute &&
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
    if (cached) return;

    const timer = window.setTimeout(async () => {
      const r = await api("chat-autocomplete", { query, limit: 12 });
      if (seq !== autocompleteRequestSeq) return;
      if (r.ok) {
        chatAutocompleteCache.set(query.toLowerCase(), r.value.suggestions);
        setAutocompleteSuggestions(r.value.suggestions);
      } else {
        setAutocompleteSuggestions([]);
      }
      setAutocompleteLoading(false);
    }, 20);
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
                  onMouseMove={() => autocomplete.setAutocompleteActive(i())}
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
                    onMouseMove={() => autocomplete.setAutocompleteActive(i())}
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

function InputBar(props: {
  bag: Bag;
  onOpenImage: (attachment: ImageAttachment) => void;
}) {
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
  const attachmentsSupported = () =>
    bag.chatModel()?.supportsAttachments !== false;
  const attachmentsDisabled = () => disabled() || !attachmentsSupported();
  const attachmentTitle = () => {
    if (disabled()) return "start a new chat to attach images";
    if (!attachmentsSupported())
      return "selected model does not support image attachments";
    return "attach image";
  };
  const notifyUnsupportedAttachments = () =>
    bag.notify(
      "attachments",
      "Selected model does not support image attachments.",
      "Switch to a vision-capable model or remove the images.",
    );
  const addImages = async (files: File[]) => {
    if (!attachmentsSupported()) {
      if (files.some((f) => f.type.startsWith("image/")))
        notifyUnsupportedAttachments();
      return;
    }
    const next = await imageAttachmentsFromFiles(files);
    if (!next.length) return;
    setAttachments([...attachments(), ...next]);
  };

  const handlePaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (!files.some((f) => f.type.startsWith("image/"))) return;
    if (!attachmentsSupported()) {
      e.preventDefault();
      notifyUnsupportedAttachments();
      return;
    }
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
    if (imgs.length > 0 && !attachmentsSupported()) {
      notifyUnsupportedAttachments();
      return;
    }
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
                <button
                  type="button"
                  class="attachment-thumb-open"
                  onClick={() => props.onOpenImage(att)}
                  title={att.name || "open image"}
                >
                  <img src={att.dataUrl} alt={att.name || "image"} />
                </button>
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
          title={attachmentTitle()}
          aria-label={attachmentTitle()}
          onClick={() => {
            if (!attachmentsSupported()) {
              notifyUnsupportedAttachments();
              return;
            }
            fileInput?.click();
          }}
          disabled={attachmentsDisabled()}
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
          disabled={attachmentsDisabled()}
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
                : "say something"
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
            onClick={() => void runPlayPrompt()}
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

function DismissedDraftThought(props: { reply: DismissedReply }) {
  return (
    <ReasoningBlock
      content={props.reply.reasoningContent ?? ""}
      streaming={false}
      timelineKey={`thought:draft:${props.reply.id}`}
    />
  );
}

function DismissedDraft(props: { reply: DismissedReply }) {
  const text = () => props.reply.content.trim();
  return (
    <Show when={text()}>
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
    </Show>
  );
}

function DismissedBlock(props: {
  group: Extract<TimelineRenderEntry, { kind: "dismissed" }>;
  bag: Bag;
  onOpenImage: (attachment: ImageAttachment) => void;
  onOpenRunTSBlock: (block: RunTSBlockLightbox) => void;
  onUpdateRunTSBlock: (block: RunTSBlockLightbox) => void;
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
              <>
                <DismissedDraftThought reply={entry.reply} />
                <DismissedDraft reply={entry.reply} />
              </>
            ) : (
              <>
                <ThoughtBox item={entry.item} streaming={false} />
                <Item
                  item={entry.item}
                  bag={props.bag}
                  onOpenImage={props.onOpenImage}
                  onOpenRunTSBlock={props.onOpenRunTSBlock}
                  onUpdateRunTSBlock={props.onUpdateRunTSBlock}
                />
              </>
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
  onOpenRunTSBlock: (block: RunTSBlockLightbox) => void;
  onUpdateRunTSBlock: (block: RunTSBlockLightbox) => void;
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
                props.item.type === "todo-diff" ||
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
                          onOpenRunTSBlock={props.onOpenRunTSBlock}
                          onUpdateRunTSBlock={props.onUpdateRunTSBlock}
                        />
                      }
                    >
                      <Log
                        item={props.item as LogItem}
                        bag={props.bag}
                        timelineKey={key()}
                      />
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
                item={
                  props.item as FileDiffItem | MemoryDiffItem | TodoDiffItem
                }
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
function Log(props: { item: LogItem; bag: Bag; timelineKey: string }) {
  const open = () => props.bag.openLogPreviewInSidebar(props.item);
  return (
    <div class="step log collapsed-log" data-timeline-key={props.timelineKey}>
      <button
        type="button"
        class="log-open"
        onClick={open}
        title="open moo.log in sidebar"
        aria-label="open moo.log in sidebar"
      >
        <span class="meta log-kind">log</span>
        <span class="log-summary">{logSummary(props.item.message)}</span>
        <span class="log-open-hint">open</span>
      </button>
      <StepFooter item={props.item} />
    </div>
  );
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
  item: FileDiffItem | MemoryDiffItem | TodoDiffItem;
  bag: Bag;
  expansion: TimelineExpansionStore;
  timelineKey: string;
}) {
  if (props.item.type === "todo-diff") {
    if (!Array.isArray(props.item.changes) || props.item.changes.length === 0) {
      return null;
    }
    return (
      <div class="step todo-diff" data-timeline-key={props.timelineKey}>
        <div class="todo-diff-body" role="log" aria-label="TODO changes">
          <TodoDiffBody item={props.item} />
        </div>
      </div>
    );
  }

  const item = props.item as FileDiffItem | MemoryDiffItem;
  const key = () => timelineExpansionKey(item);
  const open = () => props.expansion.isOpen(key());
  const setOpen = (next: boolean) => props.expansion.setOpen(key(), next);
  const isMemory = () => item.type === "memory-diff";
  const stats = () => item.stats ?? diffStats(item.diff || "");
  const label = () => (isMemory() ? "memory diff" : "file diff");
  const detail = () =>
    isMemory()
      ? `· ${(item as MemoryDiffItem).graph}`
      : `· ${collapseHome((item as FileDiffItem).path)}`;
  const installSummaryClick = (summary: HTMLElement) => {
    const onClick = (ev: MouseEvent) => {
      if (isMemory()) return;
      // Use a native listener rather than Solid's delegated onClick here: the
      // browser's <summary>/<details> default toggle can otherwise win on some
      // paths, leaving file diffs expandable but not opening their sidebar tab.
      ev.preventDefault();
      ev.stopPropagation();
      props.bag.openDiffInSidebar(item as FileDiffItem);
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
        <Show when={stats()}>
          {(summary) => (
            <span class="file-diff-summary">
              <span class="file-diff-added">+{summary().added}</span>
              <span class="file-diff-removed">−{summary().removed}</span>
              <span>({summary().lines})</span>
            </span>
          )}
        </Show>
      </summary>
      <Show when={open()}>
        <div
          class="file-diff-body"
          role="log"
          aria-label={`Diff for ${collapseHome(item.path)}`}
        >
          <DiffView
            diff={item.diff}
            snapshot={item.after}
            path={item.path}
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

function todoLabel(item: AgentTodo) {
  return `${item.id}. ${item.text}`;
}

function todoChangeText(change: TodoDiffChange) {
  const item = change.kind === "removed" ? change.before : change.after;
  if (item.status === "dropped") return "X";
  if (item.status === "blocked") return "!";
  if (item.status === "done") return "-";
  if (change.kind === "added") return "+";
  return "~";
}

function TodoDiffBody(props: { item: TodoDiffItem }) {
  const changes = () => props.item.changes || [];
  return (
    <ul class="todo-diff-list" aria-label="TODO changes">
      <For each={changes()}>
        {(change) => {
          const item = () =>
            change.kind === "removed"
              ? change.before
              : change.kind === "added"
                ? change.after
                : change.after;
          const previous = () =>
            change.kind === "updated" ? change.before : undefined;
          return (
            <li
              class="todo-diff-change"
              classList={{
                [`todo-change-${change.kind}`]: true,
                [`todo-status-${item().status}`]: true,
              }}
            >
              <span class="todo-diff-main">
                <span class="todo-diff-action">{todoChangeText(change)}</span>
                <TodoMarkdownInline
                  className="todo-diff-text"
                  content={todoLabel(item())}
                />
                <Show when={change.kind !== "removed"}>
                  <TodoMetaBubbles item={item()} />
                </Show>
              </span>
              <TodoNote item={item()} className="todo-diff-details" />
              <Show when={previous() && previous()!.text !== item().text}>
                <div class="todo-diff-previous">
                  <TodoMarkdownInline
                    className="todo-diff-previous-text"
                    content={`was: ${todoLabel(previous()!)}`}
                  />
                </div>
              </Show>
            </li>
          );
        }}
      </For>
    </ul>
  );
}

function displayStepKind(kind: string): string {
  if (kind === "agent:UserInput") return "User";
  if (kind === "agent:Subagent") return "Subagent";
  if (kind === "agent:RunTS") return "RunTS";
  return kind.replace(/^agent:/, "");
}

function activeReplyStatusLabel(item: StepItem, compacting: boolean): string {
  if (item.text.trim()) return "Streaming…";
  if (item.reasoningContent?.trim()) return "Streaming…";
  return compacting ? "Compacting…" : "Thinking…";
}

function stepClass(item: StepItem): string {
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
  if (item.kind === "agent:UserInput" && item.deletedAt) c += " message-hidden";
  return c;
}

function showStandardStepMeta(item: StepItem): boolean {
  // RunTS owns its own header (label is the headline), so suppress the
  // generic meta line for it. Subagent has a richer custom header too.
  return (
    item.kind !== "agent:RunTS" &&
    item.kind !== "agent:RunJS" &&
    item.kind !== "agent:Subagent"
  );
}

function stepMetaLabel(
  item: StepItem,
  compacting: boolean,
  active: boolean,
): string {
  if (
    item.kind === "agent:Reply" &&
    active &&
    !isTerminalStepStatus(item.status)
  ) {
    return activeReplyStatusLabel(item, compacting);
  }
  return displayStepKind(item.kind);
}

function stepMetaSuffix(item: StepItem): string {
  if (item.status === "agent:Failed") return " · failed";
  if (item.status === "agent:Cancelled") return " · cancelled";
  if (item.kind === "agent:UserInput" && item.deletedAt) return " · hidden";
  return "";
}

function showStandardStepFooter(item: StepItem): boolean {
  return (
    item.kind !== "agent:RunTS" &&
    item.kind !== "agent:RunJS" &&
    item.kind !== "agent:Subagent" &&
    !(item.kind === "agent:Reply" && item.status !== "agent:Done")
  );
}

function ReasoningBlock(props: {
  content: string;
  streaming: boolean;
  timelineKey: string;
}) {
  const text = () => props.content.trim();
  const html = () => renderMarkdown(text());
  const open = () => props.streaming;
  return (
    <Show when={text()}>
      <details
        class="step reply-thinking"
        data-timeline-key={props.timelineKey}
        open={open()}
      >
        <summary>
          <span>{props.streaming ? "Thinking" : "Thought"}</span>
          <Show when={props.streaming}>
            <LoadingDots
              class="reply-thinking-dots"
              label="streaming thinking"
            />
          </Show>
        </summary>
        <div class="body markdown reply-thinking-body" innerHTML={html()} />
      </details>
    </Show>
  );
}

function ThoughtBox(props: { item: StepItem; streaming?: boolean }) {
  const thoughtStreaming = () =>
    (props.streaming ?? true) &&
    (props.item.reasoningStreaming ?? !isTerminalStepStatus(props.item.status));
  return (
    <ReasoningBlock
      content={props.item.reasoningContent ?? ""}
      streaming={thoughtStreaming()}
      timelineKey={timelineThoughtKey(props.item)}
    />
  );
}

function Step(props: {
  item: StepItem;
  bag: Bag;
  expansion: TimelineExpansionStore;
  timelineKey: string;
  onOpenImage: (attachment: ImageAttachment) => void;
  onOpenRunTSBlock: (block: RunTSBlockLightbox) => void;
  onUpdateRunTSBlock: (block: RunTSBlockLightbox) => void;
}) {
  const cls = createMemo(() => stepClass(props.item));
  const showStandardMeta = () => showStandardStepMeta(props.item);
  const renderStep = () =>
    props.item.kind !== "agent:Reply" ||
    !!props.item.text.trim() ||
    !props.item.reasoningContent?.trim();
  return (
    <Show when={renderStep()}>
      <div class={cls()} data-timeline-key={props.timelineKey}>
        <Show when={showStandardMeta()}>
          <div class="meta">
            {stepMetaLabel(
              props.item,
              props.bag.compacting(),
              props.bag.thinking() || props.bag.compacting(),
            )}
            {stepMetaSuffix(props.item)}
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
        <Show
          when={
            props.item.kind === "agent:RunTS" ||
            props.item.kind === "agent:RunJS"
          }
        >
          <RunTSBody
            item={props.item}
            bag={props.bag}
            expansion={props.expansion}
            onOpenRunTSBlock={props.onOpenRunTSBlock}
            onUpdateRunTSBlock={props.onUpdateRunTSBlock}
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
        <Show when={showStandardStepFooter(props.item)}>
          <StepFooter item={props.item} bag={props.bag} />
        </Show>
      </div>
    </Show>
  );
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
  const output = () => result()?.text || result()?.error || "";
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
  const statusText = () =>
    subagentStatusText(result()?.status || props.item.status);
  const statusClass = () => `subagent-status-${statusText() || "unknown"}`;
  const duration = () =>
    typeof result()?.durationNs === "number"
      ? (result()?.durationNs || 0) / 1_000_000
      : null;
  return (
    <details
      class="runts-step subagent-step"
      open={open()}
      onToggle={(ev) => setOpen(ev.currentTarget.open)}
    >
      <summary>
        <Show when={props.item.status === "agent:Running"}>
          <LoadingDots class="runts-loading" label="running" />
        </Show>
        <span class="subagent-title-prefix" aria-hidden="true">
          ↳
        </span>
        <RunTSMarkdown class="runts-label" content={label()} inline />
        <Show when={task()}>
          <span class="runts-desc-inline">
            <span class="runts-desc-separator" aria-hidden="true">
              ·
            </span>
            <RunTSMarkdown class="runts-desc-text" content={task()} inline />
          </span>
        </Show>
      </summary>
      <Show when={open()}>
        <div class="runts-body subagent-body">
          <Show when={task()}>
            <RunTSMarkdown
              class="runts-desc-full subagent-task"
              content={task()}
            />
          </Show>
          <Show when={info().childChatId || result()}>
            <div class="subagent-result">
              <Show when={result()}>
                <span class={`subagent-status ${statusClass()}`}>
                  {statusText()}
                </span>
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
            <RunTSBlock
              label="Error"
              klass="runts-out runts-error subagent-error"
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
        durationNs={duration() ?? undefined}
      />
    </details>
  );
}

function subagentStatusText(status: string | undefined): string {
  return String(status || "")
    .replace(/^agent:/, "")
    .replace(/^ui:/, "")
    .toLowerCase()
    .replace(/^canceled$/, "cancelled");
}

function compactionTokenDelta(item: StepItem): string {
  const before = Number(item.compaction?.promptTokens ?? 0) || 0;
  const postPressure = Number(item.compaction?.postPromptTokens ?? 0) || 0;
  const summaryTokens = Number(item.compaction?.summaryTokens ?? 0) || 0;
  const streak = Number(item.compaction?.compactionsInARow ?? 0) || 0;
  const parts: string[] = [];
  if (before) {
    const label = postPressure
      ? `${formatTokenCount(before)} → ${formatTokenCount(postPressure)}`
      : `${formatTokenCount(before)} compacted`;
    parts.push(label);
  } else if (postPressure) {
    parts.push(`${formatTokenCount(postPressure)} after`);
  }
  const detailParts: string[] = [];
  if (summaryTokens) detailParts.push(`summary ${formatTokenCount(summaryTokens)}`);
  if (streak > 1) detailParts.push(`streak ${streak}`);
  if (detailParts.length) parts.push(detailParts.join(" · "));
  return parts.join(" · ");
}

function CompactionBody(props: { item: StepItem }) {
  const summary = createMemo(() =>
    compactionSummaryText(props.item.text || ""),
  );
  const active = () => !isTerminalStepStatus(props.item.status);
  const tokenDelta = () => compactionTokenDelta(props.item);
  return (
    <details class="compaction-summary" open={active()}>
      <summary>
        <span>
          {active()
            ? "compacting older turns"
            : compactionLabel(props.item.text || "")}
        </span>
        <Show when={tokenDelta()}>
          <span class="compaction-token-delta">{tokenDelta()}</span>
        </Show>
        <Show when={active()}>
          <LoadingDots class="compaction-dots" label="compacting" />
        </Show>
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
  | TodoDiffItem
  | MemoryDiffItem
  | BlobAddItem
  | LogItem;

function isStepItem(item: StepFooterItem): item is StepItem {
  return item.type === "step";
}

function StepFooter(props: {
  item: StepFooterItem;
  bag?: Bag;
  durationNs?: number;
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
  const [visibilityPending, setVisibilityPending] = createSignal(false);
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
  const toggleMessageVisibility = async () => {
    const target = step();
    if (!target || !props.bag || visibilityPending()) return;
    setVisibilityPending(true);
    try {
      if (target.deletedAt) {
        await props.bag.restoreMessage(target.step);
      } else {
        await props.bag.deleteMessage(target.step);
      }
    } finally {
      setVisibilityPending(false);
    }
  };
  const showVisibilityControl = () =>
    step()?.kind === "agent:UserInput" && !!props.bag;
  return (
    <footer class="step-footer">
      <span class="step-time-group">
        <time class="step-time">{absoluteTime(props.item.at)}</time>
        <Show when={typeof props.durationNs === "number"}>
          <span class="step-duration">
            {Math.round((props.durationNs ?? 0) / 1_000_000)}ms
          </span>
        </Show>
        <Show
          when={
            step()?.kind === "agent:Reply" &&
            typeof step()?.thoughtDurationNs === "number"
          }
        >
          <span class="step-thought">
            ({formatThoughtDuration(step()!.thoughtDurationNs! / 1_000_000)})
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
              visibilityPending()
                ? "updating message visibility…"
                : step()!.deletedAt
                  ? "send this user message to future LLM prompts again"
                  : "hide this user message from future LLM prompts"
            }
            disabled={visibilityPending()}
            onClick={() => void toggleMessageVisibility()}
          >
            <span class="step-action-label">
              {visibilityPending()
                ? "updating…"
                : step()!.deletedAt
                  ? "restore"
                  : "hide"}
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
  const storeObject = object as {
    content?: unknown;
    text?: unknown;
    value?: unknown;
  };
  if (storeObject.value !== undefined) return storeObject.value;
  const content =
    typeof storeObject.content === "string"
      ? storeObject.content
      : typeof storeObject.text === "string"
        ? storeObject.text
        : null;
  if (content == null) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: number | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer != null) window.clearTimeout(timer);
  }
}

function runTSResultFromObject(
  result: unknown,
): Pick<NonNullable<StepItem["runts"]>, "result" | "error" | "durationNs"> {
  const r =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  return {
    result: typeof r.value === "string" ? r.value : null,
    error: typeof r.error === "string" ? r.error : null,
    durationNs: typeof r.durationNs === "number" ? r.durationNs : undefined,
  };
}

function RunTSBackgroundCountdown(props: { item: StepItem; afterMs?: number }) {
  const afterMs = () => Number(props.afterMs ?? 0);
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (props.item.status !== "agent:Running" || afterMs() <= 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    onCleanup(() => window.clearInterval(id));
  });
  const remainingMs = createMemo(() =>
    Math.max(0, props.item.at + afterMs() - now()),
  );
  const seconds = createMemo(() => Math.ceil(remainingMs() / 1000));
  return (
    <span
      class="runts-countdown"
      title={`Auto-backgrounds in ${seconds()}s`}
      aria-label={`Auto-backgrounds in ${seconds()} seconds`}
    >
      {seconds()}s
    </span>
  );
}

function RunTSBody(props: {
  item: StepItem;
  bag: Bag;
  expansion: TimelineExpansionStore;
  onOpenRunTSBlock: (block: RunTSBlockLightbox) => void;
  onUpdateRunTSBlock: (block: RunTSBlockLightbox) => void;
}) {
  // Prefer structured runTS data from the timeline API. parseRunTS is only
  // retained for historical timeline entries and older exported payloads.
  //
  // Default render is a single line: "<title> · <desc>           <time>".
  // Click expands to reveal the full description (when long) plus the
  // code and result fold rows.
  const [hydratedResultByHash, setHydratedResultByHash] = createSignal<
    Record<
      string,
      Pick<NonNullable<StepItem["runts"]>, "result" | "error" | "durationNs">
    >
  >({});
  const [hydratingHash, setHydratingHash] = createSignal<string | null>(null);
  const [hydrateErrorByHash, setHydrateErrorByHash] = createSignal<
    Record<string, string>
  >({});
  const resultHash = () => props.item.resultHash ?? null;
  const hydratedResult = () => {
    const hash = resultHash();
    return hash ? (hydratedResultByHash()[hash] ?? null) : null;
  };
  const hydrateError = () => {
    const hash = resultHash();
    return hash ? (hydrateErrorByHash()[hash] ?? null) : null;
  };
  const ensureHydrated = async () => {
    if (!(props.item.lazyRuntsResult || props.item.lazyRunjsResult)) return;
    const hash = resultHash();
    if (!hash) return;
    if (hydratedResultByHash()[hash] || hydratingHash() === hash) return;
    setHydratingHash(hash);
    setHydrateErrorByHash((errors) => {
      const { [hash]: _removed, ...rest } = errors;
      return rest;
    });
    try {
      const object = await withTimeout(
        api("object-get", { hash: sha256Hash(hash) }),
        30_000,
        "Timed out loading result",
      );
      if (!object.ok) {
        setHydrateErrorByHash((errors) => ({
          ...errors,
          [hash]: object.error?.message || "Failed to load result",
        }));
        return;
      }
      if (!object.value.object) {
        setHydrateErrorByHash((errors) => ({
          ...errors,
          [hash]: "Result object not found",
        }));
        return;
      }
      const loaded = runTSResultFromObject(
        parseStoreObjectJSON(object.value.object),
      );
      setHydratedResultByHash((results) => ({ ...results, [hash]: loaded }));
    } catch (err) {
      setHydrateErrorByHash((errors) => ({
        ...errors,
        [hash]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setHydratingHash((current) => (current === hash ? null : current));
    }
  };
  const currentRunTS = () => {
    const loaded = hydratedResult();
    const base = props.item.runts ?? props.item.runjs;
    if (!base || !loaded) return base;
    return { ...base, ...loaded };
  };
  const parsed = createMemo(() =>
    currentRunTS()
      ? normalizeRunTS(currentRunTS()!)
      : parseRunTS(props.item.text),
  );
  const backgrounded = () => props.bag.isRunTSBackgrounded?.(props.item.step) === true;
  const model = () => props.item.model || "";
  const effort = () => props.item.effort || "";
  const showStreamingModelMeta = () =>
    !isTerminalStepStatus(props.item.status) && !!(model() || effort());

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
      class="runts-step"
      open={open()}
      onToggle={(ev) => setOpen(ev.currentTarget.open)}
    >
      <summary>
        <Show when={props.item.status === "agent:Running"}>
          <LoadingDots class="runts-loading" label="running" />
        </Show>
        <Show when={props.item.status === "agent:Queued"}>
          <LoadingDots class="runts-loading" label="streaming tool call" />
        </Show>
        <Show when={props.item.status === "agent:Cancelled"}>
          <span class="runts-status runts-status-cancelled">Cancelled</span>
        </Show>
        <RunTSMarkdown
          class="runts-label"
          content={parsed().label || "(unlabeled)"}
          inline
        />
        <Show when={parsed().description}>
          <span class="runts-desc-inline">
            <span class="runts-desc-separator" aria-hidden="true">
              ·
            </span>
            <RunTSMarkdown
              class="runts-desc-text"
              content={parsed().description}
              inline
            />
          </span>
        </Show>
        <Show when={showStreamingModelMeta()}>
          <span class="runts-model-group step-model-group">
            <Show when={model()}>
              <span class="step-model" title={model()}>
                {model()}
              </span>
            </Show>
            <Show when={effort()}>
              <span class="step-effort" title="reasoning effort">
                ({effort()})
              </span>
            </Show>
          </span>
        </Show>
        <Show
          when={
            props.item.status === "agent:Running" &&
            Number(parsed().backgroundAfterNs ?? 0) > 0
          }
        >
          <RunTSBackgroundCountdown
            item={props.item}
            afterMs={Math.ceil(
              Number(parsed().backgroundAfterNs ?? 0) / 1_000_000,
            )}
          />
        </Show>
        <Show when={props.item.status === "agent:Running"}>
          <span
            class="runts-controls"
            onPointerDown={(ev) => ev.stopPropagation()}
            onMouseDown={(ev) => ev.stopPropagation()}
            onClick={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
            }}
          >
            <Show when={!backgrounded()}>
              <button
                type="button"
                class="runts-control"
                title="run in background"
                aria-label="run in background"
                onPointerDown={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  props.bag.backgroundRunTSStep(props.item.step);
                }}
                onClick={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                }}
              >
                <BackgroundIcon class="runts-control-icon" />
              </button>
            </Show>
            <button
              type="button"
              class="runts-control runts-cancel"
              title="cancel runTS"
              aria-label="cancel runTS"
              onPointerDown={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                props.bag.cancelRunTSStep(props.item.step);
              }}
              onClick={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
              }}
            >
              <CrossIcon class="runts-control-icon" />
            </button>
          </span>
        </Show>
      </summary>
      <Show when={open()}>
        <div class="runts-body">
          <Show when={parsed().description}>
            <RunTSMarkdown
              class="runts-desc-full"
              content={parsed().description}
            />
          </Show>
          <Show when={parsed().code}>
            <RunTSBlock
                sourceId={`${props.item.step}:code`}
              label="Code"
              klass="runts-code"
              content={parsed().code}
              language="ts"
              maxPreviewLines={RUNTS_BLOCK_PREVIEW_LINES}
              onOpenFull={props.onOpenRunTSBlock}
                onUpdateFull={props.onUpdateRunTSBlock}
            />
          </Show>
          <Show when={parsed().hasArgs}>
            <RunTSBlock
                sourceId={`${props.item.step}:args`}
              label="Args"
              klass="runts-args"
              content={parsed().args}
              language="hjson"
              maxPreviewLines={RUNTS_BLOCK_PREVIEW_LINES}
              onOpenFull={props.onOpenRunTSBlock}
                onUpdateFull={props.onUpdateRunTSBlock}
            />
          </Show>
          <Show
            when={
              (props.item.lazyRuntsResult || props.item.lazyRunjsResult) &&
              !!resultHash() &&
              hydratingHash() === resultHash() &&
              !hydratedResult() &&
              !hydrateError()
            }
          >
            <section class="runts-block" aria-label="Loading result">
              <div class="runts-block-label">Result</div>
              <div class="runts-out runts-loading-result">
                <LoadingDots label="loading result" />
              </div>
            </section>
          </Show>
          <Show when={parsed().hasResult}>
            <RunTSBlock
                sourceId={`${props.item.step}:result`}
              label="Result"
              klass="runts-out"
              content={parsed().result}
              maxPreviewLines={RUNTS_BLOCK_PREVIEW_LINES}
              onOpenFull={props.onOpenRunTSBlock}
                onUpdateFull={props.onUpdateRunTSBlock}
            />
          </Show>
          <Show when={parsed().error}>
            <RunTSBlock
                sourceId={`${props.item.step}:error`}
              label="Error"
              klass="runts-out runts-error"
              content={parsed().error}
              maxPreviewLines={RUNTS_BLOCK_PREVIEW_LINES}
              onOpenFull={props.onOpenRunTSBlock}
                onUpdateFull={props.onUpdateRunTSBlock}
            />
          </Show>
          <Show when={hydrateError()}>
            <RunTSBlock
                sourceId={`${props.item.step}:hydrate-error`}
              label="Error"
              klass="runts-out runts-error"
              content={hydrateError()!}
              maxPreviewLines={RUNTS_BLOCK_PREVIEW_LINES}
              onOpenFull={props.onOpenRunTSBlock}
                onUpdateFull={props.onUpdateRunTSBlock}
            />
          </Show>
        </div>
      </Show>
      <StepFooter
        item={props.item}
        bag={props.bag}
        durationNs={parsed().durationNs}
      />
    </details>
  );
}

function RunTSMarkdown(props: {
  class?: string;
  content: string;
  inline?: boolean;
}) {
  const cls = () =>
    (props.class ? props.class + " " : "") + "markdown runts-markdown";
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

function highlightRunTSBlock(content: string, language?: string): string {
  return language
    ? highlightMarkdownCode(content, language)
    : highlightAuto(content);
}

function HighlightedPre(props: {
  class?: string;
  content: string;
  language?: string;
  tabIndex?: number;
  ref?: (el: HTMLPreElement) => void;
}) {
  let el: HTMLPreElement | undefined;
  const html = () => highlightRunTSBlock(props.content, props.language);
  const setEl = (node: HTMLPreElement) => {
    el = node;
    props.ref?.(node);
  };
  createEffect(() => {
    if (el) el.innerHTML = html();
  });
  return <pre ref={setEl} class={props.class} tabIndex={props.tabIndex} />;
}

function runTSBlockLanguageForContent(
  content: string,
  language?: string,
): string | undefined {
  if (language) return language;
  const trimmed = content.trim();
  if (maybeFormatHjsonTextForView(trimmed) !== null) return "hjson";
  if (looksLikeMarkdownText(trimmed)) return "markdown";
  return undefined;
}

function runTSBlockMeta(content: string, language?: string): string {
  const lineCount = content.split("\n").length;
  const parts = [
    `${lineCount} ${lineCount === 1 ? "line" : "lines"}`,
    `${content.length} chars`,
  ];
  const displayLanguage = isHjsonCodeLanguage(language) ? "hjson" : language;
  if (displayLanguage) parts.unshift(displayLanguage);
  return parts.join(" · ");
}

function RunTSBlock(props: {
  sourceId?: string;
  label: string;
  klass: string;
  content: string;
  language?: string;
  maxPreviewLines?: number;
  onOpenFull?: (block: RunTSBlockLightbox) => void;
  onUpdateFull?: (block: RunTSBlockLightbox) => void;
}) {
  let previewEl: HTMLDivElement | undefined;
  const [truncated, setTruncated] = createSignal(false);
  const previewLineLimit = () =>
    props.maxPreviewLines ?? RUNTS_BLOCK_PREVIEW_LINES;
  const language = () =>
    runTSBlockLanguageForContent(props.content, props.language);
  const meta = () => runTSBlockMeta(props.content, language());
  const measureOverflow = () => {
    if (!previewEl) return;
    const style = window.getComputedStyle(previewEl);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const maxPreviewHeight =
      (Number.isFinite(lineHeight) ? lineHeight : 16) * previewLineLimit();
    setTruncated(previewEl.scrollHeight > maxPreviewHeight + 1);
  };
  createEffect(() => {
    props.content;
    props.maxPreviewLines;
    queueMicrotask(measureOverflow);
  });
  onMount(() => {
    measureOverflow();
    window.addEventListener("resize", measureOverflow);
  });
  onCleanup(() => window.removeEventListener("resize", measureOverflow));
  const lightboxBlock = (): RunTSBlockLightbox => ({
    sourceId: props.sourceId ?? `${props.label}:${props.klass}`,
    label: props.label,
    content: () => props.content,
    language,
    meta,
  });
  createEffect(() => {
    props.content;
    props.label;
    props.sourceId;
    if (props.sourceId) props.onUpdateFull?.(lightboxBlock());
  });
  const openFull = () => props.onOpenFull?.(lightboxBlock());
  const openFullFromPointer = (ev: MouseEvent) => {
    if (isNestedInteractiveTarget(ev.target, ev.currentTarget)) return;
    openFull();
  };
  const openFullFromKeyboard = (ev: KeyboardEvent) => {
    if (isNestedInteractiveTarget(ev.target, ev.currentTarget)) return;
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    openFull();
  };
  return (
    <section class="runts-block" aria-label={props.label}>
      <div class="runts-block-heading">
        <div class="runts-block-title">
          <span class="runts-block-label">{props.label}</span>
          <span class="runts-block-meta">{meta()}</span>
        </div>
      </div>
      <div
        ref={previewEl}
        role="button"
        tabIndex={0}
        classList={{
          "runts-block-preview": true,
          "is-truncated": truncated(),
        }}
        style={{ "--runts-preview-max-height": `${previewLineLimit() * 1.3}em` }}
        onClick={openFullFromPointer}
        onKeyDown={openFullFromKeyboard}
        title={`Open full ${props.label}`}
      >
        <HighlightedPre
          class={props.klass}
          content={props.content}
          language={language()}
        />
        <Show when={truncated()}>
          <div class="runts-block-fade" aria-hidden="true" />
        </Show>
      </div>
    </section>
  );
}

function isNestedInteractiveTarget(
  target: EventTarget | null,
  root: EventTarget | null,
): boolean {
  if (!(target instanceof Element) || !(root instanceof Element)) return false;
  const interactive = target.closest(
    "button, a, input, textarea, select, summary, [contenteditable='true']",
  );
  return (
    interactive instanceof Element &&
    interactive !== root &&
    root.contains(interactive)
  );
}

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
    if (info()?.provider === "deepseek" && effortSupported())
      return "DeepSeek thinking mode";
    return "effort is only sent to providers/models that support it";
  };
  const effortLabel = (effort: string | null | undefined) => {
    if (!effort) return "";
    if (info()?.provider !== "deepseek") return effort;
    if (effort === "none") return "Non-think";
    if (effort === "high") return "Think High";
    if (effort === "max") return "Think Max";
    return effort;
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
              ? `default (${effortLabel(info()?.defaultEffort)})`
              : "default"}
          </option>
          <For each={info()?.efforts ?? []}>
            {(effort) => <option value={effort}>{effortLabel(effort)}</option>}
          </For>
        </select>
      </Show>
    </div>
  );
}

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const n = Math.max(0, Math.trunc(value));
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000)
    return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return n.toLocaleString();
}
function TokenBar(props: {
  tokens: () => {
    used: number;
    budget: number;
    threshold: number;
    availableTokens?: number;
    compactionsInARow?: number;
    fraction: number;
    source?: string;
    estimated?: boolean;
  } | null;
  onCompact: () => void;
  disabled: () => boolean;
  compacting: () => boolean;
}) {
  const currentTokens = () => props.tokens();
  const safeTokens = () =>
    currentTokens() ?? {
      used: 0,
      budget: 0,
      threshold: 0,
      availableTokens: 0,
      compactionsInARow: undefined,
      fraction: 0,
      source: undefined,
      estimated: undefined,
    };
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
  const cls = () => {
    const tokens = safeTokens();
    return (
      "token-meter" +
      (!currentTokens() ? " empty" : "") +
      (safeBudget() > 0 && tokens.used >= tokens.threshold ? " over" : "")
    );
  };
  const sourceLabel = () => {
    const source = safeTokens().source;
    if (source === "compaction") return "compaction prompt estimate";
    if (source === "context") return "last LLM context";
    return "token usage";
  };
  const title = () => {
    const tokens = safeTokens();
    if (!currentTokens()) return "token usage loading";
    const available = Math.max(
      0,
      Number(tokens.availableTokens ?? tokens.threshold - tokens.used) || 0,
    );
    const streak = Number(tokens.compactionsInARow ?? 0) || 0;
    return `${tokens.used.toLocaleString()} / ${tokens.budget.toLocaleString()} tokens (${sourceLabel()}) · compaction threshold ${tokens.threshold.toLocaleString()} · ${available.toLocaleString()} tokens before threshold${streak ? ` · ${streak} compactions in a row` : ""}`;
  };
  return (
    <div class={cls()} title={title()} aria-label={title()}>
      <div class="token-meter-head">
        <span>tokens</span>
        <strong>
          {currentTokens()
            ? `${formatTokenCount(safeTokens().used)} / ${formatTokenCount(safeTokens().budget)}`
            : "—"}
        </strong>
      </div>
      <div class="token-bar">
        <span class="token-fill" style={{ width: pct() + "%" }} />
        <span class="token-mark" style={{ left: thresholdPct() + "%" }} />
      </div>
      <button
        type="button"
        class="token-compact-button"
        title={
          props.compacting()
            ? "Compacting older turns…"
            : "Compact older turns into a summary"
        }
        aria-label={
          props.compacting() ? "Compacting older turns" : "Compact older turns"
        }
        disabled={props.disabled()}
        onClick={props.onCompact}
      >
        <CompactIcon class="token-compact-icon" />
      </button>
    </div>
  );
}
function compactionTrigger(
  detail: Record<string, any>,
): "manual" | "automatic" {
  return detail.trigger === "manual" ? "manual" : "automatic";
}

function compactionTriggerTitle(detail: Record<string, any>): string {
  return compactionTrigger(detail) === "manual" ? "Manual" : "Automatic";
}

function compactionFailureIntro(detail: Record<string, any>): string {
  const status = Number(detail.status ?? 0) || 0;
  const reason = typeof detail.reason === "string" ? detail.reason : "";
  const trigger = compactionTrigger(detail);
  if (status >= 400)
    return `The model provider rejected the ${trigger} compaction request.`;
  if ((status >= 200 && status < 300) || /stream/i.test(reason)) {
    return `The model provider returned a stream error after accepting the ${trigger} compaction request.`;
  }
  return `${compactionTriggerTitle(detail)} compaction failed before the conversation could be summarized.`;
}
function CompactionErrorBody(props: {
  item: StepItem;
  detail: Record<string, any>;
}) {
  const message = () =>
    String(props.detail.message || props.detail.reason || "").trim();
  const diagnostics = () => errorDiagnosticLines(props.detail);
  const technicalDetails = () => formatErrorPayloadForView(props.item.error);
  const tokenDetails = () => {
    const prompt = Number(props.detail.promptTokens ?? 0) || 0;
    const requestPrompt = Number(props.detail.requestPromptTokens ?? 0) || 0;
    const requestLimit = Number(props.detail.requestTokenLimit ?? 0) || 0;
    const budget = Number(props.detail.tokenBudget ?? 0) || 0;
    const threshold = Number(props.detail.tokenThreshold ?? 0) || 0;
    const available = Number(props.detail.availableTokens ?? 0) || 0;
    const streak = Number(props.detail.compactionsInARow ?? 0) || 0;
    if (
      !prompt &&
      !requestPrompt &&
      !requestLimit &&
      !budget &&
      !threshold &&
      !available &&
      !streak
    )
      return "";
    const hasFittedRequest =
      requestPrompt > 0 && (!prompt || requestPrompt !== prompt);
    return [
      prompt
        ? `${formatTokenCount(prompt)} ${hasFittedRequest ? "transcript" : "prompt"} tokens`
        : "",
      hasFittedRequest
        ? `${formatTokenCount(requestPrompt)} request tokens`
        : "",
      requestLimit ? `${formatTokenCount(requestLimit)} request cap` : "",
      budget ? `${formatTokenCount(budget)} token budget` : "",
      threshold ? `threshold ${formatTokenCount(threshold)}` : "",
      available ? `${formatTokenCount(available)} before threshold` : "",
      streak ? `${streak} compactions in a row` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  };
  return (
    <>
      <div class="error-head">
        <span class="error-icon">!</span>
        <strong>
          {compactionTriggerTitle(props.detail)} compaction failed
        </strong>
      </div>
      <div class="error-body">
        {compactionFailureIntro(props.detail)} Your chat is intact, but no reply
        was generated.{" "}
        {compactionTrigger(props.detail) === "manual" ? (
          "Try switching to a larger-context model, lowering reasoning effort, or reducing retained history."
        ) : (
          <>
            Try compacting from the token bar, switch to a larger-context model,
            or reduce retained history.
          </>
        )}
      </div>
      <Show when={message()}>
        <div class="error-body">Provider message: {message()}</div>
      </Show>
      <Show when={diagnostics()}>
        <div class="error-body error-diagnostics">{diagnostics()}</div>
      </Show>
      <Show when={tokenDetails()}>
        <div class="error-body">{tokenDetails()}</div>
      </Show>
      <Show when={technicalDetails()}>
        <details class="error-payload">
          <summary>Technical details</summary>
          <pre innerHTML={highlightErrorPayloadForView(technicalDetails())} />
        </details>
      </Show>
    </>
  );
}

function ErrorBody(props: { item: StepItem }) {
  const text = () => props.item.text || "";
  const lines = () => text().split("\n");
  const head = () => lines()[0] || "error";
  const detail = () => props.item.error?.detail;
  const compaction = () => compactionErrorDetail(props.item);
  const message = () =>
    String(
      (detail()?.message ?? lines().slice(1).join("\n")) ||
        compactErrorDetail(detail() ?? props.item.error) ||
        "No error details recorded.",
    ).trim();
  const diagnostics = () =>
    errorDiagnosticLines(detail() as Record<string, any> | undefined | null);
  const payloadText = () => formatErrorPayloadForView(detail()?.body);
  const showPayload = () => {
    const payload = payloadText();
    return payload && payload !== message();
  };
  if (compaction()) {
    return <CompactionErrorBody item={props.item} detail={compaction()!} />;
  }
  return (
    <>
      <div class="error-head">
        <span class="error-icon">!</span>
        <strong>{head()}</strong>
      </div>
      <Show when={message()}>
        <div
          class="error-body markdown"
          innerHTML={renderMarkdown(message())}
        />
      </Show>
      <Show when={diagnostics()}>
        <div
          class="error-body error-diagnostics markdown"
          innerHTML={renderMarkdown(diagnostics())}
        />
      </Show>
      <Show when={showPayload()}>
        <details class="error-payload" open>
          <summary>Response payload</summary>
          <pre innerHTML={highlightErrorPayloadForView(payloadText())} />
        </details>
      </Show>
    </>
  );
}

function highlightErrorPayloadForView(body: unknown): string {
  const text =
    typeof body === "string" ? body : formatErrorPayloadForView(body);
  return text ? highlightAuto(text) : "";
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
