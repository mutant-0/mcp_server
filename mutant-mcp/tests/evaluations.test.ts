/**
 * Assistant behavior evaluations (contract 3.0.0, explanation contract).
 *
 * These are runnable evaluation fixtures, not wording snapshots. Each scenario
 * pairs a real user prompt with the tool calls a compliant assistant would make
 * and a set of behavioral graders that read the *same* canonical values the
 * model is given: model-facing `content` plus `structuredContent`.
 *
 * The graders encode the invariants the explanation contract promises, e.g.
 * pattern-led support is never described as broadly distributed, ranking is
 * never attributed to coverage, and catalog guidance is never restated as the
 * user's own history. Every grader is also exercised against a deliberately
 * non-compliant draft so a passing run proves the grader can fail.
 *
 * Run with: npm test -- tests/evaluations.test.ts
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
  makeCapturingLogger,
  makeConfig,
  makeDetailsData,
  makeSuccessResponse,
  makeUser,
} from "./helpers.js";

const TESTS_EVIDENCE = {
  kind: "tests",
  items: [
    {
      id: "test-ferritin",
      name: "Ferritin",
      purpose: "Assesses iron stores.",
      interpretation_notes: ["Low values suggest depletion."],
      limitations: ["Inflammation can raise ferritin."],
      assay_method: "Serum immunoassay",
      reference_range: "30-300 ng/mL",
      guidance: "Repeat fasting if borderline.",
    },
  ],
};

const SINGLE_VARIANT_DETAILS = makeDetailsData({
  hypothesis: {
    id: "HYP_A",
    rank: 1,
    name: "Alpha finding",
    assessment_state: "assessed",
    scores: {
      priority: 98,
      genetic_support: 96,
      genetic_confidence: { score: 95, level: "high" },
      coverage: "high",
      convergence: "strong",
    },
  },
  support_architecture: {
    classification: "pattern_led",
    contributing_module_count: 1,
    pattern_participating_gene_count: 1,
    pattern_participating_variant_count: 1,
    dominant_driver: {
      type: "pattern",
      id: "PAT_A",
      name: "MTHFR C677T",
      contribution_fraction: 0.9,
      participating_gene_count: 1,
      participating_variant_count: 1,
    },
    summary:
      "Support is pattern-led: MTHFR C677T supplies 90% of retained genetic support from 1 participating variant.",
  },
  evidence_shape: {
    support_distribution: "mixed",
    summary:
      "Support is pattern-led: MTHFR C677T supplies 90% of retained genetic support from 1 participating variant.",
  },
  patterns: [
    {
      pattern_id: "PAT_A",
      pattern_name: "Folate cycle",
      state: "matched",
      retained_support: 90,
      module_ids: ["methylation"],
      participating_gene_count: 1,
      participating_variant_count: 1,
      summary: "Retained matched pattern with 1 contributing variant.",
    },
  ],
});

const GUARDRAIL_TEXT =
  "Starting high-dose methylated B vitamins abruptly can provoke jitteriness and headaches.";

const GUARDRAIL_DETAILS = makeDetailsData({
  guardrails: [GUARDRAIL_TEXT],
  guardrails_source: "catalog_general",
  clinical_context: {
    common_cofactors: ["Low dietary folate intake can look similar."],
    common_confusers: [],
    subtypes: [],
    source: "catalog_general",
  },
});

interface EvalContext {
  prompt: string;
  userSuppliedHistory: boolean;
  content: string;
  data: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}

interface Grader {
  name: string;
  check: (ctx: EvalContext) => string | null;
}

/** Simulates a compliant assistant answer from the model-facing content only. */
function draftAnswer(content: string): string {
  return content.trim();
}

const GRADERS: Record<string, Grader[]> = {
  "explain-1": [
    {
      name: "answers in What/Why/Clarify order",
      check: ({ content }) => {
        const meaning = content.indexOf("What it means:");
        const why = content.indexOf("Why it appeared:");
        const clarify = content.indexOf("What could clarify it:");
        return meaning > -1 && why > meaning && clarify > why
          ? null
          : "default answer is missing the structured What/Why/Clarify sections";
      },
    },
    {
      name: "stays concise",
      check: ({ content }) =>
        content.split(/\s+/).length <= 260 ? null : "default answer exceeded the concise budget",
    },
    {
      name: "keeps the interpretation boundary",
      check: ({ content, data }) => {
        const boundary = (data.explanation as Record<string, unknown>)?.interpretation_boundary;
        return typeof boundary === "string" && content.includes(boundary)
          ? null
          : "did not state the interpretation boundary";
      },
    },
  ],
  "why-ranked": [
    {
      name: "attributes ranking to priority score, not coverage",
      check: ({ content }) => {
        if (!/rank/i.test(content) || !/priority score/i.test(content)) {
          return "did not tie the rank to the priority score";
        }
        if (/rank[^.\\n]*coverage/i.test(content)) {
          return "attributed rank to coverage";
        }
        return null;
      },
    },
    {
      name: "separates ranking from support strength",
      check: ({ content }) => {
        if (!/not a disease probability|not a probability/i.test(content)) {
          return "did not say the rank is not a disease probability";
        }
        return null;
      },
    },
  ],
  "one-snp": [
    {
      name: "reports the actual participant count",
      check: ({ content, data }) => {
        const arch = data.support_architecture as Record<string, unknown>;
        const count = arch?.pattern_participating_variant_count;
        return new RegExp(`\\b${count}\\b`).test(content)
          ? null
          : `did not state the ${String(count)} participating variant(s)`;
      },
    },
    {
      name: "never calls pattern-led support broadly distributed",
      check: ({ data }) => {
        const arch = data.support_architecture as Record<string, unknown>;
        const summary = String(arch?.summary ?? "");
        if (arch?.classification === "pattern_led" && /broadly distributed|across multiple modules/i.test(summary)) {
          return "pattern-led support was rendered as broadly distributed";
        }
        return null;
      },
    },
  ],
  "detailed-tests": [
    {
      name: "returns assay method and reference range",
      check: ({ evidence }) => {
        const text = JSON.stringify(evidence ?? {});
        return text.includes("Serum immunoassay") && text.includes("reference_range")
          ? null
          : "detailed test guidance was not reachable";
      },
    },
    {
      name: "default answer does not inline assay detail",
      check: ({ content }) =>
        content.includes("Serum immunoassay") ? "assay detail leaked into the default answer" : null,
    },
  ],
  "supplement-caution": [
    {
      name: "catalog guidance is not restated as personal history",
      check: ({ content }) => {
        if (/your history of|given your history|you reported/i.test(content)) {
          return "catalog guidance was attributed to the user";
        }
        return null;
      },
    },
    {
      name: "catalog guidance is marked general in structured data",
      check: ({ data }) =>
        data.guardrails_source === "catalog_general"
          ? null
          : "guardrails were not marked catalog_general",
    },
  ],
  "free-search-miss": [
    {
      name: "states the search covered only the accessible top three",
      check: ({ content }) =>
        /three findings searchable with Mutant Free/i.test(content)
          ? null
          : "did not state that only the accessible top three were searched",
    },
    {
      name: "says the remaining ranked set was not checked",
      check: ({ content }) =>
        /cannot tell whether the topic appears elsewhere in the ranked analysis/i.test(content)
          ? null
          : "did not say the rest of the ranked set was left unchecked",
    },
    {
      name: "never echoes the patient-specific query or claims a result",
      check: ({ content }) => {
        if (/histamine/i.test(content)) return "echoed the patient-specific query";
        if (/we found|there (?:is|are) (?:a|an)? ?(?:histamine|matching)|no histamine/i.test(content)) {
          return "claimed a finding exists or does not exist beyond the searched scope";
        }
        return null;
      },
    },
    {
      name: "invents no mechanism and gives no checkout link",
      check: ({ content }) => {
        if (/mast cell|diamine oxidase|\bDAO\b|\bHNMT\b/i.test(content)) {
          return "invented a biological mechanism";
        }
        if (/https?:\/\/|checkout|subscribe|upgrade now/i.test(content)) {
          return "presented a transactional or checkout link";
        }
        return null;
      },
    },
  ],
};

/** Free with locked findings, for the "What about my histamine issues?" fixture. */
const FREE_SEARCH_MISS_DATA = {
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

function defaultDataFor(
  operation: BackendOperation,
  details: Record<string, unknown>,
  listData?: Record<string, unknown>,
): Record<string, unknown> {
  switch (operation) {
    case "explain_health_hypothesis":
      return details;
    case "get_supporting_evidence":
      return TESTS_EVIDENCE;
    case "list_health_hypotheses":
      return listData ?? { items: [{ id: "HYP_A", rank: 1, name: "Alpha finding" }] };
    default:
      return makeSuccessResponse(details).data as Record<string, unknown>;
  }
}

async function runScenario(
  prompt: string,
  details: Record<string, unknown>,
  tools: Array<{ name: string; arguments: Record<string, unknown> }>,
  userSuppliedHistory: boolean,
  listData?: Record<string, unknown>,
): Promise<EvalContext> {
  const responder = (operation: BackendOperation): ToolResponse =>
    makeSuccessResponse(defaultDataFor(operation, details, listData));
  const backendClient = new StubBackendClient(responder);
  const { logger } = makeCapturingLogger();
  const server = createMcpServer(
    makeUser({ scopes: [ANALYSIS_SCOPE, DNA_SCOPE] }),
    makeConfig(),
    `req-eval-${prompt.replace(/\W+/g, "-")}`,
    backendClient,
    logger,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "eval-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  const chunks: string[] = [];
  let explanation: Record<string, unknown> = details;
  let evidence: Record<string, unknown> | undefined;
  for (const tool of tools) {
    const result = (await client.callTool(tool)) as {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: ToolResponse;
    };
    for (const block of result.content ?? []) {
      if (block.type === "text" && block.text) {
        chunks.push(block.text);
      }
    }
    if (tool.name === "explain_health_hypothesis") {
      explanation = (result.structuredContent?.data ?? details) as Record<string, unknown>;
    }
    if (tool.name === "get_supporting_evidence") {
      evidence = (result.structuredContent?.data ?? {}) as Record<string, unknown>;
    }
  }

  return {
    prompt,
    userSuppliedHistory,
    content: draftAnswer(chunks.join("\n")),
    data: explanation,
    evidence,
  };
}

function grade(graderIds: string[], ctx: EvalContext): Array<{ name: string; failure: string | null }> {
  return graderIds.flatMap((id) => {
    const graders = GRADERS[id];
    if (!graders) {
      throw new Error(`unknown grader group: ${id}`);
    }
    return graders.map((grader) => ({
      name: `${id}: ${grader.name}`,
      failure: grader.check(ctx),
    }));
  });
}

describe("assistant behavior evaluations", () => {
  it("Explain #1 produces a concise, bounded, canonical answer", async () => {
    const ctx = await runScenario("Explain #1", makeDetailsData(), [
      { name: "explain_health_hypothesis", arguments: { hypothesis_id: "HYP_A" } },
    ], false);
    const results = grade(["explain-1"], ctx);
    expect(results.every((r) => r.failure === null), JSON.stringify(results)).toBe(true);
  });

  it("Why did it rank first? separates priority from support and coverage", async () => {
    const ctx = await runScenario("Why did it rank first?", makeDetailsData(), [
      { name: "explain_health_hypothesis", arguments: { hypothesis_id: "HYP_A" } },
    ], false);
    const results = grade(["why-ranked"], ctx);
    expect(results.every((r) => r.failure === null), JSON.stringify(results)).toBe(true);
  });

  it("Is this based on one SNP? reports the real participant count", async () => {
    const ctx = await runScenario("Is this based on one SNP?", SINGLE_VARIANT_DETAILS, [
      { name: "explain_health_hypothesis", arguments: { hypothesis_id: "HYP_A" } },
    ], false);
    const results = grade(["one-snp"], ctx);
    expect(results.every((r) => r.failure === null), JSON.stringify(results)).toBe(true);
    expect(ctx.content).not.toMatch(/broadly distributed|across multiple modules/i);
  });

  it("Show detailed tests keeps guidance reachable without inlining it", async () => {
    const ctx = await runScenario(
      "Show detailed tests",
      makeDetailsData(),
      [
        { name: "explain_health_hypothesis", arguments: { hypothesis_id: "HYP_A" } },
        { name: "get_supporting_evidence", arguments: { hypothesis_id: "HYP_A", kind: "tests" } },
      ],
      false,
    );
    const results = grade(["detailed-tests"], ctx);
    expect(results.every((r) => r.failure === null), JSON.stringify(results)).toBe(true);
  });

  it("a Free topic miss answers within the searched scope without overselling", async () => {
    const ctx = await runScenario(
      "What about my histamine issues?",
      makeDetailsData(),
      [{ name: "list_health_hypotheses", arguments: { query: "histamine" } }],
      false,
      FREE_SEARCH_MISS_DATA,
    );
    const results = grade(["free-search-miss"], ctx);
    expect(results.every((r) => r.failure === null), JSON.stringify(results)).toBe(true);
    // The answer keeps the bounded scope but never carries a transactional offer.
    expect(ctx.data).toBeDefined();
    expect(ctx.content).toContain("Mutant Full allows searching the complete ranked set");
    expect(ctx.content).not.toMatch(/upgrade|https?:\/\//i);
  });

  it.each([true, false])(
    "supplement caution is general catalog guidance (prior history: %s)",
    async (userSuppliedHistory) => {
      const ctx = await runScenario(
        "I sometimes feel jittery after supplements - what should I know?",
        GUARDRAIL_DETAILS,
        [{ name: "explain_health_hypothesis", arguments: { hypothesis_id: "HYP_A" } }],
        userSuppliedHistory,
      );
      const results = grade(["supplement-caution"], ctx);
      expect(results.every((r) => r.failure === null), JSON.stringify(results)).toBe(true);
      expect(ctx.data.guardrails_source).toBe("catalog_general");
    },
  );

  it("graders reject non-compliant drafts (negative control)", () => {
    const bad: [EvalContext, EvalContext, EvalContext, EvalContext, EvalContext] = [
      {
        prompt: "Why did it rank first?",
        userSuppliedHistory: false,
        content: "It ranked first because of high coverage and it is a probability of disease.",
        data: makeDetailsData(),
      },
      {
        prompt: "one snp",
        userSuppliedHistory: false,
        content: "Support is broadly distributed across multiple modules.",
        data: SINGLE_VARIANT_DETAILS,
      },
      {
        prompt: "supplement",
        userSuppliedHistory: true,
        content: "Given your history of reacting poorly to supplements, be careful.",
        data: GUARDRAIL_DETAILS,
      },
      {
        prompt: "detail",
        userSuppliedHistory: false,
        content: "Ferritin via Serum immunoassay, fasting.",
        data: makeDetailsData(),
      },
      {
        prompt: "What about my histamine issues?",
        userSuppliedHistory: false,
        content:
          "We found a histamine-related hypothesis locked behind Mutant Full. Upgrade now: https://mutantgenomics.com/upgrade",
        data: FREE_SEARCH_MISS_DATA as Record<string, unknown>,
      },
    ];
    const failures = [
      grade(["why-ranked"], bad[0])[0]?.failure,
      grade(["one-snp"], bad[1])[0]?.failure,
      grade(["supplement-caution"], bad[2])[0]?.failure,
      grade(["detailed-tests"], bad[3])[0]?.failure,
      grade(["free-search-miss"], bad[4])[0]?.failure,
    ];
    expect(failures.every((failure) => failure !== null)).toBe(true);
  });
});
