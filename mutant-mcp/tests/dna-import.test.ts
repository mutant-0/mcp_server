import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  enforceRequestCap,
  enforceResponseCap,
  MockMutantBackendClient,
  responseCapFor,
} from "../src/clients/mutant-lambda-client.js";
import { CONTRACT_VERSION, type ToolResponse } from "../src/contract.js";
import { createMcpServer } from "../src/server.js";
import { DNA_IMPORT_UI_URI } from "../src/ui/dna-import/resource.js";
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

const DNA_TOOLS = ["show_dna_import", "get_snp_catalog", "create_report"] as const;
const ANALYSIS_TOOLS = [
  "get_analysis_status",
  "get_analysis_context",
  "list_health_hypotheses",
  "get_hypothesis_details",
  "get_supporting_evidence",
  "get_genetic_context",
] as const;

const CATALOG = {
  version: 7,
  snp_count: 2,
  snps: {
    rs4680: { rsID: "rs4680", chromosome: "22", position_GRCh37: 19951271 },
    rs328: { rsID: "rs328", chromosome: "8", position_GRCh37: 19819724 },
  },
  aliases: { rs328: ["rs1000000"] },
};

const VALID_IMPORT = {
  snps: { rs4680: "GG", rs328: "CG" },
  upload_meta: { provider: "23andMe", file_name: "raw.txt", file_size_bytes: 1234 },
  import_request_id: "12345678-abcd-4ef0-9876-1234567890ab",
};

async function connect(options: {
  scopes?: string[];
  responder?: (operation: string, args: Record<string, unknown>) => ToolResponse;
  config?: Partial<Parameters<typeof makeConfig>[0]>;
  logger?: ReturnType<typeof makeCapturingLogger>;
}) {
  const backendClient = new StubBackendClient(
    (operation, args) => options.responder?.(operation, args) ?? makeSuccessResponse(),
  );
  const capture = options.logger ?? makeCapturingLogger();
  const server = createMcpServer(
    makeUser(options.scopes ? { scopes: options.scopes } : {}),
    makeConfig(options.config ?? {}),
    "req-dna",
    backendClient,
    capture.logger,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, backendClient, capture };
}

function structured(result: unknown): ToolResponse {
  return (result as { structuredContent?: unknown }).structuredContent as ToolResponse;
}

describe("DNA import authorization", () => {
  it("denies every DNA import tool to a token without dna.import", async () => {
    const { client, backendClient } = await connect({ scopes: [ANALYSIS_SCOPE] });
    // Valid arguments so the denial is the reason for failure, not schema validation.
    const args: Record<string, unknown> = {
      show_dna_import: {},
      get_snp_catalog: {},
      create_report: VALID_IMPORT,
    };
    for (const name of DNA_TOOLS) {
      const result = await client.callTool({
        name,
        arguments: args[name] as { [x: string]: unknown },
      });
      expect(result.isError, `${name} should be denied`).toBe(true);
      const envelope = structured(result);
      expect(envelope.error?.code, `${name} error code`).toBe("INSUFFICIENT_SCOPE");
      expect(envelope.error?.required_scope).toBe(DNA_SCOPE);
      expect(envelope.error?.app_code).toBe("insufficient_scope");
    }
    // Authorization is enforced before any backend work happens.
    expect(backendClient.calls).toHaveLength(0);
  });

  it("advertises the missing scope in a tool-level challenge", async () => {
    const { client } = await connect({ scopes: [ANALYSIS_SCOPE] });
    const result = await client.callTool({ name: "show_dna_import", arguments: {} });
    const meta = result._meta as { "mcp/www_authenticate"?: string[] } | undefined;
    const challenge = meta?.["mcp/www_authenticate"]?.[0];
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain(`scope="${DNA_SCOPE}"`);
  });

  it("denies the analysis tools to a dna.import-only token", async () => {
    const { client, backendClient } = await connect({ scopes: [DNA_SCOPE] });
    // Valid arguments so the denial is the reason for failure, not schema validation.
    const args: Record<string, unknown> = {
      get_analysis_status: {},
      get_analysis_context: {},
      list_health_hypotheses: {},
      get_hypothesis_details: { hypothesis_id: "HYP_TEST" },
      get_supporting_evidence: { hypothesis_id: "HYP_TEST" },
      get_genetic_context: { hypothesis_id: "HYP_TEST" },
    };
    for (const name of ANALYSIS_TOOLS) {
      const result = await client.callTool({
        name,
        arguments: args[name] as { [x: string]: unknown },
      });
      expect(result.isError, `${name} should be denied`).toBe(true);
      expect(structured(result).error?.code).toBe("INSUFFICIENT_SCOPE");
      expect(structured(result).error?.required_scope).toBe(ANALYSIS_SCOPE);
    }
    expect(backendClient.calls).toHaveLength(0);
  });

  it("allows the DNA import tools to a dna.import token", async () => {
    const { client } = await connect({
      scopes: [DNA_SCOPE],
      responder: (operation) => (operation === "get_snp_catalog" ? ok({ data: CATALOG }) : ok()),
    });
    for (const name of DNA_TOOLS) {
      const result = await client.callTool({
        name,
        arguments: name === "create_report" ? VALID_IMPORT : {},
      });
      expect(result.isError, `${name} should be allowed`).toBe(false);
    }
  });
});

function ok(overrides: Partial<ToolResponse> = {}): ToolResponse {
  return {
    contract_version: CONTRACT_VERSION,
    analysis_version: null,
    ok: true,
    data: { ok: true },
    error: null,
    ...overrides,
  };
}

describe("show_dna_import", () => {
  it("returns the UI resource URI on the descriptor and the result", async () => {
    const { client } = await connect({});
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === "show_dna_import");
    const meta = tool?._meta as Record<string, unknown> | undefined;
    expect(meta?.ui).toEqual({ resourceUri: DNA_IMPORT_UI_URI, visibility: ["model", "app"] });
    expect(meta?.["openai/outputTemplate"]).toBe(DNA_IMPORT_UI_URI);

    const result = await client.callTool({ name: "show_dna_import", arguments: {} });
    const resultMeta = result._meta as Record<string, unknown>;
    expect((resultMeta.ui as { resourceUri?: string }).resourceUri).toBe(DNA_IMPORT_UI_URI);
  });

  it("returns only minimal routing state and never genetic data", async () => {
    const { client, backendClient } = await connect({});
    const result = await client.callTool({ name: "show_dna_import", arguments: {} });
    const envelope = structured(result);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({
      account_status: "connected",
      dna_status: "missing",
      status: "awaiting_file",
    });
    // Rendering the UI must not require a backend round trip.
    expect(backendClient.calls).toHaveLength(0);
    // No genotypes anywhere in the result.
    expect(JSON.stringify(result)).not.toMatch(/rs\d{3,}/);
  });
});

describe("get_snp_catalog", () => {
  it("proxies the catalog unchanged and hides itself from the model", async () => {
    const { client, backendClient } = await connect({
      responder: () => ok({ data: CATALOG }),
    });
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === "get_snp_catalog");
    expect((tool?._meta as { ui?: { visibility?: string[] } })?.ui?.visibility).toEqual(["app"]);

    const result = await client.callTool({ name: "get_snp_catalog", arguments: {} });
    expect(structured(result).data).toEqual(CATALOG);
    // Not summarized or reshaped on the way through.
    expect(backendClient.calls[0]?.operation).toBe("get_snp_catalog");
  });

  it("maps an upstream transport failure to CATALOG_UNAVAILABLE", async () => {
    const { client } = await connect({
      responder: () =>
        makeErrorResponse("SERVICE_UNAVAILABLE", "upstream down", { retryable: true }),
    });
    const result = await client.callTool({ name: "get_snp_catalog", arguments: {} });
    const envelope = structured(result);
    expect(envelope.error?.code).toBe("CATALOG_UNAVAILABLE");
    expect(envelope.error?.app_code).toBe("catalog_unavailable");
    // Retryability is carried over from the upstream failure.
    expect(envelope.error?.retryable).toBe(true);
  });

  it("passes an upstream auth error through so the OAuth challenge still fires", async () => {
    const { client } = await connect({
      responder: () => makeErrorResponse("AUTHENTICATION_REQUIRED", "expired"),
    });
    const result = await client.callTool({ name: "get_snp_catalog", arguments: {} });
    expect(structured(result).error?.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("maps a malformed catalog to CATALOG_UNAVAILABLE rather than an empty success", async () => {
    const { client } = await connect({ responder: () => ok({ data: { unexpected: true } }) });
    const result = await client.callTool({ name: "get_snp_catalog", arguments: {} });
    expect(structured(result).error?.code).toBe("CATALOG_UNAVAILABLE");
  });

  it("allows the catalog a larger response cap than other tools", () => {
    const config = makeConfig({ MUTANT_MAX_RESPONSE_BYTES: 1000, MUTANT_SNP_CATALOG_MAX_BYTES: 9000 });
    expect(responseCapFor(config, "get_snp_catalog")).toBe(9000);
    expect(responseCapFor(config, "get_analysis_status")).toBe(1000);
    expect(enforceResponseCap("x".repeat(9000), 9000)).toBeNull();
    expect(enforceResponseCap("x".repeat(9001), 9000)?.error?.code).toBe("RESPONSE_TOO_LARGE");
  });

  it("logs only catalog metadata", async () => {
    const logger = makeCapturingLogger();
    const { client } = await connect({
      responder: () => ok({ data: CATALOG }),
      logger,
    });
    await client.callTool({ name: "get_snp_catalog", arguments: {} });
    const records = logger.records();
    const catalogRecord = records.find((record) => record.tool === "get_snp_catalog");
    expect(catalogRecord?.catalogVersion).toBe(7);
    expect(catalogRecord?.snpCount).toBe(2);
    // The catalog body itself must never be logged.
    expect(logger.text()).not.toContain("rs4680");
  });
});

describe("create_report", () => {
  it("rejects client-supplied identity before calling the backend", async () => {
    const { client, backendClient } = await connect({});
    for (const forbidden of [
      { account_id: "acct-1" },
      { user_id: "user-2" },
      { email: "someone@example.com" },
      { sub: "cognito-sub" },
      { analysis_id: "analysis-1" },
    ]) {
      const result = await client.callTool({
        name: "create_report",
        arguments: { ...VALID_IMPORT, ...forbidden },
      });
      expect(result.isError, `${JSON.stringify(forbidden)} should be rejected`).toBe(true);
    }
    expect(backendClient.calls).toHaveLength(0);
  });

  it("derives identity from the token, never from arguments", async () => {
    const { client, backendClient } = await connect({});
    await client.callTool({ name: "create_report", arguments: VALID_IMPORT });
    expect(backendClient.calls[0]?.userId).toBe("user-1");
    expect(backendClient.calls[0]?.arguments).not.toHaveProperty("user_id");
  });

  it("passes the idempotency key through on every retry", async () => {
    const { client, backendClient } = await connect({});
    await client.callTool({ name: "create_report", arguments: VALID_IMPORT });
    await client.callTool({ name: "create_report", arguments: VALID_IMPORT });
    expect(backendClient.calls).toHaveLength(2);
    for (const call of backendClient.calls) {
      expect(call.arguments.import_request_id).toBe(VALID_IMPORT.import_request_id);
    }
  });

  it("returns only analysis_id and status and never echoes genotypes", async () => {
    const { client } = await connect({
      responder: () =>
        ok({
          data: {
            analysis_id: "analysis_123",
            status: "processing",
            snps: { rs4680: "GG" },
            internal_debug: { request: "..." },
          },
        }),
    });
    const result = await client.callTool({ name: "create_report", arguments: VALID_IMPORT });
    expect(structured(result).data).toEqual({ analysis_id: "analysis_123", status: "processing" });
    expect(JSON.stringify(result)).not.toContain("GG");
  });

  it("maps upstream failures to the DNA import error vocabulary", async () => {
    const cases: Array<[string, string]> = [
      ["SERVICE_UNAVAILABLE", "REPORT_GENERATION_FAILED"],
      ["DATA_INCOMPATIBLE", "REPORT_GENERATION_FAILED"],
      ["INVALID_ARGUMENT", "INVALID_DNA_PAYLOAD"],
    ];
    for (const [upstream, expected] of cases) {
      const { client } = await connect({ responder: () => makeErrorResponse(upstream, "failed") });
      const result = await client.callTool({ name: "create_report", arguments: VALID_IMPORT });
      expect(structured(result).error?.code, `${upstream} -> ${expected}`).toBe(expected);
      expect(structured(result).error?.app_code).toBeTruthy();
    }
  });

  it("enforces the request size cap", async () => {
    const { client, backendClient } = await connect({
      config: { MUTANT_MAX_REQUEST_BYTES: 200 },
    });
    // Shape-valid but oversized: 200 markers exceed the 200-byte cap.
    const snps = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`rs${100000 + index}`, "AG"]),
    );
    const result = await client.callTool({
      name: "create_report",
      arguments: { ...VALID_IMPORT, snps },
    });
    expect(structured(result).error?.code).toBe("PAYLOAD_TOO_LARGE");
    expect(structured(result).error?.app_code).toBe("payload_too_large");
    expect(backendClient.calls).toHaveLength(0);
  });

  it("accepts a payload at the request size cap", async () => {
    const { client } = await connect({});
    const result = await client.callTool({ name: "create_report", arguments: VALID_IMPORT });
    expect(result.isError).toBe(false);
    expect(structured(result).ok).toBe(true);
  });

  it("never logs the submitted genotypes", async () => {
    const logger = makeCapturingLogger();
    const { client } = await connect({ logger });
    await client.callTool({ name: "create_report", arguments: VALID_IMPORT });
    const text = logger.text();
    expect(text).not.toContain("rs4680");
    expect(text).not.toContain('"GG"');

    const records = logger.records().filter((entry) => entry.tool === "create_report");
    expect(records).toHaveLength(2);
    for (const record of records) {
      // Counts and sizes are logged; the payload and the genotype map are not.
      expect(record.snpCount).toBe(2);
      expect(record.payloadBytes).toBeGreaterThan(0);
      expect(record).not.toHaveProperty("snps");
      expect(record).not.toHaveProperty("wgs_variant_calls");
      expect(record.importRequestId).toBe(VALID_IMPORT.import_request_id);
    }
  });
});

describe("transport size caps", () => {
  it("rejects an oversized request", () => {
    expect(enforceRequestCap({ a: "x".repeat(100) }, 10)?.error?.code).toBe("PAYLOAD_TOO_LARGE");
    expect(enforceRequestCap({ a: "x" }, 1000)).toBeNull();
  });

  it("is enforced by the dev-mode mock client too", async () => {
    const client = new MockMutantBackendClient({
      maxRequestBytes: 10,
      maxResponseBytes: 10,
      snpCatalogMaxBytes: 10,
    });
    const result = await client.invoke("get_snp_catalog", {}, makeUser(), "req");
    expect(result.error?.code).toBe("RESPONSE_TOO_LARGE");

    const requestResult = await client.invoke(
      "create_report",
      { a: "x".repeat(100) },
      makeUser(),
      "req",
    );
    expect(requestResult.error?.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("get_analysis_status", () => {
  it("points at show_dna_import when no analysis exists", async () => {
    const { client } = await connect({
      responder: () => ok({ data: { analysis: { status: "none" } }, analysis_version: null }),
    });
    const result = await client.callTool({ name: "get_analysis_status", arguments: {} });
    const data = structured(result).data as Record<string, unknown>;
    expect(data.dna_status).toBe("missing");
    expect(data.analysis_status).toBe("not_started");
    expect(data.next_action).toEqual({
      tool: "show_dna_import",
      reason: "DNA data is required before an analysis can be generated.",
    });
  });

  it("reports a ready analysis and points at the analysis tools", async () => {
    const { client } = await connect({
      responder: () =>
        ok({ data: { analysis: { status: "ready" }, entitlement: { plan: "mutant_free" } } }),
    });
    const result = await client.callTool({ name: "get_analysis_status", arguments: {} });
    const data = structured(result).data as Record<string, unknown>;
    expect(data.dna_status).toBe("available");
    expect(data.analysis_status).toBe("ready");
    expect(data.plan).toBe("Mutant Free");
    expect((data.next_action as { tool?: string }).tool).toBe("get_analysis_context");
  });

  it("asks the model to check again while an analysis is processing", async () => {
    const { client } = await connect({
      responder: () => ok({ data: { analysis: { status: "processing" } } }),
    });
    const result = await client.callTool({ name: "get_analysis_status", arguments: {} });
    const data = structured(result).data as Record<string, unknown>;
    expect(data.dna_status).toBe("available");
    expect(data.analysis_status).toBe("processing");
    expect((data.next_action as { tool?: string }).tool).toBe("get_analysis_status");
  });

  it("prefers backend-provided routing fields over the derived shim", async () => {
    const providedNextAction = {
      tool: "show_dna_import",
      reason: "DNA data is required before an analysis can be generated.",
    };
    const { client } = await connect({
      responder: () =>
        ok({
          data: {
            analysis: { status: "ready" },
            dna_status: "missing",
            analysis_status: "processing",
            plan: "Mutant Full",
            next_action: providedNextAction,
          },
        }),
    });
    const result = await client.callTool({ name: "get_analysis_status", arguments: {} });
    const data = structured(result).data as Record<string, unknown>;
    expect(data.dna_status).toBe("missing");
    expect(data.analysis_status).toBe("processing");
    expect(data.plan).toBe("Mutant Full");
    expect(data.next_action).toEqual(providedNextAction);
  });
});
