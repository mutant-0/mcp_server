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
    'If experience_state="READY" and the user is opening Mutant or asking a broad opening ' +
    'question ("What are my top hypotheses?", "What did Mutant find?", "Show my results", or a ' +
    "general overview), call show_analysis_overview in the same turn. Its card shows the ranked " +
    "findings and hints; do not answer a broad opening question with list_health_hypotheses and " +
    "do not write a duplicate prose list of the same findings.\n\n" +
    'When experience_state is "READY_REFRESH_AVAILABLE" or "READY_REFRESH_PROCESSING", this ' +
    "tool result mounts the Apps SDK card with a refresh action. Let the card present the " +
    "update option instead of asking which finding to explore in prose. The current results " +
    "remain usable until the user selects refresh.\n\n" +
    'When experience_state is "PROCESSING_INITIAL" or ' +
    '"REFRESH_PROCESSING_NO_USABLE_ANALYSIS":\n' +
    "- Do not call analysis, overview, hypothesis, evidence, or genetic-context tools while no " +
    "usable analysis exists.\n" +
    "- Do not describe, preview, or speculate about future unavailable capabilities, even when " +
    "asked what will become available. Do not infer future availability from the existence of " +
    "other MCP tools or from entitlement metadata.\n" +
    "- Do not enumerate future genes, modules, rsIDs, variants, hypotheses, scores, or patterns.\n" +
    '- Never promise a future capability. "Once processing completes, I can show your DNA at ' +
    'the marker level" is a forbidden response.\n' +
    "- When a Mutant component is rendering this state, let it own the experience; do not add " +
    "unsolicited processing narration.\n" +
    "- If the user explicitly asks what is happening or what comes next, answer briefly using " +
    "only the current status payload, without predicting capabilities or completion time.\n" +
    "- When the component owns polling, do not initiate assistant polling loops or tell the " +
    "user to keep asking for updates.\n" +
    "- Silence is preferred over describing unavailable Mutant capabilities.\n\n" +
    "The DNA import component polls its own app-only poll_analysis_status tool while " +
    "experience_state is a processing state, so do not tell the user to keep asking whether " +
    "processing has finished, do not re-call this tool to poll, and do not narrate the " +
    "analysis status while that component is active.",
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
