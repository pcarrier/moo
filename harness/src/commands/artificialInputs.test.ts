import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const chatsSource = readFileSync(new URL("./chats.ts", import.meta.url), "utf8");
const stepSource = readFileSync(new URL("./step.ts", import.meta.url), "utf8");
const driverSource = readFileSync(new URL("../driver/step.ts", import.meta.url), "utf8");
const rustDriverSource = readFileSync(new URL("../../../src/driver.rs", import.meta.url), "utf8");

describe("artificial subagent inputs", () => {
  test("marks subagent driver prompts as artificial user inputs", () => {
    expect(rustDriverSource).toContain('"artificial": true');
    expect(driverSource).toContain('...(state.artificial === true ? { artificial: true } : {})');
    expect(stepSource).toContain('const artificial = input.artificial === true;');
    expect(stepSource).toContain('...(artificial ? { artificial: true } : {})');
    expect(stepSource).toContain('...(artificial ? { extras: [["agent:artificial", "true"]] } : {})');
  });

  test("excludes artificial user inputs from chat autocomplete", () => {
    expect(chatsSource).toContain('if (payload?.value?.artificial === true) return null;');
  });
});
