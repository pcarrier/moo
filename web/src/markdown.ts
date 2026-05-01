import { marked } from "marked";

// Shared marked setup. Keep these options in sync with the timeline/store
// preview rendering instead of choosing per-call settings.
marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(content: string): string {
  return marked.parse(content) as string;
}

export function renderMarkdownInline(content: string): string {
  return marked.parseInline(content) as string;
}

function isRepoFileHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("?")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return false;
  return true;
}

export function repoFilePathFromHref(href: string): string | null {
  if (!isRepoFileHref(href)) return null;
  return decodeURIComponent(href.split("#")[0].split("?")[0]);
}

export function resolveRepoFileHref(href: string, basePath: string | null | undefined): string | null {
  const linkPath = repoFilePathFromHref(href);
  if (!linkPath) return null;
  if (linkPath.startsWith("/")) return linkPath;
  const base = (basePath || "").replace(/\/+$/, "");
  return base ? base + "/" + linkPath.replace(/^\/+/, "") : linkPath;
}
