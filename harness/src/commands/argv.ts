import { parseProjectArg, type ChatCommandName, type FileCommandName, type Input, type MemoryCommandName, type McpCommandName, type StepCommandName, type UiCommandName } from "./_shared";

type KnownArgvCommand = StepCommandName | ChatCommandName | FileCommandName | MemoryCommandName | McpCommandName | UiCommandName | "enqueue" | "submit" | "vocabulary" | "vocab-define" | "llm-auth-get" | "llm-auth-save" | "llm-auth-oauth-start" | "llm-auth-oauth-complete" | "llm-auth-oauth-device-start" | "llm-auth-oauth-device-poll" | "llm-auth-oauth-logout" | "mcp-oauth-complete" | "mcp-call";
type ArgvParser<C extends string = KnownArgvCommand> = (command: C, args: string[]) => Input;
type AnyArgvParser = (command: string, args: string[]) => Input;

function hasCommand<const T extends readonly string[]>(commands: T, command: string): command is T[number] {
  return (commands as readonly string[]).includes(command);
}

const DEFAULT_CHAT_ID = "demo";
const EMPTY_ARGV_COMMANDS = [
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
] as const;
const CHAT_ONLY_COMMANDS = [
  "resume",
  "describe",
  "tick",
  "chat-models",
  "ui-chat",
] as const;
const PATH_COMMANDS = [
  "fs-list",
  "fs-git-branches",
  "fs-git-pull-branches",
] as const;
const TRIPLE_MUTATION_COMMANDS = [
  "assert",
  "retract",
  "triple-rm",
  "triple-restore",
] as const;
const MCP_SERVER_COMMANDS = [
  "mcp-tools",
  "mcp-remove",
  "mcp-oauth-start",
  "mcp-oauth-logout",
  "mcp-oauth-status",
] as const;

export function commandPayload(input: Input): { command: string; payload: Input } {
  if (input.command) return { command: input.command, payload: input };
  if (!Array.isArray(input.argv) || input.argv.length === 0) return { command: "describe", payload: input };

  const [command, ...args] = input.argv;
  return { command, payload: payloadFromArgv(command, args) };
}

function payloadFromArgv(command: string, args: string[]): Input {
  if (hasCommand(EMPTY_ARGV_COMMANDS, command)) return basePayload(command);
  if (hasCommand(CHAT_ONLY_COMMANDS, command)) return chatPayload(command, args);
  if (hasCommand(PATH_COMMANDS, command)) return pathPayload(command, args);
  if (hasCommand(TRIPLE_MUTATION_COMMANDS, command)) return tripleMutationPayload(command, args);
  if (hasCommand(MCP_SERVER_COMMANDS, command)) return mcpServerPayload(command, args);

  if (hasCommand(ARGUMENT_PARSER_KEYS, command)) {
    const parser = ARGUMENT_PARSERS[command] as unknown as AnyArgvParser;
    return parser(command, args);
  }
  return { command, argv: args };
}

const ARGUMENT_PARSERS = {
  step: stepPayload,
  "message-delete": stepReferencePayload,
  "message-restore": stepReferencePayload,
  dump: optionalChatPayload,
  schema: optionalChatPayload,
  enqueue: enqueuePayload,
  submit: submitPayload,
  "chat-new": newChatPayload,
  "chat-rm": firstArgAsChatPayload,
  "chat-remove-recent-path": pathPayload,
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
} satisfies Partial<{ [K in KnownArgvCommand]: ArgvParser<K> }>;
const ARGUMENT_PARSER_KEYS = Object.keys(ARGUMENT_PARSERS) as Array<keyof typeof ARGUMENT_PARSERS>;

function basePayload(command: KnownArgvCommand): Input {
  return { command };
}

function chatPayload(command: "resume" | "tick" | "describe" | "chat-models" | "ui-chat", args: string[], fallback = DEFAULT_CHAT_ID): Input {
  return { command, chatId: args[0] ?? fallback };
}

function optionalChatPayload(command: ChatCommandName | FileCommandName, args: string[]): Input {
  const payload = basePayload(command);
  if (args[0]) payload.chatId = args[0];
  return payload;
}

function firstArgAsChatPayload(command: ChatCommandName, args: string[]): Input {
  return { command, chatId: args[0] };
}

function pathPayload(command: FileCommandName | ChatCommandName, args: string[]): Input {
  return { command, path: args.join(" ") || "." };
}

function stepPayload(command: "step", args: string[]): Input {
  return { command, chatId: args[0] ?? DEFAULT_CHAT_ID, message: args.slice(1).join(" ") };
}

function stepReferencePayload(command: StepCommandName, args: string[]): Input {
  return { command, chatId: args[0] ?? DEFAULT_CHAT_ID, step: args[1] };
}

function enqueuePayload(command: "enqueue", args: string[]): Input {
  const payload: Input = { command, chatId: args[0] ?? DEFAULT_CHAT_ID, kind: args[1] ?? "agent:Tick" };
  if (args[2]) payload.payload = parseJson(args[2], { raw: args[2] });
  return payload;
}

function submitPayload(command: "submit", args: string[]): Input {
  return { command, chatId: args[0] ?? DEFAULT_CHAT_ID, requestId: args[1], values: parseJsonStrict(args[2], {}, "submit values") };
}

function newChatPayload(command: "chat-new", args: string[]): Input {
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
    } else if (arg === "--use-existing-worktree") {
      payload.useExistingWorktree = true;
    } else if (arg === "--path") {
      payload.path = optionArgs.slice(index + 1).join(" ");
      break;
    } else if (arg.startsWith("--path=")) {
      payload.path = arg.slice("--path=".length);
    }
  }

  return payload;
}

function forkChatPayload(command: "chat-fork", args: string[]): Input {
  const payload: Input = { command, chatId: args[0], step: args[1] };
  if (args[2]) payload.forkChatId = args[2];
  return payload;
}

function graphPayload(command: MemoryCommandName, args: string[]): Input {
  return { command, graph: args[0] };
}

function renameChatPayload(command: "chat-rename", args: string[]): Input {
  return { command, chatId: args[0], title: args.slice(1).join(" ") };
}

function archiveChatPayload(command: "chat-archive", args: string[]): Input {
  return { command, chatId: args[0], archived: !isFalseArg(args[1]) };
}

function chatSettingsPayload(command: "chat-settings", args: string[]): Input {
  return { command, chatIds: args };
}

function modelSettingPayload(command: "chat-model-set", args: string[]): Input {
  return { command, chatId: args[0] ?? DEFAULT_CHAT_ID, model: args[1] ?? null };
}

function effortSettingPayload(command: "chat-effort-set", args: string[]): Input {
  return { command, chatId: args[0] ?? DEFAULT_CHAT_ID, effort: args[1] ?? null };
}

function jsonObjectPayload(command: "llm-auth-save", args: string[]): Input {
  return { command, ...parseJson(args.join(" "), {}) as object };
}

function triplesPayload(command: "triples", args: string[]): Input {
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

function tripleMutationPayload(command: MemoryCommandName, args: string[]): Input {
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

function mcpServerPayload(command: McpCommandName, args: string[]): Input {
  return { command, serverId: args[0], id: args[0] };
}

function mcpOAuthCompletePayload(command: "mcp-oauth-complete", args: string[]): Input {
  return { command, state: args[0], code: args[1] };
}

function mcpCallPayload(command: "mcp-call", args: string[]): Input {
  return { command, serverId: args[0], name: args[1], arguments: parseJsonStrict(args.slice(2).join(" "), {}, "mcp-call arguments") };
}

function uiIdPayload(command: UiCommandName, args: string[]): Input {
  return { command, uiId: args[0] };
}

function uiOpenPayload(command: "ui-open", args: string[]): Input {
  const payload: Input = { command, chatId: args[0] ?? DEFAULT_CHAT_ID, uiId: args[1] };
  if (args[2]) payload.instanceId = args[2];
  return payload;
}

function instancePayload(command: UiCommandName, args: string[]): Input {
  return { command, instanceId: args[0] };
}

function uiStatePayload(command: "ui-state-set", args: string[]): Input {
  return { command, instanceId: args[0], state: parseJsonStrict(args[1], {}, "ui-state-set state") };
}

function uiCallPayload(command: "ui-call", args: string[]): Input {
  return { command, uiId: args[0], name: args[1], input: parseJsonStrict(args.slice(2).join(" "), {}, "ui-call input") };
}

function vocabDefinePayload(command: "vocab-define", args: string[]): Input {
  return { command, name: args[0], description: args.slice(1).join(" ") };
}

function parseJson(text: string | undefined, fallback: unknown) {
  try { return JSON.parse(text || ""); } catch { return fallback; }
}

// Like parseJson, but only falls back when the argument was genuinely
// omitted/empty. A present-but-unparseable JSON argument is a caller mistake
// and must surface as an error rather than silently becoming the fallback
// (which would run the command with empty arguments and wrong side effects).
function parseJsonStrict(text: string | undefined, fallback: unknown, label: string) {
  if (text == null || text.trim() === "") return fallback;
  try {
    return parseJson(text, {});
  } catch {
    throw new Error(`invalid JSON for ${label}: ${text}`);
  }
}

function isFalseArg(value: string | undefined): boolean {
  return value === "false" || value === "0" || value === "no";
}
