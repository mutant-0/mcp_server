import { z } from "zod";

/**
 * Per-tool input schemas. Optional fields map to "use the user's latest analysis"
 * semantics; required fields must be supplied by the model.
 */
export const getAnalysisStatusInputSchema = {
  analysisId: z
    .string()
    .describe("Optional Mutant analysis ID. If omitted, the user's latest analysis is used.")
    .optional(),
};

export const getGenomicOverviewInputSchema = {
  analysisId: z
    .string()
    .describe("Optional Mutant analysis ID. If omitted, the user's latest analysis is used.")
    .optional(),
};

export const getGeneticContextInputSchema = {
  context: z
    .string()
    .min(1)
    .describe("Module or context identifier for the requested biological area."),
};

export const getVariantContextInputSchema = {
  variantId: z.string().min(1).describe("rsID or variant identifier to interpret."),
};

export const getRootCauseDetailsInputSchema = {
  rootCauseId: z.string().min(1).describe("Identifier of the selected root cause."),
};

export const getSupportingEvidenceInputSchema = {
  findingId: z
    .string()
    .min(1)
    .describe("Root-cause or finding ID to retrieve supporting evidence for."),
};

export const getRelevantTestsInputSchema = {
  rootCauseId: z.string().describe("Optional root-cause ID.").optional(),
  context: z.string().describe("Optional context identifier.").optional(),
};

/**
 * Shared output envelope for every tool in the shell. Both placeholder and
 * upgrade responses validate against it. A `success` variant (with real `data`)
 * is added when business logic is wired in.
 */
export const toolResultOutputSchema = {
  status: z.enum(["not_implemented", "upgrade_required"]),
  tool: z.string().optional(),
  message: z.string(),
  required_tier: z.enum(["free", "paid"]).optional(),
  upgrade_url: z.string().optional(),
};
