import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { renderMarkdown } from "./markdown";

const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");

describe("timeline error markdown rendering", () => {
  test("auth error guidance renders settings link and env key code", () => {
    const message = "Open [Settings](/settings) to configure auth, or set `OPENAI_API_KEY` before starting the server.";

    expect(renderMarkdown(message)).toBe(
      '<p>Open <a href="/settings">Settings</a> to configure auth, or set <code>OPENAI_API_KEY</code> before starting the server.</p>\n',
    );
  });

  test("ErrorBody renders error message and diagnostics as markdown", () => {
    expect(timeline).toContain('class="error-body markdown"');
    expect(timeline).toContain('innerHTML={renderMarkdown(message())}');
    expect(timeline).toContain('class="error-body error-diagnostics markdown"');
    expect(timeline).toContain('innerHTML={renderMarkdown(diagnostics())}');
  });
});
