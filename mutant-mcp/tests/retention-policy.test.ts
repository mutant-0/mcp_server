/**
 * PRIV-06 retention policy invariants.
 *
 * The checked-in policy is the single source of truth the CDK stack, the apply
 * script, and the verify report all read. These tests pin the properties that
 * keep it honest: every inventoried store has a row, a `decided` row always
 * carries a positive period, and a `pending` value is never coerced into an
 * invented retention period.
 */
import { describe, expect, it } from "vitest";
import {
  appliedRetentionDays,
  getRetentionStore,
  isResolved,
  parseRetentionPolicy,
  retentionPolicy,
  storesManagedBy,
} from "../infrastructure/lib/retention-policy.js";

/** Every store in docs/privacy/data-inventory.md section 2 must be represented. */
const REQUIRED_STORE_IDS = [
  "s3-raw-genetic-data",
  "ddb-user-genomics",
  "ddb-results",
  "ddb-assessments",
  "ddb-recommendations",
  "ddb-status",
  "ddb-consent-records",
  "cw-mcp-log-group",
  "cw-backend-report-generator",
  "cw-backend-store",
  "backups",
];

function minimalStore(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "s",
    store: "s",
    kind: "dynamodb-table",
    managedBy: "applier",
    protectedClass: "genetic-derived",
    enforcement: "dynamodb-ttl",
    retentionDays: null,
    status: "pending",
    owner: "infrastructure",
    decisionRef: "P3",
    enforceLogicalExpiry: false,
    ...overrides,
  };
}

describe("retention policy", () => {
  it("covers every inventoried store", () => {
    const ids = new Set(retentionPolicy.stores.map((row) => row.id));
    for (const id of REQUIRED_STORE_IDS) {
      expect(ids.has(id), `missing store row: ${id}`).toBe(true);
    }
  });

  it("never marks a store resolved without an approved period", () => {
    for (const store of retentionPolicy.stores) {
      if (store.status === "pending") {
        expect(isResolved(store)).toBe(false);
      }
    }
  });

  it("keeps a pending period explicit rather than coercing it to a number", () => {
    const pending = retentionPolicy.stores.filter((row) => row.status === "pending");
    expect(pending.length).toBeGreaterThan(0);
    // The MCP log group carries the *existing deployed* value while still
    // pending; every other pending row has no period.
    for (const store of pending) {
      if (store.id !== "cw-mcp-log-group") {
        expect(appliedRetentionDays(store)).toBeNull();
      }
    }
  });

  it("rejects a decided row with no period", () => {
    expect(() =>
      parseRetentionPolicy({
        version: "1",
        updatedAt: "2026-10-01",
        decisionRef: "P3",
        stores: [minimalStore({ status: "decided", retentionDays: null })],
      }),
    ).toThrow(/decided/);
  });

  it("rejects an unknown enforcement", () => {
    expect(() =>
      parseRetentionPolicy({
        version: "1",
        updatedAt: "2026-10-01",
        decisionRef: "P3",
        stores: [minimalStore({ enforcement: "delete-everything" })],
      }),
    ).toThrow(/enforcement/);
  });

  it("rejects duplicate store ids", () => {
    expect(() =>
      parseRetentionPolicy({
        version: "1",
        updatedAt: "2026-10-01",
        decisionRef: "P3",
        stores: [minimalStore({}), minimalStore({})],
      }),
    ).toThrow(/duplicate/);
  });

  it("throws for an unknown store id", () => {
    expect(() => getRetentionStore("does-not-exist")).toThrow(/no store/);
  });

  it("assigns the MCP log group to CDK and the backend tables to the applier", () => {
    expect(getRetentionStore("cw-mcp-log-group").managedBy).toBe("cdk");
    expect(
      storesManagedBy("applier").some((row) => row.id === "cw-backend-report-generator"),
    ).toBe(true);
  });
});
