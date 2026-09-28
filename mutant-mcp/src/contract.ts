/**
 * Shared Mutant MCP contract (version 3.0.0).
 *
 * These constants, error codes, and envelope types mirror the backend
 * implementation in `report-generator/mcp/contract.py`. The backend owns all
 * business semantics; the MCP Lambda is a thin, authenticated transport.
 *
 * 3.0.0 is a clean break. The response contract is now:
 *
 *  - every expected application failure is returned as `ok:false` with a
 *    structured `error.code` (never thrown through the MCP transport);
 *  - `error.next_action` is a structured `{ tool, reason?, arguments? }`;
 *  - analysis state is split into `active_analysis` (queryable now) and
 *    `pending_analysis` (in flight), with one canonical `experience_state`;
 *  - every analytical response identifies the exact `analysis_version` it
 *    describes.
 *
 * The removed 2.0.0 fields are `analysis_status`, `regenerate`,
 * `regeneration`, `current_results_usable`, and `optional_actions`.
 */

export const CONTRACT_VERSION = "3.0.0";

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

/**
 * Internal-only backend operation used by `show_analysis_overview` to bind the
 * Apps SDK card to one immutable analysis snapshot. It is never advertised as a
 * model-facing tool.
 */
export const RESOLVE_SNAPSHOT_OPERATION = "resolve_analysis_snapshot";

export type BackendOperation = ToolName | typeof RESOLVE_SNAPSHOT_OPERATION;

export function isDnaImportTool(name: string): name is DnaImportToolName {
  return (DNA_IMPORT_TOOL_NAMES as readonly string[]).includes(name);
}

export const ErrorCode = {
  AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
  INSUFFICIENT_SCOPE: "INSUFFICIENT_SCOPE",
  ACCOUNT_NOT_AVAILABLE: "ACCOUNT_NOT_AVAILABLE",
  ANALYSIS_NOT_FOUND: "ANALYSIS_NOT_FOUND",
  ANALYSIS_NOT_READY: "ANALYSIS_NOT_READY",
  ANALYSIS_PROCESSING: "ANALYSIS_PROCESSING",
  ANALYSIS_FAILED: "ANALYSIS_FAILED",
  ANALYSIS_VERSION_CHANGED: "ANALYSIS_VERSION_CHANGED",
  DNA_NOT_AVAILABLE: "DNA_NOT_AVAILABLE",
  PLAN_REQUIRED: "PLAN_REQUIRED",
  SCOPE_REQUIRED: "SCOPE_REQUIRED",
  HYPOTHESIS_NOT_FOUND: "HYPOTHESIS_NOT_FOUND",
  PATTERN_NOT_FOUND: "PATTERN_NOT_FOUND",
  EVIDENCE_NOT_AVAILABLE: "EVIDENCE_NOT_AVAILABLE",
  REGENERATION_REQUIRED: "REGENERATION_REQUIRED",
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

/**
 * A deterministic next action: the tool to call and why. Structured rather than
 * a prose string so the model branches on `tool` instead of parsing language.
 */
export interface McpNextAction {
  tool: string;
  reason?: string;
  arguments?: Record<string, unknown>;
}

export interface McpApplicationError {
  code: string;
  message: string;
  retryable: boolean;

  next_action?: McpNextAction;
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

/** @deprecated Alias kept for existing imports; use `McpApplicationError`. */
export type ToolErrorPayload = McpApplicationError;

export interface McpSuccess<T> {
  contract_version: string;
  analysis_version: string | null;
  ok: true;
  data: T;
  error: null;
}

export interface McpFailure {
  contract_version: string;
  analysis_version: string | null;
  ok: false;
  data: null;
  error: McpApplicationError;
}

export interface ToolResponse<T = Record<string, unknown>> {
  contract_version: string;
  analysis_version: string | null;
  ok: boolean;
  data: T | null;
  error: McpApplicationError | null;
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

// ---------------------------------------------------------------------------
// Canonical experience state
// ---------------------------------------------------------------------------

/**
 * The one canonical UX state. ChatGPT reads this instead of combining DNA,
 * analysis, regeneration, usability, and entitlement signals itself.
 */
export type ExperienceState =
  | "NO_DNA"
  | "PROCESSING_INITIAL"
  | "READY"
  | "READY_REFRESH_AVAILABLE"
  | "READY_REFRESH_PROCESSING"
  | "REFRESH_PROCESSING_NO_USABLE_ANALYSIS"
  | "PROCESSING_FAILED";

export type PendingAnalysisReason = "initial_analysis" | "platform_refresh" | "user_refresh";

/** The analysis that can be queried now. */
export interface ActiveAnalysisState {
  status: "none" | "ready";
  analysis_version?: string;
  generated_at?: string;
  scoring_engine_version?: string;
  usable: boolean;
}

/** A replacement analysis that may be processing or failed. */
export interface PendingAnalysisState {
  status: "processing" | "failed";
  reason: PendingAnalysisReason;
  target_scoring_engine_version?: string;
  started_at?: string;
  retry_after_seconds?: number;
  failure?: {
    code: string;
    message: string;
  };
}

/**
 * Authoritative action flags for the current experience state.
 * `can_query_analysis` is the single source of truth for whether the analytical
 * tools can answer; the model must never derive it from the other state objects.
 */
export interface AnalysisCapabilities {
  can_query_analysis: boolean;
  can_show_overview: boolean;
  can_refresh_analysis: boolean;
  can_search_hypotheses: boolean;
  can_explore_genetic_context: boolean;
}

/** Effective plan and scope for the connected account. */
export interface Entitlement {
  plan: AnalysisPlan;
  hypothesis_scope: "top_three" | "all";
  genetic_context_scope: "accessible_hypotheses" | "all_analyzed_markers";
  access_expires_at?: string;
}

export interface DnaStatusData {
  dna_status: "missing" | "available";
}

/**
 * The structured action bound to a suggested prompt. Rank is display metadata;
 * `hypothesis_id` is identity. The `analysis_version` pins the suggestion to the
 * snapshot it was rendered from.
 */
export interface PromptAction {
  analysis_version?: string;
  hypothesis_id?: string;
  intent?: string;
}

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
  action?: PromptAction;
}

/** The `get_analysis_status` payload. */
export interface AnalysisStatusData {
  dna_status: "missing" | "available";

  experience_state: ExperienceState;

  active_analysis: ActiveAnalysisState;

  pending_analysis: PendingAnalysisState | null;

  entitlement: Entitlement;

  capabilities: AnalysisCapabilities;

  next_action?: McpNextAction;

  suggested_prompts?: PromptSuggestion[];

  upgrade?: UpgradeOffer;
}

/** The `show_analysis_overview` payload, bound to one immutable snapshot. */
export interface ShowAnalysisOverviewData {
  ui_rendered: true;
  mode: "overview";
  displayed_analysis_version: string | null;
  displayed_hypotheses: Array<{
    id: string | null;
    rank: number;
    name: string;
  }>;
}

/** The `show_dna_import` payload. */
export interface DnaImportData {
  ui_rendered: true;
  mode: "initial" | "regenerate";
}

/** The `create_report` payload. */
export interface CreateReportData {
  analysis_id: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Scores, hypotheses, and interpretation
// ---------------------------------------------------------------------------

/** Effective plan for the connected account. */
export type AnalysisPlan = "mutant_free" | "mutant_full";

/**
 * The versioned, server-owned interpretation contract returned by
 * `get_analysis_context`. It supplies the analysis-specific guidance the model
 * needs to explain and present the overall experience; it is not per-hypothesis
 * prose and is never generated by an LLM.
 */
export interface InterpretationContract {
  version: "2.5";
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
    /** The canonical assessment semantics; authoritative over surface wording. */
    assessment?: string;
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
  /**
   * Which evidence units a Mutant explanation is built from, and the order they
   * must be presented in. Makes "modules before variants" machine-readable
   * rather than prose-only.
   */
  evidence_model: {
    primary_units: Array<"modules" | "patterns" | "variants">;
    preferred_explanation_order: Array<"modules" | "patterns" | "variants">;
  };
}

/**
 * Module-aware scoring-trace types for `explain_health_hypothesis`.
 *
 * These mirror the retained engine trace projected by the backend.
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

/**
 * The richer browse/search summary owned by `list_health_hypotheses` and reused
 * for the `get_analysis_context` preview.
 */
export interface HypothesisSummary {
  id: string | null;
  rank: number;
  name: string;
  summary: string;
  /** Ranking signal; not a disease probability or diagnostic confidence. */
  priority_score: number | null;
  /** Numeric genetic evidence support from Mutant's module and pattern scoring. */
  genetic_support: number | null;
  /** How well the genetic result is measured, independent of its direction. */
  genetic_confidence?: { score: number | null; level: string | null } | null;
  genetic_evidence: "weak" | "moderate" | "strong" | null;
  coverage_confidence: "low" | "moderate" | "high" | null;
  pattern_convergence: "weak" | "moderate" | "strong" | null;
}

/** One derived ranking driver for an explanation. */
export interface RankingDriver {
  component:
    | "priority_score"
    | "genetic_support"
    | "module_support"
    | "pattern_support"
    | "converging_pattern_adjustment";
  value: number | null;
  /** The published score-semantics sentence for this component. */
  semantics?: string;
}

/** The `explain_health_hypothesis` payload. */
export interface ExplainHypothesisData {
  hypothesis: {
    id: string | null;
    rank: number;
    name: string;
    assessment_state: string | null;
    scores: {
      priority: number | null;
      genetic_support: number | null;
      coverage: string | null;
      convergence: string | null;
    };
  };

  bottom_line: string | null;

  /** The assembled, module-first explanation of this hypothesis. */
  explanation?: {
    bottom_line?: string;
    why_ranked: string;
    interpretation_boundary?: string;
    top_contributing_patterns: Array<Record<string, unknown>>;
  };

  /** Engine-owned assessment; authoritative over surface wording. */
  assessment?: Record<string, unknown>;

  /** The assessment projected onto the score-breakdown vocabulary. */
  score_interpretation?: Record<string, unknown>;

  /**
   * Whether retained support is broad, mixed, or concentrated, with the
   * deterministic summary that justifies it.
   */
  evidence_shape: {
    support_distribution: "broad" | "mixed" | "concentrated";
    summary: string;
  };

  ranking_drivers: RankingDriver[];

  score_breakdown: ScoreBreakdown;

  support_architecture: SupportArchitecture;

  modules: ModuleContribution[];

  patterns: PatternContribution[];

  /** Patterns that are provisional rather than matched. */
  provisional_evidence: PatternContribution[];

  /** Separate priority-only family; never summed into module/pattern support. */
  converging_patterns: ConvergingPatternContribution[];

  /** Present when the hypothesis carries a curated or stored boundary. */
  interpretation_boundary?: string | null;

  strengthens_interpretation: string[];

  weakens_interpretation: string[];

  clinical_context?: Record<string, unknown>;
  confirmation?: Record<string, unknown>;
  guardrails?: string[];
  related_hypotheses?: Array<Record<string, unknown>>;
  suggested_prompts?: PromptSuggestion[];
}

/** Access scope of the current analysis. */
export interface AccessSummary {
  plan: AnalysisPlan;
  hypothesis_scope: "top_three" | "all";
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
export interface AnalysisContextData {
  interpretation: InterpretationContract;
  coverage: AnalysisCoverage;
  access: AccessSummary;
  preview: HypothesisSummary[];
  upgrade?: UpgradeOffer;
  suggested_prompts: PromptSuggestion[];
}

/** The `list_health_hypotheses` payload. */
export interface HypothesisListData {
  items: HypothesisSummary[];
  next_cursor: string | null;
  total_accessible?: number;
}

// ---------------------------------------------------------------------------
// Supporting evidence
// ---------------------------------------------------------------------------

/** `kind: "patterns"` item. */
export interface PatternEvidence {
  id: string | null;
  name: string | null;
  state: string | null;
  pattern_type?: string | null;
  contribution_status: "contributes" | "context_only" | "excluded" | string;
  impact_points?: number | null;
  coverage?: number | null;
  requires_clinical_confirmation?: boolean | null;
  summary?: string | null;
  marker_ids?: string[];
}

/** One pattern a marker participates in. */
export interface PatternMembership {
  pattern_id: string | null;
  pattern_name?: string | null;
  role?: string | null;
  pattern_state?: string | null;
  pattern_contributes?: boolean | null;
}

/** `kind: "variants"` item, and the marker row of `get_genetic_context`. */
export interface VariantEvidence {
  rsid: string;
  gene?: string | null;
  genotype?: string | null;
  call_state: "called" | "missing" | "unresolved";
  contribution_status: "contributes" | "no_score_contribution" | "not_scored" | "not_assessed";
  module_role?: {
    status: "contributes" | "no_score_contribution" | "not_scored" | "not_assessed";
    retained_contribution: number | null;
  };
  pattern_memberships: PatternMembership[];
}

/** A marker returned by `get_genetic_context`, deduped by rsID. */
export interface GeneticMarker extends VariantEvidence {
  module_id?: string | null;
  module_score_status?: string | null;
  status_reason?: string | null;
}

/** `kind: "modules"` item. */
export interface ModuleEvidence {
  module_id: string | null;
  module_name: string | null;
  scoring_status: string | null;
  hypothesis_role?: string | null;
  raw_module_score?: number | null;
  hypothesis_weight?: number | null;
  retained_support: number | null;
  module_support_fraction?: number | null;
  module_scoring_gene_count?: number;
  module_scoring_variant_count?: number;
  summary?: string | null;
  caveats?: string[];
  scoring_drivers?: Array<{
    rsid: string;
    gene?: string | null;
    module_contribution_status: string;
    retained_contribution: number | null;
    pattern_memberships?: PatternMembership[];
  }>;
  contextual_markers?: Array<Record<string, unknown>>;
}

/** `kind: "tests"` item. */
export interface TestEvidence {
  id: string | null;
  name: string | null;
  purpose?: string | null;
  interpretation_notes?: string[];
  limitations?: string[];
}

/** `kind: "sources"` item. */
export interface SourceEvidence {
  id: string | null;
  title: string | null;
  publisher_or_journal?: string | null;
  year?: number | string | null;
  type?: string | null;
  key_points?: string[];
  url?: string | null;
}

interface EvidencePageBase {
  next_cursor: string | null;
  source_state?: "not_provided";
}

export interface PatternEvidenceData extends EvidencePageBase {
  kind: "patterns";
  items: PatternEvidence[];
}

export interface VariantEvidenceData extends EvidencePageBase {
  kind: "variants";
  items: VariantEvidence[];
}

export interface ModuleEvidenceData extends EvidencePageBase {
  kind: "modules";
  items: ModuleEvidence[];
}

export interface SourceEvidenceData extends EvidencePageBase {
  kind: "sources";
  items: SourceEvidence[];
}

export interface TestEvidenceData extends EvidencePageBase {
  kind: "tests";
  items: TestEvidence[];
}

/** Discriminated on `kind` so the response is self-describing. */
export type SupportingEvidenceData =
  | PatternEvidenceData
  | VariantEvidenceData
  | ModuleEvidenceData
  | SourceEvidenceData
  | TestEvidenceData;

export type EvidenceKind = SupportingEvidenceData["kind"];

/** The `get_genetic_context` payload. */
export interface GeneticContextData {
  markers: GeneticMarker[];
  modules?: ModuleEvidence[];
  next_cursor: string | null;
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
