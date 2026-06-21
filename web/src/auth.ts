// Optional pre-shared key. If the URL is opened with `#psk=<value>` we
// pull the secret out of the fragment, persist it in localStorage, and
// strip the hash so the secret doesn't survive in the address bar / page
// title / referrer headers. The WS URL appends `?psk=` so the server can
// verify it on upgrade.

import { storage } from "./storage";
import { pskStatusSchema } from "./schema";

const STORAGE_KEY = "moo.psk";
let memoryPsk: string | null = null;

export type PskStatus = {
  required: boolean;
  valid: boolean;
};

function readFragment(): string | null {
  const hash = location.hash;
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.slice(1));
  const value = params.get("psk");
  if (!value) return null;
  params.delete("psk");
  const remaining = params.toString();
  const newHash = remaining ? `#${remaining}` : "";
  history.replaceState(null, "", location.pathname + location.search + newHash);
  return value;
}

export function captureFragmentPsk(): void {
  try {
    const fromFragment = readFragment();
    if (fromFragment === null) return;
    setPsk(fromFragment);
  } catch (_) {
    // localStorage may be disabled; non-fatal.
  }
}

export function getPsk(): string | null {
  try {
    return storage.getItem(STORAGE_KEY) ?? memoryPsk;
  } catch (_) {
    return memoryPsk;
  }
}

export function setPsk(value: string | null): void {
  memoryPsk = value === "" ? null : value;
  try {
    if (value === null || value === "") {
      storage.removeItem(STORAGE_KEY);
    } else {
      storage.setItem(STORAGE_KEY, value);
    }
  } catch (_) {
    // localStorage may be disabled; keep the key in memory for this page.
  }
}

export async function checkPsk(
  value: string | null = getPsk(),
): Promise<PskStatus> {
  const params = new URLSearchParams();
  if (value) params.set("psk", value);
  const qs = params.toString();
  const response = await fetch(`/api/auth/psk${qs ? `?${qs}` : ""}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`PSK check failed: HTTP ${response.status}`);
  }
  const data = pskStatusSchema.parse(await response.json());
  return data;
}
