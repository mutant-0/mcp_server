import { getHypothesisDetailsInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

export const getHypothesisDetailsTool: MutantToolDefinition = {
  name: "get_hypothesis_details",
  title: "Get Hypothesis Details",
  description:
    "Return the full stored interpretation of one health hypothesis: scoring, matched patterns, " +
    "clinical correlation and suggested tests, cofactors, subtypes, and interpretation " +
    "guardrails. The correlation is general catalog guidance, not a report of the user's records.",
  scope: "analysis.read",
  inputSchema: getHypothesisDetailsInputSchema,
  outputSchema: toolResponseOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) =>
    respond(
      await runtime.client.invoke("get_hypothesis_details", args, runtime.user, runtime.requestId),
      runtime,
    ),
};
