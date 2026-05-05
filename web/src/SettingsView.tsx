import { For, Show, createSignal, onMount } from "solid-js";

import { api, type LlmAuthMode, type LlmAuthSettings, type LlmProviderId, type V8RuntimeSettings, type V8SettingsValue } from "./api";
import { RightSidebarToggle } from "./Sidebar";
import type { Bag } from "./state";

type ProviderMeta = {
  id: LlmProviderId;
  title: string;
  envLabel: string;
  defaultBaseUrl: string;
  supportsOAuth?: boolean;
};

type ProviderDraft = {
  authMode: LlmAuthMode;
  apiKey: string;
  baseUrl: string;
};

const PROVIDERS: ProviderMeta[] = [
  { id: "openai", title: "OpenAI", envLabel: "OPENAI_API_KEY", defaultBaseUrl: "https://api.openai.com/v1", supportsOAuth: true },
  { id: "anthropic", title: "Anthropic", envLabel: "ANTHROPIC_API_KEY", defaultBaseUrl: "https://api.anthropic.com/v1" },
  { id: "qwen", title: "Qwen", envLabel: "QWEN_API_KEY or DASHSCOPE_API_KEY", defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
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

export function SettingsView(props: { bag: Bag; onToggleSidebar: () => void }) {
  const [settings, setSettings] = createSignal<LlmAuthSettings | null>(null);
  const [v8Settings, setV8Settings] = createSignal<V8SettingsValue | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [deviceLogin, setDeviceLogin] = createSignal<{ state: string; verificationUrl: string; userCode: string; expiresAt: number } | null>(null);
  const [drafts, setDrafts] = createSignal<Record<LlmProviderId, ProviderDraft>>({
    openai: blankDraft(),
    anthropic: blankDraft(),
    qwen: blankDraft(),
  });
  const [compactionThresholdPercent, setCompactionThresholdPercent] = createSignal("50");
  const [maxAttempts, setMaxAttempts] = createSignal("3");
  const [baseDelayMs, setBaseDelayMs] = createSignal("750");
  const [maxDelayMs, setMaxDelayMs] = createSignal("8000");
  const [jitterMs, setJitterMs] = createSignal("250");
  const [maxRetryAfterMs, setMaxRetryAfterMs] = createSignal("1800000");

  function updateDraft(id: LlmProviderId, patch: Partial<ProviderDraft>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  function hydrate(next: LlmAuthSettings) {
    setSettings(next);
    const providerDrafts: Record<LlmProviderId, ProviderDraft> = { openai: blankDraft(), anthropic: blankDraft(), qwen: blankDraft() };
    for (const meta of PROVIDERS) {
      const p = next.providers[meta.id];
      providerDrafts[meta.id] = {
        authMode: p.authMode,
        apiKey: p.hasApiKey ? "••••" : "",
        baseUrl: p.baseUrl || "",
      };
    }
    setDrafts(providerDrafts);
    setCompactionThresholdPercent(numberOrBlank(next.compaction?.thresholdPercent ?? 50));
    setMaxAttempts(numberOrBlank(next.retries.maxAttempts));
    setBaseDelayMs(numberOrBlank(next.retries.baseDelayMs));
    setMaxDelayMs(numberOrBlank(next.retries.maxDelayMs));
    setJitterMs(numberOrBlank(next.retries.jitterMs));
    setMaxRetryAfterMs(numberOrBlank(next.retries.maxRetryAfterMs));
  }

  async function load() {
    setLoading(true);
    setError(null);
    const [r, v8] = await Promise.all([api.llmAuth.get(), api.v8.settings()]);
    setLoading(false);
    if (r.ok) hydrate(r.value.settings);
    else setError(r.error.message);
    if (v8.ok) setV8Settings(v8.value);
    else setError(v8.error.message);
  }

  async function save() {
    setSaving(true);
    setError(null);
    const d = drafts();
    const currentV8 = v8Settings();
    const v8 = currentV8 ? await api.v8.saveSettings(currentV8.settings) : await api.v8.settings();
    if (!v8.ok) {
      setSaving(false);
      setError(v8.error.message);
      return;
    }
    setV8Settings(v8.value);
    const r = await api.llmAuth.save({
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
    });
    setSaving(false);
    if (r.ok) hydrate(r.value.settings);
    else setError(r.error.message);
  }

  async function startOAuth(id: LlmProviderId) {
    setSaving(true);
    setError(null);
    setDeviceLogin(null);
    const r = await api.llmAuth.oauthDeviceStart(id);
    setSaving(false);
    if (r.ok) {
      setDeviceLogin(r.value.device);
      window.open(r.value.device.verificationUrl, "_blank", "noopener,noreferrer");
      void pollDeviceLogin(r.value.device.state, r.value.device.interval);
    } else setError(r.error.message);
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
        if (r.value.settings) hydrate(r.value.settings);
        return;
      }
    }
  }

  async function logoutOAuth(id: LlmProviderId) {
    setSaving(true);
    setError(null);
    setDeviceLogin(null);
    const r = await api.llmAuth.oauthLogout(id);
    setSaving(false);
    if (r.ok) hydrate(r.value.settings);
    else setError(r.error.message);
  }

  function patchV8(patch: Partial<V8RuntimeSettings>) {
    setV8Settings((prev) => prev ? { ...prev, settings: { ...prev.settings, ...patch } } : prev);
  }


  function useV8Preset(name: "tiny" | "balanced" | "roomy") {
    const presets: Record<typeof name, V8RuntimeSettings> = {
      tiny: {
        maxWorkers: 4,
        maxOldGenerationBytes: 64 * 1024 * 1024,
        maxYoungGenerationBytes: 8 * 1024 * 1024,
        recycleUsedHeapBytes: 48 * 1024 * 1024,
        startupSnapshotsEnabled: true,
      },
      balanced: {
        maxWorkers: 16,
        maxOldGenerationBytes: 128 * 1024 * 1024,
        maxYoungGenerationBytes: 16 * 1024 * 1024,
        recycleUsedHeapBytes: 96 * 1024 * 1024,
        startupSnapshotsEnabled: true,
      },
      roomy: {
        maxWorkers: 16,
        maxOldGenerationBytes: 256 * 1024 * 1024,
        maxYoungGenerationBytes: 32 * 1024 * 1024,
        recycleUsedHeapBytes: 192 * 1024 * 1024,
        startupSnapshotsEnabled: true,
      },
    };
    setV8Settings((prev) => prev ? { ...prev, settings: presets[name] } : prev);
  }

  onMount(load);

  function providerCard(meta: ProviderMeta) {
    const draft = () => drafts()[meta.id];
    const provider = () => settings()?.providers[meta.id];
    const canOAuth = !!meta.supportsOAuth;
    return (
      <div class="settings-card llm-provider-card">
        <h2>{meta.title}</h2>
        <label class="field-label">Auth mode</label>
        <select value={draft().authMode} onInput={(e) => updateDraft(meta.id, { authMode: e.currentTarget.value as LlmAuthMode })}>
          <option value="env">Environment variable ({meta.envLabel})</option>
          <option value="apiKey">Stored API key</option>
          <Show when={canOAuth}><option value="oauth">OAuth</option></Show>
        </select>
        <Show when={draft().authMode === "apiKey"}>
          <label class="field-label">API key</label>
          <input type="password" value={draft().apiKey} onInput={(e) => updateDraft(meta.id, { apiKey: e.currentTarget.value })} placeholder="secret key" />
        </Show>
        <Show when={draft().authMode === "oauth" && canOAuth}>
          <div class="oauth-status">
            <strong>{provider()?.hasAccessToken ? "OAuth connected" : "OAuth not connected"}</strong>
            <span>{provider()?.expiresAt ? "token expires " + new Date(provider()!.expiresAt!).toLocaleString() : ""}</span>
          </div>
          <p class="oauth-help">Uses OpenAI's first-party Codex device login, like <code>codex login</code>; no OAuth client setup is required.</p>
          <Show when={deviceLogin()}>
            {(login) => <div class="device-login-box">
              <p>Open <a href={login().verificationUrl} target="_blank" rel="noreferrer">{login().verificationUrl}</a> and enter:</p>
              <code>{login().userCode}</code>
              <small>Waiting for OpenAI… expires {new Date(login().expiresAt).toLocaleTimeString()}.</small>
            </div>}
          </Show>
          <div class="settings-actions">
            <button onClick={() => startOAuth(meta.id)} disabled={saving()}>{provider()?.hasAccessToken ? "Reconnect " + meta.title : "Connect " + meta.title}</button>
            <button class="secondary" onClick={() => logoutOAuth(meta.id)} disabled={saving() || !provider()?.hasAccessToken}>Disconnect</button>
          </div>
        </Show>
        <div class="settings-row">
          <label><span>Base URL override</span><input value={draft().baseUrl} onInput={(e) => updateDraft(meta.id, { baseUrl: e.currentTarget.value })} placeholder={meta.defaultBaseUrl} /></label>
        </div>
      </div>
    );
  }

  return (
    <div class="chat-shell llm-auth-shell">
      <section class="main llm-auth-main">
        <header class="conv-header">
          <button class="header-icon-button" title="toggle sidebar" aria-label="toggle sidebar" onClick={props.onToggleSidebar}>☰</button>
          <button class="header-icon-button" title="back to chat" onClick={() => props.bag.showChat()}>←</button>
          <strong>Settings</strong>
          <small class="conv-stats">LLM providers</small>
          <RightSidebarToggle bag={props.bag} />
        </header>
        <main class="timeline settings-view">
          <div class="settings-hero">
            <h1>Settings</h1>
            <p>Configure LLM provider credentials, base URLs, retry behavior, and V8 runtime defaults. Model choice stays in the chat model picker.</p>
          </div>
          <Show when={error()}><div class="settings-error">{error()}</div></Show>
          <Show when={loading()}><div class="settings-card">Loading…</div></Show>
          <Show when={!loading()}>
            <section class="settings-grid llm-provider-grid">
              <For each={PROVIDERS}>{providerCard}</For>
              <div class="settings-card">
                <h2>Compaction</h2>
                <div class="settings-row two">
                  <label>
                    <span>Threshold (% of max tokens)</span>
                    <input type="number" min="1" max="100" value={compactionThresholdPercent()} onInput={(e) => setCompactionThresholdPercent(e.currentTarget.value)} />
                  </label>
                </div>
                <p class="settings-help">Automatically compact when the estimated next prompt reaches this percentage of the model context window.</p>
              </div>
              <div class="settings-card v8-settings-card">
                <h2>V8 runtime</h2>
                <Show when={v8Settings()}>
                  {(v8) => <>
                    <div class="v8-preset-row" aria-label="V8 presets">
                      <button type="button" class="secondary" onClick={() => useV8Preset("tiny")}>Tiny</button>
                      <button type="button" class="secondary" onClick={() => useV8Preset("balanced")}>Balanced</button>
                      <button type="button" class="secondary" onClick={() => useV8Preset("roomy")}>Roomy</button>
                    </div>
                    <div class="settings-row two">
                      <label>
                        <span>Worker cap</span>
                        <input type="number" min="1" max="128" value={v8().settings.maxWorkers ?? ""} onInput={(e) => patchV8({ maxWorkers: intOrNull(e.currentTarget.value) })} />
                      </label>
                      <label>
                        <span>Old generation cap (MiB)</span>
                        <input type="number" min="1" value={mib(v8().settings.maxOldGenerationBytes)} onInput={(e) => patchV8({ maxOldGenerationBytes: mibToBytes(e.currentTarget.value) })} />
                      </label>
                      <label>
                        <span>Young generation cap (MiB)</span>
                        <input type="number" min="1" value={mib(v8().settings.maxYoungGenerationBytes)} onInput={(e) => patchV8({ maxYoungGenerationBytes: mibToBytes(e.currentTarget.value) })} />
                      </label>
                      <label>
                        <span>Recycle after used heap (MiB)</span>
                        <input type="number" min="1" value={mib(v8().settings.recycleUsedHeapBytes)} onInput={(e) => patchV8({ recycleUsedHeapBytes: mibToBytes(e.currentTarget.value) })} />
                      </label>
                    </div>
                    <label class="toggle-row">
                      <input type="checkbox" checked={!!v8().settings.startupSnapshotsEnabled} onChange={(e) => patchV8({ startupSnapshotsEnabled: e.currentTarget.checked })} />
                      <span>Reuse startup snapshots</span>
                    </label>
                    <div class="v8-effective-box">
                      <strong>Effective now</strong>
                      <span>{v8().effective.maxWorkers} workers · old {mib(v8().effective.maxOldGenerationBytes)} MiB · young {mib(v8().effective.maxYoungGenerationBytes)} MiB · recycle {mib(v8().effective.recycleUsedHeapBytes)} MiB</span>
                    </div>
                    <p class="settings-help">Heap and snapshot changes apply to new isolates immediately. Worker cap changes on restart.</p>
                  </>}
                </Show>
              </div>
              <div class="settings-card">
                <h2>Retries</h2>
                <div class="settings-row two">
                  <label><span>Max attempts</span><input type="number" min="1" max="20" value={maxAttempts()} onInput={(e) => setMaxAttempts(e.currentTarget.value)} /></label>
                  <label><span>Base delay (ms)</span><input type="number" min="0" value={baseDelayMs()} onInput={(e) => setBaseDelayMs(e.currentTarget.value)} /></label>
                  <label><span>Max delay (ms)</span><input type="number" min="0" value={maxDelayMs()} onInput={(e) => setMaxDelayMs(e.currentTarget.value)} /></label>
                  <label><span>Jitter (ms)</span><input type="number" min="0" value={jitterMs()} onInput={(e) => setJitterMs(e.currentTarget.value)} /></label>
                  <label><span>Max Retry-After (ms)</span><input type="number" min="0" value={maxRetryAfterMs()} onInput={(e) => setMaxRetryAfterMs(e.currentTarget.value)} /></label>
                </div>
              </div>
            </section>
            <div class="settings-footer"><button onClick={save} disabled={saving()}>{saving() ? "Saving…" : "Save settings"}</button></div>
          </Show>
        </main>
      </section>
    </div>
  );
}
