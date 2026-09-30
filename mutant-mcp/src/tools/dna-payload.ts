/**
 * Input projection for the DNA import payload (PRIV-03).
 *
 * `create_report` accepts the component's locally normalized variants. The
 * transport schema keeps each WGS record opaque (`z.record(z.string(), unknown)`)
 * so no VCF semantics are re-implemented in the MCP layer, which also means an
 * unexpected record property would be forwarded to the backend and persisted
 * verbatim. The reports-generator's normalizer only reads a small, fixed set of
 * VCF fields, so everything else — sample labels, INFO-derived annotations,
 * comments, quality columns, headers — is dropped here before transport.
 *
 * The allowlist below is the exact set of fields `core/wgs_normalizer.py`
 * consumes (`_validate_record`, `_validate_transport_entry`, `_resolve_*`):
 *   chromosome, position, ref, alts (or the `alt` alias), gt, filter.
 * The entry envelope keeps `schema_version`, `source_format`, and `genome_build`
 * because the normalizer validates all three.
 *
 * Upload metadata is limited to provenance that does not identify the person:
 * provider, format, build, and size. The original filename is never forwarded;
 * the local UI keeps it for the user's own review.
 */

/** VCF record fields the backend normalizer actually reads. */
export const WGS_RECORD_FIELDS = [
  "chromosome",
  "position",
  "ref",
  "alts",
  "alt",
  "gt",
  "filter",
] as const;

/** Entry-envelope fields the backend validates per target. */
const WGS_ENTRY_FIELDS = ["schema_version", "source_format", "genome_build"] as const;

/** Upload-metadata fields that carry no direct personal identifier. */
const UPLOAD_META_FIELDS = ["provider", "source_format", "genome_build", "file_size_bytes"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep only the approved VCF fields from one captured record. */
function projectWgsRecord(record: unknown): Record<string, unknown> | null {
  if (!isPlainObject(record)) return null;
  const projected: Record<string, unknown> = {};
  for (const field of WGS_RECORD_FIELDS) {
    if (field in record) projected[field] = record[field];
  }
  return projected;
}

/**
 * Project the optional `wgs_variant_calls` map onto the approved VCF boundary.
 * Returns `undefined` when the map is absent or empty so it can be omitted from
 * the forwarded payload entirely.
 */
export function projectWgsVariantCalls(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const projected: Record<string, unknown> = {};
  for (const [rsid, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) continue;
    const next: Record<string, unknown> = {};
    for (const field of WGS_ENTRY_FIELDS) {
      if (field in entry) next[field] = entry[field];
    }
    const records = Array.isArray(entry.records)
      ? entry.records
          .map((record) => projectWgsRecord(record))
          .filter((record): record is Record<string, unknown> => record !== null)
      : [];
    next.records = records;
    projected[rsid] = next;
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/**
 * Project `upload_meta` onto the non-identifying provenance boundary. The
 * filename is dropped even if a legacy caller still supplies it.
 */
export function projectUploadMeta(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const projected: Record<string, unknown> = {};
  for (const field of UPLOAD_META_FIELDS) {
    if (field in value) projected[field] = value[field];
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/**
 * Build the payload actually forwarded to the reports-generator. Every other
 * argument is passed through unchanged; only the two free-form containers are
 * projected.
 */
export function sanitizeCreateReportArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const forwarded: Record<string, unknown> = { ...args };
  const wgs = projectWgsVariantCalls(args.wgs_variant_calls);
  if (wgs) forwarded.wgs_variant_calls = wgs;
  else delete forwarded.wgs_variant_calls;

  const upload = projectUploadMeta(args.upload_meta);
  if (upload) forwarded.upload_meta = upload;
  else delete forwarded.upload_meta;

  return forwarded;
}
