import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { AppCodeExplorer } from "./AppCodeExplorer";
import { UiPanel } from "./ChatApps";
import {
  anchorFromEventTarget,
  renderMarkdown,
  renderMarkdownInline,
  repoFilePathFromHref,
  resolveRepoFileHref,
} from "./markdown";
import {
  DEFAULT_HIGHLIGHT_MAX_BYTES,
  highlightAuto,
  highlightByPath,
  highlightHjsonValue,
} from "./syntax";
import { DiffView, MemoryDiffView, type DiffExpansionStore } from "./DiffView";
import { LoadingDots } from "./LoadingDots";
import { MaximizeIcon, MenuIcon, PlusIcon, RestoreIcon } from "./icons";
import { LeftSidebarToggle } from "./HeaderControls";

import {
  api,
  type FileDiffItem,
  type FsEntry,
  type GitBranchItem,
  type GitBranchesValue,
  type JjRevisionItem,
  type StepItem,
  type StoreObject,
  type TimelineItem,
  type Sha256Hash,
  type TrailItem,
  type MemoryDiffItem,
} from "./api";
import {
  diffStats,
  hasFileDiffBeforeSnapshot,
  mergeFileDiffItems,
  mergedFileDiffs,
  mergedMemoryDiffs,
  normalizeDiffPath,
  sameDiffPath,
  sameDiffPathInRoot,
  unifiedFileDiff,
  type MergedFileDiffItem,
  type MemoryGraphDiffSummary,
} from "./diffs";
import { TraceEventDetails } from "./TracesView";
import {
  displayChatId,
  type Bag,
  type BrowserNavState,
  type DiffContentMode,
  type DiffViewState,
  type JsonPreviewFile,
  type OpenRepoFile,
  type RightSidebarTab,
  relativeTime,
} from "./state";
import { collapseHome, expandHome } from "./paths";
import {
  isFilesystemAbsolutePath,
  joinRepoPath,
  normalizePathSegments,
  normalizeRepoPath,
  normalizedOptionalPath,
  pathWithinRoot,
  relativeRepoPath,
  repoFileBasePath,
  htmlPreviewAssetBasePath,
} from "./repoPaths";
import {
  applyAndPersistThemeMode,
  storedThemeMode,
  type ThemeMode,
} from "./theme";
import { getPsk } from "./auth";

type Chat = ReturnType<Bag["chats"]>[number];

function isFileDiffItem(
  item: TimelineItem | null | undefined,
): item is FileDiffItem {
  return item?.type === "file-diff";
}

function hasMemoryDiffAction(
  item: MemoryDiffItem | MemoryGraphDiffSummary,
): item is MemoryDiffItem & { action: "assert" | "retract" } {
  return (
    "action" in item && (item.action === "assert" || item.action === "retract")
  );
}

const INITIAL_RENDERED_CHATS = 80;
const RENDERED_CHATS_PAGE = 120;

function fileName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() || trimmed || "file";
}

function displayFilePath(path: string, root?: string | null): string {
  const normalized = normalizePathSegments(path);
  const normalizedRoot = normalizedOptionalPath(root);
  if (normalizedRoot && pathWithinRoot(normalized, normalizedRoot)) {
    const rel = relativeRepoPath(normalizedRoot, normalized);
    return rel || ".";
  }
  return collapseHome(path);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
}

function contentSizeBytes(content: string | null | undefined): number | null {
  return typeof content === "string" ? new Blob([content]).size : null;
}

function RepoFileLoadingDots(props: { loading?: boolean; label?: string }) {
  const loading = () => Boolean(props.loading);

  return (
    <span
      classList={{
        "repo-file-loading-slot": true,
        "repo-file-loading-slot-active": loading(),
      }}
      aria-hidden={loading() ? undefined : "true"}
    >
      <Show when={loading()}>
        <LoadingDots
          class="repo-file-loading-dots"
          label={props.label ?? "loading file"}
        />
      </Show>
    </span>
  );
}

type MeasuredFileSize = { size: number; revision: string | null };

const measuredFileSizeCache = new Map<string, MeasuredFileSize>();

function fileSizeCacheKey(
  path: string | null | undefined,
  root?: string | null,
): string | null {
  const rawPath = String(path || "").trim();
  if (!rawPath) return null;
  const normalizedRoot = normalizedOptionalPath(root) ?? "";
  return normalizedRoot + "\n" + normalizePathSegments(rawPath);
}

function cachedFileSizeBytes(
  path: string | null | undefined,
  root?: string | null,
): number | null {
  const key = fileSizeCacheKey(path, root);
  return key ? (measuredFileSizeCache.get(key)?.size ?? null) : null;
}

function rememberFileSizeBytes(
  path: string | null | undefined,
  root: string | null | undefined,
  size: number | null | undefined,
  revision?: string | null,
) {
  if (typeof size !== "number" || size < 0) return;
  const key = fileSizeCacheKey(path, root);
  if (key) {
    const existing = measuredFileSizeCache.get(key);
    measuredFileSizeCache.set(key, {
      size,
      revision:
        revision === undefined ? (existing?.revision ?? null) : revision,
    });
  }
}

function cachedFileSizeRevision(
  path: string | null | undefined,
  root?: string | null,
): string | null | undefined {
  const key = fileSizeCacheKey(path, root);
  return key ? measuredFileSizeCache.get(key)?.revision : undefined;
}

function fileSizeRevisionForPath(
  path: string | null | undefined,
  items: TimelineItem[],
): string {
  const rawPath = String(path || "").trim();
  if (!rawPath) return "";
  const parts: string[] = [];
  for (const item of items) {
    if (item.type !== "file-diff" || !sameDiffPath(item.path, rawPath))
      continue;
    parts.push(
      [
        item.id,
        item.at,
        item.hash ?? "",
        item.stats?.added ?? "",
        item.stats?.removed ?? "",
        contentSizeBytes(item.after),
      ].join(":"),
    );
  }
  parts.sort();
  return parts.join("|");
}

function sameBrowserFilePath(
  a: string | null | undefined,
  b: string | null | undefined,
  root?: string | null,
): boolean {
  const left = String(a || "").trim();
  const right = String(b || "").trim();
  if (!left || !right) return left === right;
  if (normalizePathSegments(left) === normalizePathSegments(right)) return true;
  return (
    browserRelativePath(root ?? null, left) ===
    browserRelativePath(root ?? null, right)
  );
}

function repoFileNeedsVisibleLoading(
  file: OpenRepoFile,
  root?: string | null,
): boolean {
  if (!file.loading) return false;
  const requestedPath = String(file.requestedPath || "").trim();
  const resolvedPath = String(file.path || "").trim();
  if (!requestedPath || !resolvedPath) return true;
  return !sameBrowserFilePath(resolvedPath, requestedPath, root);
}

function chatDirectory(path: string | null | undefined): string | null {
  const raw = String(path || "").trim();
  return raw || null;
}

function parentDirectoryPath(path: string): string {
  const normalized =
    normalizePathSegments(path || ".").replace(/\/+$/, "") || "/";
  if (normalized === "/") return "/";
  const slash = normalized.lastIndexOf("/");
  if (slash === 0) return "/";
  if (slash > 0) return normalized.slice(0, slash);
  if (/^[A-Za-z]:$/.test(normalized)) return normalized;
  const driveRoot = normalized.match(/^[A-Za-z]:\/[^/]*$/);
  if (driveRoot) return normalized.slice(0, 2);
  return "..";
}

function directoryEntriesWithParent(
  path: string,
  entries: FsEntry[] | undefined,
  root?: string | null,
): FsEntry[] {
  void root;
  const parent = parentDirectoryPath(path);
  const current = normalizePathSegments(path).replace(/\/+$/, "") || "/";
  const normalizedParent =
    normalizePathSegments(parent).replace(/\/+$/, "") || "/";
  return normalizedParent === current
    ? (entries ?? [])
    : [
        { name: "..", path: parent, kind: "dir", size: 0, mtime: 0 },
        ...(entries ?? []),
      ];
}

type DiffCountSource = Pick<FsEntry, "additions" | "deletions">;

function entryDiffCount(entry: DiffCountSource): {
  additions: number;
  deletions: number;
} {
  return {
    additions: Math.max(0, Number(entry.additions || 0)),
    deletions: Math.max(0, Number(entry.deletions || 0)),
  };
}

type BrowserDiffStats = {
  changed: boolean;
  additions: number;
  deletions: number;
};
type BrowserDiffStatsMap = Map<string, BrowserDiffStats>;

function normalizedBrowserDiffPath(path: string | null | undefined): string {
  const normalized = normalizePathSegments(String(path || "")).replace(
    /\/+$/,
    "",
  );
  return normalized === "." ? "" : normalized.replace(/^\/+/, "");
}

function browserRelativePath(
  root: string | null | undefined,
  path: string | null | undefined,
): string {
  const normalizedPath = normalizePathSegments(String(path || ""));
  const normalizedRoot = normalizedOptionalPath(root);
  if (normalizedRoot && pathWithinRoot(normalizedPath, normalizedRoot)) {
    return normalizedBrowserDiffPath(
      relativeRepoPath(normalizedRoot, normalizedPath),
    );
  }
  return normalizedBrowserDiffPath(normalizedPath);
}

function addBrowserDiffStats(
  stats: BrowserDiffStatsMap,
  path: string,
  additions: number,
  deletions: number,
) {
  const clean = normalizedBrowserDiffPath(path);
  if (!clean || clean.split("/").some((part) => !part || part === "..")) return;
  const add = Math.max(0, Number(additions || 0));
  const del = Math.max(0, Number(deletions || 0));
  const rootPrev = stats.get("") ?? {
    changed: false,
    additions: 0,
    deletions: 0,
  };
  stats.set("", {
    changed: true,
    additions: rootPrev.additions + add,
    deletions: rootPrev.deletions + del,
  });
  const parts = clean.split("/");
  for (let i = 1; i <= parts.length; i += 1) {
    const key = parts.slice(0, i).join("/");
    const prev = stats.get(key) ?? {
      changed: false,
      additions: 0,
      deletions: 0,
    };
    stats.set(key, {
      changed: true,
      additions: prev.additions + add,
      deletions: prev.deletions + del,
    });
  }
}

function entryWithBrowserDiffStats<
  T extends DiffCountSource & { changed?: boolean },
>(entry: T, stats: BrowserDiffStats | null | undefined): T {
  if (!stats?.changed || entry.changed) return entry;
  return {
    ...entry,
    changed: Boolean(entry.changed || stats.changed),
    additions: Math.max(0, Number(entry.additions || 0)) + stats.additions,
    deletions: Math.max(0, Number(entry.deletions || 0)) + stats.deletions,
  };
}

const OPEN_REPO_FILE_SYNTHETIC_DIFF_MAX_BYTES = 1 << 20;

function openRepoFileCurrentDiff(
  file: OpenRepoFile,
  root: string | null | undefined,
  idPrefix: string,
): FileDiffItem | null {
  const diffText = file.diff;
  if (file.kind !== "file" || !diffText) return null;
  const previewPath = file.path || file.requestedPath;
  const relativePath = browserRelativePath(root, previewPath);
  const stats = file.diffStats ?? diffStats(diffText);
  return {
    type: "file-diff" as const,
    id:
      idPrefix +
      ":" +
      normalizeDiffPath(relativePath || previewPath) +
      ":" +
      String(file.mtime || 0) +
      ":" +
      String(file.size || 0) +
      ":" +
      stats.added +
      ":" +
      stats.removed,
    chatId: "" as FileDiffItem["chatId"],
    path: relativePath || previewPath,
    diff: diffText,
    stats,
    after: file.content,
    at: file.mtime || 0,
  } satisfies FileDiffItem;
}

type FileDiffPayload = {
  chatId?: string;
  path?: string;
  diff?: string;
  stats?: FileDiffItem["stats"];
  before?: string | null;
  after?: string | null;
  hasBefore?: boolean;
  hasAfter?: boolean;
  at?: number;
  hash?: string;
};

const fileDiffPayloadCache = new Map<string, Promise<FileDiffPayload | null>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseFileDiffStats(
  value: unknown,
  diff: string,
): FileDiffItem["stats"] | undefined {
  if (!isRecord(value)) return undefined;
  const fallback = diff ? diffStats(diff) : { added: 0, removed: 0, lines: 0 };
  const added = Number(value.added);
  const removed = Number(value.removed);
  const lines = Number(value.lines);
  if (
    !Number.isFinite(added) &&
    !Number.isFinite(removed) &&
    !Number.isFinite(lines)
  ) {
    return undefined;
  }
  return {
    added: Number.isFinite(added)
      ? Math.max(0, Math.trunc(added))
      : fallback.added,
    removed: Number.isFinite(removed)
      ? Math.max(0, Math.trunc(removed))
      : fallback.removed,
    lines: Number.isFinite(lines)
      ? Math.max(0, Math.trunc(lines))
      : fallback.lines,
  };
}

function parseFileDiffPayload(value: unknown): FileDiffPayload | null {
  if (!isRecord(value)) return null;
  const beforePresent = Object.prototype.hasOwnProperty.call(value, "before");
  const afterPresent = Object.prototype.hasOwnProperty.call(value, "after");
  const beforeValue = value.before;
  const afterValue = value.after;
  const before =
    beforePresent && (typeof beforeValue === "string" || beforeValue === null)
      ? beforeValue
      : undefined;
  const after =
    afterPresent && (typeof afterValue === "string" || afterValue === null)
      ? afterValue
      : undefined;
  const diff = typeof value.diff === "string" ? value.diff : undefined;
  if (diff === undefined && before === undefined && after === undefined)
    return null;
  return {
    chatId: typeof value.chatId === "string" ? value.chatId : undefined,
    path: typeof value.path === "string" ? value.path : undefined,
    diff,
    stats: parseFileDiffStats(value.stats, diff ?? ""),
    before,
    after,
    hasBefore: before !== undefined,
    hasAfter: after !== undefined,
    at:
      typeof value.at === "number" && Number.isFinite(value.at)
        ? value.at
        : undefined,
    hash: typeof value.hash === "string" ? value.hash : undefined,
  };
}

function parseFileDiffPayloadObject(
  object: StoreObject,
): FileDiffPayload | null {
  const text = object?.content ?? object?.text;
  if (typeof text !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const candidates =
    isRecord(parsed) && isRecord(parsed.value)
      ? [parsed.value, parsed]
      : [parsed];
  for (const candidate of candidates) {
    const payload = parseFileDiffPayload(candidate);
    if (payload) return payload;
  }
  return null;
}

function normalizedFileDiffObjectHash(
  hash: string | null | undefined,
): string | null {
  const raw = String(hash || "").trim();
  return raw ? raw.toLowerCase() : null;
}

async function fileDiffPayloadForHash(
  hash: string,
): Promise<FileDiffPayload | null> {
  const normalized = normalizedFileDiffObjectHash(hash);
  if (!normalized) return null;
  let cached = fileDiffPayloadCache.get(normalized);
  if (!cached) {
    cached = api.objects
      .get(normalized as Sha256Hash)
      .then((result) =>
        result.ok ? parseFileDiffPayloadObject(result.value.object) : null,
      )
      .catch(() => null);
    fileDiffPayloadCache.set(normalized, cached);
  }
  return cached;
}

async function hydrateFileDiffItem(
  source: FileDiffItem,
): Promise<FileDiffItem | null> {
  const hash = normalizedFileDiffObjectHash(source.hash);
  if (!hash) return null;
  const payload = await fileDiffPayloadForHash(hash);
  if (!payload) return null;
  const diff = payload.diff ?? source.diff ?? "";
  const next: FileDiffItem = {
    ...source,
    path: payload.path || source.path,
    diff,
    stats:
      payload.stats ?? source.stats ?? (diff ? diffStats(diff) : undefined),
    hash: payload.hash || source.hash || hash,
    at: payload.at ?? source.at,
  };
  if (payload.chatId) next.chatId = payload.chatId as FileDiffItem["chatId"];
  if (payload.hasBefore) next.before = payload.before ?? null;
  if (payload.hasAfter) next.after = payload.after ?? null;
  return next;
}

function hasBeforeSnapshot(item: FileDiffItem): boolean {
  return (
    Object.prototype.hasOwnProperty.call(item, "before") &&
    (typeof item.before === "string" || item.before === null)
  );
}

function hasAfterSnapshot(item: FileDiffItem): boolean {
  return (
    Object.prototype.hasOwnProperty.call(item, "after") &&
    (typeof item.after === "string" || item.after === null)
  );
}

function fileDiffSourceItems(item: MergedFileDiffItem): FileDiffItem[] {
  const sources = item.items?.length ? item.items : [item];
  return [...sources].sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
}

export function expandedFileDiffNeedsHydration(
  item: MergedFileDiffItem,
): boolean {
  const sources = fileDiffSourceItems(item);
  const first = sources[0];
  const last = sources[sources.length - 1];
  return Boolean(
    (first && !hasBeforeSnapshot(first) && first.hash) ||
    (last && !hasAfterSnapshot(last) && last.hash),
  );
}

export function expandedFileDiffHydrationKey(item: MergedFileDiffItem): string {
  return fileDiffSourceItems(item)
    .map((source) =>
      [
        source.id,
        source.path,
        source.at,
        source.hash ?? "",
        hasBeforeSnapshot(source) ? "before" : "",
        hasAfterSnapshot(source) ? `after:${source.after?.length ?? 0}` : "",
        source.diff?.length ?? 0,
      ].join("\0"),
    )
    .join("\n");
}

async function hydrateMergedFileDiff(
  item: MergedFileDiffItem,
): Promise<MergedFileDiffItem> {
  const sources = fileDiffSourceItems(item);
  if (sources.length === 0) return item;
  const hydrateIndexes = new Set<number>();
  const first = sources[0]!;
  const last = sources[sources.length - 1]!;
  if (!hasBeforeSnapshot(first) && first.hash) hydrateIndexes.add(0);
  if (!hasAfterSnapshot(last) && last.hash)
    hydrateIndexes.add(sources.length - 1);
  if (hydrateIndexes.size === 0) return item;

  const next = [...sources];
  let changed = false;
  await Promise.all(
    [...hydrateIndexes].map(async (index) => {
      const hydrated = await hydrateFileDiffItem(next[index]!);
      if (!hydrated) return;
      next[index] = hydrated;
      changed = true;
    }),
  );
  if (!changed) return item;
  const merged = mergeFileDiffItems(next);
  return {
    ...merged,
    id: item.id,
    path: item.path || merged.path,
    items: next,
  };
}

function openRepoFileTimelineDiff(
  file: OpenRepoFile,
  root: string | null | undefined,
  diffs: FileDiffItem[],
): FileDiffItem | null {
  if (file.kind !== "file") return null;
  const previewPath = file.path || file.requestedPath;
  const relativePath = browserRelativePath(root, previewPath);
  return (
    diffs.find(
      (diff) =>
        sameDiffPathInRoot(diff.path, relativePath, root) ||
        sameDiffPathInRoot(diff.path, previewPath, root),
    ) ?? null
  );
}

function comparableFileContent(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sameFileContent(a: string, b: string): boolean {
  return a === b || comparableFileContent(a) === comparableFileContent(b);
}

function synthesizeOpenRepoFileDiff(
  file: OpenRepoFile,
  root: string | null | undefined,
  timelineDiff: FileDiffItem,
): FileDiffItem | null {
  if (file.kind !== "file") return null;
  if (!hasFileDiffBeforeSnapshot(timelineDiff)) return null;
  const before = timelineDiff.before;
  if (before !== null && typeof before !== "string") return null;
  const content = file.content || "";
  if (
    (before?.length ?? 0) + content.length >
    OPEN_REPO_FILE_SYNTHETIC_DIFF_MAX_BYTES
  ) {
    return null;
  }
  const previewPath = file.path || file.requestedPath;
  const relativePath = browserRelativePath(root, previewPath);
  const path = timelineDiff.path || relativePath || previewPath;
  const diff = unifiedFileDiff(path, before, content);
  const stats = diffStats(diff);
  if (stats.added === 0 && stats.removed === 0) return null;
  return {
    ...timelineDiff,
    id:
      "filesystem-current:" +
      normalizeDiffPath(path) +
      ":" +
      String(file.mtime || 0) +
      ":" +
      String(file.size || 0) +
      ":" +
      stats.added +
      ":" +
      stats.removed,
    path,
    diff,
    stats,
    after: content,
    at: Math.max(Number(timelineDiff.at || 0), Number(file.mtime || 0)),
  };
}

export function preferredOpenRepoFileDiff(
  file: OpenRepoFile,
  root: string | null | undefined,
  timelineDiff: FileDiffItem | null | undefined,
  currentDiff: FileDiffItem | null | undefined,
): FileDiffItem | null {
  if (file.kind !== "file") return null;
  if (file.loading) return null;
  if (!timelineDiff) return currentDiff ?? null;

  const content = file.content || "";
  if (
    typeof timelineDiff.after === "string" &&
    sameFileContent(timelineDiff.after, content)
  ) {
    return timelineDiff;
  }

  const synthetic = synthesizeOpenRepoFileDiff(file, root, timelineDiff);
  if (synthetic) return synthetic;
  return currentDiff ?? timelineDiff;
}

function entryDiffTitle(entry: DiffCountSource): string {
  const { additions, deletions } = entryDiffCount(entry);
  return `${additions} additions, ${deletions} deletions`;
}

function DiffStatsBadge(props: {
  stats: () => { additions: number; deletions: number };
  label: () => string;
  class?: string;
}) {
  return (
    <span
      class={`right-diff-stats${props.class ? " " + props.class : ""}`}
      title={props.label()}
      aria-label={props.label()}
    >
      <span class="right-diff-added">+{props.stats().additions}</span>
      <span class="right-diff-removed">−{props.stats().deletions}</span>
    </span>
  );
}

function EntryDiffBadge(props: { entry: DiffCountSource }) {
  return (
    <DiffStatsBadge
      stats={() => entryDiffCount(props.entry)}
      label={() => entryDiffTitle(props.entry)}
      class="fs-entry-diff-stats"
    />
  );
}

function RepoFileDiffBadge(props: { entry: DiffCountSource }) {
  return (
    <DiffStatsBadge
      stats={() => entryDiffCount(props.entry)}
      label={() => entryDiffTitle(props.entry)}
      class="repo-file-diff-stats"
    />
  );
}

function ChangeStatsBadge(props: {
  stats: () => { added: number; removed: number };
  label: () => string;
  class?: string;
  title?: () => string;
}) {
  return (
    <span
      class={`right-diff-stats${props.class ? " " + props.class : ""}`}
      title={props.title?.()}
      aria-label={props.label()}
    >
      <span class="right-diff-added">+{props.stats().added}</span>
      <span class="right-diff-removed">−{props.stats().removed}</span>
    </span>
  );
}

function sameFsEntry(a: FsEntry, b: FsEntry): boolean {
  return (
    a.name === b.name &&
    a.path === b.path &&
    a.kind === b.kind &&
    a.size === b.size &&
    a.mtime === b.mtime &&
    Boolean(a.changed) === Boolean(b.changed) &&
    Number(a.additions || 0) === Number(b.additions || 0) &&
    Number(a.deletions || 0) === Number(b.deletions || 0)
  );
}

function sameFsEntries(
  a: FsEntry[] | undefined,
  b: FsEntry[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!sameFsEntry(a[i]!, b[i]!)) return false;
  }
  return true;
}

function sameDiffStats(
  a: { added: number; removed: number; lines: number } | null | undefined,
  b: { added: number; removed: number; lines: number } | null | undefined,
): boolean {
  return !a && !b
    ? true
    : Boolean(
        a &&
        b &&
        a.added === b.added &&
        a.removed === b.removed &&
        a.lines === b.lines,
      );
}

function sameOpenRepoFile(a: OpenRepoFile, b: OpenRepoFile): boolean {
  return (
    a.requestedPath === b.requestedPath &&
    a.path === b.path &&
    a.content === b.content &&
    a.size === b.size &&
    a.mtime === b.mtime &&
    a.kind === b.kind &&
    a.loading === b.loading &&
    (a.error ?? null) === (b.error ?? null) &&
    Boolean(a.changed) === Boolean(b.changed) &&
    Number(a.additions || 0) === Number(b.additions || 0) &&
    Number(a.deletions || 0) === Number(b.deletions || 0) &&
    (a.diff ?? null) === (b.diff ?? null) &&
    sameDiffStats(a.diffStats, b.diffStats) &&
    sameFsEntries(a.entries, b.entries)
  );
}

function setOpenRepoFileIfChanged(
  setFile: (
    value: OpenRepoFile | ((prev: OpenRepoFile) => OpenRepoFile),
  ) => OpenRepoFile,
  next: OpenRepoFile,
) {
  setFile((prev) => (sameOpenRepoFile(prev, next) ? prev : next));
}

function PrettyError(props: { message: string; title?: string }) {
  const parts = () => {
    const raw = String(props.message || "Something went wrong").trim();
    const [first, ...rest] = raw.split(/\r?\n/).filter(Boolean);
    return { first: first || "Something went wrong", rest };
  };
  return (
    <div class="pretty-error" role="alert">
      <div class="pretty-error-icon" aria-hidden="true">
        !
      </div>
      <div class="pretty-error-copy">
        <div class="pretty-error-title">
          {props.title || "Couldn’t open file"}
        </div>
        <div class="pretty-error-message">{parts().first}</div>
        <Show when={parts().rest.length}>
          <pre class="pretty-error-detail">{parts().rest.join("\n")}</pre>
        </Show>
      </div>
    </div>
  );
}

export function NewChatView(props: { bag: Bag; onToggleSidebar: () => void }) {
  const { bag } = props;
  const [explorerExpanded, setExplorerExpanded] = createSignal(false);
  const [explorerPath, setExplorerPath] = createSignal(".");
  const [explorerParent, setExplorerParent] = createSignal<string | null>(null);
  const [explorerEntries, setExplorerEntries] = createSignal<FsEntry[]>([]);
  const [recentPaths, setRecentPaths] = createSignal<string[]>([]);
  const [recentRepoKinds, setRecentRepoKinds] = createSignal<
    Record<string, GitBranchesValue["repoKind"]>
  >({});
  const [recentPathsLoaded, setRecentPathsLoaded] = createSignal(false);
  const [pendingProjectPath, setPendingProjectPath] = createSignal<string | null>(null);
  const [branchPath, setBranchPath] = createSignal<string | null>(null);
  const [branches, setBranches] = createSignal<GitBranchItem[]>([]);
  const [selectedBranch, setSelectedBranch] = createSignal<string | null>(null);
  const [jjRevisions, setJjRevisions] = createSignal<JjRevisionItem[]>([]);
  const [selectedJjRevision, setSelectedJjRevision] = createSignal<
    string | null
  >(null);
  const [repoKind, setRepoKind] =
    createSignal<GitBranchesValue["repoKind"]>(null);
  const [isGitRepo, setIsGitRepo] = createSignal(false);
  const [isVersionedRepo, setIsVersionedRepo] = createSignal(false);
  const [hasBranchRemote, setHasBranchRemote] = createSignal(false);
  const [branchesLoading, setBranchesLoading] = createSignal(false);
  const [branchesPulling, setBranchesPulling] = createSignal(false);
  const [jjAvailable, setJjAvailable] = createSignal(false);
  const [branchesMessage, setBranchesMessage] = createSignal<string | null>(
    null,
  );
  const [branchesError, setBranchesError] = createSignal<string | null>(null);
  const [explorerBusy, setExplorerBusy] = createSignal(false);
  const [creatingProjectChat, setCreatingProjectChat] = createSignal(false);
  const [creatingRepoLessChat, setCreatingRepoLessChat] = createSignal(false);
  const [explorerError, setExplorerError] = createSignal<string | null>(null);

  async function loadRecentPaths() {
    const recent = await api.chat.recentPaths();
    setRecentPathsLoaded(true);
    if (!recent.ok) {
      setRecentRepoKinds({});
      return;
    }

    const paths = recent.value.paths.map((p) => collapseHome(p));
    setRecentPaths(paths);
    setRecentRepoKinds({});

    const recentFirst = recent.value.paths[0] || null;
    const start = recentFirst ? collapseHome(recentFirst) : explorerPath();
    setExplorerPath(start || ".");

    if (recent.value.paths.length > 0) void loadRecentRepoKinds();
  }

  async function loadRecentRepoKinds() {
    const recent = await api.chat.recentPaths(true);
    if (!recent.ok) return;
    const kinds: Record<string, GitBranchesValue["repoKind"]> = {};
    for (const repo of recent.value.repos || [])
      kinds[collapseHome(repo.path)] = repo.repoKind;
    setRecentRepoKinds(kinds);
  }

  onMount(() => {
    void loadRecentPaths();
  });

  function cleanDisplayPath(path: string | null | undefined): string {
    return (path || ".").trim().replace(/\/+$/, "") || ".";
  }

  function sameBranchPath(
    a: string | null | undefined,
    b: string | null | undefined,
  ): boolean {
    return cleanDisplayPath(a) === cleanDisplayPath(b);
  }

  function selectedBranchFromValue(value: GitBranchesValue): string | null {
    return (
      value.selectedBranch ||
      value.currentBranch ||
      value.defaultBranch ||
      value.branches[0]?.ref ||
      null
    );
  }

  function selectedJjRevisionFromValue(value: GitBranchesValue): string | null {
    return (
      value.selectedJjRevision ||
      value.currentJjRevision ||
      value.jjRevisions?.[0]?.rev ||
      "@"
    );
  }

  function repoKindLabel(kind: GitBranchesValue["repoKind"] | undefined): string {
    if (kind === "jj") return "JJ";
    if (kind === "git") return "Git";
    if (kind === null) return "No VCS";
    return "…";
  }

  function recentRepoKind(path: string): GitBranchesValue["repoKind"] | undefined {
    const kinds = recentRepoKinds();
    return Object.prototype.hasOwnProperty.call(kinds, path) ? kinds[path] : undefined;
  }

  function branchStartValue(path = explorerPath()): string | null {
    if (!branchPath() || !sameBranchPath(branchPath(), path)) return null;
    if (repoKind() === "jj") return selectedJjRevision();
    return isGitRepo() ? selectedBranch() : null;
  }

  function applyBranchValue(value: GitBranchesValue, displayPath: string) {
    const collapsed = collapseHome(value.path || displayPath);
    const previousPath = branchPath();
    setBranchPath(collapsed);
    setRepoKind(value.repoKind ?? (value.isRepo ? "git" : null));
    setIsGitRepo((value.repoKind ?? (value.isRepo ? "git" : null)) === "git");
    setIsVersionedRepo(value.isRepo);
    setBranches(value.branches);
    setJjRevisions(value.jjRevisions || []);
    setHasBranchRemote(value.hasRemote);
    setJjAvailable(Boolean(value.jjAvailable));
    setSelectedBranch((prev) => {
      if (
        sameBranchPath(previousPath, collapsed) &&
        prev &&
        value.branches.some((branch) => branch.ref === prev)
      )
        return prev;
      return selectedBranchFromValue(value);
    });
    setSelectedJjRevision((prev) => {
      if (
        sameBranchPath(previousPath, collapsed) &&
        prev &&
        (value.jjRevisions || []).some((revision) => revision.rev === prev)
      )
        return prev;
      return selectedJjRevisionFromValue(value);
    });
    setBranchesMessage(
      value.message || (value.fetched ? "Fetched remote branches" : null),
    );
  }

  let branchLoadSeq = 0;
  async function loadBranches(
    path = explorerPath(),
  ): Promise<GitBranchesValue | null> {
    const displayPath = path || ".";
    const seq = ++branchLoadSeq;
    setBranchesLoading(true);
    setBranchesError(null);
    const r = await api.fs.gitBranches(expandHome(displayPath));
    if (seq !== branchLoadSeq) return r.ok ? r.value : null;
    setBranchesLoading(false);
    if (!r.ok) {
      setBranchPath(displayPath);
      setRepoKind(null);
      setIsGitRepo(false);
      setIsVersionedRepo(false);
      setBranches([]);
      setJjRevisions([]);
      setSelectedBranch(null);
      setSelectedJjRevision(null);
      setHasBranchRemote(false);
      setJjAvailable(false);
      setBranchesError(r.error.message);
      return null;
    }
    applyBranchValue(r.value, displayPath);
    if (!r.value.isRepo)
      setBranchesMessage(
        "No Git or Jujutsu repository detected; the chat will use this directory as-is.",
      );
    return r.value;
  }

  async function pullBranches() {
    if (branchesPulling()) return;
    const path = branchPath() || explorerPath();
    setBranchesPulling(true);
    setBranchesError(null);
    const r = await api.fs.pullBranches(expandHome(path));
    setBranchesPulling(false);
    if (!r.ok) {
      setBranchesError(r.error.message);
      return;
    }
    applyBranchValue(r.value, path);
  }

  async function loadExplorer(path: string) {
    setExplorerBusy(true);
    setExplorerError(null);
    const r = await api.fs.list(expandHome(path));
    setExplorerBusy(false);
    if (!r.ok) {
      setExplorerError(r.error.message);
      return;
    }
    const collapsedPath = collapseHome(r.value.path);
    setExplorerPath(collapsedPath);
    setExplorerParent(
      r.value.parent ? collapseHome(r.value.parent) : r.value.parent,
    );
    setExplorerEntries(r.value.entries);
    setRecentPaths(r.value.recent.map((p) => collapseHome(p)));
  }

  async function createChatAtPath(path: string, branch: string | null = null) {
    if (creatingProjectChat()) return;
    setCreatingProjectChat(true);
    try {
      await bag.createChat(expandHome(path), { branch });
    } finally {
      setCreatingProjectChat(false);
    }
  }

  function resetBranchChoice(path: string) {
    const displayPath = cleanDisplayPath(collapseHome(path));
    setBranchPath(displayPath);
    setRepoKind(null);
    setIsGitRepo(false);
    setIsVersionedRepo(false);
    setBranches([]);
    setJjRevisions([]);
    setSelectedBranch(null);
    setSelectedJjRevision(null);
    setHasBranchRemote(false);
    setJjAvailable(false);
    setBranchesMessage(null);
    setBranchesError(null);
  }

  async function prepareProjectChat(path: string) {
    if (creatingProjectChat() || branchesLoading()) return;
    resetBranchChoice(path);
    const displayPath = cleanDisplayPath(collapseHome(path));
    const loadedBranches = await loadBranches(path);
    if (!loadedBranches) {
      setPendingProjectPath(displayPath);
      return;
    }
    if (!loadedBranches.isRepo) {
      await createChatAtPath(collapseHome(loadedBranches.path || path));
      return;
    }
    setBranchesMessage(null);
    setPendingProjectPath(collapseHome(loadedBranches.path || path));
  }

  async function createChatWithBranch() {
    const path = pendingProjectPath();
    if (!path) return;
    await createChatAtPath(path, branchStartValue(path));
  }

  function backToProjectPicker() {
    setPendingProjectPath(null);
    setBranchesError(null);
    setBranchesMessage(null);
  }

  async function createRepoLessChat() {
    if (creatingRepoLessChat()) return;
    setCreatingRepoLessChat(true);
    try {
      await bag.createChat();
    } finally {
      setCreatingRepoLessChat(false);
    }
  }

  function chooseRecentPath(path: string) {
    setExplorerPath(path);
    void prepareProjectChat(path);
  }

  async function openPathPicker(path = explorerPath()) {
    setExplorerExpanded(true);
    await loadExplorer(path || ".");
  }

  function createChatInExplorer() {
    void prepareProjectChat(explorerPath());
  }

  return (
    <section class="main conversation-main new-chat-main">
      <header class="conv-header">
        <LeftSidebarToggle onToggleSidebar={props.onToggleSidebar} />
        <div class="new-chat-header-title">New chat</div>
      </header>
      <main class="new-chat-route" aria-label="start a new chat">
        <section class="new-chat-panel" aria-label="New chat options">
          <Show when={pendingProjectPath()} fallback={
              <section
                class="fs-explorer fs-explorer-main"
                aria-label="project directory"
              >
                <button
                  type="button"
                  class="fs-pick-toggle fs-scratch-toggle"
                  onClick={createRepoLessChat}
                >
                  <span class="fs-scratch-title">Start without a project</span>
                </button>
                <Show when={recentPaths().length > 0}>
                  <div class="fs-section-title">Recent projects</div>
                  <div
                    class="fs-recent-list"
                    role="list"
                    aria-label="recent directories"
                  >
                    <For each={recentPaths()}>
                      {(path) => (
                        <button
                          type="button"
                          role="listitem"
                          title={path}
                          onClick={() => chooseRecentPath(path)}
                          disabled={creatingProjectChat() || branchesLoading()}
                        >
                          <span class="fs-folder">📁</span>
                          <span class="fs-recent-path">{path}</span>
                          <span
                            classList={{
                              "fs-repo-badge": true,
                              "is-git": recentRepoKind(path) === "git",
                              "is-jj": recentRepoKind(path) === "jj",
                              "is-none": recentRepoKind(path) === null,
                              "is-loading": recentRepoKind(path) === undefined,
                            }}
                          >
                            {repoKindLabel(recentRepoKind(path))}
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={recentPaths().length === 0}>
                  <Show
                    when={recentPathsLoaded()}
                    fallback={
                      <div class="fs-loading-centered">
                        <LoadingDots label="loading recent projects" />
                      </div>
                    }
                  >
                    <div class="fs-empty">
                      No recent projects yet. Enter a path below or browse
                      folders.
                    </div>
                  </Show>
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
                    <button
                      type="button"
                      class="fs-start-action"
                      onClick={createChatInExplorer}
                      disabled={creatingProjectChat() || branchesLoading()}
                    >
                      Start
                    </button>
                  </div>
                  <button
                    type="button"
                    class="fs-pick-toggle fs-browse-toggle"
                    onClick={() => openPathPicker()}
                  >
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
                      <button
                        type="button"
                        onClick={() => openPathPicker()}
                        disabled={explorerBusy()}
                      >
                        Go
                      </button>
                    </div>
                    <Show when={explorerError()}>
                      <div class="fs-error">
                        <PrettyError
                          title="Couldn’t browse folder"
                          message={
                            explorerError() || "Unable to list this folder"
                          }
                        />
                      </div>
                    </Show>
                    <div class="fs-entries" aria-busy={explorerBusy()}>
                      <Show when={explorerParent()}>
                        {(parent) => (
                          <button
                            type="button"
                            class="fs-entry dir"
                            onClick={() => openPathPicker(parent())}
                          >
                            <span>↩</span>
                            <span>..</span>
                          </button>
                        )}
                      </Show>
                      <For each={explorerEntries()}>
                        {(entry) => (
                          <button
                            type="button"
                            class={"fs-entry " + entry.kind}
                            classList={{ changed: entry.changed }}
                            disabled={entry.kind !== "dir"}
                            title={collapseHome(entry.path)}
                            onClick={() =>
                              entry.kind === "dir" && openPathPicker(entry.path)
                            }
                          >
                            <span>
                              {entry.kind === "dir"
                                ? "📁"
                                : entry.kind === "symlink"
                                  ? "↗"
                                  : "·"}
                            </span>
                            <span>{entry.name}</span>
                            <Show when={entry.changed}>
                              <EntryDiffBadge entry={entry} />
                            </Show>
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
              </section>
            }
          >
            <section
              class="fs-branch-step"
              aria-label="choose repository branch"
            >
              <div class="fs-branch-step-topline">
                <button
                  type="button"
                  class="fs-branch-back"
                  onClick={backToProjectPicker}
                  aria-label="Back to project selection"
                  title="Back to project selection"
                >
                  ←
                </button>
                <div class="fs-branch-title-block">
                  <h2 class="fs-branch-project" title={pendingProjectPath() || ""}>{pendingProjectPath()}</h2>
                  <div class="fs-repo-kind">{repoKindLabel(repoKind())}</div>
                </div>
                <button
                  type="button"
                  class="fs-start-action fs-branch-start"
                  onClick={createChatWithBranch}
                  disabled={creatingProjectChat() || branchesPulling()}
                >
                  Start
                </button>
              </div>
              <Show when={repoKind() === "jj"}>
                <div class="fs-branch-card" aria-label="jj start revision">
                  <div class="fs-branch-header">
                    <label for="new-chat-jj-revision">JJ start revision</label>
                  </div>
                  <select
                    id="new-chat-jj-revision"
                    value={selectedJjRevision() || "@"}
                    onChange={(e) =>
                      setSelectedJjRevision(e.currentTarget.value || "@")
                    }
                    disabled={jjRevisions().length === 0}
                    aria-label="jj revision to start from"
                  >
                    <For each={jjRevisions()}>
                      {(revision) => (
                        <option value={revision.rev}>
                          {revision.current ? "● " : ""}
                          {revision.name}
                          {revision.kind === "bookmark"
                            ? " (bookmark)"
                            : revision.kind === "trunk"
                              ? " (trunk)"
                              : ""}
                        </option>
                      )}
                    </For>
                  </select>
                  <div class="fs-branch-hint">
                    Choose the jj change, bookmark, or trunk revision the new
                    workspace should start from.
                  </div>
                  <Show when={branchesError()}>
                    <div class="fs-branch-error">{branchesError()}</div>
                  </Show>
                  <Show when={branchesMessage()}>
                    <div class="fs-branch-message">{branchesMessage()}</div>
                  </Show>
                </div>
              </Show>
              <Show when={isGitRepo()}>
                <div class="fs-branch-card" aria-label="git branch">
                  <div class="fs-branch-header">
                    <label for="new-chat-branch">Git branch</label>
                    <div class="fs-branch-header-actions">
                      <button
                        type="button"
                        class="fs-branch-pull"
                        onClick={pullBranches}
                        disabled={!isGitRepo() || !hasBranchRemote() || branchesLoading() || branchesPulling()}
                        title="Fetch remote branches"
                      >
                        {branchesPulling() ? "Pulling…" : "Pull branches"}
                      </button>
                    </div>
                  </div>
                  <select
                    id="new-chat-branch"
                    value={selectedBranch() || ""}
                    onChange={(e) =>
                      setSelectedBranch(e.currentTarget.value || null)
                    }
                    disabled={branchesPulling() || branches().length === 0}
                    aria-label="git branch to start from"
                  >
                    <For each={branches()}>
                      {(branch) => (
                        <option value={branch.ref}>
                          {branch.current ? "● " : ""}
                          {branch.name}
                          {branch.kind === "remote" ? " (remote)" : ""}
                        </option>
                      )}
                    </For>
                  </select>
                  <Show when={branchesLoading() || !selectedBranch()}>
                    <div class="fs-branch-hint">
                      {branchesLoading()
                        ? "Loading branches in the background. You can start now using the current checkout."
                        : "Choose a branch to start from, or start using this directory as-is."}
                    </div>
                  </Show>
                  <Show when={branchesError()}>
                    <div class="fs-branch-error">{branchesError()}</div>
                  </Show>
                  <Show when={branchesMessage()}>
                    <div class="fs-branch-message">{branchesMessage()}</div>
                  </Show>
                </div>
              </Show>
            </section>
          </Show>
        </section>
      </main>
    </section>
  );
}

function RepoFileDiffPreview(props: {
  file: OpenRepoFile;
  diff: FileDiffItem;
  assetRootPath?: string | null;
  expansion?: DiffExpansionStore;
  onOpenFile?: (path: string) => void;
  onOpenStore?: (hash: string) => void;
  scopeLabel?: "Individual change" | "Chat changeset";
  expansionKeyPrefix?: string;
  viewState?: DiffViewState;
  setMode?: (mode: DiffContentMode) => void;
  setScrollTop?: (scrollTop: number, mode: DiffContentMode) => void;
}) {
  const previewPath = () => props.file.path || props.file.requestedPath;
  const relativePreviewPath = () =>
    browserRelativePath(props.assetRootPath ?? null, previewPath());
  const diffPath = () => props.diff.path || relativePreviewPath();
  const displayPath = () =>
    displayFilePath(previewPath(), props.assetRootPath ?? null);
  const recordedAfterContent = () =>
    typeof props.diff.after === "string" ? props.diff.after : null;
  const latestContent = () =>
    props.file.kind === "file" ? props.file.content || "" : "";
  const [localMode, setLocalMode] = createSignal<DiffContentMode>("diff");
  const mode = () => props.viewState?.mode ?? localMode();
  const setMode = (nextMode: DiffContentMode) => {
    props.setMode?.(nextMode);
    if (!props.viewState) setLocalMode(nextMode);
  };
  const scrollTop = () => props.viewState?.scrollTopByMode[mode()] ?? 0;
  const sizeBytes = () =>
    props.file.loading && props.file.size === 0
      ? (cachedFileSizeBytes(previewPath(), props.assetRootPath) ??
        cachedFileSizeBytes(relativePreviewPath(), props.assetRootPath))
      : props.file.size;
  const visibleLoading = () =>
    repoFileNeedsVisibleLoading(props.file, props.assetRootPath);

  createEffect(
    on(
      () => props.diff.id + "\n" + previewPath(),
      () => {
        if (!props.viewState) setMode("diff");
      },
    ),
  );

  return (
    <FileDiffPanel
      scopeLabel={props.scopeLabel ?? "Chat changeset"}
      displayPath={displayPath()}
      path={diffPath()}
      sourcePath={previewPath()}
      diff={props.diff.diff}
      snapshot={recordedAfterContent() ?? latestContent()}
      sourceContent={latestContent()}
      mode={mode}
      setMode={setMode}
      assetRootPath={props.assetRootPath}
      onOpenFile={props.onOpenFile}
      onOpenStore={props.onOpenStore}
      expansion={props.expansion}
      expansionKeyPrefix={
        props.expansionKeyPrefix ??
        `browser:${normalizedBrowserDiffPath(diffPath())}`
      }
      sizeBytes={sizeBytes()}
      stats={props.diff.stats}
      loading={visibleLoading()}
      error={props.file.error}
      scrollTop={scrollTop()}
      onScrollTopChange={props.setScrollTop}
    />
  );
}

function FileDiffPanel(props: {
  displayPath: string;
  path: string;
  diff: string;
  scopeLabel: "Individual change" | "Chat changeset";
  showScopeLabel?: boolean;
  mode: () => DiffContentMode;
  setMode: (mode: DiffContentMode) => void;
  sourcePath?: string;
  snapshot?: string | null;
  sourceContent?: string | null;
  assetRootPath?: string | null;
  expansion?: DiffExpansionStore;
  expansionKeyPrefix?: string;
  onOpenFile?: (path: string) => void;
  onOpenStore?: (hash: string) => void;
  sizeBytes?: number | null;
  stats?: { added: number; removed: number } | null;
  loading?: boolean;
  error?: string | null;
  class?: string;
  ref?: HTMLElement | ((el: HTMLElement) => void);
  tabIndex?: number;
  scrollTop?: number | null;
  onScrollTopChange?: (scrollTop: number, mode: DiffContentMode) => void;
}) {
  const sourcePath = () => props.sourcePath || props.path;
  const previewKind = () => previewKindForPath(sourcePath());
  const sourceContent = () => props.sourceContent ?? props.snapshot ?? "";
  const hasSnapshot = () =>
    typeof props.sourceContent === "string" ||
    typeof props.snapshot === "string";
  const hasPreview = () => Boolean(previewKind() && hasSnapshot());
  const renderedSource = createMemo(() =>
    highlightByPath(sourceContent(), sourcePath()),
  );
  let scrollEl: HTMLElement | undefined;
  const setScrollEl = (el: HTMLElement) => {
    scrollEl = el;
    restoreScrollTop();
  };
  const restoreScrollTop = () => {
    const top = props.scrollTop;
    if (typeof top !== "number") return;
    requestAnimationFrame(() => {
      if (scrollEl) scrollEl.scrollTop = top;
    });
  };
  const handleScroll = (event: Event) => {
    props.onScrollTopChange?.(
      (event.currentTarget as HTMLElement).scrollTop,
      props.mode(),
    );
  };
  createEffect(() => {
    props.path;
    props.diff;
    props.snapshot;
    props.sourceContent;
    props.mode();
    props.scrollTop;
    restoreScrollTop();
  });
  const stats = createMemo(() => props.stats ?? diffStats(props.diff || ""));
  const hasStats = () =>
    Boolean(props.stats) || stats().added > 0 || stats().removed > 0;
  const hasSize = () =>
    typeof props.sizeBytes === "number" && props.sizeBytes >= 0;
  const sizeLabel = createMemo(() =>
    hasSize() ? formatBytes(props.sizeBytes ?? 0) : "000.0 KiB",
  );
  createEffect(() => {
    if (props.loading) return;
    if (props.mode() === "preview" && !hasPreview()) props.setMode("diff");
    if (props.mode() === "source" && !hasSnapshot()) props.setMode("diff");
  });
  const renderedSnapshot = () => (
    <Show
      when={props.mode() === "preview" && hasPreview()}
      fallback={
        <pre
          ref={setScrollEl}
          class="repo-file-content repo-file-source right-diff-snapshot-source"
          innerHTML={renderedSource()}
          onScroll={handleScroll}
        />
      }
    >
      <RenderedFilePreview
        kind={previewKind()!}
        content={sourceContent()}
        path={sourcePath()}
        assetRootPath={props.assetRootPath ?? null}
        onOpenFile={props.onOpenFile}
        ref={setScrollEl}
        onScroll={handleScroll}
      />
    </Show>
  );

  return (
    <section
      ref={props.ref}
      class={`repo-file-preview right-diff-detail${props.class ? ` ${props.class}` : ""}`}
      aria-label={`${props.scopeLabel} for ${props.displayPath}`}
      tabIndex={props.tabIndex}
    >
      <header class="repo-file-header right-diff-header">
        <div class="right-diff-title-row">
          <strong title={props.displayPath}><span class="path-ellipsis-text">{props.displayPath}</span></strong>
          <Show when={props.showScopeLabel ?? true}>
            <span class="right-diff-scope-label">{props.scopeLabel}</span>
          </Show>
        </div>
      </header>
      <Show when={props.error}>
        <div class="repo-file-error">
          <PrettyError message={props.error || "Unable to read this diff"} />
        </div>
      </Show>
      <div class="repo-file-meta right-diff-meta repo-file-toolbar">
        <div class="right-diff-meta-items">
          <span
            classList={{
              "right-diff-size": true,
              "right-diff-size-placeholder": !hasSize(),
            }}
            aria-hidden={!hasSize() ? "true" : undefined}
          >
            {sizeLabel()}
          </span>
          <Show when={hasStats()}>
            <ChangeStatsBadge
              stats={stats}
              label={() =>
                `${stats().added} additions, ${stats().removed} deletions`
              }
              title={() =>
                `${stats().added} additions, ${stats().removed} deletions`
              }
              class="right-diff-total-badge"
            />
          </Show>
          <RepoFileLoadingDots loading={props.loading} label="loading diff" />
        </div>
        <DiffPreviewModeControl
          mode={props.mode}
          setMode={props.setMode}
          previewKind={previewKind}
          hasPreview={hasPreview}
          hasSnapshot={hasSnapshot}
        />
      </div>
      <Show when={props.mode() === "diff"} fallback={renderedSnapshot()}>
        <div
          ref={setScrollEl}
          class="file-diff-body right-diff-body"
          role="log"
          aria-label={`${props.scopeLabel} for ${props.displayPath}`}
          onScroll={handleScroll}
        >
          <DiffView
            diff={props.diff}
            snapshot={props.snapshot}
            path={props.path}
            onOpenStore={props.onOpenStore}
            expansion={props.expansion}
            expansionKeyPrefix={props.expansionKeyPrefix}
          />
        </div>
      </Show>
    </section>
  );
}

export { RightSidebarToggle } from "./HeaderControls";

export function RepoFilePreview(props: {
  file: OpenRepoFile;
  onOpenFile?: (path: string) => void;
  assetRootPath?: string | null;
  timelineDiff?: FileDiffItem | null;
  diffStats?: BrowserDiffStatsMap;
  expansion?: DiffExpansionStore;
  onOpenStore?: (hash: string) => void;
  syntaxHighlightMaxBytes?: number;
  diffViewState?: (key: string) => DiffViewState;
  setDiffViewMode?: (key: string, mode: DiffContentMode) => void;
  setDiffViewScrollTop?: (
    key: string,
    scrollTop: number,
    mode: DiffContentMode,
  ) => void;
}) {
  const previewPath = () => props.file.path || props.file.requestedPath;
  const previewKind = () => previewKindForPath(previewPath());
  const isDirectory = () => props.file.kind === "dir";
  const isDiffFile = () =>
    looksLikeDiffFile(previewPath(), props.file.content || "");
  const relativePreviewPath = () =>
    browserRelativePath(props.assetRootPath ?? null, previewPath());
  const previewDiffStats = () =>
    props.diffStats?.get(relativePreviewPath()) ?? null;
  const previewFile = () =>
    entryWithBrowserDiffStats(props.file, previewDiffStats());
  createEffect(() => {
    if (props.file.kind !== "file") return;
    rememberFileSizeBytes(previewPath(), props.assetRootPath, props.file.size);
    rememberFileSizeBytes(
      relativePreviewPath(),
      props.assetRootPath,
      props.file.size,
    );
  });
  const [mode, setMode] = createSignal<FileContentMode>(
    isDiffFile() ? "diff" : previewKind() ? "preview" : "source",
  );
  const renderedSource = createMemo(() =>
    highlightByPath(
      props.file.content || "",
      previewPath(),
      props.syntaxHighlightMaxBytes ?? DEFAULT_HIGHLIGHT_MAX_BYTES,
    ),
  );
  const directoryEntries = createMemo(() =>
    directoryEntriesWithParent(
      previewPath(),
      props.file.entries,
      props.assetRootPath ?? null,
    ).map((entry) =>
      entryWithBrowserDiffStats(
        entry,
        props.diffStats?.get(
          browserRelativePath(props.assetRootPath ?? null, entry.path),
        ),
      ),
    ),
  );
  const diffFileStats = createMemo(() => diffStats(props.file.content || ""));
  const readyTimelineDiff = (item: FileDiffItem | null | undefined) =>
    item && !expandedFileDiffNeedsHydration(item) ? item : null;
  const [hydratedTimelineDiff, setHydratedTimelineDiff] =
    createSignal<FileDiffItem | null>(readyTimelineDiff(props.timelineDiff));
  let hydrateTimelineDiffRequest = 0;
  createEffect(
    on(
      () =>
        props.timelineDiff
          ? expandedFileDiffHydrationKey(props.timelineDiff)
          : "",
      async () => {
        const request = ++hydrateTimelineDiffRequest;
        const current = props.timelineDiff ?? null;
        if (!current) {
          setHydratedTimelineDiff(null);
          return;
        }
        if (!expandedFileDiffNeedsHydration(current)) {
          setHydratedTimelineDiff(current);
          return;
        }
        setHydratedTimelineDiff(null);
        const next = await hydrateMergedFileDiff(current);
        if (request === hydrateTimelineDiffRequest)
          setHydratedTimelineDiff(next);
      },
    ),
  );
  const timelineDiffHydrating = () =>
    Boolean(
      props.timelineDiff &&
      expandedFileDiffNeedsHydration(props.timelineDiff) &&
      !hydratedTimelineDiff(),
    );
  const currentFileDiff = createMemo(() => {
    if (timelineDiffHydrating()) return null;
    const currentDiff = openRepoFileCurrentDiff(
      props.file,
      props.assetRootPath ?? null,
      "repo-file-current",
    );
    return preferredOpenRepoFileDiff(
      props.file,
      props.assetRootPath ?? null,
      hydratedTimelineDiff(),
      currentDiff,
    );
  });
  const visibleLoading = () =>
    repoFileNeedsVisibleLoading(props.file, props.assetRootPath);
  createEffect(
    on(
      () => previewPath() + "\n" + (isDiffFile() ? "diff" : "plain"),
      () =>
        setMode(isDiffFile() ? "diff" : previewKind() ? "preview" : "source"),
    ),
  );

  const plainFile = () => (
    <section class="repo-file-preview" aria-label="opened repository file">
      <header class="repo-file-header">
        <div>
          <strong
            title={displayFilePath(previewPath(), props.assetRootPath ?? null)}
          >
            {displayFilePath(previewPath(), props.assetRootPath ?? null)}
          </strong>
        </div>
      </header>
      <Show when={visibleLoading() && !previewPath()}>
        <div class="repo-file-status">Loading…</div>
      </Show>
      <Show when={props.file.error}>
        <div class="repo-file-error">
          <PrettyError
            message={props.file.error || "Unable to read this file"}
          />
        </div>
      </Show>
      <Show when={!props.file.error || previewPath()}>
        <div class="repo-file-meta repo-file-toolbar">
          <div class="repo-file-meta-items">
            <span class="repo-file-meta-primary">
              {isDirectory()
                ? `${props.file.entries?.length ?? 0} entries`
                : formatBytes(props.file.size)}
            </span>
            <Show when={previewFile().changed}>
              <RepoFileDiffBadge entry={previewFile()} />
            </Show>
            <RepoFileLoadingDots loading={visibleLoading()} />
          </div>
          <Show when={!isDirectory() && previewKind()}>
            <FilePreviewModeControl
              mode={mode}
              setMode={setMode}
              previewKind={previewKind}
              hasDiff={isDiffFile}
            />
          </Show>
        </div>
        <Show
          when={isDirectory()}
          fallback={
            <Show
              when={previewKind() && mode() === "preview"}
              fallback={
                <pre
                  class="repo-file-content repo-file-source"
                  innerHTML={renderedSource()}
                />
              }
            >
              <RenderedFilePreview
                kind={previewKind()!}
                content={props.file.content || ""}
                path={previewPath()}
                assetRootPath={props.assetRootPath ?? null}
                onOpenFile={props.onOpenFile}
              />
            </Show>
          }
        >
          <div
            class="repo-file-content repo-directory-list"
            role="list"
            aria-label="directory entries"
          >
            <For each={directoryEntries()}>
              {(entry) => (
                <button
                  type="button"
                  class={"fs-entry " + entry.kind}
                  classList={{ changed: entry.changed }}
                  role="listitem"
                  onClick={() => props.onOpenFile?.(entry.path)}
                >
                  <span aria-hidden="true">
                    {entry.name === ".."
                      ? "↩"
                      : entry.kind === "dir"
                        ? "📁"
                        : "📄"}
                  </span>
                  <span title={entry.path}>{entry.name}</span>
                  <Show when={entry.changed}>
                    <EntryDiffBadge entry={entry} />
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </section>
  );

  const diffFile = () => (
    <FileDiffPanel
      displayPath={displayFilePath(previewPath(), props.assetRootPath ?? null)}
      path={previewPath()}
      sourcePath={previewPath()}
      diff={props.file.content || ""}
      snapshot={props.file.content || ""}
      sourceContent={props.file.content || ""}
      scopeLabel="Chat changeset"
      showScopeLabel={false}
      mode={mode}
      setMode={setMode}
      assetRootPath={props.assetRootPath}
      onOpenFile={props.onOpenFile}
      expansion={props.expansion}
      expansionKeyPrefix={`browser-file:${normalizedBrowserDiffPath(relativePreviewPath())}`}
      sizeBytes={
        props.file.loading && props.file.size === 0
          ? cachedFileSizeBytes(previewPath(), props.assetRootPath)
          : props.file.size
      }
      stats={diffFileStats()}
      loading={visibleLoading()}
      error={props.file.error}
    />
  );

  const currentDiffViewKey = (diff: FileDiffItem) =>
    normalizedBrowserDiffPath(
      diff.path || props.file.path || props.file.requestedPath,
    );

  const currentDiffFile = (diff: FileDiffItem) => {
    const viewKey = currentDiffViewKey(diff);
    return (
      <RepoFileDiffPreview
        file={props.file}
        diff={diff}
        assetRootPath={props.assetRootPath}
        expansion={props.expansion}
        expansionKeyPrefix={`repo-file:${normalizedBrowserDiffPath(diff.path)}`}
        onOpenFile={props.onOpenFile}
        onOpenStore={props.onOpenStore}
        viewState={props.diffViewState?.(viewKey)}
        setMode={(mode) => props.setDiffViewMode?.(viewKey, mode)}
        setScrollTop={(scrollTop, mode) =>
          props.setDiffViewScrollTop?.(viewKey, scrollTop, mode)
        }
      />
    );
  };

  return (
    <Show
      when={currentFileDiff()}
      fallback={
        <Show when={isDiffFile()} fallback={plainFile()}>
          {diffFile()}
        </Show>
      }
    >
      {(diff) => currentDiffFile(diff())}
    </Show>
  );
}

export function RightSidebar(props: { bag: Bag }) {
  const activeTab = () => props.bag.activeRightSidebarTab();
  const detailPanelMode = () => props.bag.view() === "traces";
  const openFileDiffs = createMemo(() =>
    mergedFileDiffs(trailSourceItems(props.bag)),
  );
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
    createEffect(
      on(
        () =>
          props.bag
            .rightSidebarTabs()
            .map((tab) => tab.id + ":" + tab.title)
            .join("|"),
        measure,
        { defer: true },
      ),
    );
    measure();
    onCleanup(() => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    });
  };
  const installRightResizer = (handle: HTMLDivElement) => {
    let dragging = false;
    let startX = 0;
    let startW = 0;
    let viewportW = 0;
    const onMove = (e: MouseEvent) => {
      if (!dragging || viewportW <= 0) return;
      props.bag.setRightSidebarW(
        ((startW + (startX - e.clientX)) / viewportW) * 100,
      );
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const sidebarEl = handle.closest(".right-sidebar") as HTMLElement | null;
      const rect = sidebarEl?.getBoundingClientRect();
      dragging = true;
      startX = e.clientX;
      startW = rect?.width ?? 0;
      viewportW =
        document.documentElement?.clientWidth || window.innerWidth || 0;
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
      <div
        class="right-sidebar-resizer"
        ref={(e) => installRightResizer(e)}
        title="drag to resize, double-click to collapse"
      />
      <div class="right-sidebar-actions">
        <button
          type="button"
          class="header-icon-button right-sidebar-size-toggle"
          classList={{ maximized: props.bag.rightSidebarMaximized() }}
          title={
            props.bag.rightSidebarMaximized()
              ? "reduce right pane"
              : "maximize right pane"
          }
          aria-label={
            props.bag.rightSidebarMaximized()
              ? "reduce right pane"
              : "maximize right pane"
          }
          aria-pressed={props.bag.rightSidebarMaximized()}
          onClick={() => props.bag.toggleRightSidebarMaximized()}
        >
          {props.bag.rightSidebarMaximized() ? <RestoreIcon /> : <MaximizeIcon />}
        </button>
      </div>
      <Show when={!detailPanelMode()}>
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
                classList={{
                  active: props.bag.activeRightSidebarTabId() === tab.id,
                  closable:
                    tab.id !== "trail" &&
                    tab.id !== "diffs" &&
                    tab.id !== "browser",
                }}
                aria-selected={props.bag.activeRightSidebarTabId() === tab.id}
                title={tabTitle(tab, props.bag.currentChatWorktreePath())}
                onClick={() => props.bag.setActiveRightSidebarTab(tab.id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    props.bag.setActiveRightSidebarTab(tab.id);
                  }
                }}
              >
                <span class="right-tab-kind">
                  {tab.kind === "trail"
                    ? "≡"
                    : tab.kind === "diffs"
                      ? "Σ"
                      : tab.kind === "browser"
                        ? "▤"
                        : tab.kind === "diff"
                          ? "Δ"
                          : tab.kind === "store"
                            ? "◈"
                            : tab.kind === "json"
                              ? "{}"
                              : tab.kind === "trace"
                                ? "⌁"
                                : tab.kind === "app" || tab.kind === "app-code"
                                  ? tab.icon || "▣"
                                  : "□"}
                </span>
                <span class="right-tab-title">
                  {tabTitle(tab, props.bag.currentChatWorktreePath())}
                </span>
                <Show
                  when={
                    tab.id !== "trail" &&
                    tab.id !== "diffs" &&
                    tab.id !== "browser"
                  }
                >
                  <button
                    type="button"
                    class="right-tab-close"
                    title="close tab"
                    aria-label={`close ${tabTitle(tab, props.bag.currentChatWorktreePath())}`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      void props.bag.closeRightSidebarTab(tab.id);
                    }}
                  >
                    ×
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={detailPanelMode()}>
        <TraceDetailHeader bag={props.bag} tab={activeTab()} />
      </Show>
      <div
        class="right-tab-panel"
        role={detailPanelMode() ? "region" : "tabpanel"}
      >
        <Show when={activeTab()} fallback={<TrailsTab bag={props.bag} />}>
          {(tab) => (
            <Switch fallback={<TrailsTab bag={props.bag} />}>
              <Match when={tab().kind === "file"}>
                <RepoFilePreview
                  file={
                    (tab() as Extract<RightSidebarTab, { kind: "file" }>).file
                  }
                  assetRootPath={props.bag.currentChatWorktreePath()}
                  timelineDiff={openRepoFileTimelineDiff(
                    (tab() as Extract<RightSidebarTab, { kind: "file" }>).file,
                    props.bag.currentChatWorktreePath(),
                    openFileDiffs(),
                  )}
                  onOpenFile={(path) => void props.bag.openFileInSidebar(path)}
                  onOpenStore={(hash) =>
                    void props.bag.openStorePreviewInSidebar(hash)
                  }
                  expansion={props.bag.expansionStore()}
                  syntaxHighlightMaxBytes={
                    props.bag.settingsCache()?.ui?.syntaxHighlightMaxBytes
                  }
                  diffViewState={props.bag.expandedDiffViewState}
                  setDiffViewMode={props.bag.setExpandedDiffViewMode}
                  setDiffViewScrollTop={props.bag.setExpandedDiffViewScrollTop}
                />
              </Match>
              <Match when={tab().kind === "store"}>
                <StorePreviewTab
                  store={
                    (tab() as Extract<RightSidebarTab, { kind: "store" }>).store
                  }
                  onClose={() => void props.bag.closeRightSidebarTab(tab().id)}
                  onOpenStore={(hash) =>
                    void props.bag.openStorePreviewInSidebar(hash)
                  }
                />
              </Match>
              <Match when={tab().kind === "json"}>
                <JsonPreviewTab
                  json={
                    (tab() as Extract<RightSidebarTab, { kind: "json" }>).json
                  }
                  onClose={() => void props.bag.closeRightSidebarTab(tab().id)}
                  onOpenStore={(hash) =>
                    void props.bag.openStorePreviewInSidebar(hash)
                  }
                />
              </Match>
              <Match when={tab().kind === "diff"}>
                <DiffDetailTab
                  bag={props.bag}
                  tab={tab() as Extract<RightSidebarTab, { kind: "diff" }>}
                />
              </Match>
              <Match when={tab().kind === "memory-diff"}>
                <MemoryDiffDetailTab
                  bag={props.bag}
                  tab={
                    tab() as Extract<RightSidebarTab, { kind: "memory-diff" }>
                  }
                />
              </Match>
              <Match when={tab().kind === "trace"}>
                <TraceSidebarTab
                  bag={props.bag}
                  tab={tab() as Extract<RightSidebarTab, { kind: "trace" }>}
                />
              </Match>
              <Match when={tab().kind === "app"}>
                <UiPanel bag={props.bag} embedded />
              </Match>
              <Match when={tab().kind === "app-code"}>
                <AppCodeExplorer
                  bag={props.bag}
                  uiId={
                    (tab() as Extract<RightSidebarTab, { kind: "app-code" }>)
                      .uiId
                  }
                />
              </Match>
              <Match when={tab().kind === "browser"}>
                <BrowserTab
                  bag={props.bag}
                  tab={tab() as Extract<RightSidebarTab, { kind: "browser" }>}
                />
              </Match>
              <Match when={tab().kind === "diffs"}>
                <TotalDiffTab bag={props.bag} />
              </Match>
            </Switch>
          )}
        </Show>
      </div>
    </aside>
  );
}

const browserFileCache = new Map<string, OpenRepoFile>();

function BrowserTab(props: {
  bag: Bag;
  tab: Extract<RightSidebarTab, { kind: "browser" }>;
}) {
  const rootPath = createMemo(() => props.bag.currentChatWorktreePath());
  const nav = createMemo(
    () => props.tab.nav ?? { path: null, history: [], index: 0 },
  );
  const requestedPath = createMemo(() => nav().path);
  const canGoBack = () => nav().index > 0;
  const canGoForward = () => nav().index < nav().history.length - 1;
  const setNav = (next: BrowserNavState) => props.bag.setBrowserTabNav(next);
  const cacheKey = (path: string | null | undefined) =>
    (rootPath() || "") + "\n" + String(path || "").trim();
  const initialPath = requestedPath();
  const initialCachedFile = initialPath
    ? browserFileCache.get(cacheKey(initialPath))
    : null;
  const [file, setFile] = createSignal<OpenRepoFile>(
    initialCachedFile
      ? { ...initialCachedFile, loading: true, error: null }
      : {
          requestedPath: "",
          path: null,
          content: "",
          size: 0,
          mtime: 0,
          kind: "dir",
          entries: [],
          loading: true,
          error: null,
        },
  );
  let readSeq = 0;

  const browserDiffs = createMemo(() =>
    mergedFileDiffs(trailSourceItems(props.bag)),
  );
  const timelineDiffStats = createMemo(() => {
    const stats: BrowserDiffStatsMap = new Map();
    for (const diff of browserDiffs()) {
      addBrowserDiffStats(
        stats,
        diff.path,
        diff.stats?.added ?? 0,
        diff.stats?.removed ?? 0,
      );
    }
    return stats;
  });

  const browserTimelineDiff = createMemo(() =>
    openRepoFileTimelineDiff(file(), rootPath(), browserDiffs()),
  );
  const readyBrowserTimelineDiff = (item: FileDiffItem | null | undefined) =>
    item && !expandedFileDiffNeedsHydration(item) ? item : null;
  const [hydratedBrowserTimelineDiff, setHydratedBrowserTimelineDiff] =
    createSignal<FileDiffItem | null>(
      readyBrowserTimelineDiff(browserTimelineDiff()),
    );
  let hydrateBrowserTimelineDiffRequest = 0;
  createEffect(
    on(
      () =>
        browserTimelineDiff()
          ? expandedFileDiffHydrationKey(browserTimelineDiff()!)
          : "",
      async () => {
        const request = ++hydrateBrowserTimelineDiffRequest;
        const current = browserTimelineDiff();
        if (!current) {
          setHydratedBrowserTimelineDiff(null);
          return;
        }
        if (!expandedFileDiffNeedsHydration(current)) {
          setHydratedBrowserTimelineDiff(current);
          return;
        }
        setHydratedBrowserTimelineDiff(null);
        const next = await hydrateMergedFileDiff(current);
        if (request === hydrateBrowserTimelineDiffRequest)
          setHydratedBrowserTimelineDiff(next);
      },
    ),
  );
  const browserTimelineDiffHydrating = () =>
    Boolean(
      browserTimelineDiff() &&
      expandedFileDiffNeedsHydration(browserTimelineDiff()!) &&
      !hydratedBrowserTimelineDiff(),
    );
  const browserFileDiff = createMemo(() => {
    if (browserTimelineDiffHydrating()) return null;
    const current = file();
    const currentDiff = openRepoFileCurrentDiff(
      current,
      rootPath(),
      "browser-current",
    );
    return preferredOpenRepoFileDiff(
      current,
      rootPath(),
      hydratedBrowserTimelineDiff(),
      currentDiff,
    );
  });

  const openPath = (path: string | null | undefined, replace = false) => {
    const next = String(path || "").trim();
    if (!next) return;
    const current = nav();
    if (current.path === next) return;
    if (replace) {
      const history = current.history.length ? [...current.history] : [next];
      const index = Math.max(0, Math.min(history.length - 1, current.index));
      history[index] = next;
      setNav({ path: next, history, index });
      return;
    }
    const before = current.history.slice(0, Math.max(0, current.index) + 1);
    const history = [...before, next].slice(-80);
    setNav({ path: next, history, index: history.length - 1 });
  };

  const moveHistory = (delta: number) => {
    const current = nav();
    const index = Math.max(
      0,
      Math.min(current.history.length - 1, current.index + delta),
    );
    const path = current.history[index];
    if (path) setNav({ ...current, path, index });
  };

  const currentResolvedPath = () =>
    file().path || requestedPath() || rootPath() || "";
  const parentPath = () => parentDirectoryPath(currentResolvedPath());
  const canGoUp = () => {
    const current =
      normalizePathSegments(currentResolvedPath()).replace(/\/+$/, "") || "/";
    const parent =
      normalizePathSegments(parentPath()).replace(/\/+$/, "") || "/";
    return parent !== current;
  };

  createEffect(
    on(
      rootPath,
      (root) => {
        const next = String(root || "").trim();
        if (next && !nav().path) openPath(next, true);
      },
      { defer: false },
    ),
  );

  createEffect(() => {
    const path = requestedPath();
    const seq = ++readSeq;
    if (!path) {
      setFile({
        requestedPath: "",
        path: null,
        content: "",
        size: 0,
        mtime: 0,
        kind: "dir",
        entries: [],
        loading: false,
        error: "No project directory for this chat",
      });
      return;
    }
    const cached = browserFileCache.get(cacheKey(path));
    setFile((prev) => {
      if (cached) return { ...cached, loading: true, error: null };
      const hasContent = Boolean(prev.path || prev.content || prev.entries);
      return {
        ...prev,
        requestedPath: path,
        path: hasContent ? prev.path : null,
        loading: true,
        error: null,
      };
    });
    const root = rootPath();
    const revision = fileSizeRevisionForPath(path, trailSourceItems(props.bag));
    void api.fs.read(path, root, true).then((r) => {
      if (seq !== readSeq) return;
      if (!r.ok) {
        setFile((prev) => ({
          ...prev,
          requestedPath: path,
          content: prev.content,
          size: prev.size,
          mtime: prev.mtime,
          kind: prev.kind || "dir",
          entries: prev.entries,
          loading: false,
          error: r.error.message,
        }));
        return;
      }
      const nextFile = {
        requestedPath: path,
        path: r.value.path,
        content: r.value.content,
        size: r.value.size,
        mtime: r.value.mtime,
        kind: r.value.kind,
        entries: r.value.entries,
        changed: r.value.changed,
        additions: r.value.additions,
        deletions: r.value.deletions,
        diff: r.value.diff,
        diffStats: r.value.diffStats,
        loading: false,
        error: null,
      };
      browserFileCache.set(cacheKey(path), nextFile);
      rememberFileSizeBytes(path, root, r.value.size, revision);
      rememberFileSizeBytes(r.value.path, root, r.value.size, revision);
      setOpenRepoFileIfChanged(setFile, nextFile);
    });
  });

  return (
    <section class="browser-tab">
      <div class="browser-nav" aria-label="browser navigation">
        <button
          type="button"
          onClick={() => moveHistory(-1)}
          disabled={!canGoBack()}
          title="back"
          aria-label="back"
        >
          ←
        </button>
        <button
          type="button"
          onClick={() => moveHistory(1)}
          disabled={!canGoForward()}
          title="forward"
          aria-label="forward"
        >
          →
        </button>
        <button
          type="button"
          onClick={() => openPath(parentPath())}
          disabled={!canGoUp()}
          title="parent directory"
          aria-label="parent directory"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => openPath(rootPath(), true)}
          disabled={!rootPath()}
          title="scratch root"
          aria-label="scratch root"
        >
          ⌂
        </button>
        <span title={displayFilePath(requestedPath() || "", rootPath())}>
          {displayFilePath(requestedPath() || "", rootPath())}
        </span>
      </div>
      <Show
        when={browserFileDiff()}
        fallback={
          <RepoFilePreview
            file={file()}
            assetRootPath={rootPath()}
            onOpenFile={openPath}
            onOpenStore={(hash) =>
              void props.bag.openStorePreviewInSidebar(hash)
            }
            expansion={props.bag.expansionStore()}
            diffStats={timelineDiffStats()}
            syntaxHighlightMaxBytes={
              props.bag.settingsCache()?.ui?.syntaxHighlightMaxBytes
            }
            diffViewState={props.bag.expandedDiffViewState}
            setDiffViewMode={props.bag.setExpandedDiffViewMode}
            setDiffViewScrollTop={props.bag.setExpandedDiffViewScrollTop}
          />
        }
      >
        {(diff) => (
          <RepoFileDiffPreview
            file={file()}
            diff={diff()}
            assetRootPath={rootPath()}
            expansion={props.bag.expansionStore()}
            onOpenFile={openPath}
            onOpenStore={(hash) =>
              void props.bag.openStorePreviewInSidebar(hash)
            }
            viewState={props.bag.expandedDiffViewState(
              normalizedBrowserDiffPath(
                diff().path || file().path || file().requestedPath,
              ),
            )}
            setMode={(mode) =>
              props.bag.setExpandedDiffViewMode(
                normalizedBrowserDiffPath(
                  diff().path || file().path || file().requestedPath,
                ),
                mode,
              )
            }
            setScrollTop={(scrollTop, mode) =>
              props.bag.setExpandedDiffViewScrollTop(
                normalizedBrowserDiffPath(
                  diff().path || file().path || file().requestedPath,
                ),
                scrollTop,
                mode,
              )
            }
          />
        )}
      </Show>
    </section>
  );
}

function TraceSidebarTab(props: {
  bag: Bag;
  tab: Extract<RightSidebarTab, { kind: "trace" }>;
}) {
  return (
    <section class="trace-sidebar-detail">
      <TraceEventDetails
        event={props.tab.trace}
        onOpenStore={(hash) => void props.bag.openStorePreviewInSidebar(hash)}
      />
    </section>
  );
}

function TraceDetailHeader(props: { bag: Bag; tab: RightSidebarTab | null }) {
  const title = () =>
    props.tab
      ? tabTitle(props.tab, props.bag.currentChatWorktreePath())
      : "Trace details";
  const icon = () =>
    props.tab?.kind === "store"
      ? "◈"
      : props.tab?.kind === "json"
        ? "{}"
        : props.tab?.kind === "trace"
          ? "⌁"
          : props.tab?.kind === "browser"
            ? "▤"
            : "□";
  return (
    <header class="trace-sidebar-header">
      <div class="trace-sidebar-title" title={title()}>
        <span class="trace-sidebar-kind" aria-hidden="true">
          {icon()}
        </span>
        <span>{title()}</span>
      </div>
      <Show when={props.tab}>
        {(tab) => (
          <button
            type="button"
            class="trace-sidebar-close"
            title="close details"
            aria-label={`close ${title()}`}
            onClick={() => void props.bag.closeRightSidebarTab(tab().id)}
          >
            ×
          </button>
        )}
      </Show>
    </header>
  );
}

function JsonPreviewTab(props: {
  json: JsonPreviewFile;
  onClose: () => void;
  onOpenStore?: (hash: string) => void;
}) {
  const html = createMemo(() => {
    if (props.json.autoHighlight || props.json.error)
      return highlightAuto(props.json.raw || props.json.target);
    try {
      return highlightHjsonValue(props.json.value, { linkStoreHashes: true });
    } catch {
      return highlightAuto(props.json.raw || props.json.target);
    }
  });
  const onStoreHashClick = (ev: MouseEvent) =>
    handleStoreHashClick(ev, props.onOpenStore);
  const size = () => props.json.raw.length;
  const label = () => props.json.label || "json pointer";
  const displayTarget = () => props.json.displayTarget || props.json.target;
  const downloadName = () => props.json.downloadName || "pointer.json";
  const downloadMime = () => props.json.downloadMime || "application/json";
  const downloadHref = () =>
    "data:" +
    downloadMime() +
    ";charset=utf-8," +
    encodeURIComponent(props.json.raw);
  const previewClass = () =>
    props.json.layout === "bare"
      ? "store-preview json-preview json-preview-bare"
      : "store-preview json-preview";

  return (
    <section class={previewClass()}>
      <header class="store-preview-head">
        <div class="store-preview-title">
          <strong>{label()}</strong>
          <code title={displayTarget()}>
            {displayTarget().slice(0, 160)}
            {displayTarget().length > 160 ? "…" : ""}
          </code>
          <span class="store-preview-meta">{formatBytes(size())}</span>
          <Show when={props.json.error}>
            {(err) => <span class="store-preview-error">{err()}</span>}
          </Show>
        </div>
        <div class="store-preview-controls">
          <a
            class="store-preview-download"
            href={downloadHref()}
            download={downloadName()}
          >
            download
          </a>
          <button
            type="button"
            class="file-close"
            onClick={props.onClose}
            title="close JSON preview"
          >
            ×
          </button>
        </div>
      </header>
      <div class="store-preview-body">
        <pre
          class="store-preview-text trace-json-block"
          onClick={onStoreHashClick}
          innerHTML={html()}
        />
      </div>
    </section>
  );
}

function StorePreviewTab(props: {
  store: Extract<RightSidebarTab, { kind: "store" }>["store"];
  onClose: () => void;
  onOpenStore?: (hash: string) => void;
}) {
  const object = () => props.store.object;
  const content = () => object()?.content ?? object()?.text ?? "";
  const size = () => {
    const explicit = object()?.size;
    if (typeof explicit === "number" && Number.isFinite(explicit))
      return explicit;
    return content().length;
  };
  const kind = () => object()?.kind || "object";
  const downloadHref = () => {
    const obj = object();
    if (!obj) return null;
    const bytes = obj.bytesBase64;
    if (bytes) return "data:application/octet-stream;base64," + bytes;
    return "data:text/plain;charset=utf-8," + encodeURIComponent(content());
  };
  const highlighted = createMemo(() => {
    const text = content();
    if (object()?.kind === "json") {
      try {
        return highlightHjsonValue(JSON.parse(text), { linkStoreHashes: true });
      } catch {
        // Fall through to automatic highlighting for malformed JSON objects.
      }
    }
    return highlightAuto(text);
  });
  const onStoreHashClick = (ev: MouseEvent) =>
    handleStoreHashClick(ev, props.onOpenStore);

  return (
    <section class="store-preview">
      <header class="store-preview-head">
        <div class="store-preview-title">
          <strong>{kind()}</strong>
          <code>{props.store.hash}</code>
          <Show when={object()}>
            <span class="store-preview-meta">{formatBytes(size())}</span>
          </Show>
        </div>
        <div class="store-preview-controls">
          <Show when={downloadHref()}>
            {(href) => (
              <a
                class="store-preview-download"
                href={href()}
                download={
                  props.store.hash.replace(/[^a-z0-9_.:-]/gi, "_") + ".txt"
                }
              >
                download
              </a>
            )}
          </Show>
          <button
            type="button"
            class="file-close"
            onClick={props.onClose}
            title="close object preview"
          >
            ×
          </button>
        </div>
      </header>
      <div class="store-preview-body">
        <Show
          when={!props.store.loading}
          fallback={<div class="muted">Loading object…</div>}
        >
          <Show
            when={!props.store.error}
            fallback={
              <PrettyError
                title="Couldn’t open object"
                message={props.store.error || "object not found"}
              />
            }
          >
            <Show
              when={object()}
              fallback={
                <PrettyError
                  title="Object not found"
                  message={props.store.hash}
                />
              }
            >
              <pre
                class="store-preview-text"
                onClick={onStoreHashClick}
                innerHTML={highlighted()}
              />
            </Show>
          </Show>
        </Show>
      </div>
    </section>
  );
}

function tabTitle(tab: RightSidebarTab, root?: string | null): string {
  if (tab.kind === "file")
    return displayFilePath(tab.file.path || tab.file.requestedPath, root);
  if (tab.kind === "store") return tab.title;
  if (tab.kind === "json") return tab.title;
  if (tab.kind === "diff") return collapseHome(tab.path);
  if (tab.kind === "memory-diff") return tab.graph || tab.store;
  if (tab.kind === "app") return tab.title || tab.uiId;
  if (tab.kind === "app-code") return `Code · ${tab.title}`;
  if (tab.kind === "trace") return traceTabTitle(tab.trace);
  if (tab.kind === "diffs") return "Diff";
  if (tab.kind === "browser") return "Browser";
  return "Trails";
}

function traceTabTitle(
  trace: Extract<RightSidebarTab, { kind: "trace" }>["trace"],
): string {
  const kind = String(trace.kind || "trace");
  return (
    kind.charAt(0).toUpperCase() +
    kind.slice(1) +
    " " +
    String(trace.id || trace.traceId || "—")
  );
}

type AgentTrailItem = {
  id: string;
  at: number;
  title: string;
  timelineKey?: string;
  detail?: string;
  kind: string;
  tone?: "title" | "summary" | "diff" | "memory" | "subagent";
  path?: string;
  targetChatId?: string;
  diff?: FileDiffItem | MemoryDiffItem;
  stats?: { added: number; removed: number };
  titleMarkdown?: boolean;
  detailMarkdown?: boolean;
};

function AgentTrailSection(props: { bag: Bag }) {
  const items = createMemo(() => buildTrailItems(props.bag));
  return (
    <section class="agent-trail-panel" aria-label="trail for this chat">
      <Show
        when={items().length > 0}
        fallback={<div class="repo-file-status">No trail yet.</div>}
      >
        <ol class="agent-trail-list">
          <For each={items()}>
            {(item) => (
              <AgentTrailRow
                item={item}
                bag={props.bag}
                tick={props.bag.tick()}
              />
            )}
          </For>
        </ol>
      </Show>
    </section>
  );
}

function AgentTrailRow(props: {
  item: AgentTrailItem;
  bag: Bag;
  tick: number;
}) {
  const onMarkdownClick = (ev: MouseEvent) => {
    const anchor = anchorFromEventTarget(ev.target);
    if (!anchor) return;
    const href = anchor.getAttribute("href") || "";
    const path = repoFilePathFromHref(href);
    if (!path) return;
    ev.preventDefault();
    ev.stopPropagation();
    void props.bag.openFileInSidebar(path);
  };
  const activateTrailItem = () => {
    if (props.item.diff) {
      if (props.item.diff.type === "memory-diff")
        props.bag.openMemoryDiffInSidebar(props.item.diff, "timeline");
      else props.bag.openDiffInSidebar(props.item.diff, "timeline");
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
  const itemTitle = () =>
    props.item.diff
      ? "Open this diff in the right sidebar"
      : props.item.targetChatId
        ? "Open this subagent chat"
        : "Jump to this point in the timeline";
  const content = () => (
    <>
      <span class="agent-trail-time">
        {relativeTime(props.item.at, props.tick)}
      </span>
      <span class="agent-trail-card">
        <span class="agent-trail-title-line">
          <AgentTrailInline
            class={
              "agent-trail-title" + (props.item.diff ? " agent-trail-path" : "")
            }
            content={props.item.title}
            markdown={props.item.titleMarkdown}
            onMarkdownClick={onMarkdownClick}
          />
          <Show when={props.item.stats}>
            {(stats) => (
              <ChangeStatsBadge
                stats={stats}
                label={() => diffStatLabel({ stats: stats() })}
                class="agent-trail-diff-stats"
              />
            )}
          </Show>
        </span>
        <Show when={props.item.detail}>
          <AgentTrailInline
            class="agent-trail-detail"
            content={props.item.detail || ""}
            markdown={props.item.detailMarkdown}
            onMarkdownClick={onMarkdownClick}
          />
        </Show>
      </span>
    </>
  );
  return (
    <li
      class="agent-trail-item"
      classList={{
        title: props.item.tone === "title",
        summary: props.item.tone === "summary",
        diff: props.item.tone === "diff",
        memory: props.item.tone === "memory",
        subagent: props.item.tone === "subagent",
      }}
    >
      <span class="agent-trail-dot" aria-hidden="true" />
      <div
        class="agent-trail-entry agent-trail-button"
        role="button"
        tabIndex={0}
        onClick={activateTrailItem}
        onKeyDown={onTrailKeyDown}
        title={itemTitle()}
      >
        {content()}
      </div>
    </li>
  );
}

function AgentTrailInline(props: {
  class: string;
  content: string;
  markdown?: boolean;
  onMarkdownClick: (ev: MouseEvent) => void;
}) {
  return props.markdown ? (
    <span
      class={props.class + " markdown markdown-inline"}
      onClick={props.onMarkdownClick}
      innerHTML={renderTrailMarkdownInline(props.content)}
    />
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
  return trailSourceItems(bag)
    .map((item) => {
      if (item.type === "trail") return trailTimelineItem(item);
      if (item.type === "file-diff") return diffTimelineItem(item);
      if (item.type === "memory-diff") return memoryTrailItem(item);
      if (item.type === "step" && item.kind === "agent:Subagent")
        return subagentTimelineItem(item);
      return null;
    })
    .filter((item): item is AgentTrailItem => item !== null)
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
}

function trailSourceKey(item: TimelineItem): string {
  if (item.type === "step") return `step:${item.step}`;
  if (item.type === "input") return `input:${item.requestId}`;
  if (item.type === "input-response")
    return `input-response:${item.responseId}`;
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
  const status = String(info.result?.status || item.status || "").replace(
    /^agent:/,
    "",
  );
  const childChatId = String(
    info.childChatId || info.result?.childChatId || "",
  ).trim();
  const duration =
    typeof info.result?.durationNs === "number"
      ? ` · ${formatTrailDuration(info.result.durationNs / 1_000_000)}`
      : "";
  const error = String(info.result?.error || "").trim();
  const detail = [
    status ? `${status}${duration}` : "",
    error ? `error: ${error}` : "",
    task,
  ]
    .filter(Boolean)
    .join("\n");
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

function memoryTrailItem(item: MemoryDiffItem): AgentTrailItem {
  return {
    id: item.id,
    at: item.at,
    title: memoryGraphTitle(item),
    detail: memoryGraphSubtitle(item),
    timelineKey: `memory-diff:${item.id}`,
    kind: "memory-diff",
    tone: "memory",
    diff: item,
    stats: memoryDiffFactStats(item),
  };
}

function renderTrailMarkdownInline(content: string): string {
  return renderMarkdownInline(String(content || "").replace(/\n+/g, " "));
}

function TrailsTab(props: { bag: Bag }) {
  return (
    <div class="trails-tab">
      <AgentTrailSection bag={props.bag} />
    </div>
  );
}

function TotalDiffTab(props: { bag: Bag }) {
  return (
    <div class="total-diff-tab">
      <DiffListSection bag={props.bag} />
    </div>
  );
}

function diffStatsForDisplay(item: {
  stats?: { added?: number; removed?: number };
  diff?: string;
}): { added: number; removed: number } {
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

function diffStatLabel(item: {
  stats?: { added?: number; removed?: number };
  diff?: string;
}): string {
  const stats = diffStatsForDisplay(item);
  return `+${stats.added} −${stats.removed}`;
}

function memoryGraphTitle(
  item: Pick<MemoryGraphDiffSummary | MemoryDiffItem, "graph" | "store">,
): string {
  return item.graph || item.store || "memory";
}

function memoryGraphSubtitle(
  item: Pick<MemoryGraphDiffSummary | MemoryDiffItem, "graph" | "store">,
): string {
  const store = item.store || "";
  const graph = item.graph || "";
  if (!store || memoryStoreMatchesGraph(store, graph)) return "";
  return store;
}

function memoryGraphTooltip(
  item: Pick<MemoryGraphDiffSummary | MemoryDiffItem, "graph" | "store">,
): string {
  const title = memoryGraphTitle(item);
  const subtitle = memoryGraphSubtitle(item);
  return subtitle ? title + " · " + subtitle : title;
}

function memoryStoreMatchesGraph(store: string, graph: string): boolean {
  const normalizedStore = normalizeMemoryLabel(store);
  const normalizedGraph = normalizeMemoryLabel(graph);
  return (
    !!normalizedStore &&
    !!normalizedGraph &&
    normalizedStore === normalizedGraph
  );
}

function normalizeMemoryLabel(value: string): string {
  const trimmed = String(value || "")
    .trim()
    .replace(/\/+$/, "");
  const colon = trimmed.indexOf(":");
  if (colon > 0 && trimmed.slice(colon, colon + 3) !== "://") {
    return trimmed.slice(0, colon) + "/" + trimmed.slice(colon + 1);
  }
  return trimmed;
}

function memoryDiffFactStats(item: MemoryGraphDiffSummary | MemoryDiffItem): {
  added: number;
  removed: number;
} {
  if (item.type === "memory-graph-diff")
    return { added: item.addedFacts, removed: item.removedFacts };
  const display = diffStatsForDisplay(item);
  const count = Number.isFinite(Number(item.count))
    ? Math.max(0, Number(item.count))
    : Math.max(display.added, display.removed);
  if (item.action === "retract") return { added: 0, removed: count };
  if (item.action === "assert") return { added: count, removed: 0 };
  return { added: display.added, removed: display.removed };
}

function factStatLabel(stats: { added: number; removed: number }): string {
  const added =
    stats.added === 1 ? "1 fact added" : stats.added + " facts added";
  const removed =
    stats.removed === 1 ? "1 fact removed" : stats.removed + " facts removed";
  return added + ", " + removed;
}

function FactsDiffList(props: { bag: Bag; diffs: MemoryGraphDiffSummary[] }) {
  return (
    <Show when={props.diffs.length > 0}>
      <div
        class="right-diff-items trail-memory-diff-items trail-facts-items"
        aria-label="memory changes by graph"
      >
        <For each={props.diffs}>
          {(item) => {
            const stats = memoryDiffFactStats(item);
            return (
              <button
                type="button"
                class="right-diff-row trail-history-diff-row trail-memory-diff-row"
                onClick={() =>
                  props.bag.openMemoryDiffInSidebar(item, "history")
                }
                title={memoryGraphTooltip(item)}
              >
                <span
                  class="trail-history-diff-dot trail-memory-diff-dot"
                  aria-hidden="true"
                />
                <span class="right-diff-path trail-memory-diff-path">
                  {memoryGraphTitle(item)}
                </span>
                <ChangeStatsBadge
                  stats={() => stats}
                  label={() => factStatLabel(stats)}
                />
              </button>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

function DiffListSection(props: { bag: Bag }) {
  const [expanded, setExpanded] = createSignal(false);
  const diffs = createMemo(() => mergedFileDiffs(trailSourceItems(props.bag)));
  const factDiffs = createMemo(() =>
    mergedMemoryDiffs(trailSourceItems(props.bag)),
  );
  const hasDiffs = () => diffs().length > 0 || factDiffs().length > 0;
  const fileCountLabel = () =>
    diffs().length === 1 ? "1 file" : `${diffs().length} files`;
  const memoryCountLabel = () =>
    factDiffs().length === 1
      ? "1 memory graph"
      : `${factDiffs().length} memory graphs`;
  const summaryLabel = () => {
    const parts: string[] = [];
    if (diffs().length > 0) parts.push(fileCountLabel());
    if (factDiffs().length > 0) parts.push(memoryCountLabel());
    return parts.join(" · ");
  };
  createEffect(() => {
    if (diffs().length === 0 && expanded()) setExpanded(false);
  });
  return (
    <section
      class="right-diff-list trail-total-diff"
      aria-label="total diff for this chat"
    >
      <Show
        when={hasDiffs()}
        fallback={<div class="repo-file-status">No diff yet.</div>}
      >
        <header class="right-diff-list-header">
          <div class="right-diff-list-title">
            <strong>Total diff</strong>
            <span>{summaryLabel()}</span>
          </div>
          <Show when={diffs().length > 0}>
            <button
              type="button"
              classList={{
                "right-diff-view-toggle": true,
                active: expanded(),
              }}
              aria-pressed={expanded()}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded() ? "List view" : "Expanded view"}
            </button>
          </Show>
        </header>
        <FactsDiffList bag={props.bag} diffs={factDiffs()} />
        <Show when={diffs().length > 0}>
          <Show
            when={expanded()}
            fallback={<FileDiffList bag={props.bag} diffs={diffs()} />}
          >
            <ExpandedFileDiffList bag={props.bag} diffs={diffs()} />
          </Show>
        </Show>
      </Show>
    </section>
  );
}

function FileDiffList(props: { bag: Bag; diffs: FileDiffItem[] }) {
  return (
    <div class="right-diff-items">
      <For each={props.diffs}>
        {(item) => {
          const stats = diffStatsForDisplay(item);
          return (
            <button
              type="button"
              class="right-diff-row trail-history-diff-row"
              onClick={() => props.bag.openDiffInSidebar(item, "history")}
              title={collapseHome(item.path)}
            >
              <span class="trail-history-diff-dot" aria-hidden="true" />
              <span class="right-diff-path"><span class="path-ellipsis-text">
                {collapseHome(item.path)}
              </span></span>
              <ChangeStatsBadge
                stats={() => stats}
                label={() => diffStatLabel(item)}
              />
            </button>
          );
        }}
      </For>
    </div>
  );
}

const DIFF_FILE_JUMP_LIMIT = 80;

type DiffJumpOption = {
  item: MergedFileDiffItem;
  index: number;
  score: number;
  label: string;
};

function ExpandedFileDiffList(props: {
  bag: Bag;
  diffs: MergedFileDiffItem[];
}) {
  const fileRefs = new Map<string, HTMLElement>();
  const viewStateKey = (item: MergedFileDiffItem) =>
    normalizedBrowserDiffPath(item.path);
  const viewStateFor = (item: MergedFileDiffItem) =>
    props.bag.expandedDiffViewState(viewStateKey(item));
  const setViewMode = (item: MergedFileDiffItem, mode: DiffContentMode) => {
    props.bag.setExpandedDiffViewMode(viewStateKey(item), mode);
  };
  const setViewScrollTop = (
    item: MergedFileDiffItem,
    scrollTop: number,
    mode: DiffContentMode,
  ) => {
    props.bag.setExpandedDiffViewScrollTop(viewStateKey(item), scrollTop, mode);
  };
  const registerFile = (item: MergedFileDiffItem, el: HTMLElement) => {
    fileRefs.set(viewStateKey(item), el);
  };
  const jumpToFile = (item: MergedFileDiffItem) => {
    const el = fileRefs.get(viewStateKey(item));
    if (!el) return;
    el.scrollIntoView({
      block: "start",
      inline: "nearest",
      behavior: "smooth",
    });
    el.focus({ preventScroll: true });
  };
  createEffect(() => {
    const valid = new Set(props.diffs.map(viewStateKey));
    for (const key of Array.from(fileRefs.keys())) {
      if (!valid.has(key)) {
        fileRefs.delete(key);
      }
    }
  });
  return (
    <div class="right-diff-expanded">
      <div class="right-diff-expanded-toolbar">
        <DiffFileJump diffs={props.diffs} onSelect={jumpToFile} />
      </div>
      <div class="right-diff-expanded-files">
        <For each={props.diffs}>
          {(item) => (
            <ExpandedFileDiffCard
              bag={props.bag}
              item={item}
              register={(el) => registerFile(item, el)}
              viewState={viewStateFor(item)}
              setMode={(mode) => setViewMode(item, mode)}
              setScrollTop={(scrollTop, mode) =>
                setViewScrollTop(item, scrollTop, mode)
              }
            />
          )}
        </For>
      </div>
    </div>
  );
}

function DiffFileJump(props: {
  diffs: MergedFileDiffItem[];
  onSelect: (item: MergedFileDiffItem) => void;
}) {
  let root: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const options = createMemo(() => diffJumpOptions(props.diffs, query()));
  const openMenu = () => {
    setOpen(true);
    queueMicrotask(() => input?.focus());
  };
  const closeMenu = () => setOpen(false);
  const choose = (option: DiffJumpOption) => {
    props.onSelect(option.item);
    setQuery("");
    setActive(0);
    closeMenu();
  };
  const onFocusOut = (ev: FocusEvent) => {
    const next = ev.relatedTarget as Node | null;
    if (next && root?.contains(next)) return;
    closeMenu();
  };
  const onKeyDown = (ev: KeyboardEvent) => {
    const items = options();
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (items.length)
        setActive((value) => Math.min(items.length - 1, value + 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (items.length) setActive((value) => Math.max(0, value - 1));
    } else if (ev.key === "Enter") {
      const option = items[active()];
      if (!option) return;
      ev.preventDefault();
      choose(option);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      closeMenu();
    }
  };
  createEffect(() => {
    const count = options().length;
    if (active() >= count) setActive(Math.max(0, count - 1));
  });
  return (
    <div
      class="diff-file-jump"
      ref={(el) => (root = el)}
      onFocusOut={onFocusOut}
    >
      <button
        type="button"
        class="diff-file-jump-trigger"
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => (open() ? closeMenu() : openMenu())}
      >
        Jump to file
        <span aria-hidden="true">▾</span>
      </button>
      <Show when={open()}>
        <div class="diff-file-jump-menu">
          <input
            ref={(el) => (input = el)}
            class="diff-file-jump-search"
            type="search"
            placeholder="Search changed files…"
            value={query()}
            onInput={(ev) => {
              setQuery(ev.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <div
            class="diff-file-jump-options"
            role="listbox"
            aria-label="changed files"
          >
            <Show
              when={options().length > 0}
              fallback={
                <div class="diff-file-jump-empty">No matching files</div>
              }
            >
              <For each={options()}>
                {(option, i) => {
                  const stats = diffStatsForDisplay(option.item);
                  return (
                    <button
                      type="button"
                      classList={{
                        "diff-file-jump-option": true,
                        active: i() === active(),
                      }}
                      role="option"
                      aria-selected={i() === active()}
                      title={option.label}
                      onMouseDown={(ev) => ev.preventDefault()}
                      onMouseEnter={() => setActive(i())}
                      onClick={() => choose(option)}
                    >
                      <span class="diff-file-jump-path"><span class="path-ellipsis-text">{option.label}</span></span>
                      <ChangeStatsBadge
                        stats={() => stats}
                        label={() => diffStatLabel(option.item)}
                      />
                    </button>
                  );
                }}
              </For>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

function ExpandedFileDiffCard(props: {
  bag: Bag;
  item: MergedFileDiffItem;
  register: (el: HTMLElement) => void;
  viewState: DiffViewState;
  setMode: (mode: DiffContentMode) => void;
  setScrollTop: (scrollTop: number, mode: DiffContentMode) => void;
}) {
  const [mode, setModeSignal] = createSignal<DiffContentMode>(
    props.viewState.mode,
  );
  const setMode = (nextMode: DiffContentMode) => {
    props.setMode(nextMode);
    setModeSignal(nextMode);
  };
  createEffect(() => {
    props.item.path;
    setModeSignal(props.viewState.mode);
  });
  const scrollTop = () => props.viewState.scrollTopByMode[mode()] ?? 0;
  const [hydratedItem, setHydratedItem] = createSignal<MergedFileDiffItem>(
    props.item,
  );
  const [hydrating, setHydrating] = createSignal(false);
  const [sizeLoading, setSizeLoading] = createSignal(false);
  const displayItem = () => hydratedItem();
  const displayPath = () => collapseHome(displayItem().path);
  const recordedAfterContent = () => displayItem().after;
  const sizeRevision = () =>
    fileSizeRevisionForPath(displayItem().path, trailSourceItems(props.bag));
  const [loadedSource, setLoadedSource] = createSignal<{
    path: string;
    basePath: string | null;
    revision: string;
    content: string | null;
  } | null>(null);
  const currentSourceKey = () => ({
    path: displayItem().path,
    basePath: props.bag.currentChatWorktreePath() ?? null,
    revision: sizeRevision(),
  });
  const loadedSourceContent = () => {
    const source = loadedSource();
    const key = currentSourceKey();
    if (!source) return null;
    if (source.path !== key.path) return null;
    if (source.basePath !== key.basePath) return null;
    if (source.revision !== key.revision) return null;
    return source.content;
  };
  const wantsFilesystemSource = () =>
    mode() !== "diff" && Boolean(props.bag.currentChatWorktreePath());
  const sourceContent = () => {
    const loaded = loadedSourceContent();
    if (typeof loaded === "string") return loaded;
    const after = recordedAfterContent();
    return typeof after === "string" ? after : null;
  };
  const contentSize = () => contentSizeBytes(sourceContent());
  const [loadedSizeBytes, setLoadedSizeBytes] = createSignal<number | null>(
    cachedFileSizeBytes(props.item.path, props.bag.currentChatWorktreePath()) ??
      contentSize(),
  );
  let hydrateRequest = 0;
  let sizeRequest = 0;

  createEffect(
    on(
      () => expandedFileDiffHydrationKey(props.item),
      async () => {
        const request = ++hydrateRequest;
        setHydratedItem(props.item);
        if (!expandedFileDiffNeedsHydration(props.item)) {
          setHydrating(false);
          return;
        }
        setHydrating(true);
        try {
          const next = await hydrateMergedFileDiff(props.item);
          if (request === hydrateRequest) setHydratedItem(next);
        } finally {
          if (request === hydrateRequest) setHydrating(false);
        }
      },
    ),
  );

  createEffect(
    on(
      () => normalizedBrowserDiffPath(props.item.path),
      () => setMode(props.viewState.mode),
    ),
  );

  createEffect(
    on(
      () =>
        [
          displayItem().path,
          props.bag.currentChatWorktreePath(),
          sizeRevision(),
          contentSize(),
          wantsFilesystemSource(),
        ] as const,
      async ([nextPath, basePath, revision, snapshotSize, wantsSource]) => {
        const request = ++sizeRequest;
        const normalizedBasePath = basePath ?? null;
        const cached = cachedFileSizeBytes(nextPath, basePath);
        let sizeRevisionCurrent = false;
        if (cached !== null) {
          setLoadedSizeBytes(cached);
          sizeRevisionCurrent =
            cachedFileSizeRevision(nextPath, basePath) === revision;
        } else if (snapshotSize !== null) {
          setLoadedSizeBytes(snapshotSize);
          rememberFileSizeBytes(nextPath, basePath, snapshotSize, revision);
          sizeRevisionCurrent = true;
        } else {
          setLoadedSizeBytes(null);
        }
        const source = loadedSource();
        const hasLoadedSource =
          source &&
          source.path === nextPath &&
          source.basePath === normalizedBasePath &&
          source.revision === revision;
        if (sizeRevisionCurrent && (!wantsSource || hasLoadedSource)) {
          setSizeLoading(false);
          return;
        }

        setSizeLoading(true);
        try {
          const r = await api.fs.read(nextPath, basePath);
          if (request !== sizeRequest) return;
          const nextSize = r.ok && r.value.kind !== "dir" ? r.value.size : null;
          if (nextSize !== null) {
            rememberFileSizeBytes(nextPath, basePath, nextSize, revision);
            rememberFileSizeBytes(
              r.ok ? r.value.path : nextPath,
              basePath,
              nextSize,
              revision,
            );
            setLoadedSizeBytes(nextSize);
          }
          if (wantsSource) {
            setLoadedSource({
              path: nextPath,
              basePath: normalizedBasePath,
              revision,
              content: r.ok && r.value.kind !== "dir" ? r.value.content : null,
            });
          }
        } catch {
          if (request === sizeRequest && wantsSource) {
            setLoadedSource({
              path: nextPath,
              basePath: normalizedBasePath,
              revision,
              content: null,
            });
          }
          // Size refreshes are best-effort; keep the existing cached/snapshot size.
        } finally {
          if (request === sizeRequest) {
            setSizeLoading(false);
          }
        }
      },
    ),
  );

  return (
    <FileDiffPanel
      ref={(el) => props.register(el)}
      class="right-diff-expanded-card"
      tabIndex={-1}
      displayPath={displayPath()}
      path={displayItem().path}
      sourcePath={displayItem().path}
      diff={displayItem().diff ?? ""}
      snapshot={displayItem().after}
      sourceContent={sourceContent()}
      scopeLabel="Chat changeset"
      showScopeLabel={false}
      mode={mode}
      setMode={setMode}
      assetRootPath={props.bag.currentChatWorktreePath()}
      onOpenFile={(nextPath) => void props.bag.openFileInSidebar(nextPath)}
      onOpenStore={(hash) => void props.bag.openStorePreviewInSidebar(hash)}
      expansion={props.bag.expansionStore()}
      expansionKeyPrefix={`total:${diffJumpKey(props.item)}`}
      sizeBytes={loadedSizeBytes()}
      stats={diffStatsForDisplay(displayItem())}
      loading={hydrating() || sizeLoading()}
      scrollTop={scrollTop()}
      onScrollTopChange={props.setScrollTop}
    />
  );
}

function diffJumpKey(item: FileDiffItem): string {
  return item.id + "\0" + normalizedBrowserDiffPath(item.path);
}

function diffJumpOptions(
  diffs: MergedFileDiffItem[],
  query: string,
): DiffJumpOption[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const options: DiffJumpOption[] = [];
  diffs.forEach((item, index) => {
    const label = collapseHome(item.path);
    const haystack = (
      label +
      " " +
      item.path +
      " " +
      fileName(item.path)
    ).toLowerCase();
    if (terms.some((term) => !haystack.includes(term))) return;
    options.push({
      item,
      index,
      label,
      score: diffJumpScore(item.path, label, terms),
    });
  });
  if (terms.length > 0) {
    options.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      const left = a.label.toLowerCase();
      const right = b.label.toLowerCase();
      if (left < right) return -1;
      if (left > right) return 1;
      return a.index - b.index;
    });
  }
  return options.slice(0, DIFF_FILE_JUMP_LIMIT);
}

function diffJumpScore(path: string, label: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lowerPath = path.toLowerCase();
  const lowerLabel = label.toLowerCase();
  const base = fileName(path).toLowerCase();
  let score = 0;
  for (const term of terms) {
    const baseIndex = base.indexOf(term);
    const pathIndex = lowerPath.indexOf(term);
    const labelIndex = lowerLabel.indexOf(term);
    if (base === term) score += 0;
    else if (base.startsWith(term)) score += 1;
    else if (lowerPath.startsWith(term) || lowerLabel.startsWith(term))
      score += 2;
    else if (baseIndex >= 0) score += 4 + baseIndex;
    else if (pathIndex >= 0) score += 12 + pathIndex;
    else if (labelIndex >= 0) score += 12 + labelIndex;
    else score += 10000;
  }
  return score;
}

function DiffDetailTab(props: {
  bag: Bag;
  tab: Extract<RightSidebarTab, { kind: "diff" }>;
}) {
  const rawItem = createMemo(() => {
    if (props.tab.scope === "history") {
      return (
        mergedFileDiffs(trailSourceItems(props.bag)).find((candidate) =>
          sameDiffPath(candidate.path, props.tab.path),
        ) ?? props.tab.item
      );
    }
    return (
      props.bag
        .trail()
        .find(
          (candidate): candidate is FileDiffItem =>
            candidate.type === "file-diff" && candidate.id === props.tab.diffId,
        ) ?? props.tab.item
    );
  });
  const [hydratedItem, setHydratedItem] = createSignal<FileDiffItem | null>(
    null,
  );
  const [hydrating, setHydrating] = createSignal(false);
  let hydrateRequest = 0;

  createEffect(
    on(
      () => {
        const current = rawItem();
        return current ? expandedFileDiffHydrationKey(current) : "";
      },
      async () => {
        const request = ++hydrateRequest;
        const current = rawItem();
        setHydratedItem(current ?? null);
        if (!current || !expandedFileDiffNeedsHydration(current)) {
          setHydrating(false);
          return;
        }
        setHydrating(true);
        try {
          const next = await hydrateMergedFileDiff(current);
          if (request === hydrateRequest) setHydratedItem(next);
        } finally {
          if (request === hydrateRequest) setHydrating(false);
        }
      },
    ),
  );

  const item = createMemo<FileDiffItem | null>(
    () => hydratedItem() ?? rawItem() ?? null,
  );
  const scopeLabel = () =>
    props.tab.scope === "history" ? "Chat changeset" : "Individual change";
  const path = () => item()?.path || props.tab.path;
  const displayPath = () => collapseHome(path());
  const mode = () => props.tab.mode ?? "diff";
  const setMode = (nextMode: DiffContentMode) =>
    props.bag.setDiffTabMode(props.tab.id, nextMode);
  const scrollTop = () => props.tab.scrollTopByMode?.[mode()] ?? 0;
  const setScrollTop = (scrollTop: number, nextMode: DiffContentMode) => {
    props.bag.setDiffTabScrollTop(props.tab.id, scrollTop, nextMode);
  };
  const recordedAfterContent = () => item()?.after;
  const sizeRevision = () =>
    fileSizeRevisionForPath(path(), trailSourceItems(props.bag));
  const [loadedSizeBytes, setLoadedSizeBytes] = createSignal<number | null>(
    cachedFileSizeBytes(path(), props.bag.currentChatWorktreePath()),
  );
  const [loadedSource, setLoadedSource] = createSignal<{
    path: string;
    basePath: string | null;
    revision: string;
    content: string | null;
  } | null>(null);
  const [sourceLoading, setSourceLoading] = createSignal(false);
  const currentSourceKey = () => ({
    path: path(),
    basePath: props.bag.currentChatWorktreePath() ?? null,
    revision: sizeRevision(),
  });
  const loadedSourceContent = () => {
    const source = loadedSource();
    const key = currentSourceKey();
    if (!source) return null;
    if (source.path !== key.path) return null;
    if (source.basePath !== key.basePath) return null;
    if (source.revision !== key.revision) return null;
    return source.content;
  };
  const wantsFilesystemSource = () =>
    Boolean(item()) &&
    (recordedAfterContent() === undefined ||
      (props.tab.scope === "history" &&
        Boolean(props.bag.currentChatWorktreePath())));
  const sourceContent = () => {
    const loaded = loadedSourceContent();
    if (props.tab.scope === "history" && typeof loaded === "string") {
      return loaded;
    }
    const after = recordedAfterContent();
    if (typeof after === "string") return after;
    if (after === undefined) return loaded;
    return null;
  };
  let sizeRequest = 0;
  const openFileSizeBytes = () => {
    const diffPath = path();
    const basePath = props.bag.currentChatWorktreePath();
    const cached = cachedFileSizeBytes(diffPath, basePath);
    if (cached !== null) return cached;
    const fileTab = props.bag
      .rightSidebarTabs()
      .find(
        (tab): tab is Extract<RightSidebarTab, { kind: "file" }> =>
          tab.kind === "file" &&
          (sameDiffPathInRoot(tab.file.path, diffPath, basePath) ||
            sameDiffPathInRoot(tab.file.requestedPath, diffPath, basePath)),
      );
    return fileTab ? fileTab.file.size : null;
  };
  const sourceSizeBytes = () => openFileSizeBytes() ?? loadedSizeBytes();
  createEffect(
    on(
      () =>
        [
          path(),
          props.bag.currentChatWorktreePath(),
          sizeRevision(),
          wantsFilesystemSource(),
        ] as const,
      async ([nextPath, basePath, revision, wantsSource]) => {
        const request = ++sizeRequest;
        const normalizedBasePath = basePath ?? null;
        if (!wantsSource) setSourceLoading(false);
        const cached = cachedFileSizeBytes(nextPath, basePath);
        if (cached !== null) setLoadedSizeBytes(cached);
        const cachedRevision = cachedFileSizeRevision(nextPath, basePath);
        const source = loadedSource();
        const hasLoadedSource =
          source &&
          source.path === nextPath &&
          source.basePath === normalizedBasePath &&
          source.revision === revision;
        if (cached !== null && cachedRevision === revision) {
          if (!wantsSource || hasLoadedSource) return;
        } else if (wantsSource && hasLoadedSource) {
          setSourceLoading(false);
          return;
        }
        if (wantsSource) setSourceLoading(true);
        try {
          const r = await api.fs.read(nextPath, basePath);
          if (request !== sizeRequest) return;
          const nextSize = r.ok && r.value.kind !== "dir" ? r.value.size : null;
          if (nextSize !== null) {
            rememberFileSizeBytes(nextPath, basePath, nextSize, revision);
            rememberFileSizeBytes(
              r.ok ? r.value.path : nextPath,
              basePath,
              nextSize,
              revision,
            );
            setLoadedSizeBytes(nextSize);
          }
          if (wantsSource) {
            setLoadedSource({
              path: nextPath,
              basePath: normalizedBasePath,
              revision,
              content: r.ok && r.value.kind !== "dir" ? r.value.content : null,
            });
          }
          if (nextSize === null && wantsSource) {
            setLoadedSource({
              path: nextPath,
              basePath: normalizedBasePath,
              revision,
              content: null,
            });
          }
        } catch {
          if (request === sizeRequest && wantsSource) {
            setLoadedSource({
              path: nextPath,
              basePath: normalizedBasePath,
              revision,
              content: null,
            });
          }
          // Size refreshes are best-effort; keep the existing cached size.
        } finally {
          if (request === sizeRequest) setSourceLoading(false);
        }
      },
    ),
  );
  return (
    <Show
      when={item()}
      fallback={
        <section class="repo-file-preview right-diff-detail">
          <header class="repo-file-header right-diff-header">
            <div class="right-diff-title-row">
              <strong title={displayPath()}>
                <span class="path-ellipsis-text">{displayPath()}</span>
              </strong>
              <span class="right-diff-scope-label">{scopeLabel()}</span>
            </div>
          </header>
          <div class="repo-file-status">
            Diff no longer appears in the loaded timeline.
          </div>
        </section>
      }
    >
      {(diff: () => FileDiffItem) => (
        <FileDiffPanel
          displayPath={displayPath()}
          path={path()}
          sourcePath={path()}
          diff={diff().diff ?? ""}
          snapshot={typeof diff().after === "string" ? diff().after : null}
          sourceContent={sourceContent()}
          scopeLabel={scopeLabel()}
          mode={mode}
          setMode={setMode}
          assetRootPath={props.bag.currentChatWorktreePath()}
          onOpenFile={(nextPath) => void props.bag.openFileInSidebar(nextPath)}
          onOpenStore={(hash) => void props.bag.openStorePreviewInSidebar(hash)}
          sizeBytes={sourceSizeBytes()}
          stats={diff().stats}
          loading={hydrating() || sourceLoading()}
          scrollTop={scrollTop()}
          onScrollTopChange={setScrollTop}
        />
      )}
    </Show>
  );
}

function MemoryDiffDetailTab(props: {
  bag: Bag;
  tab: Extract<RightSidebarTab, { kind: "memory-diff" }>;
}) {
  const item = createMemo(() => {
    if (props.tab.scope === "history") {
      return (
        mergedMemoryDiffs(props.bag.trail()).find(
          (candidate) =>
            candidate.store === props.tab.store &&
            candidate.graph === props.tab.graph,
        ) ?? props.tab.item
      );
    }
    return (
      props.bag
        .timeline()
        .find(
          (candidate): candidate is MemoryDiffItem =>
            candidate.type === "memory-diff" &&
            candidate.id === props.tab.diffId,
        ) ?? props.tab.item
    );
  });
  const scopeLabel = () =>
    props.tab.scope === "history" ? "Memory changes" : "Memory change";
  const graph = () => item()?.graph || props.tab.graph;
  const store = () => item()?.store || props.tab.store;
  const path = () => item()?.path || props.tab.path;
  const stats = () =>
    item() ? memoryDiffFactStats(item()!) : { added: 0, removed: 0 };
  const storeSubtitle = () =>
    memoryGraphSubtitle({ graph: graph(), store: store() });
  return (
    <section
      class="repo-file-preview right-diff-detail"
      aria-label={scopeLabel() + " for " + graph()}
    >
      <header class="repo-file-header">
        <div>
          <strong title={graph()}>{graph()}</strong>
        </div>
      </header>
      <Show
        when={item()}
        fallback={
          <div class="repo-file-status">
            Memory diff no longer appears in the loaded timeline.
          </div>
        }
      >
        <div class="repo-file-meta right-diff-meta repo-file-toolbar">
          <span>{scopeLabel()}</span>
          <Show when={storeSubtitle()}>
            {(subtitle) => <span>{subtitle()}</span>}
          </Show>
          <span class="right-diff-stats" aria-label={factStatLabel(stats())}>
            <span class="right-diff-added">+{stats().added} facts</span>
            <span class="right-diff-removed">−{stats().removed} facts</span>
          </span>
        </div>
        <div
          class="file-diff-body right-diff-body"
          role="log"
          aria-label={scopeLabel() + " for " + graph()}
        >
          <MemoryDiffView
            changes={item()?.changes}
            action={(() => {
              const current = item();
              return current && hasMemoryDiffAction(current)
                ? current.action
                : undefined;
            })()}
            diff={item()?.diff ?? ""}
            path={path()}
            onOpenStore={(hash) =>
              void props.bag.openStorePreviewInSidebar(hash)
            }
          />
        </div>
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
type FileContentMode = "diff" | "preview" | "source";

function isDiffPath(path: string): boolean {
  return /(?:^|\.)(?:diff|patch)$/i.test(path);
}

function looksLikeDiffFile(path: string, content: string): boolean {
  if (isDiffPath(path)) return true;
  if (!content.includes("\n")) return false;
  if (/^diff --git /m.test(content) || /^@@ -\d/m.test(content)) return true;
  return /^---\s/m.test(content) && /^\+\+\+\s/m.test(content);
}

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

function SidebarModeButton(props: {
  label: string;
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
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
  hasDiff?: () => boolean;
}) {
  return (
    <div class="repo-preview-mode" role="group" aria-label="File preview mode">
      <Show when={props.hasDiff?.()}>
        <SidebarModeButton
          label="Diff"
          active={props.mode() === "diff"}
          title="Show expandable diff"
          onClick={() => props.setMode("diff")}
        />
      </Show>
      <Show when={props.previewKind()}>
        <SidebarModeButton
          label="Preview"
          active={props.mode() === "preview"}
          title={previewKindLabel(props.previewKind())}
          onClick={() => props.setMode("preview")}
        />
      </Show>
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
  const noSnapshotTitle = () =>
    "No post-change snapshot is available for this diff";
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
        title={
          props.hasPreview()
            ? previewKindLabel(props.previewKind())
            : noSnapshotTitle()
        }
        onClick={() => props.setMode("preview")}
      />
      <SidebarModeButton
        label="Source"
        active={props.mode() === "source"}
        disabled={!props.hasSnapshot()}
        title={
          props.hasSnapshot() ? "Show post-change source" : noSnapshotTitle()
        }
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
  ref?: HTMLDivElement | ((el: HTMLDivElement) => void);
  onScroll?: (event: Event) => void;
}) {
  const markdownHtml = createMemo(() => renderMarkdown(props.content || ""));
  const htmlPreviewSrc = createMemo(() =>
    props.kind === "html"
      ? htmlPreviewRawUrlForPath(
          htmlPreviewResolvedFilePath(props.path, props.assetRootPath ?? null),
        )
      : null,
  );
  const onMarkdownClick = (ev: MouseEvent) =>
    handleRenderedMarkdownClick(ev, props.path, props.onOpenFile);
  return (
    <Show
      when={props.kind === "html"}
      fallback={
        <div
          ref={props.ref}
          class="repo-file-content repo-file-rendered repo-file-markdown markdown"
          onClick={onMarkdownClick}
          onScroll={props.onScroll}
          innerHTML={markdownHtml()}
        />
      }
    >
      <div
        ref={props.ref}
        class="repo-file-content repo-file-rendered repo-file-html-preview"
        onScroll={props.onScroll}
      >
        <iframe
          class="repo-file-html-frame"
          title={`HTML preview of ${collapseHome(props.path)}`}
          allow="fullscreen; clipboard-read; clipboard-write; web-share; autoplay; encrypted-media; picture-in-picture"
          src={htmlPreviewSrc() || "about:blank"}
        />
      </div>
    </Show>
  );
}

function resolveHtmlAssetHref(
  href: string,
  path: string,
  assetRootPath?: string | null,
): string | null {
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
    return root
      ? normalizePathSegments(joinRepoPath(root, decoded.slice(1)))
      : normalizePathSegments(decoded);
  }

  const basePath = htmlPreviewAssetBasePath(path, root);
  return normalizePathSegments(
    basePath ? joinRepoPath(basePath, decoded) : decoded,
  );
}

function htmlPreviewResolvedFilePath(
  path: string,
  assetRootPath?: string | null,
): string | null {
  const normalizedPath = normalizeRepoPath(path).replace(/\/+$/, "");
  if (isFilesystemAbsolutePath(normalizedPath)) return normalizedPath;
  return resolveHtmlAssetHref(normalizedPath, "index.html", assetRootPath);
}

function htmlPreviewRawUrlForPath(path: string | null): string | null {
  if (!path) return null;
  const normalized = normalizePathSegments(path);
  if (!isFilesystemAbsolutePath(normalized)) return null;
  if (normalized.startsWith("/")) {
    const dir = repoFileBasePath(normalized) || "/";
    const name = normalized.slice(dir === "/" ? 1 : dir.length + 1);
    return htmlPreviewRawUrl(dir, name, false);
  }
  return null;
}

function htmlPreviewRawUrl(
  root: string,
  rest: string | null | undefined,
  directory: boolean,
): string {
  const psk = getPsk();
  const encodedRoot = base64UrlEncode(root || "/");
  const prefix = psk
    ? `/api/fs/raw64/psk/${base64UrlEncode(psk)}/`
    : "/api/fs/raw64/";
  const encodedRest = encodeRawPathSegments(rest || "");
  return (
    prefix +
    encodedRoot +
    (encodedRest ? "/" + encodedRest : "") +
    (directory && encodedRest ? "/" : "")
  );
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function encodeRawPathSegments(path: string): string {
  const clean = normalizeRepoPath(path || "").replace(/^\/+|\/+$/g, "");
  return clean
    ? clean
        .split("/")
        .filter(Boolean)
        .map((part) => encodeURIComponent(part))
        .join("/")
    : "";
}

function handleStoreHashClick(
  ev: MouseEvent,
  onOpenStore?: (hash: string) => void,
) {
  if (!onOpenStore) return;
  const target = ev.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLElement>("[data-store-hash]");
  const hash = button?.dataset.storeHash;
  if (!hash) return;
  ev.preventDefault();
  ev.stopPropagation();
  onOpenStore(hash);
}

function handleRenderedMarkdownClick(
  ev: MouseEvent,
  currentPath: string,
  onOpenFile?: (path: string) => void,
) {
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
    models: Record<
      string,
      {
        input: number;
        cachedInput: number;
        cacheWriteInput?: number;
        output: number;
      }
    >;
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
  const lines = [
    (hasUnpriced ? "priced lower bound: $" : "estimated total: $") +
      costUsd.toFixed(4),
  ];
  if ((chat.childUsageIncluded ?? 0) > 0) {
    lines.push(
      "includes " +
        chat.childUsageIncluded +
        " hidden subagent chat" +
        (chat.childUsageIncluded === 1 ? "" : "s"),
    );
  }
  if (hasUnpriced) {
    lines.push("unpriced models omitted: " + chat.unpricedModels!.join(", "));
  }
  for (const [model, c] of Object.entries(chat.usage.models)) {
    lines.push(
      model +
        ": " +
        c.input.toLocaleString() +
        " in (+" +
        c.cachedInput.toLocaleString() +
        " cache read, +" +
        (c.cacheWriteInput ?? 0).toLocaleString() +
        " cache write) · " +
        c.output.toLocaleString() +
        " out",
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
  const [openChatMenu, setOpenChatMenu] = createSignal<string | null>(null);
  const [renderedActiveLimit, setRenderedActiveLimit] = createSignal(
    INITIAL_RENDERED_CHATS,
  );
  const [renderedArchivedLimit, setRenderedArchivedLimit] = createSignal(
    INITIAL_RENDERED_CHATS,
  );
  const [loadingMoreChats, setLoadingMoreChats] = createSignal<
    "active" | "archived" | null
  >(null);
  let loadMoreChatsFrame = 0;
  let clearLoadingMoreChatsFrame = 0;
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(storedThemeMode());

  onMount(() => {
    if (bag.traceSettingsCache()) return;
    void api.traces.settings().then((result) => {
      if (result.ok) bag.setCachedTraceSettings(result.value);
    });
  });

  const clickHouseTracingEnabled = () =>
    bag.traceSettingsCache()?.config.enabled === true;

  createEffect(() => {
    const traceSettings = bag.traceSettingsCache();
    if (
      traceSettings &&
      bag.view() === "traces" &&
      !clickHouseTracingEnabled()
    ) {
      bag.showChat();
    }
  });

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
    if (loadMoreChatsFrame) cancelAnimationFrame(loadMoreChatsFrame);
    if (clearLoadingMoreChatsFrame) {
      cancelAnimationFrame(clearLoadingMoreChatsFrame);
    }
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
  const chatById = createMemo(
    () => new Map(bag.chats().map((chat) => [chat.chatId, chat])),
  );
  const activeChats = createMemo(() =>
    orderedChats().filter((chat) => !chat.archived),
  );
  const archivedChats = createMemo(() =>
    orderedChats().filter((chat) => chat.archived),
  );
  const activeChatIds = createMemo(() =>
    activeChats().map((chat) => chat.chatId),
  );
  const archivedChatIds = createMemo(() =>
    archivedChats().map((chat) => chat.chatId),
  );
  const renderedActiveChatIds = createMemo(() =>
    activeChatIds().slice(0, renderedActiveLimit()),
  );
  const renderedArchivedChatIds = createMemo(() =>
    archivedChatIds().slice(0, renderedArchivedLimit()),
  );
  const hiddenActiveChats = createMemo(() =>
    Math.max(0, activeChatIds().length - renderedActiveChatIds().length),
  );
  const hiddenArchivedChats = createMemo(() =>
    Math.max(0, archivedChatIds().length - renderedArchivedChatIds().length),
  );

  const queueLoadMoreChats = () => {
    if (!listEl || loadingMoreChats() || loadMoreChatsFrame) return;
    const nearBottom =
      listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 96;
    const needsMoreRoom = listEl.scrollHeight <= listEl.clientHeight + 1;
    if (!nearBottom && !needsMoreRoom) return;

    const target =
      hiddenActiveChats() > 0
        ? "active"
        : !bag.archivedCollapsed() && hiddenArchivedChats() > 0
          ? "archived"
          : null;
    if (!target) return;

    setLoadingMoreChats(target);
    loadMoreChatsFrame = requestAnimationFrame(() => {
      loadMoreChatsFrame = 0;
      if (target === "active") {
        setRenderedActiveLimit((n) => n + RENDERED_CHATS_PAGE);
      } else {
        setRenderedArchivedLimit((n) => n + RENDERED_CHATS_PAGE);
      }
      clearLoadingMoreChatsFrame = requestAnimationFrame(() => {
        clearLoadingMoreChatsFrame = 0;
        setLoadingMoreChats(null);
        queueLoadMoreChats();
      });
    });
  };

  const factsCount = createMemo(() =>
    bag.graphSummaries().reduce((sum, [, count]) => sum + count, 0),
  );
  const factsCountLabel = createMemo(() => {
    if (!bag.graphSummariesLoaded()) return "loading";
    return String(factsCount());
  });
  const pointerCount = createMemo(() => bag.pointers().length);
  const pointerCountLabel = createMemo(() => {
    if (!bag.pointersLoaded()) return "loading";
    return String(pointerCount());
  });
  const skillCountLabel = createMemo(() => {
    if (!bag.skillsLoaded()) return "loading";
    return String(bag.skills().length);
  });

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  createEffect(() => {
    bag.chats();
    renderedActiveLimit();
    renderedArchivedLimit();
    bag.archivedCollapsed();
    loadingMoreChats();
    queueMicrotask(queueLoadMoreChats);
  });

  const renderedChatOrderKey = createMemo(
    () =>
      renderedActiveChatIds().join("\0") +
      "|" +
      (archivedChats().length > 0 ? "1" : "0") +
      "|" +
      (bag.archivedCollapsed() ? "1" : "0") +
      "|" +
      (bag.archivedCollapsed() ? "" : renderedArchivedChatIds().join("\0")),
  );

  createEffect(
    on(renderedChatOrderKey, () => {
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
    }),
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
          title={
            chat.path
              ? "path: " + collapseHome(chat.path) + "\ndouble-click to rename"
              : "double-click to rename"
          }
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
            <span class="chat-title">
              {chat.title || displayChatId(chat.chatId)}
            </span>
          </span>
          <Show when={chatDirectory(chat.path)}>
            {(directory) => (
              <span
                class="chat-directory"
                title={"directory: " + collapseHome(directory())}
              >
                {collapseHome(directory())}
              </span>
            )}
          </Show>
          <span class="chat-meta">
            {relativeTime(chat.lastAt, bag.tick())} · {chat.totalTurns}{" "}
            {chat.totalTurns === 1 ? "turn" : "turns"} · {chat.totalSteps}{" "}
            {chat.totalSteps === 1 ? "step" : "steps"}
            {" · "}
            <span class="chat-cost-value" title={costTitle(chat)}>
              {formatCost(
                Number.isFinite(chat.costUsd) ? chat.costUsd! : 0,
                (chat.unpricedModels?.length ?? 0) > 0,
              )}
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
              setOpenChatMenu(
                openChatMenu() === chat.chatId ? null : chat.chatId,
              )
            }
          >
            <MenuIcon />
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
          classList={{ active: bag.view() === "new" }}
          title="start a new chat"
          aria-label="start a new chat"
          aria-current={bag.view() === "new" ? "page" : undefined}
          onClick={() => bag.showNewChat()}
        >
          <PlusIcon />
        </button>
      </header>
      <ul
        class="chat-list"
        ref={listEl}
        onScroll={queueLoadMoreChats}
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
          <For each={renderedActiveChatIds()}>
            {(chatId) => chatRow(chatId)}
          </For>
          <Show
            when={hiddenActiveChats() > 0 && loadingMoreChats() === "active"}
          >
            <li class="chat-list-loading">
              <LoadingDots
                class="chat-list-loading-dots"
                label="loading more chats"
              />
            </li>
          </Show>
          <Show when={archivedChats().length > 0}>
            <li class="chat-archive-section">
              <button
                type="button"
                class="chat-archive-toggle"
                onClick={() =>
                  bag.setArchivedCollapsed(!bag.archivedCollapsed())
                }
                aria-expanded={!bag.archivedCollapsed()}
              >
                <span>{bag.archivedCollapsed() ? "▸" : "▾"}</span>
                <span>ARCHIVED</span>
                <span class="chat-archive-count">{archivedChats().length}</span>
              </button>
            </li>
            <Show when={!bag.archivedCollapsed()}>
              <For each={renderedArchivedChatIds()}>
                {(chatId) => chatRow(chatId)}
              </For>
              <Show
                when={
                  hiddenArchivedChats() > 0 && loadingMoreChats() === "archived"
                }
              >
                <li class="chat-list-loading">
                  <LoadingDots
                    class="chat-list-loading-dots"
                    label="loading more archived chats"
                  />
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
        <span class="sidebar-tab-count">{bag.uiApps().length}</span>
      </button>
      <button
        type="button"
        class="sidebar-tab"
        classList={{ active: bag.view() === "facts" }}
        onClick={() => navigate(() => bag.showFacts(null))}
      >
        <span class="sidebar-tab-label">facts</span>
        <span class="sidebar-tab-count">{factsCountLabel()}</span>
      </button>
      <button
        type="button"
        class="sidebar-tab"
        classList={{ active: bag.view() === "pointers" }}
        onClick={() => navigate(() => bag.showPointers())}
      >
        <span class="sidebar-tab-label">pointers</span>
        <span class="sidebar-tab-count">{pointerCountLabel()}</span>
      </button>
      <button
        type="button"
        class="sidebar-tab"
        classList={{ active: bag.view() === "skills" }}
        onClick={() => navigate(() => bag.showSkills())}
      >
        <span class="sidebar-tab-label">skills</span>
        <span class="sidebar-tab-count">{skillCountLabel()}</span>
      </button>
      <button
        type="button"
        class="sidebar-tab"
        classList={{ active: bag.view() === "mcp" }}
        onClick={() => navigate(() => bag.showMcp())}
      >
        <span class="sidebar-tab-label">mcp</span>
        <span class="sidebar-tab-count">{bag.mcpServers().length}</span>
      </button>
      <button
        type="button"
        class="sidebar-tab"
        classList={{ active: bag.view() === "v8" }}
        onClick={() => navigate(() => bag.showV8())}
      >
        <span class="sidebar-tab-label">v8</span>
        <Show
          when={
            bag.v8Stats()?.totals.workers && bag.v8Stats()!.totals.workers > 0
          }
        >
          <span class="sidebar-tab-count">
            {bag.v8Stats()!.totals.busy}/{bag.v8Stats()!.totals.workers} busy
          </span>
        </Show>
      </button>
      <Show when={clickHouseTracingEnabled()}>
        <button
          type="button"
          class="sidebar-tab"
          classList={{ active: bag.view() === "traces" }}
          title="open traces for current chat"
          aria-label="open traces for current chat"
          onClick={() => navigate(() => bag.showTraces(bag.chatId()))}
        >
          <span class="sidebar-tab-label">traces</span>
        </button>
      </Show>
      <div class="sidebar-theme">
        <button
          type="button"
          class="sidebar-settings-link"
          classList={{ active: bag.view() === "settings" }}
          title="settings"
          aria-label="settings"
          aria-current={bag.view() === "settings" ? "page" : undefined}
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
