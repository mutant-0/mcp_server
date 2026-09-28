import {
  CONTRACT_VERSION,
  RESOLVE_FOLLOWUPS_OPERATION,
  type ShowAnalysisFollowupsData,
  type ToolResponse,
} from "../contract.js";
import { showAnalysisFollowupsInputSchema, showAnalysisFollowupsOutputSchema } from "../schemas/index.js";
import { ANALYSIS_FOLLOWUPS_UI_URI, analysisFollowupsUiMeta } from "../ui/analysis-followups/resource.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

/**
 * Mount the compact follow-up card after an explanation or comparison.
 *
 * The card is navigation only: this tool asks the backend to verify and bind the
 * follow-up (`resolve_analysis_followups`) against the same revision the answer
 * used, so every action it offers is pinned to an authorized hypothesis id. It is
 * deliberately separate from `show_analysis_overview`: a specific question must
 * not reopen the overview, and the overview must not grow a second action bar.
 */
export const showAnalysisFollowupsTool: MutantToolDefinition = {
  name: "show_analysis_followups",
  title: "Show Analysis Follow-ups",
  description:
    "Display a compact follow-up card with context-specific next steps. Call this once, " +
    "after an explanation (`explain_health_hypothesis`) or a comparison " +
    "(`list_health_hypotheses`), when the host supports Apps SDK UI and the preceding result " +
    "gave you the analysis_version and hypothesis ids. Pass the same analysis_version and the " +
    "hypothesis ids the answer covered (at most three); a mismatch is rejected rather than " +
    "silently switching revisions. This card never replaces or repeats the chat answer: keep " +
    "your explanation in ChatGPT and let the card offer the next question. Do not call it for " +
    "a broad opening question (use show_analysis_overview) and do not mount it more than once " +
    "per answer. If the host cannot render UI or this call fails, the chat answer still stands.",
  scope: "analysis.read",
  uiVisibility: ["model", "app"],
  uiResourceUri: ANALYSIS_FOLLOWUPS_UI_URI,
  inputSchema: showAnalysisFollowupsInputSchema,
  outputSchema: showAnalysisFollowupsOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) => {
    const intent = args.intent;
    const analysisVersion = args.analysis_version;
    const hypothesisIds = args.hypothesis_ids;
    const source = args.source;

    const operationArgs: Record<string, unknown> = {
      intent,
      analysis_version: analysisVersion,
      hypothesis_ids: hypothesisIds,
    };
    if (source !== undefined) operationArgs.source = source;

    const response = await runtime.client.invoke(
      RESOLVE_FOLLOWUPS_OPERATION,
      operationArgs,
      runtime.user,
      runtime.requestId,
    );
    if (!response.ok) {
      // A stale version, a locked id, or an unready analysis is an expected
      // application state: forward the structured error envelope rather than
      // throwing, and attach no UI descriptor, so a failed verification can
      // never mount a card bound to the wrong finding.
      return respond(response, runtime, {
        operation: "show_analysis_followups",
      });
    }

    const resolved = (response.data ?? {}) as {
      mode?: string;
      intent?: ShowAnalysisFollowupsData["intent"];
      plan?: ShowAnalysisFollowupsData["plan"];
      displayed_analysis_version?: string | null;
      displayed_hypotheses?: ShowAnalysisFollowupsData["displayed_hypotheses"];
      actions?: ShowAnalysisFollowupsData["actions"];
      upgrade?: ShowAnalysisFollowupsData["upgrade"];
      source?: string;
    };

    const data: ShowAnalysisFollowupsData = {
      ui_rendered: true,
      mode: "followups",
      intent: resolved.intent === "comparison" ? "comparison" : "explanation",
      plan: resolved.plan === "mutant_full" ? "mutant_full" : "mutant_free",
      displayed_analysis_version: resolved.displayed_analysis_version ?? null,
      displayed_hypotheses: resolved.displayed_hypotheses ?? [],
      actions: resolved.actions ?? [],
    };
    if (resolved.upgrade) data.upgrade = resolved.upgrade;
    if (resolved.source) data.source = resolved.source;

    const envelope: ToolResponse = {
      contract_version: CONTRACT_VERSION,
      analysis_version: response.analysis_version,
      ok: true,
      data: data as unknown as Record<string, unknown>,
      error: null,
    };
    return respond(envelope, runtime, {
      operation: "show_analysis_followups",
      meta: {
        ...analysisFollowupsUiMeta(),
        mutant: {
          mode: "followups",
          intent: data.intent,
          displayed_analysis_version: data.displayed_analysis_version,
        },
      },
    });
  },
};
