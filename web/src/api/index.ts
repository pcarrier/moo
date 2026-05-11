export * from "./transport";
export * from "./types";
export * from "./contract";
export type { LlmAuthMode, LlmAuthSettings, LlmCompactionSettings, LlmProviderId, LlmRetrySettings } from "./llmAuth";
export type { TraceCommands } from "./traces";
export type { SkillCommands } from "./skills";
import { chatApi } from "./chat";
import { fsApi } from "./fs";
import { objectApi } from "./objects";
import { memoryApi } from "./memory";
import { uiApi } from "./ui";
import { mcpApi } from "./mcp";
import { v8Api } from "./v8";
import { llmAuthApi } from "./llmAuth";
import { tracesApi } from "./traces";
import { skillsApi } from "./skills";

export const api = {
  chat: chatApi,
  fs: fsApi,
  objects: objectApi,
  memory: memoryApi,
  ui: uiApi,
  mcp: mcpApi,
  v8: v8Api,
  llmAuth: llmAuthApi,
  traces: tracesApi,
  skills: skillsApi,
};
