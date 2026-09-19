import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  enforceRequestCap,
  enforceResponseCap,
  MockMutantBackendClient,
  resetMockAnalyses,
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
  "explain_health_hypothesis",
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
      explain_health_hypothesis: { hypothesis_id: "HYP_TEST" },
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

  it("returns only a rendered flag, the mode, and never genetic data or account state", async () => {
    const { client, backendClient } = await connect({});
    const result = await client.callTool({ name: "show_dna_import", arguments: {} });
    const envelope = structured(result);
    expect(envelope.ok).toBe(true);
    // No routing state is echoed back: the component reads the authoritative
    // state itself, so there is nothing here for the model to narrate.
    expect(envelope.data).toEqual({ ui_rendered: true, mode: "initial" });
    // Rendering the UI must not require a backend round trip.
    expect(backendClient.calls).toHaveLength(0);
    // No genotypes anywhere in the result.
    expect(JSON.stringify(result)).not.toMatch(/rs\d{3,}/);
  });

  it("echoes the regenerate mode for an explicit refresh", async () => {
    const { client } = await connect({});
    const result = await client.callTool({
      name: "show_dna_import",
      arguments: { mode: "regenerate" },
    });
    const envelope = structured(result);
    expect(envelope.data).toEqual({ ui_rendered: true, mode: "regenerate" });
    const meta = result._meta as { mutant?: { mode?: string } };
    expect(meta.mutant?.mode).toBe("regenerate");
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
  it("forwards the request-only analysis context without logging it", async () => {
    const logger = makeCapturingLogger();
    const { client, backendClient } = await connect({ logger });
    const context = { sex_chromosome_pattern: "XY", sex_chromosome_confidence: "high" };

    const result = await client.callTool({
      name: "create_report",
      arguments: { ...VALID_IMPORT, analysis_context: context },
    });

    expect(result.isError).toBe(false);
    expect(backendClient.calls[0]?.arguments.analysis_context).toEqual(context);

    // The transient context never reaches a log record or the log text.
    const text = logger.text();
    expect(text).not.toContain("sex_chromosome_pattern");
    expect(text).not.toContain("sex_chromosome_confidence");
    const records = logger.records().filter((entry) => entry.tool === "create_report");
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record).not.toHaveProperty("analysis_context");
      expect(record).not.toHaveProperty("sex_chromosome_pattern");
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
  it("passes the backend routing fields through unchanged", async () => {
    const nextAction = {
      tool: "show_dna_import",
      reason: "DNA data is required before an analysis can be generated.",
    };
    const { client } = await connect({
      responder: () =>
        ok({
          data: {
            dna_status: "missing",
            analysis_status: "unavailable",
            next_action: nextAction,
            regenerate: false,
          },
          analysis_version: null,
        }),
    });
    const result = await client.callTool({ name: "get_analysis_status", arguments: {} });
    const data = structured(result).data as Record<string, unknown>;
    expect(data.dna_status).toBe("missing");
    expect(data.analysis_status).toBe("unavailable");
    expect(data.next_action).toEqual(nextAction);
    expect(data.regenerate).toBe(false);
  });

  it("adds suggested prompts for a ready analysis", async () => {
    const { client } = await connect({
      responder: () =>
        ok({ data: { dna_status: "available", analysis_status: "ready", regenerate: false } }),
    });
    const result = await client.callTool({ name: "get_analysis_status", arguments: {} });
    const data = structured(result).data as Record<string, unknown>;
    const prompts = data.suggested_prompts as Array<{ id: string; prompt: string }>;
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.some((prompt) => prompt.id === "top-findings")).toBe(true);
  });

  it("suggests a refresh only when regeneration is available", async () => {
    const { client } = await connect({
      responder: () =>
        ok({
          data: {
            dna_status: "available",
            analysis_status: "ready",
            regenerate: true,
            regeneration: { required: false, current_results_usable: true },
          },
        }),
    });
    const result = await client.callTool({ name: "get_analysis_status", arguments: {} });
    const prompts = (structured(result).data as { suggested_prompts: Array<{ id: string }> })
      .suggested_prompts;
    expect(prompts.some((prompt) => prompt.id === "why-refresh")).toBe(true);
  });

  it("never rewrites or infers fields the backend omitted", async () => {
    const { client } = await connect({ responder: () => ok({ data: {} }) });
    const result = await client.callTool({ name: "get_analysis_status", arguments: {} });
    const data = structured(result).data as Record<string, unknown>;
    expect(data.dna_status).toBeUndefined();
    expect(data.analysis_status).toBeUndefined();
    expect(data.next_action).toBeUndefined();
    expect(data.regenerate).toBeUndefined();
  });
});

describe("dev-mode mock analysis lifecycle", () => {
  it("remembers an import so status polling reaches ready", async () => {
    resetMockAnalyses();
    const client = new MockMutantBackendClient({ analysisProcessingMs: 0 });
    const user = makeUser();

    const before = await client.invoke("get_analysis_status", {}, user, "req");
    expect(before.data?.dna_status).toBe("missing");

    await client.invoke("create_report", VALID_IMPORT, user, "req");

    const after = await client.invoke("get_analysis_status", {}, user, "req");
    expect(after.data?.analysis_status).toBe("ready");
    expect(after.data?.dna_status).toBe("available");
    expect(typeof after.data?.analysis_id).toBe("string");
    expect(typeof after.data?.created_at).toBe("string");
  });

  it("reports processing until the synthetic window elapses", async () => {
    resetMockAnalyses();
    const client = new MockMutantBackendClient({ analysisProcessingMs: 60_000 });
    const user = makeUser({ userId: "user-processing" });

    await client.invoke("create_report", VALID_IMPORT, user, "req");

    const status = await client.invoke("get_analysis_status", {}, user, "req");
    expect(status.data?.analysis_status).toBe("processing");
  });

  it("returns synthetic hypotheses only once an analysis exists", async () => {
    resetMockAnalyses();
    const client = new MockMutantBackendClient();
    const idle = await client.invoke("list_health_hypotheses", {}, makeUser(), "req");
    expect((idle.data?.items as unknown[]).length).toBe(0);

    const user = makeUser({ userId: "user-hypotheses" });
    await client.invoke("create_report", VALID_IMPORT, user, "req");
    const loaded = await client.invoke("list_health_hypotheses", {}, user, "req");
    expect((loaded.data?.items as unknown[]).length).toBe(3);
  });
});
