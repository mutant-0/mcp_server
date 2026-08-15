import type { MutantToolDefinition } from "./types.js";
import { readOnlyAnnotations } from "./types.js";
import { getGeneticContextInputSchema, toolResultOutputSchema } from "../schemas/index.js";
import { notImplementedResult } from "../responses/tool-result.js";

export const getGeneticContextTool: MutantToolDefinition = {
  name: "get_genetic_context",
  title: "Get Genetic Context",
  description: "Return genetic context for a requested biological area.",
  inputSchema: getGeneticContextInputSchema,
  outputSchema: toolResultOutputSchema,
  annotations: readOnlyAnnotations,
  accessTier: "free",
  handler: async () => notImplementedResult("get_genetic_context"),
};
