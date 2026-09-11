import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MutantUserContext } from "./auth/user-context.js";
import type { MutantBackendClient } from "./clients/mutant-lambda-client.js";
import type { AppConfig } from "./config.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = "mutant-mcp";
export const SERVER_VERSION = "1.0.0";

export const SERVER_INSTRUCTIONS = [
  "Mutant Genomics MCP server for the connected account's current saved analysis.",
  "Start with get_analysis_context: it returns coverage, interpretation rules and limitations, and the leading health hypotheses.",
  "Never ask the user for an analysis ID; the current analysis is resolved from the connection.",
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
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  registerTools(server, ctx, config, client, requestId);
  return server;
}
