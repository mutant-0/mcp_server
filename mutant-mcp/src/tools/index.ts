import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MutantUserContext } from "../auth/user-context.js";
import type { AppConfig } from "../config.js";
import { canAccess } from "../entitlements/access-policy.js";
import { upgradeRequiredResult } from "../responses/tool-result.js";
import type { MutantToolDefinition, ToolArgs } from "./types.js";
import { getAnalysisStatusTool } from "./get-analysis-status.js";
import { getGenomicOverviewTool } from "./get-genomic-overview.js";
import { getGeneticContextTool } from "./get-genetic-context.js";
import { getVariantContextTool } from "./get-variant-context.js";
import { getRootCauseDetailsTool } from "./get-root-cause-details.js";
import { getSupportingEvidenceTool } from "./get-supporting-evidence.js";
import { getRelevantTestsTool } from "./get-relevant-tests.js";

export const TOOL_DEFINITIONS: MutantToolDefinition[] = [
  getAnalysisStatusTool,
  getGenomicOverviewTool,
  getGeneticContextTool,
  getVariantContextTool,
  getRootCauseDetailsTool,
  getSupportingEvidenceTool,
  getRelevantTestsTool,
];

/**
 * Registers every tool on the given server. The user context is captured in the
 * callback closure so entitlement checks use trusted, server-derived identity.
 */
export function registerTools(
  server: McpServer,
  ctx: MutantUserContext,
  config: AppConfig,
): void {
  for (const definition of TOOL_DEFINITIONS) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        annotations: definition.annotations,
      },
      async (args) => {
        if (!canAccess(definition.name, ctx)) {
          return upgradeRequiredResult(config);
        }
        return definition.handler(args as ToolArgs, ctx, config);
      },
    );
  }
}
