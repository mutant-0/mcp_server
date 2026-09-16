import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MutantUserContext } from "../auth/user-context.js";
import { createMutantBackendClient, type MutantBackendClient } from "../clients/mutant-lambda-client.js";
import { scopeFor, type AppConfig } from "../config.js";
import { createReportTool } from "./create-report.js";
import { getAnalysisContextTool } from "./get-analysis-context.js";
import { getAnalysisStatusTool } from "./get-analysis-status.js";
import { getGeneticContextTool } from "./get-genetic-context.js";
import { getHypothesisDetailsTool } from "./get-hypothesis-details.js";
import { getSnpCatalogTool } from "./get-snp-catalog.js";
import { getSupportingEvidenceTool } from "./get-supporting-evidence.js";
import { listHealthHypothesesTool } from "./list-health-hypotheses.js";
import { respond } from "./respond.js";
import { enforceScope } from "./scope-guard.js";
import { showDnaImportTool } from "./show-dna-import.js";
import type { MutantToolDefinition, ToolRuntime } from "./types.js";

export const TOOL_DEFINITIONS: MutantToolDefinition[] = [
  getAnalysisStatusTool,
  getAnalysisContextTool,
  listHealthHypothesesTool,
  getHypothesisDetailsTool,
  getSupportingEvidenceTool,
  getGeneticContextTool,
  showDnaImportTool,
  getSnpCatalogTool,
  createReportTool,
];

/**
 * Per-tool `_meta`.
 *
 * - `securitySchemes` advertises the exact scope that tool needs, so a host can
 *   request it up front and the transports' discovery documents stay consistent
 *   with what is actually enforced in {@link enforceScope}.
 * - `ui` attaches the Apps SDK descriptor. `resourceUri` points at the component
 *   the result renders in; `visibility` (`["app"]`) keeps component-support tools
 *   out of the model's tool list. The `ui/resourceUri` and
 *   `openai/outputTemplate` keys are legacy aliases for hosts that predate
 *   `_meta.ui`, so the component still mounts without them.
 */
export function toolMeta(
  definition: MutantToolDefinition,
  config: AppConfig,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    securitySchemes: [{ type: "oauth2", scopes: [scopeFor(config, definition.scope)] }],
  };

  const ui: Record<string, unknown> = {};
  if (definition.uiResourceUri) ui.resourceUri = definition.uiResourceUri;
  if (definition.uiVisibility) ui.visibility = definition.uiVisibility;

  if (Object.keys(ui).length > 0) {
    meta.ui = ui;
  }
  if (definition.uiResourceUri) {
    // Deprecated MCP Apps key, still read by some hosts.
    meta["ui/resourceUri"] = definition.uiResourceUri;
    // Legacy ChatGPT Apps SDK key.
    meta["openai/outputTemplate"] = definition.uiResourceUri;
  }
  return meta;
}

/**
 * Registers every tool on the server. Identity is captured in the callback
 * closure from the verified token; nothing about the account or plan is read
 * from tool arguments. All entitlement and access decisions happen in the
 * backend, so the same tool definitions are exposed to Free and Full accounts.
 *
 * Per-tool scope authorization runs here rather than inside each handler: the
 * transport accepts a token carrying any supported scope (one connection serves
 * both the analysis tools and the DNA import flow), so the boundary that
 * actually narrows the grant must be impossible to forget when a tool is added.
 */
export function registerTools(
  server: McpServer,
  ctx: MutantUserContext,
  config: AppConfig,
  client: MutantBackendClient = createMutantBackendClient(config),
  requestId = "unknown",
  logger: ToolRuntime["logger"],
): void {
  const runtime: ToolRuntime = { user: ctx, config, client, requestId, logger };
  for (const definition of TOOL_DEFINITIONS) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        annotations: definition.annotations,
        _meta: toolMeta(definition, config),
      },
      async (args: Record<string, unknown> | undefined) => {
        const denied = enforceScope(definition, runtime);
        if (denied) return respond(denied, runtime);
        return definition.handler((args ?? {}) as Record<string, unknown>, runtime);
      },
    );
  }
}
