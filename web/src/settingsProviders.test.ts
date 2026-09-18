import { describe, expect, test } from "bun:test";
import { PROVIDERS, providerVariantPatch, providerVariantValue } from "./settingsProviders";

const glm = PROVIDERS.find((p) => p.id === "glm")!;
const platform = "https://api.z.ai/api/paas/v4";
const coding = "https://api.z.ai/api/coding/paas/v4";

describe("GLM plan selection", () => {
  test("offers plain-language subscription and pay-as-you-go choices", () => {
    expect(glm.variantLabel).toBe("Plan");
    expect(glm.variants?.map((v) => v.title)).toEqual(["API Platform (pay-as-you-go)", "Coding Plan (subscription)"]);
    expect(glm.endpointHint).toContain("Your API key stays unchanged");
    expect(glm.variants?.find((v) => v.id === "coding")?.hint).toContain("Moo is not currently listed");
    expect(glm.variants?.find((v) => v.id === "platform")?.hint).toBeUndefined();
  });

  test("sets the selected URL and retains key and auth mode", () => {
    for (const [variant, baseUrl] of [["coding", coding], ["platform", platform]]) {
      const draft = { authMode: "apiKey", apiKey: "••••", variant: "platform", baseUrl: "https://proxy.example/glm" };
      const patch = providerVariantPatch(glm, variant);
      expect(patch).toEqual({ variant, baseUrl });
      expect({ ...draft, ...patch }).toEqual({ authMode: "apiKey", apiKey: "••••", variant, baseUrl });
      expect(providerVariantValue(glm, { ...draft, ...patch })).toBe(variant);
    }
  });

  test("reflects saved and manually entered plan URLs even with a stale variant", () => {
    expect(providerVariantValue(glm, { variant: "platform", baseUrl: coding })).toBe("coding");
    expect(providerVariantValue(glm, { baseUrl: coding + "/" })).toBe("coding");
    expect(providerVariantValue(glm, { variant: "coding", baseUrl: platform })).toBe("platform");
    expect(providerVariantValue(glm, { variant: "coding", baseUrl: "" })).toBe("coding");
    expect(providerVariantValue(glm, {})).toBe("platform");
  });

  test("identifies custom URLs without silently replacing them", () => {
    const draft = { variant: "coding", baseUrl: "https://openrouter.ai/api/v1" };
    expect(providerVariantValue(glm, draft)).toBe("custom");
    expect(providerVariantPatch(glm, "custom")).toEqual({});
    expect(draft.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(providerVariantValue(glm, { ...draft, baseUrl: "" })).toBe("coding");
  });

  test("ignores unknown choices and keeps the existing default", () => {
    expect(providerVariantPatch(glm, "unknown")).toEqual({});
    expect(providerVariantValue(glm, { variant: "unknown", baseUrl: "" })).toBe("platform");
  });

  test("leaves Kimi's existing endpoint override behavior unchanged", () => {
    const kimi = PROVIDERS.find((p) => p.id === "kimi")!;
    expect(providerVariantPatch(kimi, "code")).toEqual({ variant: "code" });
    expect(providerVariantValue(kimi, { variant: "code", baseUrl: "https://proxy.example/kimi" })).toBe("code");
  });

  test("Ollama exposes a curated model list on the local endpoint", () => {
    const ollama = PROVIDERS.find((p) => p.id === "ollama")!;
    expect(ollama.defaultBaseUrl).toBe("http://localhost:11434/v1");
    expect(ollama.supportsModelList).toBe(true);
    expect(ollama.variants).toBeUndefined();
    expect(ollama.modelListHint).toContain("hf.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF:Q4_K_M");
  });
});
