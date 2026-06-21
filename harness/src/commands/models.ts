import { parseJson } from "../core/json";
import { moo } from "../moo";
import { chatRefs } from "../lib";
import { Term } from "../types";
import {
  decodeSimpleTurtleString,
  effortLevelsForProvider,
  normalizeEffort,
  resolveProvider,
} from "../agent";
import {
  defaultModelIds,
  inferProviderForModelId,
  modelMetadataFor,
  modelSupportsOpenAIFastMode,
  modelSupportsTools,
  modelSupportsVision,
  normalizeProvider,
  openAIBaseModelForRequest,
  openAIFastModelId,
  openAIServiceTierForModel,
  PROVIDERS,
  type ProviderName,
} from "../llm_models";
import type { Input } from "./_shared";

export type ModelOption = {
  id: string;
  provider: ProviderName;
  model: string;
  label: string;
  supportsAttachments?: boolean;
  availability?: string;
};

export function splitModelId(value: unknown): { provider: ProviderName | null; model: string } {
  const raw = String(value ?? "").trim();
  const sep = raw.indexOf(":");
  if (sep < 0) return { provider: null, model: raw };
  const provider = normalizeProvider(raw.slice(0, sep));
  if (!provider) return { provider: null, model: raw };
  return { provider, model: raw.slice(sep + 1).trim() };
}

export function modelOptionId(provider: ProviderName, model: string): string {
  return provider + ":" + model;
}

function inferProviderNameForModel(model: string | null | undefined): ProviderName | null {
  return inferProviderForModelId(model);
}

async function getChatSetting(chatId: string, key: "model" | "provider" | "effort", predicate: string): Promise<string | null> {
  const c = chatRefs(chatId);
  const ref = c[key];
  const stored = String((await moo.pointers.get({ name: ref })) ?? "").trim();
  if (stored) return stored;
  return getChatFact(chatId, predicate);
}

async function setChatSetting(chatId: string, key: "model" | "provider" | "effort", predicate: string, value: string | null): Promise<void> {
  const c = chatRefs(chatId);
  const ref = c[key];
  const normalized = String(value ?? "").trim();
  if (normalized) await moo.pointers.set({ name: ref, target: normalized });
  else await moo.pointers.delete({ name: ref });

  const store = chatFactsRef(chatId);
  const graph = chatGraph(chatId);
  const subject = chatSubject(chatId);
  const existing = await moo.facts.match({ store, ...{ graph, subject, predicate } });
  if (existing.length) {
    await moo.facts.swap({
      store,
      removes: existing.map((row) => ({
        graph: row[0],
        subject: row[1],
        predicate: row[2],
        object: new Term(row[3]),
      })),
      adds: [],
    });
  }
}

export async function getChatProvider(chatId: string): Promise<ProviderName | null> {
  return normalizeProvider(await getChatSetting(chatId, "provider", CHAT_PROVIDER_PREDICATE));
}

export async function getChatModel(chatId: string): Promise<string | null> {
  const raw = await getChatSetting(chatId, "model", CHAT_MODEL_PREDICATE);
  const parsed = splitModelId(raw);
  return parsed.model || null;
}

export async function setChatModel(chatId: string, model: string | null): Promise<void> {
  const parsed = splitModelId(model);
  const modelName = parsed.model || null;
  // Persist explicit provider when given (e.g. "openai:gpt-5"); otherwise infer from
  // model name so the picker shows the same row the user clicked even after a refresh.
  const provider = modelName ? (parsed.provider || inferProviderNameForModel(modelName)) : null;
  await setChatSetting(chatId, "model", CHAT_MODEL_PREDICATE, modelName);
  await setChatSetting(chatId, "provider", CHAT_PROVIDER_PREDICATE, provider);
}

export async function setChatEffort(chatId: string, effort: string | null): Promise<void> {
  await setChatSetting(chatId, "effort", CHAT_EFFORT_PREDICATE, normalizeEffort(effort));
}

export const CHAT_MODEL_PREDICATE = "ui:model";
export const CHAT_PROVIDER_PREDICATE = "ui:provider";
export const CHAT_EFFORT_PREDICATE = "ui:effortLevel";

const LAST_MODEL_REF = "ui/last-model";
const LAST_PROVIDER_REF = "ui/last-provider";
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
  const rows = await moo.facts.match({ store: chatFactsRef(chatId), ...{
    graph: chatGraph(chatId),
    subject: chatSubject(chatId),
    predicate,
    limit: 1,
  } });
  // Fact objects come back in their stored Turtle form (string literals are
  // wrapped in quotes); decode so callers see the raw string they wrote.
  return decodeSimpleTurtleString(String(rows[0]?.[3] ?? "")).trim() || null;
}

async function setChatFact(chatId: string, predicate: string, value: string | null): Promise<void> {
  const store = chatFactsRef(chatId);
  const graph = chatGraph(chatId);
  const subject = chatSubject(chatId);
  const existing = await moo.facts.match({ store, ...{ graph, subject, predicate } });
  // facts.match() returns objects already in their stored Turtle form.
  // Wrap in Term so facts.swap() does not re-encode them (which would double
  // the quoting and silently leave the old fact in place).
  const removes = existing.map((row) => ({
    graph: row[0],
    subject: row[1],
    predicate: row[2],
    object: new Term(row[3]),
  }));
  const adds = value ? [{ graph, subject, predicate, object: value }] : [];
  await moo.facts.swap({ store, removes, adds });
}

export async function getChatEffort(chatId: string): Promise<string | null> {
  return normalizeEffort(await getChatSetting(chatId, "effort", CHAT_EFFORT_PREDICATE));
}

export async function defaultChatEffort(): Promise<string | null> {
  return normalizeEffort(
    (await moo.env.get({ name: "MOO_LLM_EFFORT" })) ||
      (await moo.env.get({ name: "ANTHROPIC_EFFORT" })) ||
      (await moo.env.get({ name: "ANTHROPIC_THINKING_EFFORT" })) ||
      (await moo.env.get({ name: "OPENAI_REASONING_EFFORT" })) ||
      (await moo.env.get({ name: "OPENAI_EFFORT" })) ||
      (await moo.env.get({ name: "DEEPSEEK_REASONING_EFFORT" })) ||
      (await moo.env.get({ name: "DEEPSEEK_EFFORT" })),
  );
}

export async function lastChatModel(): Promise<string | null> {
  const stored = String((await moo.pointers.get({ name: LAST_MODEL_REF })) ?? "").trim();
  if (!stored) return null;
  const parsed = splitModelId(stored);
  if (!parsed.model) return null;
  if (parsed.provider) return modelOptionId(parsed.provider, parsed.model);
  const provider = normalizeProvider(await moo.pointers.get({ name: LAST_PROVIDER_REF }));
  return provider ? modelOptionId(provider, parsed.model) : parsed.model;
}

export async function lastChatEffort(): Promise<string | null> {
  return normalizeEffort(await moo.pointers.get({ name: LAST_EFFORT_REF }));
}

export async function rememberChatModel(model: string | null): Promise<void> {
  const parsed = splitModelId(model);
  const modelName = parsed.model || null;
  const provider = modelName ? (parsed.provider || inferProviderNameForModel(modelName)) : null;
  if (modelName) await moo.pointers.set({ name: LAST_MODEL_REF, target: modelName });
  else await moo.pointers.delete({ name: LAST_MODEL_REF });
  if (provider) await moo.pointers.set({ name: LAST_PROVIDER_REF, target: provider });
  else await moo.pointers.delete({ name: LAST_PROVIDER_REF });
}

export async function rememberChatEffort(effort: string | null): Promise<void> {
  const normalized = normalizeEffort(effort);
  if (normalized) await moo.pointers.set({ name: LAST_EFFORT_REF, target: normalized });
  else await moo.pointers.delete({ name: LAST_EFFORT_REF });
}

export async function applyDefaultChatSettings(chatId: string): Promise<void> {
  const [model, effort, configuredEffort] = await Promise.all([lastChatModel(), lastChatEffort(), defaultChatEffort()]);
  const effective = await resolveProvider(null, effort || configuredEffort, model ? splitModelId(model).provider : null);
  await Promise.all([
    setChatModel(chatId, model || modelOptionId(effective.name, effective.model)),
    setChatEffort(chatId, effort || configuredEffort),
  ]);
}

export async function applyLastChatSettings(chatId: string): Promise<void> {
  await applyDefaultChatSettings(chatId);
}

export function effortAllowedForModel(efforts: readonly string[], effort: string | null | undefined): string | null {
  const normalized = normalizeEffort(effort);
  return normalized && efforts.includes(normalized) ? normalized : null;
}

export function modelSupportsToolCalls(model: string): boolean {
  return modelSupportsTools(inferProviderNameForModel(model), model);
}

export function modelSupportsAttachments(provider: ProviderName | null | undefined, model: string | null | undefined): boolean {
  return modelSupportsVision(provider, model);
}

function modelAvailability(provider: ProviderName | null | undefined, model: string | null | undefined): string | undefined {
  return modelMetadataFor(provider, model)?.availability;
}

function modelOptionLabel(provider: ProviderName, model: string): string {
  const base = provider === "openai" ? openAIBaseModelForRequest(model) : model;
  const suffix = provider === "openai" && openAIServiceTierForModel(model) ? " (fast)" : "";
  return provider + " / " + base + suffix;
}

function configuredModelsFrom(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = parseJson(raw, "rememberChatSettings");
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
    out.push({
      id: modelOptionId(provider, trimmed),
      provider,
      model: trimmed,
      label: modelOptionLabel(provider, trimmed),
      supportsAttachments: modelSupportsAttachments(provider, trimmed),
      availability: modelAvailability(provider, trimmed),
    });
  };
  const addWithFastMode = (provider: ProviderName, model: string) => {
    add(provider, model);
    if (modelSupportsOpenAIFastMode(provider, model)) add(provider, openAIFastModelId(model));
  };

  for (const model of configuredModelsFrom(await moo.env.get({ name: "MOO_LLM_MODELS" }))) {
    const parsed = splitModelId(model);
    const provider = parsed.provider || inferProviderNameForModel(parsed.model);
    if (provider) addWithFastMode(provider, parsed.model);
  }
  for (const model of configuredModelsFrom(await moo.env.get({ name: "OPENAI_MODELS" }))) addWithFastMode("openai", splitModelId(model).model);
  for (const model of configuredModelsFrom(await moo.env.get({ name: "QWEN_MODELS" }))) addWithFastMode("qwen", splitModelId(model).model);
  for (const model of configuredModelsFrom(await moo.env.get({ name: "GLM_MODELS" }))) addWithFastMode("glm", splitModelId(model).model);
  for (const model of configuredModelsFrom(await moo.env.get({ name: "ZAI_MODELS" }))) addWithFastMode("glm", splitModelId(model).model);
  for (const model of configuredModelsFrom(await moo.env.get({ name: "ANTHROPIC_MODELS" }))) addWithFastMode("anthropic", splitModelId(model).model);
  for (const model of configuredModelsFrom(await moo.env.get({ name: "XAI_MODELS" }))) addWithFastMode("xai", splitModelId(model).model);
  for (const model of configuredModelsFrom(await moo.env.get({ name: "DEEPSEEK_MODELS" }))) addWithFastMode("deepseek", splitModelId(model).model);
  for (const model of configuredModelsFrom(await moo.env.get({ name: "KIMI_MODELS" }))) addWithFastMode("kimi", splitModelId(model).model);
  for (const model of configuredModelsFrom(await moo.env.get({ name: "MOONSHOT_MODELS" }))) addWithFastMode("kimi", splitModelId(model).model);
  return out;
}

export async function modelOptionsFor(selectedProvider: ProviderName | null, selectedModel: string | null): Promise<ModelOption[]> {
  const options: ModelOption[] = [];
  const seen = new Set<string>();
  const add = (provider: ProviderName, model: string) => {
    const trimmed = model.trim();
    if (!trimmed || !modelSupportsToolCalls(trimmed)) return;
    const id = modelOptionId(provider, trimmed);
    if (seen.has(id)) return;
    seen.add(id);
    options.push({
      id,
      provider,
      model: trimmed,
      label: modelOptionLabel(provider, trimmed),
      supportsAttachments: modelSupportsAttachments(provider, trimmed),
      availability: modelAvailability(provider, trimmed),
    });
  };
  const addWithFastMode = (provider: ProviderName, model: string) => {
    add(provider, model);
    if (modelSupportsOpenAIFastMode(provider, model)) add(provider, openAIFastModelId(model));
  };

  if (selectedProvider && selectedModel) addWithFastMode(selectedProvider, selectedModel);

  for (const provider of PROVIDERS) {
    const resolved = await resolveProvider(null, null, provider);
    const model = resolved.name === "openai" && resolved.serviceTier ? openAIFastModelId(resolved.model) : resolved.model;
    addWithFastMode(provider, model);
  }

  for (const option of await configuredModelOptions()) add(option.provider, option.model);
  for (const provider of PROVIDERS) for (const model of defaultModelIds(provider)) addWithFastMode(provider, model);
  return options;
}

export async function modelListFor(providerName: string, fallbackModel: string, selectedModel: string | null): Promise<string[]> {
  const selectedProvider = normalizeProvider(providerName) || inferProviderNameForModel(selectedModel || fallbackModel);
  return (await modelOptionsFor(selectedProvider, selectedModel)).map((option) => option.id);
}

export async function chatModelInfo(chatId: string) {
  const selectedProvider = await getChatProvider(chatId);
  const selectedModel = await getChatModel(chatId);
  const selectedEffort = await getChatEffort(chatId);
  const effectiveProvider = await resolveProvider(selectedModel, selectedEffort, selectedProvider);
  const authMode = effectiveProvider.authMode ?? null;
  const efforts = effortLevelsForProvider(effectiveProvider);
  const effortSupported = efforts.length > 0;
  const configuredEffort = effortSupported ? effortAllowedForModel(efforts, await defaultChatEffort()) : null;
  const defaultEffort = configuredEffort || (effectiveProvider.name === "deepseek" && effortSupported ? "high" : null);
  const supportedSelectedEffort = effortAllowedForModel(efforts, selectedEffort);
  const modelOptions = await modelOptionsFor(selectedProvider || effectiveProvider.name, selectedModel);
  const selectedModelId = selectedProvider && selectedModel ? modelOptionId(selectedProvider, selectedModel) : null;
  const effectiveOptionModel = effectiveProvider.name === "openai" && effectiveProvider.serviceTier ? openAIFastModelId(effectiveProvider.model) : effectiveProvider.model;
  const effectiveModelId = modelOptionId(effectiveProvider.name, effectiveOptionModel);
  const supportsAttachments = modelSupportsAttachments(effectiveProvider.name, effectiveProvider.model);
  return {
    chatId,
    provider: effectiveProvider.name,
    authMode,
    selectedProvider,
    selectedModel,
    selectedModelId,
    effectiveModel: effectiveProvider.model,
    effectiveModelId,
    models: modelOptions.map((option) => option.id),
    modelOptions,
    supportsAttachments,
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
  const model = parsed.model ? String(input.model ?? "") : null;
  await setChatModel(input.chatId, model);
  await rememberChatModel(model);
  return { ok: true, value: await chatModelInfo(input.chatId) };
}

export async function chatEffortSetCommand(input: Input) {
  if (!input.chatId) {
    return { ok: false, error: { message: "chat-effort-set requires chatId" } };
  }
  const effort = normalizeEffort(input.effort);
  if (input.effort != null && String(input.effort).trim() && !effort) {
    return { ok: false, error: { message: "invalid effort; expected none, minimal, low, medium, high, xhigh, or max" } };
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
  const ids = [...new Set(rawIds.map((id: unknown) => String(id ?? "").trim()).filter(Boolean))];
  const entries = await Promise.all(ids.map(async (id) => [id, await getChatEffort(id)] as const));
  const settings: Record<string, { effort: string | null }> = {};
  for (const [id, effort] of entries) settings[id] = { effort };
  return { ok: true, value: { settings } };
}
