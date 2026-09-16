import { scopeFor } from "../config.js";
import { APP_ERROR_CODES, CONTRACT_VERSION, ErrorCode, type ToolResponse } from "../contract.js";
import type { MutantToolDefinition, ToolRuntime } from "./types.js";

/** A tool must know its name and declared scope for the guard to check it. */
export type ScopedTool = Pick<MutantToolDefinition, "name" | "scope">;

/**
 * Enforce a tool's declared OAuth scope before the backend is invoked.
 *
 * The transport level accepts a token carrying *any* supported scope, because a
 * single connection serves both the analysis tools and the DNA import flow.
 * Authorization is therefore per tool: a token with only `analysis.read` gets a
 * structured `INSUFFICIENT_SCOPE` error (carrying `required_scope`) from the DNA
 * import tools, which `respond` converts into a tool-level `mcp/www_authenticate`
 * challenge so the host can drive re-consent without a transport-level 401.
 *
 * Returns `null` when the caller is authorized and should proceed.
 */
export function enforceScope(tool: ScopedTool, runtime: ToolRuntime): ToolResponse | null {
  const required = scopeFor(runtime.config, tool.scope);
  if (required && runtime.user.scopes.includes(required)) {
    return null;
  }

  const needsDnaImport = tool.scope === "dna.import";
  return {
    contract_version: CONTRACT_VERSION,
    analysis_version: null,
    ok: false,
    data: null,
    error: {
      code: ErrorCode.INSUFFICIENT_SCOPE,
      message: needsDnaImport
        ? `Importing DNA requires the '${required}' scope. Reconnect Mutant in ChatGPT to grant DNA import access.`
        : `This tool requires the '${required}' scope.`,
      retryable: false,
      next_action: "reauthorize",
      required_scope: required,
      app_code: APP_ERROR_CODES.insufficient_scope,
    },
  };
}
