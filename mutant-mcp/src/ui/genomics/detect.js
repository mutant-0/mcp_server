// GENERATED FILE - DO NOT EDIT.
// Vendored from front-end-web/src/genomics by scripts/sync-genomics.mjs.
// Edit the upstream module (and re-run sync:genomics) instead.
// Format and genome-build sniffing for raw DNA files.

// Detect the file provider from leading header lines and the first data line.
// Returns one of: 'vcf' | '23andme' | 'ancestry'.
export function detectProvider(headerLines = [], firstDataLine = '') {
  const headerText = (headerLines || []).join('\n');

  // VCF: explicit fileformat/column header.
  if (/##fileformat=VCF/i.test(headerText)) return 'vcf';
  if (/#CHROM\b/i.test(headerText)) return 'vcf';

  const parts = String(firstDataLine || '').split('\t');

  // VCF: 8+ tab columns where REF/ALT look like base sequences.
  if (parts.length >= 8) {
    const id = (parts[2] || '').trim();
    const ref = (parts[3] || '').trim().toUpperCase();
    const alt = (parts[4] || '').trim().toUpperCase();
    if ((id === '.' || /^rs\d+/i.test(id)) && /^[ACGTN.]+$/.test(ref) && /^[ACGTN.,]+$/.test(alt)) {
      return 'vcf';
    }
  }

  // Microarray: Ancestry uses allele1/allele2 columns, 23andMe a combined genotype.
  if (/allele1|allele2/i.test(headerText)) return 'ancestry';
  if (/genotype/i.test(headerText)) return '23andme';

  // Column-count fallback when no header is present.
  if (parts.length >= 5) {
    const a4 = (parts[3] || '').trim().toUpperCase();
    const a5 = (parts[4] || '').trim().toUpperCase();
    if (/^[ACGTDI]$/i.test(a4) && /^[ACGTDI]$/i.test(a5)) return 'ancestry';
  }

  return '23andme';
}

// Detect the reference genome build from VCF header lines. Defaults to GRCh38.
export function detectBuild(headerLines = []) {
  const text = (headerLines || []).join('\n').toLowerCase();
  if (/grch37|hg19|b37|hs37/.test(text)) return 'GRCh37';
  if (/grch38|hg38|b38|hs38/.test(text)) return 'GRCh38';
  return 'GRCh38';
}
