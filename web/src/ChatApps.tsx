import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";

import { api } from "./api";
import type { Bag } from "./state";
import { CloseIcon, MaximizeIcon, RestoreIcon } from "./icons";

export function ChatAppLauncher(props: { bag: Bag }) {
  const { bag } = props;
  const visibleApps = createMemo(() => {
    const open = bag.openUiId();
    return bag.chatUiApps().filter((app) => app.id !== open);
  });

  return (
    <Show when={visibleApps().length > 0}>
      <div class="chat-app-launcher" aria-label="chat apps">
        <span class="chat-app-launcher-label">app ready</span>
        <For each={visibleApps()}>
          {(app) => (
            <button
              type="button"
              class="chat-app-launcher-button"
              title={app.description || ("Open " + (app.title || app.id))}
              onClick={() => bag.openUi(app.id)}
            >
              <span class="app-icon">{app.icon || "▣"}</span>
              <span>{app.title || app.id}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

export function UiPanel(props: { bag: Bag; embedded?: boolean }) {
  const { bag } = props;
  const storedPanelWidth = Number(localStorage.getItem("moo.uiPanelWidth"));
  const defaultPanelWidth = Math.round(window.innerWidth * 0.42);
  const activeAppTab = createMemo(() => {
    const tab = bag.activeRightSidebarTab();
    return tab?.kind === "app" ? tab : null;
  });
  const activeUiId = () => activeAppTab()?.uiId ?? bag.openUiId();
  const activeInstanceId = () => activeAppTab()?.instanceId ?? bag.openUiInstanceId();
  const activeAppKey = () => activeUiId() ? `${activeUiId()}::${activeInstanceId() ?? ""}` : null;
  const [srcdoc, setSrcdoc] = createSignal<string>("");
  const [title, setTitle] = createSignal<string>("app");
  const [frameKey, setFrameKey] = createSignal(0);
  const frameDoc = createMemo(() => srcdoc() ? { key: frameKey(), doc: srcdoc() } : null);
  const [panelWidth, setPanelWidth] = createSignal(
    Number.isFinite(storedPanelWidth) && storedPanelWidth > 0
      ? storedPanelWidth
      : defaultPanelWidth,
  );
  const [maximized, setMaximized] = createSignal(false);
  const [resizing, setResizing] = createSignal(false);
  let frame: HTMLIFrameElement | undefined;
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  const clampPanelWidth = (width: number) => {
    const shellWidth = frame?.closest(".chat-shell")?.getBoundingClientRect().width || window.innerWidth;
    const min = Math.max(240, Math.min(352, shellWidth - 80));
    const max = Math.max(min, Math.min(shellWidth - 160, shellWidth * 0.85));
    return Math.round(Math.max(min, Math.min(max, width)));
  };

  const stopResize = () => {
    if (!dragging) return;
    dragging = false;
    setResizing(false);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  };

  const onResizeMove = (ev: MouseEvent) => {
    if (!dragging) return;
    setPanelWidth(clampPanelWidth(startWidth + startX - ev.clientX));
  };

  const startResize = (ev: MouseEvent) => {
    if (props.embedded || maximized()) return;
    ev.preventDefault();
    dragging = true;
    setResizing(true);
    startX = ev.clientX;
    startWidth = panelWidth();
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };

  createEffect(() => {
    localStorage.setItem("moo.uiPanelWidth", String(clampPanelWidth(panelWidth())));
  });

  window.addEventListener("mousemove", onResizeMove);
  window.addEventListener("mouseup", stopResize);
  onCleanup(() => {
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", stopResize);
    stopResize();
  });

  createEffect(on(
    activeAppKey,
    async (appKey) => {
      const uiId = activeUiId();
      if (!uiId) {
        setSrcdoc("");
        setTitle("app");
        setFrameKey((key) => key + 1);
        return;
      }
      const r = await api.ui.bundle(uiId);
      if (activeAppKey() !== appKey) return;
      if (!r.ok) { setSrcdoc(`<p>${r.error.message}</p>`); setFrameKey((key) => key + 1); return; }
      setTitle(r.value.manifest.title || uiId);
      const b = r.value.bundle;
      const html = b.html ?? b.files?.[r.value.manifest.entry || "index.html"] ?? "";
      const css = b.css ?? b.files?.["style.css"] ?? "";
      const js = b.js ?? b.files?.["client.js"] ?? "";
      setSrcdoc(buildUiSrcdoc(html, css, js));
      setFrameKey((key) => key + 1);
    },
  ));

  const onMessage = async (ev: MessageEvent) => {
    if (ev.source !== frame?.contentWindow) return;
    const msg = ev.data || {};
    if (!msg || typeof msg !== "object" || msg.source !== "moo-ui" || !msg.id) return;
    const reply = (payload: Record<string, unknown>) => frame?.contentWindow?.postMessage({ source: "moo-host", id: msg.id, ...payload }, "*");
    try {
      if (msg.method === "state:get") {
        const inst = activeInstanceId();
        if (!inst) throw new Error("no UI instance is open");
        const r = await api.ui.state.get(inst);
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value.state });
      } else if (msg.method === "state:set") {
        const inst = activeInstanceId();
        if (!inst) throw new Error("no UI instance is open");
        const r = await api.ui.state.set(inst, msg.state ?? {});
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value.state });
      } else if (msg.method === "call") {
        const uiId = activeUiId();
        if (!uiId) throw new Error("no UI is open");
        const r = await api.ui.call({ uiId, instanceId: activeInstanceId(), chatId: bag.chatId(), name: String(msg.name || "default"), input: msg.input ?? {} });
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value });
      } else if (msg.method === "memory:query") {
        const r = await api.memory.query(msg.patterns ?? [], msg.opts ?? undefined);
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value });
      } else if (msg.method === "memory:triples") {
        const r = await api.memory.triples({
          subject: typeof msg.subject === "string" ? msg.subject : undefined,
          predicate: typeof msg.predicate === "string" ? msg.predicate : undefined,
          object: typeof msg.object === "string" ? msg.object : undefined,
          ...((msg.opts && typeof msg.opts === "object") ? msg.opts : {}),
        });
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value });
      } else if (msg.method === "memory:assert") {
        const r = await api.memory.assert({ subject: String(msg.subject ?? ""), predicate: String(msg.predicate ?? ""), object: String(msg.object ?? ""), ...(msg.opts ?? {}) });
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value });
      } else if (msg.method === "memory:retract") {
        const r = await api.memory.retract({ subject: String(msg.subject ?? ""), predicate: String(msg.predicate ?? ""), object: String(msg.object ?? ""), ...(msg.opts ?? {}) });
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value });
      } else if (msg.method === "open") {
        bag.openUi(String(msg.uiId), msg.instanceId ? String(msg.instanceId) : undefined);
        reply({ ok: true, value: null });
      } else {
        throw new Error(`unknown UI method: ${msg.method}`);
      }
    } catch (err) {
      reply({ ok: false, error: { message: err instanceof Error ? err.message : String(err) } });
    }
  };
  window.addEventListener("message", onMessage);
  onCleanup(() => window.removeEventListener("message", onMessage));

  return (
    <aside
      class="ui-panel"
      classList={{ maximized: !props.embedded && maximized(), resizing: resizing(), embedded: props.embedded }}
      style={{ "--ui-panel-w": `${clampPanelWidth(panelWidth())}px` }}
    >
      <Show when={!props.embedded && !maximized()}>
        <div
          class="ui-panel-resizer"
          title="resize app panel"
          onMouseDown={startResize}
          onDblClick={() => setMaximized(true)}
        />
      </Show>
      <header class="ui-panel-header">
        <strong>{title()}</strong>
        <Show when={!props.embedded}>
          <button
            class="header-icon-button right-sidebar-size-toggle"
            classList={{ maximized: maximized() }}
            title={maximized() ? "restore app panel" : "maximize app panel"}
            aria-label={maximized() ? "restore app panel" : "maximize app panel"}
            aria-pressed={maximized()}
            onClick={() => setMaximized(!maximized())}
          >
            {maximized() ? <RestoreIcon /> : <MaximizeIcon />}
          </button>
        </Show>
        <button class="header-icon-button" title="close app" onClick={() => bag.closeUi()}><CloseIcon /></button>
      </header>
      <Show when={frameDoc()} keyed>
        {(doc) => <iframe ref={frame} class="ui-frame" data-ui-frame-key={doc.key} srcdoc={doc.doc} />}
      </Show>
    </aside>
  );
}

function disableParserAutofocus(html: string): string {
  // Browser parser-level autofocus can race with the host composer focus and emit
  // "Autofocus processing was blocked because a document already has a focused element."
  // Preserve the app author's intent without using the special HTML attribute.
  return html.replace(/\sautofocus(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gi, ' data-moo-autofocus="true"');
}

function buildUiSrcdoc(html: string, css: string, js: string): string {
  const appHtml = disableParserAutofocus(html);
  const autofocus = `
    (() => {
      const focusAutofocusElement = () => {
        const active = document.activeElement;
        if (active && active !== document.body && active !== document.documentElement) return;
        const el = document.querySelector('[data-moo-autofocus]');
        if (!el || typeof el.focus !== 'function') return;
        requestAnimationFrame(() => el.focus({ preventScroll: true }));
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', focusAutofocusElement, { once: true });
      } else {
        focusAutofocusElement();
      }
    })();
  `;
  const sdk = `
    window.moo = {
      request(method, payload) {
        const id = Math.random().toString(36).slice(2);
        parent.postMessage({ source: 'moo-ui', id, method, ...(payload || {}) }, '*');
        return new Promise((resolve, reject) => {
          const onMessage = (ev) => {
            const msg = ev.data || {};
            if (msg.source !== 'moo-host' || msg.id !== id) return;
            window.removeEventListener('message', onMessage);
            msg.ok ? resolve(msg.value) : reject(new Error(msg.error?.message || 'moo request failed'));
          };
          window.addEventListener('message', onMessage);
        });
      },
      state: { get: () => window.moo.request('state:get'), set: (state) => window.moo.request('state:set', { state }) },
      memory: {
        query: (patterns, opts) => window.moo.request('memory:query', { patterns, opts }),
        triples: (subject, predicate, object, opts) => window.moo.request('memory:triples', { subject, predicate, object, opts }),
        assert: (args) => window.moo.request('memory:assert', args || {}),
        retract: (args) => window.moo.request('memory:retract', args || {}),
        project: (project) => ({
          query: (patterns, opts) => window.moo.memory.query(patterns, { ...(opts || {}), project }),
          triples: (subject, predicate, object, opts) => window.moo.memory.triples(subject, predicate, object, { ...(opts || {}), project }),
          assert: (args) => window.moo.memory.assert({ ...(args || {}), project }),
          retract: (args) => window.moo.memory.retract({ ...(args || {}), project }),
        }),
      },
      call: (name, input) => window.moo.request('call', { name, input }),
      open: (uiId, instanceId) => window.moo.request('open', { uiId, instanceId }),
    };
  `;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${appHtml}<script>${autofocus}<\/script><script>${sdk}<\/script><script>${js}<\/script></body></html>`;
}
