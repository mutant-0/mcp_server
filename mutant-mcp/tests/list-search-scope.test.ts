/**
 * `list_health_hypotheses.search_scope`: a Free zero-result topic search must be
 * explained as "no match among the accessible top three" rather than "the topic
 * is absent", and a Full miss must stay limited to the catalog search fields.
 *
 * The scope object is authored by the backend; the MCP layer only validates and
 * presents it, so these tests assert both the preserved `structuredContent` and
 * the exact model-facing `content`.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BackendOperation, ToolResponse } from "../src/contract.js";
import { createMcpServer } from "../src/server.js";
import {
  ANALYSIS_SCOPE,
  DNA_SCOPE,
  StubBackendClient,
  makeConfig,
  makeSuccessResponse,
  makeUser,
} from "./helpers.js";

/** Free with locked findings beyond the accessible top three. */
const FREE_NO_MATCH = {
  items: [],
  next_cursor: null,
  search_scope: {
    hypothesis_scope: "top_three",
    searched_count: 3,
    total_ranked_count: 92,
    unsearched_ranked_count: 89,
    query_outcome: "no_match_in_accessible_scope",
    broader_ranked_search_available: true,
  },
};

/** Free with nothing locked: the three findings are the whole analysis. */
const FREE_NO_LOCKED = {
  items: [],
  next_cursor: null,
  search_scope: {
    hypothesis_scope: "top_three",
    searched_count: 3,
    total_ranked_count: 3,
    unsearched_ranked_count: 0,
    query_outcome: "no_match_in_accessible_scope",
    broader_ranked_search_available: false,
  },
};

/** Full: the whole ranked set is searchable. */
const FULL_NO_MATCH = {
  items: [],
  next_cursor: null,
  search_scope: {
    hypothesis_scope: "all",
    searched_count: 4,
    total_ranked_count: 4,
    unsearched_ranked_count: 0,
    query_outcome: "no_match_in_ranked_search_fields",
    broader_ranked_search_available: false,
  },
};

/** An unfiltered list that happens to be empty carries no query outcome. */
const UNFILTERED_EMPTY = {
  items: [],
  next_cursor: null,
  search_scope: {
    hypothesis_scope: "top_three",
    searched_count: 0,
    total_ranked_count: 0,
    unsearched_ranked_count: 0,
    broader_ranked_search_available: false,
  },
};

async function callList(
  data: Record<string, unknown>,
  args: Record<string, unknown> = { query: "histamine" },
): Promise<{ content: string; envelope: ToolResponse }> {
  const backendClient = new StubBackendClient((operation: BackendOperation) =>
    operation === "list_health_hypotheses" ? makeSuccessResponse(data) : makeSuccessResponse({}),
  );
  const server = createMcpServer(
    makeUser({ scopes: [ANALYSIS_SCOPE, DNA_SCOPE] }),
    makeConfig(),
    "req-scope",
    backendClient,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "scope-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  const result = await client.callTool({ name: "list_health_hypotheses", arguments: args });
  const content = ((result.content as Array<{ text?: string }> | undefined) ?? [])
    .map((block) => block.text ?? "")
    .join("\n");
  return { content, envelope: (result as unknown as { structuredContent: ToolResponse }).structuredContent };
}

describe("list_health_hypotheses search scope", () => {
  it("preserves the server-authored search_scope in structuredContent", async () => {
    const { envelope } = await callList(FREE_NO_MATCH);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual(FREE_NO_MATCH);
    expect(envelope.analysis_version).toBe("rev42-v3.0.0");
  });

  it("explains a Free miss as bounded to the accessible top three", async () => {
    const { content } = await callList(FREE_NO_MATCH);
    expect(content).toContain("among the three findings searchable with Mutant Free");
    expect(content).toContain("cannot tell whether the topic appears elsewhere in the ranked analysis");
    expect(content).toContain("Mutant Full allows searching the complete ranked set");
    // The patient-specific query is never echoed.
    expect(content).not.toContain("histamine");
  });

  it("renders the searched count from the server value without hard-coding totals", async () => {
    const { content } = await callList({
      ...FREE_NO_MATCH,
      search_scope: { ...FREE_NO_MATCH.search_scope, searched_count: 3 },
    });
    expect(content).toContain("among the three findings");
    // The user's total ranked count is never stated.
    expect(content).not.toContain("92");
    expect(content).not.toContain("89");
  });

  it("does not suggest a wider search when Free has no locked findings", async () => {
    const { content } = await callList(FREE_NO_LOCKED);
    expect(content).toContain("No matching hypothesis was found among the three findings");
    expect(content).not.toContain("Mutant Full");
    expect(content).not.toContain("elsewhere in the ranked analysis");
  });

  it("limits a Full miss to the catalog search fields", async () => {
    const { content } = await callList(FULL_NO_MATCH);
    expect(content).toBe("No ranked hypothesis matched in the catalog search fields.");
    // Never claims the user lacks a variant, signal, or condition.
    expect(content).not.toMatch(/variant|gene|condition|None of your/i);
    expect(content).not.toContain("Mutant Free");
  });

  it("gives an unfiltered empty list no query outcome", async () => {
    const { content, envelope } = await callList(UNFILTERED_EMPTY, {});
    expect(content).toBe("No health hypotheses matched.");
    const scope = (envelope.data as { search_scope?: Record<string, unknown> }).search_scope;
    expect(scope?.query_outcome).toBeUndefined();
  });
});
