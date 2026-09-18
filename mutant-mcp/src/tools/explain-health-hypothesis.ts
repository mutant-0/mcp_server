import { explainHealthHypothesisInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

export const explainHealthHypothesisTool: MutantToolDefinition = {
  name: "explain_health_hypothesis",
  title: "Explain Health Hypothesis",
  description:
    "Use this when the user asks what a Mutant health hypothesis or ranked finding means, why it " +
    "ranked, how strong its evidence is, which patterns or variants drove it, or what could " +
    "confirm or weaken it. Examples include “what is the B12 one?”, “explain finding #1,” and " +
    "“why did this rank so highly?” Returns the user’s rank and scores, score-driving matched or " +
    "partial patterns and impact points, relevant variants, possible subtypes and cofactors, " +
    "priority confirmation tests, weakening evidence, and interpretation guardrails. Distinguish " +
    "genetic susceptibility from a current condition and never present general catalog guidance " +
    "as the user’s medical history.",
  scope: "analysis.read",
  inputSchema: explainHealthHypothesisInputSchema,
  outputSchema: toolResponseOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) =>
    respond(
      await runtime.client.invoke(
        "explain_health_hypothesis",
        args,
        runtime.user,
        runtime.requestId,
      ),
      runtime,
    ),
};
