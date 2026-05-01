import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { api } from "./api";
import type { Bag } from "./state";

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
  const [srcdoc, setSrcdoc] = createSignal<string>("");
  const [title, setTitle] = createSignal<string>("app");
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

  createEffect(async () => {
    const uiId = bag.openUiId();
    if (!uiId) return;
    const r = await api.uiBundle(uiId);
    if (!r.ok) { setSrcdoc(`<p>${r.error.message}</p>`); return; }
    setTitle(r.value.manifest.title || uiId);
    const b = r.value.bundle;
    const html = b.html ?? b.files?.[r.value.manifest.entry || "index.html"] ?? "";
    const css = b.css ?? b.files?.["style.css"] ?? "";
    const js = b.js ?? b.files?.["client.js"] ?? "";
    setSrcdoc(buildUiSrcdoc(html, css, js));
  });

  const onMessage = async (ev: MessageEvent) => {
    if (ev.source !== frame?.contentWindow) return;
    const msg = ev.data || {};
    if (!msg || typeof msg !== "object" || msg.source !== "moo-ui" || !msg.id) return;
    const reply = (payload: Record<string, unknown>) => frame?.contentWindow?.postMessage({ source: "moo-host", id: msg.id, ...payload }, "*");
    try {
      if (msg.method === "state:get") {
        const inst = bag.openUiInstanceId();
        if (!inst) throw new Error("no UI instance is open");
        const r = await api.uiStateGet(inst);
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value.state });
      } else if (msg.method === "state:set") {
        const inst = bag.openUiInstanceId();
        if (!inst) throw new Error("no UI instance is open");
        const r = await api.uiStateSet(inst, msg.state ?? {});
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value.state });
      } else if (msg.method === "call") {
        const uiId = bag.openUiId();
        if (!uiId) throw new Error("no UI is open");
        const r = await api.uiCall(uiId, bag.openUiInstanceId(), bag.chatId(), String(msg.name || "default"), msg.input ?? {});
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value });
      } else if (msg.method === "memory:query") {
        const r = await api.memoryQuery(msg.patterns ?? [], msg.opts ?? undefined);
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value });
      } else if (msg.method === "memory:triples") {
        const r = await api.triples(
          typeof msg.subject === "string" ? msg.subject : undefined,
          typeof msg.predicate === "string" ? msg.predicate : undefined,
          typeof msg.object === "string" ? msg.object : undefined,
          msg.opts ?? undefined,
        );
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value });
      } else if (msg.method === "memory:assert") {
        const r = await api.assert(String(msg.subject ?? ""), String(msg.predicate ?? ""), String(msg.object ?? ""), msg.opts ?? undefined);
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value });
      } else if (msg.method === "memory:patch") {
        const r = await api.memoryPatch(Array.isArray(msg.groups) ? msg.groups : [], msg.opts ?? undefined);
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value });
      } else if (msg.method === "memory:retract") {
        const r = await api.retract(String(msg.subject ?? ""), String(msg.predicate ?? ""), String(msg.object ?? ""), msg.opts ?? undefined);
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
            class="icon-btn"
            title={maximized() ? "restore app panel" : "maximize app panel"}
            onClick={() => setMaximized(!maximized())}
          >
            {maximized() ? "↙" : "⛶"}
          </button>
        </Show>
        <button class="icon-btn" title="close app" onClick={() => bag.closeUi()}>×</button>
      </header>
      <iframe ref={frame} class="ui-frame" srcdoc={srcdoc()} />
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
        assert: (subject, predicate, object, opts) => window.moo.request('memory:assert', { subject, predicate, object, opts }),
        retract: (subject, predicate, object, opts) => window.moo.request('memory:retract', { subject, predicate, object, opts }),
        patch: (groups, opts) => window.moo.request('memory:patch', { groups, opts }),
        project: (project) => ({
          query: (patterns, opts) => window.moo.memory.query(patterns, { ...(opts || {}), project }),
          triples: (subject, predicate, object, opts) => window.moo.memory.triples(subject, predicate, object, { ...(opts || {}), project }),
          assert: (subject, predicate, object, opts) => window.moo.memory.assert(subject, predicate, object, { ...(opts || {}), project }),
          retract: (subject, predicate, object, opts) => window.moo.memory.retract(subject, predicate, object, { ...(opts || {}), project }),
          patch: (groups, opts) => window.moo.memory.patch(groups, { ...(opts || {}), project }),
        }),
      },
      call: (name, input) => window.moo.request('call', { name, input }),
      open: (uiId, instanceId) => window.moo.request('open', { uiId, instanceId }),
    };
  `;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${appHtml}<script>${autofocus}<\/script><script>${sdk}<\/script><script>${js}<\/script></body></html>`;
}
