import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { MutantUserContext } from "../auth/user-context.js";
import type { AppConfig } from "../config.js";
import type { AccessTier, ToolName } from "../entitlements/access-policy.js";

export type ToolArgs = Record<string, unknown>;

export type ToolHandler = (
  args: ToolArgs,
  ctx: MutantUserContext,
  config: AppConfig,
) => Promise<CallToolResult> | CallToolResult;

export interface MutantToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: ZodRawShapeCompat;
  outputSchema: ZodRawShapeCompat;
  annotations: ToolAnnotations;
  accessTier: AccessTier;
  handler: ToolHandler;
}

export const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
