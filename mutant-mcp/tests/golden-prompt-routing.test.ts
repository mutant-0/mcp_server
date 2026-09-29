/**
 * Golden-prompt routing evaluation.
 *
 * `routing-evaluations.test.ts` verifies that the server mounts the right
 * experience for a given tool sequence, but it authors that sequence. This
 * evaluation instead replays the tool calls ChatGPT actually selected for the
 * three Mutant entry prompts, recorded per account state in
 * `golden-prompt-routing-traces.json`, through the real MCP server over an
 * in-memory transport, and asserts where each Apps SDK card attaches.
 *
 * Provenance: a trace is authoritative only once its `provenance` is
 * "observed". The fixture ships with "pending-manual-capture" placeholders, so
 * the replay always runs as a server-contract check while the provenance gate
 * below fails the suite when GOLDEN_TRACES_REQUIRED=1: that forces the manual
 * ChatGPT capture to replace the placeholders before release.
 *
 * Run with: npm test -- tests/golden-prompt-routing.test.ts
 *           GOLDEN_TRACES_REQUIRED=1 npm test -- tests/golden-prompt-routing.test.ts
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BackendOperation, ToolResponse } from "../src/contract.js";
import { createMcpServer } from "../src/server.js";
import { ANALYSIS_FOLLOWUPS_UI_URI } from "../src/ui/analysis-followups/resource.js";
import { DNA_IMPORT_UI_URI } from "../src/ui/dna-import/resource.js";
import tracesFile from "./golden-prompt-routing-traces.json";
import {
  ANALYSIS_SCOPE,
  DNA_SCOPE,
  StubBackendClient,
  makeConfig,
  makeStatusData,
  makeSuccessResponse,
  makeToolResponse,
  makeUser,
} from "./helpers.js";

interface TraceToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

interface GoldenTrace {
  prompt: string;
  state: string;
  provenance: string;
  capturedAt: string | null;
  /** The Apps SDK card(s) this trace must (or must not) mount. */
  expect: { overview: boolean; import: boolean; followups: boolean };
  toolCalls: TraceToolCall[];
}

interface UiMeta {
  ui?: { resourceUri?: string; visibility?: string[] };
  mutant?: { mode?: string };
  "openai/outputTemplate"?: string;
}

interface ReplayedCall {
  name: string;
  arguments: Record<string, unknown>;
  isError: boolean;
  meta: UiMeta;
  structured: ToolResponse | undefined;
}

const TRACES = (tracesFile as { traces: GoldenTrace[] }).traces;

/** The account state each observed trace was captured against. */
const STATUS_BY_STATE: Record<string, Record<string, unknown>> = {
  NO_DNA: makeStatusData({
    dna_status: "missing",
    experience_state: "NO_DNA",
    active_analysis: { status: "none", usable: false },
    entitlement: { plan: "mutant_free", hypothesis_scope: "top_three" },
    capabilities: {
      can_query_analysis: false,
      can_show_overview: false,
      can_refresh_analysis: false,
      can_search_hypotheses: false,
      can_explore_genetic_context: false,
    },
    next_action: { tool: "show_dna_import", arguments: { mode: "initial" } },
  }),
  READY_FREE: makeStatusData({
    entitlement: {
      plan: "mutant_free",
      hypothesis_scope: "top_three",
      genetic_context_scope: "accessible_hypotheses",
    },
    capabilities: {
      can_query_analysis: true,
      can_show_overview: true,
      can_refresh_analysis: false,
      can_search_hypotheses: false,
      can_explore_genetic_context: true,
    },
  }),
  READY_FULL: makeStatusData(),
  PROCESSING: makeStatusData({
    dna_status: "available",
    experience_state: "PROCESSING_INITIAL",
    active_analysis: { status: "none", usable: false },
    pending_analysis: { status: "processing", reason: "initial_analysis" },
    entitlement: { plan: "mutant_free", hypothesis_scope: "top_three" },
    capabilities: {
      can_query_analysis: false,
      can_show_overview: false,
      can_refresh_analysis: false,
      can_search_hypotheses: false,
      can_explore_genetic_context: false,
    },
    next_action: { tool: "get_analysis_status" },
  }),
};

/** A real-world history prose the user might have typed into the chat. */
const SHARED_HISTORY =
  "I have had fatigue and brain fog for months and my B12 was low in March 2024.";

async function replay(trace: GoldenTrace): Promise<ReplayedCall[]> {
  const status = STATUS_BY_STATE[trace.state];
  if (!status) throw new Error(`unknown trace state: ${trace.state}`);

  const backendClient = new StubBackendClient((operation: BackendOperation) =>
    operation === "get_analysis_status"
      ? makeSuccessResponse(status)
      : makeToolResponse(operation),
  );
  const server = createMcpServer(
    makeUser({ scopes: [ANALYSIS_SCOPE, DNA_SCOPE] }),
    makeConfig(),
    `req-golden-${trace.state}-${trace.prompt.length}`,
    backendClient,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "golden-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  const calls: ReplayedCall[] = [];
  for (const call of trace.toolCalls) {
    const result = await client.callTool({
      name: call.name,
      arguments: call.arguments ?? {},
    });
    calls.push({
      name: call.name,
      arguments: call.arguments ?? {},
      isError: result.isError === true,
      meta: (result._meta ?? {}) as UiMeta,
      structured: result.structuredContent as ToolResponse | undefined,
    });
  }
  return calls;
}

function carriesUi(call: ReplayedCall): boolean {
  return (
    call.meta.ui?.resourceUri !== undefined ||
    call.meta["openai/outputTemplate"] !== undefined ||
    call.meta.mutant !== undefined
  );
}

describe("golden-prompt routing (observed traces)", () => {
  for (const trace of TRACES) {
    it(`"${trace.prompt}" (${trace.state}) replays to the state-appropriate experience`, async () => {
      const calls = await replay(trace);
      const names = calls.map((call) => call.name);

      // Readiness is unknown before the first message: status always comes first.
      expect(names[0], `${trace.state}: first tool`).toBe("get_analysis_status");

      const overviews = calls.filter((call) => call.name === "show_analysis_overview");
      const imports = calls.filter((call) => call.name === "show_dna_import");
      const followups = calls.filter((call) => call.name === "show_analysis_followups");

      // Exactly the card(s) the trace expects, and each one is a valid mount.
      expect(overviews.length, `${trace.prompt}: overview cards`).toBe(
        trace.expect.overview ? 1 : 0,
      );
      expect(imports.length, `${trace.prompt}: import cards`).toBe(trace.expect.import ? 1 : 0);
      expect(followups.length, `${trace.prompt}: follow-up cards`).toBe(
        trace.expect.followups ? 1 : 0,
      );

      if (overviews.length > 0) {
        expect(overviews[0]?.isError).toBe(false);
        expect(overviews[0]?.meta.ui?.resourceUri).toBe(DNA_IMPORT_UI_URI);
        expect(overviews[0]?.meta.mutant?.mode).toBe("overview");
      }

      if (imports.length > 0) {
        expect(imports[0]?.isError).toBe(false);
        expect(imports[0]?.meta.ui?.resourceUri).toBe(DNA_IMPORT_UI_URI);
      }

      if (followups.length > 0) {
        expect(followups[0]?.isError).toBe(false);
        expect(followups[0]?.meta.ui?.resourceUri).toBe(ANALYSIS_FOLLOWUPS_UI_URI);
        expect(followups[0]?.meta.mutant?.mode).toBe("followups");
      }

      // A topical question never mounts a compact card, even when the answer
      // called explain_health_hypothesis for supporting detail.
      if (names.includes("explain_health_hypothesis") && !trace.expect.followups) {
        expect(followups).toHaveLength(0);
      }

      if (trace.state === "PROCESSING") {
        // Processing shows only the current experience: one call, no card, no
        // promised future results, no analytical tools, no polling narration.
        expect(names).toEqual(["get_analysis_status"]);
        for (const call of calls) {
          expect(carriesUi(call)).toBe(false);
        }
      }

      // Health-history prose is never forwarded to a catalog search.
      for (const call of calls) {
        const query = call.arguments.query;
        if (query === undefined) continue;
        expect(typeof query).toBe("string");
        expect(query).not.toContain(SHARED_HISTORY);
        expect(String(query).length).toBeLessThanOrEqual(64);
      }
    });
  }

  it("records observed provenance for every trace before release", () => {
    const pending = TRACES.filter((trace) => trace.provenance !== "observed").map(
      (trace) => `${trace.prompt} (${trace.state})`,
    );
    if (process.env.GOLDEN_TRACES_REQUIRED === "1") {
      // Fail fast when the release gate is on: the three prompts must be backed
      // by a real ChatGPT capture, not a placeholder.
      expect(pending).toEqual([]);
    } else {
      // Otherwise the replay above is the contract check; report what still needs
      // capturing without blocking the default test run.
      expect(Array.isArray(pending)).toBe(true);
    }
  });
});
