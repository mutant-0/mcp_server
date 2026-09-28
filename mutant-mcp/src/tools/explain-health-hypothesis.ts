import type { ToolResponse } from "../contract.js";
import { withSuggestedPrompts } from "../presentation/prompts.js";
import { withPublicUpgradeUrl } from "../presentation/upgrade.js";
import { explainHealthHypothesisInputSchema, explainHypothesisOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

export const explainHealthHypothesisTool: MutantToolDefinition = {
  name: "explain_health_hypothesis",
  title: "Explain Health Hypothesis",
  description:
    "Explain one ranked Mutant finding. Use when the user asks what a finding means, why it " +
    "ranked, how strong it is, what supports it, what would strengthen or weaken it, or asks " +
    'questions such as "What is the B12 one?" or "Explain my #1 finding." Returns a concise, ' +
    "grounded explanation: what it means, why it appeared (evidence architecture and ranking), " +
    "and what could clarify it (the interpretation boundary, any material data gap, and at most " +
    "two primary confirmation checks). Explain the support architecture before individual genes " +
    "or variants. Pattern-led support describes how support was calculated, not that it is " +
    "broadly distributed; use the dominant driver, its share, and participating-variant counts " +
    "rather than implying breadth. Use get_supporting_evidence when the user asks for detailed " +
    "modules, patterns, variants, sources, tests, or exact scores. " +
    "Personal history, symptoms, laboratory results, medications, and prior reactions may be " +
    "attributed to the user only when the user or an authorized context source supplied them; " +
    "catalog cofactors, confounders, cautions, and guardrails are general guidance and must " +
    "never be restated as the user's history or experience. Keep genetic findings distinct " +
    "from symptoms or test results the user has not reported, and use priority_score only for " +
    "ordering and genetic_support only for strength within the analyzed evidence; neither is a " +
    "disease probability. After you answer, when the host supports Apps SDK UI, call " +
    "show_analysis_followups once with the same analysis_version and this hypothesis id so the " +
    "card can offer the next question; keep the explanation itself in the conversation and do " +
    "not restate the card.",
  scope: "analysis.read",
  inputSchema: explainHealthHypothesisInputSchema,
  outputSchema: explainHypothesisOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) => {
    const response: ToolResponse = await runtime.client.invoke(
      "explain_health_hypothesis",
      args,
      runtime.user,
      runtime.requestId,
    );
    return respond(
      withSuggestedPrompts(withPublicUpgradeUrl(response, runtime.config), "explain_health_hypothesis"),
      runtime,
      { operation: "explain_health_hypothesis" },
    );
  },
};
