import { CONTRACT_VERSION, type ToolResponse } from "../contract.js";
import { showDnaImportInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { DNA_IMPORT_UI_URI, dnaImportUiMeta } from "../ui/dna-import/resource.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

/**
 * Render the DNA import component.
 *
 * Deliberately makes no backend call: it only mounts the component, which reads
 * the account's DNA and analysis state itself through `get_analysis_status` and
 * then fetches the catalog and submits the report through its own scoped tool
 * calls. That keeps this tool's result free of genetic data and of any state the
 * component would have to reconcile, so the model never sees a genotype and
 * never narrates a status that has already moved on.
 *
 * `mode: "regenerate"` is an explicit user-selected (or required) refresh; it
 * never causes a resubmission by itself.
 */
export const showDnaImportTool: MutantToolDefinition = {
  name: "show_dna_import",
  title: "Show DNA Import",
  description:
    "Displays and manages the complete Mutant DNA import workflow, for an initial upload or an " +
    "explicitly selected analysis refresh.\n\n" +
    "The component handles file selection, local DNA processing, report creation, " +
    "processing-status polling, and the completion UI.\n\n" +
    'Call it immediately when get_analysis_status reports dna_status="missing". For ' +
    'mode="regenerate", call it only when regeneration is required or the user asks to refresh.\n\n' +
    "After calling this tool, do not ask the user to check analysis status manually, do not " +
    "restate DNA status, analysis status, or import instructions from earlier tool results, and " +
    "do not tell the user to upload DNA: the component owns the whole flow.",
  scope: "dna.import",
  uiVisibility: ["model", "app"],
  uiResourceUri: DNA_IMPORT_UI_URI,
  inputSchema: showDnaImportInputSchema,
  outputSchema: toolResponseOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) => {
    const mode = args.mode === "regenerate" ? "regenerate" : "initial";
    // No routing state is echoed back: the component reads the authoritative
    // state from get_analysis_status on mount, and a stale `dna_status` here
    // would be exactly the kind of mutable state the model must not narrate.
    // The selected mode is the one piece of state the component needs, and it
    // is reflected in the typed data plus widget-only `_meta`.
    const response: ToolResponse = {
      contract_version: CONTRACT_VERSION,
      analysis_version: null,
      ok: true,
      data: { ui_rendered: true, mode },
      error: null,
    };
    // Echo the UI descriptor on the result too: some hosts mount the component
    // from the tool result rather than from the tool descriptor.
    return respond(response, runtime, {
      operation: "show_dna_import",
      meta: { ...dnaImportUiMeta(), mutant: { mode } },
    });
  },
};
