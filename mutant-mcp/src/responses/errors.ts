export const JSONRPC_VERSION = "2.0" as const;

export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  Unauthorized: -32001,
} as const;

export interface JsonRpcErrorPayload {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export function jsonRpcErrorResponse(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorPayload {
  const resolvedId =
    typeof id === "string" || typeof id === "number" ? (id as string | number) : null;
  return {
    jsonrpc: JSONRPC_VERSION,
    id: resolvedId,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

export function authenticationError(id: unknown = null): JsonRpcErrorPayload {
  return jsonRpcErrorResponse(id, JsonRpcErrorCode.Unauthorized, "Authentication required");
}

export function invalidTokenError(id: unknown = null): JsonRpcErrorPayload {
  return jsonRpcErrorResponse(id, JsonRpcErrorCode.Unauthorized, "Invalid or expired token");
}

export function insufficientScopeError(id: unknown = null): JsonRpcErrorPayload {
  return jsonRpcErrorResponse(
    id,
    JsonRpcErrorCode.Unauthorized,
    "Insufficient scope for this resource",
  );
}

/**
 * URL of the RFC 9728 protected-resource metadata document for this resource.
 *
 * RFC 9728 locates the document at the resource's origin, not by suffixing the
 * resource URI: the well-known segment goes *first*, followed by the resource
 * path (`<origin>/.well-known/oauth-protected-resource<resource-path>`). For the
 * resource `https://dev-api.mutantbiotech.com/mcp` that is
 * `https://dev-api.mutantbiotech.com/.well-known/oauth-protected-resource/mcp`.
 *
 * Clients discover this exact URL from the
 * `WWW-Authenticate: Bearer resource_metadata="…"` challenge.
 */
export function protectedResourceMetadataUrl(resourceUri: string): string {
  const url = new URL(resourceUri);
  const resourcePath = url.pathname.replace(/\/+$/, "");
  const wellKnownPath = "/.well-known/oauth-protected-resource";
  return resourcePath && resourcePath !== "/"
    ? `${url.origin}${wellKnownPath}${resourcePath}`
    : `${url.origin}${wellKnownPath}`;
}

export interface WwwAuthenticateOptions {
  resourceMetadataUrl: string;
  error?: "invalid_token" | "insufficient_scope" | "invalid_request";
  errorDescription?: string;
  scope?: string;
}

/**
 * Build a `WWW-Authenticate: Bearer ...` challenge for a protected resource.
 */
export function wwwAuthenticateHeader(options: WwwAuthenticateOptions): string {
  const params: string[] = [`resource_metadata="${options.resourceMetadataUrl}"`];
  if (options.error) {
    params.push(`error="${options.error}"`);
  }
  if (options.errorDescription) {
    params.push(`error_description="${options.errorDescription.replace(/"/g, "'")}"`);
  }
  if (options.scope) {
    params.push(`scope="${options.scope}"`);
  }
  return `Bearer ${params.join(", ")}`;
}

/**
 * Tool-level authentication challenge carried in `_meta["mcp/www_authenticate"]`.
 * The MCP client surfaces this to trigger (re)authorization without a transport
 * level 401.
 */
export function toolAuthChallenge(options: WwwAuthenticateOptions): Record<string, unknown> {
  return {
    "mcp/www_authenticate": [wwwAuthenticateHeader(options)],
  };
}
