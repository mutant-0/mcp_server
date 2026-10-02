/**
 * PRIV-06 retention policy loader.
 *
 * `retention-policy.json` is the single source of truth for what retention is
 * applied to each inventoried store and whether that value is an approved owner
 * commitment or merely current/unset configuration awaiting decision P3. The CDK
 * stack, the apply script, and the read-only verify report all read it here so
 * they cannot disagree.
 *
 * The loader never invents a period: a `null`/`pending` row stays `null`, and a
 * `decided` row without a positive period is a configuration error.
 */
import rawPolicy from "../retention-policy.json";

export type RetentionEnforcement =
  | "log-retention"
  | "dynamodb-ttl"
  | "s3-lifecycle"
  | "pending";

export type RetentionStatus = "decided" | "pending";

export type RetentionManagedBy = "cdk" | "applier" | "runtime";

export interface RetentionStore {
  id: string;
  store: string;
  kind: string;
  managedBy: RetentionManagedBy;
  protectedClass: string;
  enforcement: RetentionEnforcement;
  ttlAttribute?: string;
  /** Concrete log-group names an applier manages. */
  logGroupNames?: string[];
  /** Prefix used to discover log groups (e.g. the MCP group per environment). */
  logGroupPattern?: string;
  retentionDays: number | null;
  status: RetentionStatus;
  owner: string;
  decisionRef: string;
  enforceLogicalExpiry: boolean;
  note?: string;
}

export interface RetentionPolicy {
  version: string;
  updatedAt: string;
  decisionRef: string;
  stores: RetentionStore[];
}

const ENFORCEMENTS: ReadonlySet<string> = new Set<string>([
  "log-retention",
  "dynamodb-ttl",
  "s3-lifecycle",
  "pending",
]);

const STATUSES: ReadonlySet<string> = new Set<string>(["decided", "pending"]);

const MANAGED_BY: ReadonlySet<string> = new Set<string>(["cdk", "applier", "runtime"]);

function fail(message: string): never {
  throw new Error(`retention-policy.json: ${message}`);
}

function parseStore(value: unknown, index: number): RetentionStore {
  if (typeof value !== "object" || value === null) {
    fail(`stores[${index}] must be an object`);
  }
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) fail(`stores[${index}].id is required`);
  for (const key of ["store", "kind", "protectedClass", "owner", "decisionRef"] as const) {
    if (typeof row[key] !== "string" || !(row[key] as string).trim()) {
      fail(`${id}: ${key} is required`);
    }
  }
  const enforcement = String(row.enforcement ?? "");
  if (!ENFORCEMENTS.has(enforcement)) {
    fail(`${id}: enforcement ${JSON.stringify(row.enforcement)} is not one of ${[...ENFORCEMENTS].join(", ")}`);
  }
  const status = String(row.status ?? "");
  if (!STATUSES.has(status)) {
    fail(`${id}: status ${JSON.stringify(row.status)} is not one of ${[...STATUSES].join(", ")}`);
  }
  const managedBy = String(row.managedBy ?? "");
  if (!MANAGED_BY.has(managedBy)) {
    fail(`${id}: managedBy ${JSON.stringify(row.managedBy)} is not one of ${[...MANAGED_BY].join(", ")}`);
  }

  const rawDays = row.retentionDays;
  let retentionDays: number | null;
  if (rawDays === null || rawDays === undefined) {
    retentionDays = null;
  } else if (typeof rawDays === "number" && Number.isInteger(rawDays) && rawDays > 0) {
    retentionDays = rawDays;
  } else {
    fail(`${id}: retentionDays must be a positive integer or null`);
  }

  // A "decided" row is an approved commitment; it cannot be an absent period.
  // A pending row may carry the current deployed value (e.g. the MCP log group's
  // existing 30 days) without that value being an approved schedule.
  if (status === "decided" && retentionDays === null) {
    fail(`${id}: status "decided" requires a positive retentionDays`);
  }

  if (row.ttlAttribute !== undefined && typeof row.ttlAttribute !== "string") {
    fail(`${id}: ttlAttribute must be a string when present`);
  }
  if (row.logGroupNames !== undefined) {
    if (
      !Array.isArray(row.logGroupNames) ||
      row.logGroupNames.some((name) => typeof name !== "string" || !name.trim())
    ) {
      fail(`${id}: logGroupNames must be an array of non-empty strings when present`);
    }
  }
  if (row.logGroupPattern !== undefined && typeof row.logGroupPattern !== "string") {
    fail(`${id}: logGroupPattern must be a string when present`);
  }
  if (typeof row.enforceLogicalExpiry !== "boolean") {
    fail(`${id}: enforceLogicalExpiry must be a boolean`);
  }
  if (row.note !== undefined && typeof row.note !== "string") {
    fail(`${id}: note must be a string when present`);
  }

  return {
    id,
    store: String(row.store),
    kind: String(row.kind),
    managedBy: managedBy as RetentionManagedBy,
    protectedClass: String(row.protectedClass),
    enforcement: enforcement as RetentionEnforcement,
    ...(row.ttlAttribute !== undefined ? { ttlAttribute: String(row.ttlAttribute) } : {}),
    ...(row.logGroupNames !== undefined
      ? { logGroupNames: (row.logGroupNames as string[]).map((name) => String(name)) }
      : {}),
    ...(row.logGroupPattern !== undefined
      ? { logGroupPattern: String(row.logGroupPattern) }
      : {}),
    retentionDays,
    status: status as RetentionStatus,
    owner: String(row.owner),
    decisionRef: String(row.decisionRef),
    enforceLogicalExpiry: row.enforceLogicalExpiry,
    ...(row.note !== undefined ? { note: String(row.note) } : {}),
  };
}

function loadPolicy(): RetentionPolicy {
  return parseRetentionPolicy(rawPolicy);
}

/**
 * Validate and normalize a policy document.
 *
 * Exported so the invariants this file enforces (every row is declared, a
 * `decided` row has a positive period, a `pending` row is never coerced) can be
 * tested against synthetic input, not only the checked-in policy.
 */
export function parseRetentionPolicy(root: unknown): RetentionPolicy {
  if (typeof root !== "object" || root === null) {
    fail("root must be an object");
  }
  const parsed = root as Record<string, unknown>;
  if (!Array.isArray(parsed.stores) || parsed.stores.length === 0) {
    fail("stores must be a non-empty array");
  }
  const stores = parsed.stores.map((row, index) => parseStore(row, index));
  const seen = new Set<string>();
  for (const row of stores) {
    if (seen.has(row.id)) fail(`duplicate store id ${row.id}`);
    seen.add(row.id);
  }
  return {
    version: String(parsed.version ?? ""),
    updatedAt: String(parsed.updatedAt ?? ""),
    decisionRef: String(parsed.decisionRef ?? ""),
    stores,
  };
}

export const retentionPolicy: RetentionPolicy = loadPolicy();

export function getRetentionStore(id: string): RetentionStore {
  const row = retentionPolicy.stores.find((candidate) => candidate.id === id);
  if (!row) fail(`no store with id ${JSON.stringify(id)}`);
  return row;
}

export function storesManagedBy(managedBy: RetentionManagedBy): RetentionStore[] {
  return retentionPolicy.stores.filter((row) => row.managedBy === managedBy);
}

/** A store closes only when its applied value is an approved commitment. */
export function isResolved(store: RetentionStore): boolean {
  return store.status === "decided" && store.retentionDays !== null;
}

/** Applied value, or `null` when no retention is currently enforced. */
export function appliedRetentionDays(store: RetentionStore): number | null {
  return store.retentionDays;
}
