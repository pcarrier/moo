import { For, Show, createEffect, createSignal, onMount } from "solid-js";

import { api, type LlmAuthMode, type LlmAuthSettings, type LlmProviderId, type TraceConfig, type TraceSettingsValue, type V8PoolRuntimeSettings, type V8RuntimeSettings, type V8SettingsValue } from "./api";
import type { Bag } from "./state";
import { ActionRow, Card, InlineActions, Notice, PageBody, PageHeader, PageShell } from "./PageChrome";
import { TabBar, type TabBarItem } from "./TabBar";

type ProviderMeta = {
  id: LlmProviderId;
  title: string;
  envLabel: string;
  defaultBaseUrl: string;
  supportsOAuth?: boolean;
  supportsSubscription?: boolean;
};

type ProviderDraft = {
  authMode: LlmAuthMode;
  apiKey: string;
  baseUrl: string;
};

type SettingsTabId = "providers" | "runtime" | "traces" | "behavior";

type SettingsTab = TabBarItem<SettingsTabId>;

const SETTINGS_TABS: SettingsTab[] = [
  { id: "providers", title: "Providers" },
  { id: "behavior", title: "Behavior" },
  { id: "runtime", title: "Runtime" },
  { id: "traces", title: "Traces" },
];

const PROVIDERS: ProviderMeta[] = [
  { id: "openai", title: "OpenAI", envLabel: "OPENAI_API_KEY", defaultBaseUrl: "https://api.openai.com/v1", supportsOAuth: true },
  { id: "anthropic", title: "Anthropic", envLabel: "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN", defaultBaseUrl: "https://api.anthropic.com/v1", supportsSubscription: true },
  { id: "qwen", title: "Qwen", envLabel: "QWEN_API_KEY or DASHSCOPE_API_KEY", defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
  { id: "xai", title: "xAI", envLabel: "XAI_API_KEY or GROK_API_KEY", defaultBaseUrl: "https://api.x.ai/v1" },
];


function numberOrBlank(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : "";
}

function blankDraft(): ProviderDraft {
  return { authMode: "env", apiKey: "", baseUrl: "" };
}

function mib(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  return String(Math.round(bytes / 1024 / 1024));
}

function mibToBytes(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1024 * 1024) : null;
}

function intOrNull(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err || "Unknown error");
}

export function SettingsView(props: { bag: Bag; onToggleSidebar: () => void }) {
  const [settings, setSettings] = createSignal<LlmAuthSettings | null>(props.bag.settingsCache());
  const [v8Settings, setV8Settings] = createSignal<V8SettingsValue | null>(props.bag.v8SettingsCache());
  const [traceSettings, setTraceSettings] = createSignal<TraceSettingsValue | null>(props.bag.traceSettingsCache());
  const [saving, setSaving] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [testingTrace, setTestingTrace] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [traceTestMessage, setTraceTestMessage] = createSignal<string | null>(null);
  const [traceTestPassed, setTraceTestPassed] = createSignal(false);
  const [activeTab, setActiveTab] = createSignal<SettingsTabId>("providers");
  const [drafts, setDrafts] = createSignal<Record<LlmProviderId, ProviderDraft>>({
    openai: blankDraft(),
    anthropic: blankDraft(),
    qwen: blankDraft(),
    xai: blankDraft(),
  });
  const [compactionThresholdPercent, setCompactionThresholdPercent] = createSignal("50");
  const [maxAttempts, setMaxAttempts] = createSignal("3");
  const [baseDelayMs, setBaseDelayMs] = createSignal("750");
  const [maxDelayMs, setMaxDelayMs] = createSignal("8000");
  const [jitterMs, setJitterMs] = createSignal("250");
  const [maxRetryAfterMs, setMaxRetryAfterMs] = createSignal("1800000");
  function updateDraft(id: LlmProviderId, patch: Partial<ProviderDraft>) {
    setDirty(true);
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }


  function hydrate(next: LlmAuthSettings) {
    setSettings(next);
    const providerDrafts: Record<LlmProviderId, ProviderDraft> = { openai: blankDraft(), anthropic: blankDraft(), qwen: blankDraft(), xai: blankDraft() };
    for (const meta of PROVIDERS) {
      const p = next.providers[meta.id];
      providerDrafts[meta.id] = {
        authMode: p.authMode,
        apiKey: p.hasApiKey ? "••••" : "",
        baseUrl: p.baseUrl || "",
      };
    }
    setDrafts(providerDrafts);
    setCompactionThresholdPercent(numberOrBlank(next.compaction?.thresholdPercent ?? 75));
    setMaxAttempts(numberOrBlank(next.retries.maxAttempts));
    setBaseDelayMs(numberOrBlank(next.retries.baseDelayMs));
    setMaxDelayMs(numberOrBlank(next.retries.maxDelayMs));
    setJitterMs(numberOrBlank(next.retries.jitterMs));
    setMaxRetryAfterMs(numberOrBlank(next.retries.maxRetryAfterMs));
  }

  function refreshInBackground() {
    setError(null);
    void props.bag.refreshSettingsCache().then(() => {
      if (props.bag.settingsError()) setError(props.bag.settingsError());
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const d = drafts();
      const currentV8 = v8Settings();
      const currentTrace = traceSettings();
      if (!currentV8 || !currentTrace) {
        setError("Settings are still loading; try again in a moment.");
        return;
      }
      const [trace, v8, r] = await Promise.all([
        api.traces.saveSettings(currentTrace.config),
        api.v8.saveSettings(currentV8.settings),
        api.llmAuth.save({
        openai: {
          authMode: d.openai.authMode,
          apiKey: d.openai.apiKey === "••••" ? undefined : d.openai.apiKey,
          baseUrl: d.openai.baseUrl,
        },
        anthropic: {
          authMode: d.anthropic.authMode,
          apiKey: d.anthropic.apiKey === "••••" ? undefined : d.anthropic.apiKey,
          baseUrl: d.anthropic.baseUrl,
        },
        qwen: {
          authMode: d.qwen.authMode,
          apiKey: d.qwen.apiKey === "••••" ? undefined : d.qwen.apiKey,
          baseUrl: d.qwen.baseUrl,
        },
        xai: {
          authMode: d.xai.authMode,
          apiKey: d.xai.apiKey === "••••" ? undefined : d.xai.apiKey,
          baseUrl: d.xai.baseUrl,
        },
        compaction: {
          thresholdPercent: Number(compactionThresholdPercent()),
        },
        retries: {
          maxAttempts: Number(maxAttempts()),
          baseDelayMs: Number(baseDelayMs()),
          maxDelayMs: Number(maxDelayMs()),
          jitterMs: Number(jitterMs()),
          maxRetryAfterMs: Number(maxRetryAfterMs()),
        },
      }),
      ]);
      if (!trace.ok) {
        setError(trace.error.message);
        return;
      }
      setTraceSettings(trace.value);
      props.bag.setCachedTraceSettings(trace.value);
      if (!v8.ok) {
        setError(v8.error.message);
        return;
      }
      setV8Settings(v8.value);
      props.bag.setCachedV8Settings(v8.value);
      if (r.ok) {
        setDirty(false);
        props.bag.setCachedSettings(r.value.settings);
        hydrate(r.value.settings);
      }
      else setError(r.error.message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const [deviceLogin, setDeviceLogin] = createSignal<{ state: string; verificationUrl: string; userCode: string; expiresAt: number } | null>(null);

  async function startOAuth(id: LlmProviderId) {
    setSaving(true);
    setError(null);
    setDeviceLogin(null);
    try {
      const r = await api.llmAuth.oauthDeviceStart(id);
      if (r.ok) {
        setDeviceLogin(r.value.device);
        void pollDeviceLogin(r.value.device.state, r.value.device.interval);
      } else setError(r.error.message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function pollDeviceLogin(state: string, intervalSeconds: number) {
    const wait = Math.max(1000, intervalSeconds * 1000);
    while (deviceLogin()?.state === state) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      const r = await api.llmAuth.oauthDevicePoll(state);
      if (!r.ok) {
        setError(r.error.message);
        setDeviceLogin(null);
        return;
      }
      if (!r.value.pending) {
        setDeviceLogin(null);
        if (r.value.settings) {
          props.bag.setCachedSettings(r.value.settings);
          hydrate(r.value.settings);
        }
        return;
      }
    }
  }

  async function logoutOAuth(id: LlmProviderId) {
    setSaving(true);
    setError(null);
    setDeviceLogin(null);
    try {
      const r = await api.llmAuth.oauthLogout(id);
      if (r.ok) {
        props.bag.setCachedSettings(r.value.settings);
        hydrate(r.value.settings);
      }
      else setError(r.error.message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function patchV8(patch: Partial<V8RuntimeSettings>) {
    setV8Settings((prev) => prev ? ({ ...prev, settings: { ...prev.settings, ...patch } }) : prev);
  }

  function patchV8Pool(key: "mainPool" | "readPool" | "scanPool" | "toolPool", patch: Partial<V8PoolRuntimeSettings>) {
    setV8Settings((prev) => {
      if (!prev) return prev;
      const current = prev.settings[key] ?? { maxWorkers: null, maxOldGenerationBytes: null, maxYoungGenerationBytes: null, recycleUsedHeapBytes: null };
      return { ...prev, settings: { ...prev.settings, [key]: { ...current, ...patch } } };
    });
  }

  function patchTrace(patch: Partial<TraceConfig>) {
    setTraceTestMessage(null);
    setTraceTestPassed(false);
    setTraceSettings((prev) => prev ? ({ ...prev, config: { ...prev.config, ...patch } }) : prev);
  }

  async function testTraceConfig() {
    const currentTrace = traceSettings();
    if (!currentTrace) return;
    setTestingTrace(true);
    setError(null);
    setTraceTestMessage(null);
    const result = await api.traces.testSettings(currentTrace.config);
    setTestingTrace(false);
    if (!result.ok) {
      setTraceTestPassed(false);
      setError(result.error.message);
      return;
    }
    setTraceTestPassed(true);
    setTraceTestMessage(result.value.message);
  }

  function useV8Preset(name: "tiny" | "balanced" | "roomy") {
    const presets: Record<typeof name, V8RuntimeSettings> = {
      tiny: {
        maxWorkers: 4,
        readMaxWorkers: 1,
        scanMaxWorkers: 1,
        toolMaxWorkers: 1,
        maxOldGenerationBytes: 64 * 1024 * 1024,
        maxYoungGenerationBytes: 8 * 1024 * 1024,
        recycleUsedHeapBytes: 48 * 1024 * 1024,
        startupSnapshotsEnabled: true,
        mainPool: { maxWorkers: 4, maxOldGenerationBytes: 64 * 1024 * 1024, maxYoungGenerationBytes: 8 * 1024 * 1024, recycleUsedHeapBytes: 48 * 1024 * 1024 },
        readPool: { maxWorkers: 1, maxOldGenerationBytes: 64 * 1024 * 1024, maxYoungGenerationBytes: 8 * 1024 * 1024, recycleUsedHeapBytes: 48 * 1024 * 1024 },
        scanPool: { maxWorkers: 1, maxOldGenerationBytes: 64 * 1024 * 1024, maxYoungGenerationBytes: 8 * 1024 * 1024, recycleUsedHeapBytes: 48 * 1024 * 1024 },
        toolPool: { maxWorkers: 1, maxOldGenerationBytes: 64 * 1024 * 1024, maxYoungGenerationBytes: 8 * 1024 * 1024, recycleUsedHeapBytes: 48 * 1024 * 1024 },
      },
      balanced: {
        maxWorkers: 16,
        readMaxWorkers: 4,
        scanMaxWorkers: 1,
        toolMaxWorkers: 4,
        maxOldGenerationBytes: 128 * 1024 * 1024,
        maxYoungGenerationBytes: 16 * 1024 * 1024,
        recycleUsedHeapBytes: 96 * 1024 * 1024,
        startupSnapshotsEnabled: true,
        mainPool: { maxWorkers: 16, maxOldGenerationBytes: 128 * 1024 * 1024, maxYoungGenerationBytes: 16 * 1024 * 1024, recycleUsedHeapBytes: 96 * 1024 * 1024 },
        readPool: { maxWorkers: 4, maxOldGenerationBytes: 128 * 1024 * 1024, maxYoungGenerationBytes: 16 * 1024 * 1024, recycleUsedHeapBytes: 96 * 1024 * 1024 },
        scanPool: { maxWorkers: 1, maxOldGenerationBytes: 128 * 1024 * 1024, maxYoungGenerationBytes: 16 * 1024 * 1024, recycleUsedHeapBytes: 96 * 1024 * 1024 },
        toolPool: { maxWorkers: 4, maxOldGenerationBytes: 128 * 1024 * 1024, maxYoungGenerationBytes: 16 * 1024 * 1024, recycleUsedHeapBytes: 96 * 1024 * 1024 },
      },
      roomy: {
        maxWorkers: 16,
        readMaxWorkers: 6,
        scanMaxWorkers: 2,
        toolMaxWorkers: 6,
        maxOldGenerationBytes: 256 * 1024 * 1024,
        maxYoungGenerationBytes: 32 * 1024 * 1024,
        recycleUsedHeapBytes: 192 * 1024 * 1024,
        startupSnapshotsEnabled: true,
        mainPool: { maxWorkers: 16, maxOldGenerationBytes: 256 * 1024 * 1024, maxYoungGenerationBytes: 32 * 1024 * 1024, recycleUsedHeapBytes: 192 * 1024 * 1024 },
        readPool: { maxWorkers: 6, maxOldGenerationBytes: 256 * 1024 * 1024, maxYoungGenerationBytes: 32 * 1024 * 1024, recycleUsedHeapBytes: 192 * 1024 * 1024 },
        scanPool: { maxWorkers: 2, maxOldGenerationBytes: 256 * 1024 * 1024, maxYoungGenerationBytes: 32 * 1024 * 1024, recycleUsedHeapBytes: 192 * 1024 * 1024 },
        toolPool: { maxWorkers: 6, maxOldGenerationBytes: 256 * 1024 * 1024, maxYoungGenerationBytes: 32 * 1024 * 1024, recycleUsedHeapBytes: 192 * 1024 * 1024 },
      },
    };
    setV8Settings((prev) => prev ? ({ ...prev, settings: presets[name] }) : prev);
  }

  createEffect(() => {
    const cached = props.bag.settingsCache();
    if (cached && !dirty() && !saving()) hydrate(cached);
  });
  createEffect(() => {
    setV8Settings(props.bag.v8SettingsCache());
  });
  createEffect(() => {
    setTraceSettings(props.bag.traceSettingsCache());
  });
  createEffect(() => {
    const cachedError = props.bag.settingsError();
    if (cachedError) setError(cachedError);
  });

  onMount(refreshInBackground);

  function providerCard(meta: ProviderMeta) {
    const draft = () => drafts()[meta.id];
    const provider = () => settings()?.providers[meta.id];
    const canOAuth = !!meta.supportsOAuth;
    const canSubscription = !!meta.supportsSubscription;
    return (
      <section class="settings-section llm-provider-section">
        <h2>{meta.title}</h2>
        <label class="field-label">Auth mode</label>
        <select
          value={draft().authMode}
          onChange={(e) => updateDraft(meta.id, { authMode: e.currentTarget.value as LlmAuthMode })}
        >
          <option value="env" selected={draft().authMode === "env"}>Environment variable ({meta.envLabel})</option>
          <option value="apiKey" selected={draft().authMode === "apiKey"}>Stored API key</option>
          {canSubscription ? <option value="subscription" selected={draft().authMode === "subscription"}>Subscription token</option> : null}
          {canOAuth ? <option value="oauth" selected={draft().authMode === "oauth"}>OAuth</option> : null}
        </select>
        <Show when={draft().authMode === "apiKey" || draft().authMode === "subscription"}>
          <label class="field-label">{draft().authMode === "subscription" ? "Subscription auth token" : "API key"}</label>
          <input type="password" value={draft().apiKey} onInput={(e) => updateDraft(meta.id, { apiKey: e.currentTarget.value })} placeholder={draft().authMode === "subscription" ? "ANTHROPIC_AUTH_TOKEN" : "secret key"} />
          <Show when={draft().authMode === "subscription"}>
            <p class="oauth-help">Uses an Anthropic subscription bearer token with the OAuth beta header instead of API-key billing.</p>
          </Show>
        </Show>
        <Show when={canOAuth}>
          <div class="oauth-status">
            <strong>{provider()?.hasAccessToken ? "OAuth connected" : "OAuth not connected"}</strong>
            <span>{provider()?.expiresAt ? "token expires " + new Date(provider()!.expiresAt!).toLocaleString() : ""}</span>
          </div>
          <p class="oauth-help">Uses OpenAI's first-party Codex login; select OAuth and save to use it for model calls.</p>
          <Show when={deviceLogin()}>
            {(login) => <div class="device-login-box">
              <p>Open <a href={login().verificationUrl} target="_blank" rel="noreferrer">{login().verificationUrl}</a> and enter:</p>
              <code>{login().userCode}</code>
              <small>Waiting for OpenAI… expires {new Date(login().expiresAt).toLocaleTimeString()}.</small>
            </div>}
          </Show>
          <ActionRow class="settings-actions oauth-actions">
            <button onClick={() => startOAuth(meta.id)} disabled={saving()}>{provider()?.hasAccessToken ? "Reconnect " + meta.title : "Connect " + meta.title}</button>
            <button class="secondary" onClick={() => logoutOAuth(meta.id)} disabled={saving()}>Disconnect</button>
          </ActionRow>
        </Show>
        <div class="settings-row">
          <label><span>Base URL override</span><input value={draft().baseUrl} onInput={(e) => updateDraft(meta.id, { baseUrl: e.currentTarget.value })} placeholder={meta.defaultBaseUrl} /></label>
        </div>
      </section>
    );
  }

  return (
    <PageShell class="llm-auth-shell" mainClass="llm-auth-main">
        <PageHeader
          bag={props.bag}
          class="settings-page-header"
          title="Settings"
          onToggleSidebar={props.onToggleSidebar}
          actions={<button type="button" class="settings-header-save" onClick={save} disabled={saving()}>{saving() ? "Saving…" : "Save"}</button>}
        />
        <PageBody class="settings-view">
          <section class="settings-panel" aria-labelledby="settings-panel-title">
            <h1 id="settings-panel-title" class="sr-only">Settings</h1>
            <Show when={error()}><Notice class="settings-error" tone="error">{error()}</Notice></Show>
            <div class="settings-layout">
                <TabBar
                  class="settings-tabs"
                  items={SETTINGS_TABS}
                  activeId={activeTab()}
                  onSelect={(id) => setActiveTab(id)}
                  ariaLabel="Settings categories"
                  tabId={(id) => `settings-tab-${id}`}
                  panelId={(id) => `settings-pane-${id}`}
                />
                <div class="settings-tab-content">
                  <section
                    class="settings-tab-panel"
                    role="tabpanel"
                    id="settings-pane-providers"
                    aria-labelledby="settings-tab-providers"
                    hidden={activeTab() !== "providers"}
                  >
                    <section class="settings-grid llm-provider-grid" aria-label="LLM provider settings">
                      <For each={PROVIDERS}>{providerCard}</For>
                    </section>
                  </section>
                  <section
                    class="settings-tab-panel"
                    role="tabpanel"
                    id="settings-pane-runtime"
                    aria-labelledby="settings-tab-runtime"
                    hidden={activeTab() !== "runtime"}
                  >
                    <div class="settings-grid runtime-settings-grid">
                      <Card class="settings-card v8-settings-card">
                        <h2>V8 runtime</h2>
                        <Show when={v8Settings()}>
                          {(v8) => <>
                            <div class="v8-preset-row" aria-label="V8 presets">
                              <button type="button" class="secondary" onClick={() => useV8Preset("tiny")}>Tiny</button>
                              <button type="button" class="secondary" onClick={() => useV8Preset("balanced")}>Balanced</button>
                              <button type="button" class="secondary" onClick={() => useV8Preset("roomy")}>Roomy</button>
                            </div>
                            <div class="settings-row v8-pool-settings">
                              <For each={[
                                { key: "mainPool" as const, title: "Main pool" },
                                { key: "readPool" as const, title: "Read pool" },
                                { key: "scanPool" as const, title: "Scan pool" },
                                { key: "toolPool" as const, title: "Async tool pool" },
                              ]}>
                                {(pool) => {
                                  const value = () => v8().settings[pool.key] ?? { maxWorkers: null, maxOldGenerationBytes: null, maxYoungGenerationBytes: null, recycleUsedHeapBytes: null };
                                  return (
                                    <fieldset class="v8-pool-fieldset">
                                      <legend>{pool.title}</legend>
                                      <label>
                                        <span>Workers</span>
                                        <input type="number" min="1" max="128" value={value().maxWorkers ?? ""} onInput={(e) => patchV8Pool(pool.key, { maxWorkers: intOrNull(e.currentTarget.value) })} />
                                      </label>
                                      <label>
                                        <span>Old generation cap (MiB)</span>
                                        <input type="number" min="1" value={mib(value().maxOldGenerationBytes)} onInput={(e) => patchV8Pool(pool.key, { maxOldGenerationBytes: mibToBytes(e.currentTarget.value) })} />
                                      </label>
                                      <label>
                                        <span>Young generation cap (MiB)</span>
                                        <input type="number" min="1" value={mib(value().maxYoungGenerationBytes)} onInput={(e) => patchV8Pool(pool.key, { maxYoungGenerationBytes: mibToBytes(e.currentTarget.value) })} />
                                      </label>
                                      <label>
                                        <span>Recycle after used heap (MiB)</span>
                                        <input type="number" min="1" value={mib(value().recycleUsedHeapBytes)} onInput={(e) => patchV8Pool(pool.key, { recycleUsedHeapBytes: mibToBytes(e.currentTarget.value) })} />
                                      </label>
                                    </fieldset>
                                  );
                                }}
                              </For>
                            </div>
                            <label class="toggle-row">
                              <input type="checkbox" checked={!!v8().settings.startupSnapshotsEnabled} onChange={(e) => patchV8({ startupSnapshotsEnabled: e.currentTarget.checked })} />
                              <span>Reuse startup snapshots</span>
                            </label>
                            <div class="v8-effective-box">
                              <strong>Effective now</strong>
                              <span>main {v8().effective.mainPool?.maxWorkers} / {mib(v8().effective.mainPool?.maxOldGenerationBytes)} MiB · read {v8().effective.readPool?.maxWorkers} / {mib(v8().effective.readPool?.maxOldGenerationBytes)} MiB · scan {v8().effective.scanPool?.maxWorkers} / {mib(v8().effective.scanPool?.maxOldGenerationBytes)} MiB · tools {v8().effective.toolPool?.maxWorkers} / {mib(v8().effective.toolPool?.maxOldGenerationBytes)} MiB</span>
                            </div>
                            <p class="settings-help">Heap and recycle changes apply to new isolates; pool worker caps change after restart.</p>
                          </>}
                        </Show>
                      </Card>
                    </div>
                  </section>
                  <section
                    class="settings-tab-panel"
                    role="tabpanel"
                    id="settings-pane-traces"
                    aria-labelledby="settings-tab-traces"
                    hidden={activeTab() !== "traces"}
                  >
                    <div class="settings-grid trace-settings-grid">
                      <Card class="settings-card">
                        <h2>ClickHouse tracing</h2>
                        <Show when={traceSettings()}>
                          {(trace) => <>
                            <label class="toggle-row">
                              <input type="checkbox" checked={trace().config.enabled} onChange={(e) => patchTrace({ enabled: e.currentTarget.checked })} />
                              <span>Enable ClickHouse tracing</span>
                            </label>
                            <div class="settings-row trace-settings-fields">
                              <label>
                                <span>ClickHouse URL</span>
                                <input value={trace().config.clickhouseUrl} onInput={(e) => patchTrace({ clickhouseUrl: e.currentTarget.value })} />
                              </label>
                              <label>
                                <span>Database</span>
                                <input value={trace().config.clickhouseDatabase} onInput={(e) => patchTrace({ clickhouseDatabase: e.currentTarget.value })} />
                              </label>
                              <label>
                                <span>Table prefix</span>
                                <input value={trace().config.clickhouseTablePrefix} onInput={(e) => patchTrace({ clickhouseTablePrefix: e.currentTarget.value })} />
                              </label>
                              <label>
                                <span>User</span>
                                <input value={trace().config.clickhouseUser ?? ""} onInput={(e) => patchTrace({ clickhouseUser: e.currentTarget.value || null })} />
                              </label>
                              <label>
                                <span>Password</span>
                                <input type="password" value={trace().config.clickhousePassword ?? ""} onInput={(e) => patchTrace({ clickhousePassword: e.currentTarget.value || null })} />
                              </label>
                            </div>
                            <InlineActions class="settings-actions trace-test-actions">
                              <button type="button" class="secondary" onClick={testTraceConfig} disabled={testingTrace() || saving()}>
                                {testingTrace() ? "Testing…" : "Test"}
                              </button>
                              <Show when={traceTestMessage()}>
                                {(message) => <span class="settings-success trace-test-message">{message()}</span>}
                              </Show>
                            </InlineActions>
                            <p class="settings-help">{trace().note || "Restart required for trace config changes to affect the running process."}</p>
                          </>}
                        </Show>
                      </Card>
                    </div>
                  </section>
                  <section
                    class="settings-tab-panel"
                    role="tabpanel"
                    id="settings-pane-behavior"
                    aria-labelledby="settings-tab-behavior"
                    hidden={activeTab() !== "behavior"}
                  >
                    <div class="settings-grid behavior-settings-grid">
                      <Card class="settings-card behavior-settings-card">
                        <div class="settings-form-section">
                          <h2>Compaction</h2>
                          <div class="settings-row compact">
                            <label>
                              <span>Threshold (% of max tokens)</span>
                              <input type="number" min="1" max="100" value={compactionThresholdPercent()} onInput={(e) => setCompactionThresholdPercent(e.currentTarget.value)} />
                            </label>
                          </div>
                          <p class="settings-help">Compact before a prompt reaches this share of the context window.</p>
                        </div>
                        <div class="settings-form-section">
                          <h2>Retries</h2>
                          <div class="settings-row three">
                            <label><span>Max attempts</span><input type="number" min="1" max="20" value={maxAttempts()} onInput={(e) => setMaxAttempts(e.currentTarget.value)} /></label>
                            <label><span>Base delay (ms)</span><input type="number" min="0" value={baseDelayMs()} onInput={(e) => setBaseDelayMs(e.currentTarget.value)} /></label>
                            <label><span>Max delay (ms)</span><input type="number" min="0" value={maxDelayMs()} onInput={(e) => setMaxDelayMs(e.currentTarget.value)} /></label>
                            <label><span>Jitter (ms)</span><input type="number" min="0" value={jitterMs()} onInput={(e) => setJitterMs(e.currentTarget.value)} /></label>
                            <label><span>Max Retry-After (ms)</span><input type="number" min="0" value={maxRetryAfterMs()} onInput={(e) => setMaxRetryAfterMs(e.currentTarget.value)} /></label>
                          </div>
                        </div>
                      </Card>
                    </div>
                  </section>
                </div>
              </div>
          </section>
        </PageBody>
    </PageShell>
  );
}
