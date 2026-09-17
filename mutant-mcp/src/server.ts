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
  "Routing: call get_analysis_status first and follow the next_action it returns. When it reports dna_status 'missing', immediately call show_dna_import in the same turn so the user can add their DNA data; never just tell the user to upload DNA. The import runs inside that panel and its raw file is never uploaded. That component also polls the analysis status itself, so do not narrate DNA or analysis status once it has rendered; once analysis_status is 'ready', use the analysis tools below.",
  "Start with get_analysis_context: it returns coverage, interpretation rules and limitations, and the leading health hypotheses.",
  "Never ask the user for an analysis ID; the current analysis is resolved from the connection.",
  "Never ask the user to paste DNA data, genotypes, or file contents into the conversation, and never repeat genotypes back to them.",
  "Scores describe model support and priority, not diagnosis or disease probability.",
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
