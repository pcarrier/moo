import { callCommand } from "./contract";
import type { ApiCommand } from "./contract";
import type { V8SettingsValue, V8StatsValue } from "./types";

export type V8Commands =
  | ApiCommand<"v8-stats", Record<string, never>, V8StatsValue>
  | ApiCommand<"v8-settings-get", Record<string, never>, V8SettingsValue>
  | ApiCommand<"v8-settings-save", { settings: V8SettingsValue["settings"] }, V8SettingsValue>;

export const v8Api = {
  stats: () => callCommand("v8-stats", {}),
  settings: () => callCommand("v8-settings-get", {}),
  saveSettings: (settings: V8SettingsValue["settings"]) => callCommand("v8-settings-save", { settings }),
};
