import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { providerErrorHint } from "./provider_error";

const standard = { name: "glm", baseUrl: "https://api.z.ai/api/paas/v4" };

describe("Z.ai balance error guidance", () => {
  test("explains the separate billing pools without promising subscription eligibility", () => {
    const hint = providerErrorHint(standard, "1113");
    expect(hint).toContain("Coding Plan subscription quota is separate from pay-as-you-go API balance");
    expect(hint).toContain("Settings > Providers > GLM > Plan > Coding Plan (subscription)");
    expect(hint).toContain("https://api.z.ai/api/coding/paas/v4");
    expect(hint).toContain("replacing any URL override without changing your API key");
    expect(hint).toContain("Moo is not currently listed, so confirm eligibility with Z.ai");
    expect(providerErrorHint(standard, 1113)).toBe(hint);
  });

  test("accepts standard endpoint authority casing, HTTPS port, and trailing slashes", () => {
    for (const baseUrl of [
      standard.baseUrl + "/",
      "HTTPS://API.Z.AI:443/api/paas/v4/",
    ]) {
      expect(providerErrorHint({ name: "glm", baseUrl }, "1113")).toBe(providerErrorHint(standard, "1113"));
    }
  });

  test("does not confuse billing errors with rate limits or other provider errors", () => {
    for (const code of [null, undefined, "1302", "1305", 429, "insufficient_quota", "11130", {}, true]) {
      expect(providerErrorHint(standard, code)).toBeNull();
    }
    expect(providerErrorHint({ ...standard, name: "openai" }, "1113")).toBeNull();
    expect(providerErrorHint(null, "1113")).toBeNull();
    expect(providerErrorHint(undefined, "1113")).toBeNull();
  });

  test("does not advise switching endpoints for Coding Plan, gateways, or lookalike URLs", () => {
    for (const baseUrl of [
      undefined,
      "",
      "https://api.z.ai/api/coding/paas/v4",
      "https://openrouter.ai/api/v1",
      "https://open.bigmodel.cn/api/paas/v4",
      "https://proxy.example/api/paas/v4",
      "https://api.z.ai.evil.example/api/paas/v4",
      "https://api.z.ai@evil.example/api/paas/v4",
      "https://evil.example/api.z.ai/api/paas/v4",
      "http://api.z.ai/api/paas/v4",
      "https://api.z.ai:8443/api/paas/v4",
      "https://api.z.ai/API/paas/v4",
      "https://api.z.ai/api/paas/v4-extra",
    ]) {
      expect(providerErrorHint({ name: "glm", baseUrl }, "1113")).toBeNull();
    }
  });

  test("adds hints to ordinary and compaction errors without replacing upstream diagnostics", () => {
    const step = readFileSync(new URL("../commands/step.ts", import.meta.url), "utf8");
    const agent = readFileSync(new URL("../agent.ts", import.meta.url), "utf8");
    expect(step).toContain("provider: state.provider");
    expect(step.match(/const hint = providerErrorHint\(/g)).toHaveLength(2);
    expect(step).toContain("message: providerErrorMessage(parsed, status)");
    expect(step).toContain("code: providerErrorCode(parsed)");
    expect(step).toContain("body: providerErrorBodyForRecord(parsed, llmResult.errorBody)");
    expect(step).toContain("providerErrorRequestId(parsed, llmResult.headers)");
    expect(agent).toContain("hint: providerErrorHint(");
    expect(agent).toContain("message: compactionProviderErrorMessage(parsed, resp.status)");
    expect(agent).toContain("code: compactionProviderErrorCode(parsed)");
    expect(agent).toContain("body: compactionProviderErrorBodyForRecord(parsed, resp.body)");
    expect(agent).toContain("requestId: providerErrorRequestId(parsed, resp.headers)");
  });
});
