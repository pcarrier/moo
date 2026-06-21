import { parseJson, terminalUiStateSchema } from "./schema";

export type TerminalUiState = {
  open: boolean;
  selectedSessionId: string | null;
};

type TerminalUiStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const TERMINAL_UI_STATE_KEY_PREFIX = "moo.terminal.chatState.v1.";
const terminalUiStateMemory = new Map<string, TerminalUiState>();

export function defaultTerminalUiState(): TerminalUiState {
  return { open: false, selectedSessionId: null };
}

function cloneTerminalUiState(state: TerminalUiState): TerminalUiState {
  return { open: state.open, selectedSessionId: state.selectedSessionId };
}

export function normalizeTerminalUiState(
  value: unknown,
): TerminalUiState | null {
  const result = terminalUiStateSchema.safeParse(value);
  if (!result.success) return null;
  const selected = result.data.selectedSessionId;
  return {
    open: result.data.open,
    selectedSessionId: typeof selected === "string" && selected ? selected : null,
  };
}

export function terminalUiStateStorageKey(chatId: string): string {
  return `${TERMINAL_UI_STATE_KEY_PREFIX}${encodeURIComponent(chatId)}`;
}

function browserTerminalUiStorage(): TerminalUiStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadTerminalUiState(
  chatId: string | null | undefined,
  storage: TerminalUiStorage | null = browserTerminalUiStorage(),
): TerminalUiState {
  if (!chatId) return defaultTerminalUiState();
  const cached = terminalUiStateMemory.get(chatId);
  if (cached) return cloneTerminalUiState(cached);
  if (!storage) return defaultTerminalUiState();
  const key = terminalUiStateStorageKey(chatId);
  try {
    const raw = storage.getItem(key);
    if (!raw) return defaultTerminalUiState();
    const parsed = normalizeTerminalUiState(parseJson(raw, "terminal UI state", terminalUiStateSchema));
    if (!parsed) throw new Error("invalid terminal UI state");
    terminalUiStateMemory.set(chatId, parsed);
    return cloneTerminalUiState(parsed);
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Storage cleanup is best-effort; keep the UI usable without persistence.
    }
    return defaultTerminalUiState();
  }
}

export function saveTerminalUiState(
  chatId: string | null | undefined,
  state: TerminalUiState,
  storage: TerminalUiStorage | null = browserTerminalUiStorage(),
): void {
  if (!chatId) return;
  const normalized = normalizeTerminalUiState(state) ?? defaultTerminalUiState();
  terminalUiStateMemory.set(chatId, normalized);
  if (!storage) return;
  try {
    storage.setItem(terminalUiStateStorageKey(chatId), JSON.stringify(normalized));
  } catch {
    // localStorage may be disabled or full; in-memory state still survives chat switches.
  }
}

export function clearTerminalUiStateCacheForTest(): void {
  terminalUiStateMemory.clear();
}
