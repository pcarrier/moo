import { Effect, errorInfo } from "./core/effect";
import { commandPayload } from "./commands/argv";
import type { Input } from "./commands/_shared";
import { COMMAND_HANDLERS, type CommandHandler } from "./commands/registry";
import { finishTraceRoot, moo, startTraceRoot, traceJsonValue, withMooServerBaseUrlContext } from "./moo";
export async function dispatch(input: Input) {
  return runDispatch(input);
}

async function runDispatch(input: Input) {
  const { command, payload } = commandPayload(input);
  const existingTrace = await moo.traces.current().catch(() => null);
  const shouldRoot = !existingTrace && shouldTraceCommand(command);
  const trace = shouldRoot ? await startTraceRoot(commandStepId(command, payload), {
    label: `command ${command}`,
    description: "top-level harness command trace",
    command,
    chatId: payload.chatId ?? null,
    input: traceJsonValue(payload),
    traceParentId: traceParentId(payload),
    traceRoute: typeof payload.traceRoute === "string" ? payload.traceRoute : null,
  }) : null;
  try {
    const result = await withMooServerBaseUrlContext(payload.serverBaseUrl, () =>
      Effect.defer(() => {
        const handler = COMMAND_HANDLERS[command];
        if (!handler) return Effect.succeed({ ok: false, error: { message: "unknown command: " + command } });
        return runHandler(handler, payload);
      })
      .match({
        onSuccess: (value) => value,
        onFailure: (error) => ({ ok: false, error: errorInfo(error) }),
      })
      .runScopedPromise(),
    );
    if (trace) {
      await moo.traces.mark("command.result", {
        command,
        ok: commandResultOk(result),
        output: traceJsonValue(result),
      });
      await finishTraceRoot({ id: trace.id, status: commandResultOk(result) ? "ok" : "error" });
    }
    return result;
  } catch (error: any) {
    if (trace) {
      await moo.traces.mark("command.error", { command, error: error?.message ?? String(error), stack: error?.stack ?? null });
      await finishTraceRoot({ id: trace.id, status: "error", error: error?.message ?? String(error) });
    }
    throw error;
  }
}

function shouldTraceCommand(_command: string): boolean {
  return true;
}

function traceParentId(payload: Input): string | null {
  const id = typeof payload.traceParentId === "string" && payload.traceParentId ? payload.traceParentId
    : typeof payload.traceFrontendId === "string" && payload.traceFrontendId ? payload.traceFrontendId
    : null;
  return id;
}

function commandStepId(command: string, payload: Input): string | null {
  const chatId = typeof payload.chatId === "string" && payload.chatId ? payload.chatId : null;
  if (chatId) return `command:${command}:${chatId}`;
  return `command:${command}`;
}

function commandResultOk(result: unknown): boolean {
  if (result && typeof result === "object" && "ok" in (result as any)) return (result as any).ok !== false;
  return true;
}

function runHandler(handler: CommandHandler, payload: Input): Effect<unknown, unknown> {
  return Effect.defer(() => toCommandEffect(handler(payload)));
}

function toCommandEffect(value: unknown | Promise<unknown> | Effect<unknown, unknown>): Effect<unknown, unknown> {
  if (value instanceof Effect) return value;
  if (value && typeof (value as any).then === "function") return Effect.tryPromise(() => value as Promise<unknown>, "command failed");
  return Effect.succeed(value);
}
