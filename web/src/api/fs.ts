import { callCommand } from "./contract";
import type { ApiCommand } from "./contract";
import { optional } from "./utils";
import type { FsListValue, FsReadValue, FsSearchValue, GitBranchesValue } from "./types";

export type FsCommands =
  | ApiCommand<"fs-list", { path: string }, FsListValue>
  | ApiCommand<"fs-search", { path: string; query: string; limit?: number }, FsSearchValue>
  | ApiCommand<"fs-read", { path: string; basePath?: string | null; includeDiff?: boolean }, FsReadValue>
  | ApiCommand<"fs-git-branches", { path: string }, GitBranchesValue>
  | ApiCommand<"fs-git-pull-branches", { path: string }, GitBranchesValue>
  | ApiCommand<"fs-git-upgrade-jj", { path: string }, GitBranchesValue>;

export const fsApi = {
  list: (path: string) => callCommand("fs-list", { path }),
  search: (path: string, query: string, limit = 24) =>
    callCommand("fs-search", { path, query, limit }),
  read: (path: string, basePath?: string | null, includeDiff = false) =>
    callCommand("fs-read", { path, ...optional({ basePath }), ...(includeDiff ? { includeDiff } : {}) }),
  gitBranches: (path: string) => callCommand("fs-git-branches", { path }),
  pullBranches: (path: string) => callCommand("fs-git-pull-branches", { path }),
  upgradeGitToJj: (path: string) => callCommand("fs-git-upgrade-jj", { path }),
};
