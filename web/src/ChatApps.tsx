import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

import { api } from "./api";
import type { Bag } from "./state";
import { storage } from "./storage";
import { CloseIcon, MaximizeIcon, RestoreIcon } from "./icons";
import { installPointerResize } from "./resizeDrag";

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
              title={app.description || "Open " + (app.title || app.id)}
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
  const storedPanelWidth = Number(storage.getItem("moo.uiPanelWidth"));
  const defaultPanelWidth = Math.round(
    window.innerWidth <= 900 ? window.innerWidth : window.innerWidth * 0.42,
  );
  const activeAppTab = createMemo(() => {
    const tab = bag.activeRightSidebarTab();
    return tab?.kind === "app" ? tab : null;
  });
  const activeUiId = () => activeAppTab()?.uiId ?? bag.openUiId();
  const activeInstanceId = () =>
    activeAppTab()?.instanceId ?? bag.openUiInstanceId();
  const activeAppKey = () =>
    activeUiId() ? `${activeUiId()}::${activeInstanceId() ?? ""}` : null;
  const [title, setTitle] = createSignal<string>("app");
  const [visibleFrameDoc, setVisibleFrameDoc] = createSignal<{
    key: number;
    appKey: string | null;
    doc: string;
  } | null>(null);
  const [pendingFrameDoc, setPendingFrameDoc] = createSignal<{
    key: number;
    appKey: string | null;
    doc: string;
  } | null>(null);
  let nextFrameKey = 0;
  const [panelWidth, setPanelWidth] = createSignal(
    Number.isFinite(storedPanelWidth) && storedPanelWidth > 0
      ? storedPanelWidth
      : defaultPanelWidth,
  );
  const [maximized, setMaximized] = createSignal(false);
  const [resizing, setResizing] = createSignal(false);
  let frame: HTMLIFrameElement | undefined;
  let pendingFrame: HTMLIFrameElement | undefined;
  let frameStack: HTMLDivElement | undefined;
  let startX = 0;
  let startWidth = 0;

  const clampPanelWidth = (width: number) => {
    const shellWidth =
      frame?.closest(".chat-shell")?.getBoundingClientRect().width ||
      window.innerWidth;
    if (shellWidth <= 900) {
      const max = Math.max(1, shellWidth);
      const min = Math.min(240, max);
      return Math.round(Math.max(min, Math.min(max, width)));
    }
    const min = Math.max(240, Math.min(352, shellWidth - 80));
    const max = Math.max(min, Math.min(shellWidth - 160, shellWidth * 0.85));
    return Math.round(Math.max(min, Math.min(max, width)));
  };

  const installPanelResizer = (handle: HTMLDivElement) => {
    installPointerResize(handle, {
      cursor: "col-resize",
      onStart: (event) => {
        if (props.embedded || maximized()) return false;
        setResizing(true);
        startX = event.clientX;
        startWidth = panelWidth();
      },
      onMove: (event) => {
        setPanelWidth(clampPanelWidth(startWidth + startX - event.clientX));
      },
      onEnd: () => setResizing(false),
    });
  };

  createEffect(() => {
    storage.setItem(
      "moo.uiPanelWidth",
      String(clampPanelWidth(panelWidth())),
    );
  });

  const showFrameDoc = (appKey: string | null, doc: string) => {
    const visible = visibleFrameDoc();
    const pending = pendingFrameDoc();
    if (
      (visible?.appKey === appKey && visible.doc === doc) ||
      (pending?.appKey === appKey && pending.doc === doc)
    )
      return;
    setPendingFrameDoc({ key: ++nextFrameKey, appKey, doc });
  };

  createEffect(
    on(activeAppKey, async (appKey) => {
      const uiId = activeUiId();
      if (!uiId) {
        setTitle("app");
        setPendingFrameDoc(null);
        setVisibleFrameDoc(null);
        return;
      }
      const r = await api("ui-bundle", { uiId });
      if (activeAppKey() !== appKey) return;
      if (!r.ok) {
        showFrameDoc(
          appKey,
          buildUiSrcdoc(`<p>${escapeHtml(r.error.message)}</p>`, "", ""),
        );
        return;
      }
      setTitle(r.value.manifest.title || uiId);
      const b = r.value.bundle;
      const html =
        b.html ?? b.files?.[r.value.manifest.entry || "index.html"] ?? "";
      const css = b.css ?? b.files?.["style.css"] ?? "";
      const js = b.js ?? b.files?.["client.js"] ?? "";
      showFrameDoc(appKey, buildUiSrcdoc(html, css, js));
    }),
  );

  const isUiFrameSource = (source: MessageEventSource | null) => {
    if (!source) return false;
    if (
      source === frame?.contentWindow ||
      source === pendingFrame?.contentWindow
    )
      return true;
    const iframes = frameStack?.querySelectorAll("iframe") ?? [];
    for (const iframe of Array.from(iframes)) {
      if (source === iframe.contentWindow) return true;
    }
    return false;
  };

  const onMessage = async (ev: MessageEvent) => {
    if (!isUiFrameSource(ev.source)) return;
    const source = ev.source as Window | null;
    const msg = ev.data || {};
    if (!msg || typeof msg !== "object" || msg.source !== "moo-ui" || !msg.id)
      return;
    // Capture the active IDs once at the start of the request so concurrent
    // app switches cannot cause later awaits to use a different instance.
    const instanceId = activeInstanceId();
    const uiId = activeUiId();
    const chatId = bag.chatId();
    const reply = (payload: Record<string, unknown>) =>
      // The app iframe is sandboxed without allow-same-origin, so its origin is
      // opaque ("null") and cannot be addressed by a concrete targetOrigin. Use
      // "*" and rely on the ev.source/msg.source validation above; postMessage
      // still targets only this specific frame's window.
      source?.postMessage({ source: "moo-host", id: msg.id, ...payload }, "*");
    try {
      if (msg.method === "state:get") {
        if (!instanceId) throw new Error("no UI instance is open");
        const r = await api("ui-state-get", { instanceId });
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value.state });
      } else if (msg.method === "state:set") {
        if (!instanceId) throw new Error("no UI instance is open");
        const r = await api("ui-state-set", {
          instanceId,
          state: msg.state ?? {},
        });
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value.state });
      } else if (msg.method === "call") {
        if (!uiId) throw new Error("no UI is open");
        const r = await api("ui-call", {
          uiId,
          instanceId,
          chatId,
          name: String(msg.name || "default"),
          input: msg.input ?? {},
        });
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value });
      } else if (msg.method === "memory:query") {
        const r = await api("memory-query", {
          patterns: msg.patterns ?? [],
          ...(msg.opts ?? {}),
        });
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value });
      } else if (msg.method === "memory:triples") {
        const r = await api("triples", {
          subject: typeof msg.subject === "string" ? msg.subject : undefined,
          predicate:
            typeof msg.predicate === "string" ? msg.predicate : undefined,
          object: typeof msg.object === "string" ? msg.object : undefined,
          ...(msg.opts && typeof msg.opts === "object" ? msg.opts : {}),
        });
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value });
      } else if (msg.method === "memory:assert") {
        const r = await api("assert", {
          subject: String(msg.subject ?? ""),
          predicate: String(msg.predicate ?? ""),
          object: String(msg.object ?? ""),
          ...(msg.opts ?? {}),
        });
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value });
      } else if (msg.method === "memory:retract") {
        const r = await api("retract", {
          subject: String(msg.subject ?? ""),
          predicate: String(msg.predicate ?? ""),
          object: String(msg.object ?? ""),
          ...(msg.opts ?? {}),
        });
        if (!r.ok) throw new Error(r.error.message);
        reply({ ok: true, value: r.value });
      } else if (msg.method === "open") {
        bag.openUi(
          String(msg.uiId),
          msg.instanceId ? String(msg.instanceId) : undefined,
        );
        reply({ ok: true, value: null });
      } else {
        throw new Error(`unknown UI method: ${msg.method}`);
      }
    } catch (err) {
      reply({
        ok: false,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  };
  window.addEventListener("message", onMessage);
  onCleanup(() => window.removeEventListener("message", onMessage));

  return (
    <aside
      class="ui-panel"
      classList={{
        maximized: !props.embedded && maximized(),
        resizing: resizing(),
        embedded: props.embedded,
      }}
      style={{ "--ui-panel-w": `${clampPanelWidth(panelWidth())}px` }}
    >
      <Show when={!props.embedded && !maximized()}>
        <div
          class="ui-panel-resizer"
          title="resize app panel"
          ref={(e) => installPanelResizer(e)}
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
            aria-label={
              maximized() ? "restore app panel" : "maximize app panel"
            }
            aria-pressed={maximized()}
            onClick={() => setMaximized(!maximized())}
          >
            {maximized() ? <RestoreIcon /> : <MaximizeIcon />}
          </button>
        </Show>
        <button
          class="header-icon-button"
          title="close app"
          onClick={() => bag.closeUi()}
        >
          <CloseIcon />
        </button>
      </header>
      <div class="ui-frame-stack" ref={frameStack}>
        <Show when={visibleFrameDoc()} keyed>
          {(doc) => (
            <iframe
              ref={frame}
              class="ui-frame"
              classList={{ loading: !!pendingFrameDoc() }}
              data-ui-frame-key={doc.key}
              sandbox="allow-scripts"
              srcdoc={doc.doc}
            />
          )}
        </Show>
        <Show when={pendingFrameDoc()} keyed>
          {(doc) => (
            <iframe
              ref={pendingFrame}
              class="ui-frame pending"
              data-ui-frame-key={doc.key}
              sandbox="allow-scripts"
              srcdoc={doc.doc}
              onLoad={() => {
                setVisibleFrameDoc(doc);
                setPendingFrameDoc(null);
                pendingFrame = undefined;
              }}
            />
          )}
        </Show>
      </div>
    </aside>
  );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] || char,
  );
}

function disableParserAutofocus(html: string): string {
  // Browser parser-level autofocus can race with the host composer focus and emit
  // "Autofocus processing was blocked because a document already has a focused element."
  // Preserve the app author's intent without using the special HTML attribute.
  return html.replace(
    /\sautofocus(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gi,
    ' data-moo-autofocus="true"',
  );
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
        return new Promise((resolve, reject) => {
          const onMessage = (ev) => {
            const msg = ev.data || {};
            if (msg.source !== 'moo-host' || msg.id !== id) return;
            window.clearTimeout(timeout);
            window.removeEventListener('message', onMessage);
            msg.ok ? resolve(msg.value) : reject(new Error(msg.error?.message || 'moo request failed'));
          };
          const timeout = window.setTimeout(() => {
            window.removeEventListener('message', onMessage);
            reject(new Error('moo request timed out'));
          }, 30000);
          window.addEventListener('message', onMessage);
          try {
            parent.postMessage({ source: 'moo-ui', id, method, ...(payload || {}) }, '*');
          } catch (err) {
            window.clearTimeout(timeout);
            window.removeEventListener('message', onMessage);
            reject(err);
          }
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
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{background:#0b0b0b;}html,body{background:#0b0b0b;}@media (prefers-color-scheme: light){:root,html,body{background:#ffffff;}}
${css}</style></head><body>${appHtml}<script>${autofocus}<\/script><script>${sdk}<\/script><script>${js}<\/script></body></html>`;
}
