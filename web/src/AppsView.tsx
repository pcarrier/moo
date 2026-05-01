import { For, Show } from "solid-js";

import { RightSidebarToggle } from "./Sidebar";
import type { Bag } from "./state";

export function AppsView(props: { bag: Bag; onToggleSidebar?: () => void }) {
  const { bag } = props;
  return (
    <div class="chat-shell apps-dashboard-view">
      <section class="main apps-view">
        <header class="conv-header">
          <button
            class="header-icon-button"
            title="toggle sidebar"
            aria-label="toggle sidebar"
            onClick={props.onToggleSidebar}
          >
            ☰
          </button>
          <button
            class="header-icon-button"
            title="back to chat"
            onClick={() => bag.showChat()}
          >
            ←
          </button>
          <strong>apps</strong>
          <small class="conv-stats">
            {bag.uiApps().length} available app{bag.uiApps().length === 1 ? "" : "s"}
          </small>
          <button class="header-icon-button" title="refresh apps" onClick={() => bag.refreshUis()}>
            ↻
          </button>
          <RightSidebarToggle bag={bag} />
        </header>
        <main class="timeline apps-list-view">
          <Show when={bag.uiApps().length > 0} fallback={<Show when={bag.uiAppsLoaded()}><div class="empty">no apps yet</div></Show>}>
            <ul class="app-list app-list-main">
              <For each={bag.uiApps()}>
                {(app) => (
                  <li class="app-row" classList={{ active: app.id === bag.openUiId() }}>
                    <button
                      class="app-select"
                      title={app.description || "open app"}
                      onClick={() => bag.openUi(app.id)}
                    >
                      <span class="app-icon">{app.icon || "▣"}</span>
                      <span class="app-copy">
                        <span class="app-title">{app.title || app.id}</span>
                        <span class="app-id">{app.id}</span>
                        <Show when={app.description}>
                          <span class="app-description">{app.description}</span>
                        </Show>
                        <Show when={app.api?.length}>
                          <span class="app-api">
                            {app.api!.length} action{app.api!.length === 1 ? "" : "s"}
                          </span>
                        </Show>
                      </span>
                    </button>
                    <button
                      class="app-delete"
                      title={`delete ${app.title || app.id}`}
                      aria-label={`delete ${app.title || app.id}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        bag.removeUi(app.id);
                      }}
                    >
                      ×
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </main>
      </section>
    </div>
  );
}
