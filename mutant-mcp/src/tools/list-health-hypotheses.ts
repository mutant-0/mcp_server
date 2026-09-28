import { withPublicUpgradeUrl } from "../presentation/upgrade.js";
import { hypothesisListOutputSchema, listHealthHypothesesInputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

export const listHealthHypothesesTool: MutantToolDefinition = {
  name: "list_health_hypotheses",
  title: "List Health Hypotheses",
  description:
    "List or search the health hypotheses in the current analysis. Send catalog-topic keywords " +
    "only, never patient-specific health information. Free accounts see their fixed top three; " +
    "Full accounts can search the whole analyzed set. This is never the initial display route: " +
    "for a broad opening question (\"What are my top hypotheses?\", \"Show my results\", \"What did " +
    'Mutant find?"), call get_analysis_status then show_analysis_overview so the card presents ' +
    "the ranked findings and hints. Use this tool after that for browsing, pagination, topic " +
    "search, sorting, and explicit comparisons such as \"Compare my top three,\" and never to " +
    "reproduce the overview card's list in prose. After a comparison answer, when the host " +
    "supports Apps SDK UI, call show_analysis_followups once with the same analysis_version and " +
    "the compared hypothesis ids.",
  scope: "analysis.read",
  inputSchema: listHealthHypothesesInputSchema,
  outputSchema: hypothesisListOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) =>
    respond(
      withPublicUpgradeUrl(
        await runtime.client.invoke("list_health_hypotheses", args, runtime.user, runtime.requestId),
        runtime.config,
      ),
      runtime,
      { operation: "list_health_hypotheses" },
    ),
};
