const MODEL_MRU_KEY = "moo.model.mru.v1";
const MODEL_MRU_MAX = 20;

export function normalizeModelMru(value: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    const model = String(item || "").trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
    if (out.length >= MODEL_MRU_MAX) break;
  }
  return out;
}

export function readModelMru(): string[] {
  try {
    return normalizeModelMru(JSON.parse(localStorage.getItem(MODEL_MRU_KEY) || "[]"));
  } catch {
    return [];
  }
}

export function persistModelMru(models: string[]) {
  try {
    localStorage.setItem(MODEL_MRU_KEY, JSON.stringify(normalizeModelMru(models)));
  } catch {
    // ignore quota/security errors
  }
}
