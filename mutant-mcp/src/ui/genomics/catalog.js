// GENERATED FILE - DO NOT EDIT.
// Vendored from front-end-web/src/genomics by scripts/sync-genomics.mjs.
// Edit the upstream module (and re-run sync:genomics) instead.
// Fetch the SNP catalog from the backend and build O(1) matching indexes.

import { fetchSnpCatalog } from '../api';
import { normalizeChrom } from './normalize';

let cachedCatalog = null;
let cachedPromise = null;

export function normalizeRsid(id) {
  return String(id || '').trim().toLowerCase();
}

// Fetch once per session. The catalog is keyed by primary rsID and includes
// aliases plus per-build reference alleles (see frontend-genome-parsing.md).
export async function fetchCatalog() {
  if (cachedCatalog) return cachedCatalog;
  if (!cachedPromise) {
    cachedPromise = (async () => {
      const catalog = await fetchSnpCatalog();
      cachedCatalog = catalog || {};
      return cachedCatalog;
    })().catch((err) => {
      // Never cache a rejected fetch. Otherwise one transient failure (network
      // blip, token refresh race) poisons every subsequent parse for the life
      // of the page, which surfaces as "works once, then stalls" until reload.
      cachedPromise = null;
      throw err;
    });
  }
  return cachedPromise;
}

// Build the non-SNV capture target map from marker definitions that carry a
// valid `wgs_capture` object. The marker-definition API is the only source of
// truth; unsupported metadata is skipped without adding any fallback rsIDs.
function buildWgsCaptureIndexes(snps) {
  const wgsCaptureById = new Map();
  const wgsCaptureRanges = [];
  // Ranges keyed by chromosome so the per-line capture check only ever scans
  // the (few) ranges registered for the current chromosome instead of every
  // target's range on every line of a multi-million-line VCF.
  const wgsCaptureRangesByChrom = new Map();

  for (const [primary, meta] of Object.entries(snps || {})) {
    const wc = meta && meta.wgs_capture;
    if (!wc || wc.schema_version !== 1 || wc.variant_class !== 'non_snv' || wc.capture_mode !== 'raw_vcf_record') {
      continue;
    }

    const rsid = normalizeRsid(primary);
    const chrom = normalizeChrom(meta && meta.chromosome);
    const entry = { rsid, ranges: {} };

    for (const [build, range] of [['GRCh37', wc.capture_range_GRCh37], ['GRCh38', wc.capture_range_GRCh38]]) {
      if (range && chrom && Number.isFinite(Number(range.start)) && Number.isFinite(Number(range.end))) {
        const r = { chrom, start: Number(range.start), end: Number(range.end) };
        entry.ranges[build] = r;
        const indexed = { build, chrom, start: r.start, end: r.end, rsid };
        wgsCaptureRanges.push(indexed);
        let perChrom = wgsCaptureRangesByChrom.get(chrom);
        if (!perChrom) { perChrom = []; wgsCaptureRangesByChrom.set(chrom, perChrom); }
        perChrom.push(indexed);
      }
    }

    wgsCaptureById.set(rsid, entry);
  }

  return { wgsCaptureById, wgsCaptureRanges, wgsCaptureRangesByChrom };
}

// Build reverse indexes for alias -> primary and coordinate -> primary.
export function buildCatalogIndexes(catalog) {
  const snps = (catalog && catalog.snps) || {};
  const aliases = (catalog && catalog.aliases) || {};
  const referenceAlleles = (catalog && catalog.reference_alleles) || {};

  const aliasToPrimary = new Map();
  const primarySet = new Set();
  const coordToRsid37 = new Map();
  const coordToRsid38 = new Map();
  const refAlleles = new Map();

  for (const [primary, meta] of Object.entries(snps)) {
    const canon = normalizeRsid(primary);
    primarySet.add(canon);

    const chrom = normalizeChrom(meta && meta.chromosome);
    if (chrom) {
      if (meta && Number.isFinite(Number(meta.position_GRCh37))) {
        coordToRsid37.set(`${chrom}:${meta.position_GRCh37}`, canon);
      }
      if (meta && Number.isFinite(Number(meta.position_GRCh38))) {
        coordToRsid38.set(`${chrom}:${meta.position_GRCh38}`, canon);
      }
    }
  }

  for (const [primary, list] of Object.entries(aliases)) {
    const canon = normalizeRsid(primary);
    if (!Array.isArray(list)) continue;
    for (const alias of list) {
      if (!alias) continue;
      const key = normalizeRsid(alias);
      if (!aliasToPrimary.has(key)) aliasToPrimary.set(key, canon);
    }
  }

  for (const [rsid, perBuild] of Object.entries(referenceAlleles)) {
    if (perBuild && typeof perBuild === 'object') {
      refAlleles.set(normalizeRsid(rsid), {
        GRCh37: perBuild.GRCh37 ? String(perBuild.GRCh37).toUpperCase() : undefined,
        GRCh38: perBuild.GRCh38 ? String(perBuild.GRCh38).toUpperCase() : undefined,
      });
    }
  }

  const { wgsCaptureById, wgsCaptureRanges, wgsCaptureRangesByChrom } = buildWgsCaptureIndexes(snps);

  return {
    aliasToPrimary,
    primarySet,
    coordToRsid37,
    coordToRsid38,
    referenceAlleles: refAlleles,
    wgsCaptureById,
    wgsCaptureRanges,
    wgsCaptureRangesByChrom,
  };
}

// Resolve an rsID (possibly an alias) to its primary rsID, or null.
export function resolvePrimary(id, indexes) {
  const key = normalizeRsid(id);
  if (indexes.primarySet.has(key)) return key;
  return indexes.aliasToPrimary.get(key) ?? null;
}
