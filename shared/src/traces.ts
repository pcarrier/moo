export type TraceStatus = "running" | "ok" | "error" | "cancelled" | "timeout" | string;

export type TraceRef = {
  traceId?: string;
  stepId?: string;
  parentId?: string | null;
};
