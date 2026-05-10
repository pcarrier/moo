import type { BuiltinSkill } from "./types";

// Harness-bundled skills are compiled into the TypeScript harness and synced
// into the same pointer/object-backed store as user-created skills. Add entries
// here when a skill should ship with the harness itself.
export const BUILTIN_SKILLS: BuiltinSkill[] = [];
