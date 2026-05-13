import type { ApiCommand } from "./contract";
import type { FsListValue, FsReadValue, FsSearchValue, GitBranchesValue } from "./types";

export type FsCommands =
  | ApiCommand<"fs-list", { path: string }, FsListValue>
  | ApiCommand<"fs-search", { path: string; query: string; limit?: number }, FsSearchValue>
  | ApiCommand<"fs-read", { path: string; basePath?: string | null; includeDiff?: boolean }, FsReadValue>
  | ApiCommand<"fs-git-branches", { path: string }, GitBranchesValue>
  | ApiCommand<"fs-git-pull-branches", { path: string }, GitBranchesValue>;
