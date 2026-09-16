// GENERATED FILE - DO NOT EDIT.
// Vendored from front-end-web/src/genomics by scripts/sync-genomics.mjs.
// Edit the upstream module (and re-run sync:genomics) instead.
// Chromosome and genotype normalization helpers shared by all parsers.

// Normalize a chromosome token to a canonical form used for coordinate lookups.
// Strips a leading "chr", upper-cases, and maps M/23/24 to their standard tokens.
export function normalizeChrom(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/^chr/i, '');
  s = s.toUpperCase();
  if (s === 'M') s = 'MT';
  if (s === '23') s = 'X';
  if (s === '24') s = 'Y';
  return s;
}

// Normalize a raw genotype string into two sorted uppercase bases, or null.
// Rejects no-call ("--"), indels ("II"/"DD"), missing, and any non-ACGT value.
export function normalizeGenotype(gt) {
  if (gt == null) return null;
  const s = String(gt).trim().toUpperCase().replace(/\s+/g, '');
  if (s.length !== 2) return null;
  if (!/^[ACGT]{2}$/.test(s)) return null;
  return s[0] <= s[1] ? s : s[1] + s[0];
}
