import type { ToolResponse } from "../contract.js";
import { withSuggestedPrompts } from "../presentation/prompts.js";
import { withValidatedPlanNotice } from "../presentation/plan-notice.js";
import { analysisStatusOutputSchema, getAnalysisStatusInputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

/**
 * `get_analysis_status` is a pass-through of the authoritative backend status.
 *
 * The backend owns every routing fact (`dna_status`, `experience_state`,
 * `active_analysis`, `pending_analysis`, `capabilities`, `next_action`); this
 * handler only adds the deterministic model-facing text and the state-aware
 * suggested prompts.
 *
 * This is a routing read, not a UI response: it deliberately mounts no Apps SDK
 * component, so a status check can never produce a card (or prose about one).
 * Every usable ready state renders through `show_analysis_overview`, the single
 * tool whose descriptor declares the UI resource.
 */
export const getAnalysisStatusTool: MutantToolDefinition = {
  name: "get_analysis_status",
  title: "Get Analysis Status",
  description:
    "Check whether the user has connected DNA, whether an analysis is ready, what their plan " +
    "permits, and what to do next. Use this first when readiness is unknown. Read " +
    "experience_state and capabilities rather than inferring readiness yourself.\n\n" +
    "Three entry prompts can open a fresh conversation: \"Which of my Mutant findings best fits " +
    "the health history or records I've shared here?\", \"Show my current Mutant findings.\", and " +
    "\"Help me add my DNA data to Mutant.\". Call this tool first for all three. For the comparison " +
    "prompt, compare only against health history or records actually shared in this ChatGPT " +
    "conversation; when none were shared, ask what the user wants to share and do not imply access " +
    "to records. Pass only catalog-topic keywords to list_health_hypotheses, never the user's " +
    "health-history prose. For the add-DNA prompt, call show_dna_import.\n\n" +
    'If the result has experience_state="NO_DNA", do not answer with import instructions: call ' +
    "show_dna_import in the same turn so the DNA import UI is rendered.\n\n" +
    'When experience_state is "READY", "READY_REFRESH_AVAILABLE", or ' +
    '"READY_REFRESH_PROCESSING" and the user is opening Mutant or asking a broad opening ' +
    'question ("What are my top hypotheses?", "What did Mutant find?", "Show my results", or a ' +
    "general overview), call show_analysis_overview in the same turn whenever " +
    "capabilities.can_show_overview is true. This status tool mounts no card by itself: only " +
    "show_analysis_overview renders one. Its card shows the ranked findings and hints, and in " +
    'the two "READY_REFRESH_*" states it also shows the optional refresh banner while the ' +
    "current results stay usable. Do not answer a broad opening question with " +
    "list_health_hypotheses, do not write a duplicate prose list of the same findings, and do " +
    "not ask which finding to explore in prose.\n\n" +
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
    return respond(
      withSuggestedPrompts(withValidatedPlanNotice(response, runtime.config), "get_analysis_status"),
      runtime,
      { operation: "get_analysis_status" },
    );
  },
};
