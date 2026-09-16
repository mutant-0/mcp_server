import { getGeneticContextInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

export const getGeneticContextTool: MutantToolDefinition = {
  name: "get_genetic_context",
  title: "Get Genetic Context",
  description:
    "Explore marker-level genetic context: call status, module scoring status, and pattern roles. " +
    "Full accounts can query by module, gene, or specific rsIDs across the analyzed marker set. " +
    "Free accounts must pass a hypothesis they can access and are limited to its evidence.",
  scope: "analysis.read",
  inputSchema: getGeneticContextInputSchema,
  outputSchema: toolResponseOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) =>
    respond(
      await runtime.client.invoke("get_genetic_context", args, runtime.user, runtime.requestId),
      runtime,
    ),
};
