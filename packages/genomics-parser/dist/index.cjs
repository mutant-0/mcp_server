var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.js
var index_exports = {};
__export(index_exports, {
  MAX_BACKGROUND_Y_CALLS_FOR_XX: () => MAX_BACKGROUND_Y_CALLS_FOR_XX,
  MAX_X_HET_RATE_FOR_XY: () => MAX_X_HET_RATE_FOR_XY,
  MIN_INFORMATIVE_Y_CALLS_FOR_XY: () => MIN_INFORMATIVE_Y_CALLS_FOR_XY,
  MIN_X_CALLS_FOR_CONFIDENT_CLASSIFICATION: () => MIN_X_CALLS_FOR_CONFIDENT_CLASSIFICATION,
  MIN_X_HET_RATE_FOR_XX: () => MIN_X_HET_RATE_FOR_XX,
  PARSER_VERSION: () => PARSER_VERSION,
  PROVIDER_LABELS: () => PROVIDER_LABELS,
  WGS_PROVIDER: () => WGS_PROVIDER,
  buildAnalysisContext: () => buildAnalysisContext,
  buildCatalogIndexes: () => buildCatalogIndexes,
  buildWgsVariantCallRecord: () => buildWgsVariantCallRecord,
  callableAlleles: () => callableAlleles,
  catalogFingerprint: () => catalogFingerprint,
  createSexChromosomeStats: () => createSexChromosomeStats,
  detectBuild: () => detectBuild,
  detectProvider: () => detectProvider,
  detectSexChromosomeContext: () => detectSexChromosomeContext,
  genotypeFromGt: () => genotypeFromGt,
  inferSexChromosomePattern: () => inferSexChromosomePattern,
  matchWgsCaptureTargets: () => matchWgsCaptureTargets,
  normalizeChrom: () => normalizeChrom,
  normalizeGenotype: () => normalizeGenotype,
  normalizeRsid: () => normalizeRsid,
  parse23andMeLine: () => parse23andMeLine,
  parseAncestryLine: () => parseAncestryLine,
  parseFile: () => parseFile,
  parseLines: () => parseLines,
  parseVcfLine: () => parseVcfLine,
  providerToSourceType: () => providerToSourceType,
  readLines: () => readLines,
  recordSexChromosomeEvidence: () => recordSexChromosomeEvidence,
  resolvePrimary: () => resolvePrimary,
  safeInferSexChromosomePattern: () => safeInferSexChromosomePattern,
  supportsStreaming: () => supportsStreaming
});
module.exports = __toCommonJS(index_exports);

// src/normalize.js
function normalizeChrom(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/^chr/i, "");
  s = s.toUpperCase();
  if (s === "M") s = "MT";
  if (s === "23") s = "X";
  if (s === "24") s = "Y";
  return s;
}
function normalizeGenotype(gt) {
  if (gt == null) return null;
  const s = String(gt).trim().toUpperCase().replace(/\s+/g, "");
  if (s.length !== 2) return null;
  if (!/^[ACGT]{2}$/.test(s)) return null;
  return s[0] <= s[1] ? s : s[1] + s[0];
}

// src/catalog.js
function normalizeRsid(id) {
  return String(id || "").trim().toLowerCase();
}
function buildWgsCaptureIndexes(snps) {
  const wgsCaptureById = /* @__PURE__ */ new Map();
  const wgsCaptureRanges = [];
  const wgsCaptureRangesByChrom = /* @__PURE__ */ new Map();
  for (const [primary, meta] of Object.entries(snps || {})) {
    const wc = meta && meta.wgs_capture;
    if (!wc || wc.schema_version !== 1 || wc.variant_class !== "non_snv" || wc.capture_mode !== "raw_vcf_record") {
      continue;
    }
    const rsid = normalizeRsid(primary);
    const chrom = normalizeChrom(meta && meta.chromosome);
    const entry = { rsid, ranges: {} };
    for (const [build, range] of [["GRCh37", wc.capture_range_GRCh37], ["GRCh38", wc.capture_range_GRCh38]]) {
      if (range && chrom && Number.isFinite(Number(range.start)) && Number.isFinite(Number(range.end))) {
        const r = { chrom, start: Number(range.start), end: Number(range.end) };
        entry.ranges[build] = r;
        const indexed = { build, chrom, start: r.start, end: r.end, rsid };
        wgsCaptureRanges.push(indexed);
        let perChrom = wgsCaptureRangesByChrom.get(chrom);
        if (!perChrom) {
          perChrom = [];
          wgsCaptureRangesByChrom.set(chrom, perChrom);
        }
        perChrom.push(indexed);
      }
    }
    wgsCaptureById.set(rsid, entry);
  }
  return { wgsCaptureById, wgsCaptureRanges, wgsCaptureRangesByChrom };
}
function buildCatalogIndexes(catalog) {
  const snps = catalog && catalog.snps || {};
  const aliases = catalog && catalog.aliases || {};
  const referenceAlleles = catalog && catalog.reference_alleles || {};
  const aliasToPrimary = /* @__PURE__ */ new Map();
  const primarySet = /* @__PURE__ */ new Set();
  const coordToRsid37 = /* @__PURE__ */ new Map();
  const coordToRsid38 = /* @__PURE__ */ new Map();
  const positionsByChrom37 = /* @__PURE__ */ new Map();
  const positionsByChrom38 = /* @__PURE__ */ new Map();
  const refAlleles = /* @__PURE__ */ new Map();
  for (const [primary, meta] of Object.entries(snps)) {
    const canon = normalizeRsid(primary);
    primarySet.add(canon);
    const chrom = normalizeChrom(meta && meta.chromosome);
    if (chrom) {
      if (meta && Number.isFinite(Number(meta.position_GRCh37))) {
        coordToRsid37.set(`${chrom}:${meta.position_GRCh37}`, canon);
        if (!positionsByChrom37.has(chrom)) positionsByChrom37.set(chrom, []);
        positionsByChrom37.get(chrom).push([Number(meta.position_GRCh37), canon]);
      }
      if (meta && Number.isFinite(Number(meta.position_GRCh38))) {
        coordToRsid38.set(`${chrom}:${meta.position_GRCh38}`, canon);
        if (!positionsByChrom38.has(chrom)) positionsByChrom38.set(chrom, []);
        positionsByChrom38.get(chrom).push([Number(meta.position_GRCh38), canon]);
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
    if (perBuild && typeof perBuild === "object") {
      refAlleles.set(normalizeRsid(rsid), {
        GRCh37: perBuild.GRCh37 ? String(perBuild.GRCh37).toUpperCase() : void 0,
        GRCh38: perBuild.GRCh38 ? String(perBuild.GRCh38).toUpperCase() : void 0
      });
    }
  }
  const { wgsCaptureById, wgsCaptureRanges, wgsCaptureRangesByChrom } = buildWgsCaptureIndexes(snps);
  for (const positions of [...positionsByChrom37.values(), ...positionsByChrom38.values()]) {
    positions.sort((a, b) => a[0] - b[0]);
  }
  return {
    aliasToPrimary,
    primarySet,
    coordToRsid37,
    coordToRsid38,
    positionsByChrom37,
    positionsByChrom38,
    referenceAlleles: refAlleles,
    wgsCaptureById,
    wgsCaptureRanges,
    wgsCaptureRangesByChrom
  };
}
function resolvePrimary(id, indexes) {
  const key = normalizeRsid(id);
  if (indexes.primarySet.has(key)) return key;
  return indexes.aliasToPrimary.get(key) ?? null;
}

// src/detect.js
function detectProvider(headerLines = [], firstDataLine = "") {
  const headerText = (headerLines || []).join("\n");
  const line = String(firstDataLine || "");
  const sniffText = `${headerText}
${line}`;
  const parts = line.split("	");
  if (/##fileformat=VCF/i.test(headerText)) return "vcf";
  if (/#CHROM\b/i.test(headerText)) return "vcf";
  if (parts.length >= 8) {
    const id = (parts[2] || "").trim();
    const ref = (parts[3] || "").trim().toUpperCase();
    const alt = (parts[4] || "").trim().toUpperCase();
    if ((id === "." || /^rs\d+/i.test(id)) && /^[ACGTN.]+$/.test(ref) && /^[ACGTN.,]+$/.test(alt)) {
      return "vcf";
    }
  }
  if (/allele1|allele2/i.test(sniffText)) return "ancestry";
  if (parts.length >= 5) {
    const a4 = (parts[3] || "").trim().toUpperCase();
    const a5 = (parts[4] || "").trim().toUpperCase();
    if (/^[ACGTDI0-]$/.test(a4) && /^[ACGTDI0-]$/.test(a5)) return "ancestry";
  }
  return "23andme";
}
function detectBuild(headerLines = []) {
  const text = (headerLines || []).join("\n").toLowerCase();
  if (/grch37|hg19|b37|hs37/.test(text)) return "GRCh37";
  if (/grch38|hg38|b38|hs38/.test(text)) return "GRCh38";
  return "GRCh38";
}

// src/sexChromosome.js
var MIN_INFORMATIVE_Y_CALLS_FOR_XY = 6;
var MAX_BACKGROUND_Y_CALLS_FOR_XX = 1;
var MAX_X_HET_RATE_FOR_XY = 0.02;
var MIN_X_HET_RATE_FOR_XX = 0.1;
var MIN_X_CALLS_FOR_CONFIDENT_CLASSIFICATION = 30;
var X_PAR_RANGES = [
  [10001, 2781479],
  // PAR1 (GRCh38)
  [60001, 2699520],
  // PAR1 (GRCh37)
  [155701383, 156030895],
  // PAR2 (GRCh38)
  [154931044, 155260560]
  // PAR2 (GRCh37)
];
var Y_PAR_RANGES = [
  [10001, 2781479],
  // PAR1 (GRCh38)
  [60001, 2649520],
  // PAR1 (GRCh37)
  [56887903, 57217415],
  // PAR2 (GRCh38)
  [59034050, 59363566]
  // PAR2 (GRCh37)
];
function isInRanges(position, ranges) {
  for (let i2 = 0; i2 < ranges.length; i2 += 1) {
    const [start, end] = ranges[i2];
    if (position >= start && position <= end) return true;
  }
  return false;
}
function createSexChromosomeStats() {
  return {
    xCalledCount: 0,
    xHeterozygousCount: 0,
    yCalledCount: 0,
    informativeYCalledCount: 0
  };
}
function callableAlleles(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, "");
  if (!s) return null;
  if (!/^[ACGT]{1,2}$/.test(s)) return null;
  return s;
}
function recordSexChromosomeEvidence(stats, rawChrom, rawGenotype, rawPosition) {
  if (!stats) return;
  const chrom = normalizeChrom(rawChrom);
  if (chrom !== "X" && chrom !== "Y") return;
  const alleles = callableAlleles(rawGenotype);
  if (!alleles) return;
  const position = Number(rawPosition);
  const hasPosition = Number.isFinite(position) && position > 0;
  if (chrom === "X") {
    if (hasPosition && isInRanges(position, X_PAR_RANGES)) return;
    stats.xCalledCount += 1;
    if (alleles.length === 2 && alleles[0] !== alleles[1]) stats.xHeterozygousCount += 1;
    return;
  }
  stats.yCalledCount += 1;
  if (!hasPosition || !isInRanges(position, Y_PAR_RANGES)) stats.informativeYCalledCount += 1;
}
function providerToSourceType(provider) {
  return String(provider || "").toLowerCase() === "vcf" ? "vcf" : "microarray";
}
function result(pattern, confidence) {
  return { pattern, confidence };
}
function inferSexChromosomePattern(stats, sourceType) {
  const s = stats || createSexChromosomeStats();
  const xCalledCount = Number(s.xCalledCount) || 0;
  const xHeterozygousCount = Number(s.xHeterozygousCount) || 0;
  const yCalledCount = Number(s.yCalledCount) || 0;
  const informativeYCalledCount = Number(s.informativeYCalledCount) || 0;
  const xHetRate = xCalledCount > 0 ? xHeterozygousCount / xCalledCount : null;
  const xEligible = xCalledCount >= MIN_X_CALLS_FOR_CONFIDENT_CLASSIFICATION;
  const strongY = informativeYCalledCount >= MIN_INFORMATIVE_Y_CALLS_FOR_XY;
  const noY = yCalledCount <= MAX_BACKGROUND_Y_CALLS_FOR_XX;
  if (sourceType === "vcf") {
    if (strongY) {
      if (!xEligible) return result("XY", "moderate");
      if (xHetRate <= MAX_X_HET_RATE_FOR_XY) return result("XY", "high");
      if (xHetRate >= MIN_X_HET_RATE_FOR_XX) return result("atypical", "moderate");
      return result("indeterminate", "low");
    }
    return result("indeterminate", "low");
  }
  if (strongY) {
    if (!xEligible) return result("XY", "moderate");
    if (xHetRate <= MAX_X_HET_RATE_FOR_XY) return result("XY", "high");
    if (xHetRate >= MIN_X_HET_RATE_FOR_XX) return result("atypical", "moderate");
    return result("indeterminate", "low");
  }
  if (noY) {
    if (xEligible && xHetRate >= MIN_X_HET_RATE_FOR_XX) return result("XX", "high");
    if (xEligible && xHetRate <= MAX_X_HET_RATE_FOR_XY) return result("atypical", "moderate");
    return result("indeterminate", "low");
  }
  return result("indeterminate", "low");
}
function safeInferSexChromosomePattern(stats, provider) {
  try {
    return inferSexChromosomePattern(stats, providerToSourceType(provider));
  } catch {
    return result("indeterminate", "low");
  }
}
var WIRE_PATTERN = {
  XX: "XX",
  XY: "XY",
  atypical: "ambiguous",
  indeterminate: "unknown"
};
var WIRE_CONFIDENCE = {
  high: "high",
  moderate: "medium",
  low: "low"
};
function buildAnalysisContext(inference) {
  const pattern = inference && inference.pattern || "indeterminate";
  const confidence = inference && inference.confidence || "low";
  return {
    sex_chromosome_pattern: WIRE_PATTERN[pattern] || "unknown",
    sex_chromosome_confidence: WIRE_CONFIDENCE[confidence] || "unknown"
  };
}

// src/parse23andMe.js
function parse23andMeLine(line, ctx) {
  const parts = line.split("	");
  if (parts.length < 4) return;
  recordSexChromosomeEvidence(ctx.sexChromosomeStats, parts[1], parts[3], parts[2]);
  const primary = resolvePrimary(parts[0], ctx.indexes);
  if (!primary) return;
  const gt = normalizeGenotype(parts[3]);
  if (gt) ctx.snps[primary] = gt;
}

// src/parseAncestry.js
function parseAncestryLine(line, ctx) {
  const parts = line.split("	");
  if (parts.length < 5) return;
  recordSexChromosomeEvidence(ctx.sexChromosomeStats, parts[1], parts[3] + parts[4], parts[2]);
  const primary = resolvePrimary(parts[0], ctx.indexes);
  if (!primary) return;
  const gt = normalizeGenotype(parts[3] + parts[4]);
  if (gt) ctx.snps[primary] = gt;
}

// src/parseVcf.js
function genotypeFromGt(ref, alts, format, sample) {
  const gtIndex = format.split(":").indexOf("GT");
  if (gtIndex < 0) return null;
  const gt = (sample.split(":")[gtIndex] || "").trim();
  if (!gt || gt.includes(".")) return null;
  const alleleOptions = [ref, ...alts.split(",")];
  let idxs = gt.split(/[/|]/).map(Number);
  if (idxs.length === 1) idxs = [idxs[0], idxs[0]];
  if (idxs.length !== 2) return null;
  if (idxs.some((i2) => !Number.isInteger(i2) || i2 < 0 || i2 >= alleleOptions.length)) return null;
  const g1 = alleleOptions[idxs[0]];
  const g2 = alleleOptions[idxs[1]];
  if (!g1 || !g2) return null;
  return normalizeGenotype(g1 + g2);
}
var EMPTY_WGS_TARGETS = /* @__PURE__ */ new Set();
function matchWgsCaptureTargets(ctx, chrom, pos, idColumn) {
  const indexes = ctx && ctx.indexes || {};
  let targets = null;
  const byChrom = indexes.wgsCaptureRangesByChrom;
  if (byChrom && byChrom.size) {
    const ranges = byChrom.get(chrom);
    if (ranges) {
      for (const range of ranges) {
        if (range.build === ctx.build && pos >= range.start && pos <= range.end) {
          if (!targets) targets = /* @__PURE__ */ new Set();
          targets.add(range.rsid);
        }
      }
    }
  }
  const raw = idColumn == null ? "" : String(idColumn);
  if (raw && raw !== ".") {
    const byId = indexes.wgsCaptureById;
    if (byId && byId.size) {
      const tokens = raw.indexOf(";") === -1 ? [raw] : raw.split(";");
      for (const token of tokens) {
        const entry = byId.get(normalizeRsid(token));
        if (entry) {
          if (!targets) targets = /* @__PURE__ */ new Set();
          targets.add(entry.rsid);
        }
      }
    }
  }
  return targets || EMPTY_WGS_TARGETS;
}
function buildWgsVariantCallRecord(parts, chrom, pos) {
  const ref = (parts[3] || "").trim().toUpperCase();
  const altRaw = (parts[4] || "").trim().toUpperCase();
  const alts = altRaw ? altRaw.split(",") : [];
  const idRaw = (parts[2] || "").trim();
  const format = (parts[8] || "").split(":");
  const sample = (parts[9] || "").split(":");
  let gt = null;
  let phased = false;
  const gtIndex = format.indexOf("GT");
  if (gtIndex >= 0) {
    const token = (sample[gtIndex] || "").trim();
    if (token) {
      gt = token;
      phased = token.includes("|");
    }
  }
  const record = {
    chromosome: chrom,
    position: pos,
    vcf_id: idRaw && idRaw !== "." ? idRaw : null,
    ref,
    alts,
    gt,
    phased
  };
  const filterRaw = (parts[6] || "").trim();
  if (filterRaw && filterRaw !== ".") record.filter = filterRaw;
  const qualRaw = (parts[5] || "").trim();
  if (qualRaw === "" || qualRaw === ".") {
    record.qual = null;
  } else {
    const q = Number(qualRaw);
    if (Number.isFinite(q)) record.qual = q;
    else record.qual = null;
  }
  const gqIndex = format.indexOf("GQ");
  if (gqIndex >= 0) {
    const raw = (sample[gqIndex] || "").trim();
    if (raw && raw !== ".") {
      const gq = Number(raw);
      if (Number.isFinite(gq)) record.gq = gq;
    }
  }
  const dpIndex = format.indexOf("DP");
  if (dpIndex >= 0) {
    const raw = (sample[dpIndex] || "").trim();
    if (raw && raw !== ".") {
      const dp = Number(raw);
      if (Number.isFinite(dp)) record.dp = dp;
    }
  }
  const adIndex = format.indexOf("AD");
  if (adIndex >= 0) {
    const raw = (sample[adIndex] || "").trim();
    if (raw && raw !== ".") {
      const ad = raw.split(",").map(Number);
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
      source_format: "vcf",
      genome_build: ctx.build,
      records: []
    };
  }
  const records = ctx.wgsVariantCalls[rsid].records;
  if (!inferredReference) {
    ctx.wgsVariantCalls[rsid].records = records.filter((r) => !r.inferred_reference_block);
    if (ctx.inferredReferenceCalls) delete ctx.inferredReferenceCalls[rsid];
  }
  ctx.wgsVariantCalls[rsid].records.push(inferredReference ? { ...record, inferred_reference_block: true } : record);
}
function referenceDepth(format, sample) {
  const keys = format.split(":");
  const values = sample.split(":");
  const minDp = values[keys.indexOf("MIN_DP")];
  const dp = values[keys.indexOf("DP")];
  const depth = Number(minDp && minDp !== "." ? minDp : dp);
  return Number.isFinite(depth) ? depth : 0;
}
function parseVcfLine(line, ctx) {
  const parts = line.split("	");
  if (parts.length < 10) return;
  const chrom = normalizeChrom(parts[0]);
  const pos = Number(parts[1]);
  if (!chrom || !Number.isFinite(pos)) return;
  const ref = (parts[3] || "").trim().toUpperCase();
  const alts = (parts[4] || "").trim().toUpperCase();
  const info = parts[7] || "";
  const format = parts[8] || "";
  const sample = parts[9] || "";
  const referenceOnlyAlt = alts === "." || alts === "<NON_REF>" || alts === "<*>";
  const endMatch = info.match(/END=(\d+)/);
  if (endMatch && Number(endMatch[1]) > pos) {
    const end = Number(endMatch[1]);
    if (parts[6] !== "PASS" || !referenceOnlyAlt) return;
    const formatKeys = format.split(":");
    const sampleValues = sample.split(":");
    const field = (key2) => sampleValues[formatKeys.indexOf(key2)];
    const gt2 = field("GT");
    const haploidReference = gt2 === "0" && (chrom === "X" || chrom === "Y" || chrom === "MT");
    if (gt2 !== "0/0" && gt2 !== "0|0" && !haploidReference) return;
    const minDepth = Number(field("MIN_DP"));
    if (!Number.isInteger(minDepth) || minDepth < 0) return;
    const rawGq = field("GQ");
    const gq = rawGq != null && rawGq !== "." && rawGq !== "" && Number.isFinite(Number(rawGq)) ? Number(rawGq) : null;
    const positions = (ctx.build === "GRCh37" ? ctx.indexes.positionsByChrom37 : ctx.indexes.positionsByChrom38)?.get(chrom) || [];
    let low = 0;
    let high = positions.length;
    while (low < high) {
      const mid = low + high >> 1;
      if (positions[mid][0] < pos) low = mid + 1;
      else high = mid;
    }
    for (let i2 = low; i2 < positions.length && positions[i2][0] <= end; i2 += 1) {
      const rsid = positions[i2][1];
      const base = ctx.indexes.referenceAlleles.get(rsid)?.[ctx.build];
      if (!/^[ACGT]$/.test(base || "") || ctx.explicitSnps?.has(rsid)) continue;
      if (ctx.indexes.wgsCaptureById?.has(rsid)) {
        addWgsCaptureRecord(ctx, rsid, {
          chromosome: chrom,
          position: positions[i2][0],
          vcf_id: null,
          ref: base,
          alts: ["."],
          gt: "0/0",
          phased: false,
          filter: "PASS",
          dp: minDepth,
          gq
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
  if (referenceOnlyAlt) {
    if (parts[6] !== "PASS" || !["0/0", "0|0"].includes(sample.split(":")[format.split(":").indexOf("GT")])) return;
    const rsid = ctx.indexes[ctx.build === "GRCh37" ? "coordToRsid37" : "coordToRsid38"]?.get(`${chrom}:${pos}`);
    const base = ctx.indexes.referenceAlleles.get(rsid)?.[ctx.build];
    const depth = referenceDepth(format, sample);
    if (ctx.indexes.wgsCaptureById?.has(rsid) && /^[ACGT]$/.test(base || "") && ref === base && depth >= 10) {
      const rawGq = sample.split(":")[format.split(":").indexOf("GQ")];
      const gq = rawGq && rawGq !== "." && Number.isFinite(Number(rawGq)) ? Number(rawGq) : null;
      addWgsCaptureRecord(ctx, rsid, {
        chromosome: chrom,
        position: pos,
        vcf_id: null,
        ref,
        alts: ["."],
        gt: "0/0",
        phased: false,
        filter: "PASS",
        dp: depth,
        gq
      }, true);
      if (ctx.inferredReferenceCalls && ctx.wgsVariantCalls?.[rsid]?.records[0]?.inferred_reference_block) {
        ctx.inferredReferenceCalls[rsid] = { min_dp: depth, gq, ploidy: 2 };
      }
    }
    return;
  }
  if ((chrom === "X" || chrom === "Y") && alts && alts !== ".") {
    recordSexChromosomeEvidence(
      ctx.sexChromosomeStats,
      chrom,
      genotypeFromGt(ref, alts, format, sample),
      pos
    );
  }
  const idColumn = (parts[2] || "").trim();
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
  const primaryIdx = ctx.build === "GRCh37" ? "coordToRsid37" : "coordToRsid38";
  const altIdx = ctx.build === "GRCh37" ? "coordToRsid38" : "coordToRsid37";
  const key = `${chrom}:${pos}`;
  let primary = ctx.indexes[primaryIdx].get(key);
  if (!primary) primary = ctx.indexes[altIdx].get(key);
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

// src/parse.js
var PROVIDER_LABELS = { vcf: "WGS", "23andme": "23andMe", ancestry: "Ancestry" };
async function parseLines(iterable, indexes) {
  const snps = {};
  const wgsVariantCalls = {};
  const inferredReferenceCalls = {};
  const explicitSnps = /* @__PURE__ */ new Set();
  const sexChromosomeStats = createSexChromosomeStats();
  const headerLines = [];
  let provider = null;
  let build = "GRCh38";
  let totalLines = 0;
  for await (const line of iterable) {
    if (line.startsWith("#")) {
      if (headerLines.length < 500) headerLines.push(line);
      continue;
    }
    if (!line.trim()) continue;
    if (!provider) {
      provider = detectProvider(headerLines, line);
      build = provider === "vcf" ? detectBuild(headerLines) : "GRCh38";
    }
    totalLines += 1;
    if (provider === "vcf") {
      parseVcfLine(line, { indexes, snps, build, wgsVariantCalls, sexChromosomeStats, inferredReferenceCalls, explicitSnps });
    } else if (provider === "ancestry") {
      parseAncestryLine(line, { indexes, snps, sexChromosomeStats });
    } else {
      parse23andMeLine(line, { indexes, snps, sexChromosomeStats });
    }
  }
  return { snps, provider, totalLines, wgsVariantCalls, inferredReferenceCalls, sexChromosomeStats };
}

// ../../mutant-mcp/node_modules/fflate/esm/browser.js
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i2 = 0; i2 < 31; ++i2) {
    b[i2] = start += 1 << eb[i2 - 1];
  }
  var r = new i32(b[30]);
  for (var i2 = 1; i2 < 30; ++i2) {
    for (var j = b[i2]; j < b[i2 + 1]; ++j) {
      r[j] = j - b[i2] << 5 | i2;
    }
  }
  return { b, r };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = (function(cd, mb, r) {
  var s = cd.length;
  var i2 = 0;
  var l = new u16(mb);
  for (; i2 < s; ++i2) {
    if (cd[i2])
      ++l[cd[i2] - 1];
  }
  var le = new u16(mb);
  for (i2 = 1; i2 < mb; ++i2) {
    le[i2] = le[i2 - 1] + l[i2 - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i2 = 0; i2 < s; ++i2) {
      if (cd[i2]) {
        var sv = i2 << 4 | cd[i2];
        var r_1 = mb - cd[i2];
        var v = le[cd[i2] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i2 = 0; i2 < s; ++i2) {
      if (cd[i2]) {
        co[i2] = rev[le[cd[i2] - 1]++] >> 15 - cd[i2];
      }
    }
  }
  return co;
});
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a) {
  var m = a[0];
  for (var i2 = 1; i2 < a.length; ++i2) {
    if (a[i2] > m)
      m = a[i2];
  }
  return m;
};
var bits = function(d, p, m) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  // determined by compression function
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var inflt = function(dat, st, buf, dict) {
  var sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st.f && !st.l)
    return buf || new u8(0);
  var noBuf = !buf;
  var resize = noBuf || st.i != 2;
  var noSt = st.i;
  if (noBuf)
    buf = new u8(sl * 3);
  var cbuf = function(l2) {
    var bl = buf.length;
    if (l2 > bl) {
      var nbuf = new u8(Math.max(bl * 2, l2));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  var tbts = sl * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + l);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l, st.p = pos = t * 8, st.f = final;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i2 = 0; i2 < hcLen; ++i2) {
          clt[clim[i2]] = bits(dat, pos + i2 * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i2 = 0; i2 < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >> 4;
          if (s < 16) {
            ldt[i2++] = s;
          } else {
            var c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i2 - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i2++] = c;
          }
        }
        var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c)
        err(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i2 = sym - 257, b = fleb[i2];
          add = bits(dat, pos, (1 << b) - 1) + fl[i2];
          pos += b;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        var dt = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + 131072);
        var end = bt + add;
        if (bt < dt) {
          var shift = dl - dt, dend = Math.min(dt, end);
          if (shift + bt < 0)
            err(3);
          for (; bt < dend; ++bt)
            buf[bt] = dict[shift + bt];
        }
        for (; bt < end; ++bt)
          buf[bt] = buf[bt - dt];
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var et = /* @__PURE__ */ new u8(0);
var gzs = function(d) {
  if (d[0] != 31 || d[1] != 139 || d[2] != 8)
    err(6, "invalid gzip data");
  var flg = d[3];
  var st = 10;
  if (flg & 4)
    st += (d[10] | d[11] << 8) + 2;
  for (var zs = (flg >> 3 & 1) + (flg >> 4 & 1); zs > 0; zs -= !d[st++])
    ;
  return st + (flg & 2);
};
var Inflate = /* @__PURE__ */ (function() {
  function Inflate2(opts, cb) {
    if (typeof opts == "function")
      cb = opts, opts = {};
    this.ondata = cb;
    var dict = opts && opts.dictionary && opts.dictionary.subarray(-32768);
    this.s = { i: 0, b: dict ? dict.length : 0 };
    this.o = new u8(32768);
    this.p = new u8(0);
    if (dict)
      this.o.set(dict);
  }
  Inflate2.prototype.e = function(c) {
    if (!this.ondata)
      err(5);
    if (this.d)
      err(4);
    if (!this.p.length)
      this.p = c;
    else if (c.length) {
      var n = new u8(this.p.length + c.length);
      n.set(this.p), n.set(c, this.p.length), this.p = n;
    }
  };
  Inflate2.prototype.c = function(final) {
    this.s.i = +(this.d = final || false);
    var bts = this.s.b;
    var dt = inflt(this.p, this.s, this.o);
    this.ondata(slc(dt, bts, this.s.b), this.d);
    this.o = slc(dt, this.s.b - 32768), this.s.b = this.o.length;
    this.p = slc(this.p, this.s.p / 8 | 0), this.s.p &= 7;
  };
  Inflate2.prototype.push = function(chunk, final) {
    this.e(chunk), this.c(final);
  };
  return Inflate2;
})();
var Gunzip = /* @__PURE__ */ (function() {
  function Gunzip2(opts, cb) {
    this.v = 1;
    this.r = 0;
    Inflate.call(this, opts, cb);
  }
  Gunzip2.prototype.push = function(chunk, final) {
    Inflate.prototype.e.call(this, chunk);
    this.r += chunk.length;
    if (this.v) {
      var p = this.p.subarray(this.v - 1);
      var s = p.length > 3 ? gzs(p) : 4;
      if (s > p.length) {
        if (!final)
          return;
      } else if (this.v > 1 && this.onmember) {
        this.onmember(this.r - p.length);
      }
      this.p = p.subarray(s), this.v = 0;
    }
    Inflate.prototype.c.call(this, 0);
    if (this.s.f && !this.s.l) {
      this.v = shft(this.s.p) + 9;
      this.s = { i: 0 };
      this.o = new u8(0);
      this.push(new u8(0), final);
    } else if (final) {
      Inflate.prototype.c.call(this, final);
    }
  };
  return Gunzip2;
})();
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {
}

// src/stream.js
function supportsStreaming() {
  return typeof File !== "undefined" && typeof File.prototype.stream === "function" && typeof TransformStream === "function" && typeof TextDecoder === "function";
}
var GZIP_MAGIC = [31, 139];
async function isGzipFile(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    return head.length >= 2 && head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1];
  } catch {
    return false;
  }
}
var YIELD_CHECK_EVERY_LINES = 512;
var YIELD_INTERVAL_MS = 24;
var nowMs = () => typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
function createMainThreadYielder() {
  let sinceCheck = 0;
  let lastYield = nowMs();
  return () => {
    sinceCheck += 1;
    if (sinceCheck < YIELD_CHECK_EVERY_LINES) return null;
    sinceCheck = 0;
    if (nowMs() - lastYield < YIELD_INTERVAL_MS) return null;
    lastYield = nowMs();
    return new Promise((resolve) => setTimeout(resolve, 0));
  };
}
async function* readLines(file, { onProgress, signal, cooperative = true } = {}) {
  const total = file.size || 0;
  let readBytes = 0;
  const isGz = await isGzipFile(file);
  const counter = new TransformStream({
    transform(chunk, controller) {
      readBytes += chunk.byteLength;
      controller.enqueue(chunk);
    }
  });
  const rawReader = file.stream().pipeThrough(counter).getReader();
  const decoder = new TextDecoder("utf-8");
  const maybeYield = cooperative ? createMainThreadYielder() : () => null;
  let buffer = "";
  let first = true;
  const drain = (bytes) => {
    const lines = [];
    buffer += decoder.decode(bytes, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (first) {
        line = line.replace(/^\uFEFF/, "");
        first = false;
      }
      lines.push(line);
    }
    return lines;
  };
  try {
    if (!isGz) {
      while (true) {
        const { done, value } = await rawReader.read();
        if (done) break;
        for (const line of drain(value)) {
          yield line;
          const pause = maybeYield();
          if (pause) await pause;
        }
        if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (onProgress && total) onProgress(Math.min(100, Math.round(readBytes / total * 100)));
      }
    } else {
      const gunzip = new Gunzip();
      const pending = [];
      gunzip.ondata = (data) => {
        if (data && data.length) pending.push(data);
      };
      while (true) {
        const { done, value } = await rawReader.read();
        gunzip.push(done ? new Uint8Array(0) : new Uint8Array(value), done);
        while (pending.length) {
          for (const line of drain(pending.shift())) {
            yield line;
            const pause = maybeYield();
            if (pause) await pause;
          }
        }
        if (done) break;
        if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (onProgress && total) onProgress(Math.min(100, Math.round(readBytes / total * 100)));
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      let line = buffer.replace(/\r$/, "");
      if (first) line = line.replace(/^\uFEFF/, "");
      yield line;
    }
  } finally {
    try {
      await rawReader.cancel();
    } catch {
    }
  }
}

// src/version.js
var PARSER_VERSION = "0.1.2";
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function catalogFingerprint(catalog) {
  const input = stable(catalog || {});
  let hash = 0xcbf29ce484222325n;
  for (let i2 = 0; i2 < input.length; i2 += 1) {
    hash ^= BigInt(input.charCodeAt(i2));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

// src/parseFile.js
var WGS_PROVIDER = "WGS";
var MAX_HEADER_LINES = 500;
var MALE_SEX_TOKENS = /* @__PURE__ */ new Set(["male", "m", "man", "men", "boy", "xy", "1"]);
var FEMALE_SEX_TOKENS = /* @__PURE__ */ new Set(["female", "f", "woman", "women", "girl", "xx", "2"]);
var SEX_HEADER_RE = /^#+\s*(?:sex|gender)\b[\s:=,;\t]+([A-Za-z0-9]+)/i;
var NO_CALL_TOKENS = /* @__PURE__ */ new Set(["", "--", "00", "NN", "II", "DD", "NULL", "NAN"]);
function detectSexChromosomeContext(headerLines, snps, catalog) {
  for (const line of headerLines || []) {
    const match = SEX_HEADER_RE.exec(String(line || ""));
    if (!match) continue;
    const token = match[1].toLowerCase();
    if (MALE_SEX_TOKENS.has(token)) {
      return { pattern: "XY", confidence: "high" };
    }
    if (FEMALE_SEX_TOKENS.has(token)) {
      return { pattern: "XX", confidence: "high" };
    }
  }
  const snpMeta = catalog && catalog.snps || {};
  for (const [rsid, gt] of Object.entries(snps || {})) {
    const meta = snpMeta[rsid];
    if (!meta || normalizeChrom(meta.chromosome) !== "Y") continue;
    const token = String(gt || "").trim().toUpperCase();
    if (token && !NO_CALL_TOKENS.has(token)) {
      return { pattern: "XY", confidence: "high" };
    }
  }
  return null;
}
async function* capturingHeaders(iterable, sink) {
  for await (const line of iterable) {
    if (line.startsWith("#")) {
      if (sink.length < MAX_HEADER_LINES) sink.push(line);
    }
    yield line;
  }
}
async function parseFile(file, { catalog, onProgress, signal, cooperative = true } = {}) {
  const fileName = file && file.name || "";
  const fileSizeBytes = file && file.size || 0;
  const parserVersion = PARSER_VERSION;
  const catalogDigest = catalogFingerprint(catalog);
  const catalogVersion = catalog?.version ?? null;
  if (!supportsStreaming()) {
    return {
      supported: false,
      snps: {},
      wgsVariantCalls: {},
      inferredReferenceCalls: {},
      provider: WGS_PROVIDER,
      providerLabel: WGS_PROVIDER,
      genomeBuild: null,
      sexChromosome: null,
      fileName,
      fileSizeBytes,
      coverage: { matched: 0, total: 0 },
      totalLines: 0,
      parserVersion,
      catalogDigest,
      catalogVersion
    };
  }
  const indexes = buildCatalogIndexes(catalog || {});
  const headerLines = [];
  const { snps, provider, totalLines, wgsVariantCalls, inferredReferenceCalls, sexChromosomeStats } = await parseLines(
    capturingHeaders(readLines(file, { onProgress, signal, cooperative }), headerLines),
    indexes
  );
  const providerLabel = PROVIDER_LABELS[provider] || "23andMe";
  const isWgs = providerLabel === WGS_PROVIDER;
  const genomeBuild = isWgs ? detectBuild(headerLines) : null;
  const inferredSexChromosome = safeInferSexChromosomePattern(sexChromosomeStats, provider);
  const sexChromosome = inferredSexChromosome.confidence === "high" && (inferredSexChromosome.pattern === "XX" || inferredSexChromosome.pattern === "XY") ? inferredSexChromosome : detectSexChromosomeContext(headerLines, {}, catalog);
  return {
    supported: true,
    snps,
    wgsVariantCalls: wgsVariantCalls || {},
    inferredReferenceCalls: inferredReferenceCalls || {},
    provider: providerLabel,
    providerLabel,
    genomeBuild,
    sexChromosome,
    fileName,
    fileSizeBytes,
    coverage: { matched: Object.keys(snps).length, total: indexes.primarySet.size },
    totalLines,
    sexChromosomeInference: inferredSexChromosome,
    parserVersion,
    catalogDigest,
    catalogVersion
  };
}
