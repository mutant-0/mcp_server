import type { ToolName, ToolResponse } from "../contract.js";
import { getAnalysisStatusInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

/** Routing states `get_analysis_status` guarantees on every successful result. */
export type DnaStatus = "missing" | "available";
export type AnalysisStatus = "not_started" | "processing" | "ready" | "failed";

/**
 * The single next move the model is expected to make, stated explicitly so it
 * never has to infer routing from the raw backend payload.
 */
export interface NextAction {
  tool: ToolName;
  reason: string;
}

/** Human-readable labels for the backend's entitlement slugs. */
const PLAN_LABELS: Record<string, string> = {
  mutant_free: "Mutant Free",
  mutant_full: "Mutant Full",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function deriveAnalysisStatus(data: Record<string, unknown>): AnalysisStatus {
  if (
    data.analysis_status === "not_started" ||
    data.analysis_status === "processing" ||
    data.analysis_status === "ready" ||
    data.analysis_status === "failed"
  ) {
    return data.analysis_status;
  }
  const status = asRecord(data.analysis)?.status;
  if (status === "processing" || status === "ready" || status === "failed") return status;
  // `none` (and anything unrecognized) means no analysis has been generated.
  return "not_started";
}

function deriveDnaStatus(data: Record<string, unknown>, analysisStatus: AnalysisStatus): DnaStatus {
  if (data.dna_status === "missing" || data.dna_status === "available") return data.dna_status;
  // An analysis that exists at all was generated from imported DNA, so any
  // analysis state past `not_started` means DNA is on file.
  return analysisStatus === "not_started" ? "missing" : "available";
}

function derivePlan(data: Record<string, unknown>): string {
  if (typeof data.plan === "string" && data.plan.length > 0) return data.plan;
  const raw = asRecord(data.entitlement)?.plan;
  if (typeof raw === "string" && raw.length > 0) return PLAN_LABELS[raw] ?? raw;
  return "unknown";
}

function deriveNextAction(dnaStatus: DnaStatus, analysisStatus: AnalysisStatus): NextAction {
  if (dnaStatus === "missing") {
    return {
      tool: "show_dna_import",
      reason: "DNA data is required before an analysis can be generated.",
    };
  }
  switch (analysisStatus) {
    case "ready":
      return {
        tool: "get_analysis_context",
        reason: "The analysis is ready; start with the analysis context.",
      };
    case "processing":
      return {
        tool: "get_analysis_status",
        reason: "The analysis is still processing; call again shortly for an update.",
      };
    case "failed":
      return {
        tool: "show_dna_import",
        reason: "The last analysis failed; re-import DNA data to generate a new one.",
      };
    default:
      return {
        tool: "show_dna_import",
        reason:
          "DNA data is on file but no analysis has been generated; re-import to create one.",
      };
  }
}

/**
 * Ensure the status payload carries the routing contract the model relies on:
 * `dna_status`, `analysis_status`, `plan`, and an explicit `next_action`.
 *
 * TEMPORARY SHIM: the reports-generator is the intended authority for these
 * fields (it is the only layer that knows whether DNA was received without a
 * report yet). Until it sends them, derive them from the raw status payload; a
 * backend-provided value always wins. Delete the derivation once the backend
 * sends the fields.
 */
export function withRoutingHints(response: ToolResponse): ToolResponse {
  if (!response.ok || !response.data || typeof response.data !== "object") return response;
  const data = response.data as Record<string, unknown>;

  const analysisStatus = deriveAnalysisStatus(data);
  const dnaStatus = deriveDnaStatus(data, analysisStatus);
  const plan = derivePlan(data);
  const providedNextAction = asRecord(data.next_action);
  const nextAction =
    providedNextAction && typeof providedNextAction.tool === "string"
      ? (data.next_action as unknown as NextAction)
      : deriveNextAction(dnaStatus, analysisStatus);

  return {
    ...response,
    data: {
      ...data,
      dna_status: dnaStatus,
      analysis_status: analysisStatus,
      plan,
      next_action: nextAction,
    },
  };
}

export const getAnalysisStatusTool: MutantToolDefinition = {
  name: "get_analysis_status",
  title: "Get Analysis Status",
  description:
    "Checks whether the authenticated Mutant account has DNA data and a completed analysis.\n\n" +
    "IMPORTANT:\n" +
    'If the result has dna_status="missing", do not answer the user with instructions about ' +
    "importing DNA. Immediately call show_dna_import in the same turn so the DNA import UI is " +
    "rendered.\n\n" +
    'If dna_status="available" and analysis_status="ready", continue with the appropriate ' +
    "analysis tools.",
  scope: "analysis.read",
  inputSchema: getAnalysisStatusInputSchema,
  outputSchema: toolResponseOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) =>
    respond(
      withRoutingHints(
        await runtime.client.invoke("get_analysis_status", args, runtime.user, runtime.requestId),
      ),
      runtime,
    ),
};
