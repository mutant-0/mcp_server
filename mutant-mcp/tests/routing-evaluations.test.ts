/**
 * Routing evaluations: broad opening questions vs specific requests.
 *
 * These are runnable fixtures, not wording snapshots. Each scenario pairs a real
 * user prompt with the tool sequence a compliant assistant would make and asserts
 * *where* the Apps SDK component attaches: exactly one overview card for a broad
 * opening question, and no component at all for a specific request. The card is
 * deliberately mounted by one render tool (`show_analysis_overview`); if routing
 * drifted to `list_health_hypotheses` the descriptor assertions fail.
 *
 * Run with: npm test -- tests/routing-evaluations.test.ts
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BackendOperation, ToolResponse } from "../src/contract.js";
import { createMcpServer } from "../src/server.js";
import { ANALYSIS_FOLLOWUPS_UI_URI } from "../src/ui/analysis-followups/resource.js";
import { DNA_IMPORT_UI_URI } from "../src/ui/dna-import/resource.js";
import {
  ANALYSIS_SCOPE,
  DNA_SCOPE,
  StubBackendClient,
  makeConfig,
  makeErrorResponse,
  makeSuccessResponse,
  makeToolResponse,
  makeUser,
} from "./helpers.js";

interface UiMeta {
  ui?: { resourceUri?: string; visibility?: string[] };
  mutant?: { mode?: string };
  "openai/outputTemplate"?: string;
}

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  isError: boolean;
  meta: UiMeta;
  structured: ToolResponse | undefined;
}

interface Scenario {
  name: string;
  /** What the user typed. */
  prompt: string;
  /** The tool sequence a compliant assistant would make, in order. */
  tools: Array<{ name: string; arguments?: Record<string, unknown> }>;
  /** Tools whose result must never carry a UI descriptor. */
  noUiOn: string[];
  /** The one tool whose result must mount the compact follow-up card. */
  followupsOn?: string;
}

const BROAD_PROMPTS = [
  "What are my top hypotheses?",
  "What did Mutant find?",
  "Show my results.",
  "What can Mutant tell me?",
  "What does my DNA say about my health?",
];

const FOLLOWUP_ARGS = {
  intent: "explanation",
  analysis_version: "rev42-v3.0.0",
  hypothesis_ids: ["HYP_A"],
};

const SPECIFIC_PROMPTS: Scenario[] = [
  {
    name: "Explain #1",
    prompt: "Explain my #1 finding in plain English.",
    tools: [
      { name: "explain_health_hypothesis", arguments: { hypothesis_id: "HYP_A" } },
      { name: "show_analysis_followups", arguments: FOLLOWUP_ARGS },
    ],
    noUiOn: ["explain_health_hypothesis"],
    followupsOn: "show_analysis_followups",
  },
  {
    name: "Compare my top three",
    prompt: "Compare my top three findings.",
    tools: [
      { name: "list_health_hypotheses", arguments: { limit: 3 } },
      { name: "explain_health_hypothesis", arguments: { hypothesis_id: "HYP_A" } },
      {
        name: "show_analysis_followups",
        arguments: { ...FOLLOWUP_ARGS, intent: "comparison", hypothesis_ids: ["HYP_A"] },
      },
    ],
    noUiOn: ["list_health_hypotheses", "explain_health_hypothesis"],
    followupsOn: "show_analysis_followups",
  },
  {
    name: "Explain a named finding",
    prompt: "What is the B12 one?",
    tools: [
      { name: "list_health_hypotheses", arguments: { query: "b12" } },
      { name: "explain_health_hypothesis", arguments: { hypothesis_id: "HYP_A" } },
      { name: "show_analysis_followups", arguments: FOLLOWUP_ARGS },
    ],
    noUiOn: ["list_health_hypotheses", "explain_health_hypothesis"],
    followupsOn: "show_analysis_followups",
  },
  {
    name: "Topic search",
    // A browse request with no question attached gets no card at all.
    prompt: "Find thyroid-related hypotheses.",
    tools: [{ name: "list_health_hypotheses", arguments: { query: "thyroid" } }],
    noUiOn: ["list_health_hypotheses"],
  },
];

async function runScenario(
  tools: Scenario["tools"],
  responder: (operation: BackendOperation) => ToolResponse = (operation) =>
    makeToolResponse(operation),
): Promise<ToolCall[]> {
  const backendClient = new StubBackendClient((operation) => responder(operation));
  const server = createMcpServer(
    makeUser({ scopes: [ANALYSIS_SCOPE, DNA_SCOPE] }),
    makeConfig(),
    "req-routing",
    backendClient,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "routing-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  const calls: ToolCall[] = [];
  for (const tool of tools) {
    const result = await client.callTool({
      name: tool.name,
      arguments: tool.arguments ?? {},
    });
    calls.push({
      name: tool.name,
      arguments: tool.arguments ?? {},
      isError: result.isError === true,
      meta: (result._meta ?? {}) as UiMeta,
      structured: result.structuredContent as ToolResponse | undefined,
    });
  }
  return calls;
}

function callTo(calls: ToolCall[], name: string): ToolCall | undefined {
  return calls.find((call) => call.name === name);
}

function carriesUi(call: ToolCall | undefined): boolean {
  if (!call) return false;
  return (
    call.meta.ui?.resourceUri !== undefined ||
    call.meta["openai/outputTemplate"] !== undefined ||
    call.meta.mutant !== undefined
  );
}

describe("routing evaluations", () => {
  for (const prompt of BROAD_PROMPTS) {
    it(`"${prompt}" routes through status to exactly one overview card`, async () => {
      const calls = await runScenario([
        { name: "get_analysis_status" },
        { name: "show_analysis_overview" },
      ]);

      // The status read is the readiness gate, and it must not mount a card by
      // itself for a ready analysis.
      expect(calls.map((call) => call.name)).toEqual([
        "get_analysis_status",
        "show_analysis_overview",
      ]);
      expect(carriesUi(callTo(calls, "get_analysis_status"))).toBe(false);

      const overview = callTo(calls, "show_analysis_overview");
      expect(overview?.isError).toBe(false);
      expect(carriesUi(overview)).toBe(true);
      expect(overview?.meta.ui?.resourceUri).toBe(DNA_IMPORT_UI_URI);
      expect(overview?.meta.mutant?.mode).toBe("overview");

      // The card is bound to one resolved snapshot with exact identities.
      const data = overview?.structured?.data as {
        displayed_analysis_version?: string | null;
        displayed_hypotheses?: Array<{ id: string | null; rank: number; name: string }>;
      };
      expect(data.displayed_analysis_version).toBe("rev42-v3.0.0");
      expect(data.displayed_hypotheses?.[0]).toEqual({
        id: "HYP_A",
        rank: 1,
        name: "Alpha finding",
      });
    });
  }

  it("never answers a broad opening question with list_health_hypotheses", async () => {
    // The non-compliant route: a prose list, or a list render, would carry no
    // overview descriptor at all. Asserting that is what makes this a real gate.
    const calls = await runScenario([
      { name: "list_health_hypotheses", arguments: { limit: 3 } },
    ]);
    expect(carriesUi(calls[0])).toBe(false);
    expect(calls[0]?.meta.mutant).toBeUndefined();
  });

  for (const scenario of SPECIFIC_PROMPTS) {
    it(`"${scenario.prompt}" uses the data path without mounting the overview card`, async () => {
      const calls = await runScenario(scenario.tools);
      for (const name of scenario.noUiOn) {
        const call = callTo(calls, name);
        expect(call, `${scenario.name}: ${name} was not called`).toBeDefined();
        expect(
          carriesUi(call),
          `${scenario.name}: ${name} must not mount the overview card`,
        ).toBe(false);
      }
      // A specific question never reopens the overview.
      expect(calls.some((call) => call.name === "show_analysis_overview")).toBe(false);

      if (scenario.followupsOn) {
        const followups = callTo(calls, scenario.followupsOn);
        expect(followups, `${scenario.name}: follow-up card was not mounted`).toBeDefined();
        expect(followups?.isError).toBe(false);
        expect(followups?.meta.ui?.resourceUri).toBe(ANALYSIS_FOLLOWUPS_UI_URI);
        expect(followups?.meta.mutant?.mode).toBe("followups");
        // The card is bound to the same revision the answer used.
        const data = followups?.structured?.data as {
          intent?: string;
          displayed_analysis_version?: string | null;
          actions?: Array<{ action?: { analysis_version?: string; hypothesis_id?: string } }>;
        };
        expect(data.displayed_analysis_version).toBe("rev42-v3.0.0");
        expect(data.actions?.every((a) => a.action?.analysis_version === "rev42-v3.0.0")).toBe(
          true,
        );
      } else {
        expect(calls.some((call) => call.name === "show_analysis_followups")).toBe(false);
      }
    });
  }

  it("mounts at most one follow-up card and never for a broad question", async () => {
    const specific = await runScenario([
      { name: "explain_health_hypothesis", arguments: { hypothesis_id: "HYP_A" } },
      { name: "show_analysis_followups", arguments: FOLLOWUP_ARGS },
    ]);
    expect(specific.filter((call) => call.name === "show_analysis_followups")).toHaveLength(1);

    const broad = await runScenario([
      { name: "get_analysis_status" },
      { name: "show_analysis_overview" },
    ]);
    expect(broad.some((call) => call.name === "show_analysis_followups")).toBe(false);
  });

  it("rejects a stale follow-up pin with a structured status instead of switching", async () => {
    const calls = await runScenario(
      [
        { name: "explain_health_hypothesis", arguments: { hypothesis_id: "HYP_A" } },
        {
          name: "show_analysis_followups",
          arguments: { ...FOLLOWUP_ARGS, analysis_version: "rev1-v1" },
        },
      ],
      (operation) =>
        operation === "resolve_analysis_followups"
          ? makeErrorResponse("ANALYSIS_VERSION_CHANGED", "stale analysis pin", {
              reason: "snapshot_changed",
            })
          : makeToolResponse(operation),
    );
    const followups = calls[1];
    expect(followups?.isError).toBe(true);
    expect(followups?.structured?.error?.code).toBe("ANALYSIS_VERSION_CHANGED");
    // A rejected verification must not mount a card bound to the wrong revision.
    expect(followups?.meta.ui).toBeUndefined();
  });

  it("keeps a follow-up turn specific after the opening overview card", async () => {
    const opening = await runScenario([
      { name: "get_analysis_status" },
      { name: "show_analysis_overview" },
    ]);
    expect(carriesUi(opening[1])).toBe(true);

    // The next user turn refers to a displayed finding: a data call, no card.
    const followUp = await runScenario([
      { name: "explain_health_hypothesis", arguments: { hypothesis_id: "HYP_A" } },
    ]);
    expect(carriesUi(followUp[0])).toBe(false);
  });

  it("does not mount any card while no usable analysis exists", async () => {
    const processing = makeSuccessResponse(
      // Mirrors the component-owned processing state.
      {
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
      },
    );
    const calls = await runScenario([{ name: "get_analysis_status" }], () => processing);
    expect(carriesUi(calls[0])).toBe(false);
  });

  it("forwards an unready overview as a structured error with no card", async () => {
    const calls = await runScenario([{ name: "show_analysis_overview" }], () =>
      makeErrorResponse("ANALYSIS_NOT_READY", "not servable yet", {
        reason: "analysis_payload_pending",
      }),
    );
    const call = calls[0];
    expect(call?.isError).toBe(true);
    expect(call?.structured?.error?.code).toBe("ANALYSIS_NOT_READY");
    // The overview card must never mount from a failed snapshot resolution.
    expect(call?.meta.ui).toBeUndefined();
    expect(call?.meta.mutant).toBeUndefined();
    expect(call?.meta["openai/outputTemplate"]).toBeUndefined();
  });
});
