import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resetAuthorizationServerCache } from "../src/auth/oauth-metadata.js";
import { createHttpHandler } from "../src/http-handler.js";
import { createLogger } from "../src/logger.js";
import { makeConfig } from "./helpers.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const oauthFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      issuer: "https://auth.mutantgenomics.com",
      authorization_endpoint: "https://auth.mutantgenomics.com/oauth2/authorize",
      token_endpoint: "https://auth.mutantgenomics.com/oauth2/token",
      jwks_uri: "https://auth.mutantgenomics.com/.well-known/jwks.json",
      scopes_supported: ["openid", "https://mcp.mutantgenomics.com/mcp/analysis.read"],
      response_types_supported: ["code", "token"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    }),
  });
  resetAuthorizationServerCache();
  const handler = await createHttpHandler(makeConfig(), createLogger("silent"), {
    oauthFetch: oauthFetch as unknown as typeof fetch,
  });
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
  it("rejects requests with no bearer token and advertises the challenge", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain("resource_metadata=");
    expect(challenge).toContain("error=\"invalid_token\"");
    // RFC 9728 places the well-known segment before the resource path, at the
    // resource origin: <origin>/.well-known/oauth-protected-resource<path>.
    expect(challenge).toContain(
      "resource_metadata=\"https://mcp.mutantgenomics.com/.well-known/oauth-protected-resource/mcp\"",
    );
    // The canonical URI-form scope is advertised so a client knows what to request.
    expect(challenge).toContain("scope=\"https://mcp.mutantgenomics.com/mcp/analysis.read\"");
  });

  it("rejects requests with an invalid bearer token", async () => {
    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { Authorization: "Bearer not-a-real-token" },
    );
    expect(response.status).toBe(401);
  });

  it("rejects unsupported GET on the MCP endpoint", async () => {
    const response = await fetch(`${baseUrl}/mcp`, { method: "GET" });
    expect(response.status).toBe(405);
  });

  it("serves protected-resource metadata", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
      bearer_methods_supported: string[];
      resource_name: string;
      resource_documentation: string;
    };
    expect(body.resource).toBe("https://mcp.mutantgenomics.com/mcp");
    // Points at the origin serving the RFC 8414 document (this host), not Cognito:
    // Cognito's custom domain 404s /.well-known/oauth-authorization-server.
    expect(body.authorization_servers).toEqual(["https://mcp.mutantgenomics.com"]);
    // The scope mirrors the Cognito resource-server identifier (the resource URI).
    expect(body.scopes_supported).toEqual(["https://mcp.mutantgenomics.com/mcp/analysis.read"]);
    expect(body.bearer_methods_supported).toContain("header");
    expect(body.resource_name).toBe("Mutant Genomics Analysis");
    expect(body.resource_documentation).toBe("https://mutantgenomics.com/mcp");
  });

  it("serves protected-resource metadata on the resource path variant", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
  });

  it("serves protected-resource metadata behind a mount prefix", async () => {
    const response = await fetch(`${baseUrl}/mcp/.well-known/oauth-protected-resource`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resource: string };
    expect(body.resource).toBe("https://mcp.mutantgenomics.com/mcp");
  });

  it("serves authorization-server metadata behind a mount prefix", async () => {
    const response = await fetch(`${baseUrl}/mcp/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
  });

  it("serves authorization-server metadata with PKCE S256", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      code_challenge_methods_supported: string[];
      grant_types_supported: string[];
      authorization_endpoint: string;
    };
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toContain("authorization_code");
    expect(body.authorization_endpoint).toContain("/oauth2/authorize");
  });

  it("serves authorization-server metadata on the mapping-key-stripped root path", async () => {
    // The custom domain maps `.well-known` to this API, so API Gateway strips the
    // prefix and the Lambda receives `/oauth-authorization-server`.
    const response = await fetch(`${baseUrl}/oauth-authorization-server`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      issuer: string;
      scopes_supported: string[];
      response_types_supported: string[];
      grant_types_supported: string[];
      code_challenge_methods_supported: string[];
      authorization_endpoint: string;
      token_endpoint: string;
    };
    // The document is served from the MCP host, so that host is the issuer even
    // though the endpoints live on the Cognito custom domain.
    expect(body.issuer).toBe("https://mcp.mutantgenomics.com");
    expect(body.scopes_supported).toEqual(["https://mcp.mutantgenomics.com/mcp/analysis.read"]);
    expect(body.response_types_supported).toEqual(["code"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.authorization_endpoint).toBe("https://auth.mutantgenomics.com/oauth2/authorize");
    expect(body.token_endpoint).toBe("https://auth.mutantgenomics.com/oauth2/token");
  });

  it("serves protected-resource metadata on the mapping-key-stripped root path", async () => {
    const response = await fetch(`${baseUrl}/oauth-protected-resource`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resource: string };
    expect(body.resource).toBe("https://mcp.mutantgenomics.com/mcp");
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
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe("mutant-mcp");
  });

  it("lists six tools over HTTP with a valid dev token", async () => {
    const response = await post(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { Authorization: "Bearer dev-free", Accept: "application/json, text/event-stream" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools).toHaveLength(6);
  });

  it("answers CORS preflight for an allowed origin", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "OPTIONS",
      headers: { Origin: "https://chatgpt.com" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://chatgpt.com");
  });
});
