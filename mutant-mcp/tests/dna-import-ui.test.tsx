// @vitest-environment jsdom
/**
 * Component tests for the DNA import Apps SDK app.
 *
 * The component talks to the server exclusively through the host bridge, so these
 * tests stand up a fake host on the same `window` the app posts to: it answers
 * `ui/initialize`, records every `tools/call`, and can push a tool result the way
 * a host does when `show_dna_import` returns. That keeps the whole component
 * state machine - catalog load, parse, review, submit, and every error branch -
 * under test without a browser or a real host.
 */
import "./setup-ui";

import {
  LATEST_PROTOCOL_VERSION,
  McpUiInitializeResultSchema,
  McpUiToolResultNotificationSchema,
} from "@modelcontextprotocol/ext-apps";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DnaImportApp } from "../src/ui/dna-import/app";
import { makeErrorResponse, makeSuccessResponse } from "./helpers.js";

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
function toolResultNotification(structured: ReturnType<typeof makeSuccessResponse>) {
  return {
    method: "ui/notifications/tool-result",
    params: {
      content: [{ type: "text", text: JSON.stringify(structured) }],
      structuredContent: structured as unknown as Record<string, unknown>,
      isError: false,
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

type ToolResponder = (
  name: string,
  args: Record<string, unknown>,
) => ReturnType<typeof makeSuccessResponse>;

interface HostBridge {
  toolCalls: ToolCall[];
  modelContextUpdates: unknown[];
  callsTo(name: string): ToolCall[];
  sendToolResult(structured: ReturnType<typeof makeSuccessResponse>): void;
  /** Detach the listener, so a finished test cannot answer the next one's calls. */
  stop(): void;
}

let activeBridge: HostBridge | null = null;

/** Stand up a fake host on `window` and answer bridge requests from it. */
function installHostBridge(respond: ToolResponder): HostBridge {
  const toolCalls: ToolCall[] = [];
  const modelContextUpdates: unknown[] = [];

  function reply(id: number, result: unknown): void {
    deliverToApp({ jsonrpc: "2.0", id, result });
  }

  function onMessage(event: MessageEvent): void {
    const message = event.data as {
      jsonrpc?: string;
      id?: number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
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
      const envelope = respond(name, args);
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
    // Anything else (open-link, size-changed is a notification, ...) is
    // acknowledged so the app never hangs on an unanswered request.
    reply(message.id, {});
  }

  window.addEventListener("message", onMessage);

  const bridge: HostBridge = {
    toolCalls,
    modelContextUpdates,
    callsTo: (name) => toolCalls.filter((call) => call.name === name),
    sendToolResult: (structured) => {
      deliverToApp({ jsonrpc: "2.0", ...toolResultNotification(structured) });
    },
    stop: () => window.removeEventListener("message", onMessage),
  };
  activeBridge = bridge;
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

/** Render the app and wait until the catalog has loaded and it is interactive. */
async function renderApp(respond: ToolResponder): Promise<HostBridge> {
  const bridge = installHostBridge(respond);
  render(<DnaImportApp />);
  await screen.findByText(/Drag and drop your DNA file here/i);
  return bridge;
}

/** Render, select a file, and wait for the review screen. */
async function renderToReview(
  respond: ToolResponder,
  file = microarrayFile(),
): Promise<HostBridge> {
  const bridge = await renderApp(respond);
  selectFile(file);
  await screen.findByText(/Ready to submit/i);
  return bridge;
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

  it("loads the catalog over the bridge and offers the file picker", async () => {
    const bridge = await renderApp(() => CATALOG);

    expect(bridge.callsTo("get_snp_catalog")).toHaveLength(1);
    expect(bridge.toolCalls[0]?.arguments).toEqual({});
    expect(screen.getByRole("button", { name: /choose dna file/i })).toBeDefined();
    // The marker count comes from the catalog, so it proves the catalog was used.
    expect(screen.getByText(/2 markers in the Mutant panel/)).toBeDefined();
  });

  it("shows a retryable catalog error and recovers on retry", async () => {
    let failing = true;
    const bridge = installHostBridge((name) =>
      name !== "get_snp_catalog" || !failing
        ? CATALOG
        : makeErrorResponse("CATALOG_UNAVAILABLE", "no catalog", {
            app_code: "catalog_unavailable",
          }),
    );
    render(<DnaImportApp />);

    await screen.findByText(/could not prepare the variant catalog/i);

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await screen.findByText(/Drag and drop your DNA file here/i);
    expect(bridge.callsTo("get_snp_catalog")).toHaveLength(2);
  });

  it("opens in the state show_dna_import asked for", async () => {
    const bridge = await renderApp(() => CATALOG);

    bridge.sendToolResult(
      makeSuccessResponse({
        account_status: "unlinked",
        dna_status: "missing",
        status: "awaiting_file",
      }),
    );

    await screen.findByText(/Connect your Mutant account first/i);
    // An unlinked account cannot import, so the dropzone is withheld.
    expect(screen.queryByText(/Drag and drop your DNA file here/i)).toBeNull();
  });

  it("says when DNA data is already on file without blocking a re-import", async () => {
    const bridge = await renderApp(() => CATALOG);

    bridge.sendToolResult(
      makeSuccessResponse({
        account_status: "connected",
        dna_status: "available",
        status: "awaiting_file",
      }),
    );

    await screen.findByText(/DNA data is already on file/i);
    expect(screen.getByText(/Drag and drop your DNA file here/i)).toBeDefined();
  });

  it("ignores a tool result that is not the import routing state", async () => {
    const bridge = await renderApp(() => CATALOG);

    bridge.sendToolResult(makeSuccessResponse({ analyses: [] }));

    // Nothing changes: the dropzone is still there and no notice appeared.
    expect(screen.getByText(/Drag and drop your DNA file here/i)).toBeDefined();
    expect(screen.queryByText(/Connect your Mutant account first/i)).toBeNull();
  });

  it("parses locally, reviews the summary, and submits only relevant variants", async () => {
    const bridge = await renderToReview((name) =>
      name === "get_snp_catalog"
        ? CATALOG
        : makeSuccessResponse({ analysis_id: "a-1", status: "queued" }),
    );

    // Local coverage: one of the two markers was found (rs4680 is not in the panel).
    expect(screen.getByText("1 of 2")).toBeDefined();
    expect(screen.queryByText(/Non-SNV capture targets/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /create my mutant analysis/i }));

    await screen.findByText(/DNA data added/i);
    expect(screen.getByText("a-1")).toBeDefined();

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
    // The model is told the analysis exists so it can continue with the analysis
    // tools.
    expect(bridge.modelContextUpdates).toHaveLength(1);
  });

  it("reuses one idempotency key when the same attempt is retried", async () => {
    let attempts = 0;
    const bridge = await renderToReview((name) => {
      if (name === "get_snp_catalog") return CATALOG;
      attempts += 1;
      return attempts === 1
        ? makeErrorResponse("REPORT_GENERATION_FAILED", "boom", {
            app_code: "report_generation_failed",
          })
        : makeSuccessResponse({ analysis_id: "a-2", status: "queued" });
    });

    fireEvent.click(screen.getByRole("button", { name: /create my mutant analysis/i }));
    await screen.findByText(/could not start your analysis/i);

    fireEvent.click(screen.getByRole("button", { name: /create my mutant analysis/i }));
    await screen.findByText(/DNA data added/i);

    const keys = bridge.callsTo("create_report").map((call) => call.arguments.import_request_id);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("asks the user to re-consent when the token lacks the import scope", async () => {
    await renderToReview((name) =>
      name === "get_snp_catalog"
        ? CATALOG
        : // No `app_code`: the component maps the contract code itself.
          makeErrorResponse("INSUFFICIENT_SCOPE", "scope missing", {
            required_scope: "https://mcp.mutantgenomics.com/mcp/dna.import",
          }),
    );

    fireEvent.click(screen.getByRole("button", { name: /create my mutant analysis/i }));

    await screen.findByText(/Reconnect Mutant to grant it/i);
    // The review screen survives so the same file can be resubmitted after the
    // user reconnects.
    expect(screen.getByRole("button", { name: /create my mutant analysis/i })).toBeDefined();
  });

  it("explains a file with no panel variants instead of submitting it", async () => {
    const bridge = await renderApp(() => CATALOG);

    selectFile(
      microarrayFile(["# rsid\tchromosome\tposition\tgenotype", "rs0\t1\t1\tAA", ""].join("\n")),
    );

    await screen.findByText(/contained none of the variants in the Mutant panel/i);
    expect(bridge.callsTo("create_report")).toHaveLength(0);
  });

  it("rejects an oversized file before reading any of it", async () => {
    const bridge = await renderApp(() => CATALOG);

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
      const bridge = await renderApp(() => CATALOG);

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
    const bridge = await renderApp((name) =>
      name === "get_snp_catalog"
        ? makeSuccessResponse({ version: 1, snp_count: markerCount, snps })
        : makeSuccessResponse({ analysis_id: "a-3" }),
    );

    selectFile(microarrayFile(lines.join("\n")));

    await screen.findByText(/too large to submit in one request/i);
    expect(bridge.callsTo("create_report")).toHaveLength(0);
  }, 30_000);

  it("cancels an in-flight parse and returns to the file picker", async () => {
    const bridge = await renderApp(() => CATALOG);

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

  it("offers another import after a successful one", async () => {
    const bridge = await renderToReview((name) =>
      name === "get_snp_catalog" ? CATALOG : makeSuccessResponse({ analysis_id: "a-4" }),
    );

    fireEvent.click(screen.getByRole("button", { name: /create my mutant analysis/i }));
    await screen.findByText(/DNA data added/i);

    fireEvent.click(screen.getByRole("button", { name: /import another file/i }));

    await screen.findByText(/Drag and drop your DNA file here/i);
    expect(bridge.callsTo("create_report")).toHaveLength(1);
  });
});
