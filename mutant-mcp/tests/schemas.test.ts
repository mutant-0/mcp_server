import { describe, expect, it } from "vitest";
import {
  analysisStatusOutputSchema,
  createReportInputSchema,
  explainHealthHypothesisInputSchema,
  getAnalysisContextInputSchema,
  getAnalysisStatusInputSchema,
  getGeneticContextInputSchema,
  getSnpCatalogInputSchema,
  getSupportingEvidenceInputSchema,
  listHealthHypothesesInputSchema,
  showDnaImportInputSchema,
  supportingEvidenceOutputSchema,
} from "../src/schemas/index.js";
import { makeErrorResponse, makeStatusData, makeSuccessResponse } from "./helpers.js";

const evidenceKindSchema = getSupportingEvidenceInputSchema.kind;
const includeContextSchema = getSupportingEvidenceInputSchema.include_context;

describe("get_supporting_evidence input schema", () => {
  it("accepts every contracted evidence kind including modules", () => {
    for (const kind of ["patterns", "variants", "modules", "sources", "tests"]) {
      expect(evidenceKindSchema.safeParse(kind).success, kind).toBe(true);
    }
    expect(evidenceKindSchema.safeParse("genes").success).toBe(false);
  });

  it("accepts an optional include_context boolean only", () => {
    expect(includeContextSchema.safeParse(true).success).toBe(true);
    expect(includeContextSchema.safeParse(false).success).toBe(true);
    expect(includeContextSchema.safeParse(undefined).success).toBe(true);
    expect(includeContextSchema.safeParse("yes").success).toBe(false);
  });
});

describe("per-tool output schemas (contract 3.0.0)", () => {
  it("accepts a typed success envelope", () => {
    expect(analysisStatusOutputSchema.safeParse(makeSuccessResponse(makeStatusData())).success).toBe(
      true,
    );
  });

  it("accepts a structured error envelope with an object next_action", () => {
    expect(
      analysisStatusOutputSchema.safeParse(
        makeErrorResponse("ANALYSIS_PROCESSING", "processing", {
          retryable: true,
          retry_after_seconds: 30,
          next_action: { tool: "get_analysis_status", reason: "Wait for processing." },
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects a string next_action, because 3.0.0 requires the structured action", () => {
    const envelope = {
      ...makeErrorResponse("ANALYSIS_NOT_READY", "not ready"),
      error: {
        code: "ANALYSIS_NOT_READY",
        message: "not ready",
        retryable: true,
        next_action: "Try again in a moment.",
      },
    };
    expect(analysisStatusOutputSchema.safeParse(envelope).success).toBe(false);
  });

  it("accepts a null analysis version and rejects a missing envelope field", () => {
    expect(analysisStatusOutputSchema.safeParse(makeErrorResponse("INVALID_CURSOR")).success).toBe(
      true,
    );
    expect(analysisStatusOutputSchema.safeParse({ ok: true }).success).toBe(false);
    // `ok: true` may not carry an error.
    expect(
      analysisStatusOutputSchema.safeParse({ ...makeSuccessResponse(makeStatusData()), error: {} })
        .success,
    ).toBe(false);
  });

  it("carries the scope-denial fields the client needs to re-consent", () => {
    const parsed = analysisStatusOutputSchema.safeParse({
      ...makeErrorResponse("INSUFFICIENT_SCOPE", "scope missing"),
      error: {
        code: "INSUFFICIENT_SCOPE",
        message: "scope missing",
        retryable: false,
        required_scope: "https://mcp.example/mcp/dna.import",
        app_code: "insufficient_scope",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown experience_state", () => {
    const parsed = analysisStatusOutputSchema.safeParse(
      makeSuccessResponse(makeStatusData({ experience_state: "READY_SOON" })),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects an untyped evidence kind", () => {
    const envelope = makeSuccessResponse({ kind: "genes", items: [] });
    expect(supportingEvidenceOutputSchema.safeParse(envelope).success).toBe(false);
    expect(
      supportingEvidenceOutputSchema.safeParse(
        makeSuccessResponse({ kind: "patterns", items: [] }),
      ).success,
    ).toBe(true);
  });
});

describe("analysis_version input pins", () => {
  it("is optional on every analytical tool", () => {
    for (const schema of [
      listHealthHypothesesInputSchema,
      explainHealthHypothesisInputSchema,
      getSupportingEvidenceInputSchema,
      getGeneticContextInputSchema,
    ]) {
      expect(schema.analysis_version.safeParse(undefined).success).toBe(true);
      expect(schema.analysis_version.safeParse("rev42-v3.0.0").success).toBe(true);
      expect(schema.analysis_version.safeParse("").success).toBe(false);
    }
  });

  it("is not accepted by the status or context tools", () => {
    expect(getAnalysisStatusInputSchema).toEqual({});
    expect(getAnalysisContextInputSchema).toEqual({});
  });
});

describe("DNA import tool input schemas", () => {
  const validImport = {
    snps: { rs4680: "AG" },
    import_request_id: "12345678-abcd-4ef0-9876-1234567890ab",
  };

  it("takes no arguments for the catalog tool and only an optional mode for the UI tool", () => {
    expect(Object.keys(showDnaImportInputSchema)).toEqual(["mode"]);
    expect(getSnpCatalogInputSchema).toEqual({});
  });

  it("accepts a minimal and a full create_report payload", () => {
    expect(createReportInputSchema.safeParse(validImport).success).toBe(true);
    expect(
      createReportInputSchema.safeParse({
        ...validImport,
        upload_meta: { provider: "23andMe", file_name: "dna.txt", file_size_bytes: 1234 },
        report_id: "core_systems",
        wgs_variant_calls: {
          rs28362491: {
            schema_version: 1,
            source_format: "vcf",
            genome_build: "GRCh38",
            records: [{ chromosome: "16", position: 50729867, ref: "G", alts: ["GC"], gt: "0/1" }],
          },
        },
      }).success,
    ).toBe(true);
  });

  it("rejects client-supplied identity, because identity comes from the token", () => {
    for (const injected of [
      { account_id: "acc-1" },
      { user_id: "user-1" },
      { email: "someone@example.com" },
      { sub: "cognito-sub" },
      { analysis_id: "analysis-1" },
    ]) {
      const result = createReportInputSchema.safeParse({ ...validImport, ...injected });
      expect(result.success, `${Object.keys(injected)[0]} must be rejected`).toBe(false);
    }
  });

  it("accepts an optional transient analysis_context and rejects malformed shapes", () => {
    expect(
      createReportInputSchema.safeParse({
        ...validImport,
        analysis_context: { sex_chromosome_pattern: "XY", sex_chromosome_confidence: "high" },
      }).success,
    ).toBe(true);
    // Either field alone, including the documented non-high/unknown values.
    expect(
      createReportInputSchema.safeParse({
        ...validImport,
        analysis_context: { sex_chromosome_pattern: "unknown" },
      }).success,
    ).toBe(true);
    expect(
      createReportInputSchema.safeParse({
        ...validImport,
        analysis_context: { sex_chromosome_confidence: "low" },
      }).success,
    ).toBe(true);

    const invalid = [
      { analysis_context: { sex_chromosome_pattern: "ZZ" } },
      { analysis_context: { sex_chromosome_confidence: "certain" } },
      // Strict nested object: an unknown nested key must be rejected.
      { analysis_context: { sex_chromosome_pattern: "XX", extra: "value" } },
      { analysis_context: "XX" },
    ];
    for (const payload of invalid) {
      expect(createReportInputSchema.safeParse({ ...validImport, ...payload }).success).toBe(false);
    }
  });

  it("rejects malformed rsIDs, genotypes, and idempotency keys", () => {
    const invalid = [
      { snps: { variant1: "AG" } },
      { snps: { rs4680: "A" } },
      { snps: { rs4680: "AX" } },
      { snps: { rs4680: "ag" } },
      { snps: {} , import_request_id: "short" },
      { ...validImport, import_request_id: "x".repeat(129) },
      { ...validImport, report_id: "Not A Slug" },
    ];
    for (const payload of invalid) {
      expect(createReportInputSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("caps submission size with transport guards, not biological rules", () => {
    const tooManySnps = Object.fromEntries(
      Array.from({ length: 20001 }, (_, index) => [`rs${index + 1}`, "AG"]),
    );
    expect(createReportInputSchema.safeParse({ ...validImport, snps: tooManySnps }).success).toBe(
      false,
    );

    const tooManyCalls = Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [
        `rs${index + 1}`,
        { schema_version: 1, source_format: "vcf", genome_build: "GRCh38", records: [] },
      ]),
    );
    expect(
      createReportInputSchema.safeParse({ ...validImport, wgs_variant_calls: tooManyCalls }).success,
    ).toBe(false);
  });
});
