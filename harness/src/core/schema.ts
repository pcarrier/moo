import { z } from "zod";

export { z };

export const judgeResultSchema = z.object({
  ok: z.boolean(),
  score: z.number(),
  reason: z.string().optional(),
});

export const openAiOAuthTokenSchema = z.object({
  access_token: z.string(),
  id_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

export const openAiDeviceLoginSchema = z.object({
  device_auth_id: z.string(),
  user_code: z.string().optional(),
  usercode: z.string().optional(),
  interval: z.union([z.string(), z.number()]).optional(),
});

export const openAiDevicePollSchema = z.object({
  authorization_code: z.string(),
  code_verifier: z.string(),
});

export const mcpJsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number().optional(),
      message: z.string().optional(),
      data: z.unknown().optional(),
    })
    .optional(),
});

export type McpJsonRpcResponse = z.infer<typeof mcpJsonRpcResponseSchema>;

export const httpHeaderRecordSchema = z.record(z.unknown());

export const mcpOAuthTokenSchema = z.object({
  access_token: z.string(),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  expires_at: z.number().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});

export const mcpOAuthPendingSchema = z.object({
  serverId: z.string(),
  codeVerifier: z.string(),
  redirectUri: z.string(),
  tokenUrl: z.string(),
  clientId: z.string(),
  clientSecret: z.string().optional(),
  scope: z.string().optional(),
  expiresAt: z.number(),
  returnChatId: z.string().optional(),
});

export const mcpSessionSchema = z.object({
  id: z.string().optional(),
  initializedAt: z.number().optional(),
});

export const mcpOAuthConfigSchema = z.object({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  authorizationUrl: z.string().optional(),
  tokenUrl: z.string().optional(),
  scope: z.string().optional(),
  redirectUri: z.string().optional(),
  resourceMetadataUrl: z.string().optional(),
  authorizationServerMetadataUrl: z.string().optional(),
  registrationUrl: z.string().optional(),
});

export const mcpServerConfigSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  url: z.string(),
  transport: z.enum(["http", "sse"]).optional(),
  enabled: z.boolean().optional(),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().optional(),
  oauth: mcpOAuthConfigSchema.optional(),
});
