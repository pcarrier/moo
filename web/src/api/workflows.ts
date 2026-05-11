import { callCommand } from "./contract";
import type { ApiCommand } from "./contract";

export type WorkflowRunStatus = "queued" | "running" | "waiting" | "blocked" | "failed" | "done" | "cancelled";
export type WorkflowStepStatus = "todo" | "running" | "waiting" | "done" | "failed" | "skipped";

export type WorkflowDefinitionSummary = {
  id: string;
  title?: string;
  version?: string;
  hash: string;
  currentPointer: string;
  steps: number;
  uses: { mcp: string[]; proc: string[]; agent: string[]; ui: string[] };
  inputSchema?: unknown;
  outputSchema?: unknown;
  updatedAt?: string | null;
};

export type WorkflowInspection = WorkflowDefinitionSummary & {
  definition: unknown;
  mermaid: string;
};

export type WorkflowStepRun = {
  id: string;
  path: string;
  kind: string;
  status: WorkflowStepStatus;
  argsHash?: string | null;
  outputHash?: string | null;
  errorHash?: string | null;
  args?: unknown;
  output?: unknown;
  error?: unknown;
  startedAt?: string | null;
  endedAt?: string | null;
};

export type WorkflowRunSummary = {
  runId: string;
  workflowId: string;
  definitionHash: string;
  status: WorkflowRunStatus;
  currentStep?: string | null;
  chatIds: string[];
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type WorkflowRunInspection = WorkflowRunSummary & {
  input: unknown;
  state: unknown;
  output?: unknown;
  events: unknown[];
  steps: WorkflowStepRun[];
  definition?: unknown | null;
  mermaid: string;
};

export type WorkflowCommands =
  | ApiCommand<"workflows-list", Record<string, never>, { workflows: WorkflowDefinitionSummary[] }>
  | ApiCommand<"workflow-save", { definition: unknown; source?: unknown; current?: boolean }, { workflow: WorkflowInspection }>
  | ApiCommand<"workflow-inspect", { id: string }, { workflow: WorkflowInspection | null }>
  | ApiCommand<"workflow-runs", { status?: WorkflowRunStatus; workflowId?: string; chatId?: string }, { runs: WorkflowRunSummary[] }>
  | ApiCommand<"workflow-inspect-run", { runId: string }, { run: WorkflowRunInspection | null }>
  | ApiCommand<"workflow-waiting", { chatId?: string }, { runs: WorkflowRunSummary[] }>
  | ApiCommand<"workflow-run", { id: string; input?: unknown; state?: unknown; chatId?: string | null; autoResume?: boolean }, { run: WorkflowRunInspection }>
  | ApiCommand<"workflow-resume", { runId: string }, { run: WorkflowRunInspection }>
  | ApiCommand<"workflow-submit", { runId: string; stepPath: string; value: unknown }, { run: WorkflowRunInspection }>
  | ApiCommand<"workflow-cancel", { runId: string; reason?: string }, { run: WorkflowRunInspection }>
  | ApiCommand<"workflow-retry", { runId: string; from?: string | null; resume?: boolean }, { run: WorkflowRunInspection }>
  | ApiCommand<"workflow-fork", { runId: string; from?: string | null; input?: unknown; state?: unknown; autoResume?: boolean }, { run: WorkflowRunInspection }>
  | ApiCommand<"workflow-link-chat", { runId: string; chatId: string }, { run: WorkflowRunInspection }>
  | ApiCommand<"workflow-unlink-chat", { runId: string; chatId: string }, { run: WorkflowRunInspection }>
  | ApiCommand<"workflow-mermaid", { runId: string }, { mermaid: string }>;

export const workflowsApi = {
  list: () => callCommand("workflows-list", {}),
  save: (definition: unknown, opts: { source?: unknown; current?: boolean } = {}) => callCommand("workflow-save", { definition, ...opts }),
  inspect: (id: string) => callCommand("workflow-inspect", { id }),
  runs: (args: { status?: WorkflowRunStatus; workflowId?: string; chatId?: string } = {}) => callCommand("workflow-runs", args),
  inspectRun: (runId: string) => callCommand("workflow-inspect-run", { runId }),
  waiting: (args: { chatId?: string } = {}) => callCommand("workflow-waiting", args),
  run: (id: string, args: { input?: unknown; state?: unknown; chatId?: string | null; autoResume?: boolean } = {}) => callCommand("workflow-run", { id, ...args }),
  resume: (runId: string) => callCommand("workflow-resume", { runId }),
  submit: (runId: string, stepPath: string, value: unknown) => callCommand("workflow-submit", { runId, stepPath, value }),
  cancel: (runId: string, reason?: string) => callCommand("workflow-cancel", { runId, ...(reason ? { reason } : {}) }),
  retry: (runId: string, args: { from?: string | null; resume?: boolean } = {}) => callCommand("workflow-retry", { runId, ...args }),
  fork: (runId: string, args: { from?: string | null; input?: unknown; state?: unknown; autoResume?: boolean } = {}) => callCommand("workflow-fork", { runId, ...args }),
  linkChat: (runId: string, chatId: string) => callCommand("workflow-link-chat", { runId, chatId }),
  unlinkChat: (runId: string, chatId: string) => callCommand("workflow-unlink-chat", { runId, chatId }),
  mermaid: (runId: string) => callCommand("workflow-mermaid", { runId }),
};
