// GENERATED FILE - DO NOT EDIT.
// Vendored from front-end-web/src/genomics by scripts/sync-genomics.mjs.
// Edit the upstream module (and re-run sync:genomics) instead.
// Sex-chromosome pattern inference, derived while the DNA file is parsed.
//
// Design constraints (see the browser sex-chromosome inference plan):
//   - Inference happens during the single existing parsing pass; there is no
//     second scan of the file and no extra I/O.
//   - The result lives in memory only. It is never written to localStorage,
//     sessionStorage, IndexedDB, analytics, telemetry, or the user profile, and
//     it is never displayed in the UI.
//   - The frontend only reports an inferred chromosome pattern (a biological
//     observation), never "gender". Downstream sex-specific scoring rules stay
//     entirely in the backend.
//   - This module contains no catalog/scoring knowledge. It counts callable
//     non-PAR X/Y loci from raw records, including records that are not in the
//     SNP catalog, because the catalog is far too small to characterize a
//     chromosome.
//
// Inference is intentionally biased toward "indeterminate": when the evidence
// conflicts or is thin, we return no usable signal rather than forcing XX/XY.

import { normalizeChrom } from './normalize';

/**
 * @typedef {'XX' | 'XY' | 'atypical' | 'indeterminate'} SexChromosomePattern
 * @typedef {'high' | 'moderate' | 'low'} SexChromosomeConfidence
 * @typedef {'microarray' | 'vcf'} SexChromosomeSourceType
 *
 * @typedef {Object} SexChromosomeInference
 * @property {SexChromosomePattern} pattern
 * @property {SexChromosomeConfidence} confidence
 *
 * @typedef {Object} SexChromosomeStats
 * @property {number} xCalledCount           Callable non-PAR X loci.
 * @property {number} xHeterozygousCount     Callable non-PAR X loci with two distinct alleles.
 * @property {number} yCalledCount           Callable Y loci (PAR included).
 * @property {number} informativeYCalledCount Callable non-PAR Y loci.
 */

// ---------------------------------------------------------------------------
// Tunable thresholds
//
// Every value below is deliberately a named constant so it can be tuned against
// real fixtures without touching the classification flow. Thresholds are chosen
// to fail toward "indeterminate" rather than to force a wrong XX/XY.
// ---------------------------------------------------------------------------

// A single stray/noisy chromosome-Y call must never classify XY, so XY requires
// a real plurality of independently callable non-PAR Y loci.
export const MIN_INFORMATIVE_Y_CALLS_FOR_XY = 6;

// Microarray platforms occasionally emit one spurious Y call (probe cross-talk,
// mapping error). A single call is tolerated for XX; the "no Y" branch is not
// reachable once yCalledCount exceeds this.
export const MAX_BACKGROUND_Y_CALLS_FOR_XX = 1;

// A hemizygous X (single X) shows essentially no heterozygosity outside the
// pseudoautosomal regions. The small allowance absorbs genotype-calling error.
export const MAX_X_HET_RATE_FOR_XY = 0.02;

// A diploid X is expected to carry a substantial heterozygous fraction. This
// floor is set well below the observed range for XX microarray data so noise,
// imputation, and low-coverage stretches do not push XX to indeterminate.
export const MIN_X_HET_RATE_FOR_XX = 0.1;

// Heterozygosity over a handful of X markers is statistically meaningless. Below
// this many callable non-PAR X loci the X signal is treated as unusable, which
// also makes tiny/empty files resolve to "indeterminate".
export const MIN_X_CALLS_FOR_CONFIDENT_CLASSIFICATION = 30;

// ---------------------------------------------------------------------------
// Pseudoautosomal region (PAR) exclusion
//
// PAR1/PAR2 are homologous between X and Y and are present in two copies
// regardless of sex, so heterozygous calls there are expected for XY as well and
// must be excluded from X heterozygosity (numerator and denominator) and from
// the informative-Y count. Ranges are the union of GRCh37 and GRCh38 so that a
// file is handled correctly regardless of the detected build.
// ---------------------------------------------------------------------------

const X_PAR_RANGES = [
  [10001, 2781479], // PAR1 (GRCh38)
  [60001, 2699520], // PAR1 (GRCh37)
  [155701383, 156030895], // PAR2 (GRCh38)
  [154931044, 155260560], // PAR2 (GRCh37)
];

const Y_PAR_RANGES = [
  [10001, 2781479], // PAR1 (GRCh38)
  [60001, 2649520], // PAR1 (GRCh37)
  [56887903, 57217415], // PAR2 (GRCh38)
  [59034050, 59363566], // PAR2 (GRCh37)
];

function isInRanges(position, ranges) {
  for (let i = 0; i < ranges.length; i += 1) {
    const [start, end] = ranges[i];
    if (position >= start && position <= end) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Evidence collection
// ---------------------------------------------------------------------------

/** @returns {SexChromosomeStats} */
export function createSexChromosomeStats() {
  return {
    xCalledCount: 0,
    xHeterozygousCount: 0,
    yCalledCount: 0,
    informativeYCalledCount: 0,
  };
}

// Return the callable allele string (1-2 uppercase A/C/G/T bases) or null.
//
// Deliberately permissive about haploid calls: microarray files report a single
// base for hemizygous X/Y loci, and VCF GT resolution may normalize a haploid
// call. Deliberately strict about everything that is not a real call:
// "--", "00", ".", "./.", ".|.", "", whitespace-only, "II", "DD", and any
// indel/NO_CALL token all return null.
export function callableAlleles(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  if (!/^[ACGT]{1,2}$/.test(s)) return null;
  return s;
}

// Fold one parsed record into the running chromosome counters.
//
// Called from the per-format line parsers *before* catalog filtering, so Y
// evidence is not limited to the handful of Y markers in the SNP catalog.
// `stats` may be undefined (direct parser unit tests) and is then ignored.
export function recordSexChromosomeEvidence(stats, rawChrom, rawGenotype, rawPosition) {
  if (!stats) return;

  const chrom = normalizeChrom(rawChrom);
  if (chrom !== 'X' && chrom !== 'Y') return;

  const alleles = callableAlleles(rawGenotype);
  if (!alleles) return;

  const position = Number(rawPosition);
  const hasPosition = Number.isFinite(position) && position > 0;

  if (chrom === 'X') {
    // Exclude pseudoautosomal X: heterozygous calls there are normal for XY.
    if (hasPosition && isInRanges(position, X_PAR_RANGES)) return;
    stats.xCalledCount += 1;
    if (alleles.length === 2 && alleles[0] !== alleles[1]) stats.xHeterozygousCount += 1;
    return;
  }

  stats.yCalledCount += 1;
  // Only non-PAR Y loci are treated as informative for an XY pattern.
  if (!hasPosition || !isInRanges(position, Y_PAR_RANGES)) stats.informativeYCalledCount += 1;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function providerToSourceType(provider) {
  return String(provider || '').toLowerCase() === 'vcf' ? 'vcf' : 'microarray';
}

function result(pattern, confidence) {
  return { pattern, confidence };
}

/**
 * Single source of truth for turning chromosome stats into a pattern.
 *
 * @param {SexChromosomeStats} stats
 * @param {SexChromosomeSourceType} sourceType
 * @returns {SexChromosomeInference}
 */
export function inferSexChromosomePattern(stats, sourceType) {
  const s = stats || createSexChromosomeStats();

  const xCalledCount = Number(s.xCalledCount) || 0;
  const xHeterozygousCount = Number(s.xHeterozygousCount) || 0;
  const yCalledCount = Number(s.yCalledCount) || 0;
  const informativeYCalledCount = Number(s.informativeYCalledCount) || 0;

  const xHetRate = xCalledCount > 0 ? xHeterozygousCount / xCalledCount : null;
  const xEligible = xCalledCount >= MIN_X_CALLS_FOR_CONFIDENT_CLASSIFICATION;
  const strongY = informativeYCalledCount >= MIN_INFORMATIVE_Y_CALLS_FOR_XY;
  const noY = yCalledCount <= MAX_BACKGROUND_Y_CALLS_FOR_XX;

  if (sourceType === 'vcf') {
    if (strongY) {
      if (!xEligible) return result('XY', 'moderate');
      if (xHetRate <= MAX_X_HET_RATE_FOR_XY) return result('XY', 'high');
      if (xHetRate >= MIN_X_HET_RATE_FOR_XX) return result('atypical', 'moderate');
      return result('indeterminate', 'low');
    }
    // Variants-only VCFs omit reference calls, so the absence of Y records is
    // not evidence of a second X. Never infer XX from a VCF in this change.
    return result('indeterminate', 'low');
  }

  // Microarray (23andMe / Ancestry)
  if (strongY) {
    if (!xEligible) return result('XY', 'moderate');
    if (xHetRate <= MAX_X_HET_RATE_FOR_XY) return result('XY', 'high');
    if (xHetRate >= MIN_X_HET_RATE_FOR_XX) return result('atypical', 'moderate');
    return result('indeterminate', 'low');
  }

  if (noY) {
    if (xEligible && xHetRate >= MIN_X_HET_RATE_FOR_XX) return result('XX', 'high');
    // No Y but an X that looks hemizygous is a conflicting signal, not XX.
    if (xEligible && xHetRate <= MAX_X_HET_RATE_FOR_XY) return result('atypical', 'moderate');
    return result('indeterminate', 'low');
  }

  return result('indeterminate', 'low');
}

// Backward-safe wrapper: inference must never break an otherwise valid import.
export function safeInferSexChromosomePattern(stats, provider) {
  try {
    return inferSexChromosomePattern(stats, providerToSourceType(provider));
  } catch {
    return result('indeterminate', 'low');
  }
}

// Map the in-memory inference to the minimal backend contract. Only the pattern
// and confidence leave the browser; raw counts and genotypes stay local.
export function buildAnalysisContext(inference) {
  const pattern = (inference && inference.pattern) || 'indeterminate';
  const confidence = (inference && inference.confidence) || 'low';
  return {
    sex_chromosome_pattern: pattern,
    sex_chromosome_confidence: confidence,
  };
}
