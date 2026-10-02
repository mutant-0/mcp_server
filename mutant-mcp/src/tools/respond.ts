import {
  approvedConsentUrl,
  approvedOnboardingUrl,
  requiredScope,
  resourceUri,
} from "../config.js";
import type { ToolName, ToolResponse } from "../contract.js";
import { protectedResourceMetadataUrl, toolAuthChallenge } from "../responses/errors.js";
import { toolResultFromResponse, type ToolResultOptions } from "../responses/tool-result.js";
import { DNA_IMPORT_UI_URI } from "../ui/dna-import/resource.js";
import type { ToolRuntime } from "./types.js";

/** `create_report` collects and stores DNA; every other gated read shares findings. */
const CONSENT_PURPOSE_GENETIC_PROCESSING = "genetic_processing";
const CONSENT_PURPOSE_CHATGPT_SHARING = "chatgpt_sharing";

function consentPurposeFor(operation?: ToolName): string {
  return operation === "create_report"
    ? CONSENT_PURPOSE_GENETIC_PROCESSING
    : CONSENT_PURPOSE_CHATGPT_SHARING;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Widget-only metadata attached to a `CONSENT_REQUIRED` result so the component
 * can render the privacy-choices card and deep-link the portal consent route for
 * exactly the purpose that was denied. Carries no genetic data: a URL, a purpose,
 * a public client id, and the machine-readable consent state.
 *
 * This is the shared recovery surface: every protected tool routes its consent
 * refusal through it, so a new tool cannot forget the state mapping. It merges
 * with any UI descriptor the tool already attached.
 */
function consentRecoveryMeta(
  runtime: ToolRuntime,
  operation: ToolName | undefined,
  response: ToolResponse,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const url = approvedConsentUrl(runtime.config);
  const clientId = runtime.config.MUTANT_OAUTH_CLIENT_ID.trim();
  const consent = response.error?.consent;
  const existingMutant = asRecord(existing?.mutant);
  const descriptor: Record<string, unknown> = {
    purpose: consentPurposeFor(operation),
    view: "consent",
    required: consent?.required ?? true,
    current: consent?.current ?? false,
    ...(url ? { url } : {}),
    ...(clientId ? { client_id: clientId } : {}),
    ...(consent?.reason ? { reason: consent.reason } : {}),
    ...(consent?.notice_version ? { notice_version: consent.notice_version } : {}),
  };
  return {
    ...(existing ?? {}),
    // Mount the shared component so the recovery card can render even from a
    // tool that is not itself a UI tool.
    ui: { resourceUri: DNA_IMPORT_UI_URI, visibility: ["model", "app"] },
    "ui/resourceUri": DNA_IMPORT_UI_URI,
    "openai/outputTemplate": DNA_IMPORT_UI_URI,
    mutant: {
      ...(existingMutant ?? {}),
      experience_state: "CONSENT_REQUIRED",
      consent: descriptor,
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
    const result = toolResultFromResponse(response, {
      ...options,
      meta: consentRecoveryMeta(runtime, options.operation, response, options.meta),
    });
    // Consent is a known, recoverable product state, not a tool failure: marking
    // it as an MCP error is what makes a host collapse it into a generic outage.
    // The structured envelope keeps `ok:false` (no data was served, the model
    // must not narrate results), but the result is renderable so the recovery
    // card mounts.
    result.isError = false;
    return result;
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
