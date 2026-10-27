import { envelopeOf } from "../schemas/index.js";
import {
  consentDataSchema,
  getConsentInputSchema,
  saveConsentInputSchema,
} from "../schemas/consent.js";
import { respond } from "./respond.js";
import {
  dnaImportWriteAnnotations,
  readOnlyAnnotations,
  type MutantToolDefinition,
} from "./types.js";

const outputSchema = envelopeOf(consentDataSchema);
export const getConsentTool: MutantToolDefinition = {
  name: "get_consent",
  title: "Review Mutant Consent",
  description:
    "Read the current privacy notice and this connection's consent choices. Component-only; contains no genetic findings.",
  scope: "analysis.read",
  uiVisibility: ["app"],
  inputSchema: getConsentInputSchema,
  outputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) => {
    const input = getConsentInputSchema.parse(args);
    return respond(
      await runtime.client.invoke("get_consent", input, runtime.user, runtime.requestId),
      runtime,
      { operation: "get_consent" },
    );
  },
};
export const saveConsentTool: MutantToolDefinition = {
  name: "save_consent",
  title: "Save Mutant Consent",
  description:
    "Record explicitly selected privacy permissions for the authenticated connection and current notice. Component-only; never reconnects an integration.",
  // Reuse the existing write grant. analysis.read alone never authorizes writes.
  scope: "dna.import",
  uiVisibility: ["app"],
  inputSchema: saveConsentInputSchema,
  outputSchema,
  annotations: dnaImportWriteAnnotations,
  handler: async (args, runtime) => {
    const input = saveConsentInputSchema.parse(args);
    return respond(
      await runtime.client.invoke("save_consent", input, runtime.user, runtime.requestId),
      runtime,
      { operation: "save_consent" },
    );
  },
};
