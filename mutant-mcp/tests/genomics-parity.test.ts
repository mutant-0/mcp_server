import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
// The manifest contract is shared with the sync script, so the drift guard cannot
// disagree with `npm run check:genomics` about the header or the hashing rules.
import { GENERATED_HEADER, normalizeNewlines, sha256 } from "../scripts/genomics-manifest.mjs";
import { parseDnaFile } from "../src/ui/dna-import/parseFile.js";
import { fetchSnpCatalog } from "../src/ui/api.js";
import { concatBytes, fakeFile } from "./genomics-fixtures.js";

/**
 * Portal/ChatGPT parity for the vendored DNA processor.
 *
 * `src/ui/genomics/*` is copied verbatim from `front-end-web/src/genomics/` by
 * `scripts/sync-genomics.mjs`. These tests are the MCP-side half of the parity
 * gate: they pin the vendored copies to the sync manifest, then drive the exact
 * function the Apps SDK component calls (`parseDnaFile`) over the same fixture
 * shapes the portal's own suite uses, and assert the full normalized payload.
 *
 * `parseDnaFile` prefers a Web Worker and falls back to the main thread. These
 * tests run under Node, which has no `Worker`, so they exercise the fallback
 * (and, through it, the same `parseDnaFileCore` the worker entry runs).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GENOMICS_DIR = path.resolve(HERE, "..", "src", "ui", "genomics");
const API_SHIM = path.resolve(HERE, "..", "src", "ui", "api.js");
const MANIFEST = path.join(GENOMICS_DIR, "sync-manifest.json");

interface Manifest {
  source: string;
  modules: Record<string, string>;
}

async function readManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(MANIFEST, "utf8")) as Manifest;
}

/** Shared fixture catalog: three markers, one alias, one WGS capture target. */
const catalog = {
  version: 1,
  snp_count: 4,
  snps: {
    rs328: {
      rsID: "rs328",
      chromosome: "8",
      position_GRCh37: 19819724,
      position_GRCh38: 19962213,
      risk_allele: "A",
    },
    rs671: {
      rsID: "rs671",
      chromosome: "12",
      position_GRCh37: 112241766,
      position_GRCh38: 111803962,
      risk_allele: "A",
    },
    rs4680: {
      rsID: "rs4680",
      chromosome: "22",
      position_GRCh37: 19951271,
      position_GRCh38: 19963748,
      risk_allele: "A",
    },
    rs999999001: {
      rsID: "rs999999001",
      chromosome: "16",
      position_GRCh37: 50745926,
      position_GRCh38: 50729867,
      risk_allele: "C",
      wgs_capture: {
        schema_version: 1,
        variant_class: "non_snv",
        capture_mode: "raw_vcf_record",
        capture_range_GRCh37: { start: 50745920, end: 50745930 },
        capture_range_GRCh38: { start: 50729860, end: 50729870 },
      },
    },
  },
  aliases: { rs671: ["rs2230021"] },
  reference_alleles: { rs328: { GRCh37: "A", GRCh38: "A" } },
};

/** Catalog without WGS targets, so capture assertions are unambiguous. */
const microarrayCatalog: Record<string, unknown> = {
  version: 1,
  snp_count: 3,
  snps: {
    rs328: catalog.snps.rs328,
    rs671: catalog.snps.rs671,
    rs4680: catalog.snps.rs4680,
  },
  aliases: { rs671: ["rs2230021"] },
};

const VCF_HEADER = [
  "##fileformat=VCFv4.2",
  "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
];

async function parse(file: File, snpCatalog: Record<string, unknown> = microarrayCatalog) {
  const result = await parseDnaFile(file, { catalog: snpCatalog });
  // A false `supported` flag would silently skip the whole parity check.
  expect(result.supported).toBe(true);
  return result;
}

describe("vendored processor drift guard", () => {
  it("ships exactly the modules the sync manifest declares", async () => {
    const manifest = await readManifest();
    const files = (await readdir(GENOMICS_DIR)).filter((name) => name !== "sync-manifest.json");
    expect([...files].sort()).toEqual(Object.keys(manifest.modules).sort());
    expect(manifest.source).toBe("front-end-web/src/genomics");
  });

  it("keeps every vendored module identical to its manifest hash", async () => {
    const manifest = await readManifest();
    for (const [name, expected] of Object.entries(manifest.modules)) {
      // Normalised first: git hands this file to Windows as CRLF and to CI as LF,
      // and the manifest hash must not depend on which.
      const raw = normalizeNewlines(await readFile(path.join(GENOMICS_DIR, name), "utf8"));
      expect(raw.startsWith(GENERATED_HEADER), `${name} must keep the generated header`).toBe(true);
      const body = raw.slice(GENERATED_HEADER.length);
      expect(sha256(body), `${name} drifted from the manifest; run npm run sync:genomics`).toBe(
        expected,
      );
    }
  });

  it("cannot fetch a catalog from the portal (the component injects it instead)", async () => {
    expect(() => fetchSnpCatalog()).toThrow(/explicit SNP catalog/);
    const shim = await readFile(API_SHIM, "utf8");
    expect(shim).not.toContain("fetch(");
  });
});

describe("genomics parity: microarray input", () => {
  it("parses 23andMe through the alias map and drops no-calls", async () => {
    const file = fakeFile(
      "23andme.txt",
      [
        "# This data was generated by 23andMe",
        "# rsid\tchromosome\tposition\tgenotype",
        "rs328\t8\t19819724\tAA",
        "rs2230021\t12\t112241766\tGA",
        "rs4680\t22\t19951271\t--",
        "rs-in-catalog-miss\t1\t1\tAG",
      ].join("\n"),
    );

    const result = await parse(file);

    expect(result).toMatchObject({
      provider: "23andMe",
      providerLabel: "23andMe",
      genomeBuild: null,
      fileName: "23andme.txt",
      supported: true,
      // No-calls, unknown rsIDs, and comment rows never become variants.
      snps: { rs328: "AA", rs671: "AG" },
      wgsVariantCalls: {},
      coverage: { matched: 2, total: 3 },
      totalLines: 4,
    });
    expect(result.fileSizeBytes).toBeGreaterThan(0);
  });

  it("combines Ancestry allele columns", async () => {
    const file = fakeFile(
      "ancestry.txt",
      [
        "# rsid\tchromosome\tposition\tallele1\tallele2",
        "rs328\t8\t19819724\tA\tG",
        "rs4680\t22\t19951271\tA\tA",
        "rs4680\t22\t19951271\tD\tI",
      ].join("\n"),
    );

    const result = await parse(file);

    expect(result.providerLabel).toBe("Ancestry");
    expect(result.genomeBuild).toBeNull();
    // The trailing indel row is rejected, leaving the previous genotype intact.
    expect(result.snps).toEqual({ rs328: "AG", rs4680: "AA" });
    expect(result.coverage).toEqual({ matched: 2, total: 3 });
  });
});

describe("genomics parity: VCF input", () => {
  it("matches GRCh38 coordinates from a plain VCF", async () => {
    const file = fakeFile(
      "sample.vcf",
      [
        "##fileformat=VCFv4.2",
        "##reference=GRCh38",
        "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
        "8\t19962213\t.\tA\tG\t.\tPASS\t.\tGT:DP\t0/1:25",
      ].join("\n"),
    );

    const result = await parse(file);

    expect(result.providerLabel).toBe("WGS");
    expect(result.genomeBuild).toBe("GRCh38");
    expect(result.snps).toEqual({ rs328: "AG" });
    expect(result.wgsVariantCalls).toEqual({});
  });

  it("matches GRCh37 coordinates and normalizes a homozygous call", async () => {
    const file = fakeFile(
      "sample.vcf",
      [
        "##fileformat=VCFv4.2",
        "##reference=GRCh37",
        "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
        "8\t19819724\t.\tA\tG\t.\tPASS\t.\tGT\t0/0",
      ].join("\n"),
    );

    const result = await parse(file);

    expect(result.genomeBuild).toBe("GRCh37");
    expect(result.snps).toEqual({ rs328: "AA" });
  });

  it("reads concatenated gzip members (bgzip/tabix .vcf.gz)", async () => {
    const part1 = `${["##fileformat=VCFv4.2", "##reference=GRCh38", VCF_HEADER[1]].join("\n")}\n`;
    const part2 = [
      "8\t19962213\t.\tA\tG\t.\tPASS\t.\tGT\t0/1",
      "12\t111803962\t.\tA\tG\t.\tPASS\t.\tGT\t1/1",
      "",
    ].join("\n");

    const file = fakeFile(
      "sample.vcf.gz",
      concatBytes(gzipSync(strToU8(part1)), gzipSync(strToU8(part2))),
    );

    const result = await parse(file);

    expect(result.genomeBuild).toBe("GRCh38");
    expect(result.snps).toEqual({ rs328: "AG", rs671: "GG" });
    expect(result.totalLines).toBe(2);
  });

  it("treats a mislabeled .gz that is actually plain text as plain text", async () => {
    const file = fakeFile("sample.vcf.gz", "8\t19962213\t.\tA\tG\t.\tPASS\t.\tGT\t0/1\n");
    const result = await parse(file);
    expect(result.providerLabel).toBe("WGS");
    expect(result.snps).toEqual({ rs328: "AG" });
  });

  it("resolves multi-allelic and haploid genotypes", async () => {
    const file = fakeFile(
      "sample.vcf",
      [
        ...VCF_HEADER,
        "8\t19962213\t.\tA\tG,T\t.\tPASS\t.\tGT\t1/2",
        "12\t111803962\t.\tA\tG\t.\tPASS\t.\tGT\t1",
      ].join("\n"),
    );

    const result = await parse(file);

    expect(result.snps).toEqual({ rs328: "GT", rs671: "GG" });
  });

  it("skips no-calls and gVCF reference blocks", async () => {
    const file = fakeFile(
      "sample.g.vcf",
      [
        ...VCF_HEADER,
        "8\t19962213\t.\tA\tG\t.\tPASS\t.\tGT\t./.",
        "8\t19962213\t.\tA\t<NON_REF>\t.\tPASS\tEND=19970000\tGT\t0/0",
        "12\t111803962\t.\tA\tG\t.\tPASS\t.\tGT\t./.",
      ].join("\n"),
    );

    const result = await parse(file, catalog);

    expect(result.snps).toEqual({});
    expect(result.wgsVariantCalls).toEqual({});
    expect(result.coverage.matched).toBe(0);
  });

  it("captures non-SNV target records with native REF/ALT/GT intact", async () => {
    const file = fakeFile(
      "wgs.vcf",
      [
        ...VCF_HEADER,
        // Reference row over the capture interval: must not be captured.
        "16\t50729860\t.\tG\t.\t.\tPASS\tEND=50729900\tGT:DP\t0/0:32",
        // Real indel, matched by explicit VCF ID.
        "16\t50729867\trs999999001\tG\tGC\t123.4\tPASS\t.\tGT:DP:GQ:AD\t0/1:32:99:18,14",
        // Second split record for the same target, matched by GRCh38 range.
        "16\t50729868\t.\tG\tGC\t.\t.\t.\tGT\t1/1",
        // Outside the capture interval: dropped.
        "16\t99999999\t.\tA\tAT\t.\tPASS\t.\tGT\t0/1",
      ].join("\n"),
    );

    const result = await parse(file, catalog);

    // The indel is not a two-base genotype, so it never becomes an SNV.
    expect(result.snps).toEqual({});
    expect(result.wgsVariantCalls).toEqual({
      rs999999001: {
        schema_version: 1,
        source_format: "vcf",
        genome_build: "GRCh38",
        records: [
          {
            chromosome: "16",
            position: 50729867,
            vcf_id: "rs999999001",
            ref: "G",
            alts: ["GC"],
            gt: "0/1",
            phased: false,
            filter: "PASS",
            qual: 123.4,
            dp: 32,
            gq: 99,
            ad: [18, 14],
          },
          {
            chromosome: "16",
            position: 50729868,
            vcf_id: null,
            ref: "G",
            alts: ["GC"],
            gt: "1/1",
            phased: false,
            qual: null,
          },
        ],
      },
    });
  });
});

describe("genomics parity: component payload contract", () => {
  it("returns only the fields create_report consumes, plus local coverage", async () => {
    const file = fakeFile("23andme.txt", "# rsid\tgenotype\nrs328\t8\t19819724\tAG\n");
    const result = await parse(file);

    expect(Object.keys(result).sort()).toEqual([
      "coverage",
      "fileName",
      "fileSizeBytes",
      "genomeBuild",
      "provider",
      "providerLabel",
      "snps",
      "supported",
      "totalLines",
      "wgsVariantCalls",
    ]);
    // `coverage.matched` is the count of catalog markers the user actually has
    // data for, which is what the component shows the user.
    expect(result.coverage.matched).toBe(Object.keys(result.snps).length);
  });
});
