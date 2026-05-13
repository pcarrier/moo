import type { ApiCommand } from "./contract";
import type { Sha256Hash, StoreObject } from "./types";

export type ObjectCommands = ApiCommand<"object-get", { hash: Sha256Hash }, { hash: Sha256Hash; object: StoreObject }>;
