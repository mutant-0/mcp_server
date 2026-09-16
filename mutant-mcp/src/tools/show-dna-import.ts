import { CONTRACT_VERSION, type ToolResponse } from "../contract.js";
import { showDnaImportInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { DNA_IMPORT_UI_URI, dnaImportUiMeta } from "../ui/dna-import/resource.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

/**
 * Render the DNA import component.
 *
 * Deliberately makes no backend call: it only tells the component which state to
 * open in, and the component fetches the catalog and submits the report itself
 * through its own scoped tool calls. That keeps this tool's result free of
 * genetic data, so the model never sees a genotype.
 */
export const showDnaImportTool: MutantToolDefinition = {
  name: "show_dna_import",
  title: "Show DNA Import",
  description:
    "Render the Mutant DNA import UI.\n\n" +
    'Call this tool immediately whenever get_analysis_status returns dna_status="missing".\n' +
    "Do not merely tell the user to upload DNA; invoke this tool so the upload interface is " +
    "shown.",
  scope: "dna.import",
  uiVisibility: ["model", "app"],
  uiResourceUri: DNA_IMPORT_UI_URI,
  inputSchema: showDnaImportInputSchema,
  outputSchema: toolResponseOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (_args, runtime) => {
    // Both fields describe the routing precondition rather than a fresh backend
    // read: this tool is only reached when no usable analysis exists, and the
    // caller authenticated to get here. The backend will become the authority
    // for `dna_status` once get_analysis_status reports it directly.
    const response: ToolResponse = {
      contract_version: CONTRACT_VERSION,
      analysis_version: null,
      ok: true,
      data: {
        account_status: "connected",
        dna_status: "missing",
        status: "awaiting_file",
      },
      error: null,
    };
    // Echo the UI descriptor on the result too: some hosts mount the component
    // from the tool result rather than from the tool descriptor.
    return respond(response, runtime, { meta: dnaImportUiMeta() });
  },
};
