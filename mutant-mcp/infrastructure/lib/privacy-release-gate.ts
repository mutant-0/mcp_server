/**
 * PRIV-10 privacy release-gate loader.
 *
 * `docs/privacy/release-gate.json` is the single source of truth for which
 * privacy requirements are backed by a named automated test and which still
 * require deployed/manual evidence. `scripts/verify-privacy-gate.ts` and
 * `tests/privacy-release-gate.test.ts` both read it here so the gate cannot be
 * hand-edited into a pass: a row is only `verified` while its evidence (a real
 * test id, or an evidence reference) is present, and the verifier resolves the
 * test ids against the tree.
 *
 * The loader never invents evidence. A `pending`/`blocked` row stays unresolved,
 * and an automated row with no `tests[]` is a configuration error.
 */
import rawGate from "../../docs/privacy/release-gate.json";

export type GateCheckKind = "automated" | "manual" | "deploy";

export type GateCheckStatus = "verified" | "pending" | "blocked";

export type GateRepo = "mcp_server" | "back-end";

export interface GateTestRef {
  repo: GateRepo;
  /** Repo-root-relative path, e.g. `mutant-mcp/tests/tool-audit.test.ts`. */
  path: string;
  /** The test's own name as it appears in the source file. */
  name: string;
}

export interface GateEvidenceRef {
  /** Repo-root-relative path to the document holding the evidence. */
  path: string;
  /** Section within that document, e.g. `11c`. */
  section: string;
}

export interface GateCheck {
  id: string;
  requirement: string;
  kind: GateCheckKind;
  status: GateCheckStatus;
  repo: GateRepo;
  tests: GateTestRef[];
  evidenceRef?: GateEvidenceRef;
  note?: string;
}

export interface PrivacyReleaseGate {
  version: string;
  updatedAt: string;
  backlogItem: string;
  decisionRefs: string[];
  checks: GateCheck[];
}

const KINDS: ReadonlySet<string> = new Set<string>(["automated", "manual", "deploy"]);
const STATUSES: ReadonlySet<string> = new Set<string>(["verified", "pending", "blocked"]);
const REPOS: ReadonlySet<string> = new Set<string>(["mcp_server", "back-end"]);

function fail(message: string): never {
  throw new Error(`release-gate.json: ${message}`);
}

function parseRepo(value: unknown, where: string): GateRepo {
  const repo = String(value ?? "");
  if (!REPOS.has(repo)) {
    fail(`${where}: repo ${JSON.stringify(value)} is not one of ${[...REPOS].join(", ")}`);
  }
  return repo as GateRepo;
}

function parseTestRef(value: unknown, id: string, index: number): GateTestRef {
  if (typeof value !== "object" || value === null) {
    fail(`${id}: tests[${index}] must be an object`);
  }
  const row = value as Record<string, unknown>;
  const path = typeof row.path === "string" ? row.path.trim() : "";
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!path) fail(`${id}: tests[${index}].path is required`);
  if (!name) fail(`${id}: tests[${index}].name is required`);
  return { repo: parseRepo(row.repo, `${id}.tests[${index}]`), path, name };
}

function parseEvidenceRef(value: unknown, id: string): GateEvidenceRef {
  if (typeof value !== "object" || value === null) {
    fail(`${id}: evidenceRef must be an object`);
  }
  const row = value as Record<string, unknown>;
  const path = typeof row.path === "string" ? row.path.trim() : "";
  const section = typeof row.section === "string" ? row.section.trim() : "";
  if (!path) fail(`${id}: evidenceRef.path is required`);
  if (!section) fail(`${id}: evidenceRef.section is required`);
  return { path, section };
}

function parseCheck(value: unknown, index: number): GateCheck {
  if (typeof value !== "object" || value === null) {
    fail(`checks[${index}] must be an object`);
  }
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) fail(`checks[${index}].id is required`);
  if (typeof row.requirement !== "string" || !row.requirement.trim()) {
    fail(`${id}: requirement is required`);
  }

  const kind = String(row.kind ?? "");
  if (!KINDS.has(kind)) {
    fail(`${id}: kind ${JSON.stringify(row.kind)} is not one of ${[...KINDS].join(", ")}`);
  }
  const status = String(row.status ?? "");
  if (!STATUSES.has(status)) {
    fail(`${id}: status ${JSON.stringify(row.status)} is not one of ${[...STATUSES].join(", ")}`);
  }
  const repo = parseRepo(row.repo, id);

  const rawTests = row.tests;
  if (rawTests !== undefined && !Array.isArray(rawTests)) {
    fail(`${id}: tests must be an array when present`);
  }
  const tests = Array.isArray(rawTests)
    ? rawTests.map((entry, testIndex) => parseTestRef(entry, id, testIndex))
    : [];

  const evidenceRef =
    row.evidenceRef !== undefined ? parseEvidenceRef(row.evidenceRef, id) : undefined;

  // An automated row is backed by tests; a manual/deploy row is backed by an
  // evidence reference. A verified row of either kind must carry its evidence.
  if (kind === "automated" && tests.length === 0) {
    fail(`${id}: an automated row requires at least one tests[] entry`);
  }
  if (kind !== "automated" && !evidenceRef) {
    fail(`${id}: a ${kind} row requires an evidenceRef`);
  }
  if (row.note !== undefined && typeof row.note !== "string") {
    fail(`${id}: note must be a string when present`);
  }

  return {
    id,
    requirement: String(row.requirement),
    kind: kind as GateCheckKind,
    status: status as GateCheckStatus,
    repo,
    tests,
    ...(evidenceRef ? { evidenceRef } : {}),
    ...(row.note !== undefined ? { note: String(row.note) } : {}),
  };
}

/**
 * Validate and normalize a gate document.
 *
 * Exported so the invariants this file enforces can be tested against synthetic
 * input, not only the checked-in gate.
 */
export function parsePrivacyReleaseGate(root: unknown): PrivacyReleaseGate {
  if (typeof root !== "object" || root === null) {
    fail("root must be an object");
  }
  const parsed = root as Record<string, unknown>;
  if (!Array.isArray(parsed.checks) || parsed.checks.length === 0) {
    fail("checks must be a non-empty array");
  }
  const checks = parsed.checks.map((row, index) => parseCheck(row, index));
  const seen = new Set<string>();
  for (const check of checks) {
    if (seen.has(check.id)) fail(`duplicate check id ${check.id}`);
    seen.add(check.id);
  }
  const decisionRefs = Array.isArray(parsed.decisionRefs)
    ? parsed.decisionRefs.map((ref) => String(ref))
    : [];
  return {
    version: String(parsed.version ?? ""),
    updatedAt: String(parsed.updatedAt ?? ""),
    backlogItem: String(parsed.backlogItem ?? ""),
    decisionRefs,
    checks,
  };
}

function loadGate(): PrivacyReleaseGate {
  return parsePrivacyReleaseGate(rawGate);
}

export const privacyReleaseGate: PrivacyReleaseGate = loadGate();

export function getGateCheck(id: string): GateCheck {
  const row = privacyReleaseGate.checks.find((candidate) => candidate.id === id);
  if (!row) fail(`no check with id ${JSON.stringify(id)}`);
  return row;
}

export function checksByKind(kind: GateCheckKind): GateCheck[] {
  return privacyReleaseGate.checks.filter((check) => check.kind === kind);
}

/** A check is verified only when its own status says so. */
export function isVerified(check: GateCheck): boolean {
  return check.status === "verified";
}
