import type { ToolResponse } from "../contract.js";
import { withSuggestedPrompts } from "../presentation/prompts.js";
import { getAnalysisStatusInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

/**
 * `get_analysis_status` is a pass-through of the authoritative backend status.
 *
 * The backend owns every routing fact (``dna_status``, ``analysis_status``,
 * ``regenerate``, ``regeneration``, ``next_action``, ``optional_actions``); this
 * handler only adds the deterministic model-facing text and the state-aware
 * suggested prompts.
 */
export const getAnalysisStatusTool: MutantToolDefinition = {
  name: "get_analysis_status",
  title: "Get Analysis Status",
  description:
    "Check whether the user has connected DNA, whether an analysis is ready, what their plan " +
    "permits, and what to do next. Use this first when readiness is unknown.\n\n" +
    'If the result has dna_status="missing", do not answer with import instructions: call ' +
    "show_dna_import in the same turn so the DNA import UI is rendered.\n\n" +
    'If analysis_status="ready" and the user is opening Mutant or asking for an overview, ' +
    "call show_analysis_overview in the same turn. Its card shows findings and hints; do not " +
    "write a duplicate prose summary.\n\n" +
    "A regenerate=true result means an optional refreshed analysis is available after DNA " +
    "resubmission; it does not invalidate the current results. Offer the refresh but continue " +
    "to the existing analysis unless the user asks for it or required is true.\n\n" +
    "The DNA import component polls this tool itself while analysis_status is processing, so do " +
    "not tell the user to keep asking whether processing has finished and do not narrate the " +
    "analysis status while that component is active.",
  scope: "analysis.read",
  inputSchema: getAnalysisStatusInputSchema,
  outputSchema: toolResponseOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) => {
    const response: ToolResponse = await runtime.client.invoke(
      "get_analysis_status",
      args,
      runtime.user,
      runtime.requestId,
    );
    return respond(withSuggestedPrompts(response, "get_analysis_status"), runtime, {
      operation: "get_analysis_status",
    });
  },
};
