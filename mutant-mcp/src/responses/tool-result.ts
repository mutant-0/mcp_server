import type { CallToolResult, TextContent } from "@modelcontextprotocol/sdk/types.js";
import type { ToolErrorPayload, ToolResponse } from "../contract.js";

function textContent(text: string): TextContent {
  return { type: "text", text };
}

/**
 * Build a single text content block mirroring the structured envelope. The
 * structured envelope is authoritative; the text is a fallback for hosts that
 * do not render `structuredContent`.
 */
export function textMirror(response: ToolResponse): string {
  const header = [
    `contract: ${response.contract_version}`,
    `analysis_version: ${response.analysis_version ?? "null"}`,
    `ok: ${response.ok}`,
  ].join("\n");

  if (response.ok) {
    return `${header}\n\ndata:\n${JSON.stringify(response.data, null, 2)}`;
  }
  const error = response.error;
  return `${header}\n\nerror: ${error?.code ?? "UNKNOWN"}\n${error?.message ?? "Unknown error"}`;
}

export interface ToolResultOptions {
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
 * mirrors the envelope into `structuredContent`, adds one text block, and sets
 * `isError` from `ok`.
 */
export function toolResultFromResponse(
  response: ToolResponse,
  options: ToolResultOptions = {},
): CallToolResult {
  const result: CallToolResult = {
    content: [textContent(textMirror(response))],
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
    contract_version: "1.0.0",
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
