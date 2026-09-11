import { getAnalysisStatusInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

export const getAnalysisStatusTool: MutantToolDefinition = {
  name: "get_analysis_status",
  title: "Get Analysis Status",
  description:
    "Return the connected account's current analysis status and effective access plan. " +
    "Call this first to learn whether a saved analysis is ready. It returns no scores or findings.",
  inputSchema: getAnalysisStatusInputSchema,
  outputSchema: toolResponseOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) =>
    respond(
      await runtime.client.invoke("get_analysis_status", args, runtime.user, runtime.requestId),
      runtime,
    ),
};
