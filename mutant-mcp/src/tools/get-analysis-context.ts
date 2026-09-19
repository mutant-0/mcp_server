import type { ToolResponse } from "../contract.js";
import { withSuggestedPrompts } from "../presentation/prompts.js";
import { getAnalysisContextInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

export const getAnalysisContextTool: MutantToolDefinition = {
  name: "get_analysis_context",
  title: "Get Analysis Context",
  description:
    "Return a concise overview of a ready DNA analysis: marker coverage, interpretation " +
    "boundaries, and the user's highest-ranked health hypotheses. Use after status reports the " +
    "analysis is ready, or when the user asks for an overview or top findings. Never ask the user " +
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
