import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";

import { api, type Skill, type SkillSaveInput, type SkillSummary } from "./api";
import { absoluteTime, relativeTime } from "./state";
import type { Bag } from "./state";
import { RefreshIcon } from "./icons";
import { Card, EmptyState, HeaderIconButton, Notice, PageBody, PageHeader, PageShell } from "./PageChrome";

const DEFAULT_CONTENT = "---\nname: Example skill\ndescription: When to use this skill\n---\n\nWrite instructions here.\n";

type Draft = {
  id: string;
  name: string;
  enabled: boolean;
  url: string;
  savedAt?: string;
  content: string;
  builtin: boolean;
  repo: boolean;
  sourcePath?: string;
};

const blankDraft = (): Draft => ({
  id: "",
  name: "",
  enabled: true,
  url: "",
  savedAt: undefined,
  content: DEFAULT_CONTENT,
  builtin: false,
  repo: false,
  sourcePath: undefined,
});

function draftFromSkill(skill: Skill): Draft {
  const repo = skill.repo === true || skill.source?.kind === "repo";
  return {
    id: skill.id,
    name: skill.name,
    enabled: skill.enabled,
    url: skill.url || "",
    savedAt: skill.updatedAt,
    content: skill.content,
    builtin: skill.builtin === true,
    repo,
    sourcePath: repo && skill.source?.kind === "repo" ? skill.source.path : undefined,
  };
}

function sameDraft(a: Draft | null, b: Draft): boolean {
  return !!a
    && a.id === b.id
    && a.name === b.name
    && a.enabled === b.enabled
    && a.url === b.url
    && a.savedAt === b.savedAt
    && a.content === b.content
    && a.builtin === b.builtin
    && a.repo === b.repo
    && a.sourcePath === b.sourcePath;
}

function isRepoSkill(skill: SkillSummary) {
  return skill.repo === true || skill.source?.kind === "repo";
}

function metaText(skill: SkillSummary) {
  const parts = [skill.id];
  if (skill.builtin) parts.push("builtin");
  else if (isRepoSkill(skill)) parts.push("repo");
  else if (!skill.url) parts.push("manual");
  if (!skill.enabled) parts.push("disabled");
  return parts.join(" · ");
}

function savedTitle(value?: string) {
  if (!value) return "never saved";
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? "saved at " + absoluteTime(ms) : "saved at " + value;
}

function savedText(value?: string, tick = 0) {
  if (!value) return "never saved";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "saved " + value;
  return "saved " + relativeTime(ms, tick);
}

function describe(skill: SkillSummary) {
  const value = skill.frontmatter?.description ?? skill.frontmatter?.summary ?? "";
  if (typeof value === "string") {
    const text = value.trim();
    return text === ">" || text === "|" ? "" : text;
  }
  return JSON.stringify(value);
}

function isReadOnlyDraft(draft: Draft) {
  return draft.builtin || draft.repo;
}

function readOnlyMessage(draft: Draft) {
  if (draft.repo) return draft.sourcePath ? `repo skills are read-only; edit ${draft.sourcePath}` : "repo skills are read-only";
  return "built-in skills are read-only";
}

function toSaveInput(draft: Draft): SkillSaveInput {
  return {
    id: draft.id.trim() || undefined,
    name: draft.name.trim() || undefined,
    enabled: draft.enabled,
    url: draft.url.trim(),
    content: draft.content,
  };
}

function skillContext(bag: Bag): { chatId?: string | null; root?: string | null } | undefined {
  const id = bag.chatId();
  return id ? { chatId: id } : undefined;
}

function frontmatterPreview(content: string) {
  if (!content.startsWith("---\n")) return "No frontmatter block.";
  const end = content.indexOf("\n---", 4);
  if (end < 0) return "Frontmatter block is not closed.";
  const raw = content.slice(4, end).trim();
  if (!raw) return "Empty frontmatter block.";
  return raw.split("\n").slice(0, 8).join("\n");
}

function insertAtSelection(textarea: HTMLTextAreaElement, insert: string) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const next = textarea.value.slice(0, start) + insert + textarea.value.slice(end);
  const cursor = start + insert.length;
  textarea.value = next;
  textarea.selectionStart = cursor;
  textarea.selectionEnd = cursor;
  return next;
}

export function SkillsView(props: { bag: Bag; onToggleSidebar?: () => void }) {
  const bag = props.bag;
  const [draft, setDraft] = createSignal<Draft>(blankDraft());
  const [savedDraft, setSavedDraft] = createSignal<Draft | null>(null);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [fetching, setFetching] = createSignal(false);
  const [message, setMessage] = createSignal<string | null>(null);

  const url = createMemo(() => draft().url.trim());
  const isDirty = createMemo(() => !sameDraft(savedDraft(), draft()));
  const canSave = createMemo(() => !busy() && !isReadOnlyDraft(draft()));
  const canFetchUrl = createMemo(() => canSave() && !!url());
  const contentStats = createMemo(() => {
    const content = draft().content;
    const lines = content ? content.split("\n").length : 0;
    return `${lines} lines · ${content.length} chars`;
  });

  onMount(() => void bag.refreshSkills());
  createEffect(() => {
    if (bag.view() === "skills") void bag.refreshSkills();
  });

  function reset() {
    setSelected(null);
    setSavedDraft(null);
    setMessage(null);
    setDraft(blankDraft());
  }

  async function edit(id: string) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api("skill-get", { id, ...skillContext(bag) });
      if (!result.ok) return setMessage(result.error.message);
      if (!result.value.skill) return setMessage("skill not found");
      const next = draftFromSkill(result.value.skill);
      setSelected(result.value.skill.id);
      setSavedDraft(next);
      setDraft(next);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (isReadOnlyDraft(draft())) return setMessage(readOnlyMessage(draft()));
    setBusy(true);
    setMessage(null);
    try {
      const result = await api("skill-save", toSaveInput(draft()));
      if (!result.ok) return setMessage(result.error.message || "failed to save");
      const next = draftFromSkill(result.value.skill);
      setSelected(result.value.skill.id);
      setSavedDraft(next);
      setDraft(next);
      await bag.refreshSkills();
    } finally {
      setBusy(false);
    }
  }

  async function fetchUrl() {
    const value = url();
    if (!value) return setMessage("enter a URL first");
    if (isReadOnlyDraft(draft())) return setMessage(readOnlyMessage(draft()));
    const selectedId = selected();
    const base = savedDraft();
    const canPersistRefresh = !!selectedId && !!base && !isDirty() && value === base.url.trim();
    setBusy(true);
    setFetching(true);
    setMessage(null);
    try {
      if (canPersistRefresh) {
        const before = draft();
        const result = await api("skill-refresh", { id: selectedId, ...skillContext(bag) });
        if (!result.ok) return setMessage(result.error.message || "fetch failed");
        if (!result.value.ok || !result.value.skill) return setMessage(result.value.error || "fetch failed");
        // The form stays editable during the in-flight refresh; don't clobber
        // edits the user made while we were waiting.
        if (!sameDraft(before, draft())) return setMessage("draft changed during fetch; not applied");
        const next = draftFromSkill(result.value.skill);
        setSelected(result.value.skill.id);
        setSavedDraft(next);
        setDraft(next);
        await bag.refreshSkills();
        return;
      }

      const result = await api("skill-download", { url: value });
      if (!result.ok) return setMessage(result.error.message || "fetch failed");
      setDraft((current) => ({
        ...current,
        url: result.value.url,
        name: current.name.trim() || result.value.name || current.name,
        content: result.value.content,
      }));
    } finally {
      setFetching(false);
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm(`Delete skill ${id}?`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api("skill-remove", { id });
      if (!result.ok) setMessage(result.error.message);
      else {
        if (selected() === id) reset();
        setMessage(result.value.removed ? "deleted" : "already deleted");
        await bag.refreshSkills();
      }
    } finally {
      setBusy(false);
    }
  }

  function onMarkdownKeyDown(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (canSave()) void save();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const next = insertAtSelection(event.currentTarget, "  ");
      setDraft({ ...draft(), content: next });
    }
  }

  return (
    <PageShell class="skills-view-shell" mainClass="skills-view">
      <PageHeader
        bag={bag}
        title="Skills"
        onToggleSidebar={props.onToggleSidebar}
        actions={
          <HeaderIconButton title="refresh skills" aria-label="refresh skills" disabled={busy()} onClick={() => bag.refreshSkills()}>
            <RefreshIcon />
          </HeaderIconButton>
        }
      />
      <PageBody class="skills-page">
        <div class="skills-grid">
          <Card class="skills-list-card">
            <div class="skills-card-title">
              <h2>Skills</h2>
              <button onClick={reset} disabled={busy()}>new</button>
            </div>
            <Show when={bag.skills().length} fallback={<EmptyState>No skills yet.</EmptyState>}>
              <ul class="skills-list">
                <For each={bag.skills()}>{(skill) => (
                  <li class={selected() === skill.id ? "selected" : ""}>
                    <button class="skill-row" onClick={() => edit(skill.id)} disabled={busy()}>
                      <span class="skill-row-main">
                        <span class="skill-row-title">
                          <strong>{skill.name}</strong>
                          <Show when={!skill.enabled}><em>disabled</em></Show>
                        </span>
                        <small>{metaText(skill)}</small>
                        <Show when={skill.url}><small class="skill-row-url" title={skill.url}>{skill.url}</small></Show>
                        <Show when={!skill.builtin}><small title={savedTitle(skill.updatedAt)}>{savedText(skill.updatedAt, bag.tick())}</small></Show>
                        <Show when={describe(skill)}><span>{describe(skill)}</span></Show>
                      </span>
                    </button>
                  </li>
                )}</For>
              </ul>
            </Show>
          </Card>

          <Card class="skills-editor-card">
            <div class="skills-editor-toolbar">
              <div class="skills-editor-status">
                <strong>{selected() ? "Edit" : "New"}</strong>
                <Show when={draft().builtin}><span>built-in · read-only</span></Show>
                <Show when={!draft().builtin && !draft().url}><span>manual</span></Show>
                <Show when={draft().url}><span class="skills-editor-url" title={draft().url}>{draft().url}</span></Show>
                <Show when={!draft().builtin && (selected() || draft().savedAt)}><span class="skills-editor-saved" title={savedTitle(draft().savedAt)}>{savedText(draft().savedAt, bag.tick())}</span></Show>
              </div>
              <div class="skills-editor-actions">
                <Show when={!isReadOnlyDraft(draft()) && selected()}>
                  <button class="danger" onClick={() => { const id = selected(); if (id) void remove(id); }} disabled={busy()}>delete</button>
                </Show>
                <button class="primary" onClick={() => void save()} disabled={!canSave()}>save</button>
              </div>
            </div>
            <Show when={message()}>
              <Notice class="skills-message">{message()}</Notice>
            </Show>

            <div class="skills-form">
              <label class="skills-field skills-name-field" for="skill-name-input">
                <span class="skills-field-label">Name</span>
                <input id="skill-name-input" value={draft().name} disabled={isReadOnlyDraft(draft())} placeholder="shown in the prompt" onInput={(event) => setDraft({ ...draft(), name: event.currentTarget.value })} />
              </label>

              <label class="skills-field skills-id-field" for="skill-id-input">
                <span class="skills-field-label">ID</span>
                <input id="skill-id-input" value={draft().id} disabled={isReadOnlyDraft(draft())} placeholder="generated from name" onInput={(event) => setDraft({ ...draft(), id: event.currentTarget.value })} />
              </label>

              <label class="skills-enabled">
                <input type="checkbox" checked={draft().enabled} disabled={isReadOnlyDraft(draft())} onChange={(event) => setDraft({ ...draft(), enabled: event.currentTarget.checked })} />
                <span>Enabled</span>
              </label>

              <div class="skills-field skills-url-field">
                <label class="skills-field-label" for="skill-url-input">URL</label>
                <div class="skills-url-row">
                  <input
                    id="skill-url-input"
                    value={draft().url}
                    disabled={draft().builtin}
                    placeholder="https://example.com/SKILL.md"
                    onInput={(event) => {
                      const nextUrl = event.currentTarget.value;
                      setDraft((current) => ({ ...current, url: nextUrl }));
                    }}
                  />
                  <button onClick={() => void fetchUrl()} disabled={!canFetchUrl()}>{fetching() ? "fetching…" : "fetch"}</button>
                </div>
              </div>

              <label class="skills-field skills-markdown-field" for="skill-content-input">
                <span class="skills-markdown-label">
                  <span>Markdown</span>
                  <small title="Ctrl/Cmd-S saves. Tab inserts two spaces.">{contentStats()}</small>
                </span>
                <textarea
                  id="skill-content-input"
                  class="skills-editor-textarea"
                  value={draft().content}
                  readOnly={isReadOnlyDraft(draft())}
                  spellcheck={false}
                  onKeyDown={onMarkdownKeyDown}
                  onInput={(event) => setDraft({ ...draft(), content: event.currentTarget.value })}
                />
              </label>

              <details class="skills-frontmatter-preview">
                <summary>prompt frontmatter</summary>
                <pre>{frontmatterPreview(draft().content)}</pre>
              </details>
            </div>
          </Card>
        </div>
      </PageBody>
    </PageShell>
  );
}
