/**
 * Golden-prompt routing trace recorder.
 *
 * Turns an observed tool-call audit log (see `src/tools/audit.ts`) into an entry
 * of `tests/golden-prompt-routing-traces.json`. The routing evaluation is only
 * authoritative once every entry's `provenance` is "observed", and this module is
 * what makes that claim checkable: the call sequence comes from the deployment's
 * own record of what the model asked for rather than a hand-authored guess about
 * what it should have asked for.
 *
 * The fixture is hand-formatted JSON, so an entry is spliced into the existing
 * text instead of regenerating the document: `prettier` then normalises the
 * result, which is a no-op on the entries that did not change (see
 * `tests/golden-trace-recorder.test.ts`).
 */
import type { ToolName } from "../src/contract.js";
import { SYNTHETIC_CAPTURE } from "../src/tools/audit.js";
import {
  cardMountsFrom,
  traceEntryIssues,
  OBSERVED_PROVENANCE,
  PENDING_PROVENANCE,
  type GoldenTrace,
  type TraceExpect,
} from "../tests/golden-trace-contract.js";

/** The audit-log marker written in place of a value the log withholds. */
export const REDACTED_QUERY_MARKER = "[redacted]";

/** One `event: "tool_call"` record as it appears in a JSON log line. */
export interface AuditRecord {
  event?: unknown;
  tool?: unknown;
  time?: unknown;
  timestamp?: unknown;
  capture?: unknown;
  captureId?: unknown;
  args?: unknown;
  argNames?: unknown;
  status?: unknown;
  errorCode?: unknown;
}

export interface CapturedCall {
  name: string;
  arguments: Record<string, unknown>;
  /**
   * True when the call's argument values came from a designated synthetic
   * capture. Ordinary records leave this false (arguments are withheld), so a
   * trace built from them is visibly incomplete rather than silently filled.
   */
  captured?: boolean;
  /** Opaque synthetic-capture session id, when the record carries one. */
  captureId?: string;
}

export interface CaptureOptions {
  /** The prompt the conversation started with. */
  prompt: string;
  /** Account state the capture was taken against. */
  state: string;
  /** Observed calls, in the order the server recorded them. */
  calls: readonly CapturedCall[];
  capturedAt: string;
  /** Overrides the mounts implied by the call sequence; rarely needed. */
  expect?: TraceExpect;
  /** Values for queries the audit log withheld, applied in call order. */
  redactedQueries?: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/**
 * Parse a captured log: newline-delimited JSON, a JSON array, a single JSON
 * object, or a CloudWatch Logs event envelope (`{ timestamp, message }` whose
 * message is the log line). Anything that is not a tool-call audit record is
 * ignored, so an unfiltered log export can be handed over as-is.
 */
export function parseAuditRecords(text: string): AuditRecord[] {
  const records: AuditRecord[] = [];

  const consider = (value: unknown, envelopeTime?: unknown): void => {
    const record = asRecord(value);
    if (!record) return;
    const message = record.message;
    if (typeof message === "string" && message.trim().startsWith("{")) {
      // CloudWatch Logs event: the log line is a JSON string inside the envelope.
      consider(JSON.parse(message), record.timestamp ?? record.time);
      return;
    }
    if (record.event !== "tool_call" || typeof record.tool !== "string") return;
    records.push(
      envelopeTime === undefined ? record : { ...record, time: record.time ?? envelopeTime },
    );
  };

  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    // Whole-document JSON first; NDJSON falls back to the per-line path.
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) consider(entry);
        return records;
      }
      consider(parsed);
      return records;
    } catch {
      // Not a single JSON document; parse line by line.
    }
  }

  for (const line of trimmed.split("\n")) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) continue;
    try {
      consider(JSON.parse(candidate));
    } catch {
      // A truncated or non-JSON line is not a tool-call record.
    }
  }
  return records;
}

/**
 * The tool-call audit records in call order. Records without a timestamp keep
 * their input order, so a manually assembled list still replays in order.
 *
 * Argument values are read only from records written by a designated synthetic
 * capture (`capture: "synthetic"`); an ordinary production record carries no
 * values, so its `arguments` is empty and `captured` is false.
 */
export function auditedCalls(
  records: readonly AuditRecord[],
  filter: { captureId?: string; from?: string; to?: string } = {},
): CapturedCall[] {
  const from = filter.from === undefined ? null : Date.parse(filter.from);
  const to = filter.to === undefined ? null : Date.parse(filter.to);

  return records
    .map((record, index) => ({ record, index, time: asTime(record.time) }))
    .filter(({ record, time }) => {
      if (filter.captureId !== undefined && record.captureId !== filter.captureId) return false;
      if (from !== null && (time === null || time < from)) return false;
      if (to !== null && (time === null || time > to)) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.time === null || b.time === null) return a.index - b.index;
      return a.time - b.time || a.index - b.index;
    })
    .map(({ record }) => {
      const captured = record.capture === SYNTHETIC_CAPTURE;
      return {
        name: record.tool as string,
        arguments: captured ? asRecord(record.args) ?? {} : {},
        captured,
        ...(typeof record.captureId === "string" ? { captureId: record.captureId } : {}),
      };
    });
}

/**
 * A bare `[{ name, arguments }]` list, as an alternative to a log export for a
 * capture that was transcribed from the host's tool-call detail view. A
 * transcribed list is treated as captured: the operator supplied the values.
 */
export function parseCallList(text: string): CapturedCall[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) return null;
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) return null;
  return parsed.map((entry) => {
    const call = asRecord(entry);
    if (!call) throw new Error("each captured call must be an object");
    const name = call.name ?? call.tool;
    if (typeof name !== "string") throw new Error("each captured call needs a name");
    return { name, arguments: asRecord(call.arguments ?? call.args) ?? {}, captured: true };
  });
}

/** Apply operator-supplied values to queries the audit log withheld. */
export function fillRedactedQueries(
  calls: readonly CapturedCall[],
  queries: readonly string[],
): CapturedCall[] {
  const withheld = calls.filter((call) => call.arguments.query === REDACTED_QUERY_MARKER);
  if (queries.length > withheld.length) {
    throw new Error(
      `--query was given ${queries.length} times but only ${withheld.length} call(s) have a withheld query`,
    );
  }
  let next = 0;
  return calls.map((call) => {
    if (call.arguments.query !== REDACTED_QUERY_MARKER) return call;
    const value = queries[next];
    next += 1;
    return value === undefined ? call : { ...call, arguments: { ...call.arguments, query: value } };
  });
}

/** The fixture entry for a capture, validated against the shared contract. */
export function toTraceEntry(options: CaptureOptions): GoldenTrace {
  const calls = fillRedactedQueries(options.calls, options.redactedQueries ?? []);
  if (calls.length === 0) {
    throw new Error(
      "no tool calls found; check --capture / --from / --to and that the log holds tool-call audit records",
    );
  }

  const uncaptured = calls.filter((call) => call.captured === false);
  if (uncaptured.length > 0) {
    throw new Error(
      `${uncaptured.length} call(s) carry no argument values: the log is an ordinary production record, ` +
        "which withholds them. Record the capture from a designated synthetic session with " +
        "MUTANT_TRACE_CAPTURE=1 and re-export; do not hand-fill the missing arguments.",
    );
  }

  const withheld = calls.filter((call) => call.arguments.query === REDACTED_QUERY_MARKER);
  if (withheld.length > 0) {
    throw new Error(
      `${withheld.length} call(s) have a withheld query value, which means the model sent something that is not a catalog keyword. ` +
        "That is itself a routing finding: read the query in the conversation and pass it with --query (repeat once per withheld call), " +
        "or record the finding and fix the routing instead of importing the trace.",
    );
  }

  const toolCalls = calls.map((call) => ({
    name: call.name as ToolName,
    arguments: call.arguments,
  }));
  const entry: GoldenTrace = {
    prompt: options.prompt,
    state: options.state as GoldenTrace["state"],
    provenance: OBSERVED_PROVENANCE,
    capturedAt: options.capturedAt,
    expect: options.expect ?? cardMountsFrom(toolCalls),
    toolCalls,
  };

  const issues = traceEntryIssues(entry, `capture "${options.prompt}" (${options.state})`);
  if (issues.length > 0) throw new Error(issues.join("\n"));
  return entry;
}

/** Source spans of the fixture's top-level `traces[]` entries, in file order. */
export function traceEntrySpans(text: string): Array<{ start: number; end: number }> {
  const key = text.indexOf('"traces"');
  if (key < 0) throw new Error("the fixture has no traces array");
  const arrayStart = text.indexOf("[", key);
  if (arrayStart < 0) throw new Error("the fixture has no traces array");

  const spans: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let entryStart = -1;
  let inString = false;
  let escaped = false;
  for (let index = arrayStart + 1; index < text.length; index += 1) {
    const char = text[index] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      if (depth === 0 && char === "{") entryStart = index;
      depth += 1;
    } else if (char === "}" || char === "]") {
      if (char === "]" && depth === 0) break;
      depth -= 1;
      if (depth === 0 && entryStart >= 0) {
        spans.push({ start: entryStart, end: index + 1 });
        entryStart = -1;
      }
    }
  }
  return spans;
}

/** One line of the fixture's inline object style; prettier rewraps as needed. */
function inlineJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${inlineJson(item)}`).join(", ")} }`;
  }
  return JSON.stringify(value) ?? "null";
}

/** One fixture entry, in the fixture's layout (6-space base indent). */
export function serializeTraceEntry(entry: GoldenTrace, indent = "      "): string {
  const inner = `${indent}  `;
  const calls = entry.toolCalls.map(
    (call) =>
      `${indent}    { "name": ${JSON.stringify(call.name)}, "arguments": ${inlineJson(call.arguments ?? {})} }`,
  );
  return [
    "{",
    `${inner}"prompt": ${JSON.stringify(entry.prompt)},`,
    `${inner}"state": ${JSON.stringify(entry.state)},`,
    `${inner}"provenance": ${JSON.stringify(entry.provenance)},`,
    `${inner}"capturedAt": ${entry.capturedAt === null ? "null" : JSON.stringify(entry.capturedAt)},`,
    `${inner}"expect": ${inlineJson(entry.expect)},`,
    `${inner}"toolCalls": [`,
    calls.join(",\n"),
    `${inner}]`,
    `${indent}}`,
  ].join("\n");
}

export interface WriteResult {
  text: string;
  replaced: boolean;
}

/**
 * Splice one entry into the fixture text, replacing the entry for the same
 * prompt and state when there is one and appending otherwise. Entries that do
 * not match are left byte-identical; `format` is applied to the whole document.
 */
export async function writeTraceEntry(
  fixtureText: string,
  entry: GoldenTrace,
  format: (text: string) => Promise<string>,
): Promise<WriteResult> {
  const document = JSON.parse(fixtureText) as { traces: GoldenTrace[] };
  const spans = traceEntrySpans(fixtureText);
  if (spans.length !== document.traces.length) {
    throw new Error(
      `the fixture could not be indexed (${spans.length} source entries vs ${document.traces.length} parsed)`,
    );
  }

  const matches = document.traces
    .map((trace, index) => ({ trace, index }))
    .filter(({ trace }) => trace.prompt === entry.prompt && trace.state === entry.state);
  if (matches.length > 1) {
    throw new Error(
      `the fixture has ${matches.length} entries for "${entry.prompt}" (${entry.state}); resolve the duplicate first`,
    );
  }

  const serialized = serializeTraceEntry(entry);
  const match = matches[0];
  let spliced: string;
  if (match) {
    const span = spans[match.index] as { start: number; end: number };
    spliced = fixtureText.slice(0, span.start) + serialized + fixtureText.slice(span.end);
  } else {
    const lastSpan = spans[spans.length - 1];
    if (!lastSpan) throw new Error("the fixture has no trace entries to append after");
    spliced = `${fixtureText.slice(0, lastSpan.end)},\n    ${serialized}${fixtureText.slice(lastSpan.end)}`;
  }

  spliced = replaceStringValue(spliced, "captureInstructions", CAPTURE_INSTRUCTIONS);
  return { text: await format(spliced), replaced: match !== undefined };
}

/** The fixture's capture instructions, so the recorded fields stay documented. */
export const CAPTURE_INSTRUCTIONS = `Recorded with \`npm run record:trace\` from a designated synthetic-capture session. Ordinary production logs carry no argument values (see src/tools/audit.ts); the deployment must run with MUTANT_TRACE_CAPTURE=1 in a controlled environment so the captured records carry \`capture: "synthetic"\`. For each entry: start a NEW ChatGPT conversation with the Mutant connection (or installed plugin) enabled, send \`prompt\` on a synthetic account in \`state\`, and record the tool calls and arguments in order in \`toolCalls\`. An entry is authoritative only once \`provenance\` is "${OBSERVED_PROVENANCE}" with a \`capturedAt\` timestamp; entries left as "${PENDING_PROVENANCE}" are placeholders that the release gate (GOLDEN_TRACES_REQUIRED=1) rejects.`;

/**
 * Replace one top-level string value in place, so a document whose layout is
 * hand-maintained is not regenerated wholesale to update a header sentence.
 * Returns the text unchanged when the key is absent or its value is not a string.
 */
export function replaceStringValue(text: string, key: string, value: string): string {
  const token = `${JSON.stringify(key)}:`;
  const keyIndex = text.indexOf(token);
  if (keyIndex < 0) return text;

  let quoteIndex = keyIndex + token.length;
  while (quoteIndex < text.length && /\s/.test(text[quoteIndex] as string)) quoteIndex += 1;
  if (text[quoteIndex] !== '"') return text;

  let index = quoteIndex + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") index += 2;
    else if (char === '"') break;
    else index += 1;
  }
  if (index >= text.length) return text;
  return text.slice(0, quoteIndex) + JSON.stringify(value) + text.slice(index + 1);
}
