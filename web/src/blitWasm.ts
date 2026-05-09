let initPromise: Promise<typeof import("@blit-sh/browser")> | null = null;

export default function initBlitWasm(): Promise<typeof import("@blit-sh/browser")> {
  if (!initPromise) {
    initPromise = import("@blit-sh/browser").then(async (mod) => {
      await mod.default();
      return mod;
    });
  }
  return initPromise;
}
