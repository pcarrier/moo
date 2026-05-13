import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { missingLlmAuthDetail, missingLlmAuthMessage } from "./step";

const stepSource = readFileSync(new URL("./step.ts", import.meta.url), "utf8");

function sourceBetween(start: string, end: string): string {
  const startIndex = stepSource.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = stepSource.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return stepSource.slice(startIndex, endIndex);
}

describe("missing LLM authentication", () => {
  test("formats the existing settings/env guidance", () => {
    expect(missingLlmAuthMessage({ name: "openai", keyEnvHint: "OPENAI_API_KEY" })).toBe([
      "LLM authentication is not configured for openai.",
      "Open [Settings](/settings) to configure auth, or set `OPENAI_API_KEY` before starting the server.",
    ].join("\n"));

    expect(missingLlmAuthMessage({ name: "openai", keyEnvHint: "OPENAI_API_KEY" }, "resume")).toStartWith(
      "Cannot resume this chat because LLM authentication is not configured for openai.",
    );
  });

  test("builds an authentication error detail payload", () => {
    expect(missingLlmAuthDetail({
      name: "openai",
      keyEnvHint: "OPENAI_API_KEY",
      model: "gpt-5.5",
      effort: "medium",
      authMode: "env",
    })).toEqual({
      source: "authentication",
      provider: "openai",
      authMode: "env",
      keyEnvHint: "OPENAI_API_KEY",
      model: "gpt-5.5",
      message: [
        "LLM authentication is not configured for openai.",
        "Open [Settings](/settings) to configure auth, or set `OPENAI_API_KEY` before starting the server.",
      ].join("\n"),
    });
  });

  test("records missing auth as a failed error step instead of a reply", () => {
    const helper = sourceBetween(
      "async function recordMissingLlmAuthError",
      "export async function stepCommand",
    );
    expect(helper).toContain("recordErrorStep(");
    expect(helper).toContain('"authentication"');
    expect(helper).not.toContain("reply(");

    const prelude = sourceBetween(
      "export async function stepPreludeCommand",
      "export async function stepResumeCommand",
    );
    expect(prelude).toContain('await recordMissingLlmAuthError(chatId, provider, "step");');
    expect(prelude).not.toContain("await reply(");

    const resume = sourceBetween(
      "export async function stepResumeCommand",
      "export async function commandValue",
    );
    expect(resume).toContain('await recordMissingLlmAuthError(chatId, provider, "resume");');
    expect(resume).not.toContain("await reply(");
  });
});
