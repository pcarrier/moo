import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

const memoryView = readFileSync(new URL("./MemoryView.tsx", import.meta.url), "utf8");

describe("facts view scroll stability", () => {
  test("fact data refreshes do not reset pagination", () => {
    const resetEffect = memoryView.slice(
      memoryView.indexOf("  createEffect(() => {\n    search();"),
      memoryView.indexOf("  createEffect(() => {\n    const maxPage = pageCount();"),
    );

    expect(resetEffect).toContain("search();");
    expect(resetEffect).toContain("pageSize();");
    expect(resetEffect).toContain("selectedGraph();");
    expect(resetEffect).toContain("setPage(1);");
    expect(resetEffect).not.toContain("bag.triples();");
  });
});
