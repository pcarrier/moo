export type ThemeMode = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "moo.theme.mode";

export function isThemeMode(value: string | null): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
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

export function applyThemeMode(mode: ThemeMode) {
  const root = document.documentElement;
  if (mode === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = mode;
  }
}

export function persistThemeMode(mode: ThemeMode) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Ignore storage access failures; the in-memory choice still applies.
  }
}

export function applyAndPersistThemeMode(mode: ThemeMode) {
  applyThemeMode(mode);
  persistThemeMode(mode);
}

export function applyStoredThemeMode(): ThemeMode {
  const mode = storedThemeMode();
  applyThemeMode(mode);
  return mode;
}
