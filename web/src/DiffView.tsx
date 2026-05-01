import { For, Show, createMemo, createSignal } from "solid-js";
import { diffDisplaySections, type DiffDisplaySection } from "./diffs";
import { escapeHtml, highlightByPath } from "./syntax";

export type DiffExpansionStore = {
  shown: (key: string) => number;
  setShown: (key: string, shown: number) => void;
};

export function DiffView(props: {
  diff: string;
  snapshot?: string | null;
  path: string;
  expansion?: DiffExpansionStore;
  expansionKeyPrefix?: string;
}) {
  const sections = createMemo(() => diffDisplaySections(props.diff || "", props.snapshot));
  return (
    <div class="diff-scroll-content">
      <For each={sections()}>
        {(section, index) => (
          <DiffDisplaySectionView
            section={section}
            path={props.path}
            expansion={props.expansion}
            expansionKey={props.expansionKeyPrefix ? `${props.expansionKeyPrefix}:diff-section:${index()}` : undefined}
          />
        )}
      </For>
    </div>
  );
}

function DiffDisplaySectionView(props: {
  section: DiffDisplaySection;
  path: string;
  expansion?: DiffExpansionStore;
  expansionKey?: string;
}) {
  return (
    <Show when={props.section.kind === "collapsed"} fallback={
      <For each={(props.section as Extract<DiffDisplaySection, { kind: "lines" }>).lines}>
        {(line) => <DiffLineView line={line} path={props.path} />}
      </For>
    }>
      <CollapsedDiffSection
        section={props.section as Extract<DiffDisplaySection, { kind: "collapsed" }>}
        path={props.path}
        expansion={props.expansion}
        expansionKey={props.expansionKey}
      />
    </Show>
  );
}

function CollapsedDiffSection(props: {
  section: Extract<DiffDisplaySection, { kind: "collapsed" }>;
  path: string;
  expansion?: DiffExpansionStore;
  expansionKey?: string;
}) {
  const [localShown, setLocalShown] = createSignal(0);
  const total = () => props.section.total;
  const usesExternalExpansion = () => Boolean(props.expansion && props.expansionKey);
  const shown = () => Math.min(
    total(),
    usesExternalExpansion()
      ? props.expansion!.shown(props.expansionKey!)
      : localShown(),
  );
  const setShown = (next: number) => {
    const clamped = Math.min(total(), Math.max(0, next));
    if (usesExternalExpansion()) props.expansion!.setShown(props.expansionKey!, clamped);
    else setLocalShown(clamped);
  };
  const visible = createMemo(() => (
    props.section.expandFrom === "end"
      ? props.section.lines.slice(Math.max(0, total() - shown()))
      : props.section.lines.slice(0, shown())
  ));
  const remaining = createMemo(() => Math.max(0, total() - shown()));
  const expand = (count: number) => setShown(shown() + count);
  const expandAll = () => expand(remaining());
  const location = () => props.section.location ? " " + props.section.location : "";
  const controls = () => (
    <Show when={remaining() > 0}>
      <div class="diff-collapsed-controls">
        <span class="diff-collapsed-label">
          {remaining()} of {total()} unchanged lines hidden{location()}
        </span>
        <span class="diff-collapsed-actions" aria-label="Expand hidden diff context">
          <button type="button" onClick={() => expand(10)}>+{Math.min(10, remaining())}</button>
          <button type="button" onClick={() => expand(100)}>+{Math.min(100, remaining())}</button>
          <button type="button" onClick={expandAll}>+all</button>
        </span>
      </div>
    </Show>
  );
  const expanded = () => (
    <Show when={visible().length > 0}>
      <div class="diff-expanded-lines">
        <For each={visible()}>
          {(line) => <DiffLineView line={line} path={props.path} />}
        </For>
      </div>
    </Show>
  );

  return (
    <div class="diff-collapsed">
      <Show when={props.section.controlsPosition === "before"} fallback={<>{expanded()}{controls()}</>}>
        {controls()}
        {expanded()}
      </Show>
    </div>
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
