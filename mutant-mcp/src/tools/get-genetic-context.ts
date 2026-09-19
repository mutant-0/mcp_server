import { getGeneticContextInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

export const getGeneticContextTool: MutantToolDefinition = {
  name: "get_genetic_context",
  title: "Get Genetic Context",
  description:
    "Inspect unique analyzed markers by hypothesis, gene, module, or rsID, including call state, " +
    "contribution status, and all pattern memberships (a marker appears once, with every pattern " +
    "membership nested). Use for marker-level questions or independent genetic exploration " +
    "permitted by the user's plan; do not use it for a plain-language hypothesis explanation. " +
    "Module summaries are returned only with include_modules or when the request is module-scoped.",
  scope: "analysis.read",
  inputSchema: getGeneticContextInputSchema,
  outputSchema: toolResponseOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) =>
    respond(
      await runtime.client.invoke("get_genetic_context", args, runtime.user, runtime.requestId),
      runtime,
      { operation: "get_genetic_context" },
    ),
};
