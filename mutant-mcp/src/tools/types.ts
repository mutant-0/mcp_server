import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { MutantUserContext } from "../auth/user-context.js";
import type { MutantBackendClient } from "../clients/mutant-lambda-client.js";
import type { AppConfig } from "../config.js";
import type { ToolName } from "../contract.js";

export interface ToolRuntime {
  user: MutantUserContext;
  config: AppConfig;
  client: MutantBackendClient;
  requestId: string;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  runtime: ToolRuntime,
) => Promise<CallToolResult>;

export interface MutantToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: ZodRawShapeCompat;
  outputSchema: AnySchema;
  annotations: ToolAnnotations;
  handler: ToolHandler;
}

export const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
