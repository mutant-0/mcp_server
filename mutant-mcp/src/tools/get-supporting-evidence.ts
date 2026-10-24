import { withValidatedPlanNotice } from "../presentation/plan-notice.js";
import { getSupportingEvidenceInputSchema, supportingEvidenceOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

export const getSupportingEvidenceTool: MutantToolDefinition = {
  name: "get_supporting_evidence",
  title: "Get Supporting Evidence",
  description:
    "Scoring v3.4 uses only scoped module evidence and retained storm support, counting shared evidence once. Converging patterns explain relationships without a separate ranking bonus; perfect storms can contribute support. Use the saved components for historical reports, which may include a converging-pattern bonus. Confidence modulates genetic priority; Evo 2 remains an adjustment to existing weights, not independent evidence. " +
    "Return one focused evidence layer for a hypothesis: matched patterns, unique supporting " +
    "variants, module scoring traces, source citations, or detailed test guidance. Use only after " +
    "the hypothesis is known and only for the evidence type the user requested; do not return all " +
    'evidence kinds together. Use kind "modules" for the expanded module scoring trace (the ' +
    "concise module breakdown is already in explain_health_hypothesis); pass include_context true " +
    "only when contextual, non-contributing markers are also needed. Use kind \"tests\" for " +
    'detailed assay guidance ("show me every relevant test" or "what should I discuss with my ' +
    'clinician"). Detailed variant, module, and pattern rows may carry an evo2 field when the ' +
    "saved result adjusted that evidence: Evo 2 adjusts existing SNP weights using DNA sequence " +
    "context. Report it only as a sequence-context weighting of an existing SNP weight, never as " +
    "a separate evidence source or a risk percentage; an unmatched pattern or non-contributing " +
    "marker carries none.",
  scope: "analysis.read",
  inputSchema: getSupportingEvidenceInputSchema,
  outputSchema: supportingEvidenceOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) =>
    respond(
      withValidatedPlanNotice(
        await runtime.client.invoke(
          "get_supporting_evidence",
          args,
          runtime.user,
          runtime.requestId,
        ),
        runtime.config,
      ),
      runtime,
      { operation: "get_supporting_evidence" },
    ),
};
