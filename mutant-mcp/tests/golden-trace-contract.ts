import { TOOL_NAMES, type ToolName } from "../src/contract.js";

/**
 * The golden-prompt routing fixture's contract.
 *
 * Shared by `golden-prompt-routing.test.ts`, which replays the traces, and
 * `scripts/record-golden-trace.ts`, which writes them from a captured audit log.
 * One validator means an imported trace and a hand-edited one are held to the
 * same rules, so a capture cannot introduce a state or tool name the replay does
 * not know about.
 */
export const TRACE_STATES = [
  "NO_DNA",
  "PROCESSING",
  "READY_FREE",
  "READY_FULL",
  "READY_REFRESH_AVAILABLE",
  "READY_REFRESH_PROCESSING",
] as const;

export type TraceState = (typeof TRACE_STATES)[number];

export const OBSERVED_PROVENANCE = "observed";
export const PENDING_PROVENANCE = "pending-manual-capture";

export interface TraceExpect {
  overview: boolean;
  import: boolean;
  followups: boolean;
}

export interface TraceToolCall {
  name: ToolName;
  arguments?: Record<string, unknown>;
}

export interface GoldenTrace {
  prompt: string;
  state: TraceState;
  provenance: string;
  capturedAt: string | null;
  /** The Apps SDK card(s) this trace must (or must not) mount. */
  expect: TraceExpect;
  toolCalls: TraceToolCall[];
}

export function isTraceState(value: unknown): value is TraceState {
  return typeof value === "string" && (TRACE_STATES as readonly string[]).includes(value);
}

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && (TOOL_NAMES as readonly string[]).includes(value);
}

/**
 * The card mounts a tool sequence implies. The replay asserts the mounted cards
 * against `expect`, so this is also the only coherent value a capture may record.
 */
export function cardMountsFrom(toolCalls: readonly { name: string }[]): TraceExpect {
  const called = (name: ToolName) => toolCalls.some((call) => call.name === name);
  return {
    overview: called("show_analysis_overview"),
    import: called("show_dna_import"),
    followups: called("show_analysis_followups"),
  };
}

/**
 * Everything wrong with one fixture entry, as operator-facing sentences. Empty
 * means the entry is replayable.
 */
export function traceEntryIssues(trace: GoldenTrace, label: string): string[] {
  const issues: string[] = [];
  const at = label ? `${label}: ` : "";

  if (typeof trace.prompt !== "string" || trace.prompt.trim() === "") {
    issues.push(`${at}prompt must be a non-empty string`);
  }
  if (!isTraceState(trace.state)) {
    issues.push(
      `${at}unknown state ${JSON.stringify(trace.state)} (expected one of ${TRACE_STATES.join(", ")})`,
    );
  }
  if (trace.provenance !== OBSERVED_PROVENANCE && trace.provenance !== PENDING_PROVENANCE) {
    issues.push(
      `${at}provenance must be "${OBSERVED_PROVENANCE}" or "${PENDING_PROVENANCE}", got ${JSON.stringify(trace.provenance)}`,
    );
  }
  if (trace.provenance === OBSERVED_PROVENANCE) {
    if (typeof trace.capturedAt !== "string" || Number.isNaN(Date.parse(trace.capturedAt))) {
      issues.push(`${at}an observed trace needs a parseable capturedAt timestamp`);
    }
  } else if (trace.capturedAt !== null) {
    issues.push(`${at}capturedAt must be null while provenance is "${PENDING_PROVENANCE}"`);
  }

  if (!Array.isArray(trace.toolCalls) || trace.toolCalls.length === 0) {
    issues.push(`${at}toolCalls must be a non-empty array`);
    return issues;
  }
  for (const call of trace.toolCalls) {
    if (!isToolName(call?.name)) {
      issues.push(`${at}unknown tool ${JSON.stringify(call?.name)}`);
    }
  }
  for (const name of [
    "show_analysis_overview",
    "show_dna_import",
    "show_analysis_followups",
  ] as const) {
    const count = trace.toolCalls.filter((call) => call.name === name).length;
    if (count > 1) {
      issues.push(`${at}${name} is called ${count} times; a trace mounts each card at most once`);
    }
  }

  const implied = cardMountsFrom(trace.toolCalls);
  if (
    trace.expect?.overview !== implied.overview ||
    trace.expect?.import !== implied.import ||
    trace.expect?.followups !== implied.followups
  ) {
    issues.push(
      `${at}expect ${JSON.stringify(trace.expect)} does not match the cards ${JSON.stringify(implied)} implied by toolCalls`,
    );
  }

  return issues;
}
