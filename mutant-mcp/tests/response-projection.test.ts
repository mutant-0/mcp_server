import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BackendOperation, ToolResponse } from "../src/contract.js";
import { projectToolResult, projectValue } from "../src/responses/projections.js";
import {
  analysisStatusOutputSchema,
  supportingEvidenceDataSchema,
} from "../src/schemas/index.js";
import { createMcpServer } from "../src/server.js";
import {
  ANALYSIS_SCOPE,
  makeConfig,
  makeHypothesisSummary,
  makeStatusData,
  makeSuccessResponse,
  makeToolResponse,
  makeUser,
  StubBackendClient,
} from "./helpers.js";

/**
 * PRIV-03 response boundary. The response builder used to forward whatever the
 * backend envelope contained; these tests inject identifying/debug fields at
 * several depths and assert they do not cross the approved projection, while the
 * fields the contract promises survive.
 */
const SENTINEL = "SENTINEL_MUST_NOT_LEAK";

async function connect(
  responder: (operation: BackendOperation, args: Record<string, unknown>) => ToolResponse,
  options: { scopes?: string[] } = {},
) {
  const backendClient = new StubBackendClient((operation, args) => responder(operation, args));
  const server = createMcpServer(
    makeUser(options.scopes ? { scopes: options.scopes } : {}),
    makeConfig(),
    "req-projection",
    backendClient,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, backendClient };
}

function envelope(result: unknown): ToolResponse {
  return (result as { structuredContent?: unknown }).structuredContent as ToolResponse;
}

function dataOf(result: unknown): Record<string, unknown> {
  return envelope(result).data as Record<string, unknown>;
}

describe("response projection", () => {
  it("drops unknown top-level, nested, and object fields from structuredContent", async () => {
    const base = makeStatusData();
    const data = makeStatusData({
      account_id: SENTINEL,
      raw_genotypes: { rs4680: "AG" },
      active_analysis: { ...(base.active_analysis as object), owner_email: SENTINEL },
      entitlement: { ...(base.entitlement as object), subject_id: SENTINEL },
      capabilities: { ...(base.capabilities as object), internal_flag: SENTINEL },
    });
    const { client } = await connect(() => makeSuccessResponse(data));
    const result = await client.callTool({ name: "get_analysis_status", arguments: {} });
    const out = dataOf(result);

    expect(JSON.stringify(out)).not.toContain(SENTINEL);
    expect(out.account_id).toBeUndefined();
    expect(out.raw_genotypes).toBeUndefined();
    expect((out.active_analysis as Record<string, unknown>).owner_email).toBeUndefined();
    expect((out.entitlement as Record<string, unknown>).subject_id).toBeUndefined();
    // Declared fields survive, including the contract version and revision.
    expect(out.dna_status).toBe("available");
    expect((out.active_analysis as Record<string, unknown>).status).toBe("ready");
    expect((out.entitlement as Record<string, unknown>).plan).toBe("mutant_full");
    expect(envelope(result).analysis_version).toBe("rev42-v3.0.0");
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("drops unrequested genotypes and debug fields from list results, keeping search scope", async () => {
    const searchScope = {
      hypothesis_scope: "top_three" as const,
      searched_count: 3,
      total_ranked_count: 12,
      unsearched_ranked_count: 9,
      broader_ranked_search_available: true,
    };
    const { client } = await connect(() =>
      makeSuccessResponse({
        items: [{ ...makeHypothesisSummary(), genotype: "AG", internal_note: SENTINEL }],
        next_cursor: "cursor-1",
        search_scope: { ...searchScope, query: SENTINEL },
      }),
    );
    const result = await client.callTool({
      name: "list_health_hypotheses",
      arguments: { query: "histamine" },
    });
    const out = dataOf(result);
    const item = (out.items as Array<Record<string, unknown>>)[0]!;

    expect(JSON.stringify(out)).not.toContain(SENTINEL);
    expect(item.genotype).toBeUndefined();
    expect(item.internal_note).toBeUndefined();
    expect(item.name).toBe("Alpha finding");
    // Pagination and the server-authored search scope stay intact.
    expect(out.next_cursor).toBe("cursor-1");
    expect(out.search_scope).toEqual(searchScope);
  });

  it("keeps approved genotype detail in the variant evidence tool and drops sample metadata", async () => {
    const { client } = await connect(() =>
      makeSuccessResponse({
        kind: "variants",
        items: [
          {
            rsid: "rs4680",
            genotype: "AG",
            call_state: "called",
            contribution_status: "contributes",
            pattern_memberships: [{ pattern_id: "PAT_A", sample_label: SENTINEL }],
            sample_label: SENTINEL,
            vcf_header: SENTINEL,
          },
        ],
        next_cursor: null,
      }),
    );
    const result = await client.callTool({
      name: "get_supporting_evidence",
      arguments: { hypothesis_id: "HYP_A", kind: "variants" },
    });
    const out = dataOf(result);
    const item = (out.items as Array<Record<string, unknown>>)[0]!;

    expect(JSON.stringify(out)).not.toContain(SENTINEL);
    expect(item.genotype).toBe("AG");
    expect(item.rsid).toBe("rs4680");
    expect(item.sample_label).toBeUndefined();
    expect(item.vcf_header).toBeUndefined();
    const membership = (item.pattern_memberships as Array<Record<string, unknown>>)[0]!;
    expect(membership.sample_label).toBeUndefined();
    expect(membership.pattern_id).toBe("PAT_A");
  });

  it("keeps the catalog's declared application data and drops unknown provenance", async () => {
    const { client } = await connect(() =>
      makeSuccessResponse({
        version: 7,
        snp_count: 1,
        snps: { rs4680: { chromosome: "22" } },
        aliases: { rs4680: ["rs1000000"] },
        reference_alleles: { rs4680: { GRCh38: "G" } },
        debug_provenance: SENTINEL,
      }),
    );
    const result = await client.callTool({ name: "get_snp_catalog", arguments: {} });
    const out = dataOf(result);

    expect(JSON.stringify(out)).not.toContain(SENTINEL);
    expect(out.debug_provenance).toBeUndefined();
    expect(out.aliases).toEqual({ rs4680: ["rs1000000"] });
    expect(out.reference_alleles).toEqual({ rs4680: { GRCh38: "G" } });
    // The opaque marker map is application data the component passes through.
    expect((out.snps as Record<string, Record<string, unknown>>).rs4680?.chromosome).toBe("22");
  });

  it("drops unknown error fields while keeping the structured codes a host keys off", async () => {
    const { client } = await connect(
      () =>
        ({
          contract_version: "3.1.0",
          analysis_version: null,
          ok: false,
          data: null,
          error: {
            code: "ANALYSIS_NOT_READY",
            message: "pending",
            retryable: false,
            reason: "analysis_payload_pending",
            app_code: "report_generation_failed",
            internal_trace: SENTINEL,
            stack: SENTINEL,
          },
        }) as unknown as ToolResponse,
    );
    const result = await client.callTool({ name: "get_analysis_context", arguments: {} });
    const error = envelope(result).error as unknown as Record<string, unknown>;

    expect(JSON.stringify(error)).not.toContain(SENTINEL);
    expect(error.code).toBe("ANALYSIS_NOT_READY");
    expect(error.reason).toBe("analysis_payload_pending");
    expect(error.app_code).toBe("report_generation_failed");
    expect(error.internal_trace).toBeUndefined();
    expect(error.stack).toBeUndefined();
  });

  it("keeps the auth challenge meta on a scope denial", async () => {
    const { client } = await connect(() => makeToolResponse("get_analysis_status"), {
      scopes: [ANALYSIS_SCOPE],
    });
    const result = (await client.callTool({
      name: "get_snp_catalog",
      arguments: {},
    })) as CallToolResult & { _meta?: Record<string, unknown> };

    expect(result.isError).toBe(true);
    expect(envelope(result).error?.code).toBe("INSUFFICIENT_SCOPE");
    expect(result._meta?.["mcp/www_authenticate"]).toBeDefined();
  });

  it("projects metadata to sanctioned keys and drops injected ones", () => {
    const result: CallToolResult = {
      content: [{ type: "text", text: "ok" }],
      structuredContent: {
        contract_version: "3.1.0",
        analysis_version: null,
        ok: true,
        data: makeStatusData({ account_id: SENTINEL }),
        error: null,
      },
      _meta: { ui: { resourceUri: "ui://x" }, internal_debug: SENTINEL },
    };
    const projected = projectToolResult(result, analysisStatusOutputSchema);
    expect(JSON.stringify(projected)).not.toContain(SENTINEL);
    expect(projected._meta).toEqual({ ui: { resourceUri: "ui://x" } });
  });

  it("returns undefined rather than forwarding a value that matches no union branch", () => {
    expect(projectValue(supportingEvidenceDataSchema, { kind: "unknown_kind", items: [] })).toBeUndefined();
  });
});
