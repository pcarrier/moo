import type { JSX } from "solid-js";

type IconProps = { class?: string };

function iconClass(value?: string): string {
  return value ? `ui-icon ${value}` : "ui-icon";
}

export function PlusIcon(props: IconProps): JSX.Element {
  return (
    <svg class={iconClass(props.class)} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </svg>
  );
}

export function MenuIcon(props: IconProps): JSX.Element {
  return (
    <svg class={iconClass(props.class)} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.5h10M3 8h10M3 11.5h10" />
    </svg>
  );
}

export function PanelIcon(props: IconProps): JSX.Element {
  return (
    <svg class={iconClass(props.class)} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 3h10v10H3z" />
      <path d="M9.5 3v10" />
    </svg>
  );
}

export function MaximizeIcon(props: IconProps): JSX.Element {
  return (
    <svg class={iconClass(props.class)} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.75 3.25H3.25v2.5M10.25 3.25h2.5v2.5M5.75 12.75H3.25v-2.5M10.25 12.75h2.5v-2.5" />
    </svg>
  );
}

export function RestoreIcon(props: IconProps): JSX.Element {
  return (
    <svg class={iconClass(props.class)} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.25 3.25v3h-3M9.75 3.25v3h3M6.25 12.75v-3h-3M9.75 12.75v-3h3" />
    </svg>
  );
}

export function CompactIcon(props: IconProps): JSX.Element {
  return (
    <svg class={iconClass(props.class)} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 5h9M3.5 11h9" />
      <path d="M8 2.75v4.5M8 13.25v-4.5" />
      <path d="M5.75 5.25 8 7.5l2.25-2.25M5.75 10.75 8 8.5l2.25 2.25" />
    </svg>
  );
}

export function CloseIcon(props: IconProps): JSX.Element {
  return (
    <svg class={iconClass(props.class)} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5" />
    </svg>
  );
}

export function BackIcon(props: IconProps): JSX.Element {
  return (
    <svg class={iconClass(props.class)} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9.75 3.75 5.5 8l4.25 4.25M5.75 8h7" />
    </svg>
  );
}

export function RefreshIcon(props: IconProps): JSX.Element {
  return (
    <svg class={iconClass(props.class)} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M12.75 6.25A4.75 4.75 0 1 0 13 8" />
      <path d="M12.75 3.75v2.5h-2.5" />
    </svg>
  );
}
