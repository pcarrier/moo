import { readFileSync } from "fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";
import { describe, expect, it } from "bun:test";

const memoryView = readFileSync(new URL("./MemoryView.tsx", import.meta.url), "utf8");
const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
const css = readStylesheetForTest();

describe("pointers view", () => {
  it("does not render the full pointer path in each row", () => {
    expect(memoryView).not.toContain('class="pointer-path"');
    expect(memoryView).not.toContain('title={props.node.path}');
  });


  it("uses centered animated loading dots while pointers load", () => {
    expect(memoryView).toContain('when={bag.pointersLoaded()}');
    expect(memoryView).toContain('<div class="facts-loading-centered">');
    expect(memoryView).toContain('<LoadingDots label="loading pointers" />');
    expect(memoryView).not.toContain('loading pointers…');
  });

  it("renders direct json targets as concise sidebar previews", () => {
    expect(memoryView).toContain('target.startsWith("json:")');
    expect(memoryView).toContain("openJsonPreviewInSidebar(props.target)");
    expect(memoryView).toContain('class="store-link pointer-target pointer-target-link pointer-target-json"');
    expect(memoryView).toContain("open JSON in sidebar");
    expect(state).toContain("function openJsonPreviewInSidebar(target: string)");
    expect(state).toContain('kind: "json"');
    expect(sidebar).toContain("function JsonPreviewTab");
    expect(sidebar).toContain("highlightHjsonValue(props.json.value, { linkStoreHashes: true })");
    expect(sidebar).toContain("handleStoreHashClick(ev, props.onOpenStore)");
    expect(sidebar).toContain('data-store-hash');
    expect(sidebar).toContain('class="store-preview-text trace-json-block"');
    expect(css).toContain("button.pointer-target");
    expect(css).toContain(".json-preview .trace-json-block");
    expect(css).toContain(".json-store-link .json-str");
  });
});
