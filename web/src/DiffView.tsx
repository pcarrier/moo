import { For, Show, createMemo, createSignal } from "solid-js";
import { diffDisplaySections, type DiffDisplaySection } from "./diffs";
import type { MemoryFactChange } from "./api";
import { escapeHtml, highlightLineFragmentByPath } from "./syntax";

export type DiffExpansionStore = {
  shown: (key: string) => number;
  setShown: (key: string, shown: number) => void;
};

export type MemoryDiffChange = MemoryFactChange & { action?: "assert" | "retract" };

export function DiffView(props: {
  diff: string;
  snapshot?: string | null;
  path: string;
  onOpenStore?: (hash: string) => void;
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
            onOpenStore={props.onOpenStore}
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
  onOpenStore?: (hash: string) => void;
  expansion?: DiffExpansionStore;
  expansionKey?: string;
}) {
  return (
    <Show when={props.section.kind === "collapsed"} fallback={
      <For each={(props.section as Extract<DiffDisplaySection, { kind: "lines" }>).lines}>
        {(line) => <DiffLineView line={line} path={props.path} onOpenStore={props.onOpenStore} />}
      </For>
    }>
      <CollapsedDiffSection
        section={props.section as Extract<DiffDisplaySection, { kind: "collapsed" }>}
        path={props.path}
        onOpenStore={props.onOpenStore}
        expansion={props.expansion}
        expansionKey={props.expansionKey}
      />
    </Show>
  );
}

function CollapsedDiffSection(props: {
  section: Extract<DiffDisplaySection, { kind: "collapsed" }>;
  path: string;
  onOpenStore?: (hash: string) => void;
  expansion?: DiffExpansionStore;
  expansionKey?: string;
}) {
  const [localShown, setLocalShown] = createSignal(0);
  const total = () => props.section.total;
  const usesExternalExpansion = () => Boolean(props.expansion && props.expansionKey);
  const storedShown = () => (
    usesExternalExpansion()
      ? props.expansion!.shown(props.expansionKey!)
      : localShown()
  );
  const shown = () => storedShown() > 0 ? total() : 0;
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
  const hasShown = createMemo(() => shown() > 0);
  const contextLabel = () => hasShown() ? "expanded" : `${total()} hidden`;
  const expandAll = () => setShown(total());
  const collapseAll = () => setShown(0);
  const location = () => props.section.location ? " " + props.section.location : "";
  const controls = () => (
    <Show when={total() > 0}>
      <div class="diff-collapsed-controls">
        <span class="diff-collapsed-label">
          {contextLabel()}
        </span>
        <span class="diff-collapsed-actions" aria-label="Expand or collapse hidden diff context">
          <Show when={!hasShown()}>
            <button type="button" onClick={expandAll}>expand</button>
          </Show>
          <Show when={hasShown()}>
            <button type="button" onClick={collapseAll}>collapse</button>
          </Show>
        </span>
      </div>
    </Show>
  );
  const expanded = () => (
    <Show when={visible().length > 0}>
      <div class="diff-expanded-lines">
        <For each={visible()}>
          {(line) => <DiffLineView line={line} path={props.path} onOpenStore={props.onOpenStore} />}
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

export function MemoryDiffView(props: {
  changes?: MemoryDiffChange[] | null;
  action?: "assert" | "retract";
  diff: string;
  path: string;
  onOpenStore?: (hash: string) => void;
}) {
  const groups = createMemo(() => memoryChangeGroups(props.changes || [], props.action));
  return (
    <Show when={groups().length > 0} fallback={
      <DiffView diff={props.diff} path={props.path} onOpenStore={props.onOpenStore} />
    }>
      <div class="diff-scroll-content memory-turtle-diff">
        <For each={groups()}>
          {(group) => (
            <div class="memory-turtle-subject">
              <DiffTurtleLine cls={group.cls} sign={group.sign} indent="" text={group.subject} path={props.path} onOpenStore={props.onOpenStore} />
              <For each={group.predicates}>
                {(predicate, predicateIndex) => (
                  <For each={predicateLines(predicate, predicateIndex(), group.predicates.length)}>
                    {(line) => (
                      <DiffTurtleLine
                        cls={predicate.cls}
                        sign={predicate.sign}
                        indent={line.indent}
                        text={line.text}
                        path={props.path}
                        onOpenStore={props.onOpenStore}
                      />
                    )}
                  </For>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

function DiffTurtleLine(props: { cls: string; sign: string; indent: string; text: string; path: string; onOpenStore?: (hash: string) => void }) {
  const parts = createMemo(() => linkifyHighlightedText(props.indent + props.text, props.path, true));
  return (
    <span class={"diff-line " + props.cls}>
      <span class="diff-prefix">{props.sign}</span>
      <span class="diff-line-body">
        <DiffLineParts parts={parts()} onOpenStore={props.onOpenStore} />
      </span>
    </span>
  );
}

type MemoryTurtleObject = { text: string; cls: string; sign: string };
type MemoryTurtlePredicate = { label: string; cls: string; sign: string; objects: MemoryTurtleObject[] };
type MemoryTurtleSubject = { subject: string; cls: string; sign: string; predicates: MemoryTurtlePredicate[] };

function memoryChangeGroups(changes: MemoryDiffChange[], fallbackAction?: "assert" | "retract"): MemoryTurtleSubject[] {
  const subjects: MemoryTurtleSubject[] = [];
  const subjectByKey = new Map<string, MemoryTurtleSubject>();
  for (const change of changes) {
    if (!isMemoryChange(change)) continue;
    const rawAction = change.action || fallbackAction;
    const action = rawAction === "retract" ? "retract" : "assert";
    const sign = action === "retract" ? "−" : "+";
    const cls = action === "retract" ? "diff-del" : "diff-add";
    const subjectKey = action + "\0" + change.subject;
    let subject = subjectByKey.get(subjectKey);
    if (!subject) {
      subject = { subject: change.subject, cls, sign, predicates: [] };
      subjectByKey.set(subjectKey, subject);
      subjects.push(subject);
    }
    const predicateLabel = change.predicate === "rdf:type" ? "a" : change.predicate;
    let predicate = subject.predicates.find((candidate) => candidate.label === predicateLabel && candidate.sign === sign);
    if (!predicate) {
      predicate = { label: predicateLabel, cls, sign, objects: [] };
      subject.predicates.push(predicate);
    }
    if (!predicate.objects.some((object) => object.text === change.object)) {
      predicate.objects.push({ text: change.object, cls, sign });
    }
  }
  return subjects;
}

function isMemoryChange(value: unknown): value is MemoryDiffChange {
  if (!value || typeof value !== "object") return false;
  const change = value as Record<string, unknown>;
  return typeof change.subject === "string" && typeof change.predicate === "string" && typeof change.object === "string";
}

function predicateLines(predicate: MemoryTurtlePredicate, predicateIndex: number, predicateCount: number): { indent: string; text: string }[] {
  const objects = predicate.objects;
  if (objects.length === 0) return [{ indent: "    ", text: predicate.label + objectSeparator(0, 1, predicateIndex, predicateCount) }];
  return objects.map((object, objectIndex) => ({
    indent: objectIndex === 0 ? "    " : "        ",
    text: (objectIndex === 0 ? predicate.label + " " : "") + object.text + objectSeparator(objectIndex, objects.length, predicateIndex, predicateCount),
  }));
}

function objectSeparator(objectIndex: number, objectCount: number, predicateIndex: number, predicateCount: number): string {
  if (objectIndex + 1 < objectCount) return " ,";
  return predicateIndex + 1 < predicateCount ? " ;" : " .";
}

function DiffLineView(props: { line: string; path: string; onOpenStore?: (hash: string) => void }) {
  const rendered = createMemo(() => renderDiffLine(props.line, props.path));
  return (
    <span class={rendered().cls}>
      <Show when={rendered().prefix}>
        {(prefix) => <span class={"diff-prefix" + (prefix().cls ? " " + prefix().cls : "")}>{prefix().text}</span>}
      </Show>
      <span class="diff-line-body">
        <Show when={rendered().parts.length > 0} fallback={<span innerHTML="&nbsp;" />}>
          <DiffLineParts parts={rendered().parts} onOpenStore={props.onOpenStore} />
        </Show>
      </span>
    </span>
  );
}

const SHA256_RE = /sha256:[a-f0-9]{64}/gi;

type DiffLinePart = { html: string; text?: never; hash?: never } | { text: string; hash: string; html?: never };
type DiffLinePrefix = { text: string; cls?: string };

function DiffLineParts(props: { parts: DiffLinePart[]; onOpenStore?: (hash: string) => void }) {
  return (
    <For each={props.parts}>
      {(part) => part.hash ? (
        <button
          type="button"
          class="store-link ttl-pn"
          title="open store preview"
          onClick={(event) => {
            event.stopPropagation();
            props.onOpenStore?.(part.hash!);
          }}
        >
          {part.text}
        </button>
      ) : (
        <span innerHTML={part.html} />
      )}
    </For>
  );
}

function renderDiffLine(line: string, path: string): { cls: string; prefix: DiffLinePrefix | null; parts: DiffLinePart[] } {
  let cls = "diff-line diff-context";
  let prefix: DiffLinePrefix | null = null;
  let body = "";
  let highlightBody = false;
  if (line.startsWith("@@")) {
    cls = "diff-line diff-hunk";
    body = line;
  } else if (line.startsWith("diff --git") || line.startsWith("index ")) {
    cls = "diff-line diff-meta";
    body = line;
  } else if (line.startsWith("+++") || line.startsWith("---")) {
    cls = "diff-line diff-file";
    prefix = { text: line.slice(0, 3), cls: "diff-file-prefix" };
    body = line.slice(3);
  } else if (line.startsWith("+")) {
    cls = "diff-line diff-add";
    prefix = { text: "+" };
    body = line.slice(1);
    highlightBody = true;
  } else if (line.startsWith("-")) {
    cls = "diff-line diff-del";
    prefix = { text: "-" };
    body = line.slice(1);
    highlightBody = true;
  } else if (line.startsWith(" ")) {
    prefix = { text: " " };
    body = line.slice(1);
    highlightBody = true;
  } else if (line.startsWith("\ No newline")) {
    cls = "diff-line diff-meta";
    body = line;
  } else {
    body = line;
    highlightBody = true;
  }
  return { cls, prefix, parts: linkifyHighlightedText(body, path, highlightBody) };
}

function linkifyHighlightedText(text: string, path: string, highlight: boolean): DiffLinePart[] {
  const parts: DiffLinePart[] = [];
  SHA256_RE.lastIndex = 0;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = SHA256_RE.exec(text)) !== null) {
    if (match.index > last) {
      const segment = text.slice(last, match.index);
      parts.push({ html: highlight ? highlightLineFragmentByPath(segment, path) : escapeHtml(segment) });
    }
    const token = match[0]!;
    parts.push({ text: token, hash: normalizeSha256(token) });
    last = match.index + token.length;
  }
  if (last < text.length) {
    const segment = text.slice(last);
    parts.push({ html: highlight ? highlightLineFragmentByPath(segment, path) : escapeHtml(segment) });
  }
  return parts;
}

function normalizeSha256(hash: string): string {
  const trimmed = hash.trim().toLowerCase();
  return trimmed.startsWith("sha256:") ? trimmed : "sha256:" + trimmed;
}
