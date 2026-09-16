import { describe, expect, test } from "bun:test";
import { jsonObjectSchema, parseJson } from "./json";
import { httpHeaderRecordSchema, mcpServerConfigSchema } from "./schema";

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

  test("keeps parse error context for invalid JSON and shapes", () => {
    expect(parseJson('{"nested":[1,null]}', "payload", jsonObjectSchema)).toEqual({ nested: [1, null] });
    expect(() => parseJson("{", "payload", jsonObjectSchema)).toThrow("payload: invalid JSON");
    expect(() => parseJson("[]", "payload", jsonObjectSchema)).toThrow("payload: invalid shape");
  });

  test("accepts unknown HTTP header values for later normalization", () => {
    const headers = { "Content-Type": "application/json", "X-Count": 2, empty: undefined };
    expect(httpHeaderRecordSchema.parse(headers)).toEqual(headers);
    expect(httpHeaderRecordSchema.parse({})).toEqual({});
    expect(httpHeaderRecordSchema.safeParse([]).success).toBe(false);
  });

  test("requires string MCP header values but permits omitted headers", () => {
    const config = { id: "example", url: "https://example.com/mcp" };
    expect(mcpServerConfigSchema.parse(config)).toEqual(config);
    expect(mcpServerConfigSchema.parse({ ...config, headers: {} })).toEqual({ ...config, headers: {} });
    expect(mcpServerConfigSchema.parse({ ...config, headers: { "X-Custom": "value" } }).headers).toEqual({ "X-Custom": "value" });
    expect(mcpServerConfigSchema.safeParse({ ...config, headers: { "X-Custom": 1 } }).success).toBe(false);
  });
});
