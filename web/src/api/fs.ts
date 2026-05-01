import { callCommand } from "./contract";
import type { ApiCommand } from "./contract";
import { optional } from "./utils";
import type { FsListValue, FsReadValue, FsSearchValue } from "./types";

export type FsCommands =
  | ApiCommand<"fs-list", { path: string }, FsListValue>
  | ApiCommand<"fs-search", { path: string; query: string; limit?: number }, FsSearchValue>
  | ApiCommand<"fs-read", { path: string; basePath?: string | null }, FsReadValue>;

export const fsApi = {
  list: (path: string) => callCommand("fs-list", { path }),
  search: (path: string, query: string, limit = 24) =>
    callCommand("fs-search", { path, query, limit }),
  read: (path: string, basePath?: string | null) =>
    callCommand("fs-read", { path, ...optional({ basePath }) }),
};
