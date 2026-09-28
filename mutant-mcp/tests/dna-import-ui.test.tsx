// @vitest-environment jsdom
/**
 * Component tests for the DNA import Apps SDK app.
 *
 * The component talks to the server exclusively through the host bridge, so these
 * tests stand up a fake host on the same `window` the app posts to: it answers
 * `ui/initialize`, records every `tools/call`, `ui/message`, and
 * `ui/update-model-context`, and can push a tool result the way a host does.
 *
 * The component now owns the whole lifecycle - it reads `poll_analysis_status` on
 * mount, polls it after `create_report`, and paints the completion card - so the
 * fake host answers the analysis reads too, and every test renders with a short
 * poll interval so polling settles inside the test rather than after 7 seconds.
 */
import "./setup-ui";

import {
  LATEST_PROTOCOL_VERSION,
  McpUiInitializeResultSchema,
  McpUiToolResultNotificationSchema,
} from "@modelcontextprotocol/ext-apps";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DnaImportApp, deliverFollowUp, type DnaImportAppProps } from "../src/ui/dna-import/app";
import { makeContextData, makeErrorResponse, makeSuccessResponse } from "./helpers.js";

type ToolResponse = ReturnType<typeof makeSuccessResponse>;

/** The exact result the fake host returns for `ui/initialize`. */
const INITIALIZE_RESULT = {
  protocolVersion: LATEST_PROTOCOL_VERSION,
  hostInfo: { name: "fake-host", version: "1.0.0" },
  hostCapabilities: {},
  hostContext: { theme: "light" },
};

/**
 * Hand a message to the app.
 *
 * `window.postMessage` would be the realistic thing to use, but jsdom leaves
 * `MessageEvent.source` null, and `PostMessageTransport` ignores any message
 * whose source is not the window it was constructed with. Dispatching with an
 * explicit source is what makes the app see a reply at all.
 */
function deliverToApp(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data, source: window }));
}

/** The tool-result notification shape the host pushes after a tool returns. */
function toolResultNotification(structured: ToolResponse, meta?: Record<string, unknown>) {
  return {
    method: "ui/notifications/tool-result",
    params: {
      content: [{ type: "text", text: JSON.stringify(structured) }],
      structuredContent: structured as unknown as Record<string, unknown>,
      isError: false,
      ...(meta ? { _meta: meta } : {}),
    },
  };
}

const CATALOG = makeSuccessResponse({
  version: 1,
  snp_count: 2,
  snps: {
    rs328: {
      rsID: "rs328",
      chromosome: "8",
      position_GRCh37: 19819724,
      position_GRCh38: 19962213,
      risk_allele: "A",
    },
    rs671: {
      rsID: "rs671",
      chromosome: "12",
      position_GRCh37: 112241766,
      position_GRCh38: 111803962,
      risk_allele: "A",
    },
  },
});

const FREE_PLAN = {
  entitlement: { plan: "mutant_free", hypothesis_scope: "top_three" },
};

const READY_CAPABILITIES = {
  can_query_analysis: true,
  can_show_overview: true,
  can_refresh_analysis: false,
  can_search_hypotheses: false,
  can_explore_genetic_context: true,
};

const NO_CAPABILITIES = {
  can_query_analysis: false,
  can_show_overview: false,
  can_refresh_analysis: false,
  can_search_hypotheses: false,
  can_explore_genetic_context: false,
};

/** No DNA on file yet: the state the file picker opens in. */
const STATUS_MISSING = makeSuccessResponse({
  dna_status: "missing",
  experience_state: "NO_DNA",
  active_analysis: { status: "none", usable: false },
  pending_analysis: null,
  next_action: {
    tool: "show_dna_import",
    reason: "DNA data is required before an analysis can be created.",
    arguments: { mode: "initial" },
  },
  ...FREE_PLAN,
  capabilities: NO_CAPABILITIES,
});

/** The elapsed timer and long-running copy read the pending run's start time. */
function pendingProcessing(startedAt: string): Record<string, unknown> {
  return {
    status: "processing",
    reason: "initial_analysis",
    started_at: startedAt,
  };
}

/** Build a 3.0.0 `poll_analysis_status` payload for one experience state. */
function statusResponse(
  status: "not_started" | "processing" | "ready" | "failed",
  overrides: Record<string, unknown> = {},
): ToolResponse {
  const generatedAt = new Date(Date.now() - 30_000).toISOString();
  const base: Record<string, unknown> = { ...FREE_PLAN, ...overrides };
  if (status === "ready") {
    return makeSuccessResponse({
      dna_status: "available",
      experience_state: "READY",
      active_analysis: {
        status: "ready",
        analysis_version: "analysis_1",
        generated_at: generatedAt,
        scoring_engine_version: "v3",
        usable: true,
      },
      pending_analysis: null,
      capabilities: READY_CAPABILITIES,
      ...base,
    }, "analysis_1");
  }
  if (status === "processing") {
    return makeSuccessResponse({
      dna_status: "available",
      experience_state: "PROCESSING_INITIAL",
      active_analysis: { status: "none", usable: false },
      pending_analysis: pendingProcessing(generatedAt),
      capabilities: NO_CAPABILITIES,
      ...base,
    });
  }
  if (status === "failed") {
    return makeSuccessResponse({
      dna_status: "available",
      experience_state: "PROCESSING_FAILED",
      active_analysis: { status: "none", usable: false },
      pending_analysis: {
        status: "failed",
        reason: "initial_analysis",
        failure: { code: "ANALYSIS_FAILED", message: "The analysis did not complete." },
      },
      capabilities: NO_CAPABILITIES,
      ...base,
    });
  }
  // DNA is on file but no analysis exists and nothing is in flight.
  return makeSuccessResponse({
    dna_status: "available",
    experience_state: "PROCESSING_INITIAL",
    active_analysis: { status: "none", usable: false },
    pending_analysis: null,
    capabilities: NO_CAPABILITIES,
    ...base,
  });
}

/**
 * A ready analysis that the platform can improve: the active analysis stays
 * usable and the refresh is optional.
 */
function refreshAvailable(overrides: Record<string, unknown> = {}): ToolResponse {
  return statusResponse("ready", {
    experience_state: "READY_REFRESH_AVAILABLE",
    capabilities: { ...READY_CAPABILITIES, can_refresh_analysis: true },
    ...overrides,
  });
}

const FINDINGS = makeSuccessResponse({  items: [
    { id: "HYP_A", rank: 1, name: "Alpha finding", summary: "First summary." },
    { id: "HYP_B", rank: 2, name: "Beta finding", summary: "Second summary." },
    { id: "HYP_C", rank: 3, name: "Gamma finding", summary: "Third summary." },
  ],
  next_cursor: null,
});

const MICROARRAY_BODY = [
  "# rsid\tchromosome\tposition\tgenotype",
  "rs328\t8\t19819724\tAA",
  "rs4680\t22\t19951271\tAG",
  "",
].join("\n");

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** Per-tool answers: either fixed, or a function of the call number. */
type Responders = Record<
  string,
  ToolResponse | ((args: Record<string, unknown>, call: number) => ToolResponse)
>;

/** The parts of the lifecycle a test does not care about. */
function defaultRespond(name: string): ToolResponse {
  if (name === "get_snp_catalog") return CATALOG;
  if (name === "poll_analysis_status") return STATUS_MISSING;
  if (name === "list_health_hypotheses") return FINDINGS;
  if (name === "create_report") {
    return makeSuccessResponse({ analysis_id: "analysis_1", status: "processing" });
  }
  return makeSuccessResponse({ ok: true });
}

interface HostBridge {
  toolCalls: ToolCall[];
  modelContextUpdates: unknown[];
  messages: Array<Record<string, unknown>>;
  openLinks: string[];
  callsTo(name: string): ToolCall[];
  sendToolResult(structured: ToolResponse, meta?: Record<string, unknown>): void;
  /** Detach the listener, so a finished test cannot answer the next one's calls. */
  stop(): void;
}

let activeBridge: HostBridge | null = null;

/** Optional per-test tweaks to how the fake host answers a bridge request. */
interface BridgeOptions {
  /** Result the host returns for `ui/message`; `{ isError: true }` simulates rejection. */
  messageResult?: unknown;
}

/** Stand up a fake host on `window` and answer bridge requests from it. */
function installHostBridge(responders: Responders = {}, options: BridgeOptions = {}): HostBridge {
  const toolCalls: ToolCall[] = [];
  const modelContextUpdates: unknown[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const openLinks: string[] = [];
  const calls = new Map<string, number>();

  function answer(name: string, args: Record<string, unknown>): ToolResponse {
    const call = (calls.get(name) ?? 0) + 1;
    calls.set(name, call);
    const entry = responders[name];
    if (typeof entry === "function") return entry(args, call);
    if (entry) return entry;
    return defaultRespond(name);
  }

  function reply(id: number, result: unknown): void {
    deliverToApp({ jsonrpc: "2.0", id, result });
  }

  function onMessage(event: MessageEvent): void {
    const message = event.data as {
      jsonrpc?: string;
      id?: number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown>; url?: string };
    };
    if (!message || message.jsonrpc !== "2.0") return;
    // Responses to our own requests have no `method`; notifications have no `id`.
    if (typeof message.method !== "string" || message.id === undefined) return;

    if (message.method === "ui/initialize") {
      reply(message.id, INITIALIZE_RESULT);
      return;
    }
    if (message.method === "tools/call") {
      const name = String(message.params?.name ?? "");
      const args = message.params?.arguments ?? {};
      toolCalls.push({ name, arguments: args });
      const envelope = answer(name, args);
      reply(message.id, {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
        isError: false,
      });
      return;
    }
    if (message.method === "ui/update-model-context") {
      modelContextUpdates.push(event.data);
      reply(message.id, {});
      return;
    }
    if (message.method === "ui/message") {
      messages.push({ params: message.params } as unknown as Record<string, unknown>);
      reply(message.id, options.messageResult ?? {});
      return;
    }
    if (message.method === "ui/open-link") {
      openLinks.push(String(message.params?.url ?? ""));
      reply(message.id, {});
      return;
    }
    // Anything else (open-link, size-changed is a notification, ...) is
    // acknowledged so the app never hangs on an unanswered request.
    reply(message.id, {});
  }

  window.addEventListener("message", onMessage);

  const bridge: HostBridge = {
    toolCalls,
    modelContextUpdates,
    messages,
    openLinks,
    callsTo: (name) => toolCalls.filter((call) => call.name === name),
    sendToolResult: (structured, meta) => {
      deliverToApp({ jsonrpc: "2.0", ...toolResultNotification(structured, meta) });
    },
    stop: () => window.removeEventListener("message", onMessage),
  };
  activeBridge = bridge;
  return bridge;
}

/** Short polling so the lifecycle settles inside a test. */
const FAST_POLL: DnaImportAppProps = {
  pollIntervalMs: 10,
  // Long enough that only the tests which ask for it hit the ceiling.
  maxPollingMs: 60_000,
  maxPollFailures: 2,
};

/**
 * The processing card heading, anchored so it does not also match the body copy
 * ("We're generating your analysis now.") or the pre-import expectation line.
 */
const PROCESSING_HEADING = /^Generating your analysis$/;

/** Render the app without waiting for any particular stage. */
function renderWith(
  responders: Responders = {},
  props: DnaImportAppProps = {},
  options: BridgeOptions = {},
): HostBridge {
  const bridge = installHostBridge(responders, options);
  render(<DnaImportApp {...FAST_POLL} {...props} />);
  return bridge;
}

/** Render the app and wait until the catalog has loaded and it is interactive. */
async function renderApp(
  responders: Responders = {},
  props: DnaImportAppProps = {},
  options: BridgeOptions = {},
): Promise<HostBridge> {
  const bridge = renderWith(responders, props, options);
  await screen.findByText(/Drag and drop your DNA file here/i);
  return bridge;
}

/** Render, select a file, and wait for the review screen. */
async function renderToReview(
  responders: Responders = {},
  file = microarrayFile(),
): Promise<HostBridge> {
  const bridge = await renderApp(responders);
  selectFile(file);
  await screen.findByText(/Ready to submit/i);
  return bridge;
}

/** Render, select a file, and submit it, waiting for the processing card. */
async function renderToProcessing(responders: Responders = {}): Promise<HostBridge> {
  const bridge = await renderToReview(responders);
  fireEvent.click(screen.getByRole("button", { name: /create my mutant analysis/i }));
  await screen.findByText(PROCESSING_HEADING);
  return bridge;
}

function selectFile(file: File): void {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error("the file input is not in the document");
  fireEvent.change(input, { target: { files: [file] } });
}

function microarrayFile(body: string = MICROARRAY_BODY): File {
  return new File([body], "23andme.txt", { type: "text/plain" });
}

afterEach(() => {
  cleanup();
  activeBridge?.stop();
  activeBridge = null;
});

describe("DNA import component", () => {
  it("uses an initialization reply the SDK accepts", () => {
    expect(McpUiInitializeResultSchema.safeParse(INITIALIZE_RESULT).success).toBe(true);
  });

  it("pushes tool results the SDK accepts", () => {
    const notification = toolResultNotification(CATALOG);
    expect(McpUiToolResultNotificationSchema.safeParse(notification).success).toBe(true);
  });

  it("checks the account status on mount and loads the catalog", async () => {
    const bridge = await renderApp();

    expect(bridge.callsTo("poll_analysis_status")).toHaveLength(1);
    expect(bridge.callsTo("poll_analysis_status")[0]?.arguments).toEqual({});
    expect(bridge.callsTo("get_snp_catalog")).toHaveLength(1);
    expect(bridge.callsTo("get_snp_catalog")[0]?.arguments).toEqual({});
    // Nothing is created just by opening the panel.
    expect(bridge.callsTo("create_report")).toHaveLength(0);
  });

  it("sets the 2-3 minute expectation before a file is chosen", async () => {
    await renderApp();

    expect(
      screen.getByText(/Generating your analysis usually takes about 2.3 minutes/i),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: /choose dna file/i })).toBeDefined();
    // The marker count comes from the catalog, so it proves the catalog was used.
    expect(screen.getByText(/2 markers in the Mutant panel/)).toBeDefined();
    // No countdown or percentage is promised anywhere.
    expect(screen.queryByText(/remaining/i)).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("shows a retryable catalog error and recovers on retry", async () => {
    let failing = true;
    installHostBridge({
      get_snp_catalog: () =>
        !failing
          ? CATALOG
          : makeErrorResponse("CATALOG_UNAVAILABLE", "no catalog", {
              app_code: "catalog_unavailable",
            }),
    });
    render(<DnaImportApp {...FAST_POLL} />);

    await screen.findByText(/could not prepare the variant catalog/i);

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await screen.findByText(/Drag and drop your DNA file here/i);
    expect(activeBridge?.callsTo("get_snp_catalog")).toHaveLength(2);
  });

  it("reports an unlinked account without offering the dropzone", async () => {
    renderWith({
      poll_analysis_status: makeErrorResponse("ACCOUNT_NOT_AVAILABLE", "no account"),
    });

    await screen.findByText(/Connect your Mutant account first/i);
    expect(screen.queryByText(/Drag and drop your DNA file here/i)).toBeNull();
  });

  it("says when DNA data is already on file without blocking a re-import", async () => {
    renderWith({
      poll_analysis_status: statusResponse("not_started"),
    });

    await screen.findByText(/DNA data is already on file/i);
    expect(screen.getByText(/Drag and drop your DNA file here/i)).toBeDefined();
  });

  it("ignores the removed 2.x status fields", async () => {
    renderWith({
      poll_analysis_status: makeSuccessResponse({
        ...(STATUS_MISSING.data as Record<string, unknown>),
        analysis_status: "unavailable",
        regenerate: true,
        regeneration: { required: false, current_results_usable: false },
      }),
    });

    await screen.findByText(/Drag and drop your DNA file here/i);
    expect(screen.queryByText(/newer analysis platform is available/i)).toBeNull();
    expect(screen.queryByText(/Analysis ready/i)).toBeNull();
  });

  it("ignores the show_dna_import result, which carries no routing state", async () => {
    const bridge = await renderApp();

    bridge.sendToolResult(makeSuccessResponse({ ui_rendered: true }));

    // Nothing changes: the dropzone is still there and no notice appeared.
    expect(screen.getByText(/Drag and drop your DNA file here/i)).toBeDefined();
    expect(screen.queryByText(/Connect your Mutant account first/i)).toBeNull();
  });

  it("parses locally, reviews the summary, and submits only relevant variants", async () => {
    const bridge = await renderToReview();

    expect(screen.queryByText(/Relevant variants found/)).toBeNull();
    expect(screen.queryByText(/Non-SNV capture targets/)).toBeNull();
    expect(screen.queryByText(/Panels covered/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /create my mutant analysis/i }));

    await screen.findByText(PROCESSING_HEADING);

    const submit = bridge.callsTo("create_report")[0];
    expect(submit?.arguments.snps).toEqual({ rs328: "AA" });
    expect(submit?.arguments.upload_meta).toEqual({
      provider: "23andMe",
      file_name: "23andme.txt",
      file_size_bytes: MICROARRAY_BODY.length,
    });
    // Identity is derived server-side from the token; the component must not
    // send any of it, and must not send the raw file either.
    expect(Object.keys(submit?.arguments ?? {}).sort()).toEqual([
      "import_request_id",
      "snps",
      "upload_meta",
    ]);
  });

  it("shows a truthful processing card without internal identifiers", async () => {
    renderWith({ poll_analysis_status: statusResponse("processing") });

    await screen.findByText(PROCESSING_HEADING);

    expect(screen.getByText(/Your DNA was imported successfully/i)).toBeDefined();
    expect(screen.getByText(/DNA file processed/i)).toBeDefined();
    expect(screen.getByText(/Relevant variants imported/i)).toBeDefined();
    expect(screen.getByText(/Analyzing genetic patterns and health hypotheses/i)).toBeDefined();
    expect(screen.getByText(/This usually takes about 2.3 minutes/i)).toBeDefined();
    expect(screen.getByText(/Elapsed: \d+:\d\d/)).toBeDefined();

    // Backend-shaped values never reach the user.
    expect(screen.queryByText(/analysis_1/)).toBeNull();
    expect(screen.queryByText(/core_systems/)).toBeNull();
    expect(screen.queryByText(/^processing$/i)).toBeNull();
    // No re-import control while an analysis is running.
    expect(screen.queryByRole("button", { name: /replace dna data/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /import another file/i })).toBeNull();
  });

  it("resumes an in-flight analysis on mount and polls it to ready", async () => {
    let ready = false;
    const bridge = renderWith({
      poll_analysis_status: () => statusResponse(ready ? "ready" : "processing"),
    });

    await screen.findByText(PROCESSING_HEADING);
    // Resuming never re-imports and never re-creates the report.
    expect(bridge.callsTo("create_report")).toHaveLength(0);

    ready = true;
    await screen.findByText(/Analysis ready/i);

    expect(bridge.callsTo("poll_analysis_status").length).toBeGreaterThan(1);
    expect(bridge.callsTo("create_report")).toHaveLength(0);
  });

  it("opens directly on the ready card when the analysis is already complete", async () => {
    renderWith({ poll_analysis_status: statusResponse("ready") });

    await screen.findByText(/Analysis ready/i);
    expect(screen.getByText(/Your DNA analysis is complete/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /view my top 3 findings/i })).toBeDefined();
    // Nothing is fetched until the user asks for it.
    expect(activeBridge?.callsTo("list_health_hypotheses")).toHaveLength(0);
  });

  it("polls automatically after submitting, without another prompt", async () => {
    let status: "processing" | "ready" = "processing";
    const bridge = await renderToProcessing({
      // The mount check opens on the picker; every later read reports the
      // analysis this component just created.
      poll_analysis_status: (_args, call) => (call === 1 ? STATUS_MISSING : statusResponse(status)),
    });

    expect(bridge.callsTo("create_report")).toHaveLength(1);
    // The model is told the component owns this state.
    expect(bridge.modelContextUpdates).toHaveLength(1);
    expect(JSON.stringify(bridge.modelContextUpdates[0])).toMatch(/do not restate/i);

    status = "ready";
    await screen.findByText(/Analysis ready/i);

    expect(bridge.callsTo("create_report")).toHaveLength(1);
    expect(JSON.stringify(bridge.modelContextUpdates[1])).toMatch(/ready/i);
  });

  it("polls to a terminal state with no next_action or suggested_prompts", async () => {
    // The component's status reads never carry prompts or a polling hint, so
    // assert the fixtures are honest before relying on them.
    for (const status of ["processing", "ready", "failed"] as const) {
      const payload = statusResponse(status).data as Record<string, unknown>;
      expect("suggested_prompts" in payload, status).toBe(false);
      expect("next_action" in payload, status).toBe(false);
    }

    let status: "processing" | "ready" = "processing";
    const bridge = await renderToProcessing({
      poll_analysis_status: (_args, call) => (call === 1 ? STATUS_MISSING : statusResponse(status)),
    });

    status = "ready";
    await screen.findByText(/Analysis ready/i);
    const afterReady = bridge.callsTo("poll_analysis_status").length;
    // Polling stops on completion: no further reads arrive.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(bridge.callsTo("poll_analysis_status").length).toBe(afterReady);

    cleanup();
    activeBridge?.stop();
    activeBridge = null;

    const failed = await renderToProcessing({
      poll_analysis_status: (_args, call) =>
        call === 1 ? STATUS_MISSING : statusResponse("failed"),
    });
    await screen.findByText(/We couldn't complete your analysis/i);
    const afterFailed = failed.callsTo("poll_analysis_status").length;
    // Polling stops on failure too.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(failed.callsTo("poll_analysis_status").length).toBe(afterFailed);
  });

  it("advances the elapsed timer once per second", async () => {
    renderWith({
      poll_analysis_status: statusResponse("processing", {
        pending_analysis: pendingProcessing(new Date(Date.now() - 30_000).toISOString()),
      }),
    });

    await screen.findByText(/Elapsed: 0:30/);
    await screen.findByText(/Elapsed: 0:31/, undefined, { timeout: 3000 });
  });

  it("changes the message when the analysis runs long", async () => {
    renderWith({
      poll_analysis_status: statusResponse("processing", {
        pending_analysis: pendingProcessing(new Date(Date.now() - 4 * 60_000).toISOString()),
      }),
    });
    await screen.findByText(/Still working on your analysis/i);
    // Past the expected range the 2-3 minute promise is dropped rather than kept.
    expect(screen.queryByText(/usually takes about 2.3 minutes/i)).toBeNull();
    // Running long is not an error.
    expect(screen.queryByText(/Something went wrong/i)).toBeNull();

    cleanup();
    activeBridge?.stop();
    activeBridge = null;

    renderWith({
      poll_analysis_status: statusResponse("processing", {
        pending_analysis: pendingProcessing(new Date(Date.now() - 6 * 60_000).toISOString()),
      }),
    });
    await screen.findByText(/You can leave this conversation and return later/i);
  });

  it("offers a recoverable state when the polling ceiling is reached", async () => {
    let ready = false;
    const bridge = renderWith(
      { poll_analysis_status: () => statusResponse(ready ? "ready" : "processing") },
      // The interval is short and the ceiling is a small multiple of it, so both
      // the exhausted state and the resumed read land well inside the window.
      { pollIntervalMs: 5, maxPollingMs: 40 },
    );

    await screen.findByText(/stopped checking automatically/i);
    const before = bridge.callsTo("poll_analysis_status").length;
    // Exceeding the expected range is not an error.
    expect(screen.queryByText(/Something went wrong/i)).toBeNull();

    ready = true;
    fireEvent.click(screen.getByRole("button", { name: /check again/i }));

    await screen.findByText(/Analysis ready/i);
    expect(bridge.callsTo("poll_analysis_status").length).toBeGreaterThan(before);
  });

  it("reports a failed analysis and retries with a new idempotency key", async () => {
    const bridge = await renderToProcessing({
      poll_analysis_status: (_args, call) =>
        call === 1 ? STATUS_MISSING : statusResponse("failed"),
    });

    await screen.findByText(/We couldn't complete your analysis/i);
    expect(screen.getByText(/did not finish successfully/i)).toBeDefined();
    // A failed analysis is reported as a recovery state, not a stack trace.
    expect(screen.queryByText(/Something went wrong/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(bridge.callsTo("create_report")).toHaveLength(2));
    // The previous analysis failed, so the retry must not deduplicate onto it.
    const keys = bridge.callsTo("create_report").map((call) => call.arguments.import_request_id);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("asks for a file again when a resumed session cannot retry in place", async () => {
    const bridge = renderWith({ poll_analysis_status: statusResponse("failed") });

    await screen.findByText(/We couldn't complete your analysis/i);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await screen.findByText(/Drag and drop your DNA file here/i);
    expect(bridge.callsTo("create_report")).toHaveLength(0);
  });

  it("renders the top findings inline when the user asks for them", async () => {
    const bridge = renderWith({ poll_analysis_status: statusResponse("ready") });

    await screen.findByText(/Analysis ready/i);
    fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));

    await screen.findByText(/Alpha finding/i);
    expect(screen.getByText(/Beta finding/i)).toBeDefined();
    expect(screen.getByText(/Gamma finding/i)).toBeDefined();
    expect(screen.getByText("First summary.")).toBeDefined();

    const calls = bridge.callsTo("list_health_hypotheses");
    expect(calls).toHaveLength(1);
    // The displayed snapshot's revision is pinned onto the query.
    expect(calls[0]?.arguments).toEqual({ limit: 3, analysis_version: "analysis_1" });
    // The findings render in place; ChatGPT is not asked to do it again.
    expect(bridge.messages).toHaveLength(0);
    expect(screen.getByRole("button", { name: /ask chatgpt about my results/i })).toBeDefined();
  });

  it("hands a finding to ChatGPT only when the user asks", async () => {
    const bridge = renderWith({ poll_analysis_status: statusResponse("ready") });

    await screen.findByText(/Analysis ready/i);
    fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));
    await screen.findByText(/Alpha finding/i);

    fireEvent.click(screen.getAllByRole("button", { name: /explain this finding/i })[0]!);

    await waitFor(() => expect(bridge.messages).toHaveLength(1));
    const sent = JSON.stringify(bridge.messages[0]);
    expect(sent).toMatch(/Alpha finding/);
    expect(sent).toMatch(/Retrieve the full finding details first/);
    expect(sent).toMatch(/what would strengthen or weaken it/);
    expect(sent).toMatch(/symptoms or test results I have not shared/);
    // Prompts are user-visible natural language, never internal ids.
    expect(sent).not.toMatch(/HYP_A/);
    // Requesting the findings again must not refetch or re-message.
    expect(bridge.callsTo("list_health_hypotheses")).toHaveLength(1);
  });

  it("renders state-aware prompt chips and sends one on click", async () => {
    const bridge = renderWith({
      poll_analysis_status: statusResponse("ready"),
      get_analysis_context: makeSuccessResponse(
        makeContextData({
          suggested_prompts: [
            {
              id: "explain-first",
              label: "Explain #1",
              prompt: "Explain my #1 finding in plain English.",
              intent: "explain",
              hypothesis_id: "HYP_A",
              action: {
                analysis_version: "analysis_1",
                hypothesis_id: "HYP_A",
                intent: "explain",
              },
            },
          ],
        }),
      ),
    });

    await screen.findByText(/Analysis ready/i);
    fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));
    await screen.findByText(/Alpha finding/i);

    const chip = await screen.findByRole("button", { name: "Explain #1" });
    fireEvent.click(chip);
    await waitFor(() => expect(bridge.messages).toHaveLength(1));
    expect(JSON.stringify(bridge.messages[0])).toContain("Explain my #1 finding in plain English.");
  });

  it("opens the overview route with findings and hints already visible", async () => {
    const bridge = renderWith(
      {
        poll_analysis_status: statusResponse("ready"),
        get_analysis_context: makeSuccessResponse(
          makeContextData({
            suggested_prompts: [
              {
                id: "compare-medical-records",
                label: "Compare with my history",
                prompt: "Compare my findings with the health history I shared.",
                intent: "comparison",
              },
            ],
          }),
        ),
      },
      { mode: "overview" },
    );

    await screen.findByText(/Alpha finding/i);
    await screen.findByRole("button", { name: "Compare with my history" });
    expect(screen.queryByRole("button", { name: /view my top 3 findings/i })).toBeNull();
    expect(bridge.callsTo("list_health_hypotheses")).toHaveLength(1);
    expect(bridge.callsTo("get_analysis_context")).toHaveLength(1);
  });

  it("opens findings when the host delivers the overview tool result", async () => {
    const bridge = renderWith({ poll_analysis_status: statusResponse("ready") });

    await screen.findByText(/Analysis ready/i);
    bridge.sendToolResult(makeSuccessResponse({ ui_rendered: true, mode: "overview" }));

    await screen.findByText(/Alpha finding/i);
    expect(bridge.callsTo("list_health_hypotheses")).toHaveLength(1);
  });

  it("shows hints from the bound overview snapshot without a second list read", async () => {
    const bridge = renderWith({
      poll_analysis_status: statusResponse("ready"),
      get_analysis_context: makeSuccessResponse(
        makeContextData({
          suggested_prompts: [
            {
              id: "explain-first",
              label: "Explain #1",
              prompt: "Explain my #1 finding in plain English.",
              intent: "explain",
              hypothesis_id: "HYP_A",
            },
          ],
        }),
      ),
    });

    await screen.findByText(/Analysis ready/i);
    // The host mounts the card from `show_analysis_overview`, so the tool result
    // already carries the ranked items and the revision they are bound to.
    bridge.sendToolResult(
      makeSuccessResponse(
        {
          ui_rendered: true,
          mode: "overview",
          displayed_analysis_version: "analysis_1",
          displayed_hypotheses: [
            { id: "HYP_A", rank: 1, name: "Alpha finding" },
            { id: "HYP_B", rank: 2, name: "Beta finding" },
          ],
        },
        "analysis_1",
      ),
      { mutant: { mode: "overview" } },
    );

    await screen.findByText(/Alpha finding/i);
    // The card must still show its hints, and the authoritative snapshot list
    // must not be fetched a second time.
    await screen.findByRole("button", { name: "Explain #1" });
    expect(bridge.callsTo("get_analysis_context")).toHaveLength(1);
    expect(bridge.callsTo("list_health_hypotheses")).toHaveLength(0);
  });

  it("surfaces an unmatched analysis error instead of the transient outage copy", async () => {
    renderWith(
      {
        poll_analysis_status: statusResponse("ready"),
        list_health_hypotheses: makeErrorResponse(
          "ANALYSIS_NOT_READY",
          "The saved analysis was produced by a different scoring engine and cannot be served. Regenerate the analysis to bring it up to date.",
          { reason: "analysis_engine_changed" },
        ),
      },
      { mode: "overview" },
    );

    await screen.findByText(/different scoring engine/i);
    expect(screen.queryByText(/temporarily unavailable/i)).toBeNull();
  });

  it("offers history comparison and the Full upgrade link only to Free accounts", async () => {
    const bridge = renderWith({
      poll_analysis_status: statusResponse("ready"),
      get_analysis_context: makeSuccessResponse(
        makeContextData({
          upgrade: { label: "Unlock Full Analysis", url: "https://mutantgenomics.com/upgrade" },
          suggested_prompts: [
            {
              id: "explain-first",
              label: "Explain #1",
              prompt: "Explain my #1 finding in plain English.",
              intent: "explain",
            },
            {
              id: "compare-top-three",
              label: "Compare top 3",
              prompt: "Compare my top three findings and explain how they differ.",
              intent: "comparison",
            },
            {
              id: "compare-medical-records",
              label: "Compare with my history",
              prompt: "Compare my accessible findings with the health history I have shared.",
              intent: "comparison",
            },
          ],
        }),
      ),
    });

    await screen.findByText(/Analysis ready/i);
    fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));
    await screen.findByRole("button", { name: "Explain #1" });
    expect(screen.getByRole("button", { name: "Compare top 3" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Compare with my history" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Compare all with Full" })).toBeNull();
    const upgradeLink = screen.getByRole("link", { name: "Upgrade to Mutant Full" });
    expect(upgradeLink.getAttribute("href")).toBe("https://mutantgenomics.com/upgrade");
    expect(upgradeLink.getAttribute("target")).toBe("_blank");
    fireEvent.click(upgradeLink);
    await waitFor(() => expect(bridge.openLinks).toEqual(["https://mutantgenomics.com/upgrade"]));
  });

  it("does not offer an upgrade to a Full account", async () => {
    const bridge = renderWith({
      poll_analysis_status: statusResponse("ready", {
        entitlement: { plan: "mutant_full", hypothesis_scope: "all" },
        capabilities: { ...READY_CAPABILITIES, can_search_hypotheses: true },
      }),
      get_analysis_context: makeSuccessResponse(
        makeContextData({
          suggested_prompts: [
            {
              id: "compare-all",
              label: "Compare all findings",
              prompt: "Compare all findings with my records.",
              intent: "comparison",
            },
          ],
        }),
      ),
    });

    await screen.findByText(/Analysis ready/i);
    fireEvent.click(screen.getByRole("button", { name: /view my findings/i }));
    await screen.findByRole("button", { name: "Compare all findings" });
    expect(screen.queryByRole("link", { name: "Upgrade to Mutant Full" })).toBeNull();
    expect(bridge.openLinks).toHaveLength(0);
  });

  it("offers an optional refresh when a newer analysis is available", async () => {
    const bridge = renderWith({
      poll_analysis_status: refreshAvailable(),
    });

    await screen.findByText(/Analysis ready/i);
    expect(screen.getByText(/newer analysis platform is available/i)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /refresh analysis/i }));
    await screen.findByText(/Resubmit your DNA to refresh/i);
    expect(screen.getByRole("button", { name: /choose dna file/i })).toBeDefined();
    expect(bridge.messages).toHaveLength(0);
  });

  it("loads hints when a refresh status result mounts the card", async () => {
    const status = refreshAvailable();
    const bridge = renderWith({
      poll_analysis_status: status,
      get_analysis_context: makeSuccessResponse(
        makeContextData({
          suggested_prompts: [
            {
              id: "compare-medical-records",
              label: "Compare with my history",
              prompt: "Compare my findings with the health history I shared.",
              intent: "comparison",
            },
          ],
        }),
      ),
    });

    await screen.findByText(/Analysis ready/i);
    bridge.sendToolResult(status, { mutant: { mode: "overview" } });

    await screen.findByText(/Alpha finding/i);
    await screen.findByRole("button", { name: "Compare with my history" });
    expect(screen.getByRole("button", { name: /refresh analysis/i })).toBeDefined();
  });

  it("opens the resubmission flow when the host selected a refresh", async () => {
    await renderApp(
      {
        poll_analysis_status: refreshAvailable(),
      },
      { mode: "regenerate" },
    );

    // A refresh needs DNA again, so the card must show the picker, not the ready
    // screen whose banner would re-offer the refresh the user just accepted.
    await screen.findByText(/Refresh your analysis/i);
    expect(screen.getByText(/Resubmit your DNA to refresh/i)).toBeDefined();
    expect(screen.getByText(/Drag and drop your DNA file here/i)).toBeDefined();
    expect(screen.queryByText(/Analysis ready/i)).toBeNull();
    expect(screen.queryByText(/newer analysis platform is available/i)).toBeNull();
  });

  it("moves off the ready card when a regenerate result arrives after mount", async () => {
    const bridge = renderWith({
      poll_analysis_status: refreshAvailable(),
    });

    await screen.findByText(/Analysis ready/i);
    expect(screen.getByRole("button", { name: /refresh analysis/i })).toBeDefined();

    // The host pushes the result of the follow-up `show_dna_import` call. It must
    // redirect to resubmission instead of re-rendering the same refresh banner.
    bridge.sendToolResult(makeSuccessResponse({ ui_rendered: true, mode: "regenerate" }));

    await screen.findByText(/Refresh your analysis/i);
    expect(screen.getByText(/Drag and drop your DNA file here/i)).toBeDefined();
    expect(screen.queryByText(/Analysis ready/i)).toBeNull();
  });

  it("sends exactly one host follow-up per action and never renders the prompt", async () => {
    const bridge = renderWith({ poll_analysis_status: statusResponse("ready") });

    await screen.findByText(/Analysis ready/i);
    fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));
    await screen.findByText(/Alpha finding/i);

    const findingsBefore = screen.getByRole("list").textContent;

    fireEvent.click(screen.getAllByRole("button", { name: /explain this finding/i })[0]!);
    await waitFor(() => expect(bridge.messages).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /ask chatgpt about my results/i }));
    await waitFor(() => expect(bridge.messages).toHaveLength(2));

    // One host message per click, delivered as a user turn.
    const texts = bridge.messages.map((message) => {
      const params = message.params as { role?: string; content?: Array<{ text?: string }> };
      expect(params.role).toBe("user");
      return params.content?.map((block) => block.text ?? "").join("") ?? "";
    });
    expect(texts[0]).toMatch(/Explain my "Alpha finding"/);
    expect(texts[1]).toBe("Ask ChatGPT about my Mutant results.");

    // The widget's findings are unchanged and the prompt text is nowhere in the card.
    expect(screen.getByRole("list").textContent).toBe(findingsBefore);
    expect(screen.queryByText(/Explain my "Alpha finding"/)).toBeNull();
    expect(screen.queryByText(/Ask ChatGPT about my Mutant results\./)).toBeNull();
    expect(screen.getByText(/Alpha finding/i)).toBeDefined();
    expect(screen.getByText(/First summary\./)).toBeDefined();
  });

  it("uses the ChatGPT host API when the widget is injected with window.openai", async () => {
    const sendFollowUpMessage = vi.fn();
    Object.defineProperty(window, "openai", {
      value: { sendFollowUpMessage },
      configurable: true,
      writable: true,
    });
    try {
      const bridge = renderWith({ poll_analysis_status: statusResponse("ready") });

      await screen.findByText(/Analysis ready/i);
      fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));
      await screen.findByText(/Alpha finding/i);

      fireEvent.click(screen.getAllByRole("button", { name: /explain this finding/i })[0]!);

      await waitFor(() => expect(sendFollowUpMessage).toHaveBeenCalledTimes(1));
      expect(sendFollowUpMessage).toHaveBeenCalledWith({
        prompt: expect.stringContaining("Alpha finding"),
        scrollToBottom: true,
      });
      // The MCP Apps bridge is not also used: the prompt is sent only once.
      expect(bridge.messages).toHaveLength(0);
      expect(screen.queryByText(/Explain my "Alpha finding"/)).toBeNull();
    } finally {
      delete (window as unknown as { openai?: unknown }).openai;
    }
  });

  it("shows a user-visible error when the host rejects the follow-up", async () => {
    const bridge = renderWith(
      { poll_analysis_status: statusResponse("ready") },
      {},
      { messageResult: { isError: true } },
    );

    await screen.findByText(/Analysis ready/i);
    fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));
    await screen.findByText(/Alpha finding/i);

    fireEvent.click(screen.getAllByRole("button", { name: /explain this finding/i })[0]!);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't send that follow-up message/i);
    // The prompt is reported as an error, not echoed into the card.
    expect(screen.queryByText(/Explain my "Alpha finding"/)).toBeNull();
    expect(bridge.callsTo("list_health_hypotheses")).toHaveLength(1);
  });

  it("feature-detects the host API and reports when none is available", async () => {
    // jsdom has no `window.openai`, and passing no app simulates a host with no
    // `ui/message` bridge.
    await expect(deliverFollowUp(null, "Explain my results")).resolves.toBe("unavailable");
  });

  it("exposes a low-emphasis replace action once the analysis is ready", async () => {
    const bridge = renderWith({ poll_analysis_status: statusResponse("ready") });

    await screen.findByText(/Analysis ready/i);
    // No re-import control while processing; a quiet one when ready.
    expect(screen.queryByRole("button", { name: /import another file/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /replace dna data/i }));

    await screen.findByText(/Drag and drop your DNA file here/i);
    expect(bridge.callsTo("create_report")).toHaveLength(0);
  });

  it("keeps the card alive but stops polling without the read scope", async () => {
    const bridge = renderWith({
      poll_analysis_status: makeErrorResponse("INSUFFICIENT_SCOPE", "scope missing", {
        app_code: "insufficient_scope",
        required_scope: "https://mcp.mutantgenomics.com/mcp/analysis.read",
      }),
    });

    await screen.findByText(/Drag and drop your DNA file here/i);
    selectFile(microarrayFile());
    await screen.findByText(/Ready to submit/i);
    fireEvent.click(screen.getByRole("button", { name: /create my mutant analysis/i }));

    await screen.findByText(PROCESSING_HEADING);
    expect(screen.getByText(/Ask ChatGPT when your analysis is ready/i)).toBeDefined();
    // The mount check plus nothing else: polling never started.
    expect(bridge.callsTo("poll_analysis_status")).toHaveLength(1);
  });

  it("reuses one idempotency key when the same attempt is retried", async () => {
    const bridge = await renderToReview({
      create_report: (_args, call) =>
        call === 1
          ? makeErrorResponse("REPORT_GENERATION_FAILED", "boom", {
              app_code: "report_generation_failed",
            })
          : makeSuccessResponse({ analysis_id: "a-2", status: "processing" }),
    });

    fireEvent.click(screen.getByRole("button", { name: /create my mutant analysis/i }));
    await screen.findByText(/could not start your analysis/i);

    fireEvent.click(screen.getByRole("button", { name: /create my mutant analysis/i }));
    await screen.findByText(PROCESSING_HEADING);

    const keys = bridge.callsTo("create_report").map((call) => call.arguments.import_request_id);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("asks the user to re-consent when the token lacks the import scope", async () => {
    await renderToReview({
      create_report: makeErrorResponse("INSUFFICIENT_SCOPE", "scope missing", {
        required_scope: "https://mcp.mutantgenomics.com/mcp/dna.import",
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: /create my mutant analysis/i }));

    await screen.findByText(/Reconnect Mutant to grant it/i);
    // The review screen survives so the same file can be resubmitted after the
    // user reconnects.
    expect(screen.getByRole("button", { name: /create my mutant analysis/i })).toBeDefined();
  });

  it("explains a file with no panel variants instead of submitting it", async () => {
    const bridge = await renderApp();

    selectFile(
      microarrayFile(["# rsid\tchromosome\tposition\tgenotype", "rs0\t1\t1\tAA", ""].join("\n")),
    );

    await screen.findByText(/contained none of the variants in the Mutant panel/i);
    expect(bridge.callsTo("create_report")).toHaveLength(0);
  });

  it("rejects an oversized file before reading any of it", async () => {
    const bridge = await renderApp();

    // No bytes are allocated: only the reported size matters here.
    const huge = new File([""], "huge.vcf.gz", { type: "application/gzip" });
    Object.defineProperty(huge, "size", { value: 2 * 1024 * 1024 * 1024 });
    selectFile(huge);

    await screen.findByText(/too large to process locally/i);
    expect(bridge.callsTo("create_report")).toHaveLength(0);
  });

  it("reports an unsupported browser rather than uploading the file", async () => {
    // `supportsStreaming()` checks `File.prototype.stream`, which is inherited
    // from `Blob.prototype`, so the shadow has to be deleted rather than
    // restored, or every later test would take this branch too.
    const ownDescriptor = Object.getOwnPropertyDescriptor(File.prototype, "stream");
    Object.defineProperty(File.prototype, "stream", { value: undefined, configurable: true });
    try {
      const bridge = await renderApp();

      selectFile(microarrayFile());

      await screen.findByText(/This browser could not read the file locally/i);
      expect(bridge.callsTo("create_report")).toHaveLength(0);
    } finally {
      if (ownDescriptor) {
        Object.defineProperty(File.prototype, "stream", ownDescriptor);
      } else {
        delete (File.prototype as unknown as Record<string, unknown>).stream;
      }
    }
  });

  it("refuses to submit more variants than one request may carry", async () => {
    // One marker over the client-side ceiling that mirrors MAX_SNP_ENTRIES.
    const markerCount = 20001;
    const snps: Record<string, unknown> = {};
    const lines = ["# rsid\tchromosome\tposition\tgenotype"];
    for (let index = 0; index < markerCount; index += 1) {
      const rsID = `rs${1000000 + index}`;
      snps[rsID] = { rsID, chromosome: "1", position_GRCh37: 100000 + index, risk_allele: "A" };
      lines.push(`${rsID}\t1\t${100000 + index}\tAA`);
    }
    const bridge = await renderApp({
      get_snp_catalog: makeSuccessResponse({ version: 1, snp_count: markerCount, snps }),
    });

    selectFile(microarrayFile(lines.join("\n")));

    await screen.findByText(/too large to submit in one request/i);
    expect(bridge.callsTo("create_report")).toHaveLength(0);
  }, 30_000);

  it("cancels an in-flight parse and returns to the file picker", async () => {
    const bridge = await renderApp();

    // A stream that never yields or closes: the parse stays in flight, which is
    // what a large file looks like to the user.
    const stalled = new File(["# rsid\tchromosome\tposition\tgenotype\n"], "23andme.txt");
    Object.defineProperty(stalled, "stream", {
      value: () => new ReadableStream({ start() {} }),
    });
    selectFile(stalled);

    await screen.findByText(/Reading DNA file/i);
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await screen.findByText(/Drag and drop your DNA file here/i);
    expect(bridge.callsTo("create_report")).toHaveLength(0);
  });
});
