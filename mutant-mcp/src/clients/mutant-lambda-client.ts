import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { MutantUserContext } from "../auth/user-context.js";
import type { AppConfig } from "../config.js";
import {
  CONTRACT_VERSION,
  ErrorCode,
  isToolResponse,
  type ToolName,
  type ToolResponse,
} from "../contract.js";

/**
 * Versioned internal request contract for direct Lambda invocation.
 * `identity.user_id` is always derived from the verified token.
 */
export interface MutantBackendEvent {
  source: "mutant-mcp";
  contract_version: typeof CONTRACT_VERSION;
  operation: ToolName;
  identity: { user_id: string };
  arguments: Record<string, unknown>;
  request_context: { request_id: string };
}

export interface MutantBackendClient {
  invoke(
    operation: ToolName,
    args: Record<string, unknown>,
    ctx: MutantUserContext,
    requestId: string,
  ): Promise<ToolResponse>;
}

export function buildBackendEvent(
  operation: ToolName,
  args: Record<string, unknown>,
  ctx: MutantUserContext,
  requestId: string,
): MutantBackendEvent {
  return {
    source: "mutant-mcp",
    contract_version: CONTRACT_VERSION,
    operation,
    identity: { user_id: ctx.userId },
    arguments: args,
    request_context: { request_id: requestId },
  };
}

function fieldError(code: string, message: string, retryable = false): ToolResponse {
  return {
    contract_version: CONTRACT_VERSION,
    analysis_version: null,
    ok: false,
    data: null,
    error: {
      code,
      message,
      retryable,
      ...(retryable ? { retry_after_seconds: 30 } : {}),
    },
  };
}

export function serviceUnavailable(message: string): ToolResponse {
  return fieldError(ErrorCode.SERVICE_UNAVAILABLE, message, true);
}

function regionFromArn(arn: string): string {
  const region = arn.split(":")[3];
  return region && region.length > 0 ? region : "us-east-1";
}

export class AwsMutantBackendClient implements MutantBackendClient {
  private readonly lambda: LambdaClient;

  constructor(private readonly config: AppConfig) {
    this.lambda = new LambdaClient({ region: regionFromArn(config.MUTANT_SERVICE_LAMBDA_ARN) });
  }

  async invoke(
    operation: ToolName,
    args: Record<string, unknown>,
    ctx: MutantUserContext,
    requestId: string,
  ): Promise<ToolResponse> {
    const event = buildBackendEvent(operation, args, ctx, requestId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.MUTANT_REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await this.lambda.send(
        new InvokeCommand({
          FunctionName: this.config.MUTANT_SERVICE_LAMBDA_ARN,
          InvocationType: "RequestResponse",
          Payload: new TextEncoder().encode(JSON.stringify(event)),
        }),
        { abortSignal: controller.signal },
      );
    } catch (error) {
      return serviceUnavailable(
        error instanceof Error && error.name === "AbortError"
          ? "The analysis request timed out."
          : "The analysis service is temporarily unavailable.",
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.Payload) {
      return fieldError(
        ErrorCode.DATA_INCOMPATIBLE,
        "The analysis service returned an empty response.",
      );
    }

    const body = Buffer.from(response.Payload).toString("utf-8");
    if (response.FunctionError) {
      return serviceUnavailable("The analysis service failed to handle the request.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return fieldError(
        ErrorCode.DATA_INCOMPATIBLE,
        "The analysis service returned an unreadable response.",
      );
    }

    return parseBackendPayload(parsed);
  }
}

/**
 * Validate and normalize a decoded backend payload into a `ToolResponse`.
 * Anything outside the contract maps to an explicit structured error rather
 * than an empty success.
 */
export function parseBackendPayload(parsed: unknown): ToolResponse {
  if (!isToolResponse(parsed)) {
    return fieldError(
      ErrorCode.DATA_INCOMPATIBLE,
      "The analysis service returned a response outside the MCP contract.",
    );
  }
  if (parsed.contract_version !== CONTRACT_VERSION) {
    return fieldError(
      ErrorCode.DATA_INCOMPATIBLE,
      `Unsupported backend contract version '${parsed.contract_version}'.`,
    );
  }
  return parsed;
}

/** Used when no target ARN is configured, so local development stays self-contained. */
export class MockMutantBackendClient implements MutantBackendClient {
  async invoke(
    operation: ToolName,
    args: Record<string, unknown>,
    ctx: MutantUserContext,
    requestId: string,
  ): Promise<ToolResponse> {
    return {
      contract_version: CONTRACT_VERSION,
      analysis_version: "mock",
      ok: true,
      data: {
        mock: true,
        operation,
        identity: { user_id: ctx.userId },
        request_id: requestId,
        arguments_received: args,
      },
      error: null,
    };
  }
}

export function createMutantBackendClient(config: AppConfig): MutantBackendClient {
  if (!config.MUTANT_SERVICE_LAMBDA_ARN) {
    return new MockMutantBackendClient();
  }
  return new AwsMutantBackendClient(config);
}
