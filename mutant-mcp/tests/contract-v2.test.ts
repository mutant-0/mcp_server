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
      return {
        coverage: { analyzed_markers: 1000 },
        interpretation: { summary: "Findings reviewed.", limitations: ["Not a diagnosis."] },
        selection_scope: "all",
        top_hypotheses: [
          { id: "HYP_A", rank: 1, title: "Alpha finding", bottom_line: "First summary." },
          { id: "HYP_B", rank: 2, title: "Beta finding", bottom_line: "Second summary." },
        ],
      };
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
});
