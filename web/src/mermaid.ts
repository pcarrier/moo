import mermaid from "mermaid";

const RENDER_DEBOUNCE_MS = 25;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;

let initialized = false;
let nextDiagramId = 0;
let activeLightboxCleanup: (() => void) | undefined;

export function startMermaidRenderer(root: ParentNode = document): () => void {
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: mermaidTheme(),
    });
    initialized = true;
  }

  let stopped = false;
  let timer: number | undefined;
  const schedule = () => {
    if (stopped || timer !== undefined) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      void renderPendingMermaidDiagrams(root);
    }, RENDER_DEBOUNCE_MS);
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "childList") preserveRenderedMermaidDiagrams(mutation);
    }
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          if (nodeContainsPendingMermaid(node)) return schedule();
        }
      } else if (mutation.type === "attributes" && isMermaidElement(mutation.target)) {
        schedule();
        return;
      }
    }
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-mermaid-source"],
  });

  const eventTarget = rootEventTarget(root);
  const onClick = (event: Event) => {
    const diagram = closestRenderedMermaidDiagram(event.target, root);
    if (!diagram) return;
    event.preventDefault();
    openMermaidLightbox(diagram);
  };
  const onKeyDown = (event: Event) => {
    if (!(event instanceof KeyboardEvent) || event.key !== "Enter" && event.key !== " ") return;
    const diagram = closestRenderedMermaidDiagram(event.target, root);
    if (!diagram) return;
    event.preventDefault();
    openMermaidLightbox(diagram);
  };
  eventTarget?.addEventListener("click", onClick);
  eventTarget?.addEventListener("keydown", onKeyDown);

  schedule();
  return () => {
    stopped = true;
    observer.disconnect();
    eventTarget?.removeEventListener("click", onClick);
    eventTarget?.removeEventListener("keydown", onKeyDown);
    if (timer !== undefined) window.clearTimeout(timer);
    closeActiveMermaidLightbox();
  };
}

async function renderPendingMermaidDiagrams(root: ParentNode) {
  for (const element of pendingMermaidElements(root)) await renderMermaidDiagram(element);
}

function preserveRenderedMermaidDiagrams(mutation: MutationRecord) {
  if (!mutation.removedNodes.length || !mutation.addedNodes.length) return;

  const reusable = new Map<string, HTMLElement[]>();
  for (const node of mutation.removedNodes) {
    for (const element of renderedMermaidElements(node)) {
      const source = element.dataset.mermaidSource;
      if (!source) continue;
      let elements = reusable.get(source);
      if (!elements) {
        elements = [];
        reusable.set(source, elements);
      }
      elements.push(element);
    }
  }
  if (!reusable.size) return;

  for (const node of mutation.addedNodes) {
    for (const element of pendingMermaidElements(node)) {
      const source = element.dataset.mermaidSource;
      if (!source) continue;
      const replacement = reusable.get(source)?.shift();
      if (!replacement) continue;
      element.replaceWith(replacement);
    }
  }
}

function renderedMermaidElements(root: ParentNode | Node): HTMLElement[] {
  if (root instanceof HTMLElement && root.matches(".mermaid[data-mermaid-source][data-mermaid-rendered]")) {
    return [root];
  }
  if (root instanceof Element || root instanceof Document || root instanceof DocumentFragment) {
    return Array.from(root.querySelectorAll<HTMLElement>(".mermaid[data-mermaid-source][data-mermaid-rendered]"));
  }
  return [];
}

function pendingMermaidElements(root: ParentNode | Node): HTMLElement[] {
  if (root instanceof HTMLElement && root.matches(".mermaid[data-mermaid-source]:not([data-mermaid-rendered]):not([data-mermaid-rendering])")) {
    return [root];
  }
  if (root instanceof Element || root instanceof Document || root instanceof DocumentFragment) {
    return Array.from(root.querySelectorAll<HTMLElement>(".mermaid[data-mermaid-source]:not([data-mermaid-rendered]):not([data-mermaid-rendering])"));
  }
  return [];
}

async function renderMermaidDiagram(element: HTMLElement) {
  const source = element.dataset.mermaidSource || "";
  if (!source.trim()) return;
  const id = "moo-mermaid-" + (++nextDiagramId);
  element.dataset.mermaidRendering = "true";
  try {
    const { svg, bindFunctions } = await mermaid.render(id, source);
    element.innerHTML = svg;
    bindFunctions?.(element);
    element.dataset.mermaidRendered = "true";
    element.classList.add("mermaid-zoomable");
    element.tabIndex = 0;
    element.setAttribute("role", "button");
    element.setAttribute("aria-label", "Open Mermaid diagram in zoomable lightbox");
    element.title = "Open diagram";
  } catch (error) {
    element.textContent = source;
    element.dataset.mermaidError = errorMessage(error);
    element.dataset.mermaidRendered = "true";
    element.setAttribute("role", "img");
    element.setAttribute("aria-label", "Mermaid diagram failed to render");
  } finally {
    delete element.dataset.mermaidRendering;
  }
}

function openMermaidLightbox(diagram: HTMLElement) {
  const svg = diagram.querySelector("svg");
  if (!svg) return;
  closeActiveMermaidLightbox();

  const overlay = document.createElement("div");
  overlay.className = "mermaid-lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Mermaid diagram viewer");

  const toolbar = document.createElement("div");
  toolbar.className = "mermaid-lightbox-toolbar";

  const title = document.createElement("div");
  title.className = "mermaid-lightbox-title";
  title.textContent = "Mermaid diagram";

  const zoomOutButton = mermaidLightboxButton("−", "Zoom out");
  const zoomResetButton = mermaidLightboxButton("100%", "Reset zoom");
  const zoomInButton = mermaidLightboxButton("+", "Zoom in");
  const closeButton = mermaidLightboxButton("×", "Close diagram");
  closeButton.classList.add("mermaid-lightbox-close");
  toolbar.append(title, zoomOutButton, zoomResetButton, zoomInButton, closeButton);

  const viewport = document.createElement("div");
  viewport.className = "mermaid-lightbox-viewport";

  const content = document.createElement("div");
  content.className = "mermaid-lightbox-content";
  content.append(cloneSvgForLightbox(svg));
  viewport.append(content);
  overlay.append(toolbar, viewport);
  document.body.append(overlay);
  document.body.classList.add("mermaid-lightbox-open");

  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragOriginX = 0;
  let dragOriginY = 0;

  const update = () => {
    content.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    zoomResetButton.textContent = Math.round(scale * 100) + "%";
  };
  const zoomBy = (factor: number) => {
    scale = clamp(scale * factor, MIN_ZOOM, MAX_ZOOM);
    update();
  };
  const reset = () => {
    scale = 1;
    offsetX = 0;
    offsetY = 0;
    update();
  };
  const close = () => closeActiveMermaidLightbox();

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    dragging = true;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragOriginX = offsetX;
    dragOriginY = offsetY;
    viewport.classList.add("is-panning");
    viewport.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging) return;
    offsetX = dragOriginX + event.clientX - dragStartX;
    offsetY = dragOriginY + event.clientY - dragStartY;
    update();
  };
  const onPointerUp = (event: PointerEvent) => {
    dragging = false;
    viewport.classList.remove("is-panning");
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(ZOOM_STEP);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomBy(1 / ZOOM_STEP);
    } else if (event.key === "0") {
      event.preventDefault();
      reset();
    }
  };
  const onOverlayClick = (event: MouseEvent) => {
    if (event.target === overlay) close();
  };

  zoomOutButton.addEventListener("click", () => zoomBy(1 / ZOOM_STEP));
  zoomResetButton.addEventListener("click", reset);
  zoomInButton.addEventListener("click", () => zoomBy(ZOOM_STEP));
  closeButton.addEventListener("click", close);
  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointermove", onPointerMove);
  viewport.addEventListener("pointerup", onPointerUp);
  viewport.addEventListener("pointercancel", onPointerUp);
  viewport.addEventListener("wheel", onWheel, { passive: false });
  overlay.addEventListener("click", onOverlayClick);
  window.addEventListener("keydown", onKeyDown);
  update();
  closeButton.focus();

  activeLightboxCleanup = () => {
    window.removeEventListener("keydown", onKeyDown);
    overlay.remove();
    document.body.classList.remove("mermaid-lightbox-open");
    activeLightboxCleanup = undefined;
  };
}

function closeActiveMermaidLightbox() {
  activeLightboxCleanup?.();
}

function cloneSvgForLightbox(svg: SVGSVGElement): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const size = svgLightboxSize(svg);
  clone.removeAttribute("style");
  clone.setAttribute("width", String(size.width));
  clone.setAttribute("height", String(size.height));
  clone.style.inlineSize = size.width + "px";
  clone.style.blockSize = size.height + "px";
  clone.style.maxInlineSize = "none";
  clone.style.maxBlockSize = "none";
  return clone;
}

function svgLightboxSize(svg: SVGSVGElement): { width: number; height: number } {
  const viewBox = svg.viewBox.baseVal;
  if (viewBox.width > 0 && viewBox.height > 0) return { width: viewBox.width, height: viewBox.height };

  const rect = svg.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height };

  const width = parseSvgLength(svg.getAttribute("width"));
  const height = parseSvgLength(svg.getAttribute("height"));
  return { width: width > 0 ? width : 800, height: height > 0 ? height : 600 };
}

function parseSvgLength(value: string | null): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mermaidLightboxButton(text: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mermaid-lightbox-button";
  button.textContent = text;
  button.setAttribute("aria-label", label);
  return button;
}

function closestRenderedMermaidDiagram(target: EventTarget | null, root: ParentNode): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>(".mermaid[data-mermaid-rendered]:not([data-mermaid-error])");
  if (!element || !rootContains(root, element)) return null;
  return element;
}

function rootContains(root: ParentNode, element: Element): boolean {
  if (root instanceof Document) return root.contains(element);
  if (root instanceof Element) return root.contains(element);
  if (root instanceof DocumentFragment) return root.contains(element);
  return false;
}

function rootEventTarget(root: ParentNode): EventTarget | null {
  return root instanceof EventTarget ? root : null;
}

function nodeContainsPendingMermaid(node: Node): boolean {
  return pendingMermaidElements(node).length > 0;
}

function isMermaidElement(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && node.classList.contains("mermaid") && node.hasAttribute("data-mermaid-source");
}

function mermaidTheme(): "default" | "dark" {
  return isDarkTheme() ? "dark" : "default";
}

function isDarkTheme(): boolean {
  const mode = document.documentElement.dataset.theme;
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
