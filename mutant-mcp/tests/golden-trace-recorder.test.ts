/**
 * Golden-prompt trace recorder.
 *
 * The recorder is the bridge between a real capture and the release gate: it
 * turns a designated synthetic-capture's tool-call audit records into a fixture
 * entry. The fixture is hand-maintained JSON, so the properties that matter here
 * are that the parse accepts what the deployment actually emits, that ordinary
 * records (which withhold every value) stay visibly incomplete, and that writing
 * an entry back does not reflow the entries around it.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import prettier from "prettier";
import { describe, expect, it } from "vitest";
import {
  auditedCalls,
  parseAuditRecords,
  parseCallList,
  replaceStringValue,
  serializeTraceEntry,
  toTraceEntry,
  traceEntrySpans,
  writeTraceEntry,
  CAPTURE_INSTRUCTIONS,
} from "../scripts/golden-trace-recorder.js";
import { OBSERVED_PROVENANCE, traceEntryIssues } from "./golden-trace-contract.js";

const TRACES_PATH = path.join(process.cwd(), "tests", "golden-prompt-routing-traces.json");

/** A record from a designated synthetic capture: argument values are present. */
const AUDIT = (tool: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    level: 30,
    time: 1759100000000,
    event: "tool_call",
    tool,
    requestId: "req-1",
    capture: "synthetic",
    captureId: "cap-1",
    argNames: Object.keys(args).sort(),
    args,
    status: "ok",
    durationMs: 12,
    msg: "tool call",
    ...extra,
  });

/** An ordinary production record: safe schema, no argument values, no capture. */
const ORDINARY = (
  tool: string,
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    level: 30,
    time: 1759100000000,
    event: "tool_call",
    tool,
    requestId: "req-1",
    argNames: ["query"],
    status: "ok",
    durationMs: 12,
    msg: "tool call",
    ...extra,
  });

describe("audit log parsing", () => {
  it("reads synthetic-capture records in call order and ignores other lines", () => {
    const text = [
      AUDIT("get_analysis_status", {}, { time: 1759100000001 }),
      '{"level":30,"time":1759100000002,"tool":"create_report","msg":"dna import submitted"}',
      AUDIT("list_health_hypotheses", { query: "b12", limit: 3 }, { time: 1759100000003 }),
    ].join("\n");

    const calls = auditedCalls(parseAuditRecords(text));
    expect(calls.map((call) => ({ name: call.name, arguments: call.arguments }))).toEqual([
      { name: "get_analysis_status", arguments: {} },
      { name: "list_health_hypotheses", arguments: { query: "b12", limit: 3 } },
    ]);
    expect(calls.every((call) => call.captured === true)).toBe(true);
  });

  it("withholds argument values from an ordinary record and flags it incomplete", () => {
    const records = parseAuditRecords(ORDINARY("list_health_hypotheses"));
    expect(auditedCalls(records)).toEqual([
      { name: "list_health_hypotheses", arguments: {}, captured: false },
    ]);
  });

  it("reads a CloudWatch Logs event array and a bare call list", () => {
    const envelope = JSON.stringify([
      { timestamp: 1759100000001, message: AUDIT("get_analysis_status", {}) },
      { timestamp: 1759100000002, message: "not json" },
      { timestamp: 1759100000003, message: AUDIT("show_dna_import", { mode: "initial" }) },
    ]);
    expect(
      auditedCalls(parseAuditRecords(envelope)).map((call) => ({
        name: call.name,
        arguments: call.arguments,
      })),
    ).toEqual([
      { name: "get_analysis_status", arguments: {} },
      { name: "show_dna_import", arguments: { mode: "initial" } },
    ]);

    expect(parseCallList('[{"name":"get_analysis_status","arguments":{}}]')).toEqual([
      { name: "get_analysis_status", arguments: {}, captured: true },
    ]);
    expect(parseCallList(AUDIT("get_analysis_status", {}))).toBeNull();
  });

  it("filters by capture session and time, and keeps untimed records in input order", () => {
    const records = parseAuditRecords(
      [
        AUDIT("get_analysis_status", {}, { time: 1759100000003 }),
        AUDIT("show_dna_import", { mode: "initial" }, { time: 1759100000001 }),
        AUDIT("get_snp_catalog", {}, { time: 1759100000002, captureId: "other" }),
      ].join("\n"),
    );

    // In call order, not in the order the log lines happened to arrive.
    expect(auditedCalls(records).map((call) => call.name)).toEqual([
      "show_dna_import",
      "get_snp_catalog",
      "get_analysis_status",
    ]);
    expect(auditedCalls(records, { captureId: "cap-1" }).map((call) => call.name)).toEqual([
      "show_dna_import",
      "get_analysis_status",
    ]);
    expect(
      auditedCalls(records, {
        from: "2025-09-28T22:53:20.002Z",
        to: "2025-09-28T22:53:20.002Z",
      }).map((call) => call.name),
    ).toEqual(["get_snp_catalog"]);

    // A capture transcribed from the host has no timestamps; its order is kept.
    const untimed = parseAuditRecords(
      [
        AUDIT("get_analysis_status", {}, { time: undefined }),
        AUDIT("show_dna_import", { mode: "initial" }, { time: undefined }),
      ].join("\n"),
    );
    expect(auditedCalls(untimed).map((call) => call.name)).toEqual([
      "get_analysis_status",
      "show_dna_import",
    ]);
  });
});

describe("building a fixture entry", () => {
  it("derives the card mounts and marks the entry observed", () => {
    const entry = toTraceEntry({
      prompt: "Show my current Mutant findings.",
      state: "READY_FREE",
      calls: [
        { name: "get_analysis_status", arguments: {} },
        { name: "show_analysis_overview", arguments: {} },
      ],
      capturedAt: "2026-09-29T23:10:00.000Z",
    });

    expect(entry.provenance).toBe(OBSERVED_PROVENANCE);
    expect(entry.expect).toEqual({ overview: true, import: false, followups: false });
    expect(traceEntryIssues(entry, "capture")).toEqual([]);
  });

  it("refuses an uncaptured call rather than filling missing arguments", () => {
    expect(() =>
      toTraceEntry({
        prompt: "Show my current Mutant findings.",
        state: "READY_FREE",
        calls: [{ name: "get_analysis_status", arguments: {}, captured: false }],
        capturedAt: "2026-09-29T23:10:00.000Z",
      }),
    ).toThrow(/no argument values/);
  });

  it("refuses a trace whose sequence contradicts the card mounts", () => {
    expect(() =>
      toTraceEntry({
        prompt: "Show my current Mutant findings.",
        state: "READY_FREE",
        calls: [{ name: "get_analysis_status", arguments: {} }],
        capturedAt: "2026-09-29T23:10:00.000Z",
        expect: { overview: true, import: false, followups: false },
      }),
    ).toThrow(/does not match the cards/);
  });

  it("refuses a withheld query, because that is a routing finding", () => {
    expect(() =>
      toTraceEntry({
        prompt: "What about histamine?",
        state: "READY_FREE",
        calls: [
          { name: "get_analysis_status", arguments: {} },
          {
            name: "list_health_hypotheses",
            arguments: { query: "[redacted]" },
          },
        ],
        capturedAt: "2026-09-29T23:10:00.000Z",
      }),
    ).toThrow(/withheld query/);
  });

  it("accepts an operator-supplied value for a withheld query, in call order", () => {
    const entry = toTraceEntry({
      prompt: "What about histamine?",
      state: "READY_FREE",
      calls: [
        { name: "list_health_hypotheses", arguments: { query: "[redacted]" } },
        { name: "list_health_hypotheses", arguments: { query: "[redacted]" } },
      ],
      capturedAt: "2026-09-29T23:10:00.000Z",
      redactedQueries: ["histamine", "thyroid"],
    });

    expect(entry.toolCalls.map((call) => call.arguments?.query)).toEqual(["histamine", "thyroid"]);
  });

  it("refuses an unknown state or tool before the fixture is touched", () => {
    expect(() =>
      toTraceEntry({
        prompt: "Show my current Mutant findings.",
        state: "READY_SUPER",
        calls: [{ name: "get_analysis_status", arguments: {} }],
        capturedAt: "2026-09-29T23:10:00.000Z",
      }),
    ).toThrow(/unknown state/);
    expect(() =>
      toTraceEntry({
        prompt: "Show my current Mutant findings.",
        state: "READY_FREE",
        calls: [{ name: "get_everything", arguments: {} }],
        capturedAt: "2026-09-29T23:10:00.000Z",
      }),
    ).toThrow(/unknown tool/);
  });
});

describe("writing the fixture", () => {
  const format = async (text: string) => {
    const options = (await prettier.resolveConfig(TRACES_PATH)) ?? {};
    return prettier.format(text, { ...options, parser: "json" });
  };

  it("rewrites an entry without reflowing the entries around it", async () => {
    const original = await readFile(TRACES_PATH, "utf8");
    const document = JSON.parse(original) as { traces: Array<Record<string, unknown>> };
    const spans = traceEntrySpans(original);
    expect(spans).toHaveLength(document.traces.length);

    // Every existing entry, round-tripped through the recorder's own serializer,
    // reproduces the file byte for byte: the splice cannot reformat what it did
    // not change.
    for (const trace of document.traces) {
      const { text } = await writeTraceEntry(
        original,
        trace as unknown as Parameters<typeof writeTraceEntry>[1],
        format,
      );
      expect(text).toBe(original);
    }
  });

  it("appends a new entry as valid JSON that the contract accepts", async () => {
    const original = await readFile(TRACES_PATH, "utf8");
    const entry = toTraceEntry({
      prompt: "Which finding fits my history?",
      state: "READY_FULL",
      calls: [
        { name: "get_analysis_status", arguments: {} },
        { name: "get_analysis_context", arguments: {} },
        { name: "list_health_hypotheses", arguments: { limit: 3 } },
      ],
      capturedAt: "2026-09-29T23:10:00.000Z",
    });

    const { text, replaced } = await writeTraceEntry(original, entry, format);
    expect(replaced).toBe(false);

    const document = JSON.parse(text) as { traces: unknown[]; captureInstructions: string };
    expect(document.traces).toHaveLength(
      (JSON.parse(original) as { traces: unknown[] }).traces.length + 1,
    );
    expect(document.captureInstructions).toBe(CAPTURE_INSTRUCTIONS);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("replaces the entry it matches and leaves the rest of the file alone", async () => {
    const original = await readFile(TRACES_PATH, "utf8");
    const document = JSON.parse(original) as {
      traces: Array<{ prompt: string; state: string; expect: { import: boolean } }>;
    };
    const target = document.traces.find((trace) => trace.state === "NO_DNA" && trace.expect.import);
    expect(target).toBeDefined();

    const entry = toTraceEntry({
      prompt: target!.prompt,
      state: target!.state,
      calls: [
        { name: "get_analysis_status", arguments: {} },
        { name: "show_dna_import", arguments: { mode: "initial" } },
      ],
      capturedAt: "2026-09-29T23:10:00.000Z",
    });

    const { text, replaced } = await writeTraceEntry(original, entry, format);
    expect(replaced).toBe(true);
    expect(JSON.parse(text)).toEqual({
      ...document,
      captureInstructions: CAPTURE_INSTRUCTIONS,
      traces: document.traces.map((trace) => (trace === target ? entry : trace)),
    });
  });

  it("serializes a single-line entry the fixture's own layout can absorb", () => {
    expect(
      serializeTraceEntry(
        {
          prompt: "Show my current Mutant findings.",
          state: "READY_FULL",
          provenance: OBSERVED_PROVENANCE,
          capturedAt: "2026-09-29T23:10:00.000Z",
          expect: { overview: true, import: false, followups: false },
          toolCalls: [
            { name: "get_analysis_status", arguments: {} },
            { name: "show_analysis_overview", arguments: {} },
          ],
        },
        "  ",
      ).split("\n"),
    ).toEqual([
      "{",
      '    "prompt": "Show my current Mutant findings.",',
      '    "state": "READY_FULL",',
      '    "provenance": "observed",',
      '    "capturedAt": "2026-09-29T23:10:00.000Z",',
      '    "expect": { "overview": true, "import": false, "followups": false },',
      '    "toolCalls": [',
      '      { "name": "get_analysis_status", "arguments": {} },',
      '      { "name": "show_analysis_overview", "arguments": {} }',
      "    ]",
      "  }",
    ]);
  });

  it("replaces a header string without touching the traces", () => {
    const text = '{\n  "note": "old",\n  "traces": []\n}\n';
    expect(replaceStringValue(text, "note", 'a "quoted" note')).toBe(
      '{\n  "note": "a \\"quoted\\" note",\n  "traces": []\n}\n',
    );
    expect(replaceStringValue(text, "absent", "x")).toBe(text);
  });
});
