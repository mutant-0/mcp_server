import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MutantUserContext } from "../auth/user-context.js";
import { createMutantBackendClient, type MutantBackendClient } from "../clients/mutant-lambda-client.js";
import type { AppConfig } from "../config.js";
import { getAnalysisContextTool } from "./get-analysis-context.js";
import { getAnalysisStatusTool } from "./get-analysis-status.js";
import { getGeneticContextTool } from "./get-genetic-context.js";
import { getHypothesisDetailsTool } from "./get-hypothesis-details.js";
import { getSupportingEvidenceTool } from "./get-supporting-evidence.js";
import { listHealthHypothesesTool } from "./list-health-hypotheses.js";
import type { MutantToolDefinition, ToolRuntime } from "./types.js";

export const TOOL_DEFINITIONS: MutantToolDefinition[] = [
  getAnalysisStatusTool,
  getAnalysisContextTool,
  listHealthHypothesesTool,
  getHypothesisDetailsTool,
  getSupportingEvidenceTool,
  getGeneticContextTool,
];

/**
 * Registers every tool on the server. Identity is captured in the callback
 * closure from the verified token; nothing about the account or plan is read
 * from tool arguments. All entitlement and access decisions happen in the
 * backend, so the same tool definitions are exposed to Free and Full accounts.
 */
export function registerTools(
  server: McpServer,
  ctx: MutantUserContext,
  config: AppConfig,
  client: MutantBackendClient = createMutantBackendClient(config),
  requestId = "unknown",
): void {
  const runtime: ToolRuntime = { user: ctx, config, client, requestId };

  for (const definition of TOOL_DEFINITIONS) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        annotations: definition.annotations,
        _meta: {
          securitySchemes: [
            { type: "oauth2", scopes: [config.MUTANT_OAUTH_SCOPE] },
          ],
        },
      },
      async (args) => definition.handler((args ?? {}) as Record<string, unknown>, runtime),
    );
  }
}
