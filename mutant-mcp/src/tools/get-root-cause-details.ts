import type { MutantToolDefinition } from "./types.js";
import { readOnlyAnnotations } from "./types.js";
import { getRootCauseDetailsInputSchema, toolResultOutputSchema } from "../schemas/index.js";
import { notImplementedResult } from "../responses/tool-result.js";

export const getRootCauseDetailsTool: MutantToolDefinition = {
  name: "get_root_cause_details",
  title: "Get Root Cause Details",
  description: "Return detailed information about a selected root cause.",
  inputSchema: getRootCauseDetailsInputSchema,
  outputSchema: toolResultOutputSchema,
  annotations: readOnlyAnnotations,
  accessTier: "paid",
  handler: async () => notImplementedResult("get_root_cause_details"),
};
