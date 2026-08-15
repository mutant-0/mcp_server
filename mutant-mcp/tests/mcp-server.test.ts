import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MutantUserContext } from "../src/auth/user-context.js";
import type { AppConfig } from "../src/config.js";
import { createMcpServer } from "../src/server.js";
import { makeConfig, makeUser } from "./helpers.js";

async function connectServer(ctx: MutantUserContext, config: AppConfig) {
  const server = createMcpServer(ctx, config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { server, client };
}

const ALL_TOOLS = [
  "get_analysis_status",
  "get_genomic_overview",
  "get_genetic_context",
  "get_variant_context",
  "get_root_cause_details",
  "get_supporting_evidence",
  "get_relevant_tests",
];

describe("MCP server integration", () => {
  it("lists all seven tools with valid schemas", async () => {
    const { client } = await connectServer(makeUser("paid"), makeConfig());
    const result = await client.listTools();
    expect(result.tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
    for (const tool of result.tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
    }
  });

  it("returns a placeholder for a free tool", async () => {
    const { client } = await connectServer(makeUser("free"), makeConfig());
    const result = await client.callTool({ name: "get_genomic_overview", arguments: {} });
    const structured = result.structuredContent as { status: string; tool: string };
    expect(structured.status).toBe("not_implemented");
    expect(structured.tool).toBe("get_genomic_overview");
  });

  it("returns upgrade_required when a free user calls a paid tool", async () => {
    const { client } = await connectServer(makeUser("free"), makeConfig());
    const result = await client.callTool({
      name: "get_root_cause_details",
      arguments: { rootCauseId: "rc-1" },
    });
    const structured = result.structuredContent as {
      status: string;
      required_tier: string;
      upgrade_url: string;
    };
    expect(structured.status).toBe("upgrade_required");
    expect(structured.required_tier).toBe("paid");
    expect(structured.upgrade_url).toBe("https://mutantgenomics.com/upgrade");
  });

  it("returns a placeholder when a paid user calls a paid tool", async () => {
    const { client } = await connectServer(makeUser("paid"), makeConfig());
    const result = await client.callTool({
      name: "get_root_cause_details",
      arguments: { rootCauseId: "rc-1" },
    });
    const structured = result.structuredContent as { status: string };
    expect(structured.status).toBe("not_implemented");
  });

  it("returns a schema error for invalid arguments", async () => {
    const { client } = await connectServer(makeUser("paid"), makeConfig());
    const result = await client.callTool({ name: "get_variant_context", arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string }>;
    expect(content[0]?.type).toBe("text");
  });
});
