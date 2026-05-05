import type { JSX } from "solid-js";
import type { Bag } from "./state";
import { RightSidebarToggle } from "./Sidebar";

export function PageHeader(props: {
  bag: Bag;
  title: string;
  description?: JSX.Element;
  actions?: JSX.Element;
  class?: string;
  onToggleSidebar: () => void;
}) {
  return (
    <header class={["view-header page-header", props.class].filter(Boolean).join(" ")}>
      <button
        type="button"
        class="header-icon-button"
        title="toggle sidebar"
        aria-label="toggle sidebar"
        onClick={props.onToggleSidebar}
      >
        ☰
      </button>
      <div class="page-header-copy">
        <h1>{props.title}</h1>
        {props.description && <p>{props.description}</p>}
      </div>
      <div class="page-header-actions">
        {props.actions}
        <RightSidebarToggle bag={props.bag} />
      </div>
    </header>
  );
}
