import { CONTRACT_VERSION, type ToolResponse } from "../contract.js";
import { toolResponseOutputSchema } from "../schemas/index.js";
import { DNA_IMPORT_UI_URI, dnaImportUiMeta } from "../ui/dna-import/resource.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

/** Mount the ready-analysis card under analysis.read, without invoking the backend. */
export const showAnalysisOverviewTool: MutantToolDefinition = {
  name: "show_analysis_overview",
  title: "Show Analysis Overview",
  description:
    "Display the Mutant analysis card with accessible findings and suggested questions. " +
    "When a user opens Mutant or asks for a general overview and get_analysis_status reports " +
    "a ready analysis, call this tool in the same turn and let the card present the results. " +
    "The card reads the current analysis itself. For a specific question, use the analysis " +
    "tools directly instead of reopening the card.",
  scope: "analysis.read",
  uiVisibility: ["model", "app"],
  uiResourceUri: DNA_IMPORT_UI_URI,
  inputSchema: {},
  outputSchema: toolResponseOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (_args, runtime) => {
    const response: ToolResponse = {
      contract_version: CONTRACT_VERSION,
      analysis_version: null,
      ok: true,
      data: { ui_rendered: true, mode: "overview" },
      error: null,
    };
    return respond(response, runtime, {
      operation: "show_analysis_overview",
      meta: { ...dnaImportUiMeta(), mutant: { mode: "overview" } },
    });
  },
};
