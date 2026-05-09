import type { ChatSummary } from "../api";
import { homeDir } from "../paths";

export function expectedChatWorktreePath(
  chat: Pick<ChatSummary, "chatId" | "path"> | null | undefined,
): string | null {
  const id = String(chat?.chatId || "").trim();
  if (!id) return null;
  const home = homeDir();
  const base = home ? home.replace(/\/+$/, "") + "/moo" : "moo";
  return base + "/" + id.replace(/^\/+/, "");
}

export function withExpectedChatWorktreePath(chat: ChatSummary): ChatSummary {
  return chat.worktreePath == null
    ? { ...chat, worktreePath: expectedChatWorktreePath(chat) }
    : chat;
}

export function withExpectedChatWorktreePaths(chats: ChatSummary[]): ChatSummary[] {
  return chats.map(withExpectedChatWorktreePath);
}
