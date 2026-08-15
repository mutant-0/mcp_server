import type { MutantToolDefinition } from "./types.js";
import { readOnlyAnnotations } from "./types.js";
import { getAnalysisStatusInputSchema, toolResultOutputSchema } from "../schemas/index.js";
import { notImplementedResult } from "../responses/tool-result.js";

export const getAnalysisStatusTool: MutantToolDefinition = {
  name: "get_analysis_status",
  title: "Get Analysis Status",
  description:
    "Determine whether the user has uploaded a genome and whether processing is complete.",
  inputSchema: getAnalysisStatusInputSchema,
  outputSchema: toolResultOutputSchema,
  annotations: readOnlyAnnotations,
  accessTier: "free",
  handler: async () => notImplementedResult("get_analysis_status"),
};
