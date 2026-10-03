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
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  analysisVersion = "analysis_1",
): ToolResponse {
  const generatedAt = new Date(Date.now() - 30_000).toISOString();
  const base: Record<string, unknown> = { ...FREE_PLAN, ...overrides };
  if (status === "ready") {
    return makeSuccessResponse({
      dna_status: "available",
      experience_state: "READY",
      active_analysis: {
        status: "ready",
        analysis_version: analysisVersion,
        generated_at: generatedAt,
        scoring_engine_version: "v3",
        usable: true,
      },
      pending_analysis: null,
      capabilities: READY_CAPABILITIES,
      ...base,
    }, analysisVersion);
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

/**
 * A usable analysis whose refresh is still being generated. The active analysis
 * stays queryable and the card shows the optional refresh control.
 */
function refreshProcessing(overrides: Record<string, unknown> = {}): ToolResponse {
  return statusResponse("ready", {
    experience_state: "READY_REFRESH_PROCESSING",
    pending_analysis: pendingProcessing(new Date(Date.now() - 10_000).toISOString()),
    capabilities: { ...READY_CAPABILITIES, can_refresh_analysis: true },
    ...overrides,
  });
}

/** A ready analysis bound to an explicit revision, so version pinning is observable. */
function readyAt(version: string): ToolResponse {
  return statusResponse("ready", {}, version);
}

const FINDINGS = makeSuccessResponse(
  {
    items: [
      {
        id: "HYP_A",
        rank: 1,
        name: "Alpha finding",
        summary: "First summary.",
        genetic_support: 72,
        genetic_evidence: "strong",
      },
      {
        id: "HYP_B",
        rank: 2,
        name: "Beta finding",
        summary: "Second summary.",
        genetic_support: 61,
        genetic_evidence: "moderate",
      },
      {
        id: "HYP_C",
        rank: 3,
        name: "Gamma finding",
        summary: "Third summary.",
        genetic_support: 40,
        genetic_evidence: "weak",
      },
    ],
    next_cursor: null,
  },
  // Matches the revision the ready status reports, so a comparison read is not
  // mistaken for a different analysis.
  "analysis_1",
);

/** The server-authored top-three comparison chip the overview card renders. */
const COMPARE_CHIP = {
  id: "compare-top-three",
  label: "Compare top 3",
  prompt: "Compare my top three findings and explain how they differ.",
  heading: "## Comparing your top three findings",
  intent: "comparison",
  action: { analysis_version: "analysis_1", intent: "comparison" },
};

/** A `get_analysis_context` result that offers only the compare chip. */
function chipContext(): ToolResponse {
  return makeSuccessResponse(makeContextData({ suggested_prompts: [COMPARE_CHIP] }));
}

/** Responders for the overview route with the compare chip and a ready analysis. */
function compareOverviewResponders(
  overrides: Responders = {},
): Responders {
  return {
    poll_analysis_status: statusResponse("ready"),
    get_analysis_context: chipContext(),
    list_health_hypotheses: FINDINGS,
    ...overrides,
  };
}

/** The bound overview result a host pushes to mount the overview card. */
function boundOverview(version = "analysis_1"): ToolResponse {
  return makeSuccessResponse(
    {
      ui_rendered: true,
      mode: "overview",
      displayed_analysis_version: version,
      displayed_hypotheses: [
        { id: "HYP_A", rank: 1, name: "Alpha finding" },
        { id: "HYP_B", rank: 2, name: "Beta finding" },
        { id: "HYP_C", rank: 3, name: "Gamma finding" },
      ],
    },
    version,
  );
}

/**
 * A bound Full overview: the first 10 accessible findings plus the account-wide
 * count. The backend caps `displayed_hypotheses` here, so the card renders the
 * ten it was given and never fetches the remaining 82 to expand the card.
 */
function boundFullOverview(version = "analysis_1"): ToolResponse {
  return makeSuccessResponse(
    {
      ui_rendered: true,
      mode: "overview",
      displayed_analysis_version: version,
      displayed_hypotheses: Array.from({ length: 10 }, (_, index) => ({
        id: `HYP_${String(index + 1).padStart(2, "0")}`,
        rank: index + 1,
        name: `Finding ${String(index + 1).padStart(2, "0")}`,
      })),
      total_accessible_count: 92,
      has_more: true,
    },
    version,
  );
}

/** The Full-only cross-finding chip the overview card keeps for the rest of the set. */
const CONNECT_FINDINGS_CHIP = {
  id: "connect-findings",
  label: "Connect my findings",
  prompt:
    "Look across the findings I can access in this analysis and tell me whether several of them are telling parts of the same biological story.",
  heading: "Mutant follow-up: Connect my findings",
  intent: "evidence",
  action: { analysis_version: "analysis_1", intent: "evidence" },
};

/** The Full entitlement the ready status must report for the capped card. */
const FULL_PLAN = {
  entitlement: { plan: "mutant_full", hypothesis_scope: "all" },
};

/**
 * Render the card the way a host mounts it from `show_analysis_overview`: the
 * bound snapshot pins the revision and the ranked list before the comparison
 * prefetch can run, so the comparison read is the card's only
 * `list_health_hypotheses` call. This mirrors production, where the card opens
 * from the display tool result rather than fetching its own list.
 */
async function renderCompareOverview(
  overrides: Responders = {},
  options: BridgeOptions = {},
): Promise<HostBridge> {
  const bridge = renderWith(compareOverviewResponders(overrides), {}, options);
  await screen.findByText(/Analysis ready/i);
  bridge.sendToolResult(boundOverview(), { mutant: { mode: "overview" } });
  await screen.findByText(/Alpha finding/i);
  return bridge;
}

/** Wait for the quiet version-pinned comparison prefetch to have been issued. */
async function waitForComparisonPrefetch(bridge: HostBridge): Promise<void> {
  await waitFor(() => expect(bridge.callsTo("list_health_hypotheses")).toHaveLength(1));
}

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
  /** Release every tool reply held by `deferToolNames`, in arrival order. */
  releaseDeferred(): void;
  /** Detach the listener, so a finished test cannot answer the next one's calls. */
  stop(): void;
}

let activeBridge: HostBridge | null = null;

/** Optional per-test tweaks to how the fake host answers a bridge request. */
interface BridgeOptions {
  /** Result the host returns for `ui/message`; `{ isError: true }` simulates rejection. */
  messageResult?: unknown;
  /**
   * Tool names whose replies are held until `releaseDeferred()` is called, so a
   * test can observe an in-flight read (and its loading state) rather than the
   * instant answer a synchronous bridge would give.
   */
  deferToolNames?: string[];
  /**
   * Widget-only `_meta` the host attaches to a tool's reply (keyed by tool name),
   * mirroring how the server's `CONSENT_REQUIRED` result carries the portal
   * consent descriptor. A function receives the call number so a second call can
   * answer differently.
   */
  toolMeta?: Record<
    string,
    Record<string, unknown> | ((args: Record<string, unknown>, call: number) => Record<string, unknown>)
  >;
}

/** Stand up a fake host on `window` and answer bridge requests from it. */
function installHostBridge(responders: Responders = {}, options: BridgeOptions = {}): HostBridge {
  const toolCalls: ToolCall[] = [];
  const modelContextUpdates: unknown[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const openLinks: string[] = [];
  const calls = new Map<string, number>();
  /** Replies held back until the test releases them, in arrival order. */
  const deferred: Array<() => void> = [];

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
      const metaEntry = options.toolMeta?.[name];
      const meta =
        typeof metaEntry === "function"
          ? metaEntry(args, calls.get(name) ?? 1)
          : metaEntry;
      const result = {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
        isError: false,
        ...(meta ? { _meta: meta } : {}),
      };
      if (options.deferToolNames?.includes(name)) {
        deferred.push(() => reply(message.id as number, result));
        return;
      }
      reply(message.id, result);
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
    releaseDeferred: () => {
      for (const release of deferred.splice(0)) release();
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
  delete (window as Window & { openai?: unknown }).openai;
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
      source_format: "array",
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
    expect(screen.getByRole("button", { name: "Summarize my top 3" })).toBeDefined();
  });

  it("hands a finding to ChatGPT only when the user asks", async () => {
    const bridge = renderWith({ poll_analysis_status: statusResponse("ready") });

    await screen.findByText(/Analysis ready/i);
    fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));
    await screen.findByText(/Alpha finding/i);

    fireEvent.click(screen.getAllByRole("button", { name: /explain finding #1/i })[0]!);

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

  it("renders only the bound top 10 for Full and hints at the rest without fetching it", async () => {
    const bridge = renderWith({
      poll_analysis_status: statusResponse("ready", FULL_PLAN),
      get_analysis_context: makeSuccessResponse(
        makeContextData({ suggested_prompts: [CONNECT_FINDINGS_CHIP] }),
      ),
      // Any list read would return the whole 92-item set; the card must not ask.
      list_health_hypotheses: makeSuccessResponse({
        items: Array.from({ length: 92 }, (_, index) => ({
          id: `HYP_${String(index + 1).padStart(2, "0")}`,
          rank: index + 1,
          name: `Finding ${String(index + 1).padStart(2, "0")}`,
        })),
        next_cursor: null,
      }),
    });

    await screen.findByText(/Analysis ready/i);
    bridge.sendToolResult(boundFullOverview(), { mutant: { mode: "overview" } });

    // Exactly the ten bound findings render, with a cue for the remaining 82.
    await screen.findByText(/Showing your top 10 of 92 findings/i);
    expect(screen.getAllByRole("button", { name: /Explain finding #/ })).toHaveLength(10);
    expect(screen.queryByText(/Finding 11/)).toBeNull();
    // The rest stays behind the deliberate cross-finding action, not an auto-expansion.
    await screen.findByRole("button", { name: "Connect my findings" });
    expect(bridge.callsTo("list_health_hypotheses")).toHaveLength(0);
  });

  it("sends a topic-free Connect my findings request bound to the displayed version", async () => {
    const bridge = renderWith({
      poll_analysis_status: statusResponse("ready", FULL_PLAN),
      get_analysis_context: makeSuccessResponse(
        makeContextData({ suggested_prompts: [CONNECT_FINDINGS_CHIP] }),
      ),
      list_health_hypotheses: makeSuccessResponse({
        items: Array.from({ length: 92 }, (_, index) => ({
          id: `HYP_${String(index + 1).padStart(2, "0")}`,
          rank: index + 1,
          name: `Finding ${String(index + 1).padStart(2, "0")}`,
        })),
        next_cursor: null,
      }),
    });

    await screen.findByText(/Analysis ready/i);
    bridge.sendToolResult(boundFullOverview(), { mutant: { mode: "overview" } });

    const chip = await screen.findByRole("button", { name: "Connect my findings" });
    fireEvent.click(chip);
    await waitFor(() => expect(bridge.messages).toHaveLength(1));

    const params = bridge.messages[0]?.params as {
      role?: string;
      content?: Array<{ text?: string }>;
    };
    const sent = params.content?.map((block) => block.text ?? "").join("") ?? "";
    // The heading instruction precedes the untouched server-authored prompt.
    expect(params.role).toBe("user");
    expect(sent).toContain('Mutant follow-up: Connect my findings');
    expect(sent).toContain(
      "Look across the findings I can access in this analysis and tell me whether several of them are telling parts of the same biological story.",
    );
    // No topic, symptom, or history is required to answer it.
    expect(sent).not.toMatch(/query=|topic|symptom|health history/i);
    // The click never expanded the card into the full ranked set.
    expect(bridge.callsTo("list_health_hypotheses")).toHaveLength(0);
    // The version guard re-read the bound revision before sending.
    expect(bridge.callsTo("poll_analysis_status").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/These results have changed/i)).toBeNull();
  });

  it("explains the connection wait before host acknowledgment without claiming the answer is ready", async () => {
    let resolveSend: () => void = () => undefined;
    const sendFollowUpMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    Object.defineProperty(window, "openai", {
      value: { sendFollowUpMessage },
      configurable: true,
      writable: true,
    });
    const diagnostic = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const bridge = renderWith({
      poll_analysis_status: statusResponse("ready", FULL_PLAN),
      get_analysis_context: makeSuccessResponse(
        makeContextData({ suggested_prompts: [CONNECT_FINDINGS_CHIP] }),
      ),
    });
    await screen.findByText(/Analysis ready/i);
    bridge.sendToolResult(boundFullOverview(), { mutant: { mode: "overview" } });
    fireEvent.click(await screen.findByRole("button", { name: "Connect my findings" }));
    expect((await screen.findByRole("status")).textContent).toContain(
      "Checking connections can take a little while",
    );
    expect(screen.queryByText(/Question sent:/)).toBeNull();
    await waitFor(() => expect(sendFollowUpMessage).toHaveBeenCalledTimes(1));
    resolveSend();
    await screen.findByText(/Question sent: Connect my findings/);
    expect(screen.getByRole("status").textContent).toContain(
      "may need time to check the supporting evidence",
    );
    const timing = diagnostic.mock.calls.filter(([message]) =>
      String(message).startsWith("[mutant-ui] timing follow-up"),
    );
    expect(timing.map(([message]) => message)).toEqual([
      expect.stringMatching(/^\[mutant-ui\] timing follow-up version check: \d+ms$/),
      expect.stringMatching(/^\[mutant-ui\] timing follow-up host acknowledgment: \d+ms$/),
    ]);
    expect(timing.every((args) => args.length === 1)).toBe(true);
    diagnostic.mockRestore();
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

  it("renders the factual plan notice and its informational link only for Free accounts", async () => {
    const bridge = renderWith({
      poll_analysis_status: statusResponse("ready"),
      get_analysis_context: makeSuccessResponse(
        makeContextData({
          plan_notice: {
            text: "Your Mutant Free plan includes your top three ranked findings.",
            learn_more: {
              label: "Learn about Mutant plans",
              url: "https://mutantgenomics.com/plans",
            },
          },
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
    // Comparison leads the card and spells out the data boundary.
    expect(
      screen.getByText(/Uses only health history or records you share in this chat\./),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Compare all with Full" })).toBeNull();
    expect(
      screen.getByText("Your Mutant Free plan includes your top three ranked findings."),
    ).toBeDefined();
    const planLink = screen.getByRole("link", { name: "Learn about Mutant plans" });
    expect(planLink.getAttribute("href")).toBe("https://mutantgenomics.com/plans");
    expect(planLink.getAttribute("target")).toBe("_blank");
    fireEvent.click(planLink);
    await waitFor(() => expect(bridge.openLinks).toEqual(["https://mutantgenomics.com/plans"]));
  });

  it("sends the server-selected comparison prompt once, even on a double click", async () => {
    const bridge = renderWith({
      poll_analysis_status: statusResponse("ready"),
      get_analysis_context: makeSuccessResponse(
        makeContextData({
          suggested_prompts: [
            {
              id: "compare-medical-records",
              label: "Compare with my history",
              prompt: "Which of my findings best fits the history I shared here?",
              intent: "comparison",
              action: { analysis_version: "analysis_1", intent: "comparison" },
            },
            {
              id: "explain-first",
              label: "Explain #1",
              prompt: "Explain my #1 finding in plain English.",
              intent: "explain",
            },
          ],
        }),
      ),
    });

    await screen.findByText(/Analysis ready/i);
    fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));

    const compare = await screen.findByRole("button", { name: "Compare with my history" });
    fireEvent.click(compare);
    fireEvent.click(compare);

    // The guard makes one click one server-selected prompt; the card never
    // builds a second, hard-coded comparison request.
    await waitFor(() => expect(bridge.messages).toHaveLength(1));
    expect(JSON.stringify(bridge.messages[0])).toContain(
      "Which of my findings best fits the history I shared here?",
    );
  });

  it("does not show a plan notice to a Full account", async () => {
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
    expect(screen.queryByRole("link", { name: "Learn about Mutant plans" })).toBeNull();
    expect(bridge.openLinks).toHaveLength(0);
  });

  it("renders the plan notice text without a link when no approved URL is available", async () => {
    renderWith({
      poll_analysis_status: statusResponse("ready"),
      get_analysis_context: makeSuccessResponse(
        makeContextData({
          plan_notice: {
            text: "Your Mutant Free plan includes your top three ranked findings.",
          },
          suggested_prompts: [
            {
              id: "explain-first",
              label: "Explain #1",
              prompt: "Explain my #1 finding in plain English.",
              intent: "explain",
            },
          ],
        }),
      ),
    });

    await screen.findByText(/Analysis ready/i);
    fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));
    expect(
      await screen.findByText("Your Mutant Free plan includes your top three ranked findings."),
    ).toBeDefined();
    expect(screen.queryByRole("link", { name: "Learn about Mutant plans" })).toBeNull();
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

  it("shows the refresh control inside the overview while a refresh is processing", async () => {
    const bridge = renderWith({ poll_analysis_status: refreshProcessing() }, { mode: "overview" });

    await screen.findByText(/Analysis ready/i);
    // The bound findings are the usable current analysis, not the pending refresh.
    await screen.findByText(/Alpha finding/i);
    // The optional refresh control is present; the current results stay usable.
    expect(screen.getByText(/refreshing is optional/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /refresh analysis/i })).toBeDefined();
    expect(bridge.callsTo("list_health_hypotheses")).toHaveLength(1);
  });

  it("keeps the bound overview revision for follow-up actions after a status read", async () => {
    const bridge = renderWith({
      // The mount status reports one revision; the verification read the card
      // makes before a follow-up reports the revision the overview pinned.
      poll_analysis_status: (_args, call) => (call === 1 ? readyAt("analysis_2") : readyAt("analysis_1")),
    });

    await screen.findByText(/Analysis ready/i);

    // The host mounts the card from `show_analysis_overview`, which pins revision
    // "analysis_1" and its findings.
    bridge.sendToolResult(
      makeSuccessResponse(
        {
          ui_rendered: true,
          mode: "overview",
          displayed_analysis_version: "analysis_1",
          displayed_hypotheses: [{ id: "HYP_A", rank: 1, name: "Alpha finding" }],
        },
        "analysis_1",
      ),
      { mutant: { mode: "overview" } },
    );
    await screen.findByText(/Alpha finding/i);

    // The follow-up resolves against the pinned revision, so it sends instead of
    // being treated as a different analysis, and the displayed findings stay put.
    fireEvent.click(screen.getByRole("button", { name: /explain finding #1/i }));
    await waitFor(() => expect(bridge.messages).toHaveLength(1));
    expect(screen.queryByText(/These results have changed/i)).toBeNull();
    expect(screen.getByText(/Alpha finding/i)).toBeDefined();
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

    fireEvent.click(screen.getAllByRole("button", { name: /explain finding #1/i })[0]!);
    await waitFor(() => expect(bridge.messages).toHaveLength(1));

    expect(screen.queryByRole("button", { name: /ask chatgpt about my results/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Summarize my top 3" }));
    await waitFor(() => expect(bridge.messages).toHaveLength(2));

    // One host message per click, delivered as a user turn.
    const texts = bridge.messages.map((message) => {
      const params = message.params as { role?: string; content?: Array<{ text?: string }> };
      expect(params.role).toBe("user");
      return params.content?.map((block) => block.text ?? "").join("") ?? "";
    });
    expect(texts[0]).toMatch(/Explain my "Alpha finding"/);
    // The heading instruction is prepended; the server-selected prompt survives.
    expect(texts[1]).toContain("## Your Mutant findings explained");
    expect(texts[1]).toContain("retrieve the supporting details for each identified finding");
    expect(texts[1]).toContain("the most important uncertainty or limitation");
    expect(texts[1]).toContain("without asking what I want to know");
    expect(texts[1]).toContain('"analysis_version":"analysis_1"');
    for (const id of ["HYP_A", "HYP_B", "HYP_C"]) {
      expect(texts[1]).toContain(`"hypothesis_id":"${id}"`);
    }

    // The widget's findings are unchanged and the prompt text is nowhere in the card.
    expect(screen.getByRole("list").textContent).toBe(findingsBefore);
    expect(screen.queryByText(/Explain my "Alpha finding"/)).toBeNull();
    expect(screen.queryByText(/Ask ChatGPT about my Mutant results\./)).toBeNull();
    expect(screen.getByText(/Alpha finding/i)).toBeDefined();
    expect(screen.getByText(/First summary\./)).toBeDefined();

    // The clicked action's short label is acknowledged; the prompt is not echoed.
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Question sent: Summarize my top 3"),
    );
    const ack = screen.getByRole("status").textContent ?? "";
    expect(ack).toContain("See the latest reply below");
    expect(ack).not.toContain("Retrieve the full finding details");
    expect(ack).not.toContain("Mutant follow-up");
  });

  it("limits a Full summary handoff to the top three displayed findings", async () => {
    const bridge = renderWith({ poll_analysis_status: statusResponse("ready", FULL_PLAN) });
    await screen.findByText(/Analysis ready/i);
    bridge.sendToolResult(boundFullOverview(), { mutant: { mode: "overview" } });
    await screen.findByText("1. Finding 01");

    fireEvent.click(screen.getByRole("button", { name: "Summarize my top 3" }));
    await waitFor(() => expect(bridge.messages).toHaveLength(1));
    const sent = JSON.stringify(bridge.messages[0]);
    for (const id of ["HYP_01", "HYP_02", "HYP_03"]) expect(sent).toContain(id);
    expect(sent).not.toContain("HYP_04");
    expect(sent).not.toContain("HYP_10");
  });

  it("offers an accurate summary label when fewer than three findings are displayed", async () => {
    const bridge = renderWith({ poll_analysis_status: statusResponse("ready") });
    await screen.findByText(/Analysis ready/i);
    const snapshot = boundOverview();
    bridge.sendToolResult(
      makeSuccessResponse(
        {
          ...snapshot.data,
          displayed_hypotheses: [{ id: "HYP_A", rank: 1, name: "Alpha finding" }],
        },
        "analysis_1",
      ),
      { mutant: { mode: "overview" } },
    );
    await screen.findByText(/Alpha finding/i);

    expect(screen.queryByRole("button", { name: "Summarize my top 3" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Summarize my findings" }));
    await waitFor(() => expect(bridge.messages).toHaveLength(1));
    const sent = JSON.stringify(bridge.messages[0]);
    expect(sent).toContain("HYP_A");
    expect(sent).not.toContain("HYP_B");
  });

  it("stops a summary handoff when the displayed analysis is stale", async () => {
    let version = "analysis_1";
    const bridge = renderWith({ poll_analysis_status: () => readyAt(version) });
    await screen.findByText(/Analysis ready/i);
    fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));
    await screen.findByText(/Alpha finding/i);

    version = "analysis_2";
    fireEvent.click(screen.getByRole("button", { name: "Summarize my top 3" }));
    await screen.findByText(/These results have changed/);
    expect(bridge.messages).toHaveLength(0);
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

      fireEvent.click(screen.getAllByRole("button", { name: /explain finding #1/i })[0]!);

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

    fireEvent.click(screen.getAllByRole("button", { name: /explain finding #1/i })[0]!);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't send that follow-up message/i);
    // The prompt is reported as an error, not echoed into the card.
    expect(screen.queryByText(/Explain my "Alpha finding"/)).toBeNull();
    expect(bridge.callsTo("list_health_hypotheses")).toHaveLength(1);
    // A rejected handoff never claims the question was sent.
    expect(screen.queryByText(/Question sent:/)).toBeNull();
  });

  it("prefixes the server-authored heading on a chip handoff", async () => {
    const bridge = renderWith({
      poll_analysis_status: statusResponse("ready"),
      get_analysis_context: makeSuccessResponse(
        makeContextData({
          suggested_prompts: [
            {
              id: "explain-first",
              label: "Explain #1",
              prompt: "Explain my #1 finding in plain English.",
              heading: "Mutant follow-up: Explain finding #1",
              intent: "explain",
              action: { analysis_version: "analysis_1", intent: "explain" },
            },
          ],
        }),
      ),
    });

    await screen.findByText(/Analysis ready/i);
    fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));
    await screen.findByText(/Alpha finding/i);

    fireEvent.click(await screen.findByRole("button", { name: "Explain #1" }));
    await waitFor(() => expect(bridge.messages).toHaveLength(1));

    const sent =
      (bridge.messages[0]?.params as { content?: Array<{ text?: string }> }).content
        ?.map((block) => block.text ?? "")
        .join("") ?? "";
    // The heading instruction precedes the untouched server-selected prompt.
    expect(sent).toContain('Start your reply with this heading on its own line: "Mutant follow-up: Explain finding #1"');
    expect(sent).toContain("Explain my #1 finding in plain English.");
    expect(sent.indexOf("Mutant follow-up:")).toBeLessThan(
      sent.indexOf("Explain my #1 finding in plain English."),
    );
  });

  it("disables the clicked action and shows Sending while the handoff is in flight", async () => {
    let resolveSend: () => void = () => undefined;
    const sendFollowUpMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    Object.defineProperty(window, "openai", {
      value: { sendFollowUpMessage },
      configurable: true,
      writable: true,
    });
    try {
      renderWith({ poll_analysis_status: statusResponse("ready") });

      await screen.findByText(/Analysis ready/i);
      fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));
      await screen.findByText(/Alpha finding/i);

      const button = screen.getByRole("button", { name: "Summarize my top 3" });
      fireEvent.click(button);

      await waitFor(() => expect(button.textContent).toBe("Sending…"));
      expect((button as HTMLButtonElement).disabled).toBe(true);

      resolveSend();
      await waitFor(() => expect(button.textContent).toBe("Summarize my top 3"));
    } finally {
      delete (window as unknown as { openai?: unknown }).openai;
    }
  });

  it("stops a stale card click and offers the current findings", async () => {
    let version = "analysis_1";
    const bridge = renderWith({
      poll_analysis_status: () =>
        makeSuccessResponse(
          statusResponse("ready").data as Record<string, unknown>,
          version,
        ),
    });

    await screen.findByText(/Analysis ready/i);
    fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));
    await screen.findByText(/Alpha finding/i);

    // The analysis advanced after this card was rendered.
    version = "analysis_2";
    fireEvent.click(screen.getAllByRole("button", { name: /explain finding #1/i })[0]!);

    await screen.findByText(/These results have changed/);
    // The old action never reached the host.
    expect(bridge.messages).toHaveLength(0);
    expect(version).toBe("analysis_2");

    // The recovery action hands off the current-findings prompt instead.
    fireEvent.click(screen.getByRole("button", { name: /open your current findings/i }));
    await waitFor(() => expect(bridge.messages).toHaveLength(1));
    expect(JSON.stringify(bridge.messages[0])).toContain("Show my current Mutant findings.");
  });

  it("persists only the sent action id and label through widget state", async () => {
    const sendFollowUpMessage = vi.fn().mockResolvedValue(undefined);
    const setWidgetState = vi.fn();
    Object.defineProperty(window, "openai", {
      value: { sendFollowUpMessage, setWidgetState, widgetState: {} },
      configurable: true,
      writable: true,
    });
    try {
      renderWith({ poll_analysis_status: statusResponse("ready") });

      await screen.findByText(/Analysis ready/i);
      fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));
      await screen.findByText(/Alpha finding/i);

      fireEvent.click(screen.getAllByRole("button", { name: /explain finding #1/i })[0]!);

      await waitFor(() => expect(setWidgetState).toHaveBeenCalled());
      const state = setWidgetState.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(state.mutantSentAction).toEqual({
        id: "explain-finding-1",
        label: "Explain finding #1",
      });
      // No prompt or health history is persisted.
      expect(JSON.stringify(state)).not.toContain("Retrieve the full finding details");
      expect(JSON.stringify(state)).not.toContain("Alpha finding");
    } finally {
      delete (window as unknown as { openai?: unknown }).openai;
    }
  });

  it("restores the sent acknowledgment from host widget state", async () => {
    Object.defineProperty(window, "openai", {
      value: {
        widgetState: {
          mutantSentAction: { id: "ask-results", label: "Ask about my results" },
        },
      },
      configurable: true,
      writable: true,
    });
    try {
      renderWith({ poll_analysis_status: statusResponse("ready") });

      await screen.findByText(/Analysis ready/i);
      const status = await screen.findByRole("status");
      expect(status.textContent).toContain("Question sent: Ask about my results");
    } finally {
      delete (window as unknown as { openai?: unknown }).openai;
    }
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

  function consentError(): ToolResponse {
    return makeErrorResponse("CONSENT_REQUIRED", "Consent is required.", {
      app_code: "consent_required",
    });
  }

  /** The widget `_meta` the server attaches to a CONSENT_REQUIRED result. */
  function consentMeta(purpose: string): Record<string, unknown> {
    return {
      mutant: {
        consent: {
          url: "https://mutantgenomics.com/consent",
          purpose,
          client_id: "connector-1",
        },
      },
    };
  }

  it("routes an import refused for consent to the portal consent page", async () => {
    const bridge = await renderApp({ create_report: consentError() }, {}, {
      toolMeta: { create_report: consentMeta("genetic_processing") },
    });

    selectFile(microarrayFile());
    await screen.findByText(/Ready to submit/i);
    fireEvent.click(screen.getByRole("button", { name: /create my mutant analysis/i }));

    // The consent card replaces the review screen: the connection is valid, so it
    // must not ask the user to reconnect, and it names the import purpose.
    await screen.findByText(/Before Mutant can import your DNA data/i);
    expect(screen.queryByText(/Ready to submit/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Review privacy choices/i }));
    await waitFor(() => expect(bridge.openLinks).toHaveLength(1));
    // Only the consent route, the purpose, and the public client id travel.
    expect(bridge.openLinks[0]).toContain("https://mutantgenomics.com/consent");
    expect(bridge.openLinks[0]).toContain("purpose=genetic_processing");
    expect(bridge.openLinks[0]).toContain("client_id=connector-1");
  });

  it("re-runs the import only once when the user retries after accepting", async () => {
    const bridge = await renderApp(
      {
        create_report: (_args, call) =>
          call === 1
            ? consentError()
            : makeSuccessResponse({ analysis_id: "analysis_1", status: "processing" }),
      },
      {},
      { toolMeta: { create_report: consentMeta("genetic_processing") } },
    );

    selectFile(microarrayFile());
    await screen.findByText(/Ready to submit/i);
    fireEvent.click(screen.getByRole("button", { name: /create my mutant analysis/i }));
    await screen.findByRole("button", { name: /Review privacy choices/i });

    const retry = screen.getByRole("button", { name: /I've accepted/i });
    fireEvent.click(retry);
    fireEvent.click(retry);

    await screen.findByText(PROCESSING_HEADING);
    // One submit before the refusal, one retry after acceptance. The second click
    // lands on the already-replaced card and cannot submit again.
    expect(bridge.callsTo("create_report")).toHaveLength(2);
  });

  it("surfaces consent when sharing findings is refused for an existing account", async () => {
    // A ready account opens directly on the completion card, not the file picker.
    renderWith(
      {
        poll_analysis_status: statusResponse("ready"),
        list_health_hypotheses: consentError(),
      },
      {},
      { toolMeta: { list_health_hypotheses: consentMeta("chatgpt_sharing") } },
    );

    await screen.findByText(/^Analysis ready$/);
    fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));

    // The analysis-ready context is preserved: the card keeps the outcome and
    // adds the privacy review state instead of looking like a fresh import.
    await screen.findByText(/^Privacy review required$/);
    await screen.findByText(/^Your DNA analysis is complete\.$/);
    // The read purpose, not importing DNA: sharing findings needs its own notice.
    await screen.findByText(/Before Mutant can share your findings here/i);
    // Consent is not an outage: no generic error copy, and no import CTA.
    expect(screen.queryByText(/Something went wrong/i)).toBeNull();
    expect(screen.queryByText(/temporarily unavailable/i)).toBeNull();
    expect(screen.queryByText(/Ready to submit/i)).toBeNull();
  });

  it("resumes the exact blocked findings read once after consent", async () => {
    const bridge = renderWith(
      {
        poll_analysis_status: statusResponse("ready"),
        get_analysis_context: chipContext(),
        list_health_hypotheses: (_args, call) => (call === 1 ? consentError() : FINDINGS),
      },
      {},
      { toolMeta: { list_health_hypotheses: consentMeta("chatgpt_sharing") } },
    );

    await screen.findByText(/^Analysis ready$/);
    fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));
    await screen.findByRole("button", { name: /Review privacy choices/i });
    const beforeResume = bridge.callsTo("list_health_hypotheses").length;

    fireEvent.click(screen.getByRole("button", { name: /I've accepted/i }));

    // The original read (same arguments), not a fixed guess, resumes and renders.
    await screen.findByText(/Alpha finding/i);
    await waitFor(() =>
      expect(bridge.callsTo("list_health_hypotheses").length).toBe(beforeResume + 1),
    );
    expect(bridge.callsTo("list_health_hypotheses").at(-1)?.arguments).toEqual({
      limit: 3,
      analysis_version: "analysis_1",
    });
  });

  it("reports a consent-sync failure and stops when the resume is refused again", async () => {
    const bridge = renderWith(
      {
        poll_analysis_status: statusResponse("ready"),
        get_analysis_context: chipContext(),
        list_health_hypotheses: consentError(),
      },
      {},
      { toolMeta: { list_health_hypotheses: consentMeta("chatgpt_sharing") } },
    );

    await screen.findByText(/^Analysis ready$/);
    fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));
    await screen.findByRole("button", { name: /Review privacy choices/i });
    const beforeResume = bridge.callsTo("list_health_hypotheses").length;

    fireEvent.click(screen.getByRole("button", { name: /I've accepted/i }));

    // The card stays up with an explicit sync message: exactly one resume
    // attempt, then it stops (no loop).
    await screen.findByText(/Mutant still can't confirm it/i);
    expect(bridge.callsTo("list_health_hypotheses").length).toBe(beforeResume + 1);
    const retry = screen.getByRole("button", { name: /I've accepted/i }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
  });

  it("opens the privacy choices directly when mounted with view=consent", async () => {
    const bridge = await renderApp({}, {}, {});
    await screen.findByText(/Drag and drop your DNA file here/i);

    bridge.sendToolResult(makeSuccessResponse({ ui_rendered: true, mode: "initial", view: "consent" }), {
      mutant: {
        view: "consent",
        consent: { url: "https://mutantgenomics.com/consent", purpose: "chatgpt_sharing" },
      },
    });

    // Recovery opens on consent, never the upload UI.
    await screen.findByText(/Before Mutant can share your findings here/i);
    await screen.findByRole("button", { name: /Review privacy choices/i });
    expect(screen.queryByText(/Drag and drop your DNA file here/i)).toBeNull();
  });

  it("emits bounded consent telemetry with no sensitive payload", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      renderWith(
        {
          poll_analysis_status: statusResponse("ready"),
          get_analysis_context: chipContext(),
          list_health_hypotheses: consentError(),
        },
        {},
        { toolMeta: { list_health_hypotheses: consentMeta("chatgpt_sharing") } },
      );

      await screen.findByText(/^Analysis ready$/);
      fireEvent.click(screen.getByRole("button", { name: /view my top 3 findings/i }));
      await screen.findByRole("button", { name: /Review privacy choices/i });
      fireEvent.click(screen.getByRole("button", { name: /Review privacy choices/i }));

      await waitFor(() =>
        expect(
          debug.mock.calls.some((call) => String(call[0]).includes("consent_recovery_opened")),
        ).toBe(true),
      );
      const consentLogs = debug.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("consent "));
      expect(consentLogs.some((line) => line.includes("consent_required_encountered"))).toBe(true);
      const joined = consentLogs.join("\n");
      expect(joined).not.toMatch(/rs\d{3,}/);
      expect(joined).not.toMatch(/Alpha finding|Beta finding|Gamma finding/);
    } finally {
      debug.mockRestore();
    }
  });

  it("shows a retryable deletion state when an import is refused mid-deletion", async () => {
    const bridge = await renderApp({
      create_report: makeErrorResponse("DELETION_IN_PROGRESS", "Deletion in progress.", {
        app_code: "deletion_in_progress",
        retryable: true,
      }),
    });

    selectFile(microarrayFile());
    await screen.findByText(/Ready to submit/i);
    fireEvent.click(screen.getByRole("button", { name: /create my mutant analysis/i }));

    await screen.findByText(/^Deletion in progress$/);
    // Not a connection or consent problem.
    expect(screen.queryByText(/Reconnect Mutant/i)).toBeNull();
    expect(screen.queryByText(/^Consent needed$/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Check again/i }));
    await waitFor(() => expect(screen.queryByText(/^Deletion in progress$/)).toBeNull());
    expect(bridge.callsTo("create_report")).toHaveLength(1);
  });

  it("offers a fresh import once the account data has been deleted", async () => {
    await renderApp({
      create_report: makeErrorResponse("DATA_DELETED", "Data deleted.", {
        app_code: "data_deleted",
        retryable: false,
      }),
    });

    selectFile(microarrayFile());
    await screen.findByText(/Ready to submit/i);
    fireEvent.click(screen.getByRole("button", { name: /create my mutant analysis/i }));

    await screen.findByText(/^Data deleted$/);
    expect(screen.queryByText(/Reconnect Mutant/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Import DNA$/i }));
    await waitFor(() => expect(screen.queryByText(/^Data deleted$/)).toBeNull());
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

  it("expands the top-three comparison in the clicked card without a chat turn", async () => {
    const bridge = await renderCompareOverview();
    await waitForComparisonPrefetch(bridge);

    fireEvent.click(screen.getByRole("button", { name: "Compare top 3" }));

    const panel = await screen.findByRole("region", {
      name: "Comparing your top three findings",
    });
    const rows = within(panel).getAllByRole("listitem").map((row) => row.textContent ?? "");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("1. Alpha finding");
    expect(rows[1]).toContain("2. Beta finding");
    expect(rows[2]).toContain("3. Gamma finding");
    // Each row carries the server-provided summary and support score.
    expect(rows[0]).toContain("First summary.");
    expect(rows[0]).toContain("Genetic support: 72 (strong)");
    expect(within(panel).getByText(/not diagnoses or probabilities/i)).toBeDefined();

    // The chip click reused the prefetched read and never opened a chat turn.
    expect(bridge.callsTo("list_health_hypotheses")).toHaveLength(1);
    expect(bridge.callsTo("list_health_hypotheses")[0]?.arguments).toEqual({
      limit: 3,
      analysis_version: "analysis_1",
    });
    expect(bridge.messages).toHaveLength(0);
  });

  it("shows a loading state in the clicked card while the comparison read is in flight", async () => {
    // The comparison prefetch is held, so the card keeps that read in flight.
    const bridge = await renderCompareOverview({}, { deferToolNames: ["list_health_hypotheses"] });
    await waitForComparisonPrefetch(bridge);

    fireEvent.click(screen.getByRole("button", { name: "Compare top 3" }));
    const panel = await screen.findByRole("region", {
      name: "Comparing your top three findings",
    });
    expect(within(panel).getByText("Loading comparison…")).toBeDefined();
    expect(bridge.messages).toHaveLength(0);

    bridge.releaseDeferred();
    expect(await within(panel).findByText("First summary.")).toBeDefined();
  });

  it("prefers the cached comparison and never reads twice for one revision", async () => {
    const bridge = await renderCompareOverview();
    await waitForComparisonPrefetch(bridge);

    const chip = screen.getByRole("button", { name: "Compare top 3" });
    fireEvent.click(chip);
    fireEvent.click(chip);
    fireEvent.click(chip);

    const panel = await screen.findByRole("region", {
      name: "Comparing your top three findings",
    });
    expect(await within(panel).findByText("First summary.")).toBeDefined();
    // Rapid clicks and the prefetch share exactly one comparison read.
    expect(bridge.callsTo("list_health_hypotheses")).toHaveLength(1);
    expect(bridge.messages).toHaveLength(0);
  });

  it("recovers with the stale notice when the comparison revision changed", async () => {
    const bridge = await renderCompareOverview({
      list_health_hypotheses: makeErrorResponse(
        "ANALYSIS_VERSION_CHANGED",
        "The analysis changed since that revision.",
      ),
    });

    await screen.findByText(/These results have changed/i);

    fireEvent.click(screen.getByRole("button", { name: "Compare top 3" }));
    await waitFor(() => expect(bridge.callsTo("list_health_hypotheses")).toHaveLength(2));
    // No panel is rendered: the card shows the recovery notice instead of a
    // comparison from a different revision.
    expect(screen.queryByRole("region", { name: "Comparing your top three findings" })).toBeNull();
    expect(bridge.messages).toHaveLength(0);
    expect(screen.getByRole("button", { name: /open your current findings/i })).toBeDefined();
  });

  it("refuses a comparison read that does not match the bound top three", async () => {
    const bridge = await renderCompareOverview({
      // Same revision, but a different set of findings than the bound top three.
      list_health_hypotheses: makeSuccessResponse(
        {
          items: [{ id: "HYP_Z", rank: 1, name: "Zeta finding", summary: "Zeta summary." }],
          next_cursor: null,
        },
        "analysis_1",
      ),
    });

    await screen.findByText(/These results have changed/i);

    fireEvent.click(screen.getByRole("button", { name: "Compare top 3" }));
    await waitFor(() => expect(bridge.callsTo("list_health_hypotheses")).toHaveLength(2));
    expect(screen.queryByRole("region", { name: "Comparing your top three findings" })).toBeNull();
    expect(screen.queryByText("Zeta finding")).toBeNull();
    expect(bridge.messages).toHaveLength(0);
  });

  it("offers a retry in the card when the comparison read fails", async () => {
    const bridge = await renderCompareOverview({
      list_health_hypotheses: (_args, call) =>
        call <= 2 ? makeErrorResponse("SERVICE_UNAVAILABLE", "comparison unavailable") : FINDINGS,
    });
    await waitForComparisonPrefetch(bridge);

    fireEvent.click(screen.getByRole("button", { name: "Compare top 3" }));
    const panel = await screen.findByRole("region", {
      name: "Comparing your top three findings",
    });
    expect(await within(panel).findByText(/comparison unavailable/i)).toBeDefined();

    fireEvent.click(within(panel).getByRole("button", { name: /try again/i }));

    expect(await within(panel).findByText("First summary.")).toBeDefined();
    expect(bridge.callsTo("list_health_hypotheses")).toHaveLength(3);
  });

  it("stacks the comparison findings on a narrow viewport", async () => {
    const original = window.innerWidth;
    window.innerWidth = 400;
    try {
      const bridge = await renderCompareOverview();
      await waitForComparisonPrefetch(bridge);

      fireEvent.click(screen.getByRole("button", { name: "Compare top 3" }));
      const panel = await screen.findByRole("region", {
        name: "Comparing your top three findings",
      });
      const list = within(panel).getByRole("list");
      await waitFor(() => expect(list.style.gridTemplateColumns).toBe("minmax(0, 1fr)"));
    } finally {
      window.innerWidth = original;
      window.dispatchEvent(new Event("resize"));
    }
  });

  it("sends the detailed comparison to ChatGPT only from the panel action", async () => {
    const sendFollowUpMessage = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "openai", {
      value: { sendFollowUpMessage },
      configurable: true,
      writable: true,
    });
    try {
      const bridge = await renderCompareOverview();
      await waitForComparisonPrefetch(bridge);

      fireEvent.click(screen.getByRole("button", { name: "Compare top 3" }));
      const panel = await screen.findByRole("region", {
        name: "Comparing your top three findings",
      });
      await within(panel).findByText("First summary.");
      // Opening the panel never sent a chat turn.
      expect(sendFollowUpMessage).not.toHaveBeenCalled();

      fireEvent.click(
        within(panel).getByRole("button", { name: /explore this comparison in chat/i }),
      );

      await waitFor(() => expect(sendFollowUpMessage).toHaveBeenCalledTimes(1));
      expect(sendFollowUpMessage).toHaveBeenCalledWith({
        prompt: expect.stringContaining("## Comparing your top three findings"),
        scrollToBottom: true,
      });
      const sent = sendFollowUpMessage.mock.calls[0]?.[0] as { prompt: string };
      expect(sent.prompt).toContain("Compare my top three findings and explain how they differ.");
      expect(bridge.messages).toHaveLength(0);
      // The card acknowledges the sent action without echoing the prompt.
      expect(screen.getByRole("status").textContent).toContain("Question sent: Compare top 3");
    } finally {
      delete (window as unknown as { openai?: unknown }).openai;
    }
  });
});
