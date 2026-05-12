import type { MemoryGraphDiffSummary } from "../diffs";
import type {
  ChatModelInfo,
  DescribeOverviewValue,
  DescribeTimelinePage,
  DescribeTrailPage,
  DescribeUpdateValue,
  DiffStats,
  FileDiffItem,
  FsEntry,
  MemoryDiffItem,
  StoreObject,
  TraceRow,
  UiApp,
  UiInstance,
} from "../api";

export type OpenRepoFile = {
  requestedPath: string;
  path: string | null;
  content: string;
  size: number;
  mtime: number;
  kind: string;
  entries?: FsEntry[];
  changed?: boolean;
  additions?: number;
  deletions?: number;
  diff?: string;
  diffStats?: DiffStats;
  loading: boolean;
  error: string | null;
};

export type StorePreviewFile = {
  hash: string;
  object: StoreObject;
  loading: boolean;
  error: string | null;
};

export type JsonPreviewFile = {
  target: string;
  value: unknown;
  raw: string;
  error: string | null;
  label?: string;
  displayTarget?: string;
  downloadName?: string;
  downloadMime?: string;
  autoHighlight?: boolean;
  layout?: "boxed" | "bare";
};

export type DiffContentMode = "diff" | "preview" | "source";

export type DiffViewState = {
  mode: DiffContentMode;
  scrollTopByMode: Partial<Record<DiffContentMode, number>>;
};

export type BrowserNavState = {
  path: string | null;
  history: string[];
  index: number;
};

export type RightSidebarTab =
  | { id: "trail"; kind: "trail"; title: string }
  | { id: "diffs"; kind: "diffs"; title: string }
  | { id: "browser"; kind: "browser"; title: string; nav?: BrowserNavState }
  | { id: string; kind: "file"; title: string; file: OpenRepoFile }
  | { id: string; kind: "store"; title: string; store: StorePreviewFile }
  | { id: string; kind: "json"; title: string; json: JsonPreviewFile }
  | {
      id: string;
      kind: "diff";
      title: string;
      diffId: string;
      path: string;
      item?: FileDiffItem;
      scope: "history" | "timeline";
      mode?: DiffContentMode;
      scrollTopByMode?: Partial<Record<DiffContentMode, number>>;
      sourceRevision?: string;
    }
  | { id: string; kind: "trace"; title: string; trace: TraceRow }
  | {
      id: string;
      kind: "memory-diff";
      title: string;
      diffId: string;
      store: string;
      graph: string;
      path: string;
      item?: MemoryDiffItem | MemoryGraphDiffSummary;
      scope: "history" | "timeline";
    }
  | {
      id: string;
      kind: "app";
      title: string;
      uiId: string;
      instanceId: string | null;
      icon?: string | null;
    }
  | {
      id: string;
      kind: "app-code";
      title: string;
      uiId: string;
      icon?: string | null;
    };

export type RightSidebarState = {
  tabs: RightSidebarTab[];
  activeTabId: string;
  width: string;
  collapsed: boolean;
  maximized: boolean;
  expandedDiffViewState?: Record<string, DiffViewState>;
};

export type CachedTimelinePage = DescribeTimelinePage & {
  cachedAt: number;
  accessedAt: number;
};

export type CachedTrailPage = DescribeTrailPage & {
  cachedAt: number;
  accessedAt: number;
};

export type ChatCacheEntry = {
  checkpoint?: DescribeUpdateValue;
  overview?: DescribeOverviewValue;
  timelinePages?: Record<string, CachedTimelinePage>;
  trailPages?: Record<string, CachedTrailPage>;
  activeTimelineKey?: string;
  activeTrailKey?: string;
  model?: ChatModelInfo;
  ui?: { apps: UiApp[]; instances: UiInstance[]; primaryUiId?: string | null };
  rightSidebar?: RightSidebarState;
  accessedAt?: number;
  updatedAt: number;
};
