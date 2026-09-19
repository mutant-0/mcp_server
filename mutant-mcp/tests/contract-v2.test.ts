import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CONTRACT_VERSION, TOOL_NAMES, type ToolName, type ToolResponse } from "../src/contract.js";
import { createMcpServer } from "../src/server.js";
import {
  ANALYSIS_SCOPE,
  DNA_SCOPE,
  makeCapturingLogger,
  makeConfig,
  makeErrorResponse,
  makeSuccessResponse,
  makeUser,
  StubBackendClient,
} from "./helpers.js";

/**
 * Contract v2.0 acceptance smoke test (§11.6).
 *
 * Stands up the server with a permissive backend stub and calls every tool the
 * server advertises, so a tool that is registered but not callable (or that
 * serializes its own structured content into model-facing text) fails here
 * rather than in a host.
 */

/** Minimal arguments that satisfy each tool's input schema. */
const MINIMAL_ARGS: Record<ToolName, Record<string, unknown>> = {
  get_analysis_status: {},
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
function contextData(): Record<string, unknown> {
  return {
    interpretation_contract: {
      version: "2.1",
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
        genetic_evidence: "The weak/moderate/strong evidence category.",
        coverage_confidence: "How completely the relevant markers were assessed.",
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
      limitations: ["Not a diagnosis."],
    },
    coverage: { analyzed_markers: 1000 },
    access_summary: {
      plan: "mutant_full",
      hypothesis_scope: "all",
      total_ranked: 2,
      returned: 2,
      unlocked: 2,
      locked: 0,
      scope_message:
        "Your complete ranked analysis is available. This response previews the top three; use hypothesis search or listing to explore the rest.",
    },
    top_hypotheses: [
      {
        id: "HYP_A",
        rank: 1,
        title: "Alpha finding",
        bottom_line: "First summary.",
        priority_score: 90,
        genetic_evidence: "strong",
        coverage_confidence: "high",
        pattern_convergence: "strong",
      },
      {
        id: "HYP_B",
        rank: 2,
        title: "Beta finding",
        bottom_line: "Second summary.",
        priority_score: 80,
        genetic_evidence: "moderate",
        coverage_confidence: "high",
        pattern_convergence: "moderate",
      },
    ],
  };
}

/** A response with the v2 shape the content builders expect for each tool. */
function dataFor(operation: ToolName): Record<string, unknown> {
  switch (operation) {
    case "get_analysis_status":
      return {
        dna_status: "available",
        analysis_status: "ready",
        regenerate: false,
        next_action: { tool: "get_analysis_context", reason: "An analysis is ready." },
      };
    case "get_analysis_context":
      return contextData();
    case "list_health_hypotheses":
      return {
        items: [{ id: "HYP_A", rank: 1, title: "Alpha finding", bottom_line: "First summary." }],
        next_cursor: "cursor-1",
      };
    case "explain_health_hypothesis":
      return {
        hypothesis: { id: "HYP_A", rank: 1, title: "Alpha finding" },
        explanation: {
          bottom_line: "Alpha finding is a moderate signal.",
          why_ranked: "It ranked first on priority score and pattern convergence.",
          interpretation_boundary: "This is not a diagnosis.",
          top_contributing_patterns: [{ id: "PAT_A", name: "Pattern A" }],
        },
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
        module_contributions: [
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
            summary: "Histamine contributed 40 support points from 1 scoring variant across 1 gene.",
            caveats: [],
          },
        ],
        pattern_contributions: [
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
        converging_pattern_contributions: [
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
        guardrails: ["Discuss results with a clinician."],
      };
    case "get_supporting_evidence":
      return {
        kind: "patterns",
        items: [{ id: "PAT_A", name: "Pattern A", state: "strong", impact_points: 5.5 }],
      };
    case "get_genetic_context":
      return {
        markers: [
          {
            rsid: "rs4680",
            call_status: "called",
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
  responder: (operation: ToolName, args: Record<string, unknown>) => ToolResponse = (
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

describe("contract v2.0 acceptance", () => {
  it("advertises every contract tool and calls each one successfully", async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    const advertised = listed.tools.map((tool) => tool.name);
    expect(advertised.sort()).toEqual([...TOOL_NAMES].sort());

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
    expect(text).not.toContain("interpretation_contract");
    expect(text).not.toContain("score_semantics");
    expect(text).not.toMatch(/^\s*[{[]/);
    expect(text.length).toBeLessThan(1500);
  });

  it("selects context prompts from the access summary, not selection_scope", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "get_analysis_context", arguments: {} });
    const data = envelopeOf(result).data as {
      suggested_prompts?: Array<{ id: string }>;
    };
    const ids = (data.suggested_prompts ?? []).map((prompt) => prompt.id);
    expect(ids).toContain("explain-first");
    expect(ids).toContain("compare-top-three");
    expect(ids).toContain("match-health-context");
    expect(ids).toContain("search-all");
    expect(ids).not.toContain("full-scope");
  });

  it("offers a Full-scope prompt to Free accounts with locked hypotheses", async () => {
    const { client } = await connect((operation) => {
      if (operation !== "get_analysis_context") {
        return makeSuccessResponse(dataFor(operation));
      }
      return makeSuccessResponse({
        ...contextData(),
        access_summary: {
          plan: "mutant_free",
          hypothesis_scope: "top_3",
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
      suggested_prompts?: Array<{ id: string }>;
    };
    const ids = (data.suggested_prompts ?? []).map((prompt) => prompt.id);
    expect(ids).toContain("full-scope");
    expect(ids).not.toContain("search-all");
  });

  it("reports errors as short text without echoing the envelope", async () => {
    const { client } = await connect(() =>
      makeErrorResponse("ANALYSIS_NOT_READY", "The analysis is still processing.", {
        next_action: "Try again in a moment.",
      }),
    );
    const result = await client.callTool({ name: "get_analysis_context", arguments: {} });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("ANALYSIS_NOT_READY");
    expect(text).not.toMatch(/^\s*[{[]/);
    expect(text).not.toContain("contract_version");
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
    const contract = (envelopeOf(result).data as { interpretation_contract: Record<string, unknown> })
      .interpretation_contract;

    expect(contract.version).toBe("2.1");
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

  it("explains a finding module-first in deterministic content order", async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: "explain_health_hypothesis",
      arguments: { hypothesis_id: "HYP_A" },
    });
    const text = textOf(result);

    const architecture = text.indexOf("Evidence architecture:");
    const modules = text.indexOf("Module contributions:");
    const patterns = text.indexOf("Retained patterns:");
    const drivers = text.indexOf("key scoring drivers");
    expect(architecture).toBeGreaterThan(-1);
    expect(modules).toBeGreaterThan(architecture);
    expect(patterns).toBeGreaterThan(modules);
    expect(drivers).toBeGreaterThan(patterns);

    // Module and pattern summary values are surfaced from the retained trace.
    expect(text).toContain("Histamine contributed 40 support points");
    expect(text).toContain("Pattern A");
    expect(text).toContain("HNMT");
    // Converging patterns are reported as a separate priority-only family.
    expect(text).toContain("Converging patterns adjusted priority only");
    // Dual module/pattern roles are stated explicitly rather than blurred.
    expect(text).toContain("Pattern participation is separate from module scoring");
    // The trace is never dumped as JSON into the model-facing text.
    expect(text).not.toMatch(/^\s*[{[]/);
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
});
