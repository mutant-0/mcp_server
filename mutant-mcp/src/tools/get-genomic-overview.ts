import type { MutantToolDefinition } from "./types.js";
import { readOnlyAnnotations } from "./types.js";
import { getGenomicOverviewInputSchema, toolResultOutputSchema } from "../schemas/index.js";
import { notImplementedResult } from "../responses/tool-result.js";

export const getGenomicOverviewTool: MutantToolDefinition = {
  name: "get_genomic_overview",
  title: "Get Genomic Overview",
  description: "Return a high-level overview of available genomic findings.",
  inputSchema: getGenomicOverviewInputSchema,
  outputSchema: toolResultOutputSchema,
  annotations: readOnlyAnnotations,
  accessTier: "free",
  handler: async () => notImplementedResult("get_genomic_overview"),
};
