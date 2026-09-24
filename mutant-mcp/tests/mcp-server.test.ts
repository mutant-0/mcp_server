import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolResponse } from "../src/contract.js";
import { SERVER_NAME, createMcpServer } from "../src/server.js";
import { TOOL_NAMES } from "../src/contract.js";
import {
  ANALYSIS_SCOPE,
  DNA_SCOPE,
  makeConfig,
  makeErrorResponse,
  makeSuccessResponse,
  makeUser,
  StubBackendClient,
} from "./helpers.js";

async function connectServer(responder: (operation: string) => ToolResponse) {
  const backendClient = new StubBackendClient((operation) => responder(operation));
  const server = createMcpServer(makeUser(), makeConfig(), "req-test", backendClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { server, client, backendClient };
}

describe("MCP server integration", () => {
  it("lists the ten contract tools with schemas", async () => {
    const { client } = await connectServer(() => makeSuccessResponse());
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(result.tools).toHaveLength(10);
    for (const tool of result.tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
    }
  });

  it("advertises each tool's own OAuth scope", async () => {
    const { client } = await connectServer(() => makeSuccessResponse());
    const result = await client.listTools();
    const dnaTools = new Set(["show_dna_import", "get_snp_catalog", "create_report"]);
    for (const tool of result.tools) {
      const meta = tool._meta as { securitySchemes?: Array<{ scopes: string[] }> } | undefined;
      const expected = dnaTools.has(tool.name) ? DNA_SCOPE : ANALYSIS_SCOPE;
      expect(meta?.securitySchemes?.[0]?.scopes).toEqual([expected]);
    }
  });

  it("renders the overview card with analysis.read and without a backend call", async () => {
    const backendClient = new StubBackendClient(() => makeSuccessResponse());
    const server = createMcpServer(
      makeUser({ scopes: [ANALYSIS_SCOPE] }),
      makeConfig(),
      "req-overview",
      backendClient,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "show_analysis_overview", arguments: {} });
    expect(result.isError).toBe(false);
    expect((result.structuredContent as ToolResponse).data).toEqual({
      ui_rendered: true,
      mode: "overview",
    });
    expect((result._meta as { ui?: { resourceUri?: string } }).ui?.resourceUri).toBe(
      "ui://mutant/dna-import/v1.html",
    );
    expect(backendClient.calls).toHaveLength(0);
  });

  it("advertises the resources capability for the Apps SDK component", async () => {
    const { client } = await connectServer(() => makeSuccessResponse());
    expect(client.getServerCapabilities()?.resources).toBeDefined();
  });

  it("relays a success envelope into structuredContent with deterministic content", async () => {
    const { client } = await connectServer(() =>
      makeSuccessResponse({
        dna_status: "available",
        analysis_status: "ready",
        analysis: { generated_at: "2026-01-01" },
      }),
    );
    const result = await client.callTool({ name: "get_analysis_status", arguments: {} });
    expect(result.isError).toBe(false);
    const structured = result.structuredContent as { ok: boolean; data: unknown };
    expect(structured.ok).toBe(true);
    // The tool is a pass-through: the backend owns every status field.
    expect(structured.data).toMatchObject({ dna_status: "available", analysis_status: "ready" });
    // Suggested prompts are injected at the MCP boundary.
    expect(
      (structured.data as { suggested_prompts?: unknown[] }).suggested_prompts,
    ).toBeDefined();

    // The model-facing text is deterministic prose, never a serialized envelope.
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toContain("ready");
    expect(content[0]?.text).toContain("show_analysis_overview");
    expect(content[0]?.text).not.toContain("contract_version");
    expect(content[0]?.text).not.toContain('"data"');
    expect((result._meta as { ui?: unknown } | undefined)?.ui).toBeUndefined();
  });

  it("mounts the refresh card from a ready status with an available update", async () => {
    const { client } = await connectServer(() =>
      makeSuccessResponse({
        dna_status: "available",
        analysis_status: "ready",
        regenerate: true,
        regeneration: { required: false, current_results_usable: true },
      }),
    );
    const result = await client.callTool({ name: "get_analysis_status", arguments: {} });
    const meta = result._meta as { ui?: { resourceUri?: string }; mutant?: { mode?: string } };
    expect(meta.ui?.resourceUri).toBe("ui://mutant/dna-import/v1.html");
    expect(meta.mutant?.mode).toBe("overview");
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain(
      "The analysis card offers a refresh action.",
    );
  });

  it("relays a structured error envelope and sets isError", async () => {
    const { client } = await connectServer(() =>
      makeErrorResponse("PLAN_ACCESS_REQUIRED", "locked", { required_plan: "mutant_full" }),
    );
    const result = await client.callTool({
      name: "explain_health_hypothesis",
      arguments: { hypothesis_id: "RC_D" },
    });
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as { ok: boolean; error: { code: string } };
    expect(structured.ok).toBe(false);
    expect(structured.error.code).toBe("PLAN_ACCESS_REQUIRED");
  });

  it("adds a tool-level OAuth challenge for auth errors", async () => {
    const { client } = await connectServer(() =>
      makeErrorResponse("AUTHENTICATION_REQUIRED", "token expired"),
    );
    const result = await client.callTool({ name: "get_analysis_status", arguments: {} });
    expect(result.isError).toBe(true);
    const meta = result._meta as { "mcp/www_authenticate"?: string[] } | undefined;
    const challenge = meta?.["mcp/www_authenticate"]?.[0];
    expect(challenge).toContain("Bearer ");
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(
      "https://mcp.mutantgenomics.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("passes the operation, arguments, and token-derived identity to the backend", async () => {
    const { client, backendClient } = await connectServer(() => makeSuccessResponse());
    await client.callTool({
      name: "get_supporting_evidence",
      arguments: { hypothesis_id: "RC_A", kind: "variants" },
    });
    expect(backendClient.calls).toHaveLength(1);
    expect(backendClient.calls[0]?.operation).toBe("get_supporting_evidence");
    expect(backendClient.calls[0]?.arguments).toEqual({ hypothesis_id: "RC_A", kind: "variants" });
    expect(backendClient.calls[0]?.userId).toBe("user-1");
  });

  it("rejects invalid arguments before calling the backend", async () => {
    const { client, backendClient } = await connectServer(() => makeSuccessResponse());
    const result = await client.callTool({ name: "explain_health_hypothesis", arguments: {} });
    expect(result.isError).toBe(true);
    expect(backendClient.calls).toHaveLength(0);
  });

  it("uses the Mutant server name", async () => {
    const { client } = await connectServer(() => makeSuccessResponse());
    expect(SERVER_NAME).toBe("mutant-mcp");
    expect(client).toBeDefined();
  });

  it("passes the modules evidence kind and include_context to the backend", async () => {
    const { client, backendClient } = await connectServer(() => makeSuccessResponse());
    await client.callTool({
      name: "get_supporting_evidence",
      arguments: { hypothesis_id: "RC_A", kind: "modules", include_context: true },
    });
    expect(backendClient.calls[0]?.arguments).toEqual({
      hypothesis_id: "RC_A",
      kind: "modules",
      include_context: true,
    });
  });

  it("never duplicates structuredContent into the model-facing content", async () => {
    const { client } = await connectServer(() => makeSuccessResponse());
    const result = await client.callTool({ name: "get_analysis_status", arguments: {} });
    const structured = JSON.stringify(result.structuredContent);
    const content = ((result.content as Array<{ text?: string }> | undefined) ?? [])
      .map((block) => block.text ?? "")
      .join("\n");
    expect(content).not.toContain(structured);
    expect(content).not.toMatch(/^\s*[{[]/);
  });
});
