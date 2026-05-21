import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { canRegisterServiceWorker } from "./pwa";
import { DARK_THEME_COLOR, LIGHT_THEME_COLOR } from "./theme";

const manifest = JSON.parse(
  readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
);
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const serviceWorker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

describe("PWA installability", () => {
  test("declares a standalone manifest with an emoji SVG icon", () => {
    expect(manifest.name).toBe("Moo");
    expect(manifest.short_name).toBe("Moo");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.background_color).toBe(LIGHT_THEME_COLOR);
    expect(manifest.theme_color).toBe(LIGHT_THEME_COLOR);
    expect(manifest.icons).toEqual([
      {
        src: "/icons/moo.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any maskable",
      },
    ]);
  });

  test("links install metadata from the document head", () => {
    expect(indexHtml).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(indexHtml).toContain(
      `name="theme-color" content="${LIGHT_THEME_COLOR}" media="(prefers-color-scheme: light)"`,
    );
    expect(indexHtml).toContain(
      `name="theme-color" content="${DARK_THEME_COLOR}" media="(prefers-color-scheme: dark)"`,
    );
    expect(indexHtml).toContain('rel="icon" href="/icons/moo.svg"');
    expect(indexHtml).toContain('rel="apple-touch-icon" href="/icons/moo.svg"');
  });

  test("registers only on secure contexts or localhost", () => {
    expect(canRegisterServiceWorker({ protocol: "https:", hostname: "moo.example" }, true)).toBe(true);
    expect(canRegisterServiceWorker({ protocol: "http:", hostname: "localhost" }, false)).toBe(true);
    expect(canRegisterServiceWorker({ protocol: "http:", hostname: "127.0.0.1" }, false)).toBe(true);
    expect(canRegisterServiceWorker({ protocol: "http:", hostname: "moo.example" }, false)).toBe(false);
  });

  test("service worker handles shell fetches without caching API traffic", () => {
    expect(serviceWorker).toContain('self.addEventListener("fetch"');
    expect(serviceWorker).toContain('request.mode === "navigate"');
    expect(serviceWorker).toContain('url.pathname.startsWith("/api/")');
  });
});
