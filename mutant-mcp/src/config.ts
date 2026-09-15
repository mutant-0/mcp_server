import { z } from "zod";

const EnvSchema = z.object({
  MUTANT_SERVICE_LAMBDA_ARN: z.string().trim().default(""),
  MUTANT_OAUTH_ISSUER: z.string().trim().default(""),
  MUTANT_OAUTH_AUDIENCE: z.string().trim().default(""),
  MUTANT_OAUTH_CLIENT_ID: z.string().trim().default(""),
  // Empty means "derive from MUTANT_MCP_RESOURCE_URI" (see requiredScope).
  MUTANT_OAUTH_SCOPE: z.string().trim().default(""),
  MUTANT_MCP_RESOURCE_URI: z.string().trim().default(""),
  MUTANT_CORS_ORIGINS: z
    .string()
    .trim()
    .default("https://chatgpt.com,https://chat.openai.com"),
  MUTANT_UPGRADE_URL: z.string().trim().default("https://mutantgenomics.com/cart"),
  MUTANT_ONBOARDING_URL: z.string().trim().default("https://mutantgenomics.com/onboarding"),
  MUTANT_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  MUTANT_MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(512000),
  MUTANT_DEV_MODE: z.string().trim().default("false"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
    .default("info"),
});

export interface AppConfig {
  MUTANT_SERVICE_LAMBDA_ARN: string;
  MUTANT_OAUTH_ISSUER: string;
  MUTANT_OAUTH_AUDIENCE: string;
  MUTANT_OAUTH_CLIENT_ID: string;
  MUTANT_OAUTH_SCOPE: string;
  MUTANT_MCP_RESOURCE_URI: string;
  MUTANT_CORS_ORIGINS: string;
  MUTANT_UPGRADE_URL: string;
  MUTANT_ONBOARDING_URL: string;
  MUTANT_REQUEST_TIMEOUT_MS: number;
  MUTANT_MAX_RESPONSE_BYTES: number;
  MUTANT_DEV_MODE: boolean;
  LOG_LEVEL: string;
}

export function corsOrigins(config: AppConfig): string[] {
  return config.MUTANT_CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Resolve the canonical MCP resource URI for metadata. Falls back to a plausible
 * local value so development and tests do not require the variable.
 *
 * Note: this fallback is for advertising metadata only. Token validation must use
 * the raw `MUTANT_MCP_RESOURCE_URI` so an unset variable never rejects real
 * tokens against `http://localhost:3000/mcp`.
 */
export function resourceUri(config: AppConfig): string {
  if (config.MUTANT_MCP_RESOURCE_URI) return config.MUTANT_MCP_RESOURCE_URI;
  return "http://localhost:3000/mcp";
}

/**
 * Scope name Cognito composes with the resource-server identifier.
 *
 * Cognito emits resource-server scopes as `<identifier>/<scope name>`. The
 * identifier is the MCP resource URI, so `analysis.read` becomes
 * `https://<host>/mcp/analysis.read`.
 */
export const DEFAULT_OAUTH_SCOPE_NAME = "analysis.read";

/**
 * The OAuth scope this resource requires: advertised in protected-resource
 * metadata and per-tool security schemes, sent in `WWW-Authenticate` challenges,
 * and enforced on every access token.
 *
 * Derived from {@link resourceUri} so the advertised scope always matches the
 * resource-server identifier the authorization server issues for, e.g.
 * `https://dev-api.mutantbiotech.com/mcp/analysis.read`. Set `MUTANT_OAUTH_SCOPE`
 * to override when an issuer names the scope differently.
 */
export function requiredScope(config: AppConfig): string {
  if (config.MUTANT_OAUTH_SCOPE) return config.MUTANT_OAUTH_SCOPE;
  return `${resourceUri(config)}/${DEFAULT_OAUTH_SCOPE_NAME}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  return {
    ...parsed,
    MUTANT_DEV_MODE: parsed.MUTANT_DEV_MODE === "true",
  };
}
