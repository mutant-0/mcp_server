import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { MutantUserContext } from "../auth/user-context.js";
import type { MutantBackendClient } from "../clients/mutant-lambda-client.js";
import type { AppConfig, MutantScopeName } from "../config.js";
import type { ToolName } from "../contract.js";
import type { AppLogger } from "../logger.js";

export interface ToolRuntime {
  user: MutantUserContext;
  config: AppConfig;
  client: MutantBackendClient;
  requestId: string;
  logger: AppLogger;
}

export type ToolLogger = ToolRuntime["logger"];

export type ToolHandler = (
  args: Record<string, unknown>,
  runtime: ToolRuntime,
) => Promise<CallToolResult>;

export interface MutantToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  /**
   * OAuth scope name this tool requires. Enforced in the MCP layer before the
   * backend is invoked, and advertised per tool in `_meta.securitySchemes`.
   */
  scope: MutantScopeName;
  /**
   * Apps SDK visibility. `["app"]` keeps the tool out of the model's tool list
   * while leaving it callable by the UI component. Defaults to the host's
   * default (`["model", "app"]`) when omitted.
   */
  uiVisibility?: Array<"model" | "app">;
  /**
   * Apps SDK UI resource this tool renders. When set, the registered tool
   * advertises `_meta.ui.resourceUri` (plus the legacy aliases) so the host
   * knows which component to mount for the result.
   */
  uiResourceUri?: string;
  inputSchema: ZodRawShapeCompat | AnySchema;
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

/**
 * A DNA import is a write, but it is additive and safely retryable when the
 * caller supplies an `import_request_id`, so it is neither read-only nor
 * destructive, and is idempotent.
 */
export const dnaImportWriteAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
