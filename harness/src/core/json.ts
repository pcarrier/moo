export function parseJson<T = unknown>(text: string, context: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${context}: invalid JSON (${message})`);
  }
}
