import { moo } from "../moo";
import { chatRefs } from "../lib";
import {
  effortLevelsForProvider,
  normalizeEffort,
  resolveProvider,
} from "../agent";
import type { Input } from "./_shared";

export type ProviderName = "openai" | "qwen" | "anthropic";

const PROVIDERS: ProviderName[] = ["openai", "anthropic", "qwen"];

export type ModelOption = {
  id: string;
  provider: ProviderName;
  model: string;
  label: string;
};

export function normalizeProvider(value: unknown): ProviderName | null {
  const provider = String(value ?? "").trim().toLowerCase();
  return provider === "openai" || provider === "qwen" || provider === "anthropic" ? provider : null;
}

export function splitModelId(value: unknown): { provider: ProviderName | null; model: string } {
  const raw = String(value ?? "").trim();
  const match = /^(openai|qwen|anthropic):(.*)$/i.exec(raw);
  if (!match) return { provider: null, model: raw };
  return { provider: normalizeProvider(match[1]), model: match[2].trim() };
}

export function modelOptionId(provider: ProviderName, model: string): string {
  return provider + ":" + model;
}

function inferProviderNameForModel(model: string): ProviderName | null {
  const id = model.trim().toLowerCase();
  if (!id) return null;
  if (id.startsWith("qwen")) return "qwen";
  if (id.startsWith("claude")) return "anthropic";
  if (id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4") || id.startsWith("chatgpt-")) return "openai";
  return null;
}

export async function getChatProvider(_chatId: string): Promise<ProviderName | null> {
  return null;
}

export async function getChatModel(chatId: string): Promise<string | null> {
  const raw = await getChatFact(chatId, CHAT_MODEL_PREDICATE);
  const parsed = splitModelId(raw);
  return parsed.model || null;
}

export async function setChatModel(chatId: string, model: string | null): Promise<void> {
  const parsed = splitModelId(model);
  await setChatFact(chatId, CHAT_MODEL_PREDICATE, parsed.model || null);
}

export async function setChatEffort(chatId: string, effort: string | null): Promise<void> {
  await setChatFact(chatId, CHAT_EFFORT_PREDICATE, normalizeEffort(effort));
}

export const CHAT_MODEL_PREDICATE = "ui:model";
export const CHAT_EFFORT_PREDICATE = "ui:effortLevel";

const LAST_MODEL_REF = "ui/last-model";
const LAST_EFFORT_REF = "ui/last-effort";

export function chatSubject(chatId: string): string {
  return "chat:" + chatId;
}

export function chatFactsRef(chatId: string): string {
  return chatRefs(chatId).facts;
}

export function chatGraph(chatId: string): string {
  return chatRefs(chatId).graph;
}

async function getChatFact(chatId: string, predicate: string): Promise<string | null> {
  const rows = await moo.facts.match(chatFactsRef(chatId), {
    graph: chatGraph(chatId),
    subject: chatSubject(chatId),
    predicate,
    limit: 1,
  });
  return String(rows[0]?.[3] ?? "").trim() || null;
}

async function setChatFact(chatId: string, predicate: string, value: string | null): Promise<void> {
  const ref = chatFactsRef(chatId);
  const graph = chatGraph(chatId);
  const subject = chatSubject(chatId);
  const existing = await moo.facts.match(ref, { graph, subject, predicate });
  const removes = existing.map((row) => [row[0], row[1], row[2], row[3]] as [string, string, string, string]);
  const adds = value ? ([[graph, subject, predicate, value]] as [string, string, string, string][]) : [];
  await moo.facts.swap(ref, removes, adds);
}

export async function getChatEffort(chatId: string): Promise<string | null> {
  return normalizeEffort(await getChatFact(chatId, CHAT_EFFORT_PREDICATE));
}

export async function defaultChatEffort(): Promise<string | null> {
  return normalizeEffort(
    (await moo.env.get("MOO_LLM_EFFORT")) ||
      (await moo.env.get("ANTHROPIC_EFFORT")) ||
      (await moo.env.get("ANTHROPIC_THINKING_EFFORT")) ||
      (await moo.env.get("OPENAI_REASONING_EFFORT")) ||
      (await moo.env.get("OPENAI_EFFORT")),
  );
}

export async function lastChatModel(): Promise<string | null> {
  const parsed = splitModelId(await moo.refs.get(LAST_MODEL_REF));
  return parsed.model || null;
}

export async function lastChatEffort(): Promise<string | null> {
  return normalizeEffort(await moo.refs.get(LAST_EFFORT_REF));
}

export async function rememberChatModel(model: string | null): Promise<void> {
  const parsed = splitModelId(model);
  if (parsed.model) await moo.refs.set(LAST_MODEL_REF, parsed.model);
  else await moo.refs.delete(LAST_MODEL_REF);
}

export async function rememberChatEffort(effort: string | null): Promise<void> {
  const normalized = normalizeEffort(effort);
  if (normalized) await moo.refs.set(LAST_EFFORT_REF, normalized);
  else await moo.refs.delete(LAST_EFFORT_REF);
}

export async function applyLastChatSettings(chatId: string): Promise<void> {
  const [model, effort] = await Promise.all([lastChatModel(), lastChatEffort()]);
  await Promise.all([setChatModel(chatId, model), setChatEffort(chatId, effort)]);
}

export function effortAllowedForModel(efforts: readonly string[], effort: string | null | undefined): string | null {
  const normalized = normalizeEffort(effort);
  return normalized && efforts.includes(normalized) ? normalized : null;
}

export function modelSupportsToolCalls(model: string): boolean {
  const id = model.trim().toLowerCase();
  if (!id) return false;
  if (id.startsWith("claude-")) return true;

  if (id.startsWith("qwen")) {
    if (/(?:omni|vl|audio|image|asr|tts|embedding|rerank|long)/.test(id)) return false;
    return /^qwen3(?:[.-]|$)/.test(id) || /^qwen-(?:plus|max|turbo|flash)(?:[-.]|$)/.test(id);
  }

  if (/(?:^|[-.])(?:audio|realtime|image|transcribe|tts|search|embedding|moderation|whisper|dall-e|deep-research)(?:[-.]|$)/.test(id)) {
    return false;
  }
  return (
    /^gpt-5(?:[.-]|$)/.test(id) ||
    /^gpt-4(?:\.1|o)?(?:[.-]|$)/.test(id) ||
    /^o(?:3|4)(?:[.-]|$)/.test(id) ||
    /^chatgpt-/.test(id)
  );
}

function configuredModelsFrom(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((m) => String(m).trim()).filter(Boolean);
  } catch {
    /* allow comma/newline separated lists */
  }
  return raw.split(/[\n,]/g).map((m) => m.trim()).filter(Boolean);
}

async function configuredModelOptions(): Promise<ModelOption[]> {
  const out: ModelOption[] = [];
  const add = (provider: ProviderName, model: string) => {
    const trimmed = model.trim();
    if (!trimmed || !modelSupportsToolCalls(trimmed)) return;
    out.push({ id: modelOptionId(provider, trimmed), provider, model: trimmed, label: provider + " / " + trimmed });
  };

  for (const model of configuredModelsFrom(await moo.env.get("MOO_LLM_MODELS"))) {
    const parsed = splitModelId(model);
    const provider = parsed.provider || inferProviderNameForModel(parsed.model);
    if (provider) add(provider, parsed.model);
  }
  for (const model of configuredModelsFrom(await moo.env.get("OPENAI_MODELS"))) add("openai", splitModelId(model).model);
  for (const model of configuredModelsFrom(await moo.env.get("QWEN_MODELS"))) add("qwen", splitModelId(model).model);
  for (const model of configuredModelsFrom(await moo.env.get("ANTHROPIC_MODELS"))) add("anthropic", splitModelId(model).model);
  return out;
}

export async function modelOptionsFor(selectedProvider: ProviderName | null, selectedModel: string | null): Promise<ModelOption[]> {
  const openaiDefaults = [
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.4-pro",
    "gpt-5.3-chat-latest",
    "gpt-5.3-codex",
    "gpt-5.2",
    "gpt-5.2-chat-latest",
    "gpt-5.2-codex",
    "gpt-5.2-pro",
    "gpt-5.1",
    "gpt-5.1-chat-latest",
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5",
    "gpt-5-chat-latest",
    "gpt-5-codex",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5-pro",
    "o4-mini",
    "o3",
    "o3-pro",
    "o3-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o",
    "gpt-4o-mini",
  ];
  const qwenDefaults = [
    "qwen3.6",
    "qwen3-max",
    "qwen3-plus",
    "qwen3-turbo",
    "qwen3-flash",
    "qwen3-coder-plus",
    "qwen3-coder-flash",
    "qwen3-coder-next",
    "qwen-plus",
    "qwen-plus-latest",
    "qwen-max",
    "qwen-max-latest",
    "qwen-turbo",
    "qwen-turbo-latest",
    "qwen-flash",
  ];
  const anthropicDefaults = [
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-opus-4-1",
    "claude-sonnet-4",
    "claude-opus-4",
    "claude-3-7-sonnet-latest",
    "claude-3-7-sonnet",
  ];

  const defaults: Record<ProviderName, string[]> = {
    openai: openaiDefaults,
    anthropic: anthropicDefaults,
    qwen: qwenDefaults,
  };

  const options: ModelOption[] = [];
  const seen = new Set<string>();
  const add = (provider: ProviderName, model: string) => {
    const trimmed = model.trim();
    if (!trimmed || !modelSupportsToolCalls(trimmed)) return;
    const id = modelOptionId(provider, trimmed);
    if (seen.has(id)) return;
    seen.add(id);
    options.push({ id, provider, model: trimmed, label: provider + " / " + trimmed });
  };

  if (selectedProvider && selectedModel) add(selectedProvider, selectedModel);

  for (const provider of PROVIDERS) {
    const resolved = await resolveProvider(null, null, provider);
    add(provider, resolved.model);
  }

  for (const option of await configuredModelOptions()) add(option.provider, option.model);
  for (const provider of PROVIDERS) for (const model of defaults[provider]) add(provider, model);
  return options;
}

export async function modelListFor(providerName: string, defaultModel: string, selectedModel: string | null): Promise<string[]> {
  const selectedProvider = normalizeProvider(providerName) || inferProviderNameForModel(selectedModel || defaultModel);
  return (await modelOptionsFor(selectedProvider, selectedModel)).map((option) => option.id);
}

export async function chatModelInfo(chatId: string) {
  const selectedProvider = await getChatProvider(chatId);
  const selectedModel = await getChatModel(chatId);
  const selectedEffort = await getChatEffort(chatId);
  const baseProvider = await resolveProvider(null, null);
  const effectiveProvider = await resolveProvider(selectedModel, selectedEffort, selectedProvider);
  const efforts = effortLevelsForProvider(effectiveProvider);
  const effortSupported = efforts.length > 0;
  const defaultEffort = effortSupported ? effortAllowedForModel(efforts, await defaultChatEffort()) : null;
  const supportedSelectedEffort = effortAllowedForModel(efforts, selectedEffort);
  const modelOptions = await modelOptionsFor(selectedProvider || effectiveProvider.name, selectedModel);
  const selectedModelId = selectedProvider && selectedModel ? modelOptionId(selectedProvider, selectedModel) : null;
  const defaultModelId = modelOptionId(baseProvider.name, baseProvider.model);
  const effectiveModelId = modelOptionId(effectiveProvider.name, effectiveProvider.model);
  return {
    chatId,
    provider: effectiveProvider.name,
    selectedProvider,
    defaultModel: baseProvider.model,
    defaultModelId,
    selectedModel,
    selectedModelId,
    effectiveModel: effectiveProvider.model,
    effectiveModelId,
    models: modelOptions.map((option) => option.id),
    modelOptions,
    defaultEffort,
    selectedEffort: supportedSelectedEffort,
    effectiveEffort: supportedSelectedEffort || defaultEffort,
    effortSupported,
    efforts,
  };
}

export async function chatModelsCommand(input: Input) {
  const chatId = input.chatId || "demo";
  return { ok: true, value: await chatModelInfo(chatId) };
}

export async function chatModelSetCommand(input: Input) {
  if (!input.chatId) {
    return { ok: false, error: { message: "chat-model-set requires chatId" } };
  }
  const parsed = splitModelId(input.model);
  await setChatModel(input.chatId, parsed.model || null);
  await rememberChatModel(parsed.model || null);
  return { ok: true, value: await chatModelInfo(input.chatId) };
}

export async function chatEffortSetCommand(input: Input) {
  if (!input.chatId) {
    return { ok: false, error: { message: "chat-effort-set requires chatId" } };
  }
  const effort = normalizeEffort(input.effort);
  if (input.effort != null && String(input.effort).trim() && !effort) {
    return { ok: false, error: { message: "invalid effort; expected minimal, low, medium, high, xhigh, or max" } };
  }
  const selectedProvider = await getChatProvider(input.chatId);
  const selectedModel = await getChatModel(input.chatId);
  const provider = await resolveProvider(selectedModel, null, selectedProvider);
  const efforts = effortLevelsForProvider(provider);
  if (effort && !efforts.includes(effort)) {
    const model = provider.model || "this model";
    const expected = efforts.length ? efforts.join(", ") : "none";
    return { ok: false, error: { message: model + " does not support effort " + effort + "; expected " + expected } };
  }
  await setChatEffort(input.chatId, effort);
  await rememberChatEffort(effort);
  return { ok: true, value: await chatModelInfo(input.chatId) };
}

export async function chatSettingsCommand(input: Input) {
  const rawIds = Array.isArray(input.chatIds) ? input.chatIds : [];
  const ids = rawIds.map((id: unknown) => String(id ?? "").trim()).filter(Boolean);
  const settings: Record<string, { effort: string | null }> = {};
  for (const id of ids) settings[id] = { effort: await getChatEffort(id) };
  return { ok: true, value: { settings } };
}
