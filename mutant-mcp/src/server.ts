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
  "Routing: call get_analysis_status first when readiness is unknown. Read its experience_state and capabilities instead of inferring readiness. When experience_state is NO_DNA, call show_dna_import in the same turn. When experience_state is READY_REFRESH_AVAILABLE or READY_REFRESH_PROCESSING, its result already opens the Apps SDK card with the refresh option; let the card present it and do not write a prose recap or open a second card. When capabilities.can_query_analysis is true and the user opens Mutant or asks for a general overview, call show_analysis_overview in the same turn and let its card show accessible findings and hints. Do not narrate status after rendering the card.",
  "While no usable analysis exists (experience_state PROCESSING_INITIAL or REFRESH_PROCESSING_NO_USABLE_ANALYSIS), do not call analysis, overview, hypothesis, evidence, or genetic-context tools, do not describe or speculate about future capabilities, genes, modules, rsIDs, variants, hypotheses, scores, or patterns, and never promise what will become available. The DNA import component owns that state and polls its own app-only poll_analysis_status tool, so do not poll get_analysis_status, do not tell the user to keep asking for updates, and do not add unsolicited processing narration. If the user explicitly asks, answer briefly using only the current status payload.",
  "For a specific analysis question, use get_analysis_context for the interpretation contract, boundaries, access scope, and compact top-three preview, then use list_health_hypotheses for browsing or comparisons and explain_health_hypothesis for one finding in depth. Do not render the overview card again for each specific question. Pass the displayed analysis_version from a card or prompt suggestion back on follow-up calls so the same revision is answered.",
  "Never ask the user for an analysis ID; the current analysis is resolved from the connection.",
  "Never ask the user to paste DNA data, genotypes, or file contents into the conversation, and never repeat genotypes back to them.",
  "Scores describe model support and priority, not diagnosis or disease probability. Do not present catalog clinical correlation as evidence from the user's own records.",
  "Keep labs, symptoms, and medical history in the conversation; send only catalog-topic keywords to search tools.",
  "Analysis lifecycle states (not ready, processing, plan-limited, scope-limited, hypothesis not found, empty evidence, regeneration required, rate limited, snapshot changed) arrive as structured errors with a next_action. Follow next_action.tool instead of retrying the same call.",
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
