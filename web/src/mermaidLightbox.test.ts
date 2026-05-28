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

  test("dismisses when clicking outside the diagram content", () => {
    expect(mermaid).toContain("const target = event.target;");
    expect(mermaid).toContain("if (!(target instanceof Node)) return;");
    expect(mermaid).toContain("if (content.contains(target) || toolbar.contains(target)) return;");
    expect(mermaid).toContain("close();");
    expect(mermaid).not.toContain("if (event.target === overlay) close();");
  });

  test("does not dismiss immediately after dragging to pan", () => {
    expect(mermaid).toContain("let movedDuringDrag = false;");
    expect(mermaid).toContain("if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) movedDuringDrag = true;");
    expect(mermaid).toContain("if (suppressNextOutsideClick) {");
    expect(mermaid).toContain("if (suppressOutsideClickTimer !== undefined) window.clearTimeout(suppressOutsideClickTimer);");
  });
});


describe("mermaid streaming updates", () => {
  test("keeps rendered diagrams while partial updates are pending", () => {
    expect(mermaid).toContain('data-mermaid-pending-source');
    expect(mermaid).toContain('if (partial) await mermaid.parse(source, { suppressErrors: false });');
    expect(mermaid).toContain('deferPartialMermaidUpdate(element, source, error);');
    expect(mermaid).toContain('queueMermaidSourceUpdate(previous, element);');
    expect(mermaid).toContain('delete element.dataset.mermaidPendingSource;');
  });

  test("keeps Mermaid syntax errors from breaking timeline layout", () => {
    const errorRule = timelineCss.match(/\.markdown \.mermaid\[data-mermaid-error\]\s*\{[^}]+\}/)?.[0] ?? "";
    expect(mermaid).toContain("suppressErrorRendering: true");
    expect(mermaid).toContain("removeMermaidRenderArtifacts(id);");
    expect(mermaid).toContain('document.getElementById("d" + id)?.remove();');
    expect(errorRule).toContain("max-inline-size: 100%;");
    expect(errorRule).toContain("max-block-size: min(22rem, 60vh);");
    expect(errorRule).toContain("overflow: auto;");
    expect(errorRule).toContain("white-space: pre-wrap;");
    expect(errorRule).toContain("overflow-wrap: anywhere;");
    expect(errorRule).toContain("word-break: break-word;");
  });
});
