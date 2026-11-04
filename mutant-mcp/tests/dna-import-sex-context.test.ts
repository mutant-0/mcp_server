import { describe, expect, it } from "vitest";
import { detectSexChromosomeContext } from "../src/ui/dna-import/parseCore.js";
import { parseDnaFile } from "../src/ui/dna-import/parseFile.js";
import { fakeFile } from "./genomics-fixtures.js";

/**
 * Transient sex-chromosome context detection.
 *
 * The detector is a pure function over the already-captured header lines and the
 * parsed genotype map. It must only report a `high`-confidence XX/XY pattern;
 * anything ambiguous returns `null` so the component omits `analysis_context`
 * and the backend treats the request as unknown.
 */

const CATALOG = {
  version: 1,
  snp_count: 3,
  snps: {
    rs328: { rsID: "rs328", chromosome: "8" },
    rs4680: { rsID: "rs4680", chromosome: "22" },
    rs1234567: { rsID: "rs1234567", chromosome: "Y" },
  },
};

describe("detectSexChromosomeContext", () => {
  it("reads an explicit sex header as high confidence", () => {
    expect(detectSexChromosomeContext(["# sex\tmale"], {}, CATALOG)).toEqual({
      pattern: "XY",
      confidence: "high",
    });
    expect(detectSexChromosomeContext(["# sex: female"], {}, CATALOG)).toEqual({
      pattern: "XX",
      confidence: "high",
    });
    expect(detectSexChromosomeContext(["##gender=M"], {}, CATALOG)).toEqual({
      pattern: "XY",
      confidence: "high",
    });
    expect(detectSexChromosomeContext(["# Sex\t2"], {}, CATALOG)).toEqual({
      pattern: "XX",
      confidence: "high",
    });
  });

  it("falls back to an observed chrY call", () => {
    expect(
      detectSexChromosomeContext([], { rs4680: "AG", rs1234567: "G" }, CATALOG),
    ).toEqual({ pattern: "XY", confidence: "high" });
  });

  it("treats a no-call chrY genotype as no evidence", () => {
    expect(detectSexChromosomeContext([], { rs1234567: "--" }, CATALOG)).toBeNull();
    expect(detectSexChromosomeContext([], { rs1234567: "" }, CATALOG)).toBeNull();
  });

  it("returns null when nothing can be inferred", () => {
    expect(detectSexChromosomeContext([], {}, CATALOG)).toBeNull();
    expect(detectSexChromosomeContext(["# sex\tunknown"], {}, CATALOG)).toBeNull();
    expect(detectSexChromosomeContext(["# rsid\tgenotype"], { rs4680: "AG" }, CATALOG)).toBeNull();
  });

  it("does not treat an absent chrY call as female", () => {
    // Many arrays do not probe chrY; absence is not evidence of XX.
    expect(detectSexChromosomeContext([], { rs4680: "AG" }, CATALOG)).toBeNull();
  });
});

describe("parseDnaFile exposes the sex-chromosome context", () => {
  it("uses whole-VCF chromosome evidence when the catalog has no Y SNPs", async () => {
    const catalog = { ...CATALOG, snps: { rs4680: CATALOG.snps.rs4680 } };
    const lines = ["##fileformat=VCFv4.2", "##reference=GRCh38", "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE"];
    for (let i = 0; i < 30; i += 1) {
      lines.push(`X\t${5000000 + i}\t.\tA\tG\t.\tPASS\t.\tGT\t0`);
    }
    for (let i = 0; i < 6; i += 1) {
      lines.push(`Y\t${5000000 + i}\t.\tA\tG\t.\tPASS\t.\tGT\t1`);
    }
    lines.push("22\t19951271\trs4680\tG\tA\t.\tPASS\t.\tGT\t0/1");
    const result = await parseDnaFile(fakeFile("genome.vcf", lines.join("\n")), { catalog });
    expect(result.sexChromosome).toEqual({ pattern: "XY", confidence: "high" });
  });

  it("carries a high-confidence header signal through the parse result", async () => {
    const file = fakeFile(
      "23andme.txt",
      ["# rsid\tchromosome\tposition\tgenotype", "# sex\tmale", "rs4680\t22\t19951271\tGG"].join("\n"),
    );
    const result = await parseDnaFile(file, { catalog: CATALOG });
    expect(result.supported).toBe(true);
    expect(result.sexChromosome).toEqual({ pattern: "XY", confidence: "high" });
  });

  it("reports null when no signal is present", async () => {
    const file = fakeFile(
      "23andme.txt",
      ["# rsid\tchromosome\tposition\tgenotype", "rs4680\t22\t19951271\tGG"].join("\n"),
    );
    const result = await parseDnaFile(file, { catalog: CATALOG });
    expect(result.sexChromosome).toBeNull();
  });
});
