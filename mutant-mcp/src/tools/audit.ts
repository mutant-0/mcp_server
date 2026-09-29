import type { ToolName } from "../contract.js";

/**
 * Tool-call audit log.
 *
 * Every tool call writes exactly one record carrying `event: "tool_call"`, in
 * call order, so a conversation's model-selected tool calls can be
 * reconstructed from the deployment's logs. That is the capture path for the
 * golden-prompt routing fixture: `scripts/record-golden-trace.ts` reads these
 * records and writes `tests/golden-prompt-routing-traces.json`, which is why
 * the record carries the arguments the evaluation asserts on.
 *
 * Argument values are limited to the fields a routing trace needs. Genotype
 * payloads (`snps`, `wgs_variant_calls`), the request-only `analysis_context`,
 * `upload_meta`, and rsID lists are recorded by key only: they are either
 * deliberately never logged (see `create_report`) or already summarized by the
 * tool's own log record. A `query` value is recorded only when it looks like the
 * catalog-topic keyword the tool description asks for; anything longer or
 * sentence-shaped is written as `[redacted]`, so the audit trail cannot become a
 * store of the user's health prose.
 */
export const TOOL_CALL_EVENT = "tool_call";

export const REDACTED_ARGUMENT = "[redacted]";

/**
 * Audited argument names per tool. A name absent here still appears in the
 * record's `argKeys`, so a withheld value is visible as withheld rather than
 * silently missing.
 */
const AUDITED_ARGUMENTS: Record<ToolName, readonly string[]> = {
  get_analysis_status: [],
  poll_analysis_status: [],
  show_analysis_overview: [],
  show_analysis_followups: ["intent", "analysis_version", "hypothesis_ids", "source"],
  get_analysis_context: [],
  list_health_hypotheses: ["query", "limit", "cursor", "analysis_version"],
  explain_health_hypothesis: ["hypothesis_id", "analysis_version"],
  get_supporting_evidence: [
    "hypothesis_id",
    "kind",
    "pattern_id",
    "include_context",
    "limit",
    "cursor",
    "analysis_version",
  ],
  get_genetic_context: [
    "hypothesis_id",
    "module_id",
    "gene",
    "include_modules",
    "limit",
    "cursor",
    "analysis_version",
  ],
  show_dna_import: ["mode"],
  get_snp_catalog: [],
  create_report: ["report_id", "import_request_id"],
};

/**
 * The shape of a catalog-topic search query: words, digits, and the punctuation
 * that appears inside catalog names, with no commas or sentence structure. The
 * input schema allows 120 characters; the routing evaluation asserts `query` is
 * at most 64 characters and never the health-history prose the user typed, so
 * anything outside that bound is withheld rather than logged.
 */
const CATALOG_KEYWORD = /^[\p{L}\p{N}][\p{L}\p{N} .'+#_-]*$/u;
const AUDITED_QUERY_MAX_CHARS = 64;

export type ToolCallStatus = "ok" | "error" | "scope_denied";

export interface ToolCallAudit {
  event: typeof TOOL_CALL_EVENT;
  tool: ToolName;
  requestId: string;
  userId: string;
  /** Every argument name the caller sent, audited or not, sorted. */
  argKeys: string[];
  /** The audited subset of the arguments, with withheld values redacted. */
  args: Record<string, unknown>;
  status: ToolCallStatus;
  durationMs: number;
}

/** True when a search query is short and word-shaped enough to be a catalog topic. */
export function isCatalogKeyword(value: string): boolean {
  return value.length > 0 && value.length <= AUDITED_QUERY_MAX_CHARS && CATALOG_KEYWORD.test(value);
}

function auditedValue(tool: ToolName, key: string, value: unknown): unknown {
  if (tool === "list_health_hypotheses" && key === "query") {
    return typeof value === "string" && isCatalogKeyword(value) ? value : REDACTED_ARGUMENT;
  }
  return value;
}

export function auditedArguments(
  tool: ToolName,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const audited: Record<string, unknown> = {};
  for (const key of AUDITED_ARGUMENTS[tool]) {
    if (!(key in args)) continue;
    audited[key] = auditedValue(tool, key, args[key]);
  }
  return audited;
}

export function auditToolCall(
  tool: ToolName,
  args: Record<string, unknown>,
  context: { requestId: string; userId: string },
  outcome: { status: ToolCallStatus; startedAt: number },
): ToolCallAudit {
  return {
    event: TOOL_CALL_EVENT,
    tool,
    requestId: context.requestId,
    userId: context.userId,
    argKeys: Object.keys(args).sort(),
    args: auditedArguments(tool, args),
    status: outcome.status,
    durationMs: Date.now() - outcome.startedAt,
  };
}
