import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MutantUserContext } from "./auth/user-context.js";
import type { MutantBackendClient } from "./clients/mutant-lambda-client.js";
import type { AppConfig } from "./config.js";
import type { AppLogger } from "./logger.js";
import { registerTools } from "./tools/index.js";
import { registerDnaImportUi } from "./ui/dna-import/resource.js";

export const SERVER_NAME = "mutant-mcp";
export const SERVER_VERSION = "1.0.0";

export const SERVER_INSTRUCTIONS = [
  "Mutant Genomics MCP server for the connected account's current saved analysis.",
  "Routing: call get_analysis_status first when readiness is unknown. When DNA is missing, call show_dna_import in the same turn. When a ready status has regenerate=true, its result already opens the Apps SDK card with a refresh button; let the card present the update option and do not write a prose recap or open a second card. For a ready analysis without a refresh, when the user opens Mutant or asks for a general overview, call show_analysis_overview in the same turn and let its card show accessible findings and hints. The card reads status and context itself. Do not narrate status after rendering the card.",
  "For a specific analysis question, use get_analysis_context for the interpretation contract, boundaries, access scope, and compact top-three preview, then use list_health_hypotheses for browsing or comparisons and explain_health_hypothesis for one finding in depth. Do not render the overview card again for each specific question.",
  "Never ask the user for an analysis ID; the current analysis is resolved from the connection.",
  "Never ask the user to paste DNA data, genotypes, or file contents into the conversation, and never repeat genotypes back to them.",
  "Scores describe model support and priority, not diagnosis or disease probability. Do not present catalog clinical correlation as evidence from the user's own records.",
  "Keep labs, symptoms, and medical history in the conversation; send only catalog-topic keywords to search tools.",
  "Fetch context again before combining results that report different analysis_version values.",
  "Respect access limits reported by the server; locked results are returned as structured errors.",
].join(" ");

/**
 * Builds a fresh, fully-configured MCP server for a single request. The user
 * context is captured in tool closures so identity can never be spoofed via
 * tool arguments. Stateless by design: no state is shared across requests.
 */
export function createMcpServer(
  ctx: MutantUserContext,
  config: AppConfig,
  requestId = "unknown",
  client?: MutantBackendClient,
  logger?: AppLogger,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        // The DNA import Apps SDK component is served as an MCP resource, so the
        // server must advertise the capability or a host will not request it.
        resources: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  registerTools(server, ctx, config, client, requestId, logger ?? silentLogger());
  registerDnaImportUi(server, config);
  return server;
}

/**
 * Fallback logger for callers that do not pass one (tests, embedding). Tool
 * handlers always log; this keeps that unconditional without a null check.
 */
function silentLogger(): AppLogger {
  return {
    child: () => silentLogger(),
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
  } as unknown as AppLogger;
}
