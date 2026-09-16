import { describe, expect, it } from "vitest";
import {
  createReportInputSchema,
  getSnpCatalogInputSchema,
  showDnaImportInputSchema,
  toolResponseOutputSchema,
} from "../src/schemas/index.js";
import { makeErrorResponse, makeSuccessResponse } from "./helpers.js";

describe("toolResponseOutputSchema", () => {
  it("accepts a success envelope", () => {
    expect(toolResponseOutputSchema.safeParse(makeSuccessResponse()).success).toBe(true);
  });

  it("accepts an error envelope", () => {
    expect(
      toolResponseOutputSchema.safeParse(
        makeErrorResponse("ANALYSIS_CHANGED", "changed"),
      ).success,
    ).toBe(true);
  });

  it("accepts a null analysis version", () => {
    expect(
      toolResponseOutputSchema.safeParse(makeErrorResponse("INVALID_CURSOR")).success,
    ).toBe(true);
  });

  it("rejects a payload missing required envelope fields", () => {
    expect(toolResponseOutputSchema.safeParse({ ok: true }).success).toBe(false);
  });

  it("carries the scope-denial fields the client needs to re-consent", () => {
    const parsed = toolResponseOutputSchema.safeParse({
      ...makeErrorResponse("INSUFFICIENT_SCOPE", "scope missing"),
      error: {
        ...makeErrorResponse("INSUFFICIENT_SCOPE", "scope missing").error,
        required_scope: "https://mcp.example/mcp/dna.import",
        app_code: "insufficient_scope",
      },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("DNA import tool input schemas", () => {
  const validImport = {
    snps: { rs4680: "AG" },
    import_request_id: "12345678-abcd-4ef0-9876-1234567890ab",
  };

  it("takes no arguments for the UI and catalog tools", () => {
    expect(showDnaImportInputSchema).toEqual({});
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
