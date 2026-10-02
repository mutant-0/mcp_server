/**
 * PRIV-10 privacy release-gate verification (read-only).
 *
 * Loads `docs/privacy/release-gate.json`, resolves every automated row's named
 * test against the tree, and reports the manual/deploy rows that still require
 * deployed evidence. Prints a table plus a machine-readable object and writes
 * `privacy-release-report.json`.
 *
 *   npm run verify:privacy             # automated gate: fails on a broken test id
 *   npm run verify:privacy -- --release # additionally fails while manual/deploy evidence is pending
 *
 * It never reads user data and never edits the gate or the routing traces. A
 * `pending` row is not a pass.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  privacyReleaseGate,
  type GateCheck,
  type GateRepo,
  type GateTestRef,
} from "../infrastructure/lib/privacy-release-gate.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

const REPO_ROOTS: Record<GateRepo, string> = {
  mcp_server: resolve(PACKAGE_ROOT, ".."),
  "back-end": resolve(PACKAGE_ROOT, "..", "..", "back-end"),
};

type TestStatus = "resolved" | "missing" | "external";

interface TestObservation {
  repo: GateRepo;
  path: string;
  name: string;
  status: TestStatus;
}

interface CheckObservation {
  id: string;
  kind: string;
  status: string;
  repo: GateRepo;
  resolved: boolean;
  unresolved: number;
  external: number;
  detail: string;
  tests: TestObservation[];
  evidence?: { path: string; section: string; present: boolean };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function testPattern(path: string, name: string): RegExp {
  if (path.endsWith(".py")) return new RegExp(`def\\s+${escapeRegExp(name)}\\s*\\(`);
  return new RegExp(`(?:it|test)\\s*\\(\\s*["'\`]${escapeRegExp(name)}["'\`]`);
}

function observeTest(test: GateTestRef): TestObservation {
  const repoRoot = REPO_ROOTS[test.repo];
  if (!existsSync(repoRoot)) {
    return { ...test, status: "external" };
  }
  const absolute = join(repoRoot, test.path);
  if (!existsSync(absolute)) {
    return { ...test, status: "missing" };
  }
  const source = readFileSync(absolute, "utf8");
  return {
    ...test,
    status: testPattern(test.path, test.name).test(source) ? "resolved" : "missing",
  };
}

function observeCheck(check: GateCheck): CheckObservation {
  const tests = check.tests.map(observeTest);
  const missing = tests.filter((test) => test.status === "missing").length;
  const external = tests.filter((test) => test.status === "external").length;
  const resolved = tests.length > 0 && missing === 0;

  let detail: string;
  if (check.kind !== "automated") {
    detail =
      check.status === "verified"
        ? "evidence recorded"
        : `${check.status}: ${check.evidenceRef?.path ?? "no"} §${check.evidenceRef?.section ?? "-"} requires deployed/manual evidence`;
  } else if (missing > 0) {
    detail = `${missing} test(s) not found in a present repository`;
  } else if (external > 0) {
    detail = `${external} test(s) in a repository not checked out here`;
  } else {
    detail = "ok";
  }

  const evidenceRef = check.evidenceRef;
  const evidence = evidenceRef
    ? {
        ...evidenceRef,
        present: existsSync(join(REPO_ROOTS[check.repo], evidenceRef.path)),
      }
    : undefined;

  return {
    id: check.id,
    kind: check.kind,
    status: check.status,
    repo: check.repo,
    resolved,
    unresolved: missing,
    external,
    detail,
    tests,
    ...(evidence ? { evidence } : {}),
  };
}

function main(): void {
  const release = process.argv.includes("--release");
  const observations = privacyReleaseGate.checks.map(observeCheck);

  const unresolvedAutomated = observations.filter(
    (row) => row.kind === "automated" && row.unresolved > 0,
  ).length;
  const unverifiedManual = observations.filter(
    (row) => row.kind !== "automated" && row.status !== "verified",
  ).length;

  const report = {
    generatedAt: new Date().toISOString(),
    gateVersion: privacyReleaseGate.version,
    backlogItem: privacyReleaseGate.backlogItem,
    decisionRefs: privacyReleaseGate.decisionRefs,
    mode: release ? "release" : "automated",
    unresolvedAutomated,
    unverifiedManual,
    checks: observations,
  };

  const heading = ["CHECK", "KIND", "STATUS", "TESTS", "RESULT"];
  console.log(heading.join("\t"));
  for (const row of observations) {
    const tests = row.tests.length === 0 ? "-" : `${row.tests.length}`;
    let result: string;
    if (row.kind !== "automated") {
      result = row.status === "verified" ? "VERIFIED" : `NOT VERIFIED (${row.detail})`;
    } else if (row.unresolved > 0) {
      result = `UNRESOLVED (${row.detail})`;
    } else if (row.external > 0) {
      result = `PARTIAL (${row.detail})`;
    } else {
      result = "RESOLVED";
    }
    console.log([row.id, row.kind, row.status, tests, result].join("\t"));
  }

  console.log("\n--- privacy-release-report.json ---");
  console.log(JSON.stringify(report, null, 2));
  writeFileSync(
    join(PACKAGE_ROOT, "privacy-release-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  const failed = unresolvedAutomated > 0 || (release && unverifiedManual > 0);
  if (failed) {
    console.error(
      `\nPRIV-10 NOT CLOSED: ${unresolvedAutomated} automated check(s) unresolved` +
        (release ? `, ${unverifiedManual} manual/deploy check(s) not verified` : "") +
        ". A pending row is not a pass.",
    );
    process.exitCode = 1;
  } else if (!release) {
    console.log(
      `\nAutomated gate clear; ${unverifiedManual} manual/deploy check(s) still require evidence ` +
        "(run with --release to enforce them).",
    );
  }
}

main();
