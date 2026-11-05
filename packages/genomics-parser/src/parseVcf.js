// VCF/gVCF variant line parser: coordinate-addressed matching against the catalog.

import { normalizeChrom, normalizeGenotype } from './normalize';
import { resolvePrimary, normalizeRsid } from './catalog';
import { recordSexChromosomeEvidence } from './sexChromosome';

// Resolve a GT field against [REF, ...ALT] into a normalized genotype, or null.
// Handles multi-allelic, haploid (single index -> homozygous), and phased "|" ==
// unphased "/". No-call / missing / multi-base alleles return null.
// Exported so sex-chromosome evidence collection resolves GT identically.
export function genotypeFromGt(ref, alts, format, sample) {
  const gtIndex = format.split(':').indexOf('GT');
  if (gtIndex < 0) return null;

  const gt = (sample.split(':')[gtIndex] || '').trim();
  if (!gt || gt.includes('.')) return null; // missing / no-call

  const alleleOptions = [ref, ...alts.split(',')];
  let idxs = gt.split(/[/|]/).map(Number);
  if (idxs.length === 1) idxs = [idxs[0], idxs[0]]; // haploid -> homozygous
  if (idxs.length !== 2) return null;
  if (idxs.some((i) => !Number.isInteger(i) || i < 0 || i >= alleleOptions.length)) return null;

  const g1 = alleleOptions[idxs[0]];
  const g2 = alleleOptions[idxs[1]];
  if (!g1 || !g2) return null;
  return normalizeGenotype(g1 + g2);
}

// Resolve which API-configured non-SNV targets a VCF row belongs to.
// Matches by VCF ID column (semicolon-delimited) and by build/chromosome
// inclusive capture range. Returns a Set of primary rsIDs (possibly empty).
//
// Hot path: this runs once per VCF line. It must not allocate arrays/Sets or
// scan every target's range on the common line (ID ".", chromosome with no
// capture targets), or large WGS/gVCF files thrash the GC and stall.
const EMPTY_WGS_TARGETS = new Set();

export function matchWgsCaptureTargets(ctx, chrom, pos, idColumn) {
  const indexes = (ctx && ctx.indexes) || {};
  let targets = null;

  // Range match: only scan the ranges registered for this chromosome.
  const byChrom = indexes.wgsCaptureRangesByChrom;
  if (byChrom && byChrom.size) {
    const ranges = byChrom.get(chrom);
    if (ranges) {
      for (const range of ranges) {
        if (range.build === ctx.build && pos >= range.start && pos <= range.end) {
          if (!targets) targets = new Set();
          targets.add(range.rsid);
        }
      }
    }
  }

  // Explicit ID match (semicolon-delimited). Rare: most rows use "." for ID,
  // so avoid tokenizing in the common case.
  const raw = idColumn == null ? '' : String(idColumn);
  if (raw && raw !== '.') {
    const byId = indexes.wgsCaptureById;
    if (byId && byId.size) {
      const tokens = raw.indexOf(';') === -1 ? [raw] : raw.split(';');
      for (const token of tokens) {
        const entry = byId.get(normalizeRsid(token));
        if (entry) {
          if (!targets) targets = new Set();
          targets.add(entry.rsid);
        }
      }
    }
  }

  return targets || EMPTY_WGS_TARGETS;
}

// Build a single `wgs_variant_call.records` entry from a VCF row, preserving
// native REF/ALT/GT and the limited quality fields defined by the contract.
// No INFO or FORMAT maps are retained.
export function buildWgsVariantCallRecord(parts, chrom, pos) {
  const ref = (parts[3] || '').trim().toUpperCase();
  const altRaw = (parts[4] || '').trim().toUpperCase();
  const alts = altRaw ? altRaw.split(',') : [];
  const idRaw = (parts[2] || '').trim();

  const format = (parts[8] || '').split(':');
  const sample = (parts[9] || '').split(':');

  let gt = null;
  let phased = false;
  const gtIndex = format.indexOf('GT');
  if (gtIndex >= 0) {
    const token = (sample[gtIndex] || '').trim();
    if (token) {
      gt = token;
      phased = token.includes('|');
    }
  }

  const record = {
    chromosome: chrom,
    position: pos,
    vcf_id: idRaw && idRaw !== '.' ? idRaw : null,
    ref,
    alts,
    gt,
    phased,
  };

  // FILTER (column 6) — preserve when available, omit for "." / empty.
  const filterRaw = (parts[6] || '').trim();
  if (filterRaw && filterRaw !== '.') record.filter = filterRaw;

  // QUAL (column 5) — numeric when finite, null for "." rather than zero.
  const qualRaw = (parts[5] || '').trim();
  if (qualRaw === '' || qualRaw === '.') {
    record.qual = null;
  } else {
    const q = Number(qualRaw);
    if (Number.isFinite(q)) record.qual = q;
    else record.qual = null;
  }

  // GQ — extract only the sample's GQ when present and not missing.
  const gqIndex = format.indexOf('GQ');
  if (gqIndex >= 0) {
    const raw = (sample[gqIndex] || '').trim();
    if (raw && raw !== '.') {
      const gq = Number(raw);
      if (Number.isFinite(gq)) record.gq = gq;
    }
  }

  // DP — extract only the sample's DP when present and not missing.
  const dpIndex = format.indexOf('DP');
  if (dpIndex >= 0) {
    const raw = (sample[dpIndex] || '').trim();
    if (raw && raw !== '.') {
      const dp = Number(raw);
      if (Number.isFinite(dp)) record.dp = dp;
    }
  }

  // AD — extract only the sample's complete AD array when present.
  const adIndex = format.indexOf('AD');
  if (adIndex >= 0) {
    const raw = (sample[adIndex] || '').trim();
    if (raw && raw !== '.') {
      const ad = raw.split(',').map(Number);
      if (ad.some((n) => Number.isFinite(n))) record.ad = ad;
    }
  }

  return record;
}

function addWgsCaptureRecord(ctx, rsid, record, inferredReference = false) {
  if (!ctx.wgsVariantCalls) return;
  const existing = ctx.wgsVariantCalls[rsid];
  if (inferredReference && existing) return;
  if (!existing) {
    ctx.wgsVariantCalls[rsid] = {
      schema_version: 1,
      source_format: 'vcf',
      genome_build: ctx.build,
      records: [],
    };
  }
  const records = ctx.wgsVariantCalls[rsid].records;
  if (!inferredReference) {
    // An actual allele row takes precedence over a reference block.
    ctx.wgsVariantCalls[rsid].records = records.filter((r) => !r.inferred_reference_block);
    if (ctx.inferredReferenceCalls) delete ctx.inferredReferenceCalls[rsid];
  }
  ctx.wgsVariantCalls[rsid].records.push(inferredReference
    ? { ...record, inferred_reference_block: true }
    : record);
}

function referenceDepth(format, sample) {
  const keys = format.split(':');
  const values = sample.split(':');
  const minDp = values[keys.indexOf('MIN_DP')];
  const dp = values[keys.indexOf('DP')];
  const depth = Number(minDp && minDp !== '.' ? minDp : dp);
  return Number.isFinite(depth) ? depth : 0;
}

export function parseVcfLine(line, ctx) {
  const parts = line.split('\t');
  if (parts.length < 10) return;

  const chrom = normalizeChrom(parts[0]);
  const pos = Number(parts[1]);
  if (!chrom || !Number.isFinite(pos)) return;

  const ref = (parts[3] || '').trim().toUpperCase();
  const alts = (parts[4] || '').trim().toUpperCase();
  const info = parts[7] || '';
  const format = parts[8] || '';
  const sample = parts[9] || '';
  const referenceOnlyAlt = alts === '.' || alts === '<NON_REF>' || alts === '<*>';

  // A block's REF belongs to POS only. Use the catalog's base for each interior
  // target, and retain provenance so these calls are distinguishable downstream.
  const endMatch = info.match(/END=(\d+)/);
  if (endMatch && Number(endMatch[1]) > pos) {
    const end = Number(endMatch[1]);
    if (parts[6] !== 'PASS' || !referenceOnlyAlt) return;
    const formatKeys = format.split(':');
    const sampleValues = sample.split(':');
    const field = (key) => sampleValues[formatKeys.indexOf(key)];
    const gt = field('GT');
    const haploidReference = gt === '0' && (chrom === 'X' || chrom === 'Y' || chrom === 'MT');
    if (gt !== '0/0' && gt !== '0|0' && !haploidReference) return;
    const minDepth = Number(field('MIN_DP'));
    // The portal's genome-parser infers a trusted catalog reference genotype
    // from a covering block even when its minimum depth is below ten.
    if (!Number.isInteger(minDepth) || minDepth < 0) return;
    const rawGq = field('GQ');
    const gq = rawGq != null && rawGq !== '.' && rawGq !== '' && Number.isFinite(Number(rawGq)) ? Number(rawGq) : null;
    const positions = (ctx.build === 'GRCh37' ? ctx.indexes.positionsByChrom37 : ctx.indexes.positionsByChrom38)?.get(chrom) || [];
    let low = 0;
    let high = positions.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (positions[mid][0] < pos) low = mid + 1;
      else high = mid;
    }
    for (let i = low; i < positions.length && positions[i][0] <= end; i += 1) {
      const rsid = positions[i][1];
      const base = ctx.indexes.referenceAlleles.get(rsid)?.[ctx.build];
      if (!/^[ACGT]$/.test(base || '') || ctx.explicitSnps?.has(rsid)) continue;
      if (ctx.indexes.wgsCaptureById?.has(rsid)) {
        addWgsCaptureRecord(ctx, rsid, {
          chromosome: chrom, position: positions[i][0], vcf_id: null,
          ref: base, alts: ['.'], gt: '0/0', phased: false,
          filter: 'PASS', dp: minDepth, gq,
        }, true);
        if (ctx.inferredReferenceCalls && ctx.wgsVariantCalls?.[rsid]?.records[0]?.inferred_reference_block) {
          ctx.inferredReferenceCalls[rsid] = { min_dp: minDepth, gq, ploidy: 2 };
        }
        continue;
      }
      ctx.snps[rsid] = base + base;
      if (ctx.inferredReferenceCalls) ctx.inferredReferenceCalls[rsid] = { min_dp: minDepth, gq, ploidy: haploidReference ? 1 : 2 };
    }
    return;
  }

  // A single-position hom-ref gVCF row can establish the reference genotype
  // at an exact registered non-SNV locus. A nearby row cannot.
  if (referenceOnlyAlt) {
    if (parts[6] !== 'PASS' || !['0/0', '0|0'].includes(sample.split(':')[format.split(':').indexOf('GT')])) return;
    const rsid = ctx.indexes[ctx.build === 'GRCh37' ? 'coordToRsid37' : 'coordToRsid38']?.get(`${chrom}:${pos}`);
    const base = ctx.indexes.referenceAlleles.get(rsid)?.[ctx.build];
    const depth = referenceDepth(format, sample);
    if (ctx.indexes.wgsCaptureById?.has(rsid) && /^[ACGT]$/.test(base || '') && ref === base && depth >= 10) {
      const rawGq = sample.split(':')[format.split(':').indexOf('GQ')];
      const gq = rawGq && rawGq !== '.' && Number.isFinite(Number(rawGq)) ? Number(rawGq) : null;
      addWgsCaptureRecord(ctx, rsid, {
        chromosome: chrom, position: pos, vcf_id: null,
        ref, alts: ['.'], gt: '0/0', phased: false,
        filter: 'PASS', dp: depth, gq,
      }, true);
      if (ctx.inferredReferenceCalls && ctx.wgsVariantCalls?.[rsid]?.records[0]?.inferred_reference_block) {
        ctx.inferredReferenceCalls[rsid] = { min_dp: depth, gq, ploidy: 2 };
      }
    }
    return;
  }

  // Sex-chromosome evidence. Guarded to X/Y (and to explicit variant rows) so
  // the autosomal hot path of a multi-million-line VCF pays nothing. PAR
  // positions are excluded inside recordSexChromosomeEvidence.
  if ((chrom === 'X' || chrom === 'Y') && alts && alts !== '.') {
    recordSexChromosomeEvidence(
      ctx.sexChromosomeStats,
      chrom,
      genotypeFromGt(ref, alts, format, sample),
      pos
    );
  }

  // Non-SNV capture runs independently of (and before) the SNV coordinate
  // lookup, so variable-length alleles that the SNV compatibility check would
  // otherwise drop still yield a captured record.
  const idColumn = (parts[2] || '').trim();

  if (alts) {
    const captureTargets = matchWgsCaptureTargets(ctx, chrom, pos, idColumn);
    if (captureTargets.size) {
      if (!ctx.wgsVariantCalls) ctx.wgsVariantCalls = {};
      const record = buildWgsVariantCallRecord(parts, chrom, pos);
      for (const rsid of captureTargets) {
        addWgsCaptureRecord(ctx, rsid, record);
      }
    }
  }

  // Prefer the declared build's index, then fall back to the opposite build.
  const primaryIdx = ctx.build === 'GRCh37' ? 'coordToRsid37' : 'coordToRsid38';
  const altIdx = ctx.build === 'GRCh37' ? 'coordToRsid38' : 'coordToRsid37';
  const key = `${chrom}:${pos}`;

  let primary = ctx.indexes[primaryIdx].get(key);
  if (!primary) primary = ctx.indexes[altIdx].get(key);

  // Some VCFs carry an rsID in the ID column; honor it when coordinate lookup misses.
  if (!primary) {
    if (/^rs\d+$/i.test(idColumn)) primary = resolvePrimary(idColumn, ctx.indexes);
  }

  if (!primary) return;

  const gt = genotypeFromGt(ref, alts, format, sample);
  if (gt) {
    ctx.snps[primary] = gt;
    if (ctx.explicitSnps) ctx.explicitSnps.add(primary);
    if (ctx.inferredReferenceCalls) delete ctx.inferredReferenceCalls[primary];
  }
}
