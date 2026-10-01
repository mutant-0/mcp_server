import type { MutantUserContext } from "../src/auth/user-context.js";
import type { MutantBackendClient } from "../src/clients/mutant-lambda-client.js";
import type { AppConfig } from "../src/config.js";
import {
  CONTRACT_VERSION,
  type BackendOperation,
  type ToolResponse,
} from "../src/contract.js";
import { createLogger, type AppLogger, type LogSink } from "../src/logger.js";

/** URI-form scopes for the test resource (derived from MUTANT_MCP_RESOURCE_URI). */
export const ANALYSIS_SCOPE = "https://mcp.mutantgenomics.com/mcp/analysis.read";
export const DNA_SCOPE = "https://mcp.mutantgenomics.com/mcp/dna.import";

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    MUTANT_SERVICE_LAMBDA_ARN: "",
    MUTANT_OAUTH_ISSUER: "https://auth.mutantgenomics.com",
    MUTANT_OAUTH_AUDIENCE: "",
    MUTANT_OAUTH_CLIENT_ID: "",
    // Empty exercises the derived `<resource>/analysis.read` scope, matching
    // production (where the Cognito resource-server identifier is the resource URI).
    MUTANT_OAUTH_SCOPE: "",
    // Empty exercises the derived `<resource>/dna.import` scope.
    MUTANT_OAUTH_SCOPE_DNA_IMPORT: "",
    MUTANT_MCP_RESOURCE_URI: "https://mcp.mutantgenomics.com/mcp",
    MUTANT_CORS_ORIGINS: "https://chatgpt.com",
    MUTANT_PLAN_INFO_URL: "https://mutantgenomics.com/plans",
    MUTANT_ONBOARDING_URL: "https://mutantgenomics.com/onboarding",
    MUTANT_CONSENT_URL: "https://mutantgenomics.com/consent",
    MUTANT_REQUEST_TIMEOUT_MS: 5000,
    MUTANT_MAX_RESPONSE_BYTES: 512000,
    MUTANT_SNP_CATALOG_MAX_BYTES: 2000000,
    MUTANT_MAX_REQUEST_BYTES: 5 * 1024 * 1024,
    MUTANT_DEV_MODE: true,
    MUTANT_TRACE_CAPTURE: false,
    MUTANT_TRACE_CAPTURE_ID: "",
    LOG_LEVEL: "silent",
    ...overrides,
  };
}

export function makeUser(overrides: Partial<MutantUserContext> = {}): MutantUserContext {
  return {
    userId: "user-1",
    // A fully-authorized connection, matching the `dev-free`/`dev-paid` dev tokens.
    scopes: [ANALYSIS_SCOPE, DNA_SCOPE],
    ...overrides,
  };
}

/** Capture structured log records for assertions about what was (not) logged. */
export function makeCapturingLogger(): {
  logger: AppLogger;
  records: () => Array<Record<string, unknown>>;
  text: () => string;
} {
  const lines: string[] = [];
  const sink: LogSink = {
    write(chunk: string) {
      lines.push(chunk);
    },
  };
  const logger = createLogger("info", sink);
  return {
    logger,
    records: () =>
      lines
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    text: () => lines.join(""),
  };
}

export function makeSuccessResponse(
  data: Record<string, unknown> = { ok: true },
  analysisVersion = "rev42-v3.0.0",
): ToolResponse {
  return {
    contract_version: CONTRACT_VERSION,
    analysis_version: analysisVersion,
    ok: true,
    data,
    error: null,
  };
}

export function makeErrorResponse(
  code: string,
  message = "error",
  extra: Partial<ToolResponse["error"]> = {},
): ToolResponse {
  return {
    contract_version: CONTRACT_VERSION,
    analysis_version: null,
    ok: false,
    data: null,
    error: { code, message, retryable: false, ...extra },
  };
}

export interface RecordedCall {
  operation: BackendOperation;
  arguments: Record<string, unknown>;
  userId: string;
  requestId: string;
}

/** Deterministic backend stub that records invocations. */
export class StubBackendClient implements MutantBackendClient {
  readonly calls: RecordedCall[] = [];

  constructor(
    private readonly responder: (
      operation: BackendOperation,
      args: Record<string, unknown>,
    ) => ToolResponse,
  ) {}

  async invoke(
    operation: BackendOperation,
    args: Record<string, unknown>,
    ctx: MutantUserContext,
    requestId: string,
  ): Promise<ToolResponse> {
    this.calls.push({ operation, arguments: args, userId: ctx.userId, requestId });
    return this.responder(operation, args);
  }
}

/** A complete, valid 3.0.0 `get_analysis_status` data payload for tests. */
export function makeStatusData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dna_status: "available",
    experience_state: "READY",
    active_analysis: {
      status: "ready",
      analysis_version: "rev42-v3.0.0",
      generated_at: "2026-01-01T00:00:00Z",
      scoring_engine_version: "v3.0.0",
      usable: true,
    },
    pending_analysis: null,
    entitlement: {
      plan: "mutant_full",
      hypothesis_scope: "all",
      genetic_context_scope: "all_analyzed_markers",
    },
    capabilities: {
      can_query_analysis: true,
      can_show_overview: true,
      can_refresh_analysis: false,
      can_search_hypotheses: true,
      can_explore_genetic_context: true,
    },
    ...overrides,
  };
}

/** The 2.6 interpretation contract, matching `report-generator/mcp/interpretation.py`. */
export function makeInterpretation(): Record<string, unknown> {
  return {
    version: "2.6",
    purpose:
      "Mutant returns ranked, genetically supported health hypotheses for exploration and clinical discussion, not diagnoses.",
    response_rules: [
      "Lead with the plain-English meaning.",
      "Distinguish genetic susceptibility from a current condition.",
    ],
    evidence_explanation_rules: {
      organizing_level: "modules_then_patterns_then_variants",
      rules: [
        "Explain contributing biological modules before individual genes or variants.",
        "Count only actual score contributors when describing module breadth.",
      ],
      module_first_instruction:
        "Explain a finding by its contributing modules first, then retained cross-module patterns, then the individual genes and variants.",
    },
    score_semantics: {
      priority_score: "The ordering score; not disease probability.",
      genetic_support: "Strength of genetic support within the analyzed evidence.",
      assessment:
        "The canonical explanation of this hypothesis result, authoritative over surface wording.",
      genetic_evidence: "The weak/moderate/strong evidence category.",
      genetic_confidence: "How well the genetic result is measured.",
      coverage_confidence: "How completely the relevant markers were assessed.",
      marker_coverage: "Marker-call completeness scope, distinct from coverage_confidence.",
      assessability: "Whether the hypothesis could be evaluated: assessed, partial, or not_assessable.",
      pattern_convergence: "How strongly independent patterns agree.",
      module_support: "Support contributed by score-eligible variants through modules.",
      pattern_support: "Additional retained support from a defined combination of variants.",
    },
    evidence_boundaries: {
      genetics_is_not_diagnosis: true,
      genetic_support_does_not_establish_current_status: true,
      clinical_correlation_is_catalog_guidance: true,
      clinical_correlation_is_not_user_record_evidence: true,
    },
    health_context_usage: {
      allowed: true,
      performed_by: "chatgpt",
      sent_to_mutant: false,
      purpose: "relevance_filtering",
    },
    presentation_order: [
      "bottom_line",
      "support_architecture",
      "module_contributions",
      "pattern_contributions",
      "key_scoring_genes_and_variants",
      "interpretation_boundary",
      "minimal_confirmation",
      "strengthening_and_weakening_evidence",
      "action_changing_guardrail",
    ],
    evidence_model: {
      primary_units: ["modules", "patterns", "variants"],
      preferred_explanation_order: ["modules", "patterns", "variants"],
    },
    limitations: ["Not a diagnosis."],
  };
}

/** A minimal valid `get_analysis_context` payload. */
export function makeContextData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    interpretation: makeInterpretation(),
    coverage: { analyzed_markers: 1000 },
    access: {
      plan: "mutant_full",
      hypothesis_scope: "all",
      total_ranked: 1,
      returned: 1,
      unlocked: 1,
      locked: 0,
      scope_message:
        "Your complete ranked analysis is available. This response previews the top three; use hypothesis search or listing to explore the rest.",
    },
    preview: [makeHypothesisSummary()],
    ...overrides,
  };
}

/** A minimal valid `show_analysis_followups` payload. */
export function makeFollowupsData(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ui_rendered: true,
    mode: "followups",
    intent: "explanation",
    plan: "mutant_free",
    displayed_analysis_version: "rev42-v3.0.0",
    displayed_hypotheses: [{ id: "HYP_A", rank: 1, name: "Alpha finding" }],
    actions: [
      {
        id: "why-ranked",
        label: "Why this rank?",
        prompt: "Why did my \"Alpha finding\" finding rank where it did?",
        heading: "Mutant follow-up: Why \"Alpha finding\" ranked",
        intent: "explain",
        hypothesis_id: "HYP_A",
        action: {
          analysis_version: "rev42-v3.0.0",
          hypothesis_id: "HYP_A",
          intent: "explain",
        },
      },
      {
        id: "compare-with-history",
        label: "Compare with my history",
        prompt:
          "Which of my top three Mutant findings seems most relevant to the health history I've shared? If I have not shared any health history, ask me what I want to share before comparing.",
        heading: "Mutant follow-up: Compare with my history",
        intent: "comparison",
        hypothesis_id: "HYP_A",
        action: {
          analysis_version: "rev42-v3.0.0",
          hypothesis_id: "HYP_A",
          intent: "comparison",
        },
      },
    ],
    ...overrides,
  };
}

/** A minimal valid `HypothesisSummary`. */
export function makeHypothesisSummary(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "HYP_A",
    rank: 1,
    name: "Alpha finding",
    summary: "First summary.",
    priority_score: 90,
    genetic_support: 72,
    genetic_evidence: "strong",
    coverage_confidence: "high",
    pattern_convergence: "strong",
    ...overrides,
  };
}

/** A minimal valid `explain_health_hypothesis` payload. */
export function makeDetailsData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hypothesis: {
      id: "HYP_A",
      rank: 1,
      name: "Alpha finding",
      assessment_state: "assessed",
      scores: {
        priority: 90,
        genetic_support: 72,
        genetic_confidence: { score: 90, level: "high" },
        coverage: "high",
        convergence: "strong",
      },
    },
    bottom_line: "Alpha finding is a moderate signal.",
    explanation: {
      bottom_line: "Alpha finding is a moderate signal.",
      why_ranked:
        "It ranked #1 on priority score, which reflects strong genetic support, module support and retained pattern support; priority orders findings and is not a disease probability.",
      interpretation_boundary: "This is not a diagnosis.",
      top_contributing_patterns: [],
    },
    score_interpretation: {
      status: "qualifying_match",
      summary: "A qualifying genetic result was detected.",
      marker_coverage: {
        called: 12,
        total: 14,
        level: "partial",
        missing_markers: ["rs1", "rs2"],
      },
      measurement_coverage: "high",
      marker_call_incomplete: true,
      assessability: "assessed",
      data_gap_effect:
        "The qualifying result stands; the uncalled markers limit completeness but do not change its direction.",
    },
    evidence_shape: {
      support_distribution: "concentrated",
      summary: "Support is concentrated in a single locus.",
    },
    ranking_drivers: [{ component: "priority_score", value: 90 }],
    score_breakdown: {
      priority_score: 90,
      genetic_support: 72,
      module_support: 40,
      pattern_support: 32,
      converging_pattern_adjustment: 5,
    },
    support_architecture: {
      classification: "single_locus",
      summary: "Support is concentrated in a single locus.",
    },
    modules: [
      {
        module_id: "histamine",
        module_name: "Histamine",
        scoring_status: "active",
        role: "primary",
        retained_support: 40,
        module_scoring_gene_count: 1,
        module_scoring_variant_count: 1,
        top_scoring_genes: ["HNMT"],
        summary: "Histamine contributed 40 support points.",
        caveats: [],
      },
    ],
    patterns: [
      {
        pattern_id: "PAT_A",
        pattern_name: "Pattern A",
        state: "matched",
        retained_support: 32,
        module_ids: ["histamine"],
        participating_gene_count: 2,
        participating_variant_count: 2,
        summary: "Retained matched pattern with 2 contributing variants.",
      },
    ],
    provisional_evidence: [],
    converging_patterns: [],
    clinical_context: {
      common_cofactors: [],
      common_confusers: [],
      subtypes: [],
      source: "catalog_general",
    },
    confirmation: { primary_checks: [] },
    guardrails: [],
    guardrails_source: "catalog_general",
    ...overrides,
  };
}

/**
 * A minimal valid `data` payload for any backend operation, so a permissive
 * stub never trips the tool's own output schema.
 */
export function defaultBackendData(operation: BackendOperation): Record<string, unknown> {
  switch (operation) {
    case "resolve_analysis_snapshot":
    case "show_analysis_overview":
      return {
        displayed_analysis_version: "rev42-v3.0.0",
        displayed_hypotheses: [{ id: "HYP_A", rank: 1, name: "Alpha finding" }],
        total_accessible_count: 1,
        has_more: false,
      };
    case "get_analysis_status":
    case "poll_analysis_status":
      return makeStatusData();
    case "get_analysis_context":
      return makeContextData();
    case "list_health_hypotheses":
      return { items: [makeHypothesisSummary()] };
    case "explain_health_hypothesis":
      return makeDetailsData();
    case "get_supporting_evidence":
      return { kind: "patterns", items: [] };
    case "get_genetic_context":
      return { markers: [] };
    case "get_snp_catalog":
      return { version: 7, snp_count: 0, snps: {} };
    case "show_dna_import":
      return { ui_rendered: true, mode: "initial" };
    case "create_report":
      return { analysis_id: "analysis_test", status: "processing" };
    case "resolve_analysis_followups":
    case "show_analysis_followups":
      return makeFollowupsData();
  }
}

/** A complete success envelope whose `data` validates for the given operation. */
export function makeToolResponse(operation: BackendOperation): ToolResponse {
  return makeSuccessResponse(defaultBackendData(operation));
}
