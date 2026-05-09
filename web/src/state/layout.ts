const SIDEBAR_KEY = "moo.sidebar.w";
const COLLAPSED_KEY = "moo.sidebar.collapsed";
const ARCHIVED_COLLAPSED_KEY = "moo.sidebar.archivedCollapsed";
const SIDEBAR_DEFAULT_W = "16rem";
const SIDEBAR_MIN_EM = 8;
const RIGHT_SIDEBAR_LAYOUT_KEY = "moo.rightSidebar.layout.v1";
const RIGHT_SIDEBAR_DEFAULT_LAYOUT_ID = "__default";
const RIGHT_SIDEBAR_DEFAULT_W = "25%";
const RIGHT_SIDEBAR_MIN_EM = 8;

export type RightSidebarLayoutState = {
  width?: string;
  collapsed?: boolean;
};

function rootEmPx(): number {
  const fontSize = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize || "16",
  );
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 16;
}

function sidebarMinPx(): number {
  return SIDEBAR_MIN_EM * rootEmPx();
}

function minSidebarPercent(): number {
  const viewportW =
    document.documentElement?.clientWidth || window.innerWidth || 0;
  if (viewportW <= 0) return 0;
  return (sidebarMinPx() / viewportW) * 100;
}

function clampSidebarPercent(percent: number, enforceMin = false): number {
  const min = enforceMin ? minSidebarPercent() : 0;
  return Math.max(min, percent);
}

function sidebarPercentFromPx(
  px: number,
  enforceMin = false,
): number | undefined {
  if (!Number.isFinite(px)) return undefined;
  const viewportW =
    document.documentElement?.clientWidth || window.innerWidth || 0;
  if (viewportW <= 0) return undefined;
  return clampSidebarPercent((px / viewportW) * 100, enforceMin);
}

function parseSidebarWidth(
  width: unknown,
  numberUnit: "percent" | "px" = "px",
  enforceMin = false,
): string | undefined {
  if (typeof width === "number") {
    const percent =
      numberUnit === "percent"
        ? clampSidebarPercent(width, enforceMin)
        : sidebarPercentFromPx(width, enforceMin);
    return percent === undefined ? undefined : `${percent}%`;
  }
  const raw = String(width ?? "").trim();
  if (!raw) return undefined;
  if (raw.endsWith("%")) {
    const percent = Number.parseFloat(raw.slice(0, -1));
    if (!Number.isFinite(percent)) return undefined;
    if (percent <= 0 && !enforceMin) return undefined;
    return `${clampSidebarPercent(percent, enforceMin)}%`;
  }
  if (raw.endsWith("px")) {
    const px = Number.parseFloat(raw.slice(0, -2));
    if (!Number.isFinite(px)) return undefined;
    if (px <= 0 && !enforceMin) return undefined;
    const nextPx = enforceMin ? Math.max(sidebarMinPx(), px) : px;
    return `${nextPx}px`;
  }
  if (raw.endsWith("rem") || raw.endsWith("em")) {
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return undefined;
    if (n <= 0 && !enforceMin) return undefined;
    const unit = raw.endsWith("rem") ? "rem" : "em";
    return enforceMin ? `${Math.max(SIDEBAR_MIN_EM, n)}${unit}` : raw;
  }
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return undefined;
  if (n <= 0 && !enforceMin) return undefined;
  const percent =
    numberUnit === "percent"
      ? clampSidebarPercent(n, enforceMin)
      : sidebarPercentFromPx(n, enforceMin);
  return percent === undefined ? undefined : `${percent}%`;
}

function clampSidebarWidth(
  width: unknown,
  numberUnit: "percent" | "px" = "px",
  enforceMin = false,
): string {
  return parseSidebarWidth(width, numberUnit, enforceMin) ?? SIDEBAR_DEFAULT_W;
}
function rightSidebarMinPx(): number {
  return RIGHT_SIDEBAR_MIN_EM * rootEmPx();
}

function minRightSidebarPercent(): number {
  const viewportW =
    document.documentElement?.clientWidth || window.innerWidth || 0;
  if (viewportW <= 0) return 0;
  return (rightSidebarMinPx() / viewportW) * 100;
}

function clampRightSidebarPercent(percent: number, enforceMin = false): number {
  const min = enforceMin ? minRightSidebarPercent() : 0;
  return Math.max(min, percent);
}

function rightSidebarPercentFromPx(
  px: number,
  enforceMin = false,
): number | undefined {
  if (!Number.isFinite(px)) return undefined;
  const viewportW =
    document.documentElement?.clientWidth || window.innerWidth || 0;
  if (viewportW <= 0) return undefined;
  return clampRightSidebarPercent((px / viewportW) * 100, enforceMin);
}

function parseRightSidebarWidth(
  width: unknown,
  numberUnit: "percent" | "px" = "px",
  enforceMin = false,
): string | undefined {
  if (typeof width === "number") {
    const percent =
      numberUnit === "percent"
        ? clampRightSidebarPercent(width, enforceMin)
        : rightSidebarPercentFromPx(width, enforceMin);
    return percent === undefined ? undefined : `${percent}%`;
  }
  const raw = String(width ?? "").trim();
  if (!raw) return undefined;
  if (raw.endsWith("%")) {
    const percent = Number.parseFloat(raw.slice(0, -1));
    if (!Number.isFinite(percent)) return undefined;
    if (percent <= 0 && !enforceMin) return undefined;
    return `${clampRightSidebarPercent(percent, enforceMin)}%`;
  }
  if (raw.endsWith("px")) {
    const px = Number.parseFloat(raw.slice(0, -2));
    if (!Number.isFinite(px)) return undefined;
    if (px <= 0 && !enforceMin) return undefined;
    const nextPx = enforceMin ? Math.max(rightSidebarMinPx(), px) : px;
    return `${nextPx}px`;
  }
  if (raw.endsWith("rem") || raw.endsWith("em")) {
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return undefined;
    if (n <= 0 && !enforceMin) return undefined;
    const unit = raw.endsWith("rem") ? "rem" : "em";
    return enforceMin ? `${Math.max(RIGHT_SIDEBAR_MIN_EM, n)}${unit}` : raw;
  }
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return undefined;
  if (n <= 0 && !enforceMin) return undefined;
  const percent =
    numberUnit === "percent"
      ? clampRightSidebarPercent(n, enforceMin)
      : rightSidebarPercentFromPx(n, enforceMin);
  return percent === undefined ? undefined : `${percent}%`;
}

export function clampRightSidebarWidth(
  width: unknown,
  numberUnit: "percent" | "px" = "px",
  enforceMin = false,
): string {
  return (
    parseRightSidebarWidth(width, numberUnit, enforceMin) ??
    RIGHT_SIDEBAR_DEFAULT_W
  );
}

export function readRightSidebarLayout(): Record<string, RightSidebarLayoutState> {
  try {
    const raw = localStorage.getItem(RIGHT_SIDEBAR_LAYOUT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const out: Record<string, RightSidebarLayoutState> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const layout = value as Record<string, unknown>;
      const width = parseRightSidebarWidth(layout.width);
      out[id] = {
        ...(width === undefined ? {} : { width }),
        collapsed: layout.collapsed === true,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function persistRightSidebarLayout(
  layout: Record<string, RightSidebarLayoutState>,
) {
  try {
    const entries = Object.entries(layout).filter(([id]) => id);
    if (entries.length === 0) {
      localStorage.removeItem(RIGHT_SIDEBAR_LAYOUT_KEY);
      return;
    }
    localStorage.setItem(
      RIGHT_SIDEBAR_LAYOUT_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    /* ignore storage failures */
  }
}

export const sidebarLayout = {
  key: SIDEBAR_KEY,
  collapsedKey: COLLAPSED_KEY,
  archivedCollapsedKey: ARCHIVED_COLLAPSED_KEY,
  defaultWidth: SIDEBAR_DEFAULT_W,
  parseWidth: parseSidebarWidth,
  clampWidth: clampSidebarWidth,
};

export const rightSidebarLayout = {
  defaultLayoutId: RIGHT_SIDEBAR_DEFAULT_LAYOUT_ID,
  defaultWidth: RIGHT_SIDEBAR_DEFAULT_W,
};
