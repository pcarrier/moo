import * as host from "./host_ops";
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
  const refs = chatRefs(chatId);
  if (!host.getRef(refs.createdAt)) {
    host.setRef(refs.createdAt, String(host.now()));
  }
  host.setRef(refs.lastAt, String(host.now()));
}

export async function ensureRun(chatId: string): Promise<string> {
  const refs = chatRefs(chatId);
  let runId = host.getRef(refs.run);
  if (!runId) {
    runId = host.newId("run");
    host.setRef(refs.run, runId);
  }
  return runId;
}

export async function appendStep(chatId: string, args: AppendStepArgs): Promise<AppendedStep> {
  const refs = chatRefs(chatId);
  touchChat(chatId);
  const runId = await ensureRun(chatId);
  const stepId = host.newId("step");
  const previous = host.getRef(refs.head);
  const now = args.at ?? host.now();
  const adds: Quad[] = [
    [refs.graph, runId, "rdf:type", "agent:Run"],
    [refs.graph, runId, "agent:chat", refs.graph],
    [refs.graph, stepId, "rdf:type", "agent:Step"],
    [refs.graph, stepId, "rdf:type", stepClass(args.kind)],
    [refs.graph, stepId, "agent:createdBy", "agent:moo"],
    [refs.graph, stepId, "agent:run", runId],
    [refs.graph, stepId, "agent:kind", args.kind],
    [refs.graph, stepId, "agent:status", args.status],
    [refs.graph, stepId, "agent:createdAt", String(now)],
  ];
  if (previous) adds.push([refs.graph, stepId, "agent:parent", previous]);
  if (args.payloadHash) adds.push([refs.graph, stepId, "agent:payload", args.payloadHash]);
  for (const [predicate, object] of args.extras || []) {
    adds.push([refs.graph, stepId, predicate, object]);
  }
  assertFactObjects(adds);
  host.swapFacts(refs.facts, EMPTY_JSON_ARRAY, JSON.stringify(adds));
  host.setRef(refs.head, stepId);
  return { runId, stepId, previous, now };
}
