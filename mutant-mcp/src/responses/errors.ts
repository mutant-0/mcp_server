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
