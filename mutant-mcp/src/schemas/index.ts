import { z } from "zod";

import {
  analysisContextDataSchema,
  analysisStatusDataSchema,
  createReportDataSchema,
  dnaImportDataSchema,
  errorOutputSchema,
  explainHypothesisDataSchema,
  geneticContextDataSchema,
  hypothesisListDataSchema,
  showAnalysisOverviewDataSchema,
  snpCatalogDataSchema,
  supportingEvidenceDataSchema,
} from "./outputs.js";

export * from "./outputs.js";

/**
 * Per-tool input schemas. Every tool takes a JSON object (never a scalar).
 * No tool accepts an analysis id, account, or plan, and the DNA import tools
 * reject unknown top-level properties outright so a client can never smuggle a
 * claim that the MCP layer would otherwise pass through to the backend.
 */

const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(50)
  .describe("Maximum number of items to return (1-50).")
  .optional();

/** A bounded limit for tools with a narrower contract maximum. */
const boundedLimitSchema = (max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .describe(`Maximum number of items to return (1-${max}).`)
    .optional();

const cursorSchema = z
  .string()
  .max(4096)
  .describe("Opaque pagination cursor returned by a previous call.")
  .optional();

const hypothesisIdSchema = z
  .string()
  .min(1)
  .max(160)
  .describe("Health hypothesis id from get_analysis_context or list_health_hypotheses.");

/**
 * Optional snapshot pin. Analytical tools answer against the currently active
 * analysis; passing the version a card displayed binds the call to that exact
 * revision and rejects a mismatch with `ANALYSIS_VERSION_CHANGED` instead of
 * silently reinterpreting the reference.
 */
const analysisVersionSchema = z
  .string()
  .min(1)
  .max(160)
  .describe("Analysis revision returned by a previous call. Omit to use the current one.")
  .optional();

export const getAnalysisStatusInputSchema = {};

export const getAnalysisContextInputSchema = {};

export const listHealthHypothesesInputSchema = {
  query: z
    .string()
    .min(1)
    .max(120)
    .describe("Optional catalog-topic keyword search across hypothesis names and summaries.")
    .optional(),
  limit: boundedLimitSchema(20),
  cursor: cursorSchema,
  analysis_version: analysisVersionSchema,
};

export const explainHealthHypothesisInputSchema = {
  hypothesis_id: hypothesisIdSchema,
  analysis_version: analysisVersionSchema,
};

export const getSupportingEvidenceInputSchema = {
  hypothesis_id: hypothesisIdSchema,
  kind: z
    .enum(["patterns", "variants", "modules", "sources", "tests"])
    .describe("Evidence kind to return. Defaults to 'patterns'.")
    .optional(),
  pattern_id: z
    .string()
    .min(1)
    .max(160)
    .describe("Optional pattern id to restrict the evidence to a single matched pattern.")
    .optional(),
  include_context: z
    .boolean()
    .describe(
      "For kind 'modules': also return contextual markers that did not contribute module support. Defaults to false.",
    )
    .optional(),
  limit: boundedLimitSchema(20),
  cursor: cursorSchema,
  analysis_version: analysisVersionSchema,
};

export const getGeneticContextInputSchema = {
  hypothesis_id: z
    .string()
    .min(1)
    .max(160)
    .describe(
      "Hypothesis whose stored variant evidence should scope this call. Required for Free accounts.",
    )
    .optional(),
  module_id: z
    .string()
    .min(1)
    .max(160)
    .describe("Module id to explore (Full accounts only).")
    .optional(),
  gene: z
    .string()
    .min(1)
    .max(40)
    .describe("Gene symbol to explore (Full accounts only).")
    .optional(),
  rsids: z
    .array(z.string().regex(/^rs[0-9]+$/i))
    .min(1)
    .max(50)
    .describe("Specific rsIDs to look up (Full accounts only).")
    .optional(),
  include_modules: z
    .boolean()
    .describe("Include module summaries alongside the markers. Defaults to false.")
    .optional(),
  limit: limitSchema,
  cursor: cursorSchema,
  analysis_version: analysisVersionSchema,
};

// ---------------------------------------------------------------------------
// DNA import
// ---------------------------------------------------------------------------

/** No arguments: the component renders from the tool result alone. */
export const showDnaImportInputSchema = {
  mode: z
    .enum(["initial", "regenerate"])
    .describe(
      "Import mode. Use 'regenerate' only when a refresh is required or the user asks to refresh.",
    )
    .optional(),
};

/** No arguments: the component needs the whole catalog or none of it. */
export const getSnpCatalogInputSchema = {};

const RSID_PATTERN = /^rs[0-9]+$/i;
const GENOTYPE_PATTERN = /^[ACGT]{2}$/;
/** Report selector slug, mirroring the reports-generator `id` field. */
const REPORT_ID_PATTERN = /^[a-z0-9_]{1,64}$/;

/**
 * Ceilings on submitted entries. These are transport guards against a runaway
 * payload, not biological validation: the reports-generator remains the only
 * authority on rsIDs, genotypes, builds, and report eligibility.
 */
export const MAX_SNP_ENTRIES = 20000;
export const MAX_WGS_VARIANT_CALLS = 500;
export const MAX_WGS_RECORDS_PER_CALL = 1000;

const snpsSchema = z
  .record(
    z.string().regex(RSID_PATTERN, "Keys must be rsIDs, for example 'rs4680'."),
    z.string().regex(GENOTYPE_PATTERN, "Genotype must be two of A/C/G/T, for example 'AG'."),
  )
  .refine((snps) => Object.keys(snps).length <= MAX_SNP_ENTRIES, {
    message: `snps must contain at most ${MAX_SNP_ENTRIES} entries.`,
  })
  .describe("Flat map of catalog rsID to normalized two-base genotype, exactly as read locally.");

/**
 * A captured non-SNV VCF record set for one target. Only the shape the
 * reports-generator contract requires is described here; individual records stay
 * opaque so no variant semantics are re-implemented in the MCP layer.
 */
const wgsVariantCallSchema = z
  .object({
    schema_version: z.number().int().min(1).max(10),
    source_format: z.string().min(1).max(32),
    genome_build: z.string().min(1).max(32),
    records: z.array(z.record(z.string(), z.unknown())).max(MAX_WGS_RECORDS_PER_CALL),
  })
  .describe("Captured non-SNV VCF records for one catalog target.");

const wgsVariantCallsSchema = z
  .record(
    z.string().regex(RSID_PATTERN, "Keys must be rsIDs, for example 'rs28362491'."),
    wgsVariantCallSchema,
  )
  .refine((calls) => Object.keys(calls).length <= MAX_WGS_VARIANT_CALLS, {
    message: `wgs_variant_calls must contain at most ${MAX_WGS_VARIANT_CALLS} entries.`,
  })
  .describe("Optional, additive map of non-SNV capture targets to their VCF records.");

const uploadMetaSchema = z
  .object({
    provider: z.string().min(1).max(64).describe("Detected source, e.g. '23andMe' or 'WGS'."),
    file_name: z.string().min(1).max(512).describe("Original file name, for the user's records."),
    file_size_bytes: z.number().int().nonnegative(),
  })
  .describe("Non-sensitive provenance for the import; never includes file contents.");

/**
 * Optional, request-only sex-chromosome context inferred locally from the raw
 * DNA file. The backend consumes it transiently while evaluating sex-specific
 * perfect-storm conditions and never persists, caches, logs, or echoes it. Only
 * `XX`/`XY` with `high` confidence activate sex-specific scoring; every other
 * combination is treated as unknown.
 */
const analysisContextSchema = z
  .strictObject({
    sex_chromosome_pattern: z
      .enum(["XX", "XY", "unknown", "ambiguous"])
      .optional()
      .describe("Inferred sex-chromosome pattern from the upload, when confidently detected."),
    sex_chromosome_confidence: z
      .enum(["high", "medium", "low", "unknown"])
      .optional()
      .describe("Confidence in the inferred pattern. Only 'high' activates sex-specific scoring."),
  })
  .describe("Optional transient context; never stored, logged, or returned.");

/**
 * Strict so that identity-bearing or scoping fields (`account_id`, `user_id`,
 * `email`, `sub`, `analysis_id`) are rejected as invalid arguments rather than
 * silently ignored. Identity is always derived from the verified token.
 */
export const createReportInputSchema = z.strictObject({
  snps: snpsSchema,
  wgs_variant_calls: wgsVariantCallsSchema.optional(),
  upload_meta: uploadMetaSchema.optional(),
  analysis_context: analysisContextSchema.optional(),
  report_id: z
    .string()
    .regex(REPORT_ID_PATTERN, "report_id must be a lowercase slug, for example 'core_systems'.")
    .describe(
      "Optional report selector. Omit to let the backend target the account's primary report; this is not an identity or account claim.",
    )
    .optional(),
  import_request_id: z
    .string()
    .min(8)
    .max(128)
    .describe(
      "Idempotency key, generated once per import attempt by the caller. A retry with the same key returns the existing result instead of creating another analysis.",
    ),
});

/**
 * Shared structured error shape returned inside the envelope.
 *
 * @deprecated Prefer `errorOutputSchema` from `./outputs.js`; kept as an alias so
 * existing imports keep working.
 */
export const toolErrorOutputSchema = errorOutputSchema;

/**
 * Envelope factory: one concrete output schema per tool.
 *
 * The MCP `outputSchema` must describe a JSON object, so the envelope is a
 * single object schema whose `data` is typed per tool and whose `error` is the
 * structured application error. The `ok` discriminator is enforced in the
 * schema itself, so an invalid combination (`ok: true` with an error, or
 * `ok: false` with data) fails validation rather than passing as a permissive
 * record.
 */
export function envelopeOf<T extends z.ZodTypeAny>(data: T) {
  return z
    .object({
      contract_version: z.string(),
      analysis_version: z.string().nullable(),
      ok: z.boolean(),
      data: data.nullable(),
      error: errorOutputSchema.nullable(),
    })
    .superRefine((value, ctx) => {
      const envelope = value as unknown as { ok: boolean; data: unknown; error: unknown };
      if (envelope.ok) {
        if (envelope.error !== null) {
          ctx.addIssue({
            code: "custom",
            path: ["error"],
            message: "A successful envelope must not carry an error.",
          });
        }
        if (envelope.data === null) {
          ctx.addIssue({
            code: "custom",
            path: ["data"],
            message: "A successful envelope must carry data.",
          });
        }
        return;
      }
      if (envelope.data !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["data"],
          message: "A failed envelope must carry null data.",
        });
      }
      if (envelope.error === null) {
        ctx.addIssue({
          code: "custom",
          path: ["error"],
          message: "A failed envelope must carry a structured error.",
        });
      }
    });
}

export const analysisStatusOutputSchema = envelopeOf(analysisStatusDataSchema);
export const analysisContextOutputSchema = envelopeOf(analysisContextDataSchema);
export const hypothesisListOutputSchema = envelopeOf(hypothesisListDataSchema);
export const explainHypothesisOutputSchema = envelopeOf(explainHypothesisDataSchema);
export const supportingEvidenceOutputSchema = envelopeOf(supportingEvidenceDataSchema);
export const geneticContextOutputSchema = envelopeOf(geneticContextDataSchema);
export const showAnalysisOverviewOutputSchema = envelopeOf(showAnalysisOverviewDataSchema);
export const dnaImportOutputSchema = envelopeOf(dnaImportDataSchema);
export const snpCatalogOutputSchema = envelopeOf(snpCatalogDataSchema);
export const createReportOutputSchema = envelopeOf(createReportDataSchema);
