import { z } from "zod";

/**
 * Per-tool input schemas. Every tool takes a JSON object (never a scalar) and
 * rejects unknown properties. No tool accepts an analysis id, account, or plan.
 */

const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(50)
  .describe("Maximum number of items to return (1-50).")
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

export const getAnalysisStatusInputSchema = {};

export const getAnalysisContextInputSchema = {};

export const listHealthHypothesesInputSchema = {
  query: z
    .string()
    .min(1)
    .max(120)
    .describe("Optional catalog-topic keyword search across hypothesis names and summaries.")
    .optional(),
  module_id: z
    .string()
    .min(1)
    .max(160)
    .describe("Optional filter to hypotheses associated with a module id.")
    .optional(),
  limit: limitSchema,
  cursor: cursorSchema,
};

export const getHypothesisDetailsInputSchema = {
  hypothesis_id: hypothesisIdSchema,
};

export const getSupportingEvidenceInputSchema = {
  hypothesis_id: hypothesisIdSchema,
  kind: z
    .enum(["patterns", "variants", "sources"])
    .describe("Evidence kind to return. Defaults to 'patterns'.")
    .optional(),
  pattern_id: z
    .string()
    .min(1)
    .max(160)
    .describe("Optional pattern id to restrict the evidence to a single matched pattern.")
    .optional(),
  limit: limitSchema,
  cursor: cursorSchema,
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
  limit: limitSchema,
  cursor: cursorSchema,
};

/**
 * Shared structured error shape returned inside the envelope.
 */
export const toolErrorOutputSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  next_action: z.string().optional(),
  required_plan: z.string().optional(),
  upgrade_url: z.string().optional(),
  retry_after_seconds: z.number().optional(),
});

/**
 * Shared `ToolResponse` envelope. `data` is intentionally permissive: each tool
 * returns a different object, while the envelope itself is uniform.
 */
export const toolResponseOutputSchema = z.object({
  contract_version: z.string(),
  analysis_version: z.string().nullable(),
  ok: z.boolean(),
  data: z.record(z.string(), z.unknown()).nullable(),
  error: toolErrorOutputSchema.nullable(),
});
