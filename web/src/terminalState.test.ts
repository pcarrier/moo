import { beforeEach, describe, expect, test } from "bun:test";

import {
  clearTerminalUiStateCacheForTest,
  loadTerminalUiState,
  normalizeTerminalUiState,
  saveTerminalUiState,
  terminalUiStateStorageKey,
} from "./terminalState";

function createStorage() {
  const values = new Map<string, string>();
  const storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> & {
    values: Map<string, string>;
  } = {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  return storage;
}

describe("terminal UI state", () => {
  beforeEach(() => clearTerminalUiStateCacheForTest());

  test("scopes persisted open and selected terminal state by chat", () => {
    const storage = createStorage();

    saveTerminalUiState(
      "chat:a",
      { open: true, selectedSessionId: "session-a" },
      storage,
    );
    saveTerminalUiState(
      "chat b",
      { open: false, selectedSessionId: "session-b" },
      storage,
    );
    clearTerminalUiStateCacheForTest();

    expect(loadTerminalUiState("chat:a", storage)).toEqual({
      open: true,
      selectedSessionId: "session-a",
    });
    expect(loadTerminalUiState("chat b", storage)).toEqual({
      open: false,
      selectedSessionId: "session-b",
    });
    expect([...storage.values.keys()]).toContain(
      "moo.terminal.chatState.v1.chat%3Aa",
    );
    expect([...storage.values.keys()]).toContain(
      "moo.terminal.chatState.v1.chat%20b",
    );
  });

  test("falls back to in-memory state when storage is unavailable", () => {
    saveTerminalUiState(
      "chat-a",
      { open: true, selectedSessionId: "session-a" },
      null,
    );

    expect(loadTerminalUiState("chat-a", null)).toEqual({
      open: true,
      selectedSessionId: "session-a",
    });

    clearTerminalUiStateCacheForTest();
    expect(loadTerminalUiState("chat-a", null)).toEqual({
      open: false,
      selectedSessionId: null,
    });
  });

  test("normalizes corrupt storage to a closed default and clears it", () => {
    const storage = createStorage();
    const key = terminalUiStateStorageKey("chat-a");
    storage.setItem(key, "not json");

    expect(loadTerminalUiState("chat-a", storage)).toEqual({
      open: false,
      selectedSessionId: null,
    });
    expect(storage.getItem(key)).toBeNull();
  });

  test("normalizes partial state values", () => {
    expect(
      normalizeTerminalUiState({ open: true, selectedSessionId: "session-a" }),
    ).toEqual({ open: true, selectedSessionId: "session-a" });
    expect(
      normalizeTerminalUiState({ open: "true", selectedSessionId: "" }),
    ).toEqual({ open: false, selectedSessionId: null });
    expect(normalizeTerminalUiState([])).toBeNull();
  });
});
