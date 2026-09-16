import { byteLength } from "../clients/mutant-lambda-client.js";
import { APP_ERROR_CODES, CONTRACT_VERSION, ErrorCode, type ToolResponse } from "../contract.js";
import { getSnpCatalogInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

/**
 * Transport-level failures that carry no catalog-specific meaning. Anything else
 * (notably `AUTHENTICATION_REQUIRED` / `INSUFFICIENT_SCOPE`) is passed through
 * untouched so the tool-level OAuth challenge still fires.
 */
const TRANSPORT_CODES = new Set<string>([
  ErrorCode.SERVICE_UNAVAILABLE,
  ErrorCode.DATA_INCOMPATIBLE,
]);

function catalogUnavailable(retryable: boolean): ToolResponse {
  return {
    contract_version: CONTRACT_VERSION,
    analysis_version: null,
    ok: false,
    data: null,
    error: {
      code: ErrorCode.CATALOG_UNAVAILABLE,
      message: "The Mutant variant catalog is not available right now.",
      retryable,
      app_code: APP_ERROR_CODES.catalog_unavailable,
      ...(retryable ? { retry_after_seconds: 30 } : {}),
    },
  };
}

/**
 * Return the Mutant SNP/variant catalog the DNA import component filters against.
 *
 * The catalog is returned unchanged rather than summarized: the component hands
 * it straight to the shared browser processor. It is application data, not model
 * context, so response size is capped by `MUTANT_SNP_CATALOG_MAX_BYTES` rather
 * than the general response cap.
 */
export const getSnpCatalogTool: MutantToolDefinition = {
  name: "get_snp_catalog",
  title: "Get SNP Catalog",
  description:
    "Returns the Mutant SNP and variant catalog used internally by the DNA import component. " +
    "This tool is application infrastructure and should not be used to interpret genetics or " +
    "answer health questions. It is called by the DNA import interface, not by the assistant.",
  scope: "dna.import",
  // Hidden from the model's tool list: only the DNA import component calls this.
  uiVisibility: ["app"],
  inputSchema: getSnpCatalogInputSchema,
  outputSchema: toolResponseOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) => {
    const startedAt = Date.now();
    const upstream = await runtime.client.invoke(
      "get_snp_catalog",
      args,
      runtime.user,
      runtime.requestId,
    );

    let response = upstream;
    if (upstream.ok) {
      const data = upstream.data;
      const catalog = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
      if (!catalog || typeof catalog.snps !== "object" || catalog.snps === null) {
        response = catalogUnavailable(true);
      }
    } else if (upstream.error?.code && TRANSPORT_CODES.has(upstream.error.code)) {
      response = catalogUnavailable(upstream.error.retryable);
    }

    // Operational logging only: version, size, and count. Never the catalog.
    const catalogMeta = (response.data ?? {}) as { version?: unknown; snp_count?: unknown };
    const snpCount =
      typeof catalogMeta.snp_count === "number"
        ? catalogMeta.snp_count
        : response.data && typeof response.data.snps === "object" && response.data.snps
          ? Object.keys(response.data.snps as Record<string, unknown>).length
          : 0;
    const bytes = response.data ? byteLength(JSON.stringify(response.data)) : 0;

    if (response.ok) {
      runtime.logger.info(
        {
          tool: "get_snp_catalog",
          userId: runtime.user.userId,
          catalogVersion: typeof catalogMeta.version === "number" ? catalogMeta.version : null,
          snpCount,
          catalogBytes: bytes,
          durationMs: Date.now() - startedAt,
        },
        "snp catalog served",
      );
    } else {
      runtime.logger.warn(
        {
          tool: "get_snp_catalog",
          userId: runtime.user.userId,
          code: response.error?.code,
          durationMs: Date.now() - startedAt,
        },
        "snp catalog unavailable",
      );
    }

    return respond(response, runtime);
  },
};
