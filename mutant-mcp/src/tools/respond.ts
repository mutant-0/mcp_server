import {
  approvedConsentUrl,
  approvedOnboardingUrl,
  requiredScope,
  resourceUri,
} from "../config.js";
import type { ToolName, ToolResponse } from "../contract.js";
import { protectedResourceMetadataUrl, toolAuthChallenge } from "../responses/errors.js";
import { toolResultFromResponse, type ToolResultOptions } from "../responses/tool-result.js";
import type { ToolRuntime } from "./types.js";

/** `create_report` collects and stores DNA; every other gated read shares findings. */
const CONSENT_PURPOSE_GENETIC_PROCESSING = "genetic_processing";
const CONSENT_PURPOSE_CHATGPT_SHARING = "chatgpt_sharing";

function consentPurposeFor(operation?: ToolName): string {
  return operation === "create_report"
    ? CONSENT_PURPOSE_GENETIC_PROCESSING
    : CONSENT_PURPOSE_CHATGPT_SHARING;
}

/**
 * Widget-only descriptor attached to a `CONSENT_REQUIRED` result so the DNA
 * import component can send the user to the portal consent route for exactly the
 * purpose that was denied, keyed to the connector client id the backend enforces
 * against. Carries no genetic data: a URL, a purpose, and a public client id.
 */
function consentMeta(
  runtime: ToolRuntime,
  operation?: ToolName,
): Record<string, unknown> | undefined {
  const url = approvedConsentUrl(runtime.config);
  if (!url) return undefined;
  const clientId = runtime.config.MUTANT_OAUTH_CLIENT_ID.trim();
  return {
    mutant: {
      consent: {
        url,
        purpose: consentPurposeFor(operation),
        ...(clientId ? { client_id: clientId } : {}),
      },
    },
  };
}

/**
 * Convert a backend envelope into a tool result, adding a tool-level OAuth
 * challenge when the backend reports an authentication/scope problem. This lets
 * the MCP client trigger (re)authorization without a transport-level 401.
 *
 * When the envelope carries `error.required_scope` (per-tool scope enforcement in
 * {@link enforceScope}), that exact scope is advertised so the host asks for the
 * scope that unblocks the call rather than the primary read scope.
 */
export function respond(
  response: ToolResponse,
  runtime: ToolRuntime,
  options: ToolResultOptions = {},
) {
  const code = response.error?.code;
  if (code === "AUTHENTICATION_REQUIRED" || code === "INSUFFICIENT_SCOPE") {
    return toolResultFromResponse(response, {
      ...options,
      challenge: toolAuthChallenge({
        resourceMetadataUrl: protectedResourceMetadataUrl(resourceUri(runtime.config)),
        error: code === "INSUFFICIENT_SCOPE" ? "insufficient_scope" : "invalid_token",
        ...(response.error?.message ? { errorDescription: response.error.message } : {}),
        scope: response.error?.required_scope ?? requiredScope(runtime.config),
      }),
    });
  }
  if (code === "CONSENT_REQUIRED") {
    const consent = consentMeta(runtime, options.operation);
    if (!consent) return toolResultFromResponse(response, options);
    return toolResultFromResponse(response, {
      ...options,
      meta: { ...(options.meta ?? {}), ...consent },
    });
  }
  if (code === "INTEGRATION_REVOKED") {
    // The ChatGPT connection was withdrawn (or the token predates the relink).
    // The recovery is to reconnect from the portal, so the widget gets a safe
    // Mutant URL; no genetic payload is present.
    const url = approvedOnboardingUrl(runtime.config);
    return toolResultFromResponse(response, {
      ...options,
      meta: {
        ...(options.meta ?? {}),
        mutant: {
          ...((options.meta?.mutant as Record<string, unknown> | undefined) ?? {}),
          integration: {
            status: "revoked",
            retryable: response.error?.retryable ?? false,
            ...(url ? { url } : {}),
          },
        },
      },
    });
  }
  if (code === "DELETION_IN_PROGRESS" || code === "DATA_DELETED") {
    // No genetic payload is present; the widget only needs to know whether to
    // wait (deletion in flight) or offer a fresh import (data deleted).
    return toolResultFromResponse(response, {
      ...options,
      meta: {
        ...(options.meta ?? {}),
        mutant: {
          deletion: {
            status: code === "DATA_DELETED" ? "deleted" : "in_progress",
            retryable: response.error?.retryable ?? false,
          },
        },
      },
    });
  }
  return toolResultFromResponse(response, options);
}
