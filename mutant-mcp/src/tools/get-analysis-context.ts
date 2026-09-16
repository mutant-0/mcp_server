import { getAnalysisContextInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

export const getAnalysisContextTool: MutantToolDefinition = {
  name: "get_analysis_context",
  title: "Get Analysis Context",
  description:
    "Start here. Return summary context for the connected account's current analysis: marker " +
    "coverage, interpretation rules and limitations, and the leading health hypotheses. " +
    "Never ask the user for an analysis ID; the current analysis is resolved from the connection.",
  scope: "analysis.read",
  inputSchema: getAnalysisContextInputSchema,
  outputSchema: toolResponseOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) =>
    respond(
      await runtime.client.invoke("get_analysis_context", args, runtime.user, runtime.requestId),
      runtime,
    ),
};
