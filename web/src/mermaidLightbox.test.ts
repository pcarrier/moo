import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const mermaid = readFileSync(new URL("./mermaid.ts", import.meta.url), "utf8");
const timelineCss = readFileSync(new URL("./styles/timeline.css", import.meta.url), "utf8");
const viewportRule = timelineCss.match(/\.mermaid-lightbox-viewport\s*\{[^}]+\}/)?.[0] ?? "";
const contentRule = timelineCss.match(/\.mermaid-lightbox-content\s*\{[^}]+\}/)?.[0] ?? "";

describe("mermaid lightbox gestures", () => {
  test("lets native touchpad scroll pan the lightbox", () => {
    expect(mermaid).toContain("if (!isLightboxZoomWheel(event)) return;");
    expect(mermaid).toContain("return event.ctrlKey;");
    expect(viewportRule).toContain("overflow: auto;");
    expect(viewportRule).toContain("overscroll-behavior: contain;");
    expect(viewportRule).toContain("touch-action: pan-x pan-y;");
    expect(viewportRule).not.toContain("overflow: hidden;");
    expect(viewportRule).not.toContain("touch-action: none;");
  });

  test("uses browser pinch wheel gestures for cursor-anchored zoom", () => {
    expect(mermaid).toContain("const deltaY = normalizedWheelDeltaY(event, viewport.clientHeight);");
    expect(mermaid).toContain("zoomBy(Math.exp(clamp(-deltaY");
    expect(mermaid).toContain("viewport.scrollLeft = scrollX * ratio - anchorX;");
    expect(mermaid).toContain("lightboxSvg.style.inlineSize");
    expect(contentRule).toContain("inline-size: max-content;");
    expect(mermaid).not.toContain("content.style.transform =");
  });
});
