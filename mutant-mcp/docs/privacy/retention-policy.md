# Retention policy and verification (PRIV-06)

Version: 1.0 (2026-10-01). Backlog item: PRIV-06. Describes the retention
configuration, how it is applied, and how it is verified. No period in this
document is a commitment until the product owner supplies it (`owner-decisions.md`
**P3**).

## 1. Source of truth

`infrastructure/retention-policy.json` is the single source of truth. Every store
in `docs/privacy/data-inventory.md` section 2 has exactly one row:

| Field | Meaning |
|---|---|
| `id`, `store`, `kind` | Identity of the store. |
| `protectedClass` | `raw-genetic`, `genetic-derived`, `consent-evidence`, `operational`, `synthetic`. |
| `enforcement` | `log-retention`, `dynamodb-ttl`, `s3-lifecycle`, or `pending`. |
| `managedBy` | `cdk` (MCP log group), `applier` (script below), or `runtime` (application clock). |
| `retentionDays` | The value enforcement applies today. `null` means none is applied. |
| `status` | `decided` (owner-approved commitment) or `pending` (current/unset configuration). |
| `enforceLogicalExpiry` | Reader must reject a record past its recorded expiry. |
| `ttlAttribute`, `logGroupNames`, `logGroupPattern` | Enforcement-specific targets. |

The loader (`infrastructure/lib/retention-policy.ts`) rejects a `decided` row
without a positive period and never coerces a `pending`/`null` value into a
number. The CDK stack, the applier, and the verify report all read this file, so
they cannot disagree.

**No production period is invented here.** All rows are `pending` with
`retentionDays: null` except the MCP log group, whose `30` is the *existing
deployed configuration*, not an approved schedule.

## 2. Applying retention

- **MCP log group (CDK).** `mutant-mcp-stack.ts` sets `RetentionInDays` on a
  created group and attaches a `LogRetention` resource to an adopted one, so the
  group is never recreated or deleted. `MUTANT_LOG_RETENTION_DAYS` overrides the
  policy value; `MUTANT_ADOPT_LOG_GROUP` selects adoption.
- **Backend stores (applier).** Backend DynamoDB tables, the raw-file S3 bucket,
  and the backend log groups have no owning IaC template, so they are applied by
  an operator script:

```powershell
npm run apply:retention              # dry run: print planned actions, no changes
npm run apply:retention -- --apply   # execute logs/dynamodb/s3 changes
```

The applier is idempotent, only touches `managedBy: "applier"` rows, and is a
no-op for every `pending` row. It requires operator AWS credentials with
`logs:PutRetentionPolicy`, `dynamodb:UpdateTimeToLive`, and
`s3:PutBucketLifecycleConfiguration`.

## 3. Logical expiry and renewal ceiling

DynamoDB TTL deletion is asynchronous, so an item can be returned after its
`ttl` has passed. Readers therefore enforce logical expiry themselves
(`core/persistence.py`): a record past its recorded expiry is treated as absent in
the response-cache, causes, and precomputed-causes loaders, and an expired chunk
fragment makes the payload unservable.

The MCP read path renews a saved payload close to expiry so a read-only account
does not lose a correctly-computed analysis. Renewal is now bounded by
`RESPONSE_CACHE_MAX_LIFETIME_SECONDS` (measured from the item's write time) and
gated on the account still consenting to `genetic_processing`. While the ceiling
is unset -- the state until **P3** -- renewal is skipped entirely rather than
extended without bound.

## 4. Verification

```powershell
npm run verify:retention
```

Read-only. Compares each store's deployed configuration against the policy and
prints a table plus `retention-report.json`. Every `pending` store and any
observed-vs-approved mismatch is reported **UNRESOLVED**, and the command exits
non-zero, so an incomplete retention posture cannot be recorded as a pass.

It requires only `logs:DescribeLogGroups`, `logs:DescribeExportTasks`,
`dynamodb:DescribeTimeToLive`, `s3:GetLifecycleConfiguration`, and
`s3:GetBucketVersioning`. It never lists S3 object keys or reads table items;
only bucket/table/log-group configuration is described. The report header records
those IAM actions and any CloudWatch log export destinations.

## 5. Closing PRIV-06

PRIV-06 closes only when every applicable store is `decided` with an approved
period that matches the deployed configuration. Until **P3** is answered, the
mechanism is in place but the ticket remains open by design.
