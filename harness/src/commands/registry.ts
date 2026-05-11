import { Effect } from "../core/effect";
import {
  llmStreamAccumulateCommand,
  llmStreamErrorCommand,
  llmStreamFinalizeCommand,
  llmStreamInitCommand,
} from "../llm_stream";
import type { Input } from "./_shared";
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
} from "./mcp";
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
} from "./ui";
import {
  enqueueCommand,
  interruptCommand,
  restartOngoingCommand,
  runJsToolCommand,
  subagentFinalCommand,
  resumeCommand,
  compactCommand,
  stepCommand,
  stepNextCommand,
  submitCommand,
  tickCommand,
  pendingMessagesCommand,
  pendingMessagesSaveCommand,
} from "./step";
import { dumpCommand } from "./dump";
import { describeCommand } from "./describe";
import {
  chatArchiveCommand,
  chatNewCommand,
  chatRemoveCommand,
  chatRenameCommand,
  chatForkCommand,
  chatAutocompleteCommand,
  chatsListCommand,
  fsGitBranchesCommand,
  fsGitPullBranchesCommand,
  fsListCommand,
  fsReadCommand,
  fsSearchCommand,
  graphRemoveCommand,
  recentChatPathsCommand,
} from "./chats";
import {
  chatEffortSetCommand,
  chatModelSetCommand,
  chatModelsCommand,
  chatSettingsCommand,
} from "./models";
import {
  assertCommand,
  compactionsCommand,
  graphSummariesCommand,
  memoryQueryCommand,
  objectGetCommand,
  pointerRemoveCommand,
  pointersCommand,
  retractCommand,
  triplesCommand,
  tripleRemoveCommand,
  subjectRemoveCommand,
  tripleRestoreCommand,
} from "./memory";
import { vocabDefineCommand, vocabularyCommand } from "./vocab";
import { schemaCommand } from "./schema";
import {
  llmAuthGetCommand,
  llmAuthOAuthCompleteCommand,
  llmAuthOAuthDevicePollCommand,
  llmAuthOAuthDeviceStartCommand,
  llmAuthOAuthLogoutCommand,
  llmAuthOAuthStartCommand,
  llmAuthSaveCommand,
} from "./llm_auth";
import { messageDeleteCommand, messageRestoreCommand } from "./messages";
import { skillDownloadCommand, skillGetCommand, skillRefreshCommand, skillRemoveCommand, skillSaveCommand, skillsListCommand } from "./skills";
import {
  workflowCancelCommand,
  workflowForkCommand,
  workflowInspectCommand,
  workflowInspectRunCommand,
  workflowLinkChatCommand,
  workflowListCommand,
  workflowMermaidCommand,
  workflowResumeCommand,
  workflowRetryCommand,
  workflowRunCommand,
  workflowRunsCommand,
  workflowSaveCommand,
  workflowSubmitCommand,
  workflowUnlinkChatCommand,
  workflowWaitingCommand,
} from "./workflows";

export type CommandHandler = (input: Input) => unknown | Promise<unknown> | Effect<unknown, unknown>;
type CommandGroup = { name: string; handlers: Record<string, CommandHandler> };

const STEP_COMMANDS: Record<string, CommandHandler> = {
  step: stepCommand,
  compact: compactCommand,
  resume: resumeCommand,
  "step-next": stepNextCommand,
  "run-js-tool": runJsToolCommand,
  "subagent-final": subagentFinalCommand,
  "restart-ongoing": () => restartOngoingCommand(),
  interrupt: interruptCommand,
  enqueue: enqueueCommand,
  tick: tickCommand,
  submit: submitCommand,
  "pending-messages": pendingMessagesCommand,
  "pending-messages-save": pendingMessagesSaveCommand,
};

const CHAT_COMMANDS: Record<string, CommandHandler> = {
  chats: () => chatsListCommand(),
  "chat-autocomplete": chatAutocompleteCommand,
  "chat-recent-paths": recentChatPathsCommand,
  "chat-new": chatNewCommand,
  "chat-rm": chatRemoveCommand,
  "chat-fork": chatForkCommand,
  "chat-rename": chatRenameCommand,
  "chat-archive": chatArchiveCommand,
  "chat-models": chatModelsCommand,
  "chat-settings": chatSettingsCommand,
  "chat-model-set": chatModelSetCommand,
  "chat-effort-set": chatEffortSetCommand,
};

const FILE_COMMANDS: Record<string, CommandHandler> = {
  "fs-list": fsListCommand,
  "fs-read": fsReadCommand,
  "fs-search": fsSearchCommand,
  "fs-git-branches": fsGitBranchesCommand,
  "fs-git-pull-branches": fsGitPullBranchesCommand,
};

const MEMORY_COMMANDS: Record<string, CommandHandler> = {
  compactions: compactionsCommand,
  "memory-query": memoryQueryCommand,
  "object-get": objectGetCommand,
  "graph-summaries": graphSummariesCommand,
  "graph-rm": graphRemoveCommand,
  pointers: pointersCommand,
  "pointer-rm": pointerRemoveCommand,
  triples: triplesCommand,
  assert: assertCommand,
  retract: retractCommand,
  "triple-rm": tripleRemoveCommand,
  "subject-rm": subjectRemoveCommand,
  "triple-restore": tripleRestoreCommand,
  vocabulary: () => vocabularyCommand(),
  "vocab-define": vocabDefineCommand,
};

const LLM_COMMANDS: Record<string, CommandHandler> = {
  "llm-stream-init": llmStreamInitCommand,
  "llm-stream-accumulate": llmStreamAccumulateCommand,
  "llm-stream-finalize": llmStreamFinalizeCommand,
  "llm-stream-error": llmStreamErrorCommand,
  "llm-auth-get": () => llmAuthGetCommand(),
  "llm-auth-save": llmAuthSaveCommand,
  "llm-auth-oauth-start": llmAuthOAuthStartCommand,
  "llm-auth-oauth-complete": llmAuthOAuthCompleteCommand,
  "llm-auth-oauth-device-start": llmAuthOAuthDeviceStartCommand,
  "llm-auth-oauth-device-poll": llmAuthOAuthDevicePollCommand,
  "llm-auth-oauth-logout": llmAuthOAuthLogoutCommand,
};

const MCP_COMMANDS: Record<string, CommandHandler> = {
  "mcp-list": () => mcpListCommand(),
  "mcp-save": mcpSaveCommand,
  "mcp-remove": mcpRemoveCommand,
  "mcp-oauth-start": mcpOAuthStartCommand,
  "mcp-oauth-complete": mcpOAuthCompleteCommand,
  "mcp-oauth-logout": mcpOAuthLogoutCommand,
  "mcp-oauth-status": mcpOAuthStatusCommand,
  "mcp-tools": mcpToolsCommand,
  "mcp-call": mcpCallCommand,
};

const UI_COMMANDS: Record<string, CommandHandler> = {
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
};


const WORKFLOW_COMMANDS: Record<string, CommandHandler> = {
  "workflows-list": workflowListCommand,
  "workflow-save": workflowSaveCommand,
  "workflow-inspect": workflowInspectCommand,
  "workflow-runs": workflowRunsCommand,
  "workflow-inspect-run": workflowInspectRunCommand,
  "workflow-waiting": workflowWaitingCommand,
  "workflow-run": workflowRunCommand,
  "workflow-resume": workflowResumeCommand,
  "workflow-submit": workflowSubmitCommand,
  "workflow-cancel": workflowCancelCommand,
  "workflow-retry": workflowRetryCommand,
  "workflow-fork": workflowForkCommand,
  "workflow-link-chat": workflowLinkChatCommand,
  "workflow-unlink-chat": workflowUnlinkChatCommand,
  "workflow-mermaid": workflowMermaidCommand,
};

const MESSAGE_COMMANDS: Record<string, CommandHandler> = {
  "message-delete": messageDeleteCommand,
  "message-restore": messageRestoreCommand,
};

const SKILL_COMMANDS: Record<string, CommandHandler> = {
  "skills-list": skillsListCommand,
  "skill-get": skillGetCommand,
  "skill-download": skillDownloadCommand,
  "skill-save": skillSaveCommand,
  "skill-remove": skillRemoveCommand,
  "skill-refresh": skillRefreshCommand,
};

const COMMAND_GROUPS: CommandGroup[] = [
  {
    name: "core",
    handlers: {
      describe: describeCommand,
      dump: dumpCommand,
      schema: schemaCommand,
    },
  },
  { name: "step", handlers: STEP_COMMANDS },
  { name: "chat", handlers: CHAT_COMMANDS },
  { name: "file", handlers: FILE_COMMANDS },
  { name: "message", handlers: MESSAGE_COMMANDS },
  { name: "memory", handlers: MEMORY_COMMANDS },
  { name: "skills", handlers: SKILL_COMMANDS },
  { name: "llm", handlers: LLM_COMMANDS },
  { name: "mcp", handlers: MCP_COMMANDS },
  { name: "ui", handlers: UI_COMMANDS },
  { name: "workflow", handlers: WORKFLOW_COMMANDS },
];

export const COMMAND_HANDLERS = buildCommandRegistry(COMMAND_GROUPS);

function buildCommandRegistry(groups: CommandGroup[]): Record<string, CommandHandler> {
  const registry: Record<string, CommandHandler> = {};
  for (const group of groups) {
    for (const command of Object.keys(group.handlers)) {
      if (registry[command]) throw new Error(`duplicate command registration: ${command}`);
      registry[command] = group.handlers[command];
    }
  }
  return registry;
}