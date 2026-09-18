import { afterEach, describe, expect, test } from "bun:test";

import { buildStreamingLLMRequest, inferProviderForModel, resolveProvider } from "../src/agent";
import { llmAuthGetCommand, llmAuthSaveCommand } from "../src/commands/llm_auth";
import { modelOptionsFor, modelSupportsAttachments, splitModelId } from "../src/commands/models";
import { modelSupportsTools } from "../src/llm_models";
import type { LLMProvider } from "../src/types";

const refs = new Map<string, string>();
const objects = new Map<string, { kind: string; content: string }>();
let objectId = 0;
let envValues = new Map<string, string>();

(globalThis as any).__op_now = () => 1_000;
(globalThis as any).__op_env_get = (name: string) => envValues.get(name) ?? null;
(globalThis as any).__op_ref_get = (name: string) => refs.get(name) ?? null;
(globalThis as any).__op_ref_set = (name: string, target: string) => { refs.set(name, target); return true; };
(globalThis as any).__op_ref_cas = (name: string, expected: string | null, next: string) => { const __cur = refs.has(name) ? refs.get(name) : null; if (__cur !== (expected ?? null)) return false; refs.set(name, next); return true; };
(globalThis as any).__op_ref_delete = (name: string) => refs.delete(name);
(globalThis as any).__op_facts_match = () => [];
(globalThis as any).__op_facts_swap = () => ({ store: "test", added: 0, removed: 0 });
(globalThis as any).__op_object_put = (kind: string, content: string) => {
  const hash = "sha256:" + String(++objectId).padStart(64, "0");
  objects.set(hash, { kind, content });
  return hash;
};
(globalThis as any).__op_object_get = (hash: string) => objects.get(hash) ?? null;

afterEach(() => {
  refs.clear();
  objects.clear();
  envValues.clear();
});

const ORNITH = "hf.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF:Q4_K_M";

describe("Ollama provider", () => {
  test("resolves the local OpenAI-compatible endpoint without a key", async () => {
    const provider = await resolveProvider(null, null, "ollama");
    expect(provider).toMatchObject({
      name: "ollama",
      apiKey: null,
      baseUrl: "http://localhost:11434/v1",
      model: "qwen3:8b",
    });
  });

  test("uses the first configured settings model as the default", async () => {
    await llmAuthSaveCommand({ ollama: { models: [ORNITH, "qwen3:8b"] } });
    const provider = await resolveProvider(null, null, "ollama");
    expect(provider).toMatchObject({ name: "ollama", model: ORNITH });
    // An explicit model override still wins over the configured default.
    expect(await resolveProvider("qwen3:32b", null, "ollama")).toMatchObject({ model: "qwen3:32b" });
  });

  test("honors OLLAMA_BASE_URL and OLLAMA_MODEL env overrides", async () => {
    envValues = new Map([
      ["OLLAMA_BASE_URL", "http://gpu-box:11434/v1"],
      ["OLLAMA_MODEL", "llama3.3:70b"],
    ]);
    const provider = await resolveProvider(null, null, "ollama");
    expect(provider).toMatchObject({ baseUrl: "http://gpu-box:11434/v1", model: "llama3.3:70b" });
  });

  test("infers Hugging Face GGUF refs as Ollama models", () => {
    expect(inferProviderForModel(ORNITH)).toBe("ollama");
    // The ":" quantifier suffix must survive provider-prefix parsing.
    expect(splitModelId("ollama:" + ORNITH)).toEqual({ provider: "ollama", model: ORNITH });
    expect(splitModelId(ORNITH)).toEqual({ provider: null, model: ORNITH });
  });

  test("trusts the curated list for tools and recognizes local vision families", () => {
    expect(modelSupportsTools("ollama", ORNITH)).toBe(true);
    expect(modelSupportsTools("ollama", "llama3.1:8b")).toBe(true);
    expect(modelSupportsAttachments("ollama", "qwen3-vl:32b")).toBe(true);
    expect(modelSupportsAttachments("ollama", "hf.co/user/gemma3-27b-GGUF:Q4_K_M")).toBe(true);
    expect(modelSupportsAttachments("ollama", ORNITH)).toBe(false);
  });

  test("builds a plain OpenAI chat completions request with no auth header", () => {
    const provider = {
      name: "ollama",
      apiKey: null,
      baseUrl: "http://localhost:11434/v1",
      model: ORNITH,
      effort: null,
      keyEnvHint: "OLLAMA_API_KEY",
      authMode: "env",
    } as unknown as LLMProvider;
    const request = buildStreamingLLMRequest(provider, [{ role: "user", content: "hello" }], [{
      type: "function",
      function: { name: "ping", description: "Ping", parameters: { type: "object" } },
    }]);
    expect(request.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(request.responsesApi).toBe(false);
    expect(request.headers.Authorization).toBeUndefined();
    expect(request.body).toMatchObject({
      model: ORNITH,
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: "auto",
    });
    // No provider-specific reasoning knobs leak into the request.
    expect(request.body).not.toHaveProperty("reasoning_effort");
    expect(request.body).not.toHaveProperty("thinking");
    expect(request.body).not.toHaveProperty("enable_thinking");
  });

  test("offers configured settings and env models in the picker", async () => {
    await llmAuthSaveCommand({ ollama: { models: [ORNITH] } });
    envValues = new Map([["OLLAMA_MODELS", "llama3.1:8b"]]);
    const options = await modelOptionsFor("ollama", null);
    const ids = options.map((option) => option.id);
    expect(ids).toContain("ollama:" + ORNITH);
    expect(ids).toContain("ollama:llama3.1:8b");
    expect(ids).toContain("ollama:qwen3:8b");
  });

  test("round-trips the model list through redacted auth settings", async () => {
    await llmAuthSaveCommand({ ollama: { models: [ORNITH, "", "qwen3:8b", ORNITH] } });
    const settings = (await llmAuthGetCommand()).value.settings;
    expect(settings.providers.ollama.models).toEqual([ORNITH, "qwen3:8b"]);
    // Omitting models keeps the stored list.
    await llmAuthSaveCommand({ ollama: { baseUrl: "http://nas:11434/v1" } });
    const reloaded = (await llmAuthGetCommand()).value.settings;
    expect(reloaded.providers.ollama.models).toEqual([ORNITH, "qwen3:8b"]);
    expect(reloaded.providers.ollama.baseUrl).toBe("http://nas:11434/v1");
  });
});
