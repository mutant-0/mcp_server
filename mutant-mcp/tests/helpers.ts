import type { MutantUserContext } from "../src/auth/user-context.js";
import type { MutantBackendClient } from "../src/clients/mutant-lambda-client.js";
import type { AppConfig } from "../src/config.js";
import { CONTRACT_VERSION, type ToolName, type ToolResponse } from "../src/contract.js";

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    MUTANT_SERVICE_LAMBDA_ARN: "",
    MUTANT_OAUTH_ISSUER: "https://auth.mutantgenomics.com",
    MUTANT_OAUTH_AUDIENCE: "",
    MUTANT_OAUTH_CLIENT_ID: "",
    MUTANT_OAUTH_SCOPE: "mutant/analysis.read",
    MUTANT_MCP_RESOURCE_URI: "https://mcp.mutantgenomics.com/mcp",
    MUTANT_CORS_ORIGINS: "https://chatgpt.com",
    MUTANT_UPGRADE_URL: "https://mutantgenomics.com/cart",
    MUTANT_ONBOARDING_URL: "https://mutantgenomics.com/onboarding",
    MUTANT_REQUEST_TIMEOUT_MS: 5000,
    MUTANT_MAX_RESPONSE_BYTES: 512000,
    MUTANT_DEV_MODE: true,
    LOG_LEVEL: "silent",
    ...overrides,
  };
}

export function makeUser(overrides: Partial<MutantUserContext> = {}): MutantUserContext {
  return {
    userId: "user-1",
    scopes: ["mutant/analysis.read"],
    ...overrides,
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
