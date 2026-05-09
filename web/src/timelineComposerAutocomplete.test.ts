import { describe, expect, test } from "bun:test";
import { shouldApplyComposerAutocompleteKey } from "./timeline/composerKeys";

describe("composer autocomplete key handling", () => {
  test("accepts suggestions with Tab only", () => {
    expect(shouldApplyComposerAutocompleteKey({ key: "Tab" })).toBe(true);
    expect(shouldApplyComposerAutocompleteKey({ key: "Enter" })).toBe(false);
  });
  test("updates active suggestion only while the mouse moves", async () => {
    const timeline = await Bun.file(new URL("./Timeline.tsx", import.meta.url)).text();

    expect(timeline).toContain(
      'onMouseMove={() => autocomplete.setAutocompleteActive(i())}',
    );
    expect(timeline).not.toContain(
      'onMouseEnter={() => autocomplete.setAutocompleteActive(i())}',
    );
  });
});
