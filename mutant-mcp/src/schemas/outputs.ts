import { z } from "zod";

/**
 * Concrete per-tool `data` schemas for the 3.0.0 contract.
 *
 * The purpose is to stop the model (and the Apps SDK card) from guessing at
 * response shapes: every tool's `data` is a typed object, every stable
 * vocabulary is an enum, and fields whose names invite misinterpretation carry
 * a `.describe()` that is part of the machine-readable schema.
 *
 * These are the transport mirror of `report-generator/mcp/projection.py`. Every
 * object schema is loose: the backend owns the payload, so an additive
 * backend-only field must never fail output validation or be dropped.
 */

export const nextActionSchema = z.looseObject({
  tool: z.string().describe("Name of the tool to call next."),
  reason: z.string().optional().describe("Why that tool should be called."),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

export const errorOutputSchema = z.looseObject({
  code: z.string().describe("Stable contract error code."),
  message: z.string(),
  retryable: z.boolean(),
  next_action: nextActionSchema.optional(),
  required_plan: z.string().optional(),
  upgrade_url: z.string().optional(),
  retry_after_seconds: z.number().optional(),
  required_scope: z.string().optional(),
  app_code: z.string().optional(),
  reason: z.string().optional().describe("Readiness diagnostic for an unservable analysis."),
});

export const experienceStateSchema = z
  .enum([
    "NO_DNA",
    "PROCESSING_INITIAL",
    "READY",
    "READY_REFRESH_AVAILABLE",
    "READY_REFRESH_PROCESSING",
    "REFRESH_PROCESSING_NO_USABLE_ANALYSIS",
    "PROCESSING_FAILED",
  ])
  .describe(
    "The one canonical experience state. Do not re-derive it from dna_status, active_analysis, or pending_analysis.",
  );

export const activeAnalysisSchema = z.looseObject({
  status: z.enum(["none", "ready"]),
  analysis_version: z.string().optional(),
  generated_at: z.string().optional(),
  scoring_engine_version: z.string().optional(),
  usable: z.boolean().describe("Whether the analytical tools can answer from this analysis."),
});

export const pendingAnalysisSchema = z.looseObject({
  status: z.enum(["processing", "failed"]),
  reason: z.enum(["initial_analysis", "platform_refresh", "user_refresh"]),
  target_scoring_engine_version: z.string().optional(),
  started_at: z.string().optional(),
  retry_after_seconds: z.number().optional(),
  failure: z.looseObject({ code: z.string(), message: z.string() }).optional(),
});

export const capabilitiesSchema = z.looseObject({
  can_query_analysis: z
    .boolean()
    .describe("Authoritative: whether the analytical tools can answer right now."),
  can_show_overview: z.boolean(),
  can_refresh_analysis: z.boolean(),
  can_search_hypotheses: z.boolean(),
  can_explore_genetic_context: z.boolean(),
});

export const entitlementSchema = z.looseObject({
  plan: z.enum(["mutant_free", "mutant_full"]),
  hypothesis_scope: z.enum(["top_three", "all"]),
  genetic_context_scope: z.enum(["accessible_hypotheses", "all_analyzed_markers"]),
  access_expires_at: z.string().optional(),
});

export const upgradeOfferSchema = z.looseObject({
  label: z.string(),
  url: z.string(),
});

export const promptSuggestionSchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  prompt: z.string(),
  intent: z.enum([
    "overview",
    "explain",
    "evidence",
    "confirmation",
    "comparison",
    "clinician_questions",
    "regeneration",
    "import_help",
  ]),
  hypothesis_id: z.string().optional(),
  action: z
    .looseObject({
      analysis_version: z.string().optional(),
      hypothesis_id: z.string().optional(),
      intent: z.string().optional(),
    })
    .optional(),
});

export const analysisStatusDataSchema = z.looseObject({
  dna_status: z.enum(["missing", "available"]),
  experience_state: experienceStateSchema,
  active_analysis: activeAnalysisSchema,
  pending_analysis: pendingAnalysisSchema.nullable(),
  entitlement: entitlementSchema,
  capabilities: capabilitiesSchema,
  next_action: nextActionSchema.optional(),
  suggested_prompts: z.array(promptSuggestionSchema).optional(),
  upgrade: upgradeOfferSchema.optional(),
});

const interpretationSchema = z.looseObject({
  version: z.literal("2.6"),
  purpose: z.string(),
  response_rules: z.array(z.string()),
  evidence_explanation_rules: z.looseObject({
    organizing_level: z.literal("modules_then_patterns_then_variants"),
    rules: z.array(z.string()),
    module_first_instruction: z.string(),
  }),
  score_semantics: z.looseObject({
    priority_score: z.string(),
    genetic_support: z.string(),
    assessment: z.string().optional(),
    genetic_evidence: z.string(),
    genetic_confidence: z.string(),
    coverage_confidence: z.string(),
    marker_coverage: z
      .string()
      .optional()
      .describe("Marker-call completeness scope, distinct from coverage_confidence."),
    assessability: z
      .string()
      .optional()
      .describe("Whether the hypothesis could be evaluated: assessed, partial, or not_assessable."),
    pattern_convergence: z.string(),
    module_support: z.string(),
    pattern_support: z.string(),
  }),
  evidence_boundaries: z.record(z.string(), z.literal(true)),
  health_context_usage: z.looseObject({
    allowed: z.literal(true),
    performed_by: z.literal("chatgpt"),
    sent_to_mutant: z.literal(false),
    purpose: z.string().optional(),
  }),
  presentation_order: z.array(z.string()),
  limitations: z.array(z.string()),
  evidence_model: z
    .looseObject({
      primary_units: z.array(z.enum(["modules", "patterns", "variants"])),
      preferred_explanation_order: z.array(z.enum(["modules", "patterns", "variants"])),
    })
    .describe("The evidence units Mutant explanations are built from, in presentation order."),
});

export const geneticConfidenceSchema = z
  .looseObject({
    score: z
      .number()
      .nullable()
      .describe(
        "How well the result is measured (0-100), independent of direction. Zero means nothing relevant was measured; null means the confidence object was present but the score was not calculated.",
      ),
    level: z
      .string()
      .nullable()
      .describe(
        "Engine confidence band for score: typically strong | moderate | limited (MCP contract maps the engine's weaker band to 'low' where applicable).",
      ),
  })
  .nullable()
  .describe(
    "The single canonical genetic-confidence value. Absent (field undefined) means the engine exposed no confidence object; null means it was explicitly not calculated; a present object with score 0 means a result was measured and measured as zero. Never a bare number or string.",
  );

export const hypothesisSummarySchema = z.looseObject({
  id: z.string().nullable(),
  rank: z.number().int(),
  name: z.string(),
  summary: z.string(),
  priority_score: z
    .number()
    .nullable()
    .describe(
      "Ranking signal used to order hypotheses. Not disease probability, not a diagnostic confidence, and not comparable across analyses.",
    ),
  genetic_support: z
    .number()
    .nullable()
    .describe(
      "Strength of genetic support within the analyzed evidence. Null means no value was calculated; zero is a calculated value that did not qualify.",
    ),
  genetic_confidence: geneticConfidenceSchema.optional(),
  genetic_evidence: z
    .string()
    .nullable()
    .describe(
      "The user-facing weak/moderate/strong evidence category. Null means it was not calculated.",
    ),
  coverage_confidence: z
    .string()
    .nullable()
    .describe("How completely relevant markers were called. High coverage can coexist with zero support. Null means it was not calculated."),
  pattern_convergence: z.string().nullable(),
});

export const accessSummarySchema = z.looseObject({
  plan: z.enum(["mutant_free", "mutant_full"]),
  hypothesis_scope: z.enum(["top_three", "all"]),
  total_ranked: z.number().int(),
  returned: z.number().int(),
  unlocked: z.number().int(),
  locked: z.number().int(),
  scope_message: z.string(),
});

export const analysisContextDataSchema = z.looseObject({
  interpretation: interpretationSchema,
  coverage: z.looseObject({
    analyzed_markers: z.number().nullable(),
    classification: z.string().optional(),
  }),
  access: accessSummarySchema,
  preview: z.array(hypothesisSummarySchema),
  upgrade: upgradeOfferSchema.optional(),
  suggested_prompts: z.array(promptSuggestionSchema),
});

export const searchScopeSchema = z.looseObject({
  hypothesis_scope: z
    .enum(["top_three", "all"])
    .describe(
      "Ranked hypotheses the search actually reached: Free searches the accessible top_three, Full searches all.",
    ),
  searched_count: z
    .number()
    .int()
    .optional()
    .describe("Ranked hypotheses the search reached. Omitted only when unavailable."),
  total_ranked_count: z.number().int().optional(),
  unsearched_ranked_count: z
    .number()
    .int()
    .optional()
    .describe("Ranked hypotheses the current plan could not search."),
  query_outcome: z
    .enum(["no_match_in_accessible_scope", "no_match_in_ranked_search_fields"])
    .optional()
    .describe(
      "Set only for a nonempty catalog-topic query whose first page has zero matches across the applicable scope; absent for an unfiltered list or an empty later page. A Free no_match_in_accessible_scope never implies the topic is absent from the locked ranked set.",
    ),
  broader_ranked_search_available: z
    .boolean()
    .describe("True only when Free has locked findings a wider search could reach."),
});

export const hypothesisListDataSchema = z.looseObject({
  items: z.array(hypothesisSummarySchema),
  next_cursor: z.string().nullable().optional(),
  total_accessible: z.number().int().optional(),
  search_scope: searchScopeSchema
    .optional()
    .describe("Entitlement-bounded scope the search actually covered, authored by the server."),
});

const patternContributionSchema = z.looseObject({
  pattern_id: z.string().nullable(),
  pattern_name: z.string().nullable(),
  state: z.string().nullable(),
  retained_support: z.number().nullable(),
  module_ids: z.array(z.string()),
  participating_gene_count: z
    .number()
    .int()
    .describe("Genes participating in this pattern only; not the hypothesis-level aggregate."),
  participating_variant_count: z
    .number()
    .int()
    .describe(
      "Variants participating in this pattern only. A one-of-three OR group may contribute a single variant here, while support_architecture.pattern_participating_variant_count aggregates across retained patterns.",
    ),
  summary: z.string().nullable(),
});

const moduleContributionSchema = z.looseObject({
  module_id: z.string().nullable(),
  module_name: z.string().nullable(),
  scoring_status: z.string().nullable(),
  role: z.string().nullable(),
  retained_support: z.number().nullable(),
  module_support_fraction: z.number().nullable().optional(),
  module_scoring_gene_count: z.number().int(),
  module_scoring_variant_count: z.number().int(),
  top_scoring_genes: z.array(z.string()),
  summary: z.string().nullable(),
  caveats: z.array(z.string()),
});

export const explainHypothesisDataSchema = z.looseObject({
  hypothesis: z.looseObject({
    id: z.string().nullable(),
    rank: z.number().int(),
    name: z.string(),
    assessment_state: z.string().nullable(),
    scores: z.looseObject({
      priority: z.number().nullable(),
      genetic_support: z.number().nullable(),
      genetic_confidence: geneticConfidenceSchema.optional(),
      coverage: z
        .string()
        .nullable()
        .describe(
          "Engine measurement-completeness scope. The marker-call scope is score_interpretation.marker_coverage; the two are distinct.",
        ),
      convergence: z.string().nullable(),
    }),
  }),
  bottom_line: z.string().nullable().optional(),
  evidence_shape: z
    .looseObject({
      support_distribution: z.enum(["broad", "mixed", "concentrated"]),
      summary: z.string().nullable(),
    })
    .optional(),
  ranking_drivers: z
    .array(
      z.looseObject({
        component: z.enum([
          "priority_score",
          "genetic_support",
          "module_support",
          "pattern_support",
          "converging_pattern_adjustment",
        ]),
        value: z.number().nullable(),
        semantics: z.string().optional(),
      }),
    )
    .optional(),
  explanation: z.looseObject({
    bottom_line: z.string().optional(),
    why_ranked: z.string(),
    interpretation_boundary: z.string().optional(),
    top_contributing_patterns: z.array(z.record(z.string(), z.unknown())),
  }),
  score_breakdown: z.looseObject({
    priority_score: z.number().nullable(),
    genetic_support: z.number().nullable(),
    module_support: z.number().nullable(),
    pattern_support: z.number().nullable(),
    converging_pattern_adjustment: z.number().nullable(),
  }),
  score_interpretation: z.record(z.string(), z.unknown()).optional(),
  assessment: z.record(z.string(), z.unknown()).optional(),
  support_architecture: z.looseObject({
    classification: z.string(),
    contributing_module_count: z.number().int().optional(),
    module_scoring_gene_count: z.number().int().optional(),
    module_scoring_variant_count: z.number().int().optional(),
    pattern_participating_gene_count: z
      .number()
      .int()
      .optional()
      .describe(
        "Aggregate count of unique genes participating in any retained pattern. Each patterns[] row counts only that pattern, so the two scopes differ.",
      ),
    pattern_participating_variant_count: z
      .number()
      .int()
      .optional()
      .describe(
        "Aggregate count of unique variants participating in any retained pattern. A one-of-three match contributes one variant here, while patterns[].participating_variant_count also counts only that pattern.",
      ),
    dominant_driver: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "The dominant driver. When it is a pattern it also carries that pattern's own participating_gene_count and participating_variant_count, distinct from the hypothesis-level pattern_participating_*_count aggregate.",
      ),
    summary: z.string().nullable(),
  }),
  modules: z.array(moduleContributionSchema),
  patterns: z.array(patternContributionSchema),
  provisional_evidence: z.array(patternContributionSchema),
  converging_patterns: z.array(
    z.looseObject({
      pattern_id: z.string().nullable(),
      state: z.string().nullable(),
      structural_fit: z.number().nullable(),
      pattern_confidence: z.number().nullable(),
      contribution: z.number().nullable(),
    }),
  ),
  clinical_context: z.record(z.string(), z.unknown()).optional(),
  confirmation: z.record(z.string(), z.unknown()).optional(),
  guardrails: z.array(z.string()).optional(),
  guardrails_source: z
    .literal("catalog_general")
    .optional()
    .describe(
      "Marks guardrails as general catalog caution, never a statement about the user's history or reactions.",
    ),
  related_hypotheses: z.array(z.record(z.string(), z.unknown())).optional(),
  strengthens_interpretation: z.array(z.string()).optional(),
  weakens_interpretation: z.array(z.string()).optional(),
  suggested_prompts: z.array(promptSuggestionSchema).optional(),
});

const patternMembershipSchema = z.looseObject({
  pattern_id: z.string().nullable(),
  pattern_name: z.string().optional(),
  role: z.string().optional().describe("This marker's role in the pattern (e.g. core, supporting, context)."),
  pattern_state: z.string().optional(),
  pattern_contributes: z.boolean().optional(),
});

const variantEvidenceSchema = z.looseObject({
  rsid: z.string(),
  gene: z.string().nullable().optional(),
  genotype: z.string().nullable().optional(),
  call_state: z
    .enum(["called", "missing", "unresolved"])
    .describe(
      "Whether a genotype was called. 'missing' means the marker is in the catalog but no call was stored; 'unresolved' means it was not in the analyzed catalog.",
    ),
  contribution_status: z
    .enum(["contributes", "context_only", "excluded", "no_score_contribution", "not_scored", "not_assessed"])
    .describe("Whether this marker adds score support. 'context_only' and 'excluded' do not."),
  module_role: z
    .looseObject({
      status: z.string(),
      retained_contribution: z.number().nullable(),
    })
    .optional(),
  pattern_memberships: z.array(patternMembershipSchema),
});

const patternEvidenceSchema = z.looseObject({
  id: z.string().nullable(),
  name: z.string().nullable(),
  state: z.string().nullable(),
  pattern_type: z.string().nullable().optional(),
  contribution_status: z.string(),
  impact_points: z.number().nullable().optional(),
  coverage: z
    .number()
    .nullable()
    .optional()
    .describe(
      "Legacy numeric alias of required-group coverage (groups with data / total groups), not marker-call completeness. Use required_group_coverage and marker_call_coverage for the explicit scopes.",
    ),
  requires_clinical_confirmation: z.boolean().nullable().optional(),
  summary: z.string().nullable().optional(),
  marker_ids: z
    .array(z.string())
    .optional()
    .describe("Legacy alias of listed_marker_ids: every marker the pattern defines, including uncalled ones."),
  required_group_coverage: z
    .looseObject({ with_data: z.number().int(), total: z.number().int() })
    .nullable()
    .optional()
    .describe("Required-logic scope: how many declared core/support groups had any tested data."),
  core_groups_matched: z.number().int().nullable().optional(),
  core_groups_required: z.number().int().nullable().optional(),
  match_rule: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe(
      "How the pattern's requirement groups combine. logic 'any_of' is a single core group satisfied by any one qualifying alternative; 'core_groups' is any other composition reported as counts only.",
    ),
  match_rule_summary: z
    .string()
    .nullable()
    .optional()
    .describe("One plain-language sentence for the pattern's requirement rule."),
  marker_call_coverage: z
    .looseObject({ called: z.number().int(), total: z.number().int() })
    .nullable()
    .optional()
    .describe(
      "Raw call scope over the pattern's listed markers: contributing and called non-risk count as called; a not_found marker is missing.",
    ),
  listed_marker_ids: z.array(z.string()).optional(),
  contributing_marker_ids: z.array(z.string()).optional(),
  called_non_risk_marker_ids: z
    .array(z.string())
    .optional()
    .describe("Called markers whose genotype was non-risk, kept distinct from contributors."),
  missing_marker_ids: z
    .array(z.string())
    .optional()
    .describe("Listed markers with no stored call; never treated as a non-risk genotype."),
  match_explanation: z
    .string()
    .nullable()
    .optional()
    .describe("Genetics-only sentence stating the one-of-N rule and the two coverage scopes; never claims full marker coverage or convergence."),
});

const moduleEvidenceSchema = z.looseObject({
  module_id: z.string().nullable(),
  module_name: z.string().nullable(),
  scoring_status: z.string().nullable(),
  hypothesis_role: z.string().nullable().optional(),
  raw_module_score: z.number().nullable().optional(),
  hypothesis_weight: z.number().nullable().optional(),
  retained_support: z.number().nullable(),
  module_support_fraction: z.number().nullable().optional(),
  module_scoring_gene_count: z.number().int().optional(),
  module_scoring_variant_count: z.number().int().optional(),
  summary: z.string().nullable().optional(),
  caveats: z.array(z.string()).optional(),
  scoring_drivers: z.array(z.record(z.string(), z.unknown())).optional(),
  contextual_markers: z.array(z.record(z.string(), z.unknown())).optional(),
});

const testEvidenceSchema = z.looseObject({
  id: z.string().nullable(),
  name: z.string().nullable(),
  purpose: z.string().nullable().optional(),
  interpretation_notes: z.array(z.string()).optional(),
  limitations: z.array(z.string()).optional(),
});

const sourceEvidenceSchema = z.looseObject({
  id: z.string().nullable(),
  title: z.string().nullable(),
  publisher_or_journal: z.string().nullable().optional(),
  year: z.union([z.number(), z.string()]).nullable().optional(),
  type: z.string().nullable().optional(),
  key_points: z.array(z.string()).optional(),
  url: z.string().nullable().optional(),
});

const evidencePage = {
  next_cursor: z.string().nullable().optional(),
  source_state: z.enum(["not_provided"]).optional(),
};

export const supportingEvidenceDataSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("patterns"), items: z.array(patternEvidenceSchema), ...evidencePage }),
  z.looseObject({ kind: z.literal("variants"), items: z.array(variantEvidenceSchema), ...evidencePage }),
  z.looseObject({ kind: z.literal("modules"), items: z.array(moduleEvidenceSchema), ...evidencePage }),
  z.looseObject({ kind: z.literal("sources"), items: z.array(sourceEvidenceSchema), ...evidencePage }),
  z.looseObject({ kind: z.literal("tests"), items: z.array(testEvidenceSchema), ...evidencePage }),
]);

export const geneticMarkerSchema = variantEvidenceSchema.extend({
  module_id: z.string().nullable().optional(),
  module_score_status: z.string().nullable().optional(),
  status_reason: z.string().nullable().optional(),
});

export const geneticContextDataSchema = z.looseObject({
  markers: z.array(geneticMarkerSchema),
  modules: z.array(moduleEvidenceSchema).optional(),
  next_cursor: z.string().nullable().optional(),
});

export const dnaImportDataSchema = z.looseObject({
  ui_rendered: z.literal(true),
  mode: z.enum(["initial", "regenerate"]),
});

export const snpCatalogDataSchema = z.looseObject({
  version: z.union([z.number(), z.string()]).optional(),
  snp_count: z.number().optional(),
  snps: z.record(z.string(), z.unknown()),
  // The catalog carries additional backend-maintained metadata (aliases,
  // reference alleles, provenance) that the component passes through untouched.
});

export const createReportDataSchema = z.looseObject({
  analysis_id: z.string(),
  status: z.string(),
});

export const showAnalysisOverviewDataSchema = z.looseObject({
  ui_rendered: z.literal(true),
  mode: z.literal("overview"),
  displayed_analysis_version: z
    .string()
    .nullable()
    .describe("The exact analysis revision this card displays. Pass it back on follow-ups."),
  displayed_hypotheses: z.array(
    z.looseObject({
      id: z.string().nullable(),
      rank: z.number().int(),
      name: z.string(),
    }),
  ),
});

/**
 * The `show_analysis_followups` payload. The card is navigation only: a context
 * label, at most two actions bound to the displayed hypothesis ids and revision,
 * and - Free only - an upgrade offer. It never carries the generated answer, the
 * user's health history, or any evidence rows.
 */
export const showAnalysisFollowupsDataSchema = z.looseObject({
  ui_rendered: z.literal(true),
  mode: z.literal("followups"),
  intent: z.enum(["explanation", "comparison"]),
  plan: z
    .enum(["mutant_free", "mutant_full"])
    .describe("Decides between the quiet Full route and the search-all hint."),
  displayed_analysis_version: z
    .string()
    .nullable()
    .describe("The exact analysis revision this card is bound to."),
  displayed_hypotheses: z.array(
    z.looseObject({
      id: z.string().nullable(),
      rank: z.number().int(),
      name: z.string(),
    }),
  ),
  actions: z.array(promptSuggestionSchema),
  upgrade: upgradeOfferSchema.optional(),
  source: z.string().optional(),
});
