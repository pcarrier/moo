// Thin wrapper around localStorage that swallows the SecurityError / QuotaExceededError
// thrown in private browsing or when storage is disabled, so UI initialization does
// not crash.
export const storage = {
  getItem(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Ignore storage errors (private mode, quota, disabled cookies).
    }
  },
  removeItem(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore.
    }
  },
};
