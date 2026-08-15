import type { MutantToolDefinition } from "./types.js";
import { readOnlyAnnotations } from "./types.js";
import { getVariantContextInputSchema, toolResultOutputSchema } from "../schemas/index.js";
import { notImplementedResult } from "../responses/tool-result.js";

export const getVariantContextTool: MutantToolDefinition = {
  name: "get_variant_context",
  title: "Get Variant Context",
  description: "Return interpretation for a specific genetic variant.",
  inputSchema: getVariantContextInputSchema,
  outputSchema: toolResultOutputSchema,
  annotations: readOnlyAnnotations,
  accessTier: "free",
  handler: async () => notImplementedResult("get_variant_context"),
};
