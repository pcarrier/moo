import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import * as prettier from "prettier/standalone";
import prettierBabel from "prettier/plugins/babel";
import prettierEstree from "prettier/plugins/estree";
import prettierHtml from "prettier/plugins/html";
import prettierPostcss from "prettier/plugins/postcss";
import prettierTypescript from "prettier/plugins/typescript";
import prettierYaml from "prettier/plugins/yaml";

import { api, type UiApp, type UiBundle } from "./api";
import type { Bag } from "./state";
import { highlightByPath } from "./syntax";

function EmptyState(props: { children: unknown }) {
  return <div class="empty-state">{props.children}</div>;
}

type AppSourceFile = {
  path: string;
  text: string;
  kind: "manifest" | "bundle" | "file";
  highlightPath?: string;
};

function sortedBundleFileEntries(
  files: Record<string, string> | undefined,
): Array<[string, string]> {
  return Object.entries(files ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

function bundleSourceFiles(manifest: UiApp, bundle: UiBundle): AppSourceFile[] {
  const out = new Map<string, AppSourceFile>();
  const add = (
    path: string,
    text: string | undefined,
    kind: AppSourceFile["kind"],
    highlightPath?: string,
  ) => {
    if (text === undefined || out.has(path)) return;
    out.set(path, { path, text, kind, highlightPath });
  };

  add("manifest.json", JSON.stringify(manifest, null, 2), "manifest");
  add(manifest.entry || "index.html", bundle.html, "bundle", "index.html");
  add("style.css", bundle.css, "bundle");
  add("client.js", bundle.js, "bundle");
  for (const [path, text] of sortedBundleFileEntries(bundle.files))
    add(path, text, "file");
  return [...out.values()];
}

function formatBytes(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function lineCount(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (const ch of text) if (ch === "\n") lines += 1;
  return lines;
}

type FormatResult = { text: string; error?: string };

function parserForPath(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "json";
  if (
    lower.endsWith(".html") ||
    lower.endsWith(".htm") ||
    lower.endsWith(".svg")
  )
    return "html";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".scss")) return "scss";
  if (lower.endsWith(".less")) return "less";
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts"))
    return "typescript";
  if (lower.endsWith(".tsx")) return "typescript";
  if (
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs") ||
    lower.endsWith(".js")
  )
    return "babel";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  return null;
}

async function formatAppSource(
  path: string,
  text: string,
): Promise<FormatResult> {
  const parser = parserForPath(path);
  if (!parser) return { text };
  try {
    return {
      text: await prettier.format(text, {
        parser,
        plugins: [
          prettierBabel,
          prettierEstree,
          prettierHtml,
          prettierPostcss,
          prettierTypescript,
          prettierYaml,
        ],
        printWidth: 100,
      }),
    };
  } catch (err) {
    return { text, error: err instanceof Error ? err.message : String(err) };
  }
}

export function AppCodeExplorer(props: { bag: Bag; uiId: string }) {
  const { bag } = props;
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
  const [formatEnabled, setFormatEnabled] = createSignal(true);
  const [filePickerActive, setFilePickerActive] = createSignal(false);
  const [bundle, { refetch: refetchBundle }] = createResource(
    () => props.uiId.trim(),
    async (uiId) => {
      const r = await api.ui.bundle(uiId);
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    },
  );

  const selectedApp = createMemo(
    () =>
      bundle()?.manifest ??
      bag.uiApps().find((app) => app.id === props.uiId) ??
      null,
  );
  const sourceFiles = createMemo(() => {
    const value = bundle();
    return value ? bundleSourceFiles(value.manifest, value.bundle) : [];
  });
  const selectedSource = createMemo(
    () =>
      sourceFiles().find((file) => file.path === selectedPath()) ??
      sourceFiles()[0] ??
      null,
  );
  const [formattedSource] = createResource(
    () => {
      const source = selectedSource();
      return source && formatEnabled()
        ? { path: source.path, text: source.text }
        : null;
    },
    async (source) =>
      source ? formatAppSource(source.path, source.text) : null,
  );
  const sourceText = createMemo(() => {
    const source = selectedSource();
    if (!source) return "";
    return formatEnabled()
      ? (formattedSource()?.text ?? source.text)
      : source.text;
  });
  const formatError = createMemo(() =>
    formatEnabled() ? formattedSource()?.error : undefined,
  );
  const highlightedSource = createMemo(() => {
    const source = selectedSource();
    return source
      ? highlightByPath(sourceText(), source.highlightPath || source.path)
      : "";
  });

  createEffect(() => {
    const files = sourceFiles();
    const path = selectedPath();
    if (files.length === 0) {
      if (path !== null) setSelectedPath(null);
      return;
    }
    if (!path || !files.some((file) => file.path === path))
      setSelectedPath(files[0]!.path);
  });

  createEffect(() => {
    props.uiId;
    const refreshIfIdle = () => {
      if (filePickerActive() || bundle.loading) return;
      void refetchBundle();
    };
    const interval = window.setInterval(refreshIfIdle, 2000);
    window.addEventListener("focus", refreshIfIdle);
    onCleanup(() => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfIdle);
    });
  });

  return (
    <section class="apps-code-explorer" aria-label="app code explorer">
      <Show
        when={selectedApp()}
        fallback={<EmptyState>app not found</EmptyState>}
      >
        {(app) => (
          <>
            <Show
              when={!bundle.loading || bundle()}
              fallback={<div class="repo-file-status">Loading code…</div>}
            >
              <Show
                when={bundle.error && !bundle()}
                fallback={
                  <>
                    <header class="apps-code-topbar">
                      <button
                        type="button"
                        class="apps-code-app-button"
                        title={`open ${app().title || app().id}`}
                        onClick={() => void bag.openUi(app().id)}
                      >
                        <span class="app-icon">{app().icon || "▣"}</span>
                        <span class="apps-code-app-copy">
                          <strong>{app().title || app().id}</strong>
                          <span>{app().id}</span>
                        </span>
                      </button>
                      <div class="apps-code-file-row">
                        <Show when={sourceFiles().length > 0}>
                          <label class="apps-file-picker">
                            <span>file</span>
                            <select
                              aria-label="app source file"
                              value={selectedSource()?.path ?? ""}
                              onFocus={() => setFilePickerActive(true)}
                              onBlur={() => setFilePickerActive(false)}
                              onChange={(ev) =>
                                setSelectedPath(ev.currentTarget.value)
                              }
                            >
                              <For each={sourceFiles()}>
                                {(file) => (
                                  <option value={file.path}>{file.path}</option>
                                )}
                              </For>
                            </select>
                          </label>
                        </Show>
                        <Show when={selectedSource()}>
                          {(source) => (
                            <span class="apps-code-meta" title={source().path}>
                              {source().kind} · {lineCount(sourceText())} lines
                              · {formatBytes(sourceText())}
                            </span>
                          )}
                        </Show>
                        <span class="apps-code-toolbar-spacer" />
                        <Show when={formatError()}>
                          {(error) => (
                            <span class="apps-format-error" title={error()}>
                              format failed
                            </span>
                          )}
                        </Show>
                        <button
                          type="button"
                          class="apps-format-toggle"
                          classList={{ active: formatEnabled() }}
                          onClick={() => setFormatEnabled((value) => !value)}
                        >
                          {formatEnabled() ? "raw" : "pretty"}
                        </button>
                      </div>
                    </header>
                    <div class="apps-code-browser">
                      <Show
                        when={selectedSource()}
                        fallback={<EmptyState>no source files</EmptyState>}
                      >
                        {(source) => (
                          <section
                            class="apps-code-pane"
                            aria-label={source().path}
                          >
                            <pre class="apps-code-block">
                              <code innerHTML={highlightedSource()} />
                            </pre>
                          </section>
                        )}
                      </Show>
                    </div>
                  </>
                }
              >
                {(error) => (
                  <div class="repo-file-error">
                    {error() instanceof Error
                      ? error().message
                      : String(error())}
                  </div>
                )}
              </Show>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
