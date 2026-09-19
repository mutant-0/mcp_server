import type { ToolResponse } from "../contract.js";
import { withSuggestedPrompts } from "../presentation/prompts.js";
import { explainHealthHypothesisInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

export const explainHealthHypothesisTool: MutantToolDefinition = {
  name: "explain_health_hypothesis",
  title: "Explain Health Hypothesis",
  description:
    "Explain one ranked Mutant finding. Use when the user asks what a finding means, why it " +
    "ranked, how strong it is, what supports it, what would strengthen or weaken it, or asks " +
    'questions such as "What is the B12 one?" or "Explain my #1 finding." Returns an ' +
    "explanation-ready summary: the plain-English bottom line, whether the genetic support is " +
    "broad or concentrated, which biological modules and retained patterns contributed, why it " +
    "ranked, the boundary between genetic support and an established condition, at most two short " +
    "primary confirmation checks, and what would strengthen or weaken the interpretation. Explain " +
    "modules and patterns before individual genes or variants. Use get_supporting_evidence only " +
    "when the user asks for detailed modules, patterns, variants, sources, or tests.",
  scope: "analysis.read",
  inputSchema: explainHealthHypothesisInputSchema,
  outputSchema: toolResponseOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) => {
    const response: ToolResponse = await runtime.client.invoke(
      "explain_health_hypothesis",
      args,
      runtime.user,
      runtime.requestId,
    );
    return respond(withSuggestedPrompts(response, "explain_health_hypothesis"), runtime, {
      operation: "explain_health_hypothesis",
    });
  },
};
