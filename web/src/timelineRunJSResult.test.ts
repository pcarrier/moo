import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
const runjsFormat = readFileSync(new URL("./timeline/format.ts", import.meta.url), "utf8");

describe("timeline runJS result rendering", () => {
  test("renders a Result row even when the runJS result is empty", () => {
    expect(runjsFormat).toContain("hasResult: runjs.result != null");
    expect(runjsFormat).toContain("let hasResult = false;");
    expect(runjsFormat).toContain("hasResult = true;");
    expect(timeline).toContain("<Show when={parsed().hasResult}>");
    expect(timeline).not.toContain("<Show when={parsed().result}>");
  });

  test("lazy result hydration is keyed by result hash and uses loading dots", () => {
    expect(timeline).toContain('const [hydratedResultByHash, setHydratedResultByHash] = createSignal<Record<');
    expect(timeline).toContain('const resultHash = () => props.item.resultHash ?? null;');
    expect(timeline).toContain('return hash ? hydratedResultByHash()[hash] ?? null : null;');
    expect(timeline).toContain('setHydratedResultByHash((results) => ({ ...results, [hash]: loaded }));');
    expect(timeline).toContain('typeof storeObject.text === "string"');
    expect(timeline).toContain('hydratingHash() === resultHash()');
    expect(timeline).toContain('<LoadingDots label="loading result" />');
    expect(timeline).not.toContain('setHydratedResult(null);');
    expect(timeline).not.toContain('const [hydratedHash, setHydratedHash]');
    expect(timeline).not.toContain('<pre class="runjs-out">Loading…</pre>');
  });

  test("lazy result hydration falls back to text content and times out", () => {
    expect(timeline).toContain('typeof storeObject.text === "string"');
    expect(timeline).toContain('async function withTimeout<T>');
    expect(timeline).toContain('"Timed out loading result"');
    expect(timeline).toContain('const object = await withTimeout(');
  });
  test("renders error response payloads as highlighted HJSON", () => {
    expect(timeline).toContain('function highlightErrorPayloadForView(body: unknown): string {');
    expect(timeline).toContain('return text ? highlightAuto(text) : "";');
    expect(timeline).toContain('<pre innerHTML={highlightErrorPayloadForView(payloadText())} />');
    expect(timeline).not.toContain('<pre>{payloadText()}</pre>');
  });
});
