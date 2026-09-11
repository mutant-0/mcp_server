/**
 * Shared Mutant MCP contract (version 1.0.0).
 *
 * These constants, error codes, and envelope types mirror the backend
 * implementation in `report-generator/mcp/contract.py`. The backend owns all
 * business semantics; the MCP Lambda is a thin, authenticated transport.
 */

export const CONTRACT_VERSION = "1.0.0";

export const TOOL_NAMES = [
  "get_analysis_status",
  "get_analysis_context",
  "list_health_hypotheses",
  "get_hypothesis_details",
  "get_supporting_evidence",
  "get_genetic_context",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const ErrorCode = {
  AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
  INSUFFICIENT_SCOPE: "INSUFFICIENT_SCOPE",
  ACCOUNT_NOT_AVAILABLE: "ACCOUNT_NOT_AVAILABLE",
  ANALYSIS_NOT_FOUND: "ANALYSIS_NOT_FOUND",
  ANALYSIS_NOT_READY: "ANALYSIS_NOT_READY",
  ANALYSIS_FAILED: "ANALYSIS_FAILED",
  ANALYSIS_CHANGED: "ANALYSIS_CHANGED",
  PLAN_ACCESS_REQUIRED: "PLAN_ACCESS_REQUIRED",
  HYPOTHESIS_SCOPE_REQUIRED: "HYPOTHESIS_SCOPE_REQUIRED",
  HYPOTHESIS_NOT_FOUND: "HYPOTHESIS_NOT_FOUND",
  PATTERN_NOT_FOUND: "PATTERN_NOT_FOUND",
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  INVALID_CURSOR: "INVALID_CURSOR",
  RATE_LIMITED: "RATE_LIMITED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  DATA_INCOMPATIBLE: "DATA_INCOMPATIBLE",
  RESPONSE_TOO_LARGE: "RESPONSE_TOO_LARGE",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ToolErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
  next_action?: string;
  required_plan?: string;
  upgrade_url?: string;
  retry_after_seconds?: number;
}

export interface ToolResponse<T = Record<string, unknown>> {
  contract_version: string;
  analysis_version: string | null;
  ok: boolean;
  data: T | null;
  error: ToolErrorPayload | null;
}

export function isToolResponse(value: unknown): value is ToolResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.ok === "boolean" &&
    "data" in record &&
    "error" in record &&
    typeof record.contract_version === "string"
  );
}

export const SCOPE_HINT = "mutant/analysis.read";
