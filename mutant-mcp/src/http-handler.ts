import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { MutantUserContext } from "./auth/user-context.js";
import { createTokenValidator, type TokenValidator } from "./auth/token-validator.js";
import type { AppConfig } from "./config.js";
import type { AppLogger } from "./logger.js";
import {
  authenticationError,
  invalidTokenError,
  JsonRpcErrorCode,
  jsonRpcErrorResponse,
} from "./responses/errors.js";
import { createMcpServer } from "./server.js";

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void;

function extractBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
}

function setCommonHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function createHttpHandler(config: AppConfig, logger: AppLogger): Promise<HttpHandler> {
  const validator: TokenValidator = await createTokenValidator({
    devMode: config.MUTANT_DEV_MODE,
    issuer: config.MUTANT_OAUTH_ISSUER,
    audience: config.MUTANT_OAUTH_AUDIENCE,
  });

  return (req, res) => {
    void handleRequest(req, res, config, logger, validator);
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  logger: AppLogger,
  validator: TokenValidator,
): Promise<void> {
  setCommonHeaders(res);
  const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
  res.setHeader("x-request-id", requestId);
  const requestLogger = logger.child({ requestId, method: req.method, path: req.url });

  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    if (req.method !== "POST") {
      requestLogger.info("rejected non-POST request");
      sendJson(res, 405, jsonRpcErrorResponse(null, JsonRpcErrorCode.MethodNotFound, "Method not allowed"));
      return;
    }

    const token = extractBearerToken(req);
    if (!token) {
      requestLogger.warn("request missing bearer token");
      sendJson(res, 401, authenticationError());
      return;
    }

    let userContext: MutantUserContext;
    try {
      userContext = await validator.validate(token);
    } catch (error) {
      requestLogger.warn({ err: error }, "request had an invalid bearer token");
      sendJson(res, 401, invalidTokenError());
      return;
    }

    const server = createMcpServer(userContext, config);
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
      sendJson(res, 500, jsonRpcErrorResponse(null, JsonRpcErrorCode.InternalError, "Internal server error"));
    } else {
      res.end();
    }
  }
}
