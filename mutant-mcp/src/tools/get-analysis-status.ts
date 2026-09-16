import type { ToolResponse } from "../contract.js";
import { getAnalysisStatusInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

/**
 * Ensure the status payload carries `dna_status` so ChatGPT can decide whether to
 * route to the DNA import interface.
 *
 * TEMPORARY SHIM: the reports-generator is the intended authority for this field
 * (it is the only layer that knows whether DNA was received without a report yet).
 * Until it sends `dna_status`, derive it from the analysis status: an analysis
 * that exists at all was generated from imported DNA, so `status === "none"`
 * means no DNA has been imported. Delete the derivation once the backend sends
 * the field; a backend-provided value always wins.
 */
export function withDnaStatus(response: ToolResponse): ToolResponse {
  if (!response.ok || !response.data || typeof response.data !== "object") return response;
  const data = response.data as Record<string, unknown>;
  if (typeof data.dna_status === "string") return response;

  const analysis = data.analysis;
  const status =
    analysis && typeof analysis === "object"
      ? (analysis as { status?: unknown }).status
      : undefined;
  const dnaStatus = typeof status === "string" && status !== "none" ? "available" : "missing";

  return { ...response, data: { ...data, dna_status: dnaStatus } };
}

export const getAnalysisStatusTool: MutantToolDefinition = {
  name: "get_analysis_status",
  title: "Get Analysis Status",
  description:
    "Return the connected account's current analysis status, DNA status, and effective access " +
    "plan. Call this first to learn whether a saved analysis is ready, and whether the user " +
    "still needs to add DNA data. When dna_status is 'missing', call show_dna_import. It " +
    "returns no scores or findings.",
  scope: "analysis.read",
  inputSchema: getAnalysisStatusInputSchema,
  outputSchema: toolResponseOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) =>
    respond(
      withDnaStatus(
        await runtime.client.invoke("get_analysis_status", args, runtime.user, runtime.requestId),
      ),
      runtime,
    ),
};
