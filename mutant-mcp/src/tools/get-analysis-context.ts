import type { ToolResponse } from "../contract.js";
import { withSuggestedPrompts } from "../presentation/prompts.js";
import { getAnalysisContextInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

export const getAnalysisContextTool: MutantToolDefinition = {
  name: "get_analysis_context",
  title: "Get Analysis Context",
  description:
    "Return the interpretation contract and starting context for a ready Mutant analysis: " +
    "how scores and evidence should be explained, important boundaries and limitations, access " +
    "scope, a compact preview of the highest-ranked hypotheses, and useful next questions. Use " +
    "once at the beginning of analysis exploration after status reports that the analysis is " +
    "ready. Use list_health_hypotheses for subsequent browsing, searching, sorting, pagination, " +
    "or comparisons. Tool selection: \"What can Mutant tell me?\" and \"What does my DNA say about " +
    "my health?\" call get_analysis_status, then get_analysis_context; \"Show or compare my top " +
    "three\" and \"Find thyroid-related hypotheses\" call list_health_hypotheses (with a query when " +
    "searching); \"Explain the B12 finding\" calls explain_health_hypothesis. Never ask the user " +
    "for an analysis ID; the current analysis is resolved from the connection.",
  scope: "analysis.read",
  inputSchema: getAnalysisContextInputSchema,
  outputSchema: toolResponseOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) => {
    const response: ToolResponse = await runtime.client.invoke(
      "get_analysis_context",
      args,
      runtime.user,
      runtime.requestId,
    );
    return respond(withSuggestedPrompts(response, "get_analysis_context"), runtime, {
      operation: "get_analysis_context",
    });
  },
};
