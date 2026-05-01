import { createSignal } from "solid-js";

// Posted by state.ts after the chats list response (which now carries
// homeDir). Components render paths through collapseHome() so anything
// inside the user's home directory shows up as "~/...". The expanded form
// is preserved for round-trips and IDs — only display strings collapse.
const [homeDir, setHomeDir] = createSignal<string | null>(null);

export { homeDir };

export function setHomeDir_(value: string | null | undefined): void {
  const next = typeof value === "string" && value ? stripTrailingSlash(value) : null;
  if (next === homeDir()) return;
  setHomeDir(next);
}

function stripTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

// Collapse `/Users/me/foo` (or `/home/me/foo`) to `~/foo` for display.
// Leaves the path untouched when it's outside the home dir, when home is
// unknown, when the input is empty, or when it's already tilde-prefixed.
// Backslashes are normalised to forward slashes so Windows-style paths
// don't get half-collapsed.
export function collapseHome(value: string | null | undefined): string {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return "";
  if (raw === "~" || raw.startsWith("~/")) return raw;
  const normalized = raw.replace(/\\/g, "/");
  const home = homeDir();
  if (!home) return normalized;
  if (normalized === home) return "~";
  if (normalized.startsWith(home + "/")) return "~" + normalized.slice(home.length);
  return normalized;
}

// Inverse of collapseHome: expand a leading tilde back to the home dir so
// callers can keep an absolute path internally while accepting tilde input
// from the user. Anything else passes through.
export function expandHome(value: string | null | undefined): string {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return "";
  if (raw !== "~" && !raw.startsWith("~/")) return raw;
  const home = homeDir();
  if (!home) return raw;
  return raw === "~" ? home : home + raw.slice(1);
}
