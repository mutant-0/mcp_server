export interface Catalog {
  version?: number;
  snp_count?: number;
  snps?: Record<string, unknown>;
  aliases?: Record<string, unknown>;
  reference_alleles?: Record<string, unknown>;
}

export interface ParseResult {
  supported: boolean;
  snps: Record<string, string>;
  wgsVariantCalls: Record<string, unknown>;
  inferredReferenceCalls: Record<string, { min_dp: number; gq: number | null; ploidy: number }>;
  provider: string;
  providerLabel: string;
  genomeBuild: string | null;
  sexChromosome: { pattern: string; confidence: string } | null;
  sexChromosomeInference: { pattern: string; confidence: string } | null;
  fileName: string;
  fileSizeBytes: number;
  coverage: { matched: number; total: number };
  totalLines: number;
  parserVersion: string;
  catalogVersion: number | null;
  catalogDigest: string;
}

export function parseFile(file: File, options: {
  catalog: Catalog;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  cooperative?: boolean;
}): Promise<ParseResult>;
export const PARSER_VERSION: string;
export const WGS_PROVIDER: string;
export function catalogFingerprint(catalog: Catalog): string;
export function detectSexChromosomeContext(headers: string[], snps: Record<string, string>, catalog: Catalog): { pattern: string; confidence: string } | null;
export function buildAnalysisContext(inference: unknown): unknown;
export function supportsStreaming(): boolean;
export function buildCatalogIndexes(catalog: Catalog): unknown;
export function normalizeRsid(id: unknown): string;
export function resolvePrimary(...args: any[]): any;
export function detectBuild(...args: any[]): any;
export function detectProvider(...args: any[]): any;
export function normalizeChrom(...args: any[]): any;
export function normalizeGenotype(...args: any[]): any;
export function parseLines(...args: any[]): any;
export const PROVIDER_LABELS: Record<string, string>;
export function parse23andMeLine(...args: any[]): any;
export function parseAncestryLine(...args: any[]): any;
export function parseVcfLine(...args: any[]): any;
export function matchWgsCaptureTargets(...args: any[]): any;
export function buildWgsVariantCallRecord(...args: any[]): any;
export function genotypeFromGt(...args: any[]): any;
export function safeInferSexChromosomePattern(...args: any[]): any;
export function inferSexChromosomePattern(...args: any[]): any;
export function createSexChromosomeStats(...args: any[]): any;
export function recordSexChromosomeEvidence(...args: any[]): any;
export function callableAlleles(...args: any[]): any;
export function providerToSourceType(...args: any[]): any;
export function readLines(...args: any[]): AsyncIterable<string>;
