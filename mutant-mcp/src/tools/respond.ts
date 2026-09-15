import { requiredScope, resourceUri } from "../config.js";
import type { ToolResponse } from "../contract.js";
import { protectedResourceMetadataUrl, toolAuthChallenge } from "../responses/errors.js";
import { toolResultFromResponse } from "../responses/tool-result.js";
import type { ToolRuntime } from "./types.js";

/**
 * Convert a backend envelope into a tool result, adding a tool-level OAuth
 * challenge when the backend reports an authentication/scope problem. This lets
 * the MCP client trigger (re)authorization without a transport-level 401.
 */
export function respond(response: ToolResponse, runtime: ToolRuntime) {
  const code = response.error?.code;
  if (code === "AUTHENTICATION_REQUIRED" || code === "INSUFFICIENT_SCOPE") {
    return toolResultFromResponse(response, {
      challenge: toolAuthChallenge({
        resourceMetadataUrl: protectedResourceMetadataUrl(resourceUri(runtime.config)),
        error: code === "INSUFFICIENT_SCOPE" ? "insufficient_scope" : "invalid_token",
        ...(response.error?.message ? { errorDescription: response.error.message } : {}),
        scope: requiredScope(runtime.config),
      }),
    });
  }
  return toolResultFromResponse(response);
}
