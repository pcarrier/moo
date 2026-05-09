export function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function isFilesystemAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

export function joinRepoPath(base: string, child: string): string {
  return base.replace(/\/+$/, "") + "/" + child.replace(/^\/+/, "");
}

export function normalizePathSegments(path: string): string {
  const normalized = normalizeRepoPath(path);
  const absolute = normalized.startsWith("/");
  const prefixMatch = normalized.match(/^[A-Za-z]:\//);
  const prefix = prefixMatch
    ? prefixMatch[0].replace(/\/$/, "")
    : absolute
      ? "/"
      : "";
  const rest = prefixMatch
    ? normalized.slice(prefixMatch[0].length)
    : absolute
      ? normalized.slice(1)
      : normalized;
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!prefix) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  if (prefix === "/") return "/" + parts.join("/");
  if (prefix) return prefix + (parts.length ? "/" + parts.join("/") : "");
  return parts.join("/") || ".";
}

export function normalizedOptionalPath(
  path: string | null | undefined,
): string | null {
  const normalized = normalizeRepoPath(path || "").replace(/\/+$/, "");
  return normalized || null;
}

export function pathWithinRoot(path: string, root: string): boolean {
  const normalizedRoot = normalizePathSegments(root).replace(/\/+$/, "") || "/";
  const normalizedPath = normalizePathSegments(path).replace(/\/+$/, "") || "/";
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(normalizedRoot.replace(/\/+$/, "") + "/")
  );
}

export function relativeRepoPath(root: string, path: string): string {
  const normalizedRoot = normalizePathSegments(root).replace(/\/+$/, "") || "/";
  const normalizedPath = normalizePathSegments(path);
  if (normalizedRoot === "/") return normalizedPath.replace(/^\/+/, "");
  return normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, "");
}

export function repoFileBasePath(path: string): string | null {
  const normalized = normalizeRepoPath(path).replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return null;
  if (slash === 0) return "/";
  return normalized.slice(0, slash);
}

export function htmlPreviewAssetBasePath(
  path: string,
  assetRootPath?: string | null,
): string | null {
  const normalizedPath = normalizeRepoPath(path).replace(/\/+$/, "");
  const fileDir = repoFileBasePath(normalizedPath);
  if (isFilesystemAbsolutePath(normalizedPath)) return fileDir;
  const root = normalizedOptionalPath(assetRootPath);
  if (!root) return fileDir;
  return fileDir ? joinRepoPath(root, fileDir) : root;
}
