import type { TimelineItem } from "../api";

export function isConversationStepKind(kind: string): boolean {
  return (
    kind === "agent:UserInput" ||
    kind === "agent:Reply" ||
    kind === "agent:Final" ||
    kind === "agent:Error"
  );
}

export function hasRestartableConversationState(items: TimelineItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.type !== "step") continue;
    if (!isConversationStepKind(item.kind)) continue;
    if (item.kind === "agent:UserInput") {
      return item.status === "agent:Done" && item.deletedAt == null;
    }
    return item.status === "agent:Failed" || item.status === "agent:Cancelled";
  }
  return false;
}
