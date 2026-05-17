import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const timeline = readFileSync(
  new URL("./Timeline.tsx", import.meta.url),
  "utf8",
);
const runtsFormat = readFileSync(
  new URL("./timeline/format.ts", import.meta.url),
  "utf8",
);
const timelineCss = readFileSync(
  new URL("./styles/timeline.css", import.meta.url),
  "utf8",
);

describe("timeline runTS result rendering", () => {
  test("renders a Result row even when the runTS result is empty", () => {
    expect(runtsFormat).toContain("hasResult: runts.result != null");
    expect(runtsFormat).toContain("let hasResult = false;");
    expect(runtsFormat).toContain("hasResult = true;");
    expect(timeline).toContain("<Show when={parsed().hasResult}>");
    expect(timeline).not.toContain("<Show when={parsed().result}>");
  });

  test("lazy result hydration is keyed by result hash and uses loading dots", () => {
    expect(timeline).toContain(
      "const [hydratedResultByHash, setHydratedResultByHash] = createSignal<",
    );
    expect(timeline).toContain(
      "const resultHash = () => props.item.resultHash ?? null;",
    );
    expect(timeline).toContain(
      "return hash ? (hydratedResultByHash()[hash] ?? null) : null;",
    );
    expect(timeline).toContain(
      "setHydratedResultByHash((results) => ({ ...results, [hash]: loaded }));",
    );
    expect(timeline).toContain('typeof storeObject.text === "string"');
    expect(timeline).toContain("hydratingHash() === resultHash()");
    expect(timeline).toContain('label="loading result"');
    expect(timeline).not.toContain("setHydratedResult(null);");
    expect(timeline).not.toContain("const [hydratedHash, setHydratedHash]");
    expect(timeline).not.toContain('<pre class="runts-out">Loading…</pre>');
  });

  test("lazy result hydration falls back to text content and times out", () => {
    expect(timeline).toContain('typeof storeObject.text === "string"');
    expect(timeline).toContain("async function withTimeout<T>");
    expect(timeline).toContain('"Timed out loading result"');
    expect(timeline).toContain("const object = await withTimeout(");
  });

  test("runTS code, args, and result blocks use 10-line previews with a lightbox", () => {
    expect(timeline).toContain("const RUNTS_BLOCK_PREVIEW_LINES = 10;");
    expect(timeline).toContain("maxPreviewLines={RUNTS_BLOCK_PREVIEW_LINES}");
    expect(timeline).toContain("const maxPreviewHeight =");
    expect(timeline).toContain(
      "setTruncated(previewEl.scrollHeight > maxPreviewHeight + 1);",
    );
    expect(timeline).toContain("function runTSBlockLanguageForContent(");
    expect(timeline).toContain("content: string,");
    expect(timeline).toContain("language?: string,");
    expect(timeline).toContain(
      'if (maybeFormatHjsonTextForView(trimmed) !== null) return "hjson";',
    );
    expect(timeline).toContain(
      'if (looksLikeMarkdownText(trimmed)) return "markdown";',
    );
    expect(timeline).toContain('label="Args"');
    expect(timeline).toContain('klass="runts-args"');
    expect(timeline).toContain('language="hjson"');
    expect(timeline).toContain("content={parsed().args}");
    expect(timeline).toContain("onOpenFull={props.onOpenRunTSBlock}");
    expect(timeline).toContain('class="runts-lightbox-backdrop"');
    expect(timeline).toContain('role="button"');
    expect(timeline).toContain('"runts-block-preview": true');
    expect(timeline).toContain('class="runts-lightbox-copy"');
    expect(timeline).toContain(
      "if (isNestedInteractiveTarget(ev.target, ev.currentTarget)) return;",
    );
    expect(timeline).toContain('class="runts-block-fade"');
    expect(timeline).toContain(
      'style={{ "--runts-preview-lines": String(previewLineLimit()) }}',
    );
    expect(timelineCss).toContain(
      "max-block-size: calc(var(--runts-preview-lines) * 1.3em);",
    );
    expect(timeline).not.toContain('class="runts-block-open"');
    expect(timeline).not.toContain('class="runts-block-more"');
  });
  test("renders error response payloads as highlighted HJSON", () => {
    expect(timeline).toContain(
      "function highlightErrorPayloadForView(body: unknown): string {",
    );
    expect(timeline).toContain('return text ? highlightAuto(text) : "";');
    expect(timeline).toContain(
      "<pre innerHTML={highlightErrorPayloadForView(payloadText())} />",
    );
    expect(timeline).not.toContain("<pre>{payloadText()}</pre>");
  });
});
