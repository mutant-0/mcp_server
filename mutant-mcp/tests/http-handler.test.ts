import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpHandler } from "../src/http-handler.js";
import { createLogger } from "../src/logger.js";
import { makeConfig } from "./helpers.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const handler = await createHttpHandler(makeConfig(), createLogger("silent"));
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("HTTP handler (dev mode)", () => {
  it("rejects requests with no bearer token", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(response.status).toBe(401);
  });

  it("rejects requests with an invalid bearer token", async () => {
    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { Authorization: "Bearer not-a-real-token" },
    );
    expect(response.status).toBe(401);
  });

  it("rejects non-POST methods", async () => {
    const response = await fetch(`${baseUrl}/mcp`, { method: "GET" });
    expect(response.status).toBe(405);
  });

  it("handles MCP initialize with a valid dev token", async () => {
    const response = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      },
      { Authorization: "Bearer dev-free", Accept: "application/json, text/event-stream" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { serverInfo: { name: string } };
    };
    expect(body.result.serverInfo.name).toBe("mutant-mcp");
  });

  it("lists tools over HTTP with a valid dev token", async () => {
    const response = await post(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { Authorization: "Bearer dev-free", Accept: "application/json, text/event-stream" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools).toHaveLength(7);
  });
});
