import { z } from "zod";

export { z };

export function parseJson<T>(text: string, context: string, schema: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${context}: invalid JSON (${message})`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${context}: invalid shape (${result.error.message})`);
  }
  return result.data;
}

export const pskStatusSchema = z.object({
  required: z.boolean(),
  valid: z.boolean(),
});

export const stringArraySchema = z.array(z.string());

export const recordUnknownSchema = z.record(z.unknown());

export const stringRecordSchema = z.record(z.string());

export const rightSidebarLayoutSchema = z.record(
  z.object({
    width: z.union([z.string(), z.number()]).optional(),
    collapsed: z.boolean().optional(),
  }),
);

export const terminalUiStateSchema = z.object({
  open: z.preprocess((value) => value === true, z.boolean()),
  selectedSessionId: z.union([z.string(), z.null()]).optional(),
});

export const chatCacheSchema = z.object({
  entries: z.array(z.tuple([z.string(), z.unknown()])).optional(),
});

export const toolCallArgsSchema = z.union([z.record(z.unknown()), z.string()]);
