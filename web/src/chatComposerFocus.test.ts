import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const stateSource = readFileSync(
  new URL("./state.ts", import.meta.url),
  "utf8",
);
const timelineSource = readFileSync(
  new URL("./Timeline.tsx", import.meta.url),
  "utf8",
);

function sourceBlock(source: string, startNeedle: string, endNeedle: string) {
  const start = source.indexOf(startNeedle);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endNeedle, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("chat composer focus", () => {
  test("does not focus the composer just because a chat was selected", () => {
    const selectBlock = sourceBlock(
      stateSource,
      "async function selectChat(",
      "function olderTimelineLoadCount",
    );

    expect(selectBlock).toContain("focusComposer?: boolean");
    expect(selectBlock).toContain(
      "if (opts?.focusComposer) requestChatComposerFocus();",
    );
    expect(selectBlock).not.toContain("setChatFocusRequest((n) => n + 1);");
  });

  test("focuses the composer only for explicit focus requests", () => {
    const inputBarBlock = sourceBlock(
      timelineSource,
      "function InputBar(props:",
      "function dismissedEntryLabel",
    );

    expect(inputBarBlock).toContain("const request = bag.chatFocusRequest();");
    expect(inputBarBlock).toContain("if (!request) return;");
    expect(inputBarBlock).toContain("bag.clearChatFocusRequest(request);");
    expect(inputBarBlock).toContain("queueMicrotask(focusMessageInput);");
  });

  test("new chat creation still asks the composer to focus", () => {
    const createBlock = sourceBlock(
      stateSource,
      "async function createChat(",
      "async function removeChat",
    );

    expect(createBlock).toContain("focusComposer: true");
  });
});
