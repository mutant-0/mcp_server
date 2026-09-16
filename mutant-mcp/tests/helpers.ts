import type { MutantUserContext } from "../src/auth/user-context.js";
import type { MutantBackendClient } from "../src/clients/mutant-lambda-client.js";
import type { AppConfig } from "../src/config.js";
import { CONTRACT_VERSION, type ToolName, type ToolResponse } from "../src/contract.js";
import { createLogger, type AppLogger, type LogSink } from "../src/logger.js";

/** URI-form scopes for the test resource (derived from MUTANT_MCP_RESOURCE_URI). */
export const ANALYSIS_SCOPE = "https://mcp.mutantgenomics.com/mcp/analysis.read";
export const DNA_SCOPE = "https://mcp.mutantgenomics.com/mcp/dna.import";

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    MUTANT_SERVICE_LAMBDA_ARN: "",
    MUTANT_OAUTH_ISSUER: "https://auth.mutantgenomics.com",
    MUTANT_OAUTH_AUDIENCE: "",
    MUTANT_OAUTH_CLIENT_ID: "",
    // Empty exercises the derived `<resource>/analysis.read` scope, matching
    // production (where the Cognito resource-server identifier is the resource URI).
    MUTANT_OAUTH_SCOPE: "",
    // Empty exercises the derived `<resource>/dna.import` scope.
    MUTANT_OAUTH_SCOPE_DNA_IMPORT: "",
    MUTANT_MCP_RESOURCE_URI: "https://mcp.mutantgenomics.com/mcp",
    MUTANT_CORS_ORIGINS: "https://chatgpt.com",
    MUTANT_UPGRADE_URL: "https://mutantgenomics.com/cart",
    MUTANT_ONBOARDING_URL: "https://mutantgenomics.com/onboarding",
    MUTANT_REQUEST_TIMEOUT_MS: 5000,
    MUTANT_MAX_RESPONSE_BYTES: 512000,
    MUTANT_SNP_CATALOG_MAX_BYTES: 2000000,
    MUTANT_MAX_REQUEST_BYTES: 5 * 1024 * 1024,
    MUTANT_DEV_MODE: true,
    LOG_LEVEL: "silent",
    ...overrides,
  };
}

export function makeUser(overrides: Partial<MutantUserContext> = {}): MutantUserContext {
  return {
    userId: "user-1",
    // A fully-authorized connection, matching the `dev-free`/`dev-paid` dev tokens.
    scopes: [ANALYSIS_SCOPE, DNA_SCOPE],
    ...overrides,
  };
}

/** Capture structured log records for assertions about what was (not) logged. */
export function makeCapturingLogger(): {
  logger: AppLogger;
  records: () => Array<Record<string, unknown>>;
  text: () => string;
} {
  const lines: string[] = [];
  const sink: LogSink = {
    write(chunk: string) {
      lines.push(chunk);
    },
  };
  const logger = createLogger("info", sink);
  return {
    logger,
    records: () =>
      lines
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    text: () => lines.join(""),
  };
}

export function makeSuccessResponse(
  data: Record<string, unknown> = { ok: true },
  analysisVersion = "rev42-v3.0.0",
): ToolResponse {
  return {
    contract_version: CONTRACT_VERSION,
    analysis_version: analysisVersion,
    ok: true,
    data,
    error: null,
  };
}

export function makeErrorResponse(
  code: string,
  message = "error",
  extra: Partial<ToolResponse["error"]> = {},
): ToolResponse {
  return {
    contract_version: CONTRACT_VERSION,
    analysis_version: null,
    ok: false,
    data: null,
    error: { code, message, retryable: false, ...extra },
  };
}

export interface RecordedCall {
  operation: ToolName;
  arguments: Record<string, unknown>;
  userId: string;
  requestId: string;
}

/** Deterministic backend stub that records invocations. */
export class StubBackendClient implements MutantBackendClient {
  readonly calls: RecordedCall[] = [];

  constructor(
    private readonly responder: (operation: ToolName, args: Record<string, unknown>) => ToolResponse,
  ) {}

  async invoke(
    operation: ToolName,
    args: Record<string, unknown>,
    ctx: MutantUserContext,
    requestId: string,
  ): Promise<ToolResponse> {
    this.calls.push({ operation, arguments: args, userId: ctx.userId, requestId });
    return this.responder(operation, args);
  }
}
