const HJSON_COLLAPSIBLE_SELECTOR = ".hjson-collapsible";
const HJSON_TOGGLE_SELECTOR = ".hjson-toggle";

type HjsonCollapsibleKind = "object" | "array" | "string";

export function startHjsonCollapsible(root: HTMLElement | Document = document): () => void {
  const doc = root instanceof Document ? root : root.ownerDocument || document;
  const onClick = (ev: MouseEvent) => {
    const toggle = hjsonToggleFromEvent(ev, root);
    if (!toggle) return;
    ev.preventDefault();
    ev.stopPropagation();
    toggleHjsonCollapsible(toggle);
  };

  doc.addEventListener("click", onClick, true);
  return () => doc.removeEventListener("click", onClick, true);
}

function hjsonToggleFromEvent(ev: Event, root: HTMLElement | Document): HTMLButtonElement | null {
  const target = ev.target;
  if (!(target instanceof Element)) return null;
  const toggle = target.closest(HJSON_TOGGLE_SELECTOR);
  if (!(toggle instanceof HTMLButtonElement)) return null;
  if (root instanceof HTMLElement && !root.contains(toggle)) return null;
  return toggle;
}

function toggleHjsonCollapsible(toggle: HTMLButtonElement) {
  const node = toggle.closest(HJSON_COLLAPSIBLE_SELECTOR);
  if (!(node instanceof HTMLElement)) return;
  const expanded = toggle.getAttribute("aria-expanded") !== "false";
  const collapsed = expanded;
  node.classList.toggle("is-collapsed", collapsed);
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  const kind = hjsonCollapsibleKind(node);
  const action = collapsed ? "expand" : "collapse";
  toggle.setAttribute("aria-label", action + " " + kind);
  toggle.setAttribute("title", action + " " + kind);
}

function hjsonCollapsibleKind(node: HTMLElement): HjsonCollapsibleKind {
  const kind = node.dataset.hjsonKind;
  return kind === "array" || kind === "string" ? kind : "object";
}
