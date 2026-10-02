/**
 * PRIV-06 retention verification report (read-only).
 *
 * Compares the deployed configuration of every inventoried store against
 * `infrastructure/retention-policy.json` and prints the result as a table plus a
 * machine-readable JSON object. A store that has no approved period (`pending`)
 * or whose observed configuration differs from the approved value is reported
 * UNRESOLVED and makes the command exit non-zero, so an incomplete retention
 * posture cannot be recorded as a pass.
 *
 * It never lists user S3 keys or reads table items: only bucket/table/log-group
 * configuration is described. Run from the MCP repo root:
 *
 *   npm run verify:retention
 */
import { awsJsonSafe, REGION } from "./retention-shared.js";
import {
  isResolved,
  retentionPolicy,
  type RetentionStore,
} from "../infrastructure/lib/retention-policy.js";

/** Read-only IAM actions this report requires. */
const IAM_ACTIONS = [
  "logs:DescribeLogGroups",
  "logs:DescribeExportTasks",
  "dynamodb:DescribeTimeToLive",
  "s3:GetLifecycleConfiguration",
  "s3:GetBucketVersioning",
];

interface StoreObservation {
  id: string;
  store: string;
  enforcement: string;
  protectedClass: string;
  status: string;
  approvedRetentionDays: number | null;
  observed: unknown;
  matches: boolean;
  resolved: boolean;
  detail: string;
}

interface LogGroupSummary {
  logGroupName: string;
  retentionInDays: number | null;
}

function describeLogGroups(prefix: string): LogGroupSummary[] | null {
  const response = awsJsonSafe<{ logGroups?: Array<Record<string, unknown>> }>([
    "logs",
    "describe-log-groups",
    "--log-group-name-prefix",
    prefix,
  ]);
  if (!response || !Array.isArray(response.logGroups)) return null;
  return response.logGroups.map((group) => ({
    logGroupName: String(group.logGroupName ?? ""),
    retentionInDays:
      typeof group.retentionInDays === "number" ? (group.retentionInDays as number) : null,
  }));
}

function observeLogGroup(store: RetentionStore): {
  observed: LogGroupSummary[] | string;
  matches: boolean;
} {
  const names = store.logGroupNames ?? [];
  const prefixes = names.length > 0 ? names : store.logGroupPattern ? [store.logGroupPattern] : [];
  if (prefixes.length === 0) {
    return { observed: "no log-group names/pattern configured", matches: false };
  }
  const groups: LogGroupSummary[] = [];
  for (const prefix of prefixes) {
    const found = describeLogGroups(prefix);
    if (found === null) return { observed: "describe-log-groups unavailable", matches: false };
    for (const group of found) {
      if (names.length > 0 && group.logGroupName !== prefix) continue;
      groups.push(group);
    }
  }
  if (groups.length === 0) {
    return { observed: "no matching log groups", matches: false };
  }
  const matches =
    store.retentionDays !== null &&
    groups.every((group) => group.retentionInDays === store.retentionDays);
  return { observed: groups, matches };
}

function observeDynamo(store: RetentionStore): { observed: unknown; matches: boolean } {
  const response = awsJsonSafe<{ TimeToLiveDescription?: Record<string, unknown> }>([
    "dynamodb",
    "describe-time-to-live",
    "--table-name",
    store.store,
  ]);
  if (!response?.TimeToLiveDescription) {
    return { observed: "describe-time-to-live unavailable", matches: false };
  }
  const description = response.TimeToLiveDescription;
  const matches =
    store.retentionDays !== null &&
    store.ttlAttribute !== undefined &&
    String(description.TimeToLiveStatus ?? "") === "ENABLED" &&
    String(description.AttributeName ?? "") === store.ttlAttribute;
  return { observed: description, matches };
}

function observeS3(store: RetentionStore): { observed: unknown; matches: boolean } {
  const lifecycle = awsJsonSafe<{ Rules?: Array<Record<string, unknown>> }>([
    "s3api",
    "get-bucket-lifecycle-configuration",
    "--bucket",
    store.store,
  ]);
  const versioning = awsJsonSafe<Record<string, unknown>>([
    "s3api",
    "get-bucket-versioning",
    "--bucket",
    store.store,
  ]);
  const rules = lifecycle?.Rules ?? [];
  const hasExpiry =
    store.retentionDays !== null &&
    rules.some((rule) => {
      const expiration = rule.Expiration as Record<string, unknown> | undefined;
      return Number(expiration?.Days ?? 0) === store.retentionDays;
    });
  return {
    observed: { lifecycle: lifecycle ?? "unavailable", versioning: versioning ?? "unavailable" },
    matches: hasExpiry,
  };
}

function observe(store: RetentionStore): { observed: unknown; matches: boolean } {
  switch (store.enforcement) {
    case "log-retention":
      return observeLogGroup(store);
    case "dynamodb-ttl":
      return observeDynamo(store);
    case "s3-lifecycle":
      return observeS3(store);
    default:
      return { observed: "no runtime/retention enforcement owned by this report", matches: false };
  }
}

function exportDestinations(): string[] | string {
  const response = awsJsonSafe<{ exportTasks?: Array<Record<string, unknown>> }>([
    "logs",
    "describe-export-tasks",
  ]);
  if (!response) return "describe-export-tasks unavailable";
  return (response.exportTasks ?? []).map(
    (task) => String(task.destination ?? task.destinationPrefix ?? "unknown"),
  );
}

function main(): void {
  const observations: StoreObservation[] = retentionPolicy.stores.map((store) => {
    const { observed, matches } = observe(store);
    const resolved = isResolved(store) && matches;
    let detail: string;
    if (store.status !== "decided") {
      detail = `pending ${store.decisionRef}: no approved retention period`;
    } else if (!matches) {
      detail = "observed configuration differs from approved value";
    } else {
      detail = "ok";
    }
    return {
      id: store.id,
      store: store.store,
      enforcement: store.enforcement,
      protectedClass: store.protectedClass,
      status: store.status,
      approvedRetentionDays: store.retentionDays,
      observed,
      matches,
      resolved,
      detail,
    };
  });

  const unresolved = observations.filter((row) => !row.resolved).length;
  const report = {
    generatedAt: new Date().toISOString(),
    region: REGION,
    policyVersion: retentionPolicy.version,
    decisionRef: retentionPolicy.decisionRef,
    iamActions: IAM_ACTIONS,
    logExportDestinations: exportDestinations(),
    unresolved,
    stores: observations,
  };

  const heading = ["STORE", "ENFORCEMENT", "APPROVED", "STATUS", "RESULT"];
  console.log(heading.join("\t"));
  for (const row of observations) {
    console.log(
      [
        row.store,
        row.enforcement,
        row.approvedRetentionDays === null ? "-" : `${row.approvedRetentionDays}d`,
        row.status,
        row.resolved ? "RESOLVED" : `UNRESOLVED (${row.detail})`,
      ].join("\t"),
    );
  }

  console.log("\n--- retention-report.json ---");
  console.log(JSON.stringify(report, null, 2));

  if (unresolved > 0) {
    console.error(
      `\nPRIV-06 NOT CLOSED: ${unresolved} store(s) unresolved. ` +
        `Approved periods are an owner decision (${retentionPolicy.decisionRef}).`,
    );
    process.exitCode = 1;
  }
}

main();
