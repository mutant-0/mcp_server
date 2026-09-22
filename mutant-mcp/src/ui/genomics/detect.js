// GENERATED FILE - DO NOT EDIT.
// Vendored from front-end-web/src/genomics by scripts/sync-genomics.mjs.
// Edit the upstream module (and re-run sync:genomics) instead.
// Format and genome-build sniffing for raw DNA files.

// Detect the file provider from leading header lines and the first data line.
// Returns one of: 'vcf' | '23andme' | 'ancestry'.
export function detectProvider(headerLines = [], firstDataLine = '') {
  const headerText = (headerLines || []).join('\n');
  const line = String(firstDataLine || '');
  // AncestryDNA's column-name row is NOT prefixed with "#", so the first data
  // line must be part of the sniff text to see the allele1/allele2 columns.
  const sniffText = `${headerText}\n${line}`;
  const parts = line.split('\t');

  // VCF: explicit fileformat/column header.
  if (/##fileformat=VCF/i.test(headerText)) return 'vcf';
  if (/#CHROM\b/i.test(headerText)) return 'vcf';

  // VCF: 8+ tab columns where REF/ALT look like base sequences.
  if (parts.length >= 8) {
    const id = (parts[2] || '').trim();
    const ref = (parts[3] || '').trim().toUpperCase();
    const alt = (parts[4] || '').trim().toUpperCase();
    if ((id === '.' || /^rs\d+/i.test(id)) && /^[ACGTN.]+$/.test(ref) && /^[ACGTN.,]+$/.test(alt)) {
      return 'vcf';
    }
  }

  // Microarray. Ancestry uses allele1/allele2 columns, 23andMe a combined
  // genotype. Check Ancestry FIRST: the AncestryDNA comment block describes the
  // columns in prose ("...observed at this SNP (genotype)..."), so a bare
  // /genotype/ test would misclassify every Ancestry file as 23andMe.
  if (/allele1|allele2/i.test(sniffText)) return 'ancestry';

  // Column-count fallback when no column-name row is present. Ancestry reports
  // a no-call as "0" (occasionally "-"), so those are valid allele tokens too.
  if (parts.length >= 5) {
    const a4 = (parts[3] || '').trim().toUpperCase();
    const a5 = (parts[4] || '').trim().toUpperCase();
    if (/^[ACGTDI0-]$/.test(a4) && /^[ACGTDI0-]$/.test(a5)) return 'ancestry';
  }

  // 23andMe (a single combined-genotype column) is the default: it is the most
  // common layout and its data rows are 4 columns with one genotype field.
  return '23andme';
}

// Detect the reference genome build from VCF header lines. Defaults to GRCh38.
export function detectBuild(headerLines = []) {
  const text = (headerLines || []).join('\n').toLowerCase();
  if (/grch37|hg19|b37|hs37/.test(text)) return 'GRCh37';
  if (/grch38|hg38|b38|hs38/.test(text)) return 'GRCh38';
  return 'GRCh38';
}
