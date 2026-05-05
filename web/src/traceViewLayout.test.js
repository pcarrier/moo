import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
const tracesView = readFileSync(new URL("./TracesView.tsx", import.meta.url), "utf8");
const tracesApi = readFileSync(new URL("./api/traces.ts", import.meta.url), "utf8");

describe("hierarchical trace view", () => {
  test("uses the new hierarchical trace commands", () => {
    for (const command of [
      "trace-chats",
      "trace-node",
      "trace-subtree",
      "trace-events",
      "trace-search",
      "trace-failed",
      "trace-summary",
      "trace-chat-tree",
    ]) {
      expect(tracesApi).toContain(command);
    }
    for (const oldCommand of ["trace-recent", "trace-diagnose", "trace-errors", "trace-get", "trace-tree", "trace-chat"]) {
      expect(tracesApi).not.toContain(`callCommand("${oldCommand}"`);
      expect(tracesView).not.toContain(`callCommand("${oldCommand}"`);
    }
  });

  test("renders three panes, tabs, lazy loading, and details", () => {
    expect(tracesView).toContain("trace-three-pane");
    expect(tracesView).toContain("trace-explorer-header");
    expect(tracesView).toContain("trace-toolbar-group");
    expect(tracesView).toContain("trace-filter-fields");
    expect(tracesView).not.toContain("Find a run, follow the tree, inspect the span.");
    expect(tracesView).toContain("setActiveTab(\"chats\")");
    expect(tracesView).toContain("setActiveTab(\"failed\")");
    expect(tracesView).toContain("setActiveTab(\"search\")");
    expect(tracesView).toContain("load more");
    expect(tracesView).toContain("invokedFromStepId");
    expect(tracesView).toContain("Events (");
    expect(css).toContain(".trace-three-pane");
    expect(css).toContain("grid-template-columns: minmax(12rem, 0.8fr) minmax(18rem, 1.3fr) minmax(18rem, 1fr)");
    expect(css).toContain(".trace-explorer-header");
    expect(css).toContain(".trace-toolbar-group");
    expect(css).toContain(".trace-filter-fields");
  });
});
