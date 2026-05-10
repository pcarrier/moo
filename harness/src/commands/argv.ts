import { parseProjectArg, type Input } from "./_shared";

type ArgvParser = (command: string, args: string[]) => Input;

const DEFAULT_CHAT_ID = "demo";
const EMPTY_ARGV_COMMANDS = new Set([
  "chats",
  "chat-recent-paths",
  "llm-auth-get",
  "llm-auth-oauth-start",
  "llm-auth-oauth-complete",
  "llm-auth-oauth-device-start",
  "llm-auth-oauth-device-poll",
  "llm-auth-oauth-logout",
  "vocabulary",
  "mcp-list",
  "ui-list",
]);
const CHAT_ONLY_COMMANDS = new Set([
  "resume",
  "describe",
  "tick",
  "chat-models",
  "ui-chat",
]);
const PATH_COMMANDS = new Set([
  "fs-list",
  "fs-git-branches",
  "fs-git-pull-branches",
]);
const TRIPLE_MUTATION_COMMANDS = new Set([
  "assert",
  "retract",
  "triple-rm",
  "triple-restore",
]);
const MCP_SERVER_COMMANDS = new Set([
  "mcp-tools",
  "mcp-remove",
  "mcp-oauth-start",
  "mcp-oauth-logout",
  "mcp-oauth-status",
]);

export function commandPayload(input: Input): { command: string; payload: Input } {
  if (input.command) return { command: input.command, payload: input };
  if (!Array.isArray(input.argv) || input.argv.length === 0) return { command: "describe", payload: input };

  const [command, ...args] = input.argv;
  return { command, payload: payloadFromArgv(command, args) };
}

function payloadFromArgv(command: string, args: string[]): Input {
  if (EMPTY_ARGV_COMMANDS.has(command)) return basePayload(command);
  if (CHAT_ONLY_COMMANDS.has(command)) return chatPayload(command, args);
  if (PATH_COMMANDS.has(command)) return pathPayload(command, args);
  if (TRIPLE_MUTATION_COMMANDS.has(command)) return tripleMutationPayload(command, args);
  if (MCP_SERVER_COMMANDS.has(command)) return mcpServerPayload(command, args);

  const parser = ARGUMENT_PARSERS[command];
  return parser ? parser(command, args) : { command, argv: args };
}

const ARGUMENT_PARSERS: Record<string, ArgvParser> = {
  step: stepPayload,
  "message-delete": stepReferencePayload,
  "message-restore": stepReferencePayload,
  dump: optionalChatPayload,
  schema: optionalChatPayload,
  enqueue: enqueuePayload,
  submit: submitPayload,
  "chat-new": newChatPayload,
  "chat-rm": firstArgAsChatPayload,
  "chat-fork": forkChatPayload,
  "graph-rm": graphPayload,
  "chat-rename": renameChatPayload,
  "chat-archive": archiveChatPayload,
  "chat-settings": chatSettingsPayload,
  "chat-model-set": modelSettingPayload,
  "chat-effort-set": effortSettingPayload,
  "llm-auth-save": jsonObjectPayload,
  compactions: firstArgAsChatPayload,
  triples: triplesPayload,
  "mcp-oauth-complete": mcpOAuthCompletePayload,
  "mcp-call": mcpCallPayload,
  "ui-bundle": uiIdPayload,
  "ui-remove": uiIdPayload,
  "ui-open": uiOpenPayload,
  "ui-state-get": instancePayload,
  "ui-state-set": uiStatePayload,
  "ui-call": uiCallPayload,
  "vocab-define": vocabDefinePayload,
};

function basePayload(command: string): Input {
  return { command };
}

function chatPayload(command: string, args: string[], fallback = DEFAULT_CHAT_ID): Input {
  return { command, chatId: args[0] ?? fallback };
}

function optionalChatPayload(command: string, args: string[]): Input {
  const payload = basePayload(command);
  if (args[0]) payload.chatId = args[0];
  return payload;
}

function firstArgAsChatPayload(command: string, args: string[]): Input {
  return { command, chatId: args[0] };
}

function pathPayload(command: string, args: string[]): Input {
  return { command, path: args.join(" ") || "." };
}

function stepPayload(command: string, args: string[]): Input {
  return { command, chatId: args[0] ?? DEFAULT_CHAT_ID, message: args.slice(1).join(" ") };
}

function stepReferencePayload(command: string, args: string[]): Input {
  return { command, chatId: args[0] ?? DEFAULT_CHAT_ID, step: args[1] };
}

function enqueuePayload(command: string, args: string[]): Input {
  const payload: Input = { command, chatId: args[0] ?? DEFAULT_CHAT_ID, kind: args[1] ?? "agent:Tick" };
  if (args[2]) payload.payload = parseJson(args[2], { raw: args[2] });
  return payload;
}

function submitPayload(command: string, args: string[]): Input {
  return { command, chatId: args[0] ?? DEFAULT_CHAT_ID, requestId: args[1], values: parseJson(args[2], {}) };
}

function newChatPayload(command: string, args: string[]): Input {
  const payload = basePayload(command);
  const optionArgs = [...args];
  if (optionArgs[0] && !optionArgs[0].startsWith("--")) payload.chatId = optionArgs.shift();

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (arg === "--branch") {
      payload.branch = optionArgs[index + 1] || "";
      index += 1;
    } else if (arg.startsWith("--branch=")) {
      payload.branch = arg.slice("--branch=".length);
    } else if (arg === "--path") {
      payload.path = optionArgs.slice(index + 1).join(" ");
      break;
    } else if (arg.startsWith("--path=")) {
      payload.path = arg.slice("--path=".length);
    }
  }

  return payload;
}

function forkChatPayload(command: string, args: string[]): Input {
  const payload: Input = { command, chatId: args[0], step: args[1] };
  if (args[2]) payload.forkChatId = args[2];
  return payload;
}

function graphPayload(command: string, args: string[]): Input {
  return { command, graph: args[0] };
}

function renameChatPayload(command: string, args: string[]): Input {
  return { command, chatId: args[0], title: args.slice(1).join(" ") };
}

function archiveChatPayload(command: string, args: string[]): Input {
  return { command, chatId: args[0], archived: !isFalseArg(args[1]) };
}

function chatSettingsPayload(command: string, args: string[]): Input {
  return { command, chatIds: args };
}

function modelSettingPayload(command: string, args: string[]): Input {
  return { command, chatId: args[0] ?? DEFAULT_CHAT_ID, model: args[1] ?? null };
}

function effortSettingPayload(command: string, args: string[]): Input {
  return { command, chatId: args[0] ?? DEFAULT_CHAT_ID, effort: args[1] ?? null };
}

function jsonObjectPayload(command: string, args: string[]): Input {
  return { command, ...parseJson(args.join(" "), {}) as object };
}

function triplesPayload(command: string, args: string[]): Input {
  const parsed = parseProjectArg(args);
  const payload: Input = {
    command,
    subject: parsed.rest[0] || null,
    predicate: parsed.rest[1] || null,
    object: parsed.rest[2] || null,
  };
  if (parsed.project !== undefined) payload.project = parsed.project;
  const removed = parsed.rest[3];
  if (removed === "include" || removed === "only" || removed === "exclude") payload.removed = removed;
  return payload;
}

function tripleMutationPayload(command: string, args: string[]): Input {
  const parsed = parseProjectArg(args);
  const payload = basePayload(command);
  if (parsed.project !== undefined) payload.project = parsed.project;

  if (command === "triple-rm" || command === "triple-restore") {
    payload.graph = parsed.rest[0];
    payload.subject = parsed.rest[1];
    payload.predicate = parsed.rest[2];
    payload.object = parsed.rest.slice(3).join(" ");
  } else {
    payload.subject = parsed.rest[0];
    payload.predicate = parsed.rest[1];
    payload.object = parsed.rest.slice(2).join(" ");
  }

  return payload;
}

function mcpServerPayload(command: string, args: string[]): Input {
  return { command, serverId: args[0], id: args[0] };
}

function mcpOAuthCompletePayload(command: string, args: string[]): Input {
  return { command, state: args[0], code: args[1] };
}

function mcpCallPayload(command: string, args: string[]): Input {
  return { command, serverId: args[0], name: args[1], arguments: parseJson(args.slice(2).join(" "), {}) };
}

function uiIdPayload(command: string, args: string[]): Input {
  return { command, uiId: args[0] };
}

function uiOpenPayload(command: string, args: string[]): Input {
  const payload: Input = { command, chatId: args[0] ?? DEFAULT_CHAT_ID, uiId: args[1] };
  if (args[2]) payload.instanceId = args[2];
  return payload;
}

function instancePayload(command: string, args: string[]): Input {
  return { command, instanceId: args[0] };
}

function uiStatePayload(command: string, args: string[]): Input {
  return { command, instanceId: args[0], state: parseJson(args[1], {}) };
}

function uiCallPayload(command: string, args: string[]): Input {
  return { command, uiId: args[0], name: args[1], input: parseJson(args.slice(2).join(" "), {}) };
}

function vocabDefinePayload(command: string, args: string[]): Input {
  return { command, name: args[0], description: args.slice(1).join(" ") };
}

function parseJson(text: string | undefined, fallback: unknown) {
  try { return JSON.parse(text || ""); } catch { return fallback; }
}

function isFalseArg(value: string | undefined): boolean {
  return value === "false" || value === "0" || value === "no";
}
