import { afterEach, describe, expect, test } from "bun:test";

import {
  DARK_THEME_COLOR,
  LIGHT_THEME_COLOR,
  resolveThemeMode,
  syncThemeColor,
  themeColorForMode,
} from "./theme";

const originalDocument = (globalThis as { document?: unknown }).document;

afterEach(() => {
  (globalThis as { document?: unknown }).document = originalDocument;
});

describe("theme system chrome", () => {
  test("resolves system mode from the current color scheme", () => {
    expect(resolveThemeMode("system", false)).toBe("light");
    expect(resolveThemeMode("system", true)).toBe("dark");
    expect(resolveThemeMode("light", true)).toBe("light");
    expect(resolveThemeMode("dark", false)).toBe("dark");
  });

  test("uses app background colors for Android bars", () => {
    expect(themeColorForMode("light", true)).toBe(LIGHT_THEME_COLOR);
    expect(themeColorForMode("dark", false)).toBe(DARK_THEME_COLOR);
    expect(themeColorForMode("system", false)).toBe(LIGHT_THEME_COLOR);
    expect(themeColorForMode("system", true)).toBe(DARK_THEME_COLOR);
  });

  test("updates all theme-color metadata entries", () => {
    const metas = [{ content: "" }, { content: "" }];
    (globalThis as { document?: unknown }).document = {
      querySelectorAll(selector: string) {
        expect(selector).toBe('meta[name="theme-color"]');
        return metas;
      },
    };

    syncThemeColor("dark");

    expect(metas.map((meta) => meta.content)).toEqual([
      DARK_THEME_COLOR,
      DARK_THEME_COLOR,
    ]);
  });
});
