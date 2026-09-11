import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { MutantUserContext } from "./auth/user-context.js";
import { authorizationServerMetadata, protectedResourceMetadata } from "./auth/oauth-metadata.js";
import {
  createTokenValidator,
  TokenValidationError,
  type TokenValidator,
} from "./auth/token-validator.js";
import type { MutantBackendClient } from "./clients/mutant-lambda-client.js";
import { corsOrigins, resourceUri, type AppConfig } from "./config.js";
import type { AppLogger } from "./logger.js";
import {
  authenticationError,
  invalidTokenError,
  insufficientScopeError,
  JsonRpcErrorCode,
  jsonRpcErrorResponse,
  protectedResourceMetadataUrl,
  wwwAuthenticateHeader,
} from "./responses/errors.js";
import { createMcpServer } from "./server.js";

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface HttpHandlerOptions {
  validator?: TokenValidator;
  backendClient?: MutantBackendClient;
  oauthFetch?: typeof fetch;
}

function extractBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
}

function applyCors(req: IncomingMessage, res: ServerResponse, config: AppConfig): void {
  const origin = req.headers.origin;
  const allowed = corsOrigins(config);
  if (typeof origin === "string" && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
    res.setHeader("Access-Control-Max-Age", "600");
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return req.url ?? "/";
  }
}

export async function createHttpHandler(
  config: AppConfig,
  logger: AppLogger,
  options: HttpHandlerOptions = {},
): Promise<HttpHandler> {
  const validator: TokenValidator =
    options.validator ??
    (await createTokenValidator({
      devMode: config.MUTANT_DEV_MODE,
      issuer: config.MUTANT_OAUTH_ISSUER,
      audience: config.MUTANT_OAUTH_AUDIENCE,
      clientId: config.MUTANT_OAUTH_CLIENT_ID,
      requiredScope: config.MUTANT_OAUTH_SCOPE,
      resourceUri: resourceUri(config),
    }));

  return (req, res) => {
    void handleRequest(req, res, config, logger, validator, options);
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  logger: AppLogger,
  validator: TokenValidator,
  options: HttpHandlerOptions,
): Promise<void> {
  applyCors(req, res, config);
  const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
  res.setHeader("x-request-id", requestId);
  const path = requestPath(req);
  const requestLogger = logger.child({ requestId, method: req.method, path });

  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    // OAuth discovery surface (RFC 9728 protected-resource metadata + AS metadata).
    if (req.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
      sendJson(res, 200, protectedResourceMetadata(config), {
        "Cache-Control": "public, max-age=300",
      });
      return;
    }
    if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
      sendJson(res, 200, await authorizationServerMetadata(config, options.oauthFetch), {
        "Cache-Control": "public, max-age=300",
      });
      return;
    }

    if (req.method !== "POST") {
      requestLogger.info("rejected unsupported method");
      res.setHeader("Allow", "POST, GET, OPTIONS");
      sendJson(
        res,
        405,
        jsonRpcErrorResponse(null, JsonRpcErrorCode.MethodNotFound, "Method not allowed"),
      );
      return;
    }

    const token = extractBearerToken(req);
    if (!token) {
      requestLogger.warn("request missing bearer token");
      challenge(res, config, "invalid_token", "Authentication required", false);
      sendJson(res, 401, authenticationError());
      return;
    }

    let userContext: MutantUserContext;
    try {
      userContext = await validator.validate(token);
    } catch (error) {
      if (error instanceof TokenValidationError) {
        const status = error.oauthError === "insufficient_scope" ? 403 : 401;
        requestLogger.warn({ oauthError: error.oauthError }, "request token rejected");
        challenge(res, config, error.oauthError, error.message, true);
        sendJson(
          res,
          status,
          error.oauthError === "insufficient_scope"
            ? insufficientScopeError()
            : invalidTokenError(),
        );
        return;
      }
      requestLogger.error({ err: error }, "token validation failed unexpectedly");
      challenge(res, config, "invalid_token", "Invalid or expired token", true);
      sendJson(res, 401, invalidTokenError());
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    const server = createMcpServer(userContext, config, requestId, options.backendClient);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      try {
        await server.close();
      } catch {
        // transport may already be closed after a full JSON response
      }
    }
  } catch (error) {
    requestLogger.error({ err: error }, "unhandled error while processing request");
    if (!res.headersSent) {
      sendJson(
        res,
        500,
        jsonRpcErrorResponse(null, JsonRpcErrorCode.InternalError, "Internal server error"),
      );
    } else {
      res.end();
    }
  }
}

function challenge(
  res: ServerResponse,
  config: AppConfig,
  oauthError: "invalid_token" | "insufficient_scope" | "invalid_request",
  description: string,
  includeScope: boolean,
): void {
  res.setHeader(
    "WWW-Authenticate",
    wwwAuthenticateHeader({
      resourceMetadataUrl: protectedResourceMetadataUrl(resourceUri(config)),
      error: oauthError,
      errorDescription: description,
      ...(includeScope ? { scope: config.MUTANT_OAUTH_SCOPE } : {}),
    }),
  );
}
