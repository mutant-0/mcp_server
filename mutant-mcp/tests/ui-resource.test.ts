import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server.js";
import { DNA_IMPORT_UI_URI } from "../src/ui/dna-import/resource.js";
import { makeConfig, makeUser, StubBackendClient } from "./helpers.js";

/** Mime type the MCP Apps spec requires for an app resource document. */
const APP_MIME_TYPE = "text/html;profile=mcp-app";

async function connect() {
  const server = createMcpServer(
    makeUser(),
    makeConfig(),
    "req-ui",
    new StubBackendClient(() => {
      throw new Error("the UI resource must not call the backend");
    }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("DNA import UI resource", () => {
  it("is listed with the app mime type", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    const resource = resources.find((entry) => entry.uri === DNA_IMPORT_UI_URI);
    expect(resource).toBeDefined();
    expect(resource?.mimeType).toBe(APP_MIME_TYPE);
  });

  it("reads back a self-contained HTML document", async () => {
    const client = await connect();
    const { contents } = await client.readResource({ uri: DNA_IMPORT_UI_URI });
    expect(contents).toHaveLength(1);

    const content = contents[0] as { mimeType?: string; text?: string };
    expect(content.mimeType).toBe(APP_MIME_TYPE);
    expect(content.text).toBeTypeOf("string");

    const html = content.text ?? "";
    expect(html).toContain("<!DOCTYPE html>");
    // The host bridge is the component's only transport.
    expect(html).toContain("ui/initialize");
    expect(html).toContain("tools/call");
    expect(html).toContain("postMessage");
  });

  it("inlines the parser worker and starts it from an object URL", async () => {
    const client = await connect();
    const { contents } = await client.readResource({ uri: DNA_IMPORT_UI_URI });
    const html = (contents[0] as { text?: string }).text ?? "";

    // The worker is bundled into the same document: an app resource is served
    // inline, so it has no origin to fetch a sibling script from.
    expect(html).toContain("createObjectURL");
    expect(html).toContain("revokeObjectURL");
    // A marker only the worker bundle carries, so this fails if the two esbuild
    // passes ever stop being wired together.
    expect(html).toContain("No file received by the DNA parser worker.");
    // The worker's own startup handshake is what the component waits for.
    expect(html).toContain("worker never completed its startup handshake");
  });

  it("serves a full-width, single-column document under a stable URI", async () => {
    // The pointer must not move. ChatGPT keys its stored widget snapshot by this
    // URI, so a version bump makes the app fail with "Failed to fetch template"
    // instead of refreshing anything. Layout changes ship under this same URI.
    expect(DNA_IMPORT_UI_URI).toBe("ui://mutant/dna-import/v1.html");

    const client = await connect();
    const { contents } = await client.readResource({ uri: DNA_IMPORT_UI_URI });
    const html = (contents[0] as { text?: string }).text ?? "";

    // The whole mount chain fills the host card, and the boxes that used to sit
    // in a reserved right-hand column are full width with no fixed ceiling.
    expect(html).toContain("box-sizing: border-box");
    // `!important` keeps a host-injected shell stylesheet from re-capping the chain.
    expect(html).toContain("width: 100% !important");
    expect(html).toContain("max-width: none !important");
    expect(html).toContain("#root > *");
    expect(html).toContain('maxWidth:"none"');
    // One full-width track; a two-track template would reserve an empty column.
    expect(html).toContain("minmax(0, 1fr)");
    expect(html).not.toContain("grid-template-columns: 3fr 1fr");
    // The old bounded width is gone.
    expect(html).not.toContain("maxWidth:520");
  });

  it("declares no CSP domains, because the component only uses the host bridge", async () => {
    const client = await connect();
    const { contents } = await client.readResource({ uri: DNA_IMPORT_UI_URI });
    const meta = (contents[0] as { _meta?: { ui?: { csp?: Record<string, unknown> } } })._meta;
    expect(meta?.ui?.csp).toEqual({});
  });

  it("carries no portal auth, storage, or direct network access", async () => {
    const client = await connect();
    const { contents } = await client.readResource({ uri: DNA_IMPORT_UI_URI });
    const html = (contents[0] as { text?: string }).text ?? "";

    // The portal component this was ported from depended on all of these; the
    // Apps SDK component must be free of them so it can run in a sandboxed
    // iframe with an empty CSP.
    for (const forbidden of [
      "localStorage",
      "sessionStorage",
      "document.cookie",
      "Authorization",
      "Bearer",
      "dev-api.mutantbiotech",
      "XMLHttpRequest",
      "fetch(",
    ]) {
      expect(html, `component must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("never reaches the backend to render the document", async () => {
    // The stub client throws on any invoke; a successful read proves the
    // resource is static and identical for every authenticated account.
    const client = await connect();
    const { contents } = await client.readResource({ uri: DNA_IMPORT_UI_URI });
    expect(contents).toHaveLength(1);
  });
});
