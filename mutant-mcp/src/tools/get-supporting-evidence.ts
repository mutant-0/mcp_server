import { getSupportingEvidenceInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

export const getSupportingEvidenceTool: MutantToolDefinition = {
  name: "get_supporting_evidence",
  title: "Get Supporting Evidence",
  description:
    "Return one focused evidence layer for a hypothesis: matched patterns, unique supporting " +
    "variants, module scoring traces, source citations, or detailed test guidance. Use only after " +
    "the hypothesis is known and only for the evidence type the user requested; do not return all " +
    'evidence kinds together. Use kind "modules" for the expanded module scoring trace (the ' +
    "concise module breakdown is already in explain_health_hypothesis); pass include_context true " +
    "only when contextual, non-contributing markers are also needed. Use kind \"tests\" for " +
    'detailed assay guidance ("show me every relevant test" or "what should I discuss with my ' +
    'clinician").',
  scope: "analysis.read",
  inputSchema: getSupportingEvidenceInputSchema,
  outputSchema: toolResponseOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) =>
    respond(
      await runtime.client.invoke("get_supporting_evidence", args, runtime.user, runtime.requestId),
      runtime,
      { operation: "get_supporting_evidence" },
    ),
};
