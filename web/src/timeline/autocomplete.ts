import { api, type FsEntry, type FsSearchEntry } from "../api";

export type AutocompleteMode = "chat" | "path";

export const PATH_AUTOCOMPLETE_LIMIT = 24;
export const PATH_AUTOCOMPLETE_FUZZY_MIN_QUERY = 2;

export type PathAutocompleteContext = {
  start: number;
  end: number;
  basePath: string;
  query: string;
  dirPrefix: string;
  absolute: boolean;
  namePrefix: string;
  listDir: string;
};

export type PathAutocompleteSuggestion = {
  name: string;
  path: string;
  kind: string;
  size: number;
  mtime: number;
};

export type PathAutocompleteSnapshot = {
  key: string;
  suggestions: PathAutocompleteSuggestion[];
  loading: boolean;
  interactive: boolean;
};

const PATH_TOKEN_BOUNDARIES = "([{\"'`";

function isPathTokenBoundary(value: string): boolean {
  return (
    value === "" || /\s/.test(value) || PATH_TOKEN_BOUNDARIES.includes(value)
  );
}

export function findPathAutocompleteContext(
  text: string,
  cursor: number,
  basePath: string | null | undefined,
): PathAutocompleteContext | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  let at = safeCursor > 0 ? text.lastIndexOf("@", safeCursor - 1) : -1;
  while (at >= 0) {
    const hasBoundary = isPathTokenBoundary(at === 0 ? "" : text[at - 1] || "");
    const rawBeforeCursor = text.slice(at + 1, safeCursor);
    if (hasBoundary && !/\s/.test(rawBeforeCursor)) break;
    at = at > 0 ? text.lastIndexOf("@", at - 1) : -1;
  }
  if (at < 0) return null;

  const rawBeforeCursor = text.slice(at + 1, safeCursor);
  if (/\s/.test(rawBeforeCursor)) return null;

  let end = safeCursor;
  while (end < text.length && !/\s/.test(text[end] || "")) end += 1;

  const absolute = rawBeforeCursor.startsWith("/");
  const lastSlash = rawBeforeCursor.lastIndexOf("/");
  if (!absolute && !basePath) return null;
  const dirPrefix =
    lastSlash >= 0 ? rawBeforeCursor.slice(0, lastSlash + 1) : "";
  const namePrefix =
    lastSlash >= 0 ? rawBeforeCursor.slice(lastSlash + 1) : rawBeforeCursor;
  const cleanDir = dirPrefix.replace(/^\/+/, "").replace(/\/+$/, "");
  const base = (basePath || "").replace(/\/+$/, "");
  const listDir = absolute
    ? cleanDir ? "/" + cleanDir : "/"
    : cleanDir ? base + "/" + cleanDir : base || "/";

  return {
    start: at,
    end,
    basePath: base,
    query: absolute ? rawBeforeCursor : rawBeforeCursor.replace(/^\/+/, ""),
    dirPrefix,
    absolute,
    namePrefix,
    listDir,
  };
}

export function pathAutocompleteKey(context: PathAutocompleteContext): string {
  return [
    context.basePath,
    context.listDir,
    context.dirPrefix,
    context.absolute ? "absolute" : "relative",
    context.namePrefix,
    context.query,
  ].join("\0");
}

function pathAutocompleteRank(name: string, prefix: string): number {
  if (!prefix) return 2;
  const lowerName = name.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lowerName === lowerPrefix) return 5;
  if (lowerName.startsWith(lowerPrefix)) return 4;
  if (lowerName.includes(lowerPrefix)) return 2;
  return 0;
}

export function pathAutocompleteSuggestions(
  context: PathAutocompleteContext,
  entries: FsEntry[],
  limit: number,
): PathAutocompleteSuggestion[] {
  const prefix = context.namePrefix;
  return entries
    .filter((entry) => isPathAutocompleteEntry(entry))
    .filter((entry) => prefix.startsWith(".") || !entry.name.startsWith("."))
    .map((entry) => ({ entry, rank: pathAutocompleteRank(entry.name, prefix) }))
    .filter(({ rank }) => rank > 0)
    .sort((a, b) => {
      const ak = a.entry.kind === "dir" ? 0 : 1;
      const bk = b.entry.kind === "dir" ? 0 : 1;
      if (ak !== bk) return ak - bk;
      if (a.rank !== b.rank) return b.rank - a.rank;
      const an = a.entry.name.toLowerCase();
      const bn = b.entry.name.toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0;
    })
    .slice(0, limit)
    .map(({ entry }) =>
      pathAutocompleteSuggestionFromEntry(
        context.dirPrefix + entry.name,
        context.absolute,
        entry,
      ),
    );
}

function isPathAutocompleteEntry(entry: unknown): entry is FsEntry {
  return Boolean(
    entry &&
    typeof entry === "object" &&
    typeof (entry as FsEntry).name === "string",
  );
}

function pathAutocompleteSuggestionFromEntry(
  path: string,
  absolute: boolean,
  entry: FsEntry,
): PathAutocompleteSuggestion {
  const cleanPath = typeof path === "string" ? path : entry.name;
  const kind = typeof entry.kind === "string" ? entry.kind : "unknown";
  const isDir = kind === "dir";
  const displayPath = absolute
    ? cleanPath.replace(/\/+/g, "/")
    : cleanPath.replace(/^\/+/g, "");
  return {
    name: entry.name,
    path: displayPath + (isDir && !displayPath.endsWith("/") ? "/" : ""),
    kind,
    size:
      typeof entry.size === "number" && Number.isFinite(entry.size)
        ? entry.size
        : 0,
    mtime:
      typeof entry.mtime === "number" && Number.isFinite(entry.mtime)
        ? entry.mtime
        : 0,
  };
}

export function pathAutocompleteSearchSuggestions(
  entries: FsSearchEntry[],
): PathAutocompleteSuggestion[] {
  return entries
    .filter(
      (entry) =>
        isPathAutocompleteEntry(entry) &&
        typeof entry.relativePath === "string",
    )
    .map((entry) =>
      pathAutocompleteSuggestionFromEntry(entry.relativePath, false, entry),
    );
}

export function mergePathAutocompleteSuggestions(
  direct: PathAutocompleteSuggestion[],
  fuzzy: PathAutocompleteSuggestion[],
  limit: number,
): PathAutocompleteSuggestion[] {
  const seen = new Set<string>();
  const merged: PathAutocompleteSuggestion[] = [];
  for (const suggestion of [...direct, ...fuzzy]) {
    const key = suggestion.path.replace(/\/+$/, "") || suggestion.path;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(suggestion);
    if (merged.length >= limit) break;
  }
  return merged;
}

export function formatPathAutocompleteKind(
  suggestion: PathAutocompleteSuggestion,
): string {
  if (suggestion.kind === "dir") return "directory";
  if (suggestion.kind === "file") return "file";
  return suggestion.kind || "path";
}

type CachedPromise<T> = { promise: Promise<T>; value?: T };

const pathAutocompleteListCache = new Map<string, CachedPromise<FsEntry[]>>();
const pathAutocompleteSearchCache = new Map<
  string,
  CachedPromise<FsSearchEntry[]>
>();

export function cachedPathAutocompleteListValue(path: string): FsEntry[] | undefined {
  return pathAutocompleteListCache.get(path)?.value;
}

export function cachedPathAutocompleteSearchValue(
  basePath: string,
  query: string,
  limit: number,
): FsSearchEntry[] | undefined {
  return pathAutocompleteSearchCache.get(basePath + "\0" + query + "\0" + limit)
    ?.value;
}

export async function cachedPathAutocompleteList(path: string): Promise<FsEntry[]> {
  let cached = pathAutocompleteListCache.get(path);
  if (!cached) {
    const promise = api("fs-list", { path })
      .then((result) =>
        result.ok && Array.isArray(result.value.entries)
          ? result.value.entries
          : [],
      )
      .catch(() => []);
    cached = { promise };
    pathAutocompleteListCache.set(path, cached);
    promise.then(
      (value) => {
        cached!.value = value;
      },
      () => {
        if (pathAutocompleteListCache.get(path) === cached)
          pathAutocompleteListCache.delete(path);
      },
    );
  }
  return cached.promise;
}

export async function cachedPathAutocompleteSearch(
  basePath: string,
  query: string,
  limit: number,
): Promise<FsSearchEntry[]> {
  const key = basePath + "\0" + query + "\0" + limit;
  let cached = pathAutocompleteSearchCache.get(key);
  if (!cached) {
    const promise = api("fs-search", { path: basePath, query, limit })
      .then((result) =>
        result.ok && Array.isArray(result.value.entries)
          ? result.value.entries
          : [],
      )
      .catch(() => []);
    cached = { promise };
    pathAutocompleteSearchCache.set(key, cached);
    promise.then(
      (value) => {
        cached!.value = value;
      },
      () => {
        if (pathAutocompleteSearchCache.get(key) === cached)
          pathAutocompleteSearchCache.delete(key);
      },
    );
  }
  return cached.promise;
}

export function cachedPathAutocompleteSnapshot(
  context: PathAutocompleteContext,
): PathAutocompleteSnapshot | null {
  const directEntries = cachedPathAutocompleteListValue(context.listDir);
  if (!directEntries) return null;
  const direct = pathAutocompleteSuggestions(
    context,
    directEntries,
    PATH_AUTOCOMPLETE_LIMIT,
  );
  const fuzzyEntries =
    !context.absolute &&
    context.query.length >= PATH_AUTOCOMPLETE_FUZZY_MIN_QUERY
      ? cachedPathAutocompleteSearchValue(
          context.basePath,
          context.query,
          PATH_AUTOCOMPLETE_LIMIT,
        )
      : undefined;
  const fuzzy = fuzzyEntries
    ? pathAutocompleteSearchSuggestions(fuzzyEntries)
    : [];
  const suggestions = mergePathAutocompleteSuggestions(
    direct,
    fuzzy,
    PATH_AUTOCOMPLETE_LIMIT,
  );
  return {
    key: pathAutocompleteKey(context),
    suggestions,
    loading:
      !context.absolute &&
      context.query.length >= PATH_AUTOCOMPLETE_FUZZY_MIN_QUERY &&
      !fuzzyEntries,
    interactive: true,
  };
}


