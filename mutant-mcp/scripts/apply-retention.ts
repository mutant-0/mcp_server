/**
 * PRIV-06 retention applier (dry-run by default).
 *
 * Reads `infrastructure/retention-policy.json` and applies the configured
 * retention to the stores it owns (`managedBy: "applier"`): backend CloudWatch
 * log groups, DynamoDB TTL, and the raw-file S3 bucket lifecycle. The MCP log
 * group is managed by CDK and the runtime clock by the application, so both are
 * skipped here.
 *
 * It is idempotent and safe to re-run. A `pending` row (no approved period) is a
 * no-op: this script never invents a retention period. Pass `--apply` to make
 * changes; without it every action is printed, not executed.
 *
 * Usage:
 *   npm run apply:retention            # dry run, print planned actions
 *   npm run apply:retention -- --apply # execute
 */
import { aws, REGION } from "./retention-shared.js";
import {
  retentionPolicy,
  storesManagedBy,
  type RetentionStore,
} from "../infrastructure/lib/retention-policy.js";

interface PlannedAction {
  storeId: string;
  target: string;
  action: string;
  command: string[] | null;
  skippedReason?: string;
}

function actionForLogGroup(
  store: RetentionStore,
  groupName: string,
  retentionDays: number,
): PlannedAction {
  return {
    storeId: store.id,
    target: groupName,
    action: `set log-group retention to ${retentionDays} days`,
    command: [
      "logs",
      "put-retention-policy",
      "--log-group-name",
      groupName,
      "--retention-in-days",
      String(retentionDays),
    ],
  };
}

function actionForTtl(store: RetentionStore, retentionDays: number): PlannedAction {
  return {
    storeId: store.id,
    target: store.store,
    action: `enable DynamoDB TTL on ${store.ttlAttribute} (${retentionDays} days)`,
    command: [
      "dynamodb",
      "update-time-to-live",
      "--table-name",
      store.store,
      "--time-to-live-specification",
      `Enabled=true,AttributeName=${store.ttlAttribute}`,
    ],
  };
}

function actionForS3(store: RetentionStore, retentionDays: number): PlannedAction {
  const configuration = {
    Rules: [
      {
        ID: `priv-06-${store.id}`,
        Status: "Enabled",
        Filter: { Prefix: "users/" },
        Expiration: { Days: retentionDays },
        NoncurrentVersionExpiration: { NoncurrentDays: retentionDays },
      },
    ],
  };
  return {
    storeId: store.id,
    target: store.store,
    action: `apply S3 lifecycle expiry of ${retentionDays} days`,
    command: [
      "s3api",
      "put-bucket-lifecycle-configuration",
      "--bucket",
      store.store,
      "--lifecycle-configuration",
      JSON.stringify(configuration),
    ],
  };
}

function planForStore(store: RetentionStore): PlannedAction[] {
  if (store.retentionDays === null) {
    return [
      {
        storeId: store.id,
        target: store.store,
        action: "no-op",
        command: null,
        skippedReason: `status=${store.status}: no approved retention period (decision ${store.decisionRef})`,
      },
    ];
  }

  switch (store.enforcement) {
    case "log-retention": {
      const names = store.logGroupNames ?? [];
      if (names.length === 0) {
        return [
          {
            storeId: store.id,
            target: store.store,
            action: "no-op",
            command: null,
            skippedReason: "no concrete log-group names configured",
          },
        ];
      }
      return names.map((name) => actionForLogGroup(store, name, store.retentionDays as number));
    }
    case "dynamodb-ttl":
      if (!store.ttlAttribute) {
        return [
          {
            storeId: store.id,
            target: store.store,
            action: "no-op",
            command: null,
            skippedReason: "no ttl attribute configured for this table",
          },
        ];
      }
      return [actionForTtl(store, store.retentionDays)];
    case "s3-lifecycle":
      return [actionForS3(store, store.retentionDays)];
    default:
      return [
        {
          storeId: store.id,
          target: store.store,
          action: "no-op",
          command: null,
          skippedReason: `enforcement=${store.enforcement} is not applier-managed`,
        },
      ];
  }
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const stores = storesManagedBy("applier");
  const planned = stores.flatMap(planForStore);
  const executable = planned.filter((item) => item.command !== null);

  console.log(
    `retention applier (${apply ? "APPLY" : "DRY RUN"}) - policy v${retentionPolicy.version}, region ${REGION}`,
  );
  for (const item of planned) {
    if (item.command) {
      console.log(`  [plan] ${item.storeId} :: ${item.action} :: ${item.target}`);
    } else {
      console.log(`  [skip] ${item.storeId} :: ${item.skippedReason}`);
    }
  }

  if (!apply) {
    console.log(
      `\nDry run: ${executable.length} action(s) would run. Re-run with --apply to execute.`,
    );
    return;
  }

  let applied = 0;
  for (const item of executable) {
    const command = item.command as string[];
    console.log(`  [apply] ${item.storeId} :: ${item.action} :: ${item.target}`);
    aws(command);
    applied += 1;
  }
  console.log(`\nApplied ${applied} action(s).`);
}

main();
