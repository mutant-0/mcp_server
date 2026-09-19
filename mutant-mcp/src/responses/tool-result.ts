import type { CallToolResult, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { CONTRACT_VERSION, type ToolErrorPayload, type ToolName, type ToolResponse } from "../contract.js";
import { buildContent } from "../presentation/content.js";

function textContent(text: string): TextContent {
  return { type: "text", text };
}

/**
 * Build the single text content block for a result.
 *
 * The block is a concise deterministic summary assembled from the typed data
 * (see `buildContent`); it is never a serialized copy of `structuredContent`.
 * `operation` selects the summary; without it a generic summary is used.
 */
export function textMirror(response: ToolResponse, operation?: ToolName): string {
  return buildContent(operation, response);
}

export interface ToolResultOptions {
  /** Tool that produced the response, selecting the deterministic summary. */
  operation?: ToolName;
  /** Tool-level auth challenge for `_meta["mcp/www_authenticate"]`. */
  challenge?: Record<string, unknown>;
  /**
   * Extra `_meta` merged into the result. Used to attach the Apps SDK UI
   * descriptors and security schemes a host needs to render the component.
   */
  meta?: Record<string, unknown>;
}

/**
 * Convert a backend `ToolResponse` envelope into an MCP `CallToolResult`:
 * mirrors the envelope into `structuredContent`, adds one deterministic text
 * block, and sets `isError` from `ok`.
 */
export function toolResultFromResponse(
  response: ToolResponse,
  options: ToolResultOptions = {},
): CallToolResult {
  const result: CallToolResult = {
    content: [textContent(buildContent(options.operation, response))],
    structuredContent: response as unknown as Record<string, unknown>,
    isError: !response.ok,
  };
  if (options.challenge) {
    result._meta = options.challenge;
  }
  if (options.meta) {
    result._meta = { ...(result._meta ?? {}), ...options.meta };
  }
  return result;
}

export function errorToolResult(
  error: ToolErrorPayload,
  analysisVersion: string | null = null,
): CallToolResult {
  return toolResultFromResponse({
    contract_version: CONTRACT_VERSION,
    analysis_version: analysisVersion,
    ok: false,
    data: null,
    error,
  });
}

/** Convenience for transport failures (never silently returns an empty success). */
export function serviceUnavailableResult(
  message = "The Mutant analysis service is temporarily unavailable.",
  retryAfterSeconds = 30,
): CallToolResult {
  return errorToolResult({
    code: "SERVICE_UNAVAILABLE",
    message,
    retryable: true,
    retry_after_seconds: retryAfterSeconds,
  });
}
