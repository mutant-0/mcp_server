import { byteLength, payloadTooLarge } from "../clients/mutant-lambda-client.js";
import { APP_ERROR_CODES, ErrorCode, type ToolResponse } from "../contract.js";
import { createReportInputSchema, toolResponseOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { dnaImportWriteAnnotations, type MutantToolDefinition } from "./types.js";

/**
 * Upstream codes remapped to the stable DNA import vocabulary (§14). Codes that
 * carry authorization meaning are deliberately absent so a scope or
 * authentication failure still produces a tool-level OAuth challenge:
 * `AUTHENTICATION_REQUIRED`, `INSUFFICIENT_SCOPE`, `PLAN_ACCESS_REQUIRED`, and
 * `PAYLOAD_TOO_LARGE` / `RESPONSE_TOO_LARGE` all pass through unchanged.
 */
const REMAPS: Record<string, { code: string; app_code: string; retryable?: boolean }> = {
  [ErrorCode.SERVICE_UNAVAILABLE]: {
    code: ErrorCode.REPORT_GENERATION_FAILED,
    app_code: APP_ERROR_CODES.report_generation_failed,
    retryable: true,
  },
  [ErrorCode.DATA_INCOMPATIBLE]: {
    code: ErrorCode.REPORT_GENERATION_FAILED,
    app_code: APP_ERROR_CODES.report_generation_failed,
    retryable: true,
  },
  [ErrorCode.INVALID_ARGUMENT]: {
    code: ErrorCode.INVALID_DNA_PAYLOAD,
    app_code: APP_ERROR_CODES.invalid_dna_payload,
  },
};

function remapUpstreamError(response: ToolResponse): ToolResponse {
  const code = response.error?.code;
  const remap = code ? REMAPS[code] : undefined;
  if (!remap) return response;
  return {
    ...response,
    error: {
      code: remap.code,
      message: response.error?.message ?? "The Mutant analysis could not be created.",
      retryable: remap.retryable ?? response.error?.retryable ?? false,
      app_code: remap.app_code,
      ...(remap.retryable ? { retry_after_seconds: 30 } : {}),
    },
  };
}

/**
 * Reduce the success payload to exactly what the workflow needs. The submitted
 * genotypes are never echoed back to the component or the model, so a host that
 * ignores tool visibility still cannot read the user's DNA out of the result.
 */
function narrowSuccess(response: ToolResponse): ToolResponse {
  if (!response.ok) return response;
  const data = (response.data ?? {}) as Record<string, unknown>;
  const analysisId = typeof data.analysis_id === "string" ? data.analysis_id : null;
  const status = typeof data.status === "string" ? data.status : null;
  return { ...response, data: { analysis_id: analysisId, status } };
}

/** Non-sensitive payload metrics. Never the payload itself. */
export function describeDnaPayload(args: Record<string, unknown>): {
  snpCount: number;
  wgsVariantCallCount: number;
  wgsRecordCount: number;
  payloadBytes: number;
  inputSizeBytes: number | null;
  provider: string | null;
  genomeBuild: string | null;
} {
  const snps = (args.snps ?? {}) as Record<string, unknown>;
  const wgs = (args.wgs_variant_calls ?? {}) as Record<string, { records?: unknown[] }>;
  const upload = (args.upload_meta ?? {}) as { provider?: unknown; file_size_bytes?: unknown };

  let wgsRecordCount = 0;
  for (const call of Object.values(wgs)) {
    if (call && Array.isArray(call.records)) wgsRecordCount += call.records.length;
  }

  const builds = new Set<string>();
  for (const call of Object.values(wgs)) {
    const build = (call as { genome_build?: unknown } | null)?.genome_build;
    if (typeof build === "string") builds.add(build);
  }

  return {
    snpCount: Object.keys(snps).length,
    wgsVariantCallCount: Object.keys(wgs).length,
    wgsRecordCount,
    payloadBytes: byteLength(JSON.stringify(args ?? {})),
    inputSizeBytes: typeof upload.file_size_bytes === "number" ? upload.file_size_bytes : null,
    provider: typeof upload.provider === "string" ? upload.provider : null,
    genomeBuild: builds.size === 1 ? [...builds][0]! : null,
  };
}

/**
 * Create a Mutant analysis from locally processed DNA data.
 *
 * The component has already filtered the raw file down to Mutant-relevant
 * variants; this tool validates only the transport-level shape, derives the
 * identity from the verified token, and proxies to the reports-generator, which
 * owns every genomic decision (rsID, genotype, build, non-SNV records, report
 * eligibility).
 */
export const createReportTool: MutantToolDefinition = {
  name: "create_report",
  title: "Create Report",
  description:
    "Creates a Mutant analysis from locally processed DNA data. Called by the DNA import " +
    "interface with the normalized subset of Mutant-relevant variants; the raw DNA file is " +
    "never uploaded. Retrying with the same import_request_id returns the existing analysis " +
    "instead of creating another one.",
  scope: "dna.import",
  // The component submits the payload; the model has no reason to call this, and
  // hiding it keeps genotypes out of the conversation.
  uiVisibility: ["app"],
  inputSchema: createReportInputSchema,
  outputSchema: toolResponseOutputSchema,
  annotations: dnaImportWriteAnnotations,
  handler: async (args, runtime) => {
    const startedAt = Date.now();
    const importRequestId =
      typeof args.import_request_id === "string" ? args.import_request_id : null;
    const metrics = describeDnaPayload(args);

    // Enforce the transport cap here as well as in the client, so the guard does
    // not depend on which backend client is wired in.
    if (metrics.payloadBytes > runtime.config.MUTANT_MAX_REQUEST_BYTES) {
      runtime.logger.warn(
        {
          tool: "create_report",
          requestId: runtime.requestId,
          importRequestId,
          ...metrics,
          maxRequestBytes: runtime.config.MUTANT_MAX_REQUEST_BYTES,
        },
        "dna import rejected: payload too large",
      );
      return respond(payloadTooLarge(), runtime);
    }

    runtime.logger.info(
      { tool: "create_report", requestId: runtime.requestId, importRequestId, ...metrics },
      "dna import submitted",
    );

    const upstream = await runtime.client.invoke(
      "create_report",
      args,
      runtime.user,
      runtime.requestId,
    );
    const response = narrowSuccess(remapUpstreamError(upstream));

    const data = (response.data ?? {}) as { analysis_id?: unknown; status?: unknown };
    const log = {
      tool: "create_report",
      requestId: runtime.requestId,
      userId: runtime.user.userId,
      importRequestId,
      ...metrics,
      analysisId: typeof data.analysis_id === "string" ? data.analysis_id : null,
      upstreamStatus: typeof data.status === "string" ? data.status : null,
      errorCode: response.error?.code ?? null,
      durationMs: Date.now() - startedAt,
    };
    if (response.ok) {
      runtime.logger.info(log, "dna import completed");
    } else {
      runtime.logger.warn(log, "dna import failed");
    }

    return respond(response, runtime);
  },
};
