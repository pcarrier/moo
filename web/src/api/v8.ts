import { callCommand } from "./contract";
import type { ApiCommand } from "./contract";
import type { V8StatsValue } from "./types";

export type V8Commands =
  | ApiCommand<"v8-stats", Record<string, never>, V8StatsValue>;

export const v8Api = {
  stats: () => callCommand("v8-stats", {}),
};
