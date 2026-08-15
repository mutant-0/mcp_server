import type { MutantUserContext } from "../auth/user-context.js";

export const TOOL_ACCESS = {
  get_analysis_status: "free",
  get_genomic_overview: "free",
  get_genetic_context: "free",
  get_variant_context: "free",
  get_root_cause_details: "paid",
  get_supporting_evidence: "paid",
  get_relevant_tests: "paid",
} as const;

export type ToolName = keyof typeof TOOL_ACCESS;
export type AccessTier = (typeof TOOL_ACCESS)[ToolName];

export const TOOL_NAMES = Object.keys(TOOL_ACCESS) as ToolName[];

export function requiredTier(tool: ToolName): AccessTier {
  return TOOL_ACCESS[tool];
}

export function canAccess(tool: ToolName, user: MutantUserContext): boolean {
  if (requiredTier(tool) === "free") return true;
  return user.accessLevel === "paid";
}
