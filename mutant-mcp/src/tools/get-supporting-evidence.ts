import type { MutantToolDefinition } from "./types.js";
import { readOnlyAnnotations } from "./types.js";
import { getSupportingEvidenceInputSchema, toolResultOutputSchema } from "../schemas/index.js";
import { notImplementedResult } from "../responses/tool-result.js";

export const getSupportingEvidenceTool: MutantToolDefinition = {
  name: "get_supporting_evidence",
  title: "Get Supporting Evidence",
  description: "Return evidence, relevant variants, and sources for a finding.",
  inputSchema: getSupportingEvidenceInputSchema,
  outputSchema: toolResultOutputSchema,
  annotations: readOnlyAnnotations,
  accessTier: "paid",
  handler: async () => notImplementedResult("get_supporting_evidence"),
};
