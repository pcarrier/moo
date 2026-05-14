import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const timeline = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");

describe("timeline image lightbox", () => {
  test("dismisses when clicking outside the image", () => {
    expect(timeline).toContain('class="image-lightbox-backdrop"');
    expect(timeline).toContain('onClick={closeLightbox}');
    expect(timeline).toContain('class="image-lightbox-image"');
    expect(timeline).toContain('onClick={(e) => e.stopPropagation()}');
    expect(timeline).toContain('class="image-lightbox-caption"');
  });
});
