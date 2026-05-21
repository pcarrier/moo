export type ServiceWorkerLocation = Pick<Location, "hostname" | "protocol">;

const LOCALHOST_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function canRegisterServiceWorker(
  location: ServiceWorkerLocation,
  secureContext = globalThis.isSecureContext === true,
): boolean {
  if (secureContext) return true;
  return (
    location.protocol === "http:" &&
    LOCALHOST_NAMES.has(location.hostname.toLowerCase())
  );
}

export function registerServiceWorker(): void {
  if (typeof window === "undefined" || typeof navigator === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  if (!canRegisterServiceWorker(window.location)) return;

  window.addEventListener(
    "load",
    () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // Installation should not fail the app if a browser rejects the worker.
      });
    },
    { once: true },
  );
}
