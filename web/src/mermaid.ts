import mermaid from "mermaid";

const RENDER_DEBOUNCE_MS = 25;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;
const WHEEL_LINE_HEIGHT_PX = 16;
const WHEEL_ZOOM_DELTA_LIMIT = 500;
const WHEEL_ZOOM_SENSITIVITY = 0.002;

let initialized = false;
let nextDiagramId = 0;
let activeLightboxCleanup: (() => void) | undefined;

export function startMermaidRenderer(root: ParentNode = document): () => void {
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
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
    attributeFilter: ["data-mermaid-source", "data-mermaid-pending-source"],
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

  const reusable: HTMLElement[] = [];
  for (const node of mutation.removedNodes) {
    for (const element of renderedMermaidElements(node)) {
      if (element.dataset.mermaidSource) reusable.push(element);
    }
  }
  if (!reusable.length) return;

  for (const node of mutation.addedNodes) {
    for (const element of unrenderedMermaidElements(node)) {
      const source = element.dataset.mermaidSource;
      if (!source) continue;

      const exact = takeExactMermaidReplacement(reusable, source);
      if (exact) {
        restoreMermaidPlaceholderState(exact, element);
        element.replaceWith(exact);
        continue;
      }

      const previous = takePreviousMermaidReplacement(reusable, source);
      if (!previous) continue;
      queueMermaidSourceUpdate(previous, element);
      element.replaceWith(previous);
    }
  }
}

function takeExactMermaidReplacement(reusable: HTMLElement[], source: string): HTMLElement | null {
  return takeMermaidReplacement(reusable, reusable.findIndex((element) => element.dataset.mermaidSource === source));
}

function takePreviousMermaidReplacement(reusable: HTMLElement[], source: string): HTMLElement | null {
  let bestIndex = -1;
  let bestLength = -1;
  for (let i = 0; i < reusable.length; i++) {
    const candidate = reusable[i]!;
    if (candidate.dataset.mermaidError) continue;
    const previousSource = candidate.dataset.mermaidSource || "";
    if (!isPreviousMermaidSource(previousSource, source)) continue;
    if (previousSource.length > bestLength) {
      bestIndex = i;
      bestLength = previousSource.length;
    }
  }
  return takeMermaidReplacement(reusable, bestIndex);
}

function takeMermaidReplacement(reusable: HTMLElement[], index: number): HTMLElement | null {
  if (index < 0) return null;
  const [replacement] = reusable.splice(index, 1);
  return replacement ?? null;
}

function restoreMermaidPlaceholderState(replacement: HTMLElement, placeholder: HTMLElement) {
  delete replacement.dataset.mermaidPendingSource;
  delete replacement.dataset.mermaidPendingPartial;
  delete replacement.dataset.mermaidPendingError;
  syncPartialMermaidState(replacement, placeholder.dataset.mermaidPartial === "true");
}

function queueMermaidSourceUpdate(replacement: HTMLElement, placeholder: HTMLElement) {
  replacement.dataset.mermaidPendingSource = placeholder.dataset.mermaidSource || "";
  delete replacement.dataset.mermaidPendingError;
  if (placeholder.dataset.mermaidPartial === "true") {
    replacement.dataset.mermaidPendingPartial = "true";
  } else {
    delete replacement.dataset.mermaidPendingPartial;
  }
}

function renderedMermaidElements(root: ParentNode | Node): HTMLElement[] {
  return mermaidElements(root, ".mermaid[data-mermaid-source][data-mermaid-rendered]");
}

function pendingMermaidElements(root: ParentNode | Node): HTMLElement[] {
  return mermaidElements(root, [
    ".mermaid[data-mermaid-source]:not([data-mermaid-rendered]):not([data-mermaid-rendering])",
    ".mermaid[data-mermaid-rendered][data-mermaid-pending-source]:not([data-mermaid-rendering])",
  ].join(","));
}

function unrenderedMermaidElements(root: ParentNode | Node): HTMLElement[] {
  return mermaidElements(root, ".mermaid[data-mermaid-source]:not([data-mermaid-rendered]):not([data-mermaid-rendering])");
}

function mermaidElements(root: ParentNode | Node, selector: string): HTMLElement[] {
  if (root instanceof HTMLElement && root.matches(selector)) return [root];
  if (root instanceof Element || root instanceof Document || root instanceof DocumentFragment) {
    return Array.from(root.querySelectorAll<HTMLElement>(selector));
  }
  return [];
}

async function renderMermaidDiagram(element: HTMLElement) {
  const pendingSource = element.dataset.mermaidPendingSource;
  const source = pendingSource ?? element.dataset.mermaidSource ?? "";
  if (!source.trim()) return;
  const partial = pendingSource === undefined
    ? element.dataset.mermaidPartial === "true"
    : element.dataset.mermaidPendingPartial === "true";
  const id = "moo-mermaid-" + (++nextDiagramId);
  element.dataset.mermaidRendering = "true";
  try {
    if (partial) await mermaid.parse(source, { suppressErrors: false });
    const { svg, bindFunctions } = await mermaid.render(id, source);
    element.innerHTML = svg;
    bindFunctions?.(element);
    element.dataset.mermaidSource = source;
    element.dataset.mermaidRendered = "true";
    delete element.dataset.mermaidError;
    delete element.dataset.mermaidPendingSource;
    delete element.dataset.mermaidPendingPartial;
    delete element.dataset.mermaidPendingError;
    syncPartialMermaidState(element, partial);
    element.classList.add("mermaid-zoomable");
    element.tabIndex = 0;
    element.setAttribute("role", "button");
    element.setAttribute("aria-label", "Open Mermaid diagram in zoomable lightbox");
    element.title = "Open diagram";
  } catch (error) {
    removeMermaidRenderArtifacts(id);
    if (partial) {
      deferPartialMermaidUpdate(element, source, error);
      return;
    }
    renderMermaidError(element, source, error);
  } finally {
    delete element.dataset.mermaidRendering;
  }
}

function deferPartialMermaidUpdate(element: HTMLElement, source: string, error: unknown) {
  element.dataset.mermaidPendingError = errorMessage(error);
  if (!element.dataset.mermaidRendered) element.textContent = source;
}

function renderMermaidError(element: HTMLElement, source: string, error: unknown) {
  element.textContent = source;
  element.dataset.mermaidSource = source;
  element.dataset.mermaidError = errorMessage(error);
  element.dataset.mermaidRendered = "true";
  delete element.dataset.mermaidPendingSource;
  delete element.dataset.mermaidPendingPartial;
  delete element.dataset.mermaidPendingError;
  syncPartialMermaidState(element, false);
  element.classList.remove("mermaid-zoomable");
  element.removeAttribute("tabindex");
  element.removeAttribute("title");
  element.setAttribute("role", "img");
  element.setAttribute("aria-label", "Mermaid diagram failed to render");
}

function removeMermaidRenderArtifacts(id: string) {
  document.getElementById("d" + id)?.remove();
  document.getElementById("i" + id)?.remove();
  document.getElementById(id)?.remove();
}

function isPreviousMermaidSource(previous: string, next: string): boolean {
  return previous.length > 0 && previous.length < next.length && next.startsWith(previous);
}

function syncPartialMermaidState(element: HTMLElement, partial: boolean) {
  if (partial) {
    element.dataset.mermaidPartial = "true";
  } else {
    delete element.dataset.mermaidPartial;
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

  const svgSize = svgLightboxSize(svg);
  const lightboxSvg = cloneSvgForLightbox(svg, svgSize);

  const content = document.createElement("div");
  content.className = "mermaid-lightbox-content";
  content.append(lightboxSvg);
  viewport.append(content);
  overlay.append(toolbar, viewport);
  document.body.append(overlay);
  document.body.classList.add("mermaid-lightbox-open");

  let scale = 1;
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragOriginX = 0;
  let dragOriginY = 0;
  let movedDuringDrag = false;
  let suppressNextOutsideClick = false;
  let suppressOutsideClickTimer: number | undefined;

  const update = () => {
    lightboxSvg.style.inlineSize = Math.max(1, svgSize.width * scale) + "px";
    lightboxSvg.style.blockSize = Math.max(1, svgSize.height * scale) + "px";
    zoomResetButton.textContent = Math.round(scale * 100) + "%";
  };
  const centerContent = () => {
    viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
    viewport.scrollTop = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2);
  };
  const zoomBy = (factor: number, anchor?: { clientX: number; clientY: number }) => {
    const nextScale = clamp(scale * factor, MIN_ZOOM, MAX_ZOOM);
    if (nextScale === scale) return;

    const previousScale = scale;
    const rect = viewport.getBoundingClientRect();
    const anchorX = anchor ? anchor.clientX - rect.left : viewport.clientWidth / 2;
    const anchorY = anchor ? anchor.clientY - rect.top : viewport.clientHeight / 2;
    const scrollX = viewport.scrollLeft + anchorX;
    const scrollY = viewport.scrollTop + anchorY;

    scale = nextScale;
    update();

    const ratio = scale / previousScale;
    viewport.scrollLeft = scrollX * ratio - anchorX;
    viewport.scrollTop = scrollY * ratio - anchorY;
  };
  const reset = () => {
    scale = 1;
    update();
    centerContent();
  };
  const close = () => closeActiveMermaidLightbox();

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    dragging = true;
    movedDuringDrag = false;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragOriginX = viewport.scrollLeft;
    dragOriginY = viewport.scrollTop;
    viewport.classList.add("is-panning");
    viewport.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging) return;
    event.preventDefault();
    const deltaX = event.clientX - dragStartX;
    const deltaY = event.clientY - dragStartY;
    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) movedDuringDrag = true;
    viewport.scrollLeft = dragOriginX - deltaX;
    viewport.scrollTop = dragOriginY - deltaY;
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    viewport.classList.remove("is-panning");
    if (movedDuringDrag) {
      suppressNextOutsideClick = true;
      if (suppressOutsideClickTimer !== undefined) window.clearTimeout(suppressOutsideClickTimer);
      suppressOutsideClickTimer = window.setTimeout(() => {
        suppressNextOutsideClick = false;
        suppressOutsideClickTimer = undefined;
      }, 0);
    }
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  };
  const onWheel = (event: WheelEvent) => {
    if (!isLightboxZoomWheel(event)) return;
    event.preventDefault();
    const deltaY = normalizedWheelDeltaY(event, viewport.clientHeight);
    if (deltaY === 0) return;
    zoomBy(Math.exp(clamp(-deltaY, -WHEEL_ZOOM_DELTA_LIMIT, WHEEL_ZOOM_DELTA_LIMIT) * WHEEL_ZOOM_SENSITIVITY), event);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
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
    if (suppressNextOutsideClick) {
      suppressNextOutsideClick = false;
      if (suppressOutsideClickTimer !== undefined) window.clearTimeout(suppressOutsideClickTimer);
      suppressOutsideClickTimer = undefined;
      return;
    }
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (content.contains(target) || toolbar.contains(target)) return;
    close();
  };

  const zoomOutHandler = () => zoomBy(1 / ZOOM_STEP);
  const zoomInHandler = () => zoomBy(ZOOM_STEP);
  zoomOutButton.addEventListener("click", zoomOutHandler);
  zoomResetButton.addEventListener("click", reset);
  zoomInButton.addEventListener("click", zoomInHandler);
  closeButton.addEventListener("click", close);
  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointermove", onPointerMove);
  viewport.addEventListener("pointerup", onPointerUp);
  viewport.addEventListener("pointercancel", onPointerUp);
  viewport.addEventListener("wheel", onWheel, { passive: false });
  overlay.addEventListener("click", onOverlayClick);
  window.addEventListener("keydown", onKeyDown, true);
  update();
  window.requestAnimationFrame(centerContent);
  closeButton.focus();

  activeLightboxCleanup = () => {
    zoomOutButton.removeEventListener("click", zoomOutHandler);
    zoomResetButton.removeEventListener("click", reset);
    zoomInButton.removeEventListener("click", zoomInHandler);
    closeButton.removeEventListener("click", close);
    viewport.removeEventListener("pointerdown", onPointerDown);
    viewport.removeEventListener("pointermove", onPointerMove);
    viewport.removeEventListener("pointerup", onPointerUp);
    viewport.removeEventListener("pointercancel", onPointerUp);
    viewport.removeEventListener("wheel", onWheel);
    overlay.removeEventListener("click", onOverlayClick);
    window.removeEventListener("keydown", onKeyDown, true);
    if (suppressOutsideClickTimer !== undefined) window.clearTimeout(suppressOutsideClickTimer);
    overlay.remove();
    document.body.classList.remove("mermaid-lightbox-open");
    activeLightboxCleanup = undefined;
  };
}

function closeActiveMermaidLightbox() {
  activeLightboxCleanup?.();
}

function cloneSvgForLightbox(svg: SVGSVGElement, size = svgLightboxSize(svg)): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement;
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

function isLightboxZoomWheel(event: WheelEvent): boolean {
  return event.ctrlKey;
}

function normalizedWheelDeltaY(event: WheelEvent, pageHeight: number): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * WHEEL_LINE_HEIGHT_PX;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * pageHeight;
  return event.deltaY;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
