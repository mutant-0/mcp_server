import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MutantToolDefinition } from "./types.js";

// Keep only bounded analytical routing arguments in widget-only metadata. Never
// retain an import payload, credentials, account identity, or arbitrary inputs.
const ARGUMENTS: Record<string, readonly string[]> = {
  explain_health_hypothesis: ["hypothesis_id", "analysis_version"],
  get_supporting_evidence: [
    "hypothesis_id",
    "analysis_version",
    "cursor",
    "kind",
    "limit",
    "pattern_id",
    "include_context",
  ],
  get_genetic_context: [
    "hypothesis_id",
    "analysis_version",
    "cursor",
    "gene",
    "module_id",
    "rsids",
    "include_modules",
    "limit",
  ],
  list_health_hypotheses: ["analysis_version", "cursor", "limit", "query"],
  get_analysis_context: [],
  show_analysis_overview: [],
};
export function attachConsentPendingAction(
  result: CallToolResult,
  tool: MutantToolDefinition,
  args: Record<string, unknown>,
): CallToolResult {
  const envelope = result.structuredContent as { error?: { code?: string } } | undefined;
  const keys = ARGUMENTS[tool.name];
  if (envelope?.error?.code !== "CONSENT_REQUIRED" || !keys) return result;
  const meta = result._meta ?? {};
  const mutant = (meta.mutant ?? {}) as Record<string, unknown>;
  return {
    ...result,
    _meta: {
      ...meta,
      mutant: {
        ...mutant,
        pending_action: {
          tool: tool.name,
          args: Object.fromEntries(
            keys.filter((key) => key in args).map((key) => [key, args[key]]),
          ),
        },
      },
    },
  };
}
