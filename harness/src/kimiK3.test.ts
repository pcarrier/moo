import { describe, expect, test } from "bun:test";

import {
  buildStreamingLLMRequest,
  effortLevelsForProvider,
  type LLMProvider,
} from "./agent";
import { modelMetadataFor, PROVIDER_METADATA } from "./llm_models";

describe("Kimi K3 model support", () => {
  test("uses Kimi K3 as the Moonshot platform default with documented limits and pricing", () => {
    expect(PROVIDER_METADATA.kimi.fallbackModel).toBe("kimi-k3");
    expect(PROVIDER_METADATA.kimi.variants?.find((variant) => variant.id === "platform")?.fallbackModel).toBe("kimi-k3");

    expect(modelMetadataFor("kimi", "kimi-k3")).toMatchObject({
      contextWindow: 1_048_576,
      maxOutputTokens: 1_048_576,
      pricing: { input: 3, cachedInput: 0.3, output: 15 },
      capabilities: {
        toolCalls: true,
        structuredOutputs: true,
        reasoning: true,
        vision: true,
      },
      defaultOption: true,
    });
  });

  test("sends K3 reasoning_effort=max instead of the K2 thinking parameter", () => {
    const provider: LLMProvider = {
      name: "kimi",
      model: "kimi-k3",
      apiKey: "test-key",
      baseUrl: "https://api.moonshot.ai/v1",
      effort: null,
    };

    expect(effortLevelsForProvider(provider)).toEqual(["max"]);

    const request = buildStreamingLLMRequest(
      provider,
      [{ role: "user", content: "Introduce Kimi K3 in one sentence." }],
      null,
    );

    expect(request.body).toMatchObject({
      model: "kimi-k3",
      reasoning_effort: "max",
      stream: true,
    });
    expect(request.body).not.toHaveProperty("thinking");
  });
});
