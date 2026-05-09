const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function decodeSimpleTurtleString(value: string): string {
  const trimmed = value.trim();
  const m =
    /^"((?:[^"\\\r\n]|\\["\\nrtbf])*)"(?:@[A-Za-z]+(?:-[A-Za-z0-9]+)*|\^\^\S+)?$/.exec(
      trimmed,
    );
  if (!m) return trimmed;
  return m[1].replace(/\\(["\\nrtbf])/g, (_all, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      default:
        return ch;
    }
  });
}

export function normalizeEffort(value: unknown): string | null {
  const effort = decodeSimpleTurtleString(String(value ?? ""))
    .trim()
    .toLowerCase();
  return EFFORT_LEVELS.includes(effort) ? effort : null;
}

