import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readStylesheetForTest } from "./styleTestUtils.test.ts";

const skillsView = readFileSync(new URL("./SkillsView.tsx", import.meta.url), "utf8");
const css = readStylesheetForTest();

function cssRuleBody(selector: string) {
  const marker = `${selector} {`;
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`missing CSS rule: ${selector}`);
  const bodyStart = start + marker.length;
  const end = css.indexOf("}\n", bodyStart);
  if (end < 0) throw new Error(`unterminated CSS rule: ${selector}`);
  return css.slice(bodyStart, end);
}

describe("skills view status messages", () => {
  test("uses the editor saved timestamp instead of a floating save toast", () => {
    expect(skillsView).not.toContain('setMessage("saved")');
    expect(skillsView).toContain('<PageBody class="skills-page">\n        <div class="skills-grid">');

    const toolbarIndex = skillsView.indexOf('class="skills-editor-toolbar"');
    const messageIndex = skillsView.indexOf('<Notice class="skills-message">');
    const formIndex = skillsView.indexOf('class="skills-form"');

    expect(messageIndex).toBeGreaterThan(toolbarIndex);
    expect(messageIndex).toBeLessThan(formIndex);
  });

  test("themes any remaining skills messages as square in-card notices", () => {
    const body = cssRuleBody(".skills-message");
    expect(body).toContain("border: 1px solid var(--line)");
    expect(body).toContain("background: var(--sidebar-active)");
    expect(body).toContain("color: var(--muted)");
    expect(body).toContain("padding: 0.5rem 0.65rem");
  });
});
