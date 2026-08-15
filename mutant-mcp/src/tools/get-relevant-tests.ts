import type { MutantToolDefinition } from "./types.js";
import { readOnlyAnnotations } from "./types.js";
import { getRelevantTestsInputSchema, toolResultOutputSchema } from "../schemas/index.js";
import { notImplementedResult } from "../responses/tool-result.js";

export const getRelevantTestsTool: MutantToolDefinition = {
  name: "get_relevant_tests",
  title: "Get Relevant Tests",
  description: "Return relevant clinical or functional testing options.",
  inputSchema: getRelevantTestsInputSchema,
  outputSchema: toolResultOutputSchema,
  annotations: readOnlyAnnotations,
  accessTier: "paid",
  handler: async () => notImplementedResult("get_relevant_tests"),
};
