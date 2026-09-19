import { listHealthHypothesesInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

export const listHealthHypothesesTool: MutantToolDefinition = {
  name: "list_health_hypotheses",
  title: "List Health Hypotheses",
  description:
    "List or search the health hypotheses in the current analysis. Send catalog-topic keywords " +
    "only, never patient-specific health information. Free accounts see their fixed top three; " +
    "Full accounts can search the whole analyzed set. Do not use this tool to initialize the " +
    "overall interpretation experience; use get_analysis_context for that purpose.",
  scope: "analysis.read",
  inputSchema: listHealthHypothesesInputSchema,
  outputSchema: toolResponseOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) =>
    respond(
      await runtime.client.invoke("list_health_hypotheses", args, runtime.user, runtime.requestId),
      runtime,
      { operation: "list_health_hypotheses" },
    ),
};
