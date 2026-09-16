// Shared parsing core for the Apps SDK DNA import component.
//
// This is glue, not parsing: every format decision, coordinate lookup, genotype
// normalization, and non-SNV capture rule lives in the vendored shared processor
// (src/ui/genomics/*, synced from front-end-web/src/genomics by
// scripts/sync-genomics.mjs). This module only wires that processor to a catalog
// the component already holds.
//
// It is the single implementation behind both execution paths in parseFile.js:
// the Web Worker (`cooperative: false`) and the main-thread fallback
// (`cooperative: true`). The two entries must not differ in any other way, and
// tests/parse-parity.test.ts enforces that.
//
// It differs from the portal's src/genomics/index.js in one way: the catalog is
// injected instead of fetched. The component receives it from the
// `get_snp_catalog` MCP tool, so the vendored `catalog.js` `fetchCatalog` path
// (and its portal HTTP client) is never reached.

import { buildCatalogIndexes } from "../genomics/catalog.js";
import { detectBuild } from "../genomics/detect.js";
import { parseLines, PROVIDER_LABELS } from "../genomics/parse.js";
import { readLines, supportsStreaming } from "../genomics/stream.js";

/** Provider label the backend uses for sequencing input. */
export const WGS_PROVIDER = "WGS";

/** Cap on header lines retained for build detection, mirroring parseLines. */
const MAX_HEADER_LINES = 500;

/**
 * Tee the line stream so we can sniff the VCF header for the reference build
 * without re-implementing any detection: `detectBuild` comes from the shared
 * processor and is given exactly the header lines `parseLines` would have seen.
 */
async function* capturingHeaders(iterable, sink) {
  for await (const line of iterable) {
    if (line.startsWith("#")) {
      if (sink.length < MAX_HEADER_LINES) sink.push(line);
    }
    yield line;
  }
}

/**
 * Parse a raw DNA file in the browser and reduce it to Mutant-relevant variants.
 *
 * The raw file is read and discarded locally: only the returned normalized
 * `snps` / `wgsVariantCalls` maps ever leave this function.
 *
 * @param {File} file - raw file chosen by the user.
 * @param {object} options
 * @param {object} options.catalog - SNP catalog from `get_snp_catalog`.
 * @param {(percent: number) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.cooperative] - let the reader yield to the event loop.
 *   True on the main thread (keeps the iframe painting), false inside a worker
 *   (no UI to starve, and `setTimeout` is throttled in background tabs).
 */
export async function parseDnaFileCore(
  file,
  { catalog, onProgress, signal, cooperative = true } = {},
) {
  const fileName = (file && file.name) || "";
  const fileSizeBytes = (file && file.size) || 0;

  if (!supportsStreaming()) {
    // Nothing is uploaded as a fallback: the raw file must never leave the
    // browser context, so the component reports this as an unsupported client.
    return {
      supported: false,
      snps: {},
      wgsVariantCalls: {},
      provider: WGS_PROVIDER,
      providerLabel: WGS_PROVIDER,
      genomeBuild: null,
      fileName,
      fileSizeBytes,
      coverage: { matched: 0, total: 0 },
      totalLines: 0,
    };
  }

  const indexes = buildCatalogIndexes(catalog || {});
  const headerLines = [];
  const { snps, provider, totalLines, wgsVariantCalls } = await parseLines(
    capturingHeaders(readLines(file, { onProgress, signal, cooperative }), headerLines),
    indexes,
  );

  const providerLabel = PROVIDER_LABELS[provider] || "23andMe";
  const isWgs = providerLabel === WGS_PROVIDER;

  // A genome build is only meaningful for coordinate-addressed sequencing input;
  // microarray files are matched by rsID, so reporting a build there would imply
  // a precision the parse does not use.
  const genomeBuild = isWgs ? detectBuild(headerLines) : null;

  return {
    supported: true,
    snps,
    wgsVariantCalls: wgsVariantCalls || {},
    provider: providerLabel,
    providerLabel,
    genomeBuild,
    fileName,
    fileSizeBytes,
    coverage: { matched: Object.keys(snps).length, total: indexes.primarySet.size },
    totalLines,
  };
}
