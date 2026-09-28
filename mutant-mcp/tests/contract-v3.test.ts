import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CONTRACT_VERSION,
  TOOL_NAMES,
  type BackendOperation,
  type ToolName,
  type ToolResponse,
} from "../src/contract.js";
import { createMcpServer } from "../src/server.js";
import {
  ANALYSIS_SCOPE,
  DNA_SCOPE,
  makeCapturingLogger,
  makeConfig,
  makeErrorResponse,
  makeStatusData,
  makeSuccessResponse,
  makeUser,
  StubBackendClient,
} from "./helpers.js";

/**
 * Contract v3.0 acceptance smoke test.
 *
 * Stands up the server with a permissive backend stub and calls every tool the
 * server advertises, so a tool that is registered but not callable (or that
 * serializes its own structured content into model-facing text) fails here
 * rather than in a host. Every response is also validated against the tool's
 * own concrete `outputSchema` by the SDK, so a drifted `data` shape fails here.
 */

/** Minimal arguments that satisfy each tool's input schema. */
const MINIMAL_ARGS: Record<ToolName, Record<string, unknown>> = {
  get_analysis_status: {},
  poll_analysis_status: {},
  show_analysis_overview: {},
  get_analysis_context: {},
  list_health_hypotheses: {},
  explain_health_hypothesis: { hypothesis_id: "HYP_A" },
  get_supporting_evidence: { hypothesis_id: "HYP_A", kind: "patterns" },
  get_genetic_context: {},
  show_dna_import: {},
  get_snp_catalog: {},
  create_report: {
    snps: { rs4680: "GG", rs328: "CG" },
    upload_meta: { provider: "23andMe", file_name: "raw.txt", file_size_bytes: 1234 },
    import_request_id: "12345678-abcd-4ef0-9876-1234567890ab",
  },
};

/** The `get_analysis_context` payload: the interpretation contract plus previews. */
function interpretation(): Record<string, unknown> {
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
        "Explain the hypothesis as pathway-level support, not a single SNP.",
        "Start from the contributing biological modules.",
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
      assessability: "Whether the hypothesis could be evaluated.",
      pattern_convergence: "How strongly independent patterns agree.",
      module_support: "Genetic support from the underlying biological modules.",
      pattern_support:
        "Additional retained support from cross-module patterns; comparable to module_support on the same 0-100 scale.",
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

function contextData(): Record<string, unknown> {
  return {
    interpretation: interpretation(),
    coverage: { analyzed_markers: 1000 },
    access: {
      plan: "mutant_full",
      hypothesis_scope: "all",
      total_ranked: 2,
      returned: 2,
      unlocked: 2,
      locked: 0,
      scope_message:
        "Your complete ranked analysis is available. This response previews the top three; use hypothesis search or listing to explore the rest.",
    },
    preview: [
      {
        id: "HYP_A",
        rank: 1,
        name: "Alpha finding",
        summary: "First summary.",
        priority_score: 90,
        genetic_support: 72,
        genetic_evidence: "strong",
        coverage_confidence: "high",
        pattern_convergence: "strong",
      },
      {
        id: "HYP_B",
        rank: 2,
        name: "Beta finding",
        summary: "Second summary.",
        priority_score: 80,
        genetic_support: 61,
        genetic_evidence: "moderate",
        coverage_confidence: "high",
        pattern_convergence: "moderate",
      },
    ],
  };
}

/** A response with the 3.0.0 shape the content builders expect for each tool. */
function dataFor(operation: BackendOperation): Record<string, unknown> {
  switch (operation) {
    case "resolve_analysis_snapshot":
    case "show_analysis_overview":
      return {
        displayed_analysis_version: "rev42-v3.0.0",
        displayed_hypotheses: [
          { id: "HYP_A", rank: 1, name: "Alpha finding" },
          { id: "HYP_B", rank: 2, name: "Beta finding" },
        ],
      };
    case "get_analysis_status":
    case "poll_analysis_status":
      return makeStatusData();
    case "get_analysis_context":
      return contextData();
    case "list_health_hypotheses":
      return {
        items: [
          {
            id: "HYP_A",
            rank: 1,
            name: "Alpha finding",
            summary: "First summary.",
            priority_score: 90,
            genetic_support: 72,
            genetic_evidence: "strong",
            coverage_confidence: "high",
            pattern_convergence: "strong",
          },
        ],
        next_cursor: "cursor-1",
      };
    case "explain_health_hypothesis":
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
          why_ranked: "It ranked first on priority score and pattern convergence.",
          interpretation_boundary: "This is not a diagnosis.",
          top_contributing_patterns: [{ id: "PAT_A", name: "Pattern A" }],
        },
        evidence_shape: {
          support_distribution: "concentrated",
          summary: "Support is concentrated in a single locus.",
        },
        ranking_drivers: [
          { component: "priority_score", value: 90 },
          { component: "genetic_support", value: 72 },
          { component: "module_support", value: 40 },
          { component: "pattern_support", value: 32 },
          { component: "converging_pattern_adjustment", value: 5 },
        ],
        score_breakdown: {
          priority_score: 90,
          genetic_support: 72,
          module_support: 40,
          pattern_support: 32,
          converging_pattern_adjustment: 5,
        },
        support_architecture: {
          classification: "single_locus",
          contributing_module_count: 1,
          module_scoring_gene_count: 1,
          module_scoring_variant_count: 1,
          pattern_participating_gene_count: 2,
          pattern_participating_variant_count: 2,
          summary: "Support is concentrated in a single locus.",
        },
        modules: [
          {
            module_id: "histamine",
            module_name: "Histamine",
            scoring_status: "active",
            role: "primary",
            retained_support: 40,
            module_support_fraction: 1,
            module_scoring_gene_count: 1,
            module_scoring_variant_count: 1,
            top_scoring_genes: ["HNMT"],
            summary:
              "Histamine contributed 40 support points from 1 scoring variant across 1 gene.",
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
        converging_patterns: [
          {
            pattern_id: "CONV_1",
            state: "observed",
            structural_fit: 0.9,
            pattern_confidence: 0.8,
            contribution: 5,
          },
        ],
        confirmation: {
          primary_checks: [{ id: "test-1", short_name: "Ferritin", role: "First-line check" }],
          stronger_support: "A high ferritin would strengthen this.",
          weakening_evidence: "A normal ferritin would weaken this.",
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
        assessment: {
          status: "qualifying_match",
          assessability: "assessed",
          marker_call_incomplete: true,
          marker_coverage: {
            called: 12,
            total: 14,
            level: "partial",
            missing_markers: ["rs1", "rs2"],
          },
        },
        clinical_context: {
          common_cofactors: [],
          common_confusers: [],
          subtypes: [],
          source: "catalog_general",
        },
        guardrails: ["Discuss results with a clinician."],
        guardrails_source: "catalog_general",
      };
    case "get_supporting_evidence":
      return {
        kind: "patterns",
        items: [
          {
            id: "PAT_A",
            name: "Pattern A",
            state: "matched",
            contribution_status: "contributes",
            impact_points: 5.5,
          },
        ],
      };
    case "get_genetic_context":
      return {
        markers: [
          {
            rsid: "rs4680",
            gene: "COMT",
            genotype: "GG",
            call_state: "called",
            contribution_status: "contributes",
            pattern_memberships: [{ pattern_id: "PAT_A", role: "contributing" }],
          },
        ],
      };
    case "get_snp_catalog":
      return {
        version: 7,
        snp_count: 1,
        snps: { rs4680: { rsID: "rs4680", chromosome: "22", position_GRCh37: 19951271 } },
      };
    case "show_dna_import":
      return { ui_rendered: true, mode: "initial" };
    case "create_report":
      return { analysis_id: "analysis_1", status: "processing" };
  }
}

async function connect(
  responder: (operation: BackendOperation, args: Record<string, unknown>) => ToolResponse = (
    operation,
  ) => makeSuccessResponse(dataFor(operation)),
) {
  const backendClient = new StubBackendClient(responder);
  const { logger } = makeCapturingLogger();
  const server = createMcpServer(
    makeUser({ scopes: [ANALYSIS_SCOPE, DNA_SCOPE] }),
    makeConfig(),
    "req-smoke",
    backendClient,
    logger,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "smoke-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, backendClient };
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function envelopeOf(result: unknown): ToolResponse {
  return (result as { structuredContent: ToolResponse }).structuredContent;
}

describe("contract v3.0 acceptance", () => {
  it("advertises every contract tool and calls each one successfully", async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    const advertised = listed.tools.map((tool) => tool.name);
    expect(advertised.sort()).toEqual([...TOOL_NAMES].sort());

    // Every advertised tool must publish its own concrete output schema.
    for (const tool of listed.tools) {
      expect(tool.outputSchema, `${tool.name} output schema`).toBeTruthy();
    }

    for (const name of TOOL_NAMES) {
      const result = await client.callTool({ name, arguments: MINIMAL_ARGS[name] });
      expect(result.isError, `${name} should succeed`).toBe(false);
      const envelope = envelopeOf(result);
      expect(envelope.contract_version, `${name} contract version`).toBe(CONTRACT_VERSION);
      expect(envelope.ok, `${name} ok flag`).toBe(true);
    }
  });

  it("summarizes each tool in text instead of dumping structured content", async () => {
    const { client } = await connect();
    for (const name of TOOL_NAMES) {
      const result = await client.callTool({ name, arguments: MINIMAL_ARGS[name] });
      const text = textOf(result);
      expect(text.length, `${name} text`).toBeGreaterThan(0);
      // The model-facing text must never be the serialized envelope.
      expect(text, `${name} text should not be JSON`).not.toMatch(/^\s*[{[]/);
      expect(text).not.toContain(JSON.stringify(result).slice(0, 40));
      expect(text, `${name} should not leak the envelope`).not.toContain("contract_version");
    }
  });

  it("caps suggested prompts at five natural-language follow-ups", async () => {
    const { client } = await connect();
    const withPrompts = [
      "get_analysis_status",
      "get_analysis_context",
      "explain_health_hypothesis",
    ] as const;
    for (const name of withPrompts) {
      const result = await client.callTool({ name, arguments: MINIMAL_ARGS[name] });
      const data = envelopeOf(result).data as { suggested_prompts?: Array<Record<string, unknown>> };
      const prompts = data.suggested_prompts ?? [];
      expect(prompts.length, `${name} prompt count`).toBeGreaterThan(0);
      expect(prompts.length, `${name} prompt count`).toBeLessThanOrEqual(5);
      for (const prompt of prompts) {
        expect(typeof prompt.id).toBe("string");
        expect(typeof prompt.label).toBe("string");
        expect(typeof prompt.prompt).toBe("string");
        // Prompts are user-visible prose, never internal tool commands.
        expect(String(prompt.prompt)).not.toMatch(/call_|_id=|\(\)/);
      }
    }
  });

  it("renders the context content from the interpretation contract without dumping it", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "get_analysis_context", arguments: {} });
    const text = textOf(result);
    expect(text).toContain("assessed 1000 markers");
    expect(text).toContain("Alpha finding");
    expect(text).toContain("complete ranked analysis");
    expect(text).toContain("Not a diagnosis.");
    expect(text).toContain("You can ask me to explain one finding");
    // The structured contract is not echoed into the model-facing text.
    expect(text).not.toContain("interpretation");
    expect(text).not.toContain("score_semantics");
    expect(text).not.toMatch(/^\s*[{[]/);
    expect(text.length).toBeLessThan(1500);
  });

  it("selects context prompts from the access summary, not selection_scope", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "get_analysis_context", arguments: {} });
    const data = envelopeOf(result).data as {
      suggested_prompts?: Array<{ id: string; prompt: string }>;
    };
    const ids = (data.suggested_prompts ?? []).map((prompt) => prompt.id);
    expect(ids).toContain("explain-first");
    expect(ids).toContain("search-all");
    expect(ids).toContain("compare-all");
    expect(ids).not.toContain("full-scope");

    // Prompt chips carry a structured action bound to the displayed snapshot.
    const explain = data.suggested_prompts?.find((prompt) => prompt.id === "explain-first") as
      | { action?: { analysis_version?: string; hypothesis_id?: string; intent?: string } }
      | undefined;
    expect(explain?.action?.analysis_version).toBe("rev42-v3.0.0");
    expect(explain?.action?.hypothesis_id).toBe("HYP_A");
    expect(explain?.action?.intent).toBe("explain");
  });

  it("keeps the Free hint row to explain/compare-history without a Full-scope chip", async () => {
    const { client } = await connect((operation) => {
      if (operation !== "get_analysis_context") {
        return makeSuccessResponse(dataFor(operation));
      }
      return makeSuccessResponse({
        ...contextData(),
        access: {
          plan: "mutant_free",
          hypothesis_scope: "top_three",
          total_ranked: 10,
          returned: 3,
          unlocked: 3,
          locked: 7,
          scope_message:
            "Your top three ranked hypotheses are fully unlocked. Mutant Full can search 7 additional ranked hypotheses.",
        },
      });
    });
    const result = await client.callTool({ name: "get_analysis_context", arguments: {} });
    const data = envelopeOf(result).data as {
      suggested_prompts?: Array<{
        id: string;
        label: string;
        action?: { analysis_version?: string; hypothesis_id?: string; intent?: string };
      }>;
    };
    const prompts = data.suggested_prompts ?? [];
    const ids = prompts.map((prompt) => prompt.id);
    expect(ids).toContain("explain-first");
    expect(ids).toContain("compare-top-three");
    expect(ids).toContain("compare-medical-records");
    expect(ids).not.toContain("full-scope");
    expect(ids).not.toContain("search-all");
    expect(ids).not.toContain("compare-all");

    // The upgrade is a separate link, never a hint-row chip.
    expect(prompts.some((prompt) => prompt.label === "Compare all with Full")).toBe(false);

    const history = prompts.find((prompt) => prompt.id === "compare-medical-records");
    expect(history?.label).toBe("Compare with my history");
    expect(history?.action?.analysis_version).toBe("rev42-v3.0.0");
    expect(history?.action?.intent).toBe("comparison");

    const compareTop = prompts.find((prompt) => prompt.id === "compare-top-three");
    expect(compareTop?.action?.analysis_version).toBe("rev42-v3.0.0");
    expect(compareTop?.action?.hypothesis_id).toBe("HYP_A");
  });

  it("reports errors as short text without echoing the envelope", async () => {
    const { client } = await connect(() =>
      makeErrorResponse("ANALYSIS_PROCESSING", "The analysis is still processing.", {
        next_action: { tool: "get_analysis_status", reason: "Processing is not finished." },
      }),
    );
    const result = await client.callTool({ name: "get_analysis_context", arguments: {} });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("ANALYSIS_PROCESSING");
    expect(text).toContain("get_analysis_status");
    expect(text).not.toMatch(/^\s*[{[]/);
    expect(text).not.toContain("contract_version");
  });

  it("binds the overview card to one displayed snapshot", async () => {
    const { client, backendClient } = await connect();
    const result = await client.callTool({ name: "show_analysis_overview", arguments: {} });
    expect(result.isError).toBe(false);
    const data = envelopeOf(result).data as {
      displayed_analysis_version: string | null;
      displayed_hypotheses: Array<{ id: string; rank: number; name: string }>;
    };
    expect(data.displayed_analysis_version).toBe("rev42-v3.0.0");
    expect(data.displayed_hypotheses.length).toBe(2);
    expect(backendClient.calls.map((call) => call.operation)).toContain(
      "resolve_analysis_snapshot",
    );
    const meta = result._meta as { mutant?: { displayed_analysis_version?: string } };
    expect(meta.mutant?.displayed_analysis_version).toBe("rev42-v3.0.0");
  });

  it("keeps widget-only state out of genetic data and off the analysis tools", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "show_dna_import", arguments: {} });
    const meta = result._meta as { mutant?: { mode?: string } };
    expect(meta.mutant?.mode).toBe("initial");
    expect(JSON.stringify(result)).not.toMatch(/rs\d{3,}/);

    const context = await client.callTool({ name: "get_analysis_context", arguments: {} });
    expect((context._meta as Record<string, unknown> | undefined)?.mutant).toBeUndefined();
  });

  it("carries the module-first explanation contract without dumping it into text", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "get_analysis_context", arguments: {} });
    const contract = (envelopeOf(result).data as { interpretation: Record<string, unknown> })
      .interpretation;

    expect(contract.version).toBe("2.6");
    const rules = contract.evidence_explanation_rules as {
      organizing_level: string;
      rules: string[];
      module_first_instruction: string;
    };
    expect(rules.organizing_level).toBe("modules_then_patterns_then_variants");
    expect(rules.module_first_instruction).toContain("modules first");

    const semantics = contract.score_semantics as Record<string, string>;
    expect(semantics.module_support).toBeTruthy();
    expect(semantics.pattern_support).toBeTruthy();
    expect(semantics.assessment).toBeTruthy();
    expect(semantics.marker_coverage).toBeTruthy();
    expect(semantics.assessability).toBeTruthy();

    const model = contract.evidence_model as {
      primary_units: string[];
      preferred_explanation_order: string[];
    };
    expect(model.primary_units).toEqual(["modules", "patterns", "variants"]);
    expect(model.preferred_explanation_order).toEqual(["modules", "patterns", "variants"]);

    const order = contract.presentation_order as string[];
    expect(order.slice(0, 4)).toEqual([
      "bottom_line",
      "support_architecture",
      "module_contributions",
      "pattern_contributions",
    ]);

    // The structured rules stay structured; the model-facing text is prose.
    const text = textOf(result);
    expect(text).not.toContain("modules_then_patterns_then_variants");
    expect(text).not.toContain("evidence_explanation_rules");
  });

  it("explains a finding in the concise What/Why/Clarify content order", async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: "explain_health_hypothesis",
      arguments: { hypothesis_id: "HYP_A" },
    });
    const text = textOf(result);

    const meaning = text.indexOf("What it means:");
    const why = text.indexOf("Why it appeared:");
    const clarify = text.indexOf("What could clarify it:");
    expect(meaning).toBeGreaterThan(-1);
    expect(why).toBeGreaterThan(meaning);
    expect(clarify).toBeGreaterThan(why);

    // The architecture summary and ranking rationale carry "why it appeared".
    expect(text).toContain("Support is concentrated in a single locus.");
    expect(text).toContain("It ranked first on priority score and pattern convergence.");

    // The default answer is concise: the module list, retained-pattern list,
    // key drivers, converging-pattern sentence, and guardrail list stay in
    // structuredContent and are reachable through get_supporting_evidence.
    expect(text).not.toContain("Module contributions:");
    expect(text).not.toContain("Retained patterns:");
    expect(text).not.toContain("key scoring drivers");
    expect(text).not.toContain("Converging patterns adjusted priority only");
    expect(text).not.toContain("Pattern participation is separate from module scoring");

    // Bounded default length (~150-220 words), never a JSON dump.
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(260);
    expect(text).not.toMatch(/^\s*[{[]/);
  });

  it("derives content and structured fields from one canonical assessment", async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: "explain_health_hypothesis",
      arguments: { hypothesis_id: "HYP_A" },
    });
    const data = envelopeOf(result).data as Record<string, any>;
    expect(data.score_interpretation.marker_coverage.total).toBe(
      data.assessment.marker_coverage.total,
    );
    expect(data.score_interpretation.assessability).toBe(data.assessment.assessability);
    expect(data.score_interpretation.marker_call_incomplete).toBe(
      data.assessment.marker_call_incomplete,
    );
    const text = textOf(result);
    expect(text).toContain(data.score_interpretation.data_gap_effect);
    expect(text).not.toContain("marker_coverage");
    expect(text).not.toMatch(/^\s*[{[]/);
  });

  it("keeps detailed test guidance reachable after trimming default content", async () => {
    const { client } = await connect();
    const explanation = textOf(
      await client.callTool({
        name: "explain_health_hypothesis",
        arguments: { hypothesis_id: "HYP_A" },
      }),
    );
    expect(explanation).not.toContain("assay");
    const evidence = await client.callTool({
      name: "get_supporting_evidence",
      arguments: { hypothesis_id: "HYP_A", kind: "tests" },
    });
    expect(textOf(evidence)).toBeTruthy();
  });

  it("renders the modules evidence kind without dumping the trace", async () => {
    const { client } = await connect((operation) => {
      if (operation !== "get_supporting_evidence") {
        return makeSuccessResponse(dataFor(operation));
      }
      return makeSuccessResponse({
        kind: "modules",
        items: [
          {
            module_id: "histamine",
            module_name: "Histamine",
            scoring_status: "active",
            retained_support: 40,
            scoring_drivers: [
              {
                rsid: "rs100",
                gene: "HNMT",
                module_contribution_status: "contributes",
                retained_contribution: 40,
              },
            ],
          },
        ],
      });
    });
    const result = await client.callTool({
      name: "get_supporting_evidence",
      arguments: { hypothesis_id: "HYP_A", kind: "modules", include_context: true },
    });
    const text = textOf(result);
    expect(text).toContain("modules");
    expect(text).toContain("Histamine");
    expect(text).toContain("40 retained points");
    expect(text).not.toMatch(/^\s*[{[]/);
    expect(text).not.toContain("scoring_drivers");
  });

  it("rejects a stale analysis_version with ANALYSIS_VERSION_CHANGED", async () => {
    const { client } = await connect(() =>
      makeErrorResponse(
        "ANALYSIS_VERSION_CHANGED",
        "The analysis changed since that revision.",
        {
          next_action: {
            tool: "show_analysis_overview",
            reason: "Re-resolve the current analysis revision.",
          },
        },
      ),
    );
    const result = await client.callTool({
      name: "explain_health_hypothesis",
      arguments: { hypothesis_id: "HYP_A", analysis_version: "stale-rev" },
    });
    expect(result.isError).toBe(true);
    const envelope = envelopeOf(result);
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("ANALYSIS_VERSION_CHANGED");
    expect(envelope.error?.next_action?.tool).toBe("show_analysis_overview");
  });
});
