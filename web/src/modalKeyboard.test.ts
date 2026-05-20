import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const terminal = readFileSync(
  new URL("./TerminalView.tsx", import.meta.url),
  "utf8",
);
const state = readFileSync(new URL("./state.ts", import.meta.url), "utf8");

describe("modal keyboard handling", () => {
  test("terminal shortcuts do not steal Escape from open modals", () => {
    expect(terminal).toContain('import { hasOpenModalDialog } from "./modal";');
    expect(terminal).toContain(
      "if (event.defaultPrevented || hasOpenModalDialog()) return;",
    );
    expect(terminal.indexOf("hasOpenModalDialog()) return")).toBeLessThan(
      terminal.indexOf("const focusedTerminal = focusedInsideTerminal"),
    );
  });

  test("agent stop shortcut ignores Escape while a modal dialog is open", () => {
    expect(state).toContain('import { hasOpenModalDialog } from "./modal";');
    expect(state).toContain(
      "if (e.defaultPrevented || hasOpenModalDialog()) return;",
    );
    const escHandler = state.slice(state.indexOf("const escHandler"));
    expect(escHandler.indexOf("hasOpenModalDialog()) return")).toBeLessThan(
      escHandler.indexOf("const id = chatId();"),
    );
  });
});
