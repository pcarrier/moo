import type { AppendStepArgs, Quad, StepClass } from "./types";
import { assertFactObjects, chatRefs } from "./lib";

const EMPTY_JSON_ARRAY = "[]";

export type AppendedStep = {
  runId: string;
  stepId: string;
  previous: string | null;
  now: number;
};

export function stepClass(kind: string): StepClass {
  if (kind === "agent:UserInput" || kind === "agent:Reply" || kind === "agent:Final") return "agent:Message";
  if (kind === "agent:ShellCommand" || kind === "agent:RunJS" || kind === "agent:Subagent" || kind === "agent:ToolCall") return "agent:ToolInvocation";
  if (kind === "agent:Error") return "agent:ErrorEvent";
  return "agent:LifecycleMarker";
}

function touchChat(chatId: string): void {
  const c = chatRefs(chatId);
  if (!__op_ref_get(c.createdAt)) {
    __op_ref_set(c.createdAt, String(__op_now()));
  }
  __op_ref_set(c.lastAt, String(__op_now()));
}

export async function ensureRun(chatId: string): Promise<string> {
  const c = chatRefs(chatId);
  let runId = __op_ref_get(c.run);
  if (!runId) {
    runId = __op_id("run");
    __op_ref_set(c.run, runId);
  }
  return runId;
}

export async function appendStep(chatId: string, args: AppendStepArgs): Promise<AppendedStep> {
  const c = chatRefs(chatId);
  touchChat(chatId);
  const runId = await ensureRun(chatId);
  const stepId = __op_id("step");
  const previous = __op_ref_get(c.head);
  const now = args.at ?? __op_now();
  const adds: Quad[] = [
    [c.graph, runId, "rdf:type", "agent:Run"],
    [c.graph, runId, "agent:chat", c.graph],
    [c.graph, stepId, "rdf:type", "agent:Step"],
    [c.graph, stepId, "rdf:type", stepClass(args.kind)],
    [c.graph, stepId, "agent:createdBy", "agent:moo"],
    [c.graph, stepId, "agent:run", runId],
    [c.graph, stepId, "agent:kind", args.kind],
    [c.graph, stepId, "agent:status", args.status],
    [c.graph, stepId, "agent:createdAt", String(now)],
  ];
  if (previous) adds.push([c.graph, stepId, "agent:parent", previous]);
  if (args.payloadHash) adds.push([c.graph, stepId, "agent:payload", args.payloadHash]);
  for (const [predicate, object] of args.extras || []) {
    adds.push([c.graph, stepId, predicate, object]);
  }
  assertFactObjects(adds);
  __op_facts_swap(c.facts, EMPTY_JSON_ARRAY, JSON.stringify(adds));
  __op_ref_set(c.head, stepId);
  return { runId, stepId, previous, now };
}
