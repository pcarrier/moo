export type TokenProgressValue = {
  used: number;
  budget: number;
  threshold: number;
  availableTokens?: number;
  compactionsInARow?: number;
  fraction: number;
  source?: string;
  estimated?: boolean;
};

export function mergeTokenProgress(
  current: TokenProgressValue | null,
  next: TokenProgressValue,
  active: boolean,
  options: { reset?: boolean } = {},
): TokenProgressValue {
  // While a chat is actively streaming, token progress can arrive from multiple
  // sources: live chars/4 estimates, final provider usage, and describe refreshes
  // reading the last completed provider usage. Those sources do not agree
  // exactly and can be delivered out of order, so do not let ordinary updates
  // snap the header meter backward mid-step. Explicit reset events are reserved
  // for compaction, where a lower count is the real new context size. Some
  // refreshes only carry the persisted compaction pressure metadata rather than
  // the live reset flag, so accept lower compaction-to-compaction readings too.
  const inferredCompactionReset =
    current?.source === "compaction" && next.source === "compaction";
  if (
    !options.reset &&
    !inferredCompactionReset &&
    active &&
    current &&
    next.used < current.used
  )
    return current;
  return next;
}
