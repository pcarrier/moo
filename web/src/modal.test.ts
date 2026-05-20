import { describe, expect, test } from "bun:test";
import { MODAL_DIALOG_SELECTOR, hasOpenModalDialog } from "./modal";

describe("modal helpers", () => {
  test("detects active aria-modal dialogs", () => {
    let selector = "";
    const root = {
      querySelector(nextSelector: string) {
        selector = nextSelector;
        return {} as Element;
      },
    };

    expect(hasOpenModalDialog(root)).toBe(true);
    expect(selector).toBe(MODAL_DIALOG_SELECTOR);
  });

  test("ignores roots without modal dialogs", () => {
    const root = {
      querySelector() {
        return null;
      },
    };

    expect(hasOpenModalDialog(root)).toBe(false);
  });
});
