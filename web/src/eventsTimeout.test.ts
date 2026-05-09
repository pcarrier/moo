import { afterEach, describe, expect, test } from "bun:test";

import { WSConnection } from "./events";

const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("WSConnection RPC timeout", () => {
  test("times out RPCs even when no websocket is open", async () => {
    let timeoutMs: number | undefined;
    (globalThis as { window?: unknown }).window = {
      setTimeout(callback: () => void, ms: number) {
        timeoutMs = ms;
        queueMicrotask(callback);
        return 1;
      },
      clearTimeout() {},
    };

    const ws = new WSConnection();
    const result = await ws.run<{ ok: false; error: { message: string } }>({ command: "settings-save" });

    expect(timeoutMs).toBe(120_000);
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe("ws request timed out after 120000ms");
  });
});
