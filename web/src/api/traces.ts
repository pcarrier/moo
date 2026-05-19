import type { ApiCommand } from "./contract";
import type { OtelConfig, OtelConfigTestValue, OtelSettingsValue } from "./types";

export type OtelCommands =
  | ApiCommand<"otel-config-get", Record<string, never>, OtelSettingsValue>
  | ApiCommand<"otel-config-save", { config: OtelConfig }, OtelSettingsValue>
  | ApiCommand<"otel-config-test", { config: OtelConfig }, OtelConfigTestValue>;
