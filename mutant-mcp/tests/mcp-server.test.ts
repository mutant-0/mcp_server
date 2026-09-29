import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BackendOperation, ToolResponse } from "../src/contract.js";
import { SERVER_INSTRUCTIONS, SERVER_NAME, createMcpServer } from "../src/server.js";
import { TOOL_NAMES } from "../src/contract.js";
import {
  ANALYSIS_SCOPE,
  DNA_SCOPE,
  makeConfig,
  makeContextData,
  makeErrorResponse,
  makeStatusData,
  makeSuccessResponse,
  makeToolResponse,
  makeUser,
  StubBackendClient,
} from "./helpers.js";

async function connectServer(
  responder: (operation: BackendOperation) => ToolResponse = (operation) =>
    makeToolResponse(operation),
) {
  const backendClient = new StubBackendClient((operation) => responder(operation));
  const server = createMcpServer(makeUser(), makeConfig(), "req-test", backendClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { server, client, backendClient };
}

describe("MCP server integration", () => {
  it("lists the twelve contract tools with schemas", async () => {
    const { client } = await connectServer();
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(result.tools).toHaveLength(12);
    for (const tool of result.tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
    }
  });

  it("advertises each tool's own OAuth scope", async () => {
    const { client } = await connectServer();
    const result = await client.listTools();
    const dnaTools = new Set(["show_dna_import", "get_snp_catalog", "create_report"]);
    for (const tool of result.tools) {
      const meta = tool._meta as { securitySchemes?: Array<{ scopes: string[] }> } | undefined;
      const expected = dnaTools.has(tool.name) ? DNA_SCOPE : ANALYSIS_SCOPE;
      expect(meta?.securitySchemes?.[0]?.scopes).toEqual([expected]);
    }
  });

  it("binds the overview card to one resolved snapshot", async () => {
    const backendClient = new StubBackendClient((operation) => makeToolResponse(operation));
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
      displayed_analysis_version: "rev42-v3.0.0",
      displayed_hypotheses: [{ id: "HYP_A", rank: 1, name: "Alpha finding" }],
      total_accessible_count: 1,
      has_more: false,
    });
    expect((result._meta as { ui?: { resourceUri?: string } }).ui?.resourceUri).toBe(
      "ui://mutant/dna-import/v1.html",
    );
    // The card resolves exactly one snapshot, so it can never render a revision
    // other than the one the model was told about.
    expect(backendClient.calls.map((call) => call.operation)).toEqual([
      "resolve_analysis_snapshot",
    ]);
  });

  it("never mounts the overview card for a failed snapshot resolution", async () => {
    const { client } = await connectServer(() =>
      makeErrorResponse("ANALYSIS_NOT_READY", "not servable yet", {
        reason: "analysis_payload_pending",
      }),
    );
    const result = await client.callTool({ name: "show_analysis_overview", arguments: {} });
    expect(result.isError).toBe(true);
    const meta = result._meta as
      | { ui?: unknown; mutant?: unknown; "openai/outputTemplate"?: unknown }
      | undefined;
    // An unready analysis is a structured error, never a card: the overview
    // component must not mount from a failed snapshot resolution.
    expect(meta?.ui).toBeUndefined();
    expect(meta?.mutant).toBeUndefined();
    expect(meta?.["openai/outputTemplate"]).toBeUndefined();
  });

  it("advertises the resources capability for the Apps SDK component", async () => {
    const { client } = await connectServer();
    expect(client.getServerCapabilities()?.resources).toBeDefined();
  });

  it("relays a success envelope into structuredContent with deterministic content", async () => {
    const { client } = await connectServer(() => makeSuccessResponse(makeStatusData()));
    const result = await client.callTool({ name: "get_analysis_status", arguments: {} });
    expect(result.isError).toBe(false);
    const structured = result.structuredContent as { ok: boolean; data: unknown };
    expect(structured.ok).toBe(true);
    // The tool is a pass-through: the backend owns every status field.
    expect(structured.data).toMatchObject({
      dna_status: "available",
      experience_state: "READY",
    });
    // Suggested prompts are injected at the MCP boundary.
    expect((structured.data as { suggested_prompts?: unknown[] }).suggested_prompts).toBeDefined();

    // The model-facing text is deterministic prose, never a serialized envelope.
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toContain("ready");
    expect(content[0]?.text).toContain("show_analysis_overview");
    expect(content[0]?.text).not.toContain("contract_version");
    expect(content[0]?.text).not.toContain('"data"');
    expect((result._meta as { ui?: unknown } | undefined)?.ui).toBeUndefined();
  });

  it("replaces backend-local checkout URLs with the public portal URL", async () => {
    const { client } = await connectServer((operation) =>
      makeSuccessResponse(
        operation === "get_analysis_context"
          ? makeContextData({
              upgrade: { label: "Unlock Full Analysis", url: "http://localhost:3000/cart" },
            })
          : makeStatusData({
              upgrade: { label: "Unlock Full Analysis", url: "http://localhost:3000/cart" },
            }),
      ),
    );
    const context = await client.callTool({ name: "get_analysis_context", arguments: {} });
    const status = await client.callTool({ name: "get_analysis_status", arguments: {} });
    // Every upgrade link carries the ChatGPT source tag so the destination can
    // see that the card prompted it.
    expect((context.structuredContent as ToolResponse).data?.upgrade).toEqual({
      label: "Unlock Full Analysis",
      url: "https://mutantgenomics.com/upgrade?source=chatgpt",
    });
    expect((status.structuredContent as ToolResponse).data?.upgrade).toEqual({
      label: "Unlock Full Analysis",
      url: "https://mutantgenomics.com/upgrade?source=chatgpt",
    });
  });

  it("points a PLAN_REQUIRED recovery link at the tagged public portal URL", async () => {
    const { client } = await connectServer(() =>
      makeErrorResponse("PLAN_REQUIRED", "This finding needs Mutant Full.", {
        required_plan: "mutant_full",
        upgrade_url: "http://localhost:3000/cart",
      }),
    );
    const result = await client.callTool({
      name: "explain_health_hypothesis",
      arguments: { hypothesis_id: "HYP_D" },
    });
    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as ToolResponse;
    expect(envelope.error?.code).toBe("PLAN_REQUIRED");
    // The recovery link never leaks an internal origin and stays attributable.
    expect(envelope.error?.upgrade_url).toBe(
      "https://mutantgenomics.com/upgrade?source=chatgpt",
    );
  });

  it("keeps the status tool card-free for a ready analysis with an available update", async () => {
    const { client } = await connectServer(() =>
      makeSuccessResponse(makeStatusData({ experience_state: "READY_REFRESH_AVAILABLE" })),
    );
    const result = await client.callTool({ name: "get_analysis_status", arguments: {} });
    // Status is a routing read, never a UI response: no UI descriptor is carried
    // even when a refresh is available, so a status-only path cannot imply a card.
    const meta = result._meta as
      | { ui?: unknown; mutant?: unknown; "openai/outputTemplate"?: unknown }
      | undefined;
    expect(meta?.ui).toBeUndefined();
    expect(meta?.mutant).toBeUndefined();
    expect(meta?.["openai/outputTemplate"]).toBeUndefined();
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain(
      "refreshing is optional and your current results remain usable",
    );
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain("show_analysis_overview");
  });

  it("advertises the overview UI descriptor on the display tool", async () => {
    const { client } = await connectServer(() => makeSuccessResponse(makeStatusData()));
    const tools = await client.listTools();
    const overview = tools.tools.find((tool) => tool.name === "show_analysis_overview");
    const meta = overview?._meta as
      | { ui?: { resourceUri?: string }; "openai/outputTemplate"?: string }
      | undefined;
    expect(meta?.ui?.resourceUri).toBe("ui://mutant/dna-import/v1.html");
    expect(meta?.["openai/outputTemplate"]).toBe("ui://mutant/dna-import/v1.html");
    // The general-purpose status tool declares no UI resource at all.
    const status = tools.tools.find((tool) => tool.name === "get_analysis_status");
    const statusMeta = status?._meta as
      | { ui?: unknown; "openai/outputTemplate"?: unknown }
      | undefined;
    expect(statusMeta?.ui).toBeUndefined();
    expect(statusMeta?.["openai/outputTemplate"]).toBeUndefined();
  });

  it("relays a structured error envelope and sets isError", async () => {
    const { client } = await connectServer(() =>
      makeErrorResponse("PLAN_REQUIRED", "locked", {
        required_plan: "mutant_full",
        next_action: { tool: "show_dna_import", reason: "Upgrade to continue." },
      }),
    );
    const result = await client.callTool({
      name: "explain_health_hypothesis",
      arguments: { hypothesis_id: "RC_D" },
    });
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as { ok: boolean; error: { code: string } };
    expect(structured.ok).toBe(false);
    expect(structured.error.code).toBe("PLAN_REQUIRED");
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
    const { client, backendClient } = await connectServer();
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
    const { client, backendClient } = await connectServer();
    const result = await client.callTool({ name: "explain_health_hypothesis", arguments: {} });
    expect(result.isError).toBe(true);
    expect(backendClient.calls).toHaveLength(0);
  });

  it("uses the Mutant server name", async () => {
    const { client } = await connectServer();
    expect(SERVER_NAME).toBe("mutant-mcp");
    expect(client).toBeDefined();
  });

  it("routes the three entry prompts safely from a fresh conversation", () => {
    // These are the pre-message starter prompts; every one of them must begin at
    // status and follow the reported state, and comparison must never forward the
    // user's history prose as a catalog search query.
    expect(SERVER_INSTRUCTIONS).toContain(
      "Which of my Mutant findings best fits the health history or records I've shared here?",
    );
    expect(SERVER_INSTRUCTIONS).toContain("Show my current Mutant findings.");
    expect(SERVER_INSTRUCTIONS).toContain("Help me add my DNA data to Mutant.");
    expect(SERVER_INSTRUCTIONS).toContain("Call get_analysis_status first for every one of them");
    expect(SERVER_INSTRUCTIONS).toContain(
      "Never pass the user's health-history prose as the list_health_hypotheses query argument",
    );
    expect(SERVER_INSTRUCTIONS).toContain(
      "no promised future results and no extra polling instructions",
    );
  });

  it("passes the modules evidence kind and include_context to the backend", async () => {
    const { client, backendClient } = await connectServer();
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
    const { client } = await connectServer(() => makeSuccessResponse(makeStatusData()));
    const result = await client.callTool({ name: "get_analysis_status", arguments: {} });
    const structured = JSON.stringify(result.structuredContent);
    const content = ((result.content as Array<{ text?: string }> | undefined) ?? [])
      .map((block) => block.text ?? "")
      .join("\n");
    expect(content).not.toContain(structured);
    expect(content).not.toMatch(/^\s*[{[]/);
  });
});

describe("server instructions pin the explanation contract", () => {
  const text = SERVER_INSTRUCTIONS;

  it("forbids attributing catalog guidance to the user", () => {
    expect(text).toContain("authorized context source");
    expect(text).toContain("never restate them as the user's history");
    expect(text).toContain("never send personal history to Mutant");
  });

  it("separates ranking from support and keeps coverage scopes distinct", () => {
    expect(text).toContain("priority_score only for ordering");
    expect(text).toContain("genetic_support only for strength");
    expect(text).toContain("assessability");
    expect(text).toContain("marker-call completeness");
  });

  it("states that pattern-led is not broad distribution", () => {
    expect(text).toContain("not that it is broadly distributed");
    expect(text).toContain("participating-variant counts");
  });
});

/** The two states where no usable analysis exists yet. */
const PROCESSING_STATES = [
  { state: "PROCESSING_INITIAL", text: "Analysis is processing." },
  { state: "REFRESH_PROCESSING_NO_USABLE_ANALYSIS", text: "Analysis refresh is processing." },
] as const;

function processingStatusData(state: string): Record<string, unknown> {
  return makeStatusData({
    experience_state: state,
    active_analysis: { status: "none", usable: false },
    pending_analysis: {
      status: "processing",
      reason: state === "PROCESSING_INITIAL" ? "initial_analysis" : "platform_refresh",
    },
    capabilities: {
      can_query_analysis: false,
      can_show_overview: false,
      can_refresh_analysis: false,
      can_search_hypotheses: false,
      can_explore_genetic_context: false,
    },
    next_action: {
      tool: "get_analysis_status",
      reason: "The analysis is still processing; call again shortly for an update.",
    },
  });
}

describe("processing-state UX (component-owned)", () => {
  for (const { state, text } of PROCESSING_STATES) {
    it(`omits prompts, shortens content, and keeps flags false for ${state}`, async () => {
      const { client } = await connectServer(() => makeSuccessResponse(processingStatusData(state)));
      for (const tool of ["get_analysis_status", "poll_analysis_status"]) {
        const result = await client.callTool({ name: tool, arguments: {} });
        expect(result.isError).toBe(false);
        const structured = result.structuredContent as ToolResponse;
        expect(structured.ok).toBe(true);
        expect(structured.error).toBeNull();
        const data = structured.data as Record<string, unknown>;
        // Property absence, not null/empty.
        expect("suggested_prompts" in data).toBe(false);
        expect(data.capabilities).toEqual({
          can_query_analysis: false,
          can_show_overview: false,
          can_refresh_analysis: false,
          can_search_hypotheses: false,
          can_explore_genetic_context: false,
        });
        const content = (result.content as Array<{ text: string }>)[0]?.text;
        expect(content).toBe(text);
      }
    });

    it(`keeps the polling next_action only on the model path (${state})`, async () => {
      const { client } = await connectServer(() => makeSuccessResponse(processingStatusData(state)));
      const model = (await client.callTool({ name: "get_analysis_status", arguments: {} }))
        .structuredContent as ToolResponse;
      expect((model.data as Record<string, unknown>).next_action).toEqual({
        tool: "get_analysis_status",
        reason: "The analysis is still processing; call again shortly for an update.",
      });
      const component = (await client.callTool({ name: "poll_analysis_status", arguments: {} }))
        .structuredContent as ToolResponse;
      expect("next_action" in (component.data as Record<string, unknown>)).toBe(false);
    });
  }

  it("hides poll_analysis_status from the model", async () => {
    const { client } = await connectServer();
    const result = await client.listTools();
    const tool = result.tools.find((entry) => entry.name === "poll_analysis_status");
    const visibility = (tool?._meta as { ui?: { visibility?: string[] } } | undefined)?.ui
      ?.visibility;
    expect(visibility).toEqual(["app"]);
  });
});
