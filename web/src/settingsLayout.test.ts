import { readFileSync } from "fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";
import { describe, expect, it } from "bun:test";

const settingsView = readFileSync(new URL("./SettingsView.tsx", import.meta.url), "utf8");
const tabBar = readFileSync(new URL("./TabBar.tsx", import.meta.url), "utf8");
const css = readStylesheetForTest();
const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");

function cssBlock(selector: string) {
  const start = css.indexOf(`${selector} {`);
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

describe("settings layout", () => {
  it("uses a shared horizontal tab bar component", () => {
    expect(tabBar).toContain("export function TabBar");
    expect(tabBar).toContain('role="tablist"');
    expect(tabBar).not.toContain('aria-orientation="vertical"');
    expect(tabBar).toContain('role="tab"');
    expect(tabBar).toContain('tabIndex={selected() ? 0 : -1}');
    expect(tabBar).toContain('aria-controls={panelId(item.id)}');
    expect(tabBar).toContain('event.key === "ArrowRight"');
    expect(tabBar).toContain('event.key === "ArrowLeft"');

    expect(settingsView).toContain('from "./TabBar"');
    expect(settingsView).toContain("TabBar");
    expect(settingsView).toContain('class="settings-tabs"');
    expect(settingsView).toContain('ariaLabel="Settings categories"');
    expect(settingsView).toContain('panelId={(id) => `settings-pane-${id}`}');
  });


  it("does not let background settings refresh clobber unsaved provider auth edits", () => {
    expect(settingsView).toContain("const [dirty, setDirty] = createSignal(false);");
    expect(settingsView).toContain("setDirty(true);");
    expect(settingsView).toContain("setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));");
    expect(settingsView).toContain("if (cached && !dirty() && !saving()) hydrate(cached);");
    expect(settingsView).toContain("setDirty(false);");
  });

  it("renders provider auth select options as controlled native option children", () => {
    expect(settingsView).toContain('{canOAuth ? <option value="oauth" selected={draft().authMode === "oauth"}>OAuth</option> : null}');
    expect(settingsView).not.toContain('canSubscription');
    expect(settingsView).not.toContain('value="subscription"');
    expect(settingsView).not.toContain('<Show when={canOAuth}><option value="oauth">OAuth</option></Show>');
  });

  it("saves provider auth modes from the Solid draft state", () => {
    expect(settingsView).toContain('const d = drafts();');
    expect(settingsView).not.toContain('authModeSelects');
    expect(settingsView).not.toContain('draftsForSave');
  });

  it("defaults automatic compaction to fifty percent", () => {
    expect(settingsView).toContain("next.compaction?.thresholdPercent ?? 50");
  });
  it("orders behavior immediately after providers", () => {
    expect(settingsView).toContain('{ id: "providers", title: "Providers" },\n  { id: "behavior", title: "Behavior" },\n  { id: "runtime", title: "Runtime" },\n  { id: "traces", title: "Traces" },');
  });

  it("removes duplicate explanatory headers from the settings body", () => {
    expect(settingsView).toContain('id="settings-panel-title" class="sr-only"');
    expect(settingsView).not.toContain("settings-panel-header");
    expect(settingsView).not.toContain("settings-active-summary");
    expect(settingsView).not.toContain("settings-section-heading");
    expect(settingsView).not.toContain("activeTabDetails");
  });

  it("lets the settings route use the available width", () => {
    const route = cssBlock(".settings-view");
    expect(route).toContain("overflow: hidden");
    expect(route).toContain("padding: 1rem 1rem 1rem");
    expect(route).toContain("flex-direction: row");
    expect(route).toContain("justify-content: stretch");

    const panel = cssBlock(".settings-panel");
    expect(panel).toContain("flex: 1 1 auto");
    expect(panel).toContain("inline-size: 100%");
    expect(panel).not.toContain("48rem");
    expect(panel).toContain("max-block-size: 100%");
    expect(panel).toContain("overflow: auto");
    expect(panel).not.toContain("padding:");
  });

  it("uses square product tabs above visibly grouped settings", () => {
    const view = cssBlock(".settings-view");
    expect(view).toContain("padding: 1rem 1rem 1rem");
    expect(view).not.toContain("padding: 1.75rem");

    const layout = cssBlock(".settings-layout");
    expect(layout).toContain("display: flex");
    expect(layout).toContain("flex-direction: column");
    expect(layout).toContain("gap: 0");
    expect(layout).not.toContain("border: 1px solid var(--line-strong)");

    const tabs = cssBlock(".settings-tabs");
    expect(tabs).toContain("position: relative");
    expect(tabs).toContain("inline-size: 100%");
    expect(tabs).toContain("border-radius: 0");
    expect(tabs).not.toContain("border-bottom:");
    expect(tabs).toContain("background: var(--bg)");

    expect(cssBlock(".settings-tabs::after")).toContain("background: var(--line-strong)");
    const settingsTab = cssBlock(".settings-tabs .tab-bar-tab");
    expect(settingsTab).toContain("background: color-mix(in srgb, var(--sidebar-active) 72%, var(--bg))");
    expect(settingsTab).toContain("border-top: 1px solid var(--line-strong)");
    expect(settingsTab).not.toContain("padding-inline");
    expect(cssBlock(".settings-tabs .tab-bar-tab:first-child")).toContain("border-left: 1px solid var(--line-strong)");

    const tabBarBlock = cssBlock(".tab-bar");
    expect(tabBarBlock).toContain("min-block-size: var(--top-bar-h)");
    expect(tabBarBlock).toContain("background: transparent");
    expect(tabBarBlock).toContain("gap: 0");
    expect(tabBarBlock).not.toContain("border:");

    expect(cssBlock(".tab-bar::after")).toContain("background: var(--line)");

    const tab = cssBlock(".tab-bar-tab");
    expect(tab).toContain("border: 0");
    expect(tab).toContain("border-right: 1px solid var(--line)");
    expect(tab).not.toContain("border-top");
    expect(tab).not.toContain("border-left");
    expect(tab).toContain("border-radius: 0");
    expect(tab).toContain("min-block-size: calc(var(--top-bar-h) - 1px)");

    const activeTab = cssBlock('.tab-bar-tab.active,\n.tab-bar-tab[aria-selected="true"]');
    expect(activeTab).toContain("border-right-color: var(--line-strong)");
    expect(activeTab).not.toContain("border-color:");
    expect(activeTab).not.toContain("border-top");
    expect(activeTab).not.toContain("border-left");

    const activeTabAfter = cssBlock('.tab-bar-tab.active::after,\n.tab-bar-tab[aria-selected="true"]::after');
    expect(activeTabAfter).toContain("background: var(--bg)");

    const tabContent = cssBlock(".settings-tab-content");
    expect(tabContent).toContain("inline-size: 100%");
    expect(tabContent).toContain("background: var(--bg)");
    expect(tabContent).toContain("border: 1px solid var(--line-strong)");
    expect(tabContent).toContain("border-top: 0");

    const card = cssBlock(".settings-section,\n.settings-card,\n.ui-card.settings-card");
    expect(card).toContain("border: 0");
    expect(card).toContain("background: transparent");
  });

  it("drops rounded corners from settings tabs and panels", () => {
    const settingsCss = css.slice(css.indexOf(".tab-bar {"), css.indexOf(".memory-turtle-diff"));
    const radii = [...settingsCss.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => match[1].trim());
    expect(radii.every((radius) => radius === "0")).toBe(true);
  });

  it("lays out ClickHouse settings one per line", () => {
    expect(settingsView).toContain('class="settings-row trace-settings-fields"');
    const traceFields = cssBlock(".trace-settings-fields");
    expect(traceFields).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("places actions without extra chrome", () => {
    expect(settingsView).toContain('class="settings-actions trace-test-actions"');
    expect(settingsView).toContain('{testingTrace() ? "Testing…" : "Test"}');
    expect(settingsView).not.toContain("Test ClickHouse configuration before saving");
    expect(settingsView).not.toContain('BackToChatButton');
    expect(settingsView).not.toContain('navigation={<BackToChatButton bag={props.bag} />}');
    expect(settingsView).toContain('class="settings-header-save"');
    expect(settingsView).toContain('{saving() ? "Saving…" : "Save"}');
    expect(settingsView).toContain('disabled={saving()}');
    const headerIndex = settingsView.indexOf('<PageHeader');
    const titleIndex = settingsView.indexOf('title="Settings"', headerIndex);
    const saveIndex = settingsView.indexOf('class="settings-header-save"', headerIndex);
    const tabsIndex = settingsView.indexOf('class="settings-tabs"');
    const contentIndex = settingsView.indexOf('class="settings-tab-content"');
    expect(headerIndex).toBeGreaterThanOrEqual(0);
    expect(saveIndex).toBeGreaterThan(titleIndex);
    expect(saveIndex).toBeLessThan(tabsIndex);
    expect(tabsIndex).toBeGreaterThanOrEqual(0);
    expect(contentIndex).toBeGreaterThan(tabsIndex);
    expect(settingsView).not.toContain('class="settings-footer"');
    expect(settingsView).not.toContain('activeTab() === "traces" && !traceTestPassed()');
    expect(settingsView).not.toContain("Save settings");
    expect(settingsView).toMatch(/trace-test-actions[\s\S]*settings-success trace-test-message/);

    expect(css).toContain(".settings-header-save {");
    const headerSaveStart = css.indexOf(".settings-header-save {");
    const headerSave = css.slice(headerSaveStart, css.indexOf("}", headerSaveStart));
    expect(headerSave).toContain("border-radius: 0");
  });
  it("keeps providers one per line without nested boxes", () => {
    const grid = cssBlock(".settings-grid");
    expect(grid).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(grid).toContain("gap: 0");

    const section = cssBlock(".settings-section,\n.settings-card,\n.ui-card.settings-card");
    expect(section).toContain("border: 0");
    expect(section).toContain("background: transparent");
    expect(section).toContain("box-shadow: none");
    expect(settingsView).toContain('class="settings-section llm-provider-section"');
    expect(settingsView).not.toContain('class="settings-card llm-provider-card"');
    expect(settingsView).toContain('class="settings-card behavior-settings-card"');
    expect(settingsView).toContain('class="settings-row three"');
  });
  it("does not render unsafe optimistic runtime or trace defaults", () => {
    expect(settingsView).not.toContain("const DEFAULT_V8_SETTINGS");
    expect(settingsView).not.toContain("const DEFAULT_TRACE_SETTINGS");
    expect(settingsView).not.toContain("Loading V8 runtime settings");
    expect(settingsView).toContain("createSignal<V8SettingsValue | null>");
    expect(settingsView).toContain("createSignal<TraceSettingsValue | null>");
    expect(settingsView).toContain('<h2>V8 runtime</h2>');
    expect(settingsView).toContain('<h2 class="settings-heading-with-badge">ClickHouse tracing <span class="settings-experimental-badge">Experimental</span></h2>');
  });

  it("hydrates independent settings as each request completes", () => {
    expect(state).not.toContain(`Promise.allSettled([
      settingsSingle(),
      v8SettingsSingle(),
      traceSettingsSingle(),
    ])`);
    expect(state).toContain("const v8Settings = v8SettingsSingle()");
    expect(state).toContain("if (result.ok) setV8SettingsCache(result.value);");
    expect(state).toContain("const traceSettings = traceSettingsSingle()");
    expect(state).toContain("if (result.ok) setTraceSettingsCache(result.value);");
    expect(state).toContain("await Promise.all([settings, v8Settings, traceSettings]);");
    expect(state).toContain("void refreshSettingsCache();");
  });
});


it("keeps settings commands on database-only initialization", () => {
  const ws = readFileSync(new URL("../../src/ws.rs", import.meta.url), "utf8");
  expect(ws).toContain("fn db_only_command(command: &str) -> bool");
  expect(ws).toContain('"v8-settings-get"');
  expect(ws).toContain('"v8-settings-save"');
  expect(ws).toContain('"trace-config-get"');
  expect(ws).not.toContain("trace_config_command(command)");
});
