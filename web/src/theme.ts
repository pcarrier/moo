export type ThemeMode = "system" | "light" | "dark";
export type ResolvedThemeMode = Exclude<ThemeMode, "system">;

export const THEME_STORAGE_KEY = "moo.theme.mode";
export const LIGHT_THEME_COLOR = "#fafafa";
export const DARK_THEME_COLOR = "#141414";

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export function isThemeMode(value: string | null): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.(DARK_SCHEME_QUERY).matches === true;
}

export function resolveThemeMode(
  mode: ThemeMode,
  prefersDark = systemPrefersDark(),
): ResolvedThemeMode {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}

export function themeColorForMode(
  mode: ThemeMode,
  prefersDark = systemPrefersDark(),
): string {
  return resolveThemeMode(mode, prefersDark) === "dark"
    ? DARK_THEME_COLOR
    : LIGHT_THEME_COLOR;
}

export function syncThemeColor(mode: ThemeMode): void {
  const color = themeColorForMode(mode);
  for (const meta of document.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"]',
  )) {
    meta.content = color;
  }
}

export function storedThemeMode(): ThemeMode {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeMode(value)) return value;
  } catch {
    // Ignore storage access failures and fall back to the system setting.
  }
  return "system";
}

export function applyThemeMode(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = mode;
  }
  syncThemeColor(mode);
}

export function persistThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Ignore storage access failures; the in-memory choice still applies.
  }
}

export function applyAndPersistThemeMode(mode: ThemeMode): void {
  applyThemeMode(mode);
  persistThemeMode(mode);
}

export function applyStoredThemeMode(): ThemeMode {
  const mode = storedThemeMode();
  applyThemeMode(mode);
  return mode;
}

export function startThemeColorSync(
  getMode: () => ThemeMode = storedThemeMode,
): () => void {
  if (typeof window === "undefined") return () => {};
  const media = window.matchMedia?.(DARK_SCHEME_QUERY);
  if (!media) return () => {};

  const syncIfSystem = () => {
    if (getMode() === "system") syncThemeColor("system");
  };
  const legacyMedia = media as MediaQueryList & {
    addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
    removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
  };

  media.addEventListener?.("change", syncIfSystem) ??
    legacyMedia.addListener?.(syncIfSystem);

  return () => {
    media.removeEventListener?.("change", syncIfSystem) ??
      legacyMedia.removeListener?.(syncIfSystem);
  };
}
