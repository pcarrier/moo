// Live WebSocket integration test for the OpenAI Responses streaming endpoint.
//
// Enabled only when credentials are provided via environment variables. Run with:
//
//   MOO_LIVE_WS=1 OPENAI_API_KEY=sk-... bun test harness/tests/openai_websocket_live.test.ts
//
// OAuth (Codex) flow:
//
//   MOO_LIVE_WS=1 \
//   MOO_LIVE_WS_OAUTH_TOKEN=eyJ... \
//   MOO_LIVE_WS_OAUTH_ACCOUNT_ID=acct_... \
//   bun test harness/tests/openai_websocket_live.test.ts
//
// The test sends "say hello" and asserts that streamed text deltas arrive and
// the assembled response contains "hello" (case-insensitive). Useful for
// verifying the Responses-over-WebSocket transport end-to-end.

import { test, expect } from "bun:test";
import {
  buildStreamingLLMRequest,
  accumulateSummaryStreamEvent,
  type RawUsage,
} from "../src/agent";

const g = globalThis as any;
let testIdSeq = 0;
g.__op_id ??= (prefix: string) => `${prefix}:${++testIdSeq}`;
g.__op_trace_current ??= () => null;
g.__op_trace_insert ??= () => null;
g.__op_trace_finish ??= () => "true";
g.__op_trace_leave ??= () => null;
g.__op_trace_enter ??= () => null;

const LIVE = process.env.MOO_LIVE_WS === "1";
const OAUTH_TOKEN = process.env.MOO_LIVE_WS_OAUTH_TOKEN;
const OAUTH_ACCOUNT = process.env.MOO_LIVE_WS_OAUTH_ACCOUNT_ID;
const API_KEY = process.env.OPENAI_API_KEY;
const MODEL =
  process.env.MOO_LIVE_WS_MODEL ||
  (OAUTH_TOKEN ? "gpt-5.3-codex" : "gpt-5");

function provider() {
  if (OAUTH_TOKEN) {
    return {
      name: "openai" as const,
      apiKey: OAUTH_TOKEN,
      baseUrl: "https://chatgpt.com/backend-api/codex",
      model: MODEL,
      effort: "low" as const,
      keyEnvHint: "MOO_LIVE_WS_OAUTH_TOKEN",
      authMode: "oauth" as const,
      oauthAccountId: OAUTH_ACCOUNT ?? null,
    };
  }
  return {
    name: "openai" as const,
    apiKey: API_KEY ?? "",
    baseUrl: "https://api.openai.com/v1",
    model: MODEL,
    effort: null,
    keyEnvHint: "OPENAI_API_KEY",
    authMode: "apiKey" as const,
  };
}

const canRun = LIVE && (OAUTH_TOKEN || API_KEY);

test.skipIf(!canRun)("OpenAI Responses-over-WebSocket streams 'say hello'", async () => {
  const request = buildStreamingLLMRequest(
    provider() as any,
    [
      { role: "system", content: "Reply with exactly one short sentence." },
      { role: "user", content: "Say hello." },
    ],
    null,
  );

  expect(request.transport).toBe("websocket");
  expect(request.url.startsWith("wss://")).toBe(true);

  const ws = new WebSocket(request.url, {
    // Bun supports passing headers via the second arg.
    headers: request.headers,
  } as any);

  type StreamState = { content: string; model: string | null; usage: RawUsage | null; error: unknown };
  const state: StreamState = { content: "", model: null, usage: null, error: null };
  const deltas: string[] = [];
  let completed = false;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`timed out after 30s; content so far=${JSON.stringify(state.content)} deltas=${deltas.length} error=${JSON.stringify(state.error)}`));
    }, 30_000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(request.body));
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : "";
      if (!raw) return;
      let parsed: any;
      try { parsed = JSON.parse(raw); } catch { return; }
      if (parsed?.type === "response.output_text.delta" && typeof parsed.delta === "string") {
        deltas.push(parsed.delta);
      }
      accumulateSummaryStreamEvent(state, parsed, /*responsesApi*/ true);
      if (parsed?.type === "response.completed" || parsed?.type === "response.done") {
        completed = true;
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        resolve();
      }
      if (parsed?.type === "error" || parsed?.error) {
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        reject(new Error(`server error: ${JSON.stringify(parsed)}`));
      }
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      if (!completed) {
        clearTimeout(timeout);
        reject(new Error(`WS closed before response.completed: code=${event.code} reason=${event.reason || "<none>"} content=${JSON.stringify(state.content)}`));
      }
    });

    ws.addEventListener("error", (event: any) => {
      clearTimeout(timeout);
      reject(new Error(`WS error: ${event?.message || JSON.stringify(event)}`));
    });
  });

  expect(deltas.length).toBeGreaterThan(0);
  expect(state.content.toLowerCase()).toContain("hello");
  expect(state.error).toBeNull();
});
