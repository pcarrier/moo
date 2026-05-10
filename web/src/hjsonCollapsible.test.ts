import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const behavior = readFileSync(new URL("./hjsonCollapsible.ts", import.meta.url), "utf8");
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("HJSON collapsible behavior", () => {
  test("delegates toggle clicks from rendered HJSON markup", () => {
    expect(behavior).toContain('doc.addEventListener("click", onClick, true)');
    expect(behavior).toContain('target.closest(HJSON_TOGGLE_SELECTOR)');
    expect(behavior).toContain('node.classList.toggle("is-collapsed", collapsed)');
    expect(behavior).toContain('toggle.setAttribute("aria-expanded", collapsed ? "false" : "true")');
    expect(behavior).toContain('toggle.setAttribute("aria-label", action + " " + kind)');
  });

  test("starts once from the app root so all highlighted HJSON can toggle", () => {
    expect(app).toContain('import { startHjsonCollapsible } from "./hjsonCollapsible";');
    expect(app).toContain('const stopHjsonCollapsible = startHjsonCollapsible(document.body);');
    expect(app).toContain('stopHjsonCollapsible();');
  });
});
