import type { StepItem } from "../api";

export type TimelineDraft = {
  kind?: "reply" | "compaction";
  draftId: string;
  content: string;
  reasoningContent?: string;
  reasoningStreaming?: boolean;
  at: number;
};

const optionalStepKeys: Array<keyof StepItem> = [
  "updatedAt",
  "error",
  "runts",
  "runjs",
  "lazyRuntsResult",
  "lazyRunjsResult",
  "resultHash",
  "subagent",
  "compaction",
  "attachments",
  "model",
  "effort",
  "thoughtDurationNs",
  "draftId",
  "reasoningContent",
  "reasoningStreaming",
  "deletedAt",
];

export function syncStepItem(target: StepItem, source: StepItem): StepItem {
  const record = target as Record<string, unknown>;
  for (const key of optionalStepKeys) delete record[key];
  Object.assign(target, source);
  return target;
}

export function draftStepItem(draft: TimelineDraft): StepItem {
  const compacting = draft.kind === "compaction";
  return {
    type: "step",
    step: `draft:${draft.draftId}` as StepItem["step"],
    kind: compacting ? "agent:Compaction" : "agent:Reply",
    status: "agent:Running",
    at: Number(draft.at) || Date.now(),
    text: compacting ? `compaction\n${draft.content}` : draft.content,
    draftId: draft.draftId,
    ...(compacting
      ? {}
      : {
          reasoningContent: draft.reasoningContent,
          reasoningStreaming: draft.reasoningStreaming,
        }),
  };
}

export function syncDraftStepItem(
  target: StepItem,
  draft: TimelineDraft,
): StepItem {
  return syncStepItem(target, draftStepItem(draft));
}
