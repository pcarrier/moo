import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  hasAfterSnapshot,
  htmlPreviewSrcDoc,
  preferredOpenRepoFileDiff,
} from "./Sidebar";
import type { FileDiffItem } from "./api";
import type { OpenRepoFile } from "./state";

const sidebar = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");

function diffItem(partial: Partial<FileDiffItem>): FileDiffItem {
  return {
    type: "file-diff",
    id: "diff",
    chatId: "chat" as FileDiffItem["chatId"],
    path: "page.html",
    diff: "--- a/page.html\n+++ b/page.html\n@@ -1 +1 @@\n-old\n+new",
    at: 1,
    ...partial,
  };
}

function openRepoFile(partial: Partial<OpenRepoFile>): OpenRepoFile {
  return {
    requestedPath: "src/page.html",
    path: "/repo/src/page.html",
    content: "new",
    size: 3,
    mtime: 1,
    kind: "file",
    loading: false,
    error: null,
    ...partial,
  };
}

describe("HTML diff previews", () => {
  test("detects explicit post-change snapshots, including deletions", () => {
    expect(hasAfterSnapshot(diffItem({ after: "<h1>target</h1>" }))).toBe(true);
    expect(hasAfterSnapshot(diffItem({ after: null }))).toBe(true);
    expect(hasAfterSnapshot(diffItem({}))).toBe(false);
  });

  test("repo file diff previews pass the diff target to source and preview panes", () => {
    expect(sidebar).toContain("const diffTargetContent = () => {");
    expect(sidebar).toContain(
      "if (hasAfterSnapshot(props.diff)) return props.diff.after ?? null;",
    );
    expect(sidebar).toContain("snapshot={diffTargetContent()}");
    expect(sidebar).toContain("sourceContent={diffTargetContent()}");
    expect(sidebar).not.toContain(
      "snapshot={recordedAfterContent() ?? latestContent()}",
    );
    expect(sidebar).not.toContain("sourceContent={latestContent()}");
  });

  test("diff panels prefer snapshots over latest filesystem source", () => {
    expect(sidebar).toContain(
      'if (typeof props.snapshot === "string") return props.snapshot;',
    );
    expect(sidebar).toContain("if (props.snapshot === null) return null;");
    expect(sidebar).toContain(
      'return typeof props.sourceContent === "string" ? props.sourceContent : null;',
    );
    expect(sidebar).toContain(
      'const hasSnapshot = () => typeof targetContent() === "string";',
    );
  });

  test("history diff source panes only load current files when snapshots are absent", () => {
    expect(sidebar).toContain("recordedAfterContent() === undefined &&");
    expect(sidebar).toContain("if (after === null) return null;");
    expect(sidebar).toContain("snapshot={diff().after}");
    expect(sidebar).not.toContain(
      'snapshot={typeof diff().after === "string" ? diff().after : null}',
    );
  });

  test("HTML preview iframes use srcdoc content with a raw-file asset base", () => {
    expect(sidebar).toContain(
      "srcdoc={htmlPreviewSrcDoc(props.content, htmlPreviewSrc())}",
    );
    expect(
      htmlPreviewSrcDoc(
        "<html><body>target</body></html>",
        "/api/fs/raw64/root/page.html",
      ),
    ).toBe(
      '<html><head><base href="/api/fs/raw64/root/page.html"></head><body>target</body></html>',
    );
  });

  test("injects one escaped base tag for relative assets", () => {
    expect(
      htmlPreviewSrcDoc(
        "<html><body>Hi</body></html>",
        "/api/fs/raw64/a/b?x=1&y=2",
      ),
    ).toBe(
      '<html><head><base href="/api/fs/raw64/a/b?x=1&amp;y=2"></head><body>Hi</body></html>',
    );
    expect(
      htmlPreviewSrcDoc(
        '<html><head><base href="/custom/"></head><body>Hi</body></html>',
        "/raw/page.html",
      ),
    ).toBe('<html><head><base href="/custom/"></head><body>Hi</body></html>');
  });
  test("keeps browser diffs visible during same-file background refreshes", () => {
    const currentDiff = diffItem({
      id: "current",
      path: "src/page.html",
      diff: "--- a/src/page.html\n+++ b/src/page.html\n@@ -1 +1 @@\n-old\n+new",
      after: "new",
    });

    expect(
      preferredOpenRepoFileDiff(
        openRepoFile({ loading: true }),
        "/repo",
        null,
        currentDiff,
      ),
    ).toBe(currentDiff);

    expect(
      preferredOpenRepoFileDiff(
        openRepoFile({ requestedPath: "src/other.html", loading: true }),
        "/repo",
        null,
        currentDiff,
      ),
    ).toBeNull();
  });

  test("browser and file previews keep current diffs while timeline snapshots hydrate", () => {
    expect(sidebar).toContain("keepSamePathHydratedDiff(");
    expect(sidebar).toContain("setHydratedTimelineDiff((previous) =>");
    expect(sidebar).toContain("setHydratedBrowserTimelineDiff((previous) =>");
    expect(sidebar).toContain(
      "if (timelineDiffHydrating() && !currentDiff) return null;",
    );
    expect(sidebar).toContain(
      "if (browserTimelineDiffHydrating() && !currentDiff) return null;",
    );
    expect(sidebar).not.toContain("if (timelineDiffHydrating()) return null;");
    expect(sidebar).not.toContain(
      "if (browserTimelineDiffHydrating()) return null;",
    );
  });
  test("keeps browser diffs visible during same-file background refreshes", () => {
    const currentDiff = diffItem({
      id: "current",
      path: "src/page.html",
      diff: "--- a/src/page.html\n+++ b/src/page.html\n@@ -1 +1 @@\n-old\n+new",
      after: "new",
    });

    expect(
      preferredOpenRepoFileDiff(
        openRepoFile({ loading: true }),
        "/repo",
        null,
        currentDiff,
      ),
    ).toBe(currentDiff);

    expect(
      preferredOpenRepoFileDiff(
        openRepoFile({ requestedPath: "src/other.html", loading: true }),
        "/repo",
        null,
        currentDiff,
      ),
    ).toBeNull();
  });

  test("browser and file previews keep current diffs while timeline snapshots hydrate", () => {
    expect(sidebar).toContain("keepSamePathHydratedDiff(");
    expect(sidebar).toContain("setHydratedTimelineDiff((previous) =>");
    expect(sidebar).toContain("setHydratedBrowserTimelineDiff((previous) =>");
    expect(sidebar).toContain("if (timelineDiffHydrating() && !currentDiff) return null;");
    expect(sidebar).toContain("if (browserTimelineDiffHydrating() && !currentDiff) return null;");
    expect(sidebar).not.toContain("if (timelineDiffHydrating()) return null;");
    expect(sidebar).not.toContain("if (browserTimelineDiffHydrating()) return null;");
  });

});
