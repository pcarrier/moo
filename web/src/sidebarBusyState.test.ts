import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

const sidebar = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles/sidebar.css", import.meta.url), "utf8");

describe("sidebar chat busy state", () => {
  test("uses effective active status for the chat status dot", () => {
    expect(sidebar).toContain(
      "effectiveStatus(chat.status, bag.isChatActive(chat.chatId));",
    );
    expect(sidebar).toContain(
      'class={"chat-status " + chatStatusClass(status())}',
    );
    expect(sidebar).toContain(
      'title={"status: " + chatStatusLabel(status())}',
    );
  });

  test("does not render busy state at the row level", () => {
    const rowStart = sidebar.indexOf('<li\n        class="chat-row"');
    expect(rowStart).toBeGreaterThanOrEqual(0);
    const rowEnd = sidebar.indexOf('</li>', rowStart);
    const row = sidebar.slice(rowStart, rowEnd);

    expect(row).not.toContain("busy:");
    expect(sidebar).not.toContain("const busy =");
    expect(css).not.toContain(".chat-row.busy");
  });
});
