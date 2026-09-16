import { z } from "zod";

/**
 * Default cap on a serialized tool request. Kept below the 6 MiB synchronous
 * `lambda:InvokeFunction` payload ceiling, which is the binding limit for the
 * MCP -> report-generator hop (the HTTP API's 10 MB limit is not reached).
 */
const DEFAULT_MAX_REQUEST_BYTES = 5 * 1024 * 1024;

/** Exported so the dev-mode mock client applies the same default cap. */
export const DEFAULT_MUTANT_MAX_REQUEST_BYTES = DEFAULT_MAX_REQUEST_BYTES;

const EnvSchema = z.object({
  MUTANT_SERVICE_LAMBDA_ARN: z.string().trim().default(""),
  MUTANT_OAUTH_ISSUER: z.string().trim().default(""),
  MUTANT_OAUTH_AUDIENCE: z.string().trim().default(""),
  MUTANT_OAUTH_CLIENT_ID: z.string().trim().default(""),
  // Empty means "derive from MUTANT_MCP_RESOURCE_URI" (see analysisReadScope).
  MUTANT_OAUTH_SCOPE: z.string().trim().default(""),
  // Empty means "derive from MUTANT_MCP_RESOURCE_URI" (see dnaImportScope).
  MUTANT_OAUTH_SCOPE_DNA_IMPORT: z.string().trim().default(""),
  MUTANT_MCP_RESOURCE_URI: z.string().trim().default(""),
  MUTANT_CORS_ORIGINS: z
    .string()
    .trim()
    .default("https://chatgpt.com,https://chat.openai.com"),
  MUTANT_UPGRADE_URL: z.string().trim().default("https://mutantgenomics.com/cart"),
  MUTANT_ONBOARDING_URL: z.string().trim().default("https://mutantgenomics.com/onboarding"),
  MUTANT_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  MUTANT_MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(512000),
  // The SNP catalog is application data for the DNA import component, not model
  // context, so it is allowed a much larger response than the default cap.
  MUTANT_SNP_CATALOG_MAX_BYTES: z.coerce.number().int().positive().default(2000000),
  MUTANT_MAX_REQUEST_BYTES: z.coerce.number().int().positive().default(DEFAULT_MAX_REQUEST_BYTES),
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
  MUTANT_OAUTH_SCOPE_DNA_IMPORT: string;
  MUTANT_MCP_RESOURCE_URI: string;
  MUTANT_CORS_ORIGINS: string;
  MUTANT_UPGRADE_URL: string;
  MUTANT_ONBOARDING_URL: string;
  MUTANT_REQUEST_TIMEOUT_MS: number;
  MUTANT_MAX_RESPONSE_BYTES: number;
  MUTANT_SNP_CATALOG_MAX_BYTES: number;
  MUTANT_MAX_REQUEST_BYTES: number;
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
 * Scope names Cognito composes with the resource-server identifier.
 *
 * Cognito emits resource-server scopes as `<identifier>/<scope name>`. The
 * identifier is the MCP resource URI, so `analysis.read` becomes
 * `https://<host>/mcp/analysis.read`.
 */
export const ANALYSIS_READ_SCOPE_NAME = "analysis.read";

/**
 * Dedicated scope for DNA submission. Separate from `analysis.read` because
 * importing DNA creates or modifies user data, so a read-only grant must never
 * be able to trigger it.
 */
export const DNA_IMPORT_SCOPE_NAME = "dna.import";

export type MutantScopeName = typeof ANALYSIS_READ_SCOPE_NAME | typeof DNA_IMPORT_SCOPE_NAME;

/** Retained alias; `analysis.read` is the default/"primary" scope. */
export const DEFAULT_OAUTH_SCOPE_NAME = ANALYSIS_READ_SCOPE_NAME;

/**
 * The read scope required by the six model-facing analysis tools. Advertised in
 * protected-resource metadata, per-tool security schemes, and `WWW-Authenticate`
 * challenges.
 *
 * Derived from {@link resourceUri} so the advertised scope always matches the
 * resource-server identifier the authorization server issues for, e.g.
 * `https://dev-api.mutantbiotech.com/mcp/analysis.read`. Set `MUTANT_OAUTH_SCOPE`
 * to override when an issuer names the scope differently.
 */
export function analysisReadScope(config: AppConfig): string {
  if (config.MUTANT_OAUTH_SCOPE) return config.MUTANT_OAUTH_SCOPE;
  return `${resourceUri(config)}/${ANALYSIS_READ_SCOPE_NAME}`;
}

/**
 * The scope required by `show_dna_import`, `get_snp_catalog`, and
 * `create_report`. Set `MUTANT_OAUTH_SCOPE_DNA_IMPORT` to override when the
 * issuer names it differently.
 */
export function dnaImportScope(config: AppConfig): string {
  if (config.MUTANT_OAUTH_SCOPE_DNA_IMPORT) return config.MUTANT_OAUTH_SCOPE_DNA_IMPORT;
  return `${resourceUri(config)}/${DNA_IMPORT_SCOPE_NAME}`;
}

/**
 * Both scopes this resource supports. Every discovery surface advertises the
 * same list so a client can request exactly what it needs in one consent.
 */
export function supportedScopes(config: AppConfig): string[] {
  return [analysisReadScope(config), dnaImportScope(config)].filter(Boolean);
}

/** Resolve a tool's declared scope name to its wire (URI-form) scope value. */
export function scopeFor(config: AppConfig, name: MutantScopeName): string {
  return name === DNA_IMPORT_SCOPE_NAME ? dnaImportScope(config) : analysisReadScope(config);
}

/** The primary scope; retained for challenge helpers that advertise a default. */
export function requiredScope(config: AppConfig): string {
  return analysisReadScope(config);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  return {
    ...parsed,
    MUTANT_DEV_MODE: parsed.MUTANT_DEV_MODE === "true",
  };
}
