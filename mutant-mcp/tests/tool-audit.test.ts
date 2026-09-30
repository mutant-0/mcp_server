/**
 * Tool-call audit log.
 *
 * The audit record must be a bounded, safe operational schema: tool, status,
 * timing, an opaque request id, and argument *names* derived from the tool's own
 * schema. It must never carry an argument *value*, an account identifier, or a
 * caller-supplied key — that was the previous design's flaw, where a
 * short-string heuristic let health-history prose (and a user id) into
 * CloudWatch. These tests serialize the whole log for the success, scope-denial,
 * and thrown-error paths and assert that sentinel data is absent while useful
 * routing/ops signal remains.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOL_NAMES, type ToolResponse } from "../src/contract.js";
import { createMcpServer } from "../src/server.js";
import { auditToolCall, classifyThrownError, knownArgumentNames } from "../src/tools/audit.js";
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
  upload_meta: { provider: "23andMe", file_name: "Jane_Doe_raw.txt", file_size_bytes: 1234 },
  import_request_id: "12345678-abcd-4ef0-9876-1234567890ab",
};

/** The review's example of health-history prose that reached the audit log. */
const SHARED_HISTORY = "I have a rare desease";

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
    capture?: boolean;
    responder?: (operation: Parameters<typeof makeToolResponse>[0]) => ToolResponse;
  } = {},
) {
  const capture = makeCapturingLogger();
  const backendClient = new StubBackendClient(
    (operation) => options.responder?.(operation) ?? makeToolResponse(operation),
  );
  const server = createMcpServer(
    makeUser(options.scopes ? { scopes: options.scopes } : {}),
    makeConfig(
      options.capture ? { MUTANT_TRACE_CAPTURE: true, MUTANT_TRACE_CAPTURE_ID: "cap-1" } : {},
    ),
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
    text: capture.text,
    audits: () => capture.records().filter((record) => record.event === "tool_call"),
  };
}

describe("tool-call audit records", () => {
  it("records one ordered record per call with argument names but no values", async () => {
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
      argNames: [],
      requestId: "req-audit",
    });
    expect(records[1]).toMatchObject({
      status: "ok",
      argNames: ["limit", "query"],
    });
    // No account identifier and no argument value ever reach the record.
    expect(records[1]).not.toHaveProperty("args");
    expect(records[1]).not.toHaveProperty("userId");
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

  it("keeps health-history prose, filenames, genotypes, tokens, and context out of the full log", async () => {
    const { client, text } = await connect();
    await client.callTool({ name: "list_health_hypotheses", arguments: { query: SHARED_HISTORY } });
    await client.callTool({
      name: "list_health_hypotheses",
      arguments: { query: "Bearer sk-live-TOKEN-123" },
    });
    await client.callTool({
      name: "create_report",
      arguments: {
        ...CATALOG_MATCHED_IMPORT,
        analysis_context: { sex_chromosome_pattern: "XY", sex_chromosome_confidence: "high" },
      },
    });

    const serialized = text();
    for (const sentinel of [
      SHARED_HISTORY,
      "rare desease",
      "sk-live-TOKEN-123",
      "Jane_Doe_raw.txt",
      "raw.txt",
      "rs4680",
      "GG",
      "sex_chromosome_pattern",
      "sex_chromosome_confidence",
      "user-1",
    ]) {
      expect(serialized, `log must not contain ${JSON.stringify(sentinel)}`).not.toContain(sentinel);
    }
  });

  it("records a scope denial as a routing fact with a classified code", async () => {
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
      errorCode: "INSUFFICIENT_SCOPE",
      argNames: ["mode"],
    });
    expect(audits()[0]).not.toHaveProperty("args");
  });

  it("classifies a thrown error without copying its message or stack", async () => {
    const boom = new Error("Jane_Doe_raw.txt contained rs4680 GG for user-1");
    boom.name = "RangeError";
    const { client, audits, text } = await connect({
      responder: () => {
        throw boom;
      },
    });

    await client.callTool({ name: "get_analysis_status", arguments: {} }).catch(() => undefined);

    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ status: "error", errorCode: "RANGE_ERROR" });
    expect(text()).not.toContain("Jane_Doe_raw.txt");
    expect(text()).not.toContain("rs4680");
    expect(text()).not.toContain("user-1");
  });

  it("derives argument names from the tool schema and drops unknown keys", () => {
    const record = auditToolCall(
      "list_health_hypotheses",
      { bogus: "x", query: SHARED_HISTORY, limit: 2 },
      { requestId: "req-1" },
      { status: "ok", startedAt: Date.now() },
    );
    expect(record.argNames).toEqual(["limit", "query"]);
    expect(record).not.toHaveProperty("args");
    expect(knownArgumentNames("list_health_hypotheses", { bogus: "x" })).toEqual([]);
  });

  it("classifies thrown errors to a bounded code", () => {
    expect(classifyThrownError(new Error("x"))).toBe("UNEXPECTED_ERROR");
    const timeout = new Error("x");
    timeout.name = "AbortError";
    expect(classifyThrownError(timeout)).toBe("ABORTED");
    expect(classifyThrownError("a string")).toBe("UNEXPECTED_ERROR");
  });

  it("captures routing values only in a designated synthetic capture", async () => {
    const { client, audits } = await connect({ capture: true });
    await client.callTool({ name: "list_health_hypotheses", arguments: { query: "b12", limit: 2 } });
    await client.callTool({ name: "create_report", arguments: CATALOG_MATCHED_IMPORT });

    const captured = audits();
    expect(captured[0]).toMatchObject({
      capture: "synthetic",
      captureId: "cap-1",
      args: { query: "b12", limit: 2 },
    });
    // Even a capture never routes genotypes, filenames, or the transient context.
    expect(captured[1]?.args).toEqual({
      import_request_id: CATALOG_MATCHED_IMPORT.import_request_id,
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
});
