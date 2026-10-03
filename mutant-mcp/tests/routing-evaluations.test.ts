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
  makeStatusData,
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
  /** When set, the compact card must be bound to exactly these hypothesis ids. */
  followupHypothesisIds?: string[];
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
    name: "Summarize displayed findings",
    prompt: "Summarize the Mutant findings identified below in plain English.",
    tools: [
      { name: "get_analysis_context" },
      {
        name: "explain_health_hypothesis",
        arguments: { hypothesis_id: "HYP_A", analysis_version: "rev42-v3.0.0" },
      },
      {
        name: "explain_health_hypothesis",
        arguments: { hypothesis_id: "HYP_B", analysis_version: "rev42-v3.0.0" },
      },
      {
        name: "explain_health_hypothesis",
        arguments: { hypothesis_id: "HYP_C", analysis_version: "rev42-v3.0.0" },
      },
    ],
    noUiOn: ["get_analysis_context", "explain_health_hypothesis"],
  },
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
    name: "Explain finding #2",
    // The overview card's per-finding "Explain finding #2" button hands off the
    // second finding's identity. Answering a specific finding must mount at most
    // one compact follow-up card bound to that id and never reopen the overview.
    prompt: 'Mutant follow-up: Explain finding #2\n\nExplain my "Beta finding" finding from my Mutant analysis in useful detail.',
    tools: [
      { name: "explain_health_hypothesis", arguments: { hypothesis_id: "HYP_B" } },
      {
        name: "show_analysis_followups",
        arguments: {
          intent: "explanation",
          analysis_version: "rev42-v3.0.0",
          hypothesis_ids: ["HYP_B"],
        },
      },
    ],
    noUiOn: ["explain_health_hypothesis"],
    followupsOn: "show_analysis_followups",
    followupHypothesisIds: ["HYP_B"],
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
    prompt: "Explain the B12 finding.",
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
  {
    name: "Topical symptom question",
    // "What can you say about my thyroid issues?" is a topic question, not a
    // finding request. The answer may search the catalog and call
    // explain_health_hypothesis for supporting detail, but the user did not ask
    // to explain or compare an identified finding, so no compact card mounts.
    prompt: "What can you say about my thyroid issues?",
    tools: [
      { name: "get_analysis_status" },
      { name: "list_health_hypotheses", arguments: { query: "thyroid" } },
      { name: "explain_health_hypothesis", arguments: { hypothesis_id: "HYP_A" } },
    ],
    noUiOn: ["get_analysis_status", "list_health_hypotheses", "explain_health_hypothesis"],
  },
  {
    name: "Histamine topic search",
    prompt: "What about histamine?",
    tools: [{ name: "list_health_hypotheses", arguments: { query: "histamine" } }],
    noUiOn: ["list_health_hypotheses"],
  },
  {
    name: "Free topic miss",
    // "What about my histamine issues?" becomes a catalog-topic search; the
    // history prose is never forwarded. The bounded scope answer mounts no card.
    prompt: "What about my histamine issues?",
    tools: [
      { name: "get_analysis_status" },
      { name: "list_health_hypotheses", arguments: { query: "histamine" } },
    ],
    noUiOn: ["get_analysis_status", "list_health_hypotheses"],
  },
  {
    name: "History comparison",
    // A request that already compares findings against the user's history must
    // not mount the card: its "Compare with my history" action would only repeat
    // the action just performed.
    prompt: "Which finding fits my history?",
    tools: [
      { name: "get_analysis_context" },
      { name: "list_health_hypotheses", arguments: { limit: 3 } },
    ],
    noUiOn: ["get_analysis_context", "list_health_hypotheses"],
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

  for (const state of ["READY_REFRESH_AVAILABLE", "READY_REFRESH_PROCESSING"] as const) {
    it(`"Show my current Mutant findings." in ${state} routes status to one overview card`, async () => {
      const status = makeStatusData({
        experience_state: state,
        capabilities: {
          can_query_analysis: true,
          can_show_overview: true,
          can_refresh_analysis: true,
          can_search_hypotheses: true,
          can_explore_genetic_context: true,
        },
      });
      const calls = await runScenario(
        [{ name: "get_analysis_status" }, { name: "show_analysis_overview" }],
        (operation) =>
          operation === "get_analysis_status"
            ? makeSuccessResponse(status)
            : makeToolResponse(operation),
      );

      expect(calls.map((call) => call.name)).toEqual([
        "get_analysis_status",
        "show_analysis_overview",
      ]);
      // Status is a routing read: it never mounts a card, even when a refresh is
      // available. The overview is the only UI-bearing call.
      expect(carriesUi(callTo(calls, "get_analysis_status"))).toBe(false);

      const overview = callTo(calls, "show_analysis_overview");
      expect(overview?.isError).toBe(false);
      expect(carriesUi(overview)).toBe(true);
      expect(overview?.meta.ui?.resourceUri).toBe(DNA_IMPORT_UI_URI);
      expect(overview?.meta.mutant?.mode).toBe("overview");
      // The broad prompt is never answered with a duplicate prose list.
      expect(calls.some((call) => call.name === "list_health_hypotheses")).toBe(false);
    });
  }

  it.each([
    "READY",
    "READY_REFRESH_AVAILABLE",
    "READY_REFRESH_PROCESSING",
    "PROCESSING_INITIAL",
    "REFRESH_PROCESSING_NO_USABLE_ANALYSIS",
  ])("get_analysis_status advertises no UI resource in %s", async (experience) => {
    const calls = await runScenario([{ name: "get_analysis_status" }], (operation) =>
      operation === "get_analysis_status"
        ? makeSuccessResponse(makeStatusData({ experience_state: experience }))
        : makeToolResponse(operation),
    );
    expect(calls[0]?.meta.ui).toBeUndefined();
    expect(calls[0]?.meta.mutant).toBeUndefined();
    expect(calls[0]?.meta["openai/outputTemplate"]).toBeUndefined();
  });

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
        if (scenario.followupHypothesisIds) {
          expect(followups?.arguments.hypothesis_ids).toEqual(scenario.followupHypothesisIds);
          expect(followups?.arguments.analysis_version).toBe("rev42-v3.0.0");
        }
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

// --- pre-message entry ("starter") prompt routing -----------------------------
//
// The three prompts a person can send before the first Apps SDK card exists.
// Each must begin with `get_analysis_status` (readiness is unknown) and then take
// the state-appropriate path. These assertions cover the *server* behavior for
// that path; the observed-traces evaluation in golden-prompt-routing.test.ts is
// what proves ChatGPT actually selected those tools.
describe("starter prompt routing", () => {
  const COMPARE_PROMPT =
    "Which of my Mutant findings best fits the health history or records I've shared here?";
  const FINDINGS_PROMPT = "Show my current Mutant findings.";
  const ADD_DNA_PROMPT = "Help me add my DNA data to Mutant.";

  const READY_FREE = makeStatusData({
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
  });

  const NO_DNA_STATUS = makeStatusData({
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
  });

  const PROCESSING_STATUS = makeStatusData({
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
  });

  const IMPORT_CALL = {
    name: "show_dna_import",
    arguments: { mode: "initial" as const },
  };
  const OVERVIEW_CALL = { name: "show_analysis_overview" };

  /** A real-world history prose the user might have typed in the chat. */
  const SHARED_HISTORY =
    "I have had fatigue and brain fog for months and my B12 was low in March 2024.";

  interface StarterScenario {
    prompt: string;
    state: "NO_DNA" | "READY_FREE" | "READY_FULL" | "PROCESSING";
    status: Record<string, unknown>;
    tools: Array<{ name: string; arguments?: Record<string, unknown> }>;
    expectOverview: boolean;
    expectImport: boolean;
  }

  const STARTER_SCENARIOS: StarterScenario[] = [
    // Comparison prompt.
    {
      prompt: COMPARE_PROMPT,
      state: "NO_DNA",
      status: NO_DNA_STATUS,
      tools: [{ name: "get_analysis_status" }, IMPORT_CALL],
      expectOverview: false,
      expectImport: true,
    },
    {
      prompt: COMPARE_PROMPT,
      state: "READY_FREE",
      status: READY_FREE,
      tools: [
        { name: "get_analysis_status" },
        { name: "get_analysis_context" },
        { name: "list_health_hypotheses", arguments: { limit: 3 } },
      ],
      expectOverview: false,
      expectImport: false,
    },
    {
      prompt: COMPARE_PROMPT,
      state: "READY_FULL",
      status: makeStatusData(),
      tools: [
        { name: "get_analysis_status" },
        { name: "get_analysis_context" },
        { name: "list_health_hypotheses", arguments: { limit: 10 } },
      ],
      expectOverview: false,
      expectImport: false,
    },
    {
      prompt: COMPARE_PROMPT,
      state: "PROCESSING",
      status: PROCESSING_STATUS,
      tools: [{ name: "get_analysis_status" }],
      expectOverview: false,
      expectImport: false,
    },
    // Broad findings prompt.
    {
      prompt: FINDINGS_PROMPT,
      state: "NO_DNA",
      status: NO_DNA_STATUS,
      tools: [{ name: "get_analysis_status" }, IMPORT_CALL],
      expectOverview: false,
      expectImport: true,
    },
    {
      prompt: FINDINGS_PROMPT,
      state: "READY_FREE",
      status: READY_FREE,
      tools: [{ name: "get_analysis_status" }, OVERVIEW_CALL],
      expectOverview: true,
      expectImport: false,
    },
    {
      prompt: FINDINGS_PROMPT,
      state: "READY_FULL",
      status: makeStatusData(),
      tools: [{ name: "get_analysis_status" }, OVERVIEW_CALL],
      expectOverview: true,
      expectImport: false,
    },
    {
      prompt: FINDINGS_PROMPT,
      state: "PROCESSING",
      status: PROCESSING_STATUS,
      tools: [{ name: "get_analysis_status" }],
      expectOverview: false,
      expectImport: false,
    },
    // Add-DNA prompt.
    {
      prompt: ADD_DNA_PROMPT,
      state: "NO_DNA",
      status: NO_DNA_STATUS,
      tools: [{ name: "get_analysis_status" }, IMPORT_CALL],
      expectOverview: false,
      expectImport: true,
    },
    {
      prompt: ADD_DNA_PROMPT,
      state: "READY_FREE",
      status: READY_FREE,
      tools: [{ name: "get_analysis_status" }, IMPORT_CALL],
      expectOverview: false,
      expectImport: true,
    },
    {
      prompt: ADD_DNA_PROMPT,
      state: "READY_FULL",
      status: makeStatusData(),
      tools: [{ name: "get_analysis_status" }, IMPORT_CALL],
      expectOverview: false,
      expectImport: true,
    },
    {
      prompt: ADD_DNA_PROMPT,
      state: "PROCESSING",
      status: PROCESSING_STATUS,
      tools: [{ name: "get_analysis_status" }],
      expectOverview: false,
      expectImport: false,
    },
  ];

  for (const scenario of STARTER_SCENARIOS) {
    it(`"${scenario.prompt}" (${scenario.state}) starts at status and takes the state path`, async () => {
      const calls = await runScenario(scenario.tools, (operation) =>
        operation === "get_analysis_status"
          ? makeSuccessResponse(scenario.status)
          : makeToolResponse(operation),
      );

      // Readiness is unknown before the first message, so status is always first.
      expect(calls[0]?.name).toBe("get_analysis_status");

      const overviews = calls.filter((call) => call.name === "show_analysis_overview");
      if (scenario.expectOverview) {
        expect(overviews).toHaveLength(1);
        expect(overviews[0]?.meta.ui?.resourceUri).toBe(DNA_IMPORT_UI_URI);
        expect(overviews[0]?.meta.mutant?.mode).toBe("overview");
      } else {
        expect(overviews).toHaveLength(0);
      }

      const imports = calls.filter((call) => call.name === "show_dna_import");
      if (scenario.expectImport) {
        expect(imports).toHaveLength(1);
        expect(imports[0]?.isError).toBe(false);
        expect(imports[0]?.meta.ui?.resourceUri).toBe(DNA_IMPORT_UI_URI);
      } else {
        expect(imports).toHaveLength(0);
      }

      // The processing experience promises nothing and mounts nothing.
      if (scenario.state === "PROCESSING") {
        expect(calls.map((call) => call.name)).toEqual(["get_analysis_status"]);
        for (const call of calls) {
          expect(carriesUi(call)).toBe(false);
        }
        expect(scenario.tools.some((tool) => tool.name === "list_health_hypotheses")).toBe(false);
      }

      // Health-history prose is never forwarded to a catalog search.
      for (const call of calls) {
        const query = call.arguments.query;
        if (query === undefined) continue;
        expect(typeof query).toBe("string");
        expect(query).not.toContain(SHARED_HISTORY);
        expect(String(query).length).toBeLessThanOrEqual(64);
        expect(String(query)).not.toMatch(/\s{3,}/);
      }
    });
  }

  it("keeps history prose out of the catalog search for a shared-history comparison", async () => {
    // The model receives the history as chat context (performed_by: chatgpt,
    // sent_to_mutant: false). Only catalog-topic keywords may reach the backend.
    const calls = await runScenario(
      [
        { name: "get_analysis_status" },
        { name: "get_analysis_context" },
        { name: "list_health_hypotheses", arguments: { query: "b12" } },
      ],
      (operation) =>
        operation === "get_analysis_status"
          ? makeSuccessResponse(READY_FREE)
          : makeToolResponse(operation),
    );
    const search = callTo(calls, "list_health_hypotheses");
    expect(search?.arguments.query).toBe("b12");
    expect(JSON.stringify(calls.map((call) => call.arguments))).not.toContain(SHARED_HISTORY);
  });

  it("mounts no compact follow-up card for the history-comparison starter prompt", async () => {
    // This prompt already asks to compare findings against the user's history, so
    // the card's "Compare with my history" action would only repeat the request.
    const calls = await runScenario(
      [
        { name: "get_analysis_status" },
        { name: "get_analysis_context" },
        { name: "list_health_hypotheses", arguments: { limit: 3 } },
      ],
      (operation) =>
        operation === "get_analysis_status"
          ? makeSuccessResponse(READY_FREE)
          : makeToolResponse(operation),
    );
    expect(calls.some((call) => call.name === "show_analysis_followups")).toBe(false);
    expect(calls.some((call) => call.name === "show_analysis_overview")).toBe(false);
  });
});
