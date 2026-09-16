// GENERATED FILE - DO NOT EDIT.
// Vendored from front-end-web/src/genomics by scripts/sync-genomics.mjs.
// Edit the upstream module (and re-run sync:genomics) instead.
// Ancestry raw data line parser: rsid, chromosome, position, allele1, allele2 (5 columns).

import { normalizeGenotype } from './normalize';
import { resolvePrimary } from './catalog';

export function parseAncestryLine(line, ctx) {
  const parts = line.split('\t');
  if (parts.length < 5) return;

  const primary = resolvePrimary(parts[0], ctx.indexes);
  if (!primary) return;

  const gt = normalizeGenotype(parts[3] + parts[4]);
  if (gt) ctx.snps[primary] = gt;
}
