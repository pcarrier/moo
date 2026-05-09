const TECHNICAL_CHAT_ID_RE = /^chat-([0-9a-f]{12,})(?:[0-9a-f]{12})?$/i;

export function displayChatId(chatId: string | null | undefined): string {
  const id = String(chatId ?? "").trim();
  if (!id) return "";
  return id.replace(TECHNICAL_CHAT_ID_RE, "$1");
}

export function relativeTime(ms: number, _tick: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000)
    return `${Math.round(diff / (60 * 60_000))}h ago`;
  return `${Math.round(diff / (24 * 60 * 60_000))}d ago`;
}

export function absoluteTime(ms: number): string {
  return ms ? new Date(ms).toISOString() : "";
}
