/**
 * Shared Mutant MCP contract (version 2.0.0).
 *
 * These constants, error codes, and envelope types mirror the backend
 * implementation in `report-generator/mcp/contract.py`. The backend owns all
 * business semantics; the MCP Lambda is a thin, authenticated transport.
 */

export const CONTRACT_VERSION = "2.0.0";

/**
 * Model-facing analysis tools. These require `analysis.read`.
 */
export const ANALYSIS_TOOL_NAMES = [
  "get_analysis_status",
  "get_analysis_context",
  "list_health_hypotheses",
  "explain_health_hypothesis",
  "get_supporting_evidence",
  "get_genetic_context",
] as const;

/**
 * DNA import tools. `show_dna_import` renders the Apps SDK component;
 * `get_snp_catalog` and `create_report` are called by that component. All three
 * require the dedicated `dna.import` scope because `create_report` writes data.
 */
export const DNA_IMPORT_TOOL_NAMES = [
  "show_dna_import",
  "get_snp_catalog",
  "create_report",
] as const;

export const TOOL_NAMES = [...ANALYSIS_TOOL_NAMES, ...DNA_IMPORT_TOOL_NAMES] as const;

export type AnalysisToolName = (typeof ANALYSIS_TOOL_NAMES)[number];
export type DnaImportToolName = (typeof DNA_IMPORT_TOOL_NAMES)[number];
export type ToolName = (typeof TOOL_NAMES)[number];

export function isDnaImportTool(name: string): name is DnaImportToolName {
  return (DNA_IMPORT_TOOL_NAMES as readonly string[]).includes(name);
}

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
  // DNA import. These map onto the lowercase application codes the component
  // renders (`catalog_unavailable`, `invalid_dna_payload`, ...).
  CATALOG_UNAVAILABLE: "CATALOG_UNAVAILABLE",
  INVALID_DNA_PAYLOAD: "INVALID_DNA_PAYLOAD",
  UNSUPPORTED_FORMAT: "UNSUPPORTED_FORMAT",
  UNSUPPORTED_GENOME_BUILD: "UNSUPPORTED_GENOME_BUILD",
  REPORT_GENERATION_FAILED: "REPORT_GENERATION_FAILED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
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
  /**
   * URI-form scope required by the tool that produced this error. Present on
   * `INSUFFICIENT_SCOPE` so the tool-level OAuth challenge advertises the exact
   * scope the client must request to unblock itself.
   */
  required_scope?: string;
  /**
   * Application-level error code for the DNA import component
   * (e.g. `invalid_dna_payload`). Hosts that render the Apps SDK component use
   * this; the envelope `code` remains the stable MCP contract value.
   */
  app_code?: string;
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

/**
 * A state-aware, user-visible follow-up the widget can render as a chip. The
 * `prompt` is exact natural language; it must never contain internal commands.
 */
export interface PromptSuggestion {
  id: string;
  label: string;
  prompt: string;
  intent:
    | "overview"
    | "explain"
    | "evidence"
    | "confirmation"
    | "comparison"
    | "clinician_questions"
    | "regeneration"
    | "import_help";
  hypothesis_id?: string;
}

/**
 * Stable application-level error vocabulary surfaced to the DNA import
 * component (contract codes -> component codes).
 */
export const APP_ERROR_CODES = {
  unauthorized: "unauthorized",
  insufficient_scope: "insufficient_scope",
  catalog_unavailable: "catalog_unavailable",
  invalid_dna_payload: "invalid_dna_payload",
  unsupported_format: "unsupported_format",
  unsupported_genome_build: "unsupported_genome_build",
  report_generation_failed: "report_generation_failed",
  payload_too_large: "payload_too_large",
  service_unavailable: "service_unavailable",
  // Derived by the DNA import component from the analysis lifecycle rather than
  // returned by a tool: `analysis_failed` when the analysis reaches a failed
  // state, `analysis_timeout` when polling stops without a terminal state. They
  // exist so the component reports a debugging code without surfacing backend
  // exceptions to the user.
  analysis_failed: "analysis_failed",
  analysis_timeout: "analysis_timeout",
} as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[keyof typeof APP_ERROR_CODES];

/** Map a contract error code to the component-facing application code. */
export function appErrorCode(code: string): AppErrorCode {
  switch (code) {
    case ErrorCode.AUTHENTICATION_REQUIRED:
      return APP_ERROR_CODES.unauthorized;
    case ErrorCode.INSUFFICIENT_SCOPE:
      return APP_ERROR_CODES.insufficient_scope;
    case ErrorCode.CATALOG_UNAVAILABLE:
      return APP_ERROR_CODES.catalog_unavailable;
    case ErrorCode.INVALID_DNA_PAYLOAD:
    case ErrorCode.INVALID_ARGUMENT:
      return APP_ERROR_CODES.invalid_dna_payload;
    case ErrorCode.UNSUPPORTED_FORMAT:
      return APP_ERROR_CODES.unsupported_format;
    case ErrorCode.UNSUPPORTED_GENOME_BUILD:
      return APP_ERROR_CODES.unsupported_genome_build;
    case ErrorCode.REPORT_GENERATION_FAILED:
      return APP_ERROR_CODES.report_generation_failed;
    case ErrorCode.PAYLOAD_TOO_LARGE:
    case ErrorCode.RESPONSE_TOO_LARGE:
      return APP_ERROR_CODES.payload_too_large;
    default:
      return APP_ERROR_CODES.service_unavailable;
  }
}
