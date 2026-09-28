import {
  CONTRACT_VERSION,
  type ShowAnalysisOverviewData,
  type ToolResponse,
} from "../contract.js";
import { showAnalysisOverviewOutputSchema } from "../schemas/index.js";
import { DNA_IMPORT_UI_URI, dnaImportUiMeta } from "../ui/dna-import/resource.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

/**
 * Mount the ready-analysis card under analysis.read.
 *
 * The card is bound to one immutable snapshot: this tool asks the backend to
 * resolve the current analysis (`resolve_analysis_snapshot`) and returns the
 * exact `displayed_analysis_version` plus the visible hypothesis identities. The
 * card renders that snapshot and passes its version back on follow-ups, so "#3"
 * cannot silently mean a different finding than the one the model described.
 */
export const showAnalysisOverviewTool: MutantToolDefinition = {
  name: "show_analysis_overview",
  title: "Show Analysis Overview",
  description:
    "Display the Mutant analysis card with accessible findings and suggested questions. " +
    'Call this for any broad opening question ("What are my top hypotheses?", "What did Mutant ' +
    'find?", "Show my results", or a general overview) and when a user opens Mutant: when ' +
    "get_analysis_status reports experience_state READY (or a usable refresh) with " +
    "can_show_overview true, call this tool in the same turn and let the card present the " +
    "results. The card is the display route for the ranked findings; do not answer the same " +
    "question with list_health_hypotheses and do not restate the card's list in prose. " +
    "The card is bound to the analysis revision returned here; pass displayed_analysis_version " +
    "on follow-up analysis calls. For a specific question, use the analysis tools directly " +
    "instead of reopening the card.",
  scope: "analysis.read",
  uiVisibility: ["model", "app"],
  uiResourceUri: DNA_IMPORT_UI_URI,
  inputSchema: {},
  outputSchema: showAnalysisOverviewOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (_args, runtime) => {
    const response = await runtime.client.invoke(
      "resolve_analysis_snapshot",
      {},
      runtime.user,
      runtime.requestId,
    );
    if (!response.ok) {
      // An unready analysis is an expected application state: forward the
      // structured error envelope rather than throwing. No UI descriptor is
      // attached, so a processing/locked/failed result can never mount the
      // overview card: the processing experience belongs to show_dna_import and
      // poll_analysis_status.
      return respond(response, runtime, {
        operation: "show_analysis_overview",
      });
    }

    const snapshot = (response.data ?? {}) as {
      displayed_analysis_version?: string | null;
      displayed_hypotheses?: ShowAnalysisOverviewData["displayed_hypotheses"];
    };
    const data: ShowAnalysisOverviewData = {
      ui_rendered: true,
      mode: "overview",
      displayed_analysis_version: snapshot.displayed_analysis_version ?? null,
      displayed_hypotheses: snapshot.displayed_hypotheses ?? [],
    };
    const envelope: ToolResponse = {
      contract_version: CONTRACT_VERSION,
      analysis_version: response.analysis_version,
      ok: true,
      data: data as unknown as Record<string, unknown>,
      error: null,
    };
    return respond(envelope, runtime, {
      operation: "show_analysis_overview",
      meta: {
        ...dnaImportUiMeta(),
        mutant: {
          mode: "overview",
          displayed_analysis_version: data.displayed_analysis_version,
        },
      },
    });
  },
};
