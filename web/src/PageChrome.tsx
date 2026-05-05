import { splitProps, type JSX } from "solid-js";
import type { Bag } from "./state";
import { RightSidebarToggle } from "./Sidebar";

function joinClasses(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function PageHeader(props: {
  /**
   * Page-level header chrome.  Its toggle slots intentionally mirror
   * Timeline's /chat/... header: left nav toggle first, optional page actions,
   * and the right-sidebar toggle pinned to the far right only on pages that opt in.
   */
  bag: Bag;
  title: string;
  navigation?: JSX.Element;
  actions?: JSX.Element;
  class?: string;
  onToggleSidebar?: () => void;
  showRightSidebarToggle?: boolean;
}) {
  return (
    <header class={joinClasses("view-header page-header", props.navigation ? "has-page-navigation" : "", props.class)}>
      <button
        type="button"
        class="header-icon-button"
        title="toggle sidebar"
        aria-label="toggle sidebar"
        onClick={() => props.onToggleSidebar?.()}
      >
        ☰
      </button>
      {props.navigation && <div class="page-header-navigation">{props.navigation}</div>}
      <h1 class="page-title">{props.title}</h1>
      <div class="page-header-actions">
        {props.actions}
        {props.showRightSidebarToggle && <RightSidebarToggle bag={props.bag} />}
      </div>
    </header>
  );
}

export function HeaderIconButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  const [local, rest] = splitProps(props, ["class", "type", "children"]);
  return (
    <button type={local.type || "button"} class={joinClasses("header-icon-button", local.class)} {...rest}>
      {local.children}
    </button>
  );
}

export function BackToChatButton(props: { bag: Bag; title?: string; class?: string }) {
  const title = () => props.title || "back to chat";
  return (
    <HeaderIconButton class={props.class} title={title()} aria-label={title()} onClick={() => props.bag.showChat()}>
      ←
    </HeaderIconButton>
  );
}

export function PageShell(props: { class?: string; mainClass?: string; children: JSX.Element }) {
  return (
    <div class={joinClasses("chat-shell", props.class)}>
      <section class={joinClasses("main", props.mainClass)}>{props.children}</section>
    </div>
  );
}

export function PageBody(props: { class?: string; children: JSX.Element; ref?: HTMLElement | ((el: HTMLElement) => void) }) {
  return (
    <main class={joinClasses("timeline", props.class)} ref={props.ref}>
      {props.children}
    </main>
  );
}

export function PageToolbar(props: { class?: string; children: JSX.Element }) {
  return <div class={joinClasses("page-toolbar", props.class)}>{props.children}</div>;
}

export function ToolbarSection(props: { class?: string; children: JSX.Element; ariaLabel?: string }) {
  return <div class={joinClasses("toolbar-section", props.class)} aria-label={props.ariaLabel}>{props.children}</div>;
}

export function StatPill(props: { class?: string; value: JSX.Element; label: JSX.Element }) {
  return (
    <span class={joinClasses("stat-pill", props.class)}>
      <strong>{props.value}</strong>
      <span>{props.label}</span>
    </span>
  );
}

export function ControlField(props: { class?: string; label: JSX.Element; children: JSX.Element }) {
  return (
    <label class={joinClasses("control-field", props.class)}>
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

export function EmptyState(props: { class?: string; children: JSX.Element }) {
  return <div class={joinClasses("empty empty-state", props.class)}>{props.children}</div>;
}

export function Notice(props: { class?: string; tone?: "info" | "warn" | "error"; children: JSX.Element }) {
  return <div class={joinClasses("notice", props.tone ? "notice-" + props.tone : "", props.class)}>{props.children}</div>;
}

export function Card(props: { class?: string; children: JSX.Element }) {
  return <div class={joinClasses("ui-card", props.class)}>{props.children}</div>;
}

export function CardHeader(props: { class?: string; children: JSX.Element }) {
  return <div class={joinClasses("card-header", props.class)}>{props.children}</div>;
}

export function FormGrid(props: { class?: string; children: JSX.Element }) {
  return <div class={joinClasses("form-grid", props.class)}>{props.children}</div>;
}

export function ActionRow(props: { class?: string; children: JSX.Element }) {
  return <div class={joinClasses("action-row", props.class)}>{props.children}</div>;
}

export function MetricCard(props: {
  class?: string;
  label: JSX.Element;
  value: JSX.Element;
  sub?: JSX.Element;
  tone?: "ok" | "warn" | "error" | "busy";
}) {
  return (
    <div class={joinClasses("metric-card", props.tone, props.class)}>
      <div class="metric-label">{props.label}</div>
      <div class="metric-value">{props.value}</div>
      {props.sub && <div class="metric-sub">{props.sub}</div>}
    </div>
  );
}
