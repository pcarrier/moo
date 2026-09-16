import { describe, expect, test } from "bun:test";
import {
  jsonObjectSchema,
  parseJson,
  recordUnknownSchema,
  rightSidebarLayoutSchema,
  stringRecordSchema,
  toolCallArgsSchema,
} from "./schema";

describe("record schemas", () => {
  test("preserves arbitrary keys and recursive JSON values", () => {
    const value = {
      "": null,
      "tool:args": { nested: [true, 42, "text", null] },
      unset: undefined,
    };
    expect(jsonObjectSchema.parse(value)).toEqual(value);
    expect(jsonObjectSchema.safeParse({ invalid: () => {} }).success).toBe(false);
    expect(jsonObjectSchema.safeParse([]).success).toBe(false);
  });

  test("validates record values without requiring any keys", () => {
    expect(stringRecordSchema.parse({})).toEqual({});
    expect(stringRecordSchema.parse({ "X-Custom": "value" })).toEqual({ "X-Custom": "value" });
    expect(stringRecordSchema.safeParse({ key: 42 }).success).toBe(false);
    expect(recordUnknownSchema.parse({ key: undefined, nested: [1] })).toEqual({ key: undefined, nested: [1] });
  });

  test("accepts arbitrary sidebar IDs and optional layout fields", () => {
    const layout = { "app:example": {}, trail: { width: 320, collapsed: false } };
    expect(rightSidebarLayoutSchema.parse(layout)).toEqual(layout);
    expect(rightSidebarLayoutSchema.safeParse({ trail: { collapsed: "yes" } }).success).toBe(false);
  });

  test("accepts structured or streaming tool arguments", () => {
    expect(toolCallArgsSchema.parse({ args: { nested: [1, null] } })).toEqual({ args: { nested: [1, null] } });
    expect(toolCallArgsSchema.parse('{"partial":')).toBe('{"partial":');
    expect(toolCallArgsSchema.safeParse([]).success).toBe(false);
  });

  test("keeps parse error context for invalid JSON and shapes", () => {
    expect(parseJson('{"key":"value"}', "settings", stringRecordSchema)).toEqual({ key: "value" });
    expect(() => parseJson("{", "settings", stringRecordSchema)).toThrow("settings: invalid JSON");
    expect(() => parseJson('{"key":1}', "settings", stringRecordSchema)).toThrow("settings: invalid shape");
  });
});
