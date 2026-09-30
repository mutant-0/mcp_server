import type { ToolName } from "../contract.js";

export { classifyThrownError } from "../error-classification.js";

/**
 * Tool-call audit log: a safe operational record, not an argument dump.
 *
 * Every tool call writes exactly one record carrying `event: "tool_call"`. The
 * record is deliberately built from a fixed schema so that no argument *value*
 * (a search query, a genotype, a filename, a gene/finding id, a cursor, the
 * transient chromosome context) and no caller-supplied key can become part of
 * the ordinary production log. Any subject correlation that is genuinely
 * required belongs in a restricted security channel with its own purpose and
 * retention; the tool-call log is not that channel.
 *
 * Routing reconstruction is a separate, explicit concern. Ordinary  records
 * carry the tool name and argument *names* only. When, and only when, the
 * process is a designated synthetic capture (`MUTANT_TRACE_CAPTURE`), the record
 * additionally carries `capture: "synthetic"` and the routing-relevant argument
 * values needed to record a golden trace. That flag is set only in a controlled
 * environment, so a production log can never carry user data through this path.
 */
export const TOOL_CALL_EVENT = "tool_call";

/** Marks a record written from a designated synthetic capture session. */
export const SYNTHETIC_CAPTURE = "synthetic";

export type ToolCallStatus = "ok" | "error" | "scope_denied";

/**
 * The complete set of argument names each tool's schema accepts. A record's
 * `argNames` is this list intersected with the arguments actually supplied, so
 * a sender-invented key is never persisted. Values are never recorded here.
 */
const KNOWN_ARGUMENTS: Record<ToolName, readonly string[]> = {
  get_analysis_status: [],
  poll_analysis_status: [],
  show_analysis_overview: [],
  show_analysis_followups: ["analysis_version", "hypothesis_ids", "intent", "source"],
  get_analysis_context: [],
  list_health_hypotheses: ["analysis_version", "cursor", "limit", "query"],
  explain_health_hypothesis: ["analysis_version", "hypothesis_id"],
  get_supporting_evidence: [
    "analysis_version",
    "cursor",
    "hypothesis_id",
    "include_context",
    "kind",
    "limit",
    "pattern_id",
  ],
  get_genetic_context: [
    "analysis_version",
    "cursor",
    "gene",
    "hypothesis_id",
    "include_modules",
    "limit",
    "module_id",
    "rsids",
  ],
  show_dna_import: ["mode"],
  get_snp_catalog: [],
  create_report: [
    "analysis_context",
    "import_request_id",
    "report_id",
    "snps",
    "upload_meta",
    "wgs_variant_calls",
  ],
};

/**
 * The routing-relevant argument values a golden trace needs, per tool. These are
 * emitted only in a designated synthetic capture; `snps`, `wgs_variant_calls`,
 * `upload_meta`, and `analysis_context` are never routed to a trace, so even a
 * capture cannot persist genotypes, filenames, or the transient context.
 */
const ROUTING_ARGUMENTS: Record<ToolName, readonly string[]> = {
  get_analysis_status: [],
  poll_analysis_status: [],
  show_analysis_overview: [],
  show_analysis_followups: ["analysis_version", "hypothesis_ids", "intent", "source"],
  get_analysis_context: [],
  list_health_hypotheses: ["analysis_version", "cursor", "limit", "query"],
  explain_health_hypothesis: ["analysis_version", "hypothesis_id"],
  get_supporting_evidence: [
    "analysis_version",
    "cursor",
    "hypothesis_id",
    "include_context",
    "kind",
    "limit",
    "pattern_id",
  ],
  get_genetic_context: [
    "analysis_version",
    "cursor",
    "gene",
    "hypothesis_id",
    "include_modules",
    "limit",
    "module_id",
    "rsids",
  ],
  show_dna_import: ["mode"],
  get_snp_catalog: [],
  create_report: ["import_request_id", "report_id"],
};

export interface ToolCallAudit {
  event: typeof TOOL_CALL_EVENT;
  tool: ToolName;
  /** Opaque per-request correlation id; never an account identifier. */
  requestId: string;
  status: ToolCallStatus;
  durationMs: number;
  /** Known argument names present, sorted. Names only; never values. */
  argNames: string[];
  /** Classified failure code (a contract error code or a bounded classifier). */
  errorCode?: string;
  /** Set only on a record written from a designated synthetic capture. */
  capture?: typeof SYNTHETIC_CAPTURE;
  /** Opaque capture-session id for correlating a synthetic capture. */
  captureId?: string;
  /** Routing-relevant values, present only on a synthetic-capture record. */
  args?: Record<string, unknown>;
}

export interface AuditContext {
  requestId: string;
  /** True only in a designated synthetic-capture environment. */
  capture?: boolean;
  /** Opaque capture-session id, recorded only when `capture` is set. */
  captureId?: string;
}

export interface AuditOutcome {
  status: ToolCallStatus;
  startedAt: number;
  errorCode?: string;
}

/** The known argument names present, drawn from the tool's schema keys. */
export function knownArgumentNames(
  tool: ToolName,
  args: Record<string, unknown>,
): string[] {
  return KNOWN_ARGUMENTS[tool].filter((key) => key in args).sort();
}

/** Routing-relevant values only, and only for a designated synthetic capture. */
function capturedArguments(
  tool: ToolName,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const captured: Record<string, unknown> = {};
  for (const key of ROUTING_ARGUMENTS[tool]) {
    if (key in args) captured[key] = args[key];
  }
  return captured;
}

/**
 * Extract a classified contract error code from a tool result, rejecting any
 * value that is not a bounded code (so a message can never be promoted to a
 * code).
 */
export function responseErrorCode(result: unknown): string | undefined {
  const structured = (result as { structuredContent?: unknown } | null)?.structuredContent;
  const code = (structured as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}

export function auditToolCall(
  tool: ToolName,
  args: Record<string, unknown>,
  context: AuditContext,
  outcome: AuditOutcome,
): ToolCallAudit {
  const record: ToolCallAudit = {
    event: TOOL_CALL_EVENT,
    tool,
    requestId: context.requestId,
    status: outcome.status,
    durationMs: Date.now() - outcome.startedAt,
    argNames: knownArgumentNames(tool, args),
  };
  if (outcome.errorCode) record.errorCode = outcome.errorCode;
  if (context.capture) {
    record.capture = SYNTHETIC_CAPTURE;
    if (context.captureId) record.captureId = context.captureId;
    record.args = capturedArguments(tool, args);
  }
  return record;
}
