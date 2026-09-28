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
    "When a user opens Mutant or asks for a general overview and get_analysis_status reports " +
    "a ready analysis, call this tool in the same turn and let the card present the results. " +
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
    const uiMeta = { ...dnaImportUiMeta(), mutant: { mode: "overview" } };
    if (!response.ok) {
      // An unready analysis is an expected application state: forward the
      // structured error envelope rather than throwing.
      return respond(response, runtime, {
        operation: "show_analysis_overview",
        meta: uiMeta,
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
