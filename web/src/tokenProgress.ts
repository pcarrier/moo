export type TokenProgressValue = {
  used: number;
  budget: number;
  threshold: number;
  fraction: number;
};

export function mergeTokenProgress(
  current: TokenProgressValue | null,
  next: TokenProgressValue,
  active: boolean,
): TokenProgressValue {
  // While a chat is actively streaming, describe responses can lag behind the
  // latest token-progress event because describe reads the last completed
  // provider usage. Do not let those refreshes snap the header meter backward;
  // newer token events (final usage or compaction reset after the chat stops)
  // will replace it.
  if (active && current && next.used < current.used) return current;
  return next;
}
