import { moo } from "../moo";
import { chatRefs } from "../lib";
import { Term } from "../types";
import type { Input } from "./_shared";

type UserInputStepLookup =
  | { ok: true; value: ReturnType<typeof chatRefs> }
  | { ok: false; error: { message: string } };

async function removeDeletedAt(store: string, graph: string, stepId: string, txn: any) {
  const existing = await moo.facts.match({ store, ...{
    graph,
    subject: stepId,
    predicate: "agent:deletedAt",
  } });
  // facts.match returns objects in encoded Turtle form; remove them exactly.
  for (const [g, s, p, o] of existing) txn.remove({ graph: g, subject: s, predicate: p, object: new Term(o) });
}

async function requireUserInputStep(chatId: string, stepId: string): Promise<UserInputStepLookup> {
  const c = chatRefs(chatId);
  const rows = await moo.facts.matchAll({ patterns: [
      [stepId, "rdf:type", "agent:Step"],
      [stepId, "agent:kind", "agent:UserInput"],
    ], ...{ store: c.facts, graph: c.graph, limit: 1 } });
  if (!rows.length) {
    return { ok: false, error: { message: `message step not found or not a user message: ${stepId}` } };
  }
  return { ok: true, value: c };
}

export async function messageDeleteCommand(input: Input) {
  const chatId = String(input.chatId || "demo");
  const stepId = String(input.step || input.stepId || input.messageStepId || "").trim();
  if (!stepId) return { ok: false, error: { message: "step is required" } };
  const found = await requireUserInputStep(chatId, stepId);
  if (!found.ok) return found;
  const c = found.value;
  const deletedAt = String(await moo.time.nowMs({}));
  await moo.facts.update({ store: c.facts, fn: async (txn) => {
    await removeDeletedAt(c.facts, c.graph, stepId, txn);
    txn.add({ graph: c.graph, subject: stepId, predicate: "agent:deletedAt", object: deletedAt });
  } });
  await moo.chat.touch({ chatId: chatId });
  return { ok: true, value: { chatId, step: stepId, deletedAt } };
}

export async function messageRestoreCommand(input: Input) {
  const chatId = String(input.chatId || "demo");
  const stepId = String(input.step || input.stepId || input.messageStepId || "").trim();
  if (!stepId) return { ok: false, error: { message: "step is required" } };
  const found = await requireUserInputStep(chatId, stepId);
  if (!found.ok) return found;
  const c = found.value;
  await moo.facts.update({ store: c.facts, fn: async (txn) => {
    await removeDeletedAt(c.facts, c.graph, stepId, txn);
  } });
  await moo.chat.touch({ chatId: chatId });
  return { ok: true, value: { chatId, step: stepId, deletedAt: null } };
}
