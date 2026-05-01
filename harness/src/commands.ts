import {
  llmStreamAccumulateCommand,
  llmStreamErrorCommand,
  llmStreamFinalizeCommand,
  llmStreamInitCommand,
} from "./llm_stream";
import { parseProjectArg, type Input } from "./commands/_shared";
import {
  mcpCallCommand,
  mcpListCommand,
  mcpOAuthCompleteCommand,
  mcpOAuthLogoutCommand,
  mcpOAuthStartCommand,
  mcpOAuthStatusCommand,
  mcpRemoveCommand,
  mcpSaveCommand,
  mcpToolsCommand,
} from "./commands/mcp";
import {
  uiBundleCommand,
  uiCallCommand,
  uiChatCommand,
  uiCloseCommand,
  uiListCommand,
  uiRemoveCommand,
  uiOpenCommand,
  uiRegisterCommand,
  uiStateGetCommand,
  uiStateSetCommand,
} from "./commands/ui";
import { helpCommand } from "./commands/help";
import {
  enqueueCommand,
  interruptCommand,
  restartOngoingCommand,
  runJsToolCommand,
  subagentFinalCommand,
  stepCommand,
  stepNextCommand,
  submitCommand,
  tickCommand,
} from "./commands/step";
import { dumpCommand } from "./commands/dump";
import { chatExportCommand } from "./commands/export";
import { describeCommand } from "./commands/describe";
import {
  chatArchiveCommand,
  chatNewCommand,
  chatRemoveCommand,
  chatRenameCommand,
  chatAutocompleteCommand,
  chatsListCommand,
  fsListCommand,
  fsReadCommand,
  graphRemoveCommand,
  recentChatPathsCommand,
} from "./commands/chats";
import {
  chatEffortSetCommand,
  chatModelSetCommand,
  chatModelsCommand,
  chatSettingsCommand,
} from "./commands/models";
import {
  assertCommand,
  compactionsCommand,
  memoryQueryCommand,
  objectGetCommand,
  retractCommand,
  triplesCommand,
  tripleRemoveCommand,
  tripleRestoreCommand,
} from "./commands/memory";
import { vocabDefineCommand, vocabularyCommand } from "./commands/vocab";
import { schemaCommand } from "./commands/schema";
import { messageDeleteCommand, messageRestoreCommand } from "./commands/messages";

type CommandHandler = (input: Input) => unknown | Promise<unknown>;

const COMMANDS: Record<string, CommandHandler> = {
  step: stepCommand,
  "step-next": stepNextCommand,
  "run-js-tool": runJsToolCommand,
  "subagent-final": subagentFinalCommand,
  "restart-ongoing": () => restartOngoingCommand(),
  interrupt: interruptCommand,
  describe: describeCommand,
  enqueue: enqueueCommand,
  tick: tickCommand,
  dump: dumpCommand,
  submit: submitCommand,
  "llm-stream-init": llmStreamInitCommand,
  "llm-stream-accumulate": llmStreamAccumulateCommand,
  "llm-stream-finalize": llmStreamFinalizeCommand,
  "llm-stream-error": llmStreamErrorCommand,
  chats: () => chatsListCommand(),
  "chat-autocomplete": chatAutocompleteCommand,
  "fs-list": fsListCommand,
  "fs-read": fsReadCommand,
  "chat-recent-paths": () => recentChatPathsCommand(),
  "chat-new": chatNewCommand,
  "chat-rm": chatRemoveCommand,
  "graph-rm": graphRemoveCommand,
  "chat-rename": chatRenameCommand,
  "chat-archive": chatArchiveCommand,
  "chat-export": chatExportCommand,
  "chat-models": chatModelsCommand,
  "chat-settings": chatSettingsCommand,
  "chat-model-set": chatModelSetCommand,
  "chat-effort-set": chatEffortSetCommand,
  "message-delete": messageDeleteCommand,
  "message-restore": messageRestoreCommand,
  schema: schemaCommand,
  compactions: compactionsCommand,
  "memory-query": memoryQueryCommand,
  "object-get": objectGetCommand,
  triples: triplesCommand,
  assert: assertCommand,
  retract: retractCommand,
  "triple-rm": tripleRemoveCommand,
  "triple-restore": tripleRestoreCommand,
  vocabulary: () => vocabularyCommand(),
  "vocab-define": vocabDefineCommand,
  "mcp-list": () => mcpListCommand(),
  "mcp-save": mcpSaveCommand,
  "mcp-remove": mcpRemoveCommand,
  "mcp-oauth-start": mcpOAuthStartCommand,
  "mcp-oauth-complete": mcpOAuthCompleteCommand,
  "mcp-oauth-logout": mcpOAuthLogoutCommand,
  "mcp-oauth-status": mcpOAuthStatusCommand,
  "mcp-tools": mcpToolsCommand,
  "mcp-call": mcpCallCommand,
  "ui-register": uiRegisterCommand,
  "ui-list": uiListCommand,
  "ui-remove": uiRemoveCommand,
  "ui-bundle": uiBundleCommand,
  "ui-chat": uiChatCommand,
  "ui-open": uiOpenCommand,
  "ui-close": uiCloseCommand,
  "ui-state-get": uiStateGetCommand,
  "ui-state-set": uiStateSetCommand,
  "ui-call": uiCallCommand,
  help: () => helpCommand(),
};

export async function dispatch(input: Input) {
  const { command, payload } = commandPayload(input);
  const handler = COMMANDS[command];
  if (!handler) return { ok: false, error: { message: "unknown command: " + command } };
  return await handler(payload);
}

function commandPayload(input: Input): { command: string; payload: Input } {
  let command = input.command;
  let payload = input;

  if (!command && Array.isArray(input.argv) && input.argv.length > 0) {
    const [cmd, ...rest] = input.argv;
    command = cmd;
    payload = mergeArgv(cmd, rest);
  }

  return { command: command || "describe", payload };
}

function mergeArgv(command: string, rest: string[]): Input {
  const out: Input = { command };
  switch (command) {
    case "step":
      out.chatId = rest[0] ?? "demo";
      out.message = rest.slice(1).join(" ");
      return out;
    case "chat-export":
    case "describe":
    case "tick":
      out.chatId = rest[0] ?? "demo";
      return out;
    case "message-delete":
    case "message-restore":
      out.chatId = rest[0] ?? "demo";
      out.step = rest[1];
      return out;
    case "dump":
      if (rest[0]) out.chatId = rest[0];
      return out;
    case "enqueue":
      out.chatId = rest[0] ?? "demo";
      out.kind = rest[1] ?? "agent:Tick";
      if (rest[2]) {
        try {
          out.payload = JSON.parse(rest[2]);
        } catch {
          out.payload = { raw: rest[2] };
        }
      }
      return out;
    case "submit":
      out.chatId = rest[0] ?? "demo";
      out.requestId = rest[1];
      try {
        out.values = JSON.parse(rest[2] || "{}");
      } catch {
        out.values = {};
      }
      return out;
    case "chats":
    case "chat-recent-paths":
      return out;
    case "fs-list":
      out.path = rest.join(" ") || ".";
      return out;
    case "chat-new": {
      if (rest[0] === "--path") {
        out.path = rest.slice(1).join(" ");
      } else {
        if (rest[0]) out.chatId = rest[0];
        if (rest[1] === "--path") out.path = rest.slice(2).join(" ");
      }
      return out;
    }
    case "chat-rm":
      out.chatId = rest[0];
      return out;
    case "graph-rm":
      out.graph = rest[0];
      return out;
    case "chat-rename":
      out.chatId = rest[0];
      out.title = rest.slice(1).join(" ");
      return out;
    case "chat-archive":
      out.chatId = rest[0];
      out.archived = rest[1] !== "false" && rest[1] !== "0" && rest[1] !== "no";
      return out;
    case "chat-models":
      out.chatId = rest[0] ?? "demo";
      return out;
    case "chat-settings":
      out.chatIds = rest;
      return out;
    case "chat-model-set":
      out.chatId = rest[0] ?? "demo";
      out.model = rest[1] ?? null;
      return out;
    case "chat-effort-set":
      out.chatId = rest[0] ?? "demo";
      out.effort = rest[1] ?? null;
      return out;
    case "schema":
      if (rest[0]) out.chatId = rest[0];
      return out;
    case "compactions":
      out.chatId = rest[0];
      return out;
    case "triples": {
      const parsed = parseProjectArg(rest);
      if (parsed.project !== undefined) out.project = parsed.project;
      out.subject = parsed.rest[0] || null;
      out.predicate = parsed.rest[1] || null;
      out.object = parsed.rest[2] || null;
      const removed = parsed.rest[3];
      if (removed === "include" || removed === "only" || removed === "exclude") out.removed = removed;
      return out;
    }
    case "assert":
    case "retract":
    case "triple-rm":
    case "triple-restore": {
      const parsed = parseProjectArg(rest);
      if (parsed.project !== undefined) out.project = parsed.project;
      if (command === "triple-rm" || command === "triple-restore") {
        out.graph = parsed.rest[0];
        out.subject = parsed.rest[1];
        out.predicate = parsed.rest[2];
        out.object = parsed.rest.slice(3).join(" ");
      } else {
        out.subject = parsed.rest[0];
        out.predicate = parsed.rest[1];
        out.object = parsed.rest.slice(2).join(" ");
      }
      return out;
    }
    case "vocabulary":
    case "ui-list":
      return out;
    case "ui-bundle":
    case "ui-remove":
      out.uiId = rest[0];
      return out;
    case "ui-chat":
      out.chatId = rest[0] ?? "demo";
      return out;
    case "ui-open":
      out.chatId = rest[0] ?? "demo";
      out.uiId = rest[1];
      if (rest[2]) out.instanceId = rest[2];
      return out;
    case "ui-state-get":
      out.instanceId = rest[0];
      return out;
    case "ui-state-set":
      out.instanceId = rest[0];
      try { out.state = JSON.parse(rest[1] || "{}"); } catch { out.state = {}; }
      return out;
    case "ui-call":
      out.uiId = rest[0];
      out.name = rest[1];
      try { out.input = JSON.parse(rest.slice(2).join(" ") || "{}"); } catch { out.input = {}; }
      return out;
    case "vocab-define":
      out.name = rest[0];
      out.description = rest.slice(1).join(" ");
      return out;
    default:
      out.argv = rest;
      return out;
  }
}
