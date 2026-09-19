import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { MutantUserContext } from "../auth/user-context.js";
import { DEFAULT_MUTANT_MAX_REQUEST_BYTES, type AppConfig } from "../config.js";
import {
  APP_ERROR_CODES,
  CONTRACT_VERSION,
  ErrorCode,
  isToolResponse,
  type ToolName,
  type ToolResponse,
} from "../contract.js";

/**
 * Versioned internal request contract for direct Lambda invocation.
 * `identity.user_id` is always derived from the verified token.
 */
export interface MutantBackendEvent {
  source: "mutant-mcp";
  contract_version: typeof CONTRACT_VERSION;
  operation: ToolName;
  identity: { user_id: string };
  arguments: Record<string, unknown>;
  request_context: { request_id: string };
}

export interface MutantBackendClient {
  invoke(
    operation: ToolName,
    args: Record<string, unknown>,
    ctx: MutantUserContext,
    requestId: string,
  ): Promise<ToolResponse>;
}

export function buildBackendEvent(
  operation: ToolName,
  args: Record<string, unknown>,
  ctx: MutantUserContext,
  requestId: string,
): MutantBackendEvent {
  return {
    source: "mutant-mcp",
    contract_version: CONTRACT_VERSION,
    operation,
    identity: { user_id: ctx.userId },
    arguments: args,
    request_context: { request_id: requestId },
  };
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf-8");
}

function fieldError(
  code: string,
  message: string,
  retryable = false,
  extra: Partial<ToolResponse["error"]> = {},
): ToolResponse {
  return {
    contract_version: CONTRACT_VERSION,
    analysis_version: null,
    ok: false,
    data: null,
    error: {
      code,
      message,
      retryable,
      ...(retryable ? { retry_after_seconds: 30 } : {}),
      ...extra,
    },
  };
}

export function serviceUnavailable(message: string): ToolResponse {
  return fieldError(ErrorCode.SERVICE_UNAVAILABLE, message, true);
}

/** The `PAYLOAD_TOO_LARGE` envelope, shared by the request cap and the tools. */
export function payloadTooLarge(): ToolResponse {
  return fieldError(
    ErrorCode.PAYLOAD_TOO_LARGE,
    "The processed DNA data is too large to submit in one request.",
    false,
    { app_code: APP_ERROR_CODES.payload_too_large },
  );
}

/**
 * Response cap for an operation. `get_snp_catalog` returns application data for
 * the DNA import component rather than model context, so it is allowed the
 * (larger) catalog cap; every other tool uses the general response cap.
 */
export function responseCap(
  operation: ToolName,
  maxResponseBytes: number,
  snpCatalogMaxBytes: number,
): number {
  if (operation === "get_snp_catalog") {
    return Math.max(snpCatalogMaxBytes, maxResponseBytes);
  }
  return maxResponseBytes;
}

export function responseCapFor(config: AppConfig, operation: ToolName): number {
  return responseCap(
    operation,
    config.MUTANT_MAX_RESPONSE_BYTES,
    config.MUTANT_SNP_CATALOG_MAX_BYTES,
  );
}

/**
 * Reject a request whose serialized arguments exceed the cap.
 *
 * This guards the synchronous `lambda:InvokeFunction` payload ceiling, which is
 * the binding limit for a normalized WGS import payload. Returns `null` when the
 * request fits.
 */
export function enforceRequestCap(
  args: Record<string, unknown>,
  maxRequestBytes: number,
): ToolResponse | null {
  const size = byteLength(JSON.stringify(args ?? {}));
  if (size <= maxRequestBytes) return null;
  return payloadTooLarge();
}

/**
 * Reject a response that exceeds the cap *before* parsing it, so an oversized
 * upstream body never becomes structured content the model could see.
 */
export function enforceResponseCap(rawBody: string, capBytes: number): ToolResponse | null {
  const size = byteLength(rawBody);
  if (size <= capBytes) return null;
  return fieldError(
    ErrorCode.RESPONSE_TOO_LARGE,
    "The analysis service returned more data than this tool can safely deliver.",
    false,
    { app_code: APP_ERROR_CODES.payload_too_large },
  );
}

function regionFromArn(arn: string): string {
  const region = arn.split(":")[3];
  return region && region.length > 0 ? region : "us-east-1";
}

export class AwsMutantBackendClient implements MutantBackendClient {
  private readonly lambda: LambdaClient;

  constructor(private readonly config: AppConfig) {
    this.lambda = new LambdaClient({ region: regionFromArn(config.MUTANT_SERVICE_LAMBDA_ARN) });
  }

  async invoke(
    operation: ToolName,
    args: Record<string, unknown>,
    ctx: MutantUserContext,
    requestId: string,
  ): Promise<ToolResponse> {
    const oversized = enforceRequestCap(args, this.config.MUTANT_MAX_REQUEST_BYTES);
    if (oversized) return oversized;

    const event = buildBackendEvent(operation, args, ctx, requestId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.MUTANT_REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await this.lambda.send(
        new InvokeCommand({
          FunctionName: this.config.MUTANT_SERVICE_LAMBDA_ARN,
          InvocationType: "RequestResponse",
          Payload: new TextEncoder().encode(JSON.stringify(event)),
        }),
        { abortSignal: controller.signal },
      );
    } catch (error) {
      return serviceUnavailable(
        error instanceof Error && error.name === "AbortError"
          ? "The analysis request timed out."
          : "The analysis service is temporarily unavailable.",
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.Payload) {
      return fieldError(
        ErrorCode.DATA_INCOMPATIBLE,
        "The analysis service returned an empty response.",
      );
    }

    const body = Buffer.from(response.Payload).toString("utf-8");
    const tooLarge = enforceResponseCap(body, responseCapFor(this.config, operation));
    if (tooLarge) return tooLarge;

    if (response.FunctionError) {
      return serviceUnavailable("The analysis service failed to handle the request.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return fieldError(
        ErrorCode.DATA_INCOMPATIBLE,
        "The analysis service returned an unreadable response.",
      );
    }

    return parseBackendPayload(parsed);
  }
}

/**
 * Validate and normalize a decoded backend payload into a `ToolResponse`.
 * Anything outside the contract maps to an explicit structured error rather
 * than an empty success.
 */
export function parseBackendPayload(parsed: unknown): ToolResponse {
  if (!isToolResponse(parsed)) {
    return fieldError(
      ErrorCode.DATA_INCOMPATIBLE,
      "The analysis service returned a response outside the MCP contract.",
    );
  }
  if (parsed.contract_version !== CONTRACT_VERSION) {
    return fieldError(
      ErrorCode.DATA_INCOMPATIBLE,
      `Unsupported backend contract version '${parsed.contract_version}'.`,
    );
  }
  return parsed;
}

/**
 * Minimal synthetic catalog used by dev mode. It is deliberately tiny: the real
 * catalog comes from the backend, and the component only needs a well-formed
 * shape to exercise the local parse + submit path.
 */
export const MOCK_SNP_CATALOG = {
  version: 1,
  snp_count: 3,
  snps: {
    rs4680: {
      rsID: "rs4680",
      chromosome: "22",
      position_GRCh37: 19951271,
      position_GRCh38: 19963748,
      risk_allele: "A",
    },
    rs328: {
      rsID: "rs328",
      chromosome: "8",
      position_GRCh37: 19819724,
      position_GRCh38: 19962213,
      risk_allele: "G",
    },
    rs1801133: {
      rsID: "rs1801133",
      chromosome: "1",
      position_GRCh37: 11856378,
      position_GRCh38: 11796321,
      risk_allele: "A",
    },
  },
  aliases: { rs4680: ["rs1000000"] },
  reference_alleles: {
    rs4680: { GRCh37: "G", GRCh38: "G" },
    rs328: { GRCh37: "C", GRCh38: "C" },
  },
} as const;

/** Caps the dev-mode mock enforces, mirroring the real client. */
export interface MockClientCaps {
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  snpCatalogMaxBytes?: number;
  /**
   * How long the synthetic dev-mode analysis stays `processing` before the mock
   * reports it `ready`. Dev-loop convenience and a test seam; the real timing is
   * the reports-generator's.
   */
  analysisProcessingMs?: number;
}

/** Dev-mode default: long enough to see the processing card, short enough to wait. */
const DEFAULT_MOCK_ANALYSIS_PROCESSING_MS = 20_000;

/**
 * Dev-mode analyses, keyed by user. Module-level because the mock stands in for a
 * backend that is stateless per request: the Lambda process is the only thing
 * that can remember that an import happened.
 */
const mockAnalyses = new Map<string, { analysisId: string; startedAt: number }>();

/** Dev/test helper: forget every synthetic analysis. */
export function resetMockAnalyses(): void {
  mockAnalyses.clear();
}

/** Synthetic hypotheses so the ready-state CTA renders in dev mode. */
function mockHypotheses(): Record<string, unknown>[] {
  const rows = [
    ["HYP_MOCK_A", "Lipid metabolism", "Model support for how your variants influence lipid handling."],
    ["HYP_MOCK_B", "Folate metabolism", "Patterns in your variants related to folate and homocysteine."],
    ["HYP_MOCK_C", "Caffeine clearance", "Reported variant support for how you metabolize caffeine."],
  ];
  return rows.map(([id, title, bottomLine], index) => ({
    id,
    rank: index + 1,
    title,
    bottom_line: bottomLine,
    priority_score: 90 - index * 10,
    genetic_support_score: 80 - index * 10,
    genetic_evidence: "moderate",
    coverage_confidence: "high",
    pattern_convergence: "moderate",
  }));
}

/** Synthetic analysis-context data, mirroring the v2 contract shape. */
function mockContext(): Record<string, unknown> {
  const hypotheses = mockHypotheses();
  const previews = hypotheses.map((row) => ({
    id: row.id,
    rank: row.rank,
    title: row.title,
    bottom_line: row.bottom_line,
    priority_score: row.priority_score,
    genetic_evidence: row.genetic_evidence,
    coverage_confidence: row.coverage_confidence,
    pattern_convergence: row.pattern_convergence,
  }));
  return {
    interpretation_contract: {
      version: "2.0",
      purpose:
        "Mutant returns ranked, genetically supported health hypotheses for exploration and clinical discussion, not diagnoses.",
      response_rules: [
        "Lead with the plain-English meaning.",
        "Distinguish genetic susceptibility from a current condition.",
      ],
      score_semantics: {
        priority_score: "The ordering score; not disease probability.",
        genetic_support: "Strength of genetic support within the analyzed evidence.",
        genetic_evidence: "The weak/moderate/strong evidence category.",
        coverage_confidence: "How completely the relevant markers were assessed.",
        pattern_convergence: "How strongly independent patterns agree.",
      },
      evidence_boundaries: {
        genetics_is_not_diagnosis: true,
        genetic_support_does_not_establish_current_status: true,
        clinical_correlation_is_catalog_guidance: true,
        clinical_correlation_is_not_user_record_evidence: true,
      },
      health_context_usage: {
        allowed: true,
        performed_by: "chatgpt",
        sent_to_mutant: false,
        purpose: "relevance_filtering",
      },
      presentation_order: [
        "bottom_line",
        "why_ranked",
        "interpretation_boundary",
        "minimal_confirmation",
        "strengthening_and_weakening_evidence",
        "action_changing_guardrail",
      ],
      limitations: [
        "This analysis covers only the markers in the Mutant panel.",
        "Absence of a finding is not evidence of absence.",
      ],
    },
    coverage: { analyzed_markers: 1000 },
    access_summary: {
      plan: "mutant_free",
      hypothesis_scope: "top_3",
      total_ranked: hypotheses.length,
      returned: previews.length,
      unlocked: previews.length,
      locked: 0,
      scope_message: "Your top three ranked hypotheses are fully unlocked.",
    },
    top_hypotheses: previews,
  };
}

/** Used when no target ARN is configured, so local development stays self-contained. */
export class MockMutantBackendClient implements MutantBackendClient {
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly snpCatalogMaxBytes: number;
  private readonly analysisProcessingMs: number;

  constructor(caps: MockClientCaps = {}) {
    this.maxRequestBytes = caps.maxRequestBytes ?? DEFAULT_MUTANT_MAX_REQUEST_BYTES;
    this.maxResponseBytes = caps.maxResponseBytes ?? 512000;
    this.snpCatalogMaxBytes = caps.snpCatalogMaxBytes ?? 2000000;
    this.analysisProcessingMs = caps.analysisProcessingMs ?? DEFAULT_MOCK_ANALYSIS_PROCESSING_MS;
  }

  async invoke(
    operation: ToolName,
    args: Record<string, unknown>,
    ctx: MutantUserContext,
    requestId: string,
  ): Promise<ToolResponse> {
    // The mock enforces the same transport caps as the real client so dev mode
    // exercises the oversize paths instead of silently accepting anything.
    const oversized = enforceRequestCap(args, this.maxRequestBytes);
    if (oversized) return oversized;

    const response = this.respond(operation, args, ctx, requestId);
    const tooLarge = enforceResponseCap(
      JSON.stringify(response),
      responseCap(operation, this.maxResponseBytes, this.snpCatalogMaxBytes),
    );
    return tooLarge ?? response;
  }

  /**
   * The synthetic DNA import lifecycle: an import is remembered, then reports
   * `processing` until the window elapses and `ready` afterwards. Without this,
   * dev mode would tell the component there is no DNA data right after a
   * successful import and the polling flow would look broken.
   */
  private analysisStatus(ctx: MutantUserContext): ToolResponse {
    const record = mockAnalyses.get(ctx.userId);
    if (!record) {
      return {
        contract_version: CONTRACT_VERSION,
        analysis_version: null,
        ok: true,
        data: {
          dna_status: "missing",
          analysis_status: "unavailable",
          entitlement: { plan: "mutant_free", hypothesis_scope: "top_3" },
          capabilities: { clinical_correlation: true, supporting_evidence: true },
          regenerate: false,
          next_action: {
            tool: "show_dna_import",
            reason: "DNA data is required before an analysis can be generated.",
          },
        },
        error: null,
      };
    }

    const createdAt = new Date(record.startedAt).toISOString();
    const ready = Date.now() - record.startedAt >= this.analysisProcessingMs;
    const status = ready ? "ready" : "processing";
    return {
      contract_version: CONTRACT_VERSION,
      analysis_version: ready ? "mock" : null,
      ok: true,
      data: {
        dna_status: "available",
        analysis_status: status,
        analysis_id: record.analysisId,
        created_at: createdAt,
        analysis: {
          generated_at: ready ? createdAt : null,
          scoring_engine_version: "mock",
        },
        entitlement: { plan: "mutant_free", hypothesis_scope: "top_3" },
        capabilities: { clinical_correlation: true, supporting_evidence: true },
        regenerate: false,
        next_action: ready
          ? { tool: "get_analysis_context", reason: "The current analysis is ready." }
          : { tool: "get_analysis_status", reason: "The analysis is still processing." },
      },
      error: null,
    };
  }

  private respond(
    operation: ToolName,
    args: Record<string, unknown>,
    ctx: MutantUserContext,
    requestId: string,
  ): ToolResponse {
    if (operation === "get_snp_catalog") {
      return {
        contract_version: CONTRACT_VERSION,
        analysis_version: null,
        ok: true,
        // `data` is the catalog itself, mirroring the reports-generator
        // `/snp-catalog` body the portal processor already consumes.
        data: MOCK_SNP_CATALOG as unknown as Record<string, unknown>,
        error: null,
      };
    }

    if (operation === "create_report") {
      const importRequestId =
        typeof args.import_request_id === "string" ? args.import_request_id : "unknown";
      const analysisId = `analysis_mock_${importRequestId.slice(0, 8)}`;
      // A repeat of the same import request is idempotent here too: the new
      // attempt always restarts the clock, because it is a new import.
      mockAnalyses.set(ctx.userId, { analysisId, startedAt: Date.now() });
      return {
        contract_version: CONTRACT_VERSION,
        analysis_version: null,
        ok: true,
        data: { analysis_id: analysisId, status: "processing" },
        error: null,
      };
    }

    if (operation === "get_analysis_status") {
      return this.analysisStatus(ctx);
    }

    if (operation === "get_analysis_context") {
      return {
        contract_version: CONTRACT_VERSION,
        analysis_version: "mock",
        ok: true,
        data: mockAnalyses.has(ctx.userId) ? mockContext() : {},
        error: null,
      };
    }

    if (operation === "list_health_hypotheses") {
      return {
        contract_version: CONTRACT_VERSION,
        analysis_version: "mock",
        ok: true,
        data: { items: mockAnalyses.has(ctx.userId) ? mockHypotheses() : [] },
        error: null,
      };
    }

    if (operation === "explain_health_hypothesis") {
      return {
        contract_version: CONTRACT_VERSION,
        analysis_version: "mock",
        ok: true,
        data: {
          hypothesis: {
            id: "HYP_MOCK_A",
            rank: 1,
            title: "Lipid metabolism",
            assessment_state: "assessed",
            scores: { priority: 72, genetic_support: 74, coverage: "high", convergence: "moderate" },
          },
          explanation: {
            bottom_line: "Model support for how your variants influence lipid handling.",
            why_ranked:
              "It ranked #1 because it has moderate genetic support, high coverage and moderate convergence.",
            top_contributing_patterns: [],
          },
          clinical_context: { common_cofactors: [], common_confusers: [], subtypes: [] },
          confirmation: { primary_checks: [] },
          guardrails: [],
        },
        error: null,
      };
    }

    return {
      contract_version: CONTRACT_VERSION,
      analysis_version: "mock",
      ok: true,
      data: {
        mock: true,
        operation,
        identity: { user_id: ctx.userId },
        request_id: requestId,
        // Key names only: echoing arguments would put submitted genotypes (and
        // any future sensitive field) into a mock tool result.
        argument_keys: Object.keys(args ?? {}),
      },
      error: null,
    };
  }
}

export function createMutantBackendClient(config: AppConfig): MutantBackendClient {
  if (!config.MUTANT_SERVICE_LAMBDA_ARN) {
    return new MockMutantBackendClient({
      maxRequestBytes: config.MUTANT_MAX_REQUEST_BYTES,
      maxResponseBytes: config.MUTANT_MAX_RESPONSE_BYTES,
      snpCatalogMaxBytes: config.MUTANT_SNP_CATALOG_MAX_BYTES,
    });
  }
  return new AwsMutantBackendClient(config);
}
