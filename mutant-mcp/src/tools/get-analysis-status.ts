import type { ToolResponse } from "../contract.js";
import { withSuggestedPrompts } from "../presentation/prompts.js";
import { withPublicUpgradeUrl } from "../presentation/upgrade.js";
import { analysisStatusOutputSchema, getAnalysisStatusInputSchema } from "../schemas/index.js";
import { dnaImportUiMeta } from "../ui/dna-import/resource.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

/**
 * `get_analysis_status` is a pass-through of the authoritative backend status.
 *
 * The backend owns every routing fact (`dna_status`, `experience_state`,
 * `active_analysis`, `pending_analysis`, `capabilities`, `next_action`); this
 * handler only adds the deterministic model-facing text, the state-aware
 * suggested prompts, and the refresh card.
 */
export const getAnalysisStatusTool: MutantToolDefinition = {
  name: "get_analysis_status",
  title: "Get Analysis Status",
  description:
    "Check whether the user has connected DNA, whether an analysis is ready, what their plan " +
    "permits, and what to do next. Use this first when readiness is unknown. Read " +
    "experience_state and capabilities rather than inferring readiness yourself.\n\n" +
    'If the result has experience_state="NO_DNA", do not answer with import instructions: call ' +
    "show_dna_import in the same turn so the DNA import UI is rendered.\n\n" +
    'If experience_state="READY" and the user is opening Mutant or asking for an overview, ' +
    "call show_analysis_overview in the same turn. Its card shows findings and hints; do not " +
    "write a duplicate prose summary.\n\n" +
    'When experience_state is "READY_REFRESH_AVAILABLE" or "READY_REFRESH_PROCESSING", this ' +
    "tool result mounts the Apps SDK card with a refresh action. Let the card present the " +
    "update option instead of asking which finding to explore in prose. The current results " +
    "remain usable until the user selects refresh.\n\n" +
    'The DNA import component polls this tool itself while experience_state is a processing ' +
    "state, so do not tell the user to keep asking whether processing has finished and do not " +
    "narrate the analysis status while that component is active.",
  scope: "analysis.read",
  inputSchema: getAnalysisStatusInputSchema,
  outputSchema: analysisStatusOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) => {
    const response: ToolResponse = await runtime.client.invoke(
      "get_analysis_status",
      args,
      runtime.user,
      runtime.requestId,
    );
    const data = response.data;
    const experience =
      typeof data?.experience_state === "string" ? data.experience_state : null;
    const showRefreshCard =
      response.ok &&
      (experience === "READY_REFRESH_AVAILABLE" ||
        experience === "READY_REFRESH_PROCESSING");
    return respond(
      withSuggestedPrompts(withPublicUpgradeUrl(response, runtime.config), "get_analysis_status"),
      runtime,
      {
        operation: "get_analysis_status",
        ...(showRefreshCard
          ? { meta: { ...dnaImportUiMeta(), mutant: { mode: "overview" } } }
          : {}),
      },
    );
  },
};
