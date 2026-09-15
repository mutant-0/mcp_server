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
import { corsOrigins, requiredScope, resourceUri, type AppConfig } from "./config.js";
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

const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

/**
 * Match a well-known route in any of the shapes the deployment produces:
 *
 * - host root: `/.well-known/oauth-authorization-server` (the RFC 8414 form,
 *   reachable because the custom domain maps the `.well-known` prefix here);
 * - behind a mount prefix: `/mcp/.well-known/oauth-authorization-server` (what a
 *   local dev server and the API mapping key form see);
 * - mapping-key stripped: `/oauth-authorization-server` (API Gateway removes the
 *   mapped `.well-known` prefix before invoking the Lambda).
 *
 * An optional resource-path suffix is also accepted, e.g.
 * `/.well-known/oauth-protected-resource/mcp` (RFC 9728 canonical form).
 */
function matchesWellKnown(path: string, wellKnownPath: string): boolean {
  // The same document served without its `.well-known` segment, which is what
  // arrives when the domain maps `.well-known` directly to this API.
  const stripped = wellKnownPath.replace(/^\/\.well-known/, "");
  for (const candidate of [wellKnownPath, stripped]) {
    const index = path.indexOf(candidate);
    if (index < 0) continue;
    const end = index + candidate.length;
    if (end === path.length || path[end] === "/") return true;
  }
  return false;
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
      requiredScope: requiredScope(config),
      // Use the raw value (not the metadata fallback) so an unset variable does
      // not reject valid tokens against the localhost placeholder.
      resourceUri: config.MUTANT_MCP_RESOURCE_URI,
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
    if (req.method === "GET" && matchesWellKnown(path, PROTECTED_RESOURCE_METADATA_PATH)) {
      sendJson(res, 200, protectedResourceMetadata(config), {
        "Cache-Control": "no-store, max-age=0",
      });
      return;
    }
    if (req.method === "GET" && matchesWellKnown(path, AUTHORIZATION_SERVER_METADATA_PATH)) {
      sendJson(res, 200, await authorizationServerMetadata(config, options.oauthFetch), {
        "Cache-Control": "no-store, max-age=0",
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
      challenge(res, config, "invalid_token", "Authentication required");
      sendJson(res, 401, authenticationError());
      return;
    }

    let userContext: MutantUserContext;
    try {
      userContext = await validator.validate(token);
    } catch (error) {
      if (error instanceof TokenValidationError) {
        const status = error.oauthError === "insufficient_scope" ? 403 : 401;
        requestLogger.warn(
          {
            oauthError: error.oauthError,
            reason: error.reason,
            description: error.message,
          },
          "request token rejected",
        );
        challenge(res, config, error.oauthError, error.message);
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
      challenge(res, config, "invalid_token", "Invalid or expired token");
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
): void {
  res.setHeader(
    "WWW-Authenticate",
    wwwAuthenticateHeader({
      resourceMetadataUrl: protectedResourceMetadataUrl(resourceUri(config)),
      error: oauthError,
      errorDescription: description,
      // Always advertise the canonical URI-form scope so a client that has not
      // yet obtained a token knows exactly what to request.
      scope: requiredScope(config),
    }),
  );
}
