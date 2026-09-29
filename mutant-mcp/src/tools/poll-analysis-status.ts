import type { ToolResponse } from "../contract.js";
import { withoutPollingHints } from "../presentation/processing.js";
import { withValidatedPlanNotice } from "../presentation/plan-notice.js";
import { analysisStatusOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

/**
 * `poll_analysis_status` is the component-owned counterpart of
 * `get_analysis_status`.
 *
 * It is the same backend read (`get_analysis_status`), but it is hidden from the
 * model (`uiVisibility: ["app"]`) and is called only by the DNA import component
 * while it owns the processing experience. Because tool identity is the trusted
 * ownership signal, this tool omits the polling `next_action` and never attaches
 * `suggested_prompts`: the card owns status, so the model must not repeat it.
 *
 * The model-facing `get_analysis_status` keeps its deterministic next action for
 * the non-UI path; only the component-owned channel strips it.
 */
export const pollAnalysisStatusTool: MutantToolDefinition = {
  name: "poll_analysis_status",
  title: "Poll Analysis Status",
  description:
    "Component-owned analysis status read. Called only by the Mutant DNA import component " +
    "while it polls for a processing analysis; hidden from the model. Returns the same " +
    "authoritative status payload as get_analysis_status without polling next-action hints or " +
    "suggested prompts.",
  scope: "analysis.read",
  uiVisibility: ["app"],
  inputSchema: {},
  outputSchema: analysisStatusOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) => {
    const response: ToolResponse = await runtime.client.invoke(
      "get_analysis_status",
      args,
      runtime.user,
      runtime.requestId,
    );
    return respond(
      withoutPollingHints(withValidatedPlanNotice(response, runtime.config)),
      runtime,
      { operation: "poll_analysis_status" },
    );
  },
};
