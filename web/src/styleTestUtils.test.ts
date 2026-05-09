import { readFileSync } from "node:fs";

export function readStylesheetForTest(): string {
  const manifest = readFileSync(new URL("./style.css", import.meta.url), "utf8");
  return manifest.replace(/^@import\s+["'](.+?)["'];\s*$/gm, (_line, href: string) =>
    readFileSync(new URL(href, import.meta.url), "utf8"),
  );
}
