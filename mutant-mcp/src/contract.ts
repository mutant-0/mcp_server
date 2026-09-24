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
  "show_analysis_overview",
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
  /**
   * Readiness diagnostic for a saved analysis that could not be served
   * (e.g. `analysis_payload_pending`, `analysis_engine_changed`).
   * `ANALYSIS_NOT_READY` covers both a regeneration still in flight and a
   * permanent engine change — which have opposite remedies — so this reports
   * which one actually applied.
   */
  reason?: string;
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

/** Effective plan for the connected account. */
export type AnalysisPlan = "mutant_free" | "mutant_full";

/**
 * The versioned, server-owned interpretation contract returned by
 * `get_analysis_context`. It supplies the analysis-specific guidance the model
 * needs to explain and present the overall experience; it is not per-hypothesis
 * prose and is never generated by an LLM.
 */
export interface InterpretationContract {
  version: "2.1";
  purpose: string;
  response_rules: string[];
  /**
   * Module-first explanation rules. ChatGPT must organize a hypothesis
   * explanation by biological module first, then retained patterns, then
   * individual genes/variants (`organizing_level`).
   */
  evidence_explanation_rules: {
    organizing_level: "modules_then_patterns_then_variants";
    rules: string[];
    module_first_instruction: string;
  };
  score_semantics: {
    priority_score: string;
    genetic_support: string;
    genetic_evidence: string;
    coverage_confidence: string;
    pattern_convergence: string;
    module_support: string;
    pattern_support: string;
  };
  evidence_boundaries: {
    genetics_is_not_diagnosis: true;
    genetic_support_does_not_establish_current_status: true;
    clinical_correlation_is_catalog_guidance: true;
    clinical_correlation_is_not_user_record_evidence: true;
  };
  health_context_usage: {
    allowed: true;
    performed_by: "chatgpt";
    sent_to_mutant: false;
    purpose: "relevance_filtering";
  };
  presentation_order: Array<
    | "bottom_line"
    | "support_architecture"
    | "module_contributions"
    | "pattern_contributions"
    | "key_scoring_genes_and_variants"
    | "interpretation_boundary"
    | "minimal_confirmation"
    | "strengthening_and_weakening_evidence"
    | "action_changing_guardrail"
  >;
  limitations: string[];
}

/**
 * Module-aware scoring-trace types for `explain_health_hypothesis`.
 *
 * These mirror the retained engine trace projected by the backend. The wire
 * schema for `data` stays loose (the transport does not exact-validate it), but
 * these types are the reference for the deterministic content builders.
 */

/** Deterministic classification of a hypothesis's genetic support. */
export type SupportArchitectureClassification =
  | "single_locus"
  | "locus_concentrated"
  | "multi_gene_single_module"
  | "multi_module"
  | "pattern_led"
  | "unknown";

export interface SupportArchitecture {
  classification: SupportArchitectureClassification;
  /** Present on the retained trace; absent on the legacy fallback. */
  contributing_module_count?: number;
  module_scoring_gene_count?: number;
  module_scoring_variant_count?: number;
  pattern_participating_gene_count?: number;
  pattern_participating_variant_count?: number;
  dominant_driver?: {
    type: "module" | "pattern" | "gene" | "variant" | null;
    id: string | null;
    name: string | null;
    contribution_fraction?: number;
  };
  summary: string;
}

export interface ModuleContribution {
  module_id: string | null;
  module_name: string | null;
  scoring_status: "active" | "partially_active" | "context_only" | "retired" | null;
  role: "primary" | "supporting" | "context" | null;
  retained_support: number | null;
  module_support_fraction?: number | null;
  module_scoring_gene_count: number;
  module_scoring_variant_count: number;
  top_scoring_genes: string[];
  summary: string | null;
  caveats: string[];
}

export interface PatternContribution {
  pattern_id: string | null;
  pattern_name: string | null;
  state: "matched" | "provisional" | null;
  retained_support: number | null;
  module_ids: string[];
  participating_gene_count: number;
  participating_variant_count: number;
  summary: string | null;
}

export interface ScoreBreakdown {
  priority_score: number | null;
  genetic_support: number | null;
  module_support: number | null;
  pattern_support: number | null;
  converging_pattern_adjustment: number | null;
}

/**
 * A converging pattern: a separate priority-only contribution family. It is
 * never summed into `module_support` or `pattern_support`.
 */
export interface ConvergingPatternContribution {
  pattern_id: string | null;
  state: string | null;
  structural_fit: number | null;
  pattern_confidence: number | null;
  contribution: number | null;
}

/** The `explain_health_hypothesis` payload. */
export interface HypothesisDetailsData {
  hypothesis: {
    id: string | null;
    rank: number;
    title: string;
    assessment_state: string | null;
    scores: {
      priority: number | null;
      genetic_support: number | null;
      coverage: string | null;
      convergence: string | null;
    };
  };
  explanation: Record<string, unknown>;
  score_breakdown: ScoreBreakdown;
  support_architecture: SupportArchitecture;
  module_contributions: ModuleContribution[];
  pattern_contributions: PatternContribution[];
  /** Separate priority-only family; never summed into module/pattern support. */
  converging_pattern_contributions: ConvergingPatternContribution[];
  clinical_context?: Record<string, unknown>;
  confirmation?: Record<string, unknown>;
  guardrails?: string[];
  related_hypotheses?: Array<Record<string, unknown>>;
  suggested_prompts?: PromptSuggestion[];
}

/** The compact preview returned in `get_analysis_context`. */
export interface HypothesisPreview {
  id: string | null;
  rank: number;
  title: string;
  bottom_line: string;
  priority_score: number | null;
  genetic_evidence: "weak" | "moderate" | "strong" | null;
  coverage_confidence: "low" | "moderate" | "high" | null;
  pattern_convergence: "weak" | "moderate" | "strong" | null;
}

/**
 * The richer browse/search summary owned by `list_health_hypotheses`.
 * Deliberately a separate type from `HypothesisPreview` so the context response
 * cannot gradually accumulate list-only fields.
 */
export interface HypothesisSummary {
  id: string | null;
  rank: number;
  title: string;
  bottom_line: string;
  priority_score: number | null;
  genetic_support_score: number | null;
  genetic_evidence: "weak" | "moderate" | "strong" | null;
  coverage_confidence: "low" | "moderate" | "high" | null;
  pattern_convergence: "weak" | "moderate" | "strong" | null;
  context_tags?: string[];
}

/** Access scope of the current analysis. */
export interface AccessSummary {
  plan: AnalysisPlan;
  hypothesis_scope: "top_3" | "all";
  total_ranked: number;
  returned: number;
  unlocked: number;
  locked: number;
  scope_message: string;
}

export interface AnalysisCoverage {
  analyzed_markers: number | null;
  classification?: "limited" | "moderate" | "broad";
}

export interface UpgradeOffer {
  label: string;
  url: string;
}

/**
 * The `get_analysis_context` payload. `suggested_prompts` is attached at the MCP
 * boundary; the backend supplies every other field.
 */
export interface GetAnalysisContextData {
  interpretation_contract: InterpretationContract;
  coverage: AnalysisCoverage;
  access_summary: AccessSummary;
  top_hypotheses: HypothesisPreview[];
  upgrade?: UpgradeOffer;
  suggested_prompts: PromptSuggestion[];
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
