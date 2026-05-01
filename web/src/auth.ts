// Optional pre-shared key. If the URL is opened with `#psk=<value>` we
// pull the secret out of the fragment, persist it in localStorage, and
// strip the hash so the secret doesn't survive in the address bar / page
// title / referrer headers. The WS URL appends `?psk=` so the server can
// verify it on upgrade.

const STORAGE_KEY = "moo.psk";

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
    if (fromFragment === "") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, fromFragment);
    }
  } catch (_) {
    // localStorage may be disabled; non-fatal.
  }
}

export function getPsk(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch (_) {
    return null;
  }
}
