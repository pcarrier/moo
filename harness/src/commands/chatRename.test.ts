import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const chatsSource = readFileSync(new URL("./chats.ts", import.meta.url), "utf8");
const mooSource = readFileSync(new URL("../moo.ts", import.meta.url), "utf8");

describe("manual chat rename", () => {
  test("marks user renames as manual title updates", () => {
    expect(chatsSource).toContain("moo.chat.setTitle({ chatId: input.chatId, title, manual: true })");
  });

  test("agent title updates do not overwrite the active manual title", () => {
    expect(mooSource).toContain("const manualRef = `chat/${chatId}/title-manual`");
    expect(mooSource).toContain("if (!manual && manualTitle && (previousTitle || null) === manualTitle && nextTitle !== manualTitle)");
  });
});
