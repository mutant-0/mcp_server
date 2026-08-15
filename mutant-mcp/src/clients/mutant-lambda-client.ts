import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { MutantUserContext } from "../auth/user-context.js";
import type { AppConfig } from "../config.js";

/**
 * Internal event contract between the MCP Lambda and the existing Mutant REST
 * Lambda. `identity.user_id` is always derived from the verified token.
 */
export interface MutantLambdaEvent {
  source: "mutant-mcp";
  version: "1";
  operation: string;
  identity: { user_id: string };
  arguments: Record<string, unknown>;
  request_context: { request_id: string };
}

export interface MutantLambdaClient {
  invoke(
    operation: string,
    args: Record<string, unknown>,
    ctx: MutantUserContext,
    requestId: string,
  ): Promise<unknown>;
}

function regionFromArn(arn: string): string {
  const region = arn.split(":")[3];
  return region && region.length > 0 ? region : "us-east-1";
}

export class AwsMutantLambdaClient implements MutantLambdaClient {
  private readonly lambda: LambdaClient;

  constructor(private readonly config: AppConfig) {
    this.lambda = new LambdaClient({ region: regionFromArn(config.MUTANT_SERVICE_LAMBDA_ARN) });
  }

  async invoke(
    operation: string,
    args: Record<string, unknown>,
    ctx: MutantUserContext,
    requestId: string,
  ): Promise<unknown> {
    const event: MutantLambdaEvent = {
      source: "mutant-mcp",
      version: "1",
      operation,
      identity: { user_id: ctx.userId },
      arguments: args,
      request_context: { request_id: requestId },
    };

    const command = new InvokeCommand({
      FunctionName: this.config.MUTANT_SERVICE_LAMBDA_ARN,
      InvocationType: "RequestResponse",
      Payload: new TextEncoder().encode(JSON.stringify(event)),
    });

    const response = await this.lambda.send(command);
    if (response.FunctionError) {
      throw new Error(`Mutant Lambda returned an error: ${response.FunctionError}`);
    }
    if (!response.Payload) {
      return undefined;
    }
    const body = Buffer.from(response.Payload).toString("utf-8");
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
}

/** Used when no target ARN is configured, so the shell is fully self-contained. */
export class MockMutantLambdaClient implements MutantLambdaClient {
  async invoke(
    operation: string,
    args: Record<string, unknown>,
    ctx: MutantUserContext,
    requestId: string,
  ): Promise<unknown> {
    return {
      status: "ok",
      mock: true,
      operation,
      identity: { user_id: ctx.userId },
      request_id: requestId,
      arguments_received: args,
    };
  }
}

export function createMutantLambdaClient(config: AppConfig): MutantLambdaClient {
  if (!config.MUTANT_SERVICE_LAMBDA_ARN) {
    return new MockMutantLambdaClient();
  }
  return new AwsMutantLambdaClient(config);
}
