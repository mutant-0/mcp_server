import { z } from "zod";

export const consentPurposeSchema = z.enum(["genetic_processing", "chatgpt_sharing"]);
export const getConsentInputSchema = z.object({}).strict();
export const saveConsentInputSchema = z
  .object({
    notice_version: z.string().min(1).max(32),
    purposes: z
      .array(consentPurposeSchema)
      .min(1)
      .max(2)
      .refine((p) => new Set(p).size === p.length),
  })
  .strict();
export const consentDataSchema = z
  .object({
    notice: z.object({
      version: z.string().min(1).max(32),
      summary: z.string(),
      sections: z.array(z.object({ heading: z.string(), body: z.string() })),
    }),
    purposes: z
      .array(
        z.object({
          purpose: consentPurposeSchema,
          status: z.enum(["none", "accepted", "withdrawn"]),
          notice_version: z.string().nullable(),
          accepted_at: z.string().nullable(),
          withdrawn_at: z.string().nullable(),
          current: z.boolean(),
        }),
      )
      .length(2)
      .refine(
        (rows) =>
          new Set(rows.map((row) => row.purpose)).size === 2 &&
          rows.every((row) => !row.current || row.status === "accepted"),
      ),
  })
  .refine((data) =>
    data.purposes.every((row) => !row.current || row.notice_version === data.notice.version),
  );
export type ConsentData = z.infer<typeof consentDataSchema>;
