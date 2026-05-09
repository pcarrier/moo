import { For, type JSX } from "solid-js";

function joinClasses(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export type TabBarItem<Id extends string = string> = {
  id: Id;
  title: JSX.Element;
  subtitle?: JSX.Element;
};

export function TabBar<Id extends string>(props: {
  items: readonly TabBarItem<Id>[];
  activeId: Id;
  onSelect: (id: Id) => void;
  ariaLabel: string;
  class?: string;
  tabId?: (id: Id) => string;
  panelId?: (id: Id) => string;
}) {
  const tabId = (id: Id) => props.tabId?.(id) ?? `tab-bar-${id}`;
  const panelId = (id: Id) => props.panelId?.(id) ?? `tab-bar-panel-${id}`;

  function moveSelection(from: Id, offset: number) {
    const index = props.items.findIndex((item) => item.id === from);
    if (index < 0 || props.items.length === 0) return;
    const next = (index + offset + props.items.length) % props.items.length;
    props.onSelect(props.items[next].id);
  }

  function selectEdge(edge: "first" | "last") {
    const item = edge === "first" ? props.items[0] : props.items[props.items.length - 1];
    if (item) props.onSelect(item.id);
  }

  return (
    <nav class={joinClasses("tab-bar", props.class)} role="tablist" aria-label={props.ariaLabel}>
      <For each={props.items}>{(item) => {
        const selected = () => props.activeId === item.id;
        return (
          <button
            type="button"
            id={tabId(item.id)}
            class="tab-bar-tab"
            classList={{ active: selected() }}
            tabIndex={selected() ? 0 : -1}
            role="tab"
            aria-selected={selected()}
            aria-controls={panelId(item.id)}
            onClick={() => props.onSelect(item.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.onSelect(item.id);
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                moveSelection(item.id, 1);
              } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                moveSelection(item.id, -1);
              } else if (event.key === "Home") {
                event.preventDefault();
                selectEdge("first");
              } else if (event.key === "End") {
                event.preventDefault();
                selectEdge("last");
              }
            }}
          >
            <span class="tab-bar-tab-title">{item.title}</span>
            {item.subtitle && <span class="tab-bar-tab-subtitle">{item.subtitle}</span>}
          </button>
        );
      }}</For>
    </nav>
  );
}
