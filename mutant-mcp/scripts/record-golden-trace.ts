#!/usr/bin/env node
/**
 * Record observed golden-prompt routing traces from a captured tool-call log.
 *
 * Usage (from `mutant-mcp/`):
 *   npm run record:trace -- --prompt "<entry prompt>" --state READY_FREE \
 *     --calls captured-logs.json [--user <sub>] [--from <iso>] [--to <iso>] \
 *     [--query <keyword> ...] [--captured-at <iso>] [--write]
 *
 * Without `--write` the entry is printed; the fixture is only touched with
 * `--write`, which replaces the entry for the same prompt and state (or appends
 * it) and marks it `observed`, which is what the release gate checks.
 *
 * The log is the deployment's own output: every tool call emits an
 * `event: "tool_call"` record (see src/tools/audit.ts) with the audited
 * arguments, so a sequence is captured as the model actually selected it.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { TRACE_STATES } from "../tests/golden-trace-contract.js";
import {
  auditedCalls,
  parseAuditRecords,
  parseCallList,
  serializeTraceEntry,
  toTraceEntry,
  writeTraceEntry,
  type CapturedCall,
} from "./golden-trace-recorder.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const TRACES_PATH = path.join(PROJECT_ROOT, "tests", "golden-prompt-routing-traces.json");

interface Args {
  prompt?: string;
  state?: string;
  calls?: string;
  user?: string;
  from?: string;
  to?: string;
  capturedAt?: string;
  queries: string[];
  write: boolean;
  help: boolean;
}

const USAGE = `Record a golden-prompt routing trace from an observed tool-call log.

  --prompt <text>        The entry prompt the conversation started with (required)
  --state <STATE>        The account state the capture was taken against (required)
                         one of: ${TRACE_STATES.join(", ")}
  --calls <file>         Tool-call log to read (required): the audit records from the
                         deployment logs, or a bare [{ name, arguments }] list
  --user <sub>           Only records for this account
  --from <iso>           Only records at or after this time
  --to <iso>             Only records at or before this time
  --query <keyword>      Value for a query the audit log withheld, in call order
  --captured-at <iso>    Capture timestamp (default: now)
  --write                Update ${path.relative(PROJECT_ROOT, TRACES_PATH).replace(/\\/g, "/")} (default: print)
  --help                 Show this message`;

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { queries: [], write: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--prompt":
        args.prompt = value();
        break;
      case "--state":
        args.state = value();
        break;
      case "--calls":
        args.calls = value();
        break;
      case "--user":
        args.user = value();
        break;
      case "--from":
        args.from = value();
        break;
      case "--to":
        args.to = value();
        break;
      case "--captured-at":
        args.capturedAt = value();
        break;
      case "--query":
        args.queries.push(value());
        break;
      case "--write":
        args.write = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`unknown flag ${flag ?? ""}`);
    }
  }
  return args;
}

async function readCalls(file: string, args: Args): Promise<CapturedCall[]> {
  const text = await readFile(path.resolve(file), "utf8");
  const list = parseCallList(text);
  if (list) {
    if (list.length === 0) throw new Error(`${file} contains no calls`);
    return list;
  }
  const records = parseAuditRecords(text);
  if (records.length === 0) {
    throw new Error(
      `${file} contains no tool-call audit records (event: "tool_call"); is this the right log?`,
    );
  }
  const calls = auditedCalls(records, { userId: args.user, from: args.from, to: args.to });
  if (calls.length === 0) {
    throw new Error(`${file} has ${records.length} audit record(s) but none matched the filter`);
  }
  return calls;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.prompt || !args.state || !args.calls) {
    throw new Error(`--prompt, --state and --calls are required\n\n${USAGE}`);
  }
  if (!(TRACE_STATES as readonly string[]).includes(args.state)) {
    throw new Error(`unknown --state ${args.state}; expected one of ${TRACE_STATES.join(", ")}`);
  }

  const calls = await readCalls(args.calls, args);
  const entry = toTraceEntry({
    prompt: args.prompt,
    state: args.state,
    calls,
    capturedAt: args.capturedAt ?? new Date().toISOString(),
    redactedQueries: args.queries,
  });

  const sequence = entry.toolCalls.map((call) => call.name).join(" -> ");
  console.error(
    `${entry.toolCalls.length} observed call(s) for "${entry.prompt}" (${entry.state}): ${sequence}`,
  );

  if (!args.write) {
    console.log(serializeTraceEntry(entry, "    "));
    console.error("dry run: pass --write to update the fixture");
    return;
  }

  const fixture = await readFile(TRACES_PATH, "utf8");
  const options = (await prettier.resolveConfig(TRACES_PATH)) ?? {};
  const { text, replaced } = await writeTraceEntry(fixture, entry, (document) =>
    prettier.format(document, { ...options, parser: "json" }),
  );
  await writeFile(TRACES_PATH, text, "utf8");
  console.error(
    `${replaced ? "replaced" : "appended"} the trace for "${entry.prompt}" (${entry.state}) in ${path.relative(PROJECT_ROOT, TRACES_PATH)}`,
  );
  console.error(
    "verify with: GOLDEN_TRACES_REQUIRED=1 npm exec -- vitest run tests/golden-prompt-routing.test.ts",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
