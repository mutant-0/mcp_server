// GENERATED FILE - DO NOT EDIT.
// Vendored from front-end-web/src/genomics by scripts/sync-genomics.mjs.
// Edit the upstream module (and re-run sync:genomics) instead.
// 23andMe raw data line parser: rsid, chromosome, position, genotype (4 columns).

import { normalizeGenotype } from './normalize';
import { resolvePrimary } from './catalog';

export function parse23andMeLine(line, ctx) {
  const parts = line.split('\t');
  if (parts.length < 4) return;

  const primary = resolvePrimary(parts[0], ctx.indexes);
  if (!primary) return;

  const gt = normalizeGenotype(parts[3]);
  if (gt) ctx.snps[primary] = gt;
}
