import { For, Show } from "solid-js";

import type { Bag } from "./state";
import { RefreshIcon } from "./icons";
import {
  BackToChatButton,
  EmptyState,
  HeaderIconButton,
  PageBody,
  PageHeader,
  PageShell,
} from "./PageChrome";

export function AppsView(props: { bag: Bag; onToggleSidebar?: () => void }) {
  const { bag } = props;

  return (
    <PageShell class="apps-dashboard-view" mainClass="apps-view">
      <PageHeader
        bag={bag}
        title="Apps"
        onToggleSidebar={props.onToggleSidebar || (() => {})}
        showRightSidebarToggle
        actions={
          <>
            <BackToChatButton bag={bag} />
            <HeaderIconButton
              title="refresh apps"
              aria-label="refresh apps"
              onClick={() => void bag.refreshUis()}
            >
              <RefreshIcon />
            </HeaderIconButton>
          </>
        }
      />
      <PageBody class="apps-list-view">
        <Show
          when={bag.uiApps().length > 0}
          fallback={
            <Show when={bag.uiAppsLoaded()}>
              <EmptyState>no apps yet</EmptyState>
            </Show>
          }
        >
          <section class="apps-explorer-list" aria-label="apps">
            <ul class="app-list app-list-main">
              <For each={bag.uiApps()}>
                {(app) => (
                  <li
                    class="app-row"
                    classList={{ open: app.id === bag.openUiId() }}
                  >
                    <button
                      type="button"
                      class="app-select"
                      title={app.description || `open ${app.title || app.id}`}
                      onClick={() => void bag.openUi(app.id)}
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
                            {app.api!.length} action
                            {app.api!.length === 1 ? "" : "s"}
                          </span>
                        </Show>
                      </span>
                    </button>
                    <button
                      type="button"
                      class="app-code"
                      title={`show code for ${app.title || app.id}`}
                      aria-label={`show code for ${app.title || app.id}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        bag.openAppCodeInSidebar(app.id);
                      }}
                    >
                      code
                    </button>
                    <button
                      type="button"
                      class="app-delete"
                      title={`delete ${app.title || app.id}`}
                      aria-label={`delete ${app.title || app.id}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        void bag.removeUi(app.id);
                      }}
                    >
                      ×
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </PageBody>
    </PageShell>
  );
}
