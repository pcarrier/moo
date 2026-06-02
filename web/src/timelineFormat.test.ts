import { expect, test } from "bun:test";
import { formatRunTSArgs } from "./timeline/format";

test("formatRunTSArgs preserves original object key order", () => {
  expect(formatRunTSArgs({ z: 0, a: 1, nested: { beta: 2, alpha: 1 } })).toBe(`{
  z: 0
  a: 1
  nested: {
    beta: 2
    alpha: 1
  }
}`);
});
