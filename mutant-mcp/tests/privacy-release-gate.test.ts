/**
 * PRIV-10 privacy release-gate invariants.
 *
 * The gate must stay honest: every required requirement has a row, an automated
 * row resolves to a real named test in the tree, a manual/deploy row carries an
 * evidence reference, and no row is `verified` without its evidence. It must also
 * never convert an incomplete golden routing trace into an observed one.
 *
 * The `back-end` rows are only resolvable when that repository is checked out
 * alongside this one (`../back-end`). In CI, where only this repo is present,
 * those rows are skipped rather than falsely reported as missing.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getGateCheck,
  parsePrivacyReleaseGate,
  privacyReleaseGate,
  type GateCheck,
  type GateRepo,
} from "../infrastructure/lib/privacy-release-gate.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

const REPO_ROOTS: Record<GateRepo, string> = {
  mcp_server: resolve(PACKAGE_ROOT, ".."),
  "back-end": resolve(PACKAGE_ROOT, "..", "..", "back-end"),
};

/** Every PRIV-10 requirement the release gate must represent. */
const REQUIRED_CHECK_IDS = [
  "consent-bypass",
  "payload-leakage",
  "log-sanitization",
  "cross-account-access",
  "withdrawal",
  "deletion-races",
  "staging-walk",
  "release-evidence",
  "golden-routing-provenance",
];

/** The six categories the focused CI suite must cover (backlog step 1). */
const REQUIRED_AUTOMATED_IDS = REQUIRED_CHECK_IDS.filter(
  (id) => !["staging-walk", "release-evidence", "golden-routing-provenance"].includes(id),
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function testPattern(path: string, name: string): RegExp {
  // Python `def name(`; TypeScript/Vitest `it("name"`.
  if (path.endsWith(".py")) return new RegExp(`def\\s+${escapeRegExp(name)}\\s*\\(`);
  return new RegExp(`(?:it|test)\\s*\\(\\s*["'\`]${escapeRegExp(name)}["'\`]`);
}

function testFileResolves(test: { repo: GateRepo; path: string; name: string }): boolean {
  const repoRoot = REPO_ROOTS[test.repo];
  if (!existsSync(repoRoot)) return false;
  const absolute = join(repoRoot, test.path);
  if (!existsSync(absolute)) return false;
  return testPattern(test.path, test.name).test(readFileSync(absolute, "utf8"));
}

function minimalCheck(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "c",
    requirement: "r",
    kind: "automated",
    status: "pending",
    repo: "mcp_server",
    tests: [{ repo: "mcp_server", path: "mutant-mcp/tests/tool-audit.test.ts", name: "x" }],
    ...overrides,
  };
}

describe("privacy release gate", () => {
  it("covers every required PRIV-10 requirement", () => {
    const ids = new Set(privacyReleaseGate.checks.map((check) => check.id));
    for (const id of REQUIRED_CHECK_IDS) {
      expect(ids.has(id), `missing gate check: ${id}`).toBe(true);
    }
  });

  it("marks the six focused-suite categories automated", () => {
    for (const id of REQUIRED_AUTOMATED_IDS) {
      expect(getGateCheck(id).kind, `${id} should be automated`).toBe("automated");
    }
  });

  it("resolves every available automated test id to a real named test", () => {
    for (const check of privacyReleaseGate.checks) {
      if (check.kind !== "automated") continue;
      const available = check.tests.filter((test) => existsSync(REPO_ROOTS[test.repo]));
      // Nothing verifiable to check when a whole repo is absent (CI checks out
      // only mcp_server); the verifier reports those rows as external.
      if (available.length === 0) continue;
      for (const test of available) {
        expect(
          testFileResolves(test),
          `${check.id}: ${test.repo}:${test.path} has no test named ${JSON.stringify(test.name)}`,
        ).toBe(true);
      }
    }
  });

  it("never marks a check verified without its evidence", () => {
    for (const check of privacyReleaseGate.checks) {
      if (check.status !== "verified") continue;
      if (check.kind === "automated") {
        expect(check.tests.length, `${check.id} is verified but has no tests`).toBeGreaterThan(0);
      } else {
        expect(check.evidenceRef, `${check.id} is verified but has no evidenceRef`).toBeDefined();
      }
    }
  });

  it("keeps the deployed/manual rows out of the automated gate", () => {
    for (const id of ["staging-walk", "release-evidence", "golden-routing-provenance"]) {
      const check = getGateCheck(id);
      expect(check.kind).not.toBe("automated");
    }
  });

  it("rejects an automated row with no tests", () => {
    expect(() =>
      parsePrivacyReleaseGate({
        version: "1",
        updatedAt: "2026-10-02",
        backlogItem: "PRIV-10",
        checks: [minimalCheck({ tests: [] })],
      }),
    ).toThrow(/automated/);
  });

  it("rejects a manual row with no evidence reference", () => {
    expect(() =>
      parsePrivacyReleaseGate({
        version: "1",
        updatedAt: "2026-10-02",
        backlogItem: "PRIV-10",
        checks: [minimalCheck({ kind: "manual", tests: undefined })],
      }),
    ).toThrow(/evidenceRef/);
  });

  it("rejects an unknown kind, status, repo, and duplicate id", () => {
    const base = { version: "1", updatedAt: "2026-10-02", backlogItem: "PRIV-10" };
    expect(() =>
      parsePrivacyReleaseGate({ ...base, checks: [minimalCheck({ kind: "vibes" })] }),
    ).toThrow(/kind/);
    expect(() =>
      parsePrivacyReleaseGate({ ...base, checks: [minimalCheck({ status: "green" })] }),
    ).toThrow(/status/);
    expect(() =>
      parsePrivacyReleaseGate({ ...base, checks: [minimalCheck({ repo: "elsewhere" })] }),
    ).toThrow(/repo/);
    expect(() =>
      parsePrivacyReleaseGate({ ...base, checks: [minimalCheck({}), minimalCheck({})] }),
    ).toThrow(/duplicate/);
  });

  it("throws for an unknown check id", () => {
    expect(() => getGateCheck("does-not-exist")).toThrow(/no check/);
  });

  it("keeps golden routing traces from being flipped to observed by this gate", () => {
    const tracesPath = join(PACKAGE_ROOT, "tests", "golden-prompt-routing-traces.json");
    const traces = JSON.parse(readFileSync(tracesPath, "utf8")) as {
      traces: Array<{ provenance: string; capturedAt: string | null }>;
    };
    // The gate does not assert traces are observed; it forbids claiming they are
    // without a capture. A provenance off the contract is a data error.
    for (const trace of traces.traces) {
      expect(["observed", "pending-manual-capture"]).toContain(trace.provenance);
      if (trace.provenance === "observed") {
        expect(typeof trace.capturedAt).toBe("string");
      } else {
        expect(trace.capturedAt).toBeNull();
      }
    }
    // PRIV-10 must not report routing provenance as automated/verified.
    expect(getGateCheck("golden-routing-provenance").status).not.toBe("verified");
  });

  it("carries a requirement and a resolvable evidence pointer for every check", () => {
    for (const check of privacyReleaseGate.checks) {
      expect(check.requirement.trim().length, `${check.id} needs a requirement`).toBeGreaterThan(0);
      if (check.kind === "automated") {
        for (const test of check.tests) {
          expect(test.path, `${check.id} test path`).toBeTruthy();
          expect(test.name, `${check.id} test name`).toBeTruthy();
        }
      } else {
        expect(check.evidenceRef?.path, `${check.id} evidence path`).toBeTruthy();
        expect(check.evidenceRef?.section, `${check.id} evidence section`).toBeTruthy();
      }
    }
  });

  it("keeps the six automated categories verifiable end to end", () => {
    // The focused CI suite must name the same files the gate points at; this is
    // the seam between `test:privacy` and the manifest.
    const suite = readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8");
    expect(suite).toContain("test:privacy");
    for (const id of REQUIRED_AUTOMATED_IDS) {
      const check: GateCheck = getGateCheck(id);
      const mcpFiles = check.tests
        .filter((test) => test.repo === "mcp_server")
        .map((test) => test.path.replace("mutant-mcp/", ""));
      for (const file of mcpFiles) {
        expect(suite, `test:privacy must run ${file}`).toContain(file);
      }
    }
  });
});
