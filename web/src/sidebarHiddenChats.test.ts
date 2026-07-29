import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const sidebar = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");

describe("left sidebar hidden chats", () => {
  test("excludes hidden chats from active and archived sections", () => {
    expect(sidebar).toContain(
      "orderedChats().filter((chat) => !chat.hidden && !chat.archived)",
    );
    expect(sidebar).toContain(
      "orderedChats().filter((chat) => !chat.hidden && chat.archived)",
    );
  });
});
