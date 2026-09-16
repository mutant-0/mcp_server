import { getSupportingEvidenceInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

export const getSupportingEvidenceTool: MutantToolDefinition = {
  name: "get_supporting_evidence",
  title: "Get Supporting Evidence",
  description:
    "Return the stored evidence behind one health hypothesis: matched patterns and their resolved " +
    "score contribution, per-marker variant evidence, or the curated literature sources. " +
    "Evidence for a hypothesis is never expanded with data from other hypotheses.",
  scope: "analysis.read",
  inputSchema: getSupportingEvidenceInputSchema,
  outputSchema: toolResponseOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) =>
    respond(
      await runtime.client.invoke("get_supporting_evidence", args, runtime.user, runtime.requestId),
      runtime,
    ),
};
