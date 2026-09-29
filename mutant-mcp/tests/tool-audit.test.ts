/**
 * Tool-call audit log.
 *
 * The audit record is what makes the golden-prompt routing fixture recordable
 * from real traffic: one `event: "tool_call"` per call, in order, carrying the
 * arguments the routing evaluation asserts on and nothing else. These tests pin
 * both halves — that every registered tool is audited by construction, and that
 * the record cannot become a place where genotypes, the transient
 * sex-chromosome context, or the user's health prose end up in CloudWatch.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOL_NAMES, type ToolResponse } from "../src/contract.js";
import { createMcpServer } from "../src/server.js";
import { REDACTED_ARGUMENT, isCatalogKeyword } from "../src/tools/audit.js";
import {
  ANALYSIS_SCOPE,
  StubBackendClient,
  makeCapturingLogger,
  makeConfig,
  makeToolResponse,
  makeUser,
} from "./helpers.js";

const CATALOG_MATCHED_IMPORT = {
  snps: { rs4680: "GG", rs328: "CG" },
  upload_meta: { provider: "23andMe", file_name: "raw.txt", file_size_bytes: 1234 },
  import_request_id: "12345678-abcd-4ef0-9876-1234567890ab",
};

const SHARED_HISTORY =
  "I have had fatigue and brain fog for months and my B12 was low in March 2024.";

/** One valid call per registered tool, so the audit wrapper is exercised for all. */
const CALLS: Array<{ name: string; arguments: Record<string, unknown> }> = [
  { name: "get_analysis_status", arguments: {} },
  { name: "poll_analysis_status", arguments: {} },
  { name: "show_analysis_overview", arguments: {} },
  { name: "get_analysis_context", arguments: {} },
  { name: "list_health_hypotheses", arguments: {} },
  { name: "explain_health_hypothesis", arguments: { hypothesis_id: "HYP_A" } },
  { name: "get_supporting_evidence", arguments: { hypothesis_id: "HYP_A" } },
  { name: "get_genetic_context", arguments: { gene: "HNMT" } },
  { name: "show_dna_import", arguments: { mode: "initial" } },
  { name: "get_snp_catalog", arguments: {} },
  { name: "create_report", arguments: CATALOG_MATCHED_IMPORT },
  {
    name: "show_analysis_followups",
    arguments: {
      intent: "explanation",
      analysis_version: "rev42-v3.0.0",
      hypothesis_ids: ["HYP_A"],
    },
  },
];

async function connect(
  options: {
    scopes?: string[];
    responder?: (operation: Parameters<typeof makeToolResponse>[0]) => ToolResponse;
  } = {},
) {
  const capture = makeCapturingLogger();
  const backendClient = new StubBackendClient(
    (operation) => options.responder?.(operation) ?? makeToolResponse(operation),
  );
  const server = createMcpServer(
    makeUser(options.scopes ? { scopes: options.scopes } : {}),
    makeConfig(),
    "req-audit",
    backendClient,
    capture.logger,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "audit-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    backendClient,
    records: capture.records,
    audits: () => capture.records().filter((record) => record.event === "tool_call"),
  };
}

describe("tool-call audit records", () => {
  it("records one ordered record per call, with the audited arguments", async () => {
    const { client, audits } = await connect();
    await client.callTool({ name: "get_analysis_status", arguments: {} });
    await client.callTool({
      name: "list_health_hypotheses",
      arguments: { query: "b12", limit: 3 },
    });

    const records = audits();
    expect(records.map((record) => record.tool)).toEqual([
      "get_analysis_status",
      "list_health_hypotheses",
    ]);
    expect(records[0]).toMatchObject({
      event: "tool_call",
      status: "ok",
      argKeys: [],
      args: {},
      userId: "user-1",
      requestId: "req-audit",
    });
    expect(records[1]).toMatchObject({
      status: "ok",
      argKeys: ["limit", "query"],
      args: { query: "b12", limit: 3 },
    });
    expect(typeof records[1]?.durationMs).toBe("number");
  });

  it("audits every registered tool, so a new tool cannot skip the record", async () => {
    const { client, audits } = await connect();
    for (const call of CALLS) await client.callTool(call);

    // The call list is exhaustive: a tool added to TOOL_NAMES without a call
    // here fails this assertion rather than going unaudited.
    expect(CALLS.map((call) => call.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(audits().map((record) => record.tool)).toEqual(CALLS.map((call) => call.name));
    expect(audits().every((record) => record.status === "ok")).toBe(true);
  });

  it("withholds a search query that is not a catalog keyword", async () => {
    const { client, audits } = await connect();
    await client.callTool({
      name: "list_health_hypotheses",
      arguments: { query: SHARED_HISTORY },
    });

    const record = audits()[0];
    expect(record?.args).toEqual({ query: REDACTED_ARGUMENT });
    // The key is still visible, so a withheld value is visibly withheld.
    expect(record?.argKeys).toEqual(["query"]);
  });

  it("keeps genotypes, upload metadata, and the transient context out of the record", async () => {
    const { client, audits } = await connect();
    await client.callTool({
      name: "create_report",
      arguments: {
        ...CATALOG_MATCHED_IMPORT,
        analysis_context: { sex_chromosome_pattern: "XY", sex_chromosome_confidence: "high" },
      },
    });

    const record = audits()[0];
    expect(record?.tool).toBe("create_report");
    expect(record?.args).toEqual({
      import_request_id: CATALOG_MATCHED_IMPORT.import_request_id,
    });
    // The withheld values are recorded by key only.
    expect(record?.argKeys).toEqual(
      ["analysis_context", "import_request_id", "snps", "upload_meta"].sort(),
    );
  });

  it("records an rsID lookup by key, not by value", async () => {
    const { client, audits } = await connect();
    await client.callTool({
      name: "get_genetic_context",
      arguments: { rsids: ["rs4680"], limit: 5 },
    });

    const record = audits()[0];
    expect(record?.args).toEqual({ limit: 5 });
    expect(record?.argKeys).toEqual(["limit", "rsids"]);
  });

  it("records a scope denial as a routing fact instead of a call", async () => {
    const { client, audits, backendClient } = await connect({ scopes: [ANALYSIS_SCOPE] });
    const result = await client.callTool({
      name: "show_dna_import",
      arguments: { mode: "initial" },
    });

    expect(result.isError).toBe(true);
    expect(backendClient.calls).toHaveLength(0);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      tool: "show_dna_import",
      status: "scope_denied",
      args: { mode: "initial" },
    });
  });

  it("marks the audit record apart from a tool's own log records", async () => {
    const { client, records } = await connect();
    await client.callTool({ name: "create_report", arguments: CATALOG_MATCHED_IMPORT });

    const forCreateReport = records().filter((record) => record.tool === "create_report");
    const audit = forCreateReport.filter((record) => record.event === "tool_call");
    expect(audit).toHaveLength(1);
    // The tool's own records describe the import (a submission and a completion)
    // and carry no `event`, so log assertions can address them separately.
    expect(forCreateReport.length).toBeGreaterThan(audit.length);
  });

  it("classifies keyword-shaped queries only", () => {
    for (const keyword of ["b12", "thyroid", "histamine intolerance", "COMT"]) {
      expect(isCatalogKeyword(keyword)).toBe(true);
    }
    for (const prose of [SHARED_HISTORY, "", "x".repeat(65), "what about my thyroid issues?"]) {
      expect(isCatalogKeyword(prose)).toBe(false);
    }
  });
});
