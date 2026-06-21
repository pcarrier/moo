import { z } from "zod";

export { z };

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(jsonValueSchema), jsonObjectSchema])
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.lazy(() =>
  z.record(z.union([jsonValueSchema, z.undefined()]))
);

export const stringArraySchema = z.array(z.unknown());

export function parseJson<T>(text: string, context: string, schema?: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${context}: invalid JSON (${message})`);
  }
  if (schema) {
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`${context}: invalid shape (${result.error.message})`);
    }
    return result.data;
  }
  return parsed as T;
}
