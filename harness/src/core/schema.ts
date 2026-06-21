import { z } from "zod";

export { z };

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
