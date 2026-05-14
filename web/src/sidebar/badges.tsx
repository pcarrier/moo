// Diff badge components — small inline indicators showing added/removed lines
// for filesystem entries, diffs, and memory changes in the right sidebar.
//
// Extracted from Sidebar.tsx to keep the sidebar focused on layout.

import type { FsEntry } from "../api";

export type DiffCountSource = Pick<FsEntry, "additions" | "deletions">;

export function entryDiffCount(entry: DiffCountSource): {
  additions: number;
  deletions: number;
} {
  return {
    additions: Math.max(0, Number(entry.additions || 0)),
    deletions: Math.max(0, Number(entry.deletions || 0)),
  };
}

export function entryDiffTitle(entry: DiffCountSource): string {
  const { additions, deletions } = entryDiffCount(entry);
  return `${additions} additions, ${deletions} deletions`;
}

export function DiffStatsBadge(props: {
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

export function EntryDiffBadge(props: { entry: DiffCountSource }) {
  return (
    <DiffStatsBadge
      stats={() => entryDiffCount(props.entry)}
      label={() => entryDiffTitle(props.entry)}
      class="fs-entry-diff-stats"
    />
  );
}

export function RepoFileDiffBadge(props: { entry: DiffCountSource }) {
  return (
    <DiffStatsBadge
      stats={() => entryDiffCount(props.entry)}
      label={() => entryDiffTitle(props.entry)}
      class="repo-file-diff-stats"
    />
  );
}

export function ChangeStatsBadge(props: {
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
