// GENERATED FILE - DO NOT EDIT.
// Vendored from front-end-web/src/genomics by scripts/sync-genomics.mjs.
// Edit the upstream module (and re-run sync:genomics) instead.
// Shared parse loop: consumes a line iterable and returns the flat SNP map.
//
// Used by both the main-thread fallback path (src/genomics/index.js) and the
// Web Worker path (src/genomics/parse.worker.js) so there is a single source of
// truth for provider detection and per-line parsing.

import { detectProvider, detectBuild } from './detect';
import { parse23andMeLine } from './parse23andMe';
import { parseAncestryLine } from './parseAncestry';
import { parseVcfLine } from './parseVcf';

export const PROVIDER_LABELS = { vcf: 'WGS', '23andme': '23andMe', ancestry: 'Ancestry' };

export async function parseLines(iterable, indexes) {
  const snps = {};
  const wgsVariantCalls = {};
  const headerLines = [];
  let provider = null;
  let build = 'GRCh38';
  let totalLines = 0;

  for await (const line of iterable) {
    if (line.startsWith('#')) {
      if (headerLines.length < 500) headerLines.push(line);
      continue;
    }
    if (!line.trim()) continue;

    if (!provider) {
      provider = detectProvider(headerLines, line);
      build = provider === 'vcf' ? detectBuild(headerLines) : 'GRCh38';
    }

    totalLines += 1;

    if (provider === 'vcf') {
      parseVcfLine(line, { indexes, snps, build, wgsVariantCalls });
    } else if (provider === 'ancestry') {
      parseAncestryLine(line, { indexes, snps });
    } else {
      parse23andMeLine(line, { indexes, snps });
    }
  }

  return { snps, provider, totalLines, wgsVariantCalls };
}
