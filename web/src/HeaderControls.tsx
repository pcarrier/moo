import { Show, splitProps, type JSX } from "solid-js";
import type { Bag } from "./state";
import { MenuIcon, PanelIcon } from "./icons";

export function joinClasses(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function HeaderIconButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  const [local, rest] = splitProps(props, ["class", "type", "children"]);
  return (
    <button type={local.type || "button"} class={joinClasses("header-icon-button", local.class)} {...rest}>
      {local.children}
    </button>
  );
}

export function LeftSidebarToggle(props: {
  onToggleSidebar?: () => void;
  title?: string;
  class?: string;
}) {
  const title = () => props.title || "toggle sidebar";
  return (
    <HeaderIconButton
      class={props.class}
      title={title()}
      aria-label={title()}
      onClick={() => props.onToggleSidebar?.()}
    >
      <MenuIcon />
    </HeaderIconButton>
  );
}

export function RightSidebarToggle(props: { bag: Bag; class?: string }) {
  const title = () =>
    props.bag.rightSidebarCollapsed()
      ? "show right sidebar"
      : "hide right sidebar";
  return (
    <Show when={props.bag.rightSidebarTabs().length > 0}>
      <HeaderIconButton
        class={joinClasses("right-sidebar-toggle", props.class)}
        title={title()}
        aria-label={title()}
        aria-pressed={!props.bag.rightSidebarCollapsed()}
        onClick={() => props.bag.toggleRightSidebarCollapsed()}
      >
        <PanelIcon />
      </HeaderIconButton>
    </Show>
  );
}
