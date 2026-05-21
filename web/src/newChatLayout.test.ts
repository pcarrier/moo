import { readFileSync } from "fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";
import { describe, expect, it } from "bun:test";

const sidebar = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
const css = readStylesheetForTest();

function snippetAfter(source: string, needle: string) {
  const start = source.indexOf(needle);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("</button>", start);
  expect(end).toBeGreaterThanOrEqual(start);
  return source.slice(start, end);
}

function cssBlock(selector: string, from = 0) {
  const start = css.indexOf(`${selector} {`, from);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf("{", start) + 1;
  let depth = 1;
  for (let i = bodyStart; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") depth -= 1;
    if (depth === 0) return css.slice(bodyStart, i);
  }
  throw new Error(`Unclosed CSS block for ${selector}`);
}

describe("new chat layout", () => {
  it("renders compact new chat options", () => {
    expect(sidebar).toContain('class="new-chat-panel"');
    expect(sidebar).toContain('aria-label="New chat options"');
    expect(sidebar).not.toContain("Start a new chat");
    expect(sidebar).not.toContain('id="new-chat-panel-title"');
    expect(sidebar).toContain('class="fs-pick-toggle fs-scratch-toggle"');
    expect(sidebar).toContain('class="fs-pick-toggle fs-browse-toggle"');
    expect(sidebar).toContain('class="fs-start-action"');
    expect(sidebar).toContain('aria-label="project directory"');
    expect(sidebar).toContain('id="new-chat-branch"');
    expect(sidebar).toContain("Pull branches");
  });

  it("never disables scratch start while project actions are creating", () => {
    expect(sidebar).toContain(
      "const [creatingProjectChat, setCreatingProjectChat] = createSignal(false);",
    );
    expect(sidebar).toContain(
      "const [creatingRepoLessChat, setCreatingRepoLessChat] = createSignal(false);",
    );

    const scratchStart = snippetAfter(
      sidebar,
      'class="fs-pick-toggle fs-scratch-toggle"',
    );
    expect(scratchStart).not.toContain("disabled=");

    const recentStart = snippetAfter(
      sidebar,
      "onClick={() => chooseRecentPath(path)}",
    );
    expect(recentStart).toContain("disabled={");
    expect(recentStart).toContain("creatingProjectChat() || branchesLoading()");

    const pathStart = snippetAfter(sidebar, "onClick={createChatInExplorer}");
    expect(pathStart).toContain(
      "disabled={creatingProjectChat() || branchesLoading()}",
    );
  });

  it("offers git branch selection as a second step", () => {
    expect(sidebar).toContain('api("fs-git-branches"');
    expect(sidebar).toContain('api("fs-git-pull-branches"');
    expect(sidebar).toContain(
      "const [pendingProjectPath, setPendingProjectPath] =",
    );
    expect(sidebar).toContain("createSignal<string | null>(null);");
    expect(sidebar).toContain("<Show");
    expect(sidebar).toContain("when={pendingProjectPath()}");
    expect(sidebar).toContain("fallback=");
    const fallbackStart = sidebar.indexOf("when={pendingProjectPath()}");
    const branchStart = sidebar.indexOf('class="fs-branch-step"');
    const scratchStart = sidebar.indexOf(
      'class="fs-pick-toggle fs-scratch-toggle"',
    );
    expect(scratchStart).toBeGreaterThan(fallbackStart);
    expect(scratchStart).toBeLessThan(branchStart);
    expect(sidebar).toContain('class="fs-branch-step-topline"');
    expect(sidebar).toContain('class="fs-branch-back"');
    expect(sidebar).toContain('class="fs-start-action fs-branch-start"');
    expect(sidebar).not.toContain('class="fs-branch-actions"');
    expect(sidebar).toContain('aria-label="Back to project selection"');
    expect(sidebar).toContain("←");
    expect(sidebar).toContain('class="fs-branch-title-block"');
    expect(sidebar).not.toContain('class="fs-step-kicker"');
    expect(sidebar).not.toContain("Step 2");
    const branchMarkup = sidebar.slice(
      branchStart,
      sidebar.indexOf("</section>", branchStart),
    );
    expect(branchMarkup).not.toContain(">Back</button>");
    expect(branchMarkup).toContain("←");
    expect(sidebar).toContain('class="fs-branch-project"');
    expect(sidebar).toContain('title={pendingProjectPath() || ""}');
    expect(sidebar).toContain("{pendingProjectPath()}");
    expect(sidebar).not.toContain('<p class="fs-branch-project"');
    expect(sidebar).toContain("resetBranchChoice(path);");
    expect(sidebar).toContain("if (!loadedBranches.isRepo)");
    expect(sidebar).toContain(
      "await createChatAtPath(collapseHome(loadedBranches.path || path));",
    );
    expect(sidebar).toContain(
      "setPendingProjectPath(collapseHome(loadedBranches.path || path));",
    );
    expect(sidebar).toContain("when={isGitRepo()}");
    expect(sidebar).toContain('when={repoKind() === "jj"}');
    expect(sidebar).toContain('id="new-chat-jj-revision"');
    expect(sidebar).toContain(
      "await bag.createChat(expandHome(path), { branch });",
    );
    expect(sidebar).toContain(
      'if (repoKind() === "jj") return selectedJjRevision();',
    );
    expect(sidebar).toContain("disabled={");
    expect(sidebar).toContain("!isGitRepo() ||");
    expect(sidebar).toContain("!hasBranchRemote() ||");
    expect(sidebar).toContain("branchesLoading() ||");
    expect(sidebar).toContain("branchesPulling()");

    const branchStep = cssBlock(".fs-branch-step");
    expect(branchStep).not.toContain("border-top");

    const branchStepTopline = cssBlock(".fs-branch-step-topline");
    expect(branchStepTopline).toContain("justify-content: space-between");

    const branchBack = cssBlock(".fs-branch-back");
    expect(branchBack).toContain("flex: 0 0 auto");

    const branchStartButton = cssBlock(".fs-branch-start");
    expect(branchStartButton).toContain("margin-left: auto");

    const branchTitle = cssBlock(".fs-branch-project");
    expect(branchTitle).toContain("text-overflow: ellipsis");

    const branchCard = cssBlock(".fs-branch-card");
    expect(branchCard).toContain("display: flex");

    const branchActions = cssBlock(
      ".fs-branch-pull",
      css.indexOf(".fs-branch-header"),
    );
    expect(branchActions).toContain("white-space: nowrap");
    expect(sidebar).not.toContain("fs-branch-upgrade");
  });

  it("uses each project row as the action without duplicate labels", () => {
    expect(sidebar).not.toContain("fs-scratch-action");
    expect(sidebar).not.toContain("fs-recent-action");
    const scratchStart = snippetAfter(
      sidebar,
      'class="fs-pick-toggle fs-scratch-toggle"',
    );
    expect(scratchStart).not.toContain("fs-start-action");
    const recentStart = snippetAfter(
      sidebar,
      "onClick={() => chooseRecentPath(path)}",
    );
    expect(recentStart).not.toContain("fs-start-action");

    const panel = cssBlock(".new-chat-panel");
    expect(panel).toContain("--fs-panel-inline-padding: 1rem");
    expect(panel).toContain("--fs-row-inline-padding: 0.45rem");

    const recentList = cssBlock(".fs-recent-list");
    expect(recentList).toContain(
      "calc(var(--fs-panel-inline-padding) - var(--fs-row-inline-padding))",
    );

    const recent = cssBlock(".fs-recent-project");
    expect(recent).toContain(
      "grid-template-columns: 1.5rem minmax(0, 1fr) auto",
    );
    expect(recent).toContain("padding: 0.35rem var(--fs-row-inline-padding)");
    const remove = cssBlock(".fs-recent-remove");
    expect(remove).toContain("width: 2rem");
    expect(remove).toContain("opacity: 0");

    const scratch = cssBlock(".fs-pick-toggle");
    expect(scratch).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(scratch).toContain("padding: 0.7rem var(--fs-panel-inline-padding)");
    expect(scratch).toContain("background: var(--bg)");
    expect(css).not.toContain(".fs-scratch-toggle {");

    const pathCard = cssBlock(".fs-path-card");
    expect(pathCard).toContain(
      "padding: 0.75rem var(--fs-panel-inline-padding) 1rem",
    );

    const pathRow = cssBlock(".fs-path-row");
    expect(pathRow).toContain(
      "grid-template-columns: minmax(0, 1fr) var(--fs-start-action-width)",
    );
  });

  it("lets the route and panel use the available width", () => {
    const route = cssBlock(".new-chat-route");
    expect(route).toContain("overflow: hidden");
    expect(route).toContain("align-items: stretch");
    expect(route).toContain("justify-content: stretch");

    const panel = cssBlock(".new-chat-panel");
    expect(panel).toContain("flex: 1 1 auto");
    expect(panel).toContain("inline-size: 100%");
    expect(panel).toContain("block-size: 100%");
    expect(panel).toContain("overflow: hidden");
    expect(panel).toContain("border: 0");
    expect(panel).not.toContain("48rem");
  });

  it("lets the file browser take the full available height", () => {
    const recent = cssBlock(".fs-explorer-main .fs-recent-list");
    expect(recent).toContain("max-block-size: 14rem");
    expect(recent).toContain("overflow: auto");

    const explorer = cssBlock(".fs-explorer.fs-explorer-main");
    expect(explorer).toContain("flex: 1 1 auto");
    expect(explorer).toContain("block-size: 100%");
    expect(explorer).toContain("max-block-size: none");

    const picker = cssBlock(".fs-explorer-main .fs-picker");
    expect(picker).toContain("flex: 1 1 auto");
    expect(picker).toContain("min-block-size: 0");

    const entries = cssBlock(".fs-explorer-main .fs-entries");
    expect(entries).toContain("flex: 1 1 auto");
    expect(entries).toContain("max-block-size: none");
    expect(entries).toContain("max-height: none");
  });
});

describe("new chat shared header controls", () => {
  it("new chat header uses the shared left sidebar toggle", () => {
    const sidebar = readFileSync(
      new URL("./Sidebar.tsx", import.meta.url),
      "utf8",
    );
    expect(sidebar).toContain(
      'import { LeftSidebarToggle } from "./HeaderControls";',
    );
    expect(sidebar).toContain(
      "<LeftSidebarToggle onToggleSidebar={props.onToggleSidebar} />",
    );
  });
});
