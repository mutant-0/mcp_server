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
    "reproduce the overview card's list in prose. Only when the request itself asked to compare " +
    "two or more accessible findings, when the host supports Apps SDK UI, call " +
    "show_analysis_followups once with the same analysis_version and the compared hypothesis " +
    "ids; do not call it for a topic search, a no-match or browse answer, or a request that " +
    "compares findings with the user's health history or records. Every success returns a " +
    "server-authored search_scope describing " +
    "what the search actually covered: hypothesis_scope, the searched and unsearched ranked counts, " +
    "and broader_ranked_search_available. When a topic query returns no items, answer once from that " +
    "scope instead of treating the miss as proof the topic is absent. A Free no_match_in_accessible_scope " +
    "means only that the accessible top three did not match; it does not say whether the locked ranked " +
    "set contains the topic, so never speculate about a specific locked finding and never claim Mutant " +
    "Full will find it. State the wider-search sentence only when broader_ranked_search_available is true; " +
    "a Full no_match_in_ranked_search_fields is limited to the catalog search fields (name, summary, " +
    "plain-language summary, and type), not every biological evidence layer. Do not compare unseen scores, " +
    "invent gene or variant mechanisms, or pitch an upgrade; the entitlement boundary is a factual scope " +
    "statement, and follow-up questions about plan capabilities may be answered from search_scope.",
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
